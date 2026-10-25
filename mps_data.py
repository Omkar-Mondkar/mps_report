"""
mps_data.py - data layer for mps_graph.

  * config loading / validation
  * discovery of MPS files in the data directory (servers + dates)
  * (server, exchange, segment, date) -> file name resolution, with path-traversal protection
  * parsing and incremental tailing of "<count>,<YYYY-MM-DD HH:MM:SS>" files
"""
import datetime
import json
import math
import os
import re
import time

MAX_CHUNK = 4 * 1024 * 1024  # bytes read per data request
EPOCH_ORD = datetime.date(1970, 1, 1).toordinal()

IP_RE = re.compile(r'^[0-9A-Za-z][0-9A-Za-z.:_-]{0,63}$')
ISO_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
CODE_RE = re.compile(r'^[A-Z]{2,8}$')   # exchange / segment code

NEW_FIELDS = ('{ip}', '{exchange}', '{segment}', '{date}')
OLD_FIELDS = ('{ip}', '{date}')
FIELD_RX = {
    '{ip}': r'(?P<ip>[0-9A-Za-z][0-9A-Za-z.:_-]*?)',
    '{exchange}': r'(?P<exchange>[A-Z]{2,8})',
    '{segment}': r'(?P<segment>[A-Z]{2,8})',
    '{date}': r'(?P<date>[0-9]{6,8})',
}
DEFAULT_FILENAME = 'MPS_Greek_{ip}_{exchange}_{segment}_{date}.csv'
DEFAULT_LEGACY = 'MPS_Greek_{ip}_{date}.csv'

DEFAULTS = {
    'title': 'Messages / second',
    'dir': '/else/home/oaa/MsgRatioPerSec',
    # {ip} = server id, {exchange} / {segment} = upper-case codes (NSE, CM, ...),
    # {date} = date in `date_format`
    'filename': DEFAULT_FILENAME,
    # files written before the exchange/segment were part of the name; null disables
    'legacy_filename': DEFAULT_LEGACY,
    # display order and names; codes found in files but not listed here are still offered
    'exchanges': [{'code': 'NSE', 'name': 'NSE'}, {'code': 'BSE', 'name': 'BSE'}],
    'segments': [{'code': 'CM', 'name': 'Cash'},
                 {'code': 'FO', 'name': 'Futures & Options'},
                 {'code': 'CD', 'name': 'Currency'}],
    'date_format': '%d%m%Y',
    # optional friendly names; servers found in the directory but not listed here
    # are still offered, labelled by their IP.   [{"name": "...", "ip": "..."}]
    'servers': [],
    'interval_ms': 1000,
}


class ConfigError(Exception):
    pass


class BadRequest(ValueError):
    pass


# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------
def _compile(key, name, fields):
    """Validate a file name template and compile it to an anchored regex."""
    if not isinstance(name, str):
        raise ConfigError('"%s" must be a string' % key)
    for f in fields:
        if name.count(f) != 1:
            raise ConfigError('"%s" must contain %s exactly once' % (key, f))
    if '/' in name or '\\' in name:
        raise ConfigError('"%s" must be a plain file name (no directories)' % key)
    rx = ''
    for part in re.split(r'(\{[a-z]+\})', name):
        rx += FIELD_RX[part] if part in fields else re.escape(part)
    return re.compile('^' + rx + '$')


def _codes(items, what):
    out, seen = [], set()
    for it in items or []:
        if isinstance(it, str):
            code, label = it, it
        elif isinstance(it, dict):
            code = str(it.get('code', ''))
            label = str(it.get('name') or code)
        else:
            raise ConfigError('bad %s entry in config: %r' % (what, it))
        if not CODE_RE.match(code):
            raise ConfigError('bad %s code in config: %r (expected 2-8 capital letters)'
                              % (what, code))
        if code not in seen:
            seen.add(code)
            out.append({'code': code, 'name': label})
    return out


def load_config(path=None, **overrides):
    cfg = dict(DEFAULTS)
    user = {}
    if path:
        try:
            with open(path, encoding='utf-8') as f:
                user = json.load(f)
            cfg.update(user)
        except (OSError, ValueError) as e:
            raise ConfigError('cannot read config %s: %s' % (path, e))
    cfg.update({k: v for k, v in overrides.items() if v is not None})

    # A config written for the previous version names only {ip} and {date}: keep reading
    # those files as the old pattern and use the default pattern for the new files.
    cfg['notice'] = None
    name = cfg['filename']
    if (isinstance(name, str) and '{exchange}' not in name and '{segment}' not in name
            and name != DEFAULT_FILENAME):
        if 'legacy_filename' not in user:
            cfg['legacy_filename'] = name
        cfg['filename'] = DEFAULT_FILENAME
        cfg['notice'] = ('"filename" %r has no {exchange}/{segment}: treating it as '
                         '"legacy_filename" and using %r for the new files'
                         % (name, DEFAULT_FILENAME))
    cfg['_rx'] = _compile('filename', cfg['filename'], NEW_FIELDS)
    if cfg.get('legacy_filename'):
        cfg['_rx_old'] = _compile('legacy_filename', cfg['legacy_filename'], OLD_FIELDS)
    else:
        cfg['legacy_filename'] = None
        cfg['_rx_old'] = None
    cfg['exchanges'] = _codes(cfg.get('exchanges'), 'exchange')
    cfg['segments'] = _codes(cfg.get('segments'), 'segment')
    try:
        datetime.date(2026, 1, 2).strftime(cfg['date_format'])
    except ValueError as e:
        raise ConfigError('bad "date_format": %s' % e)

    servers = []
    for s in cfg.get('servers') or []:
        ip = str(s.get('ip', ''))
        if not IP_RE.match(ip):
            raise ConfigError('bad server ip in config: %r' % ip)
        servers.append({'ip': ip, 'name': str(s.get('name') or ip)})
    cfg['servers'] = servers

    cfg['dir'] = os.path.abspath(cfg['dir'])
    cfg['interval_ms'] = max(200, int(cfg['interval_ms']))
    return cfg


# --------------------------------------------------------------------------
# Discovery / resolution
# --------------------------------------------------------------------------
def _natural(s):
    return [int(x) if x.isdigit() else x for x in re.split(r'(\d+)', s)]


def scan(cfg):
    """-> {(ip, exchange, segment): {iso_date: (size, mtime)}}; exchange and segment are ''
    for old-style files.  The new pattern is tried first: the old one would also swallow a
    new name (ip = '10.0.0.1_NSE_CM').  Raises OSError if the dir is unreadable."""
    out = {}
    with os.scandir(cfg['dir']) as it:
        for e in it:
            m = cfg['_rx'].match(e.name)
            if not m and cfg['_rx_old']:
                m = cfg['_rx_old'].match(e.name)
            if not m:
                continue
            g = m.groupdict()
            try:
                if not e.is_file():
                    continue
                d = datetime.datetime.strptime(g['date'], cfg['date_format']).date()
                st = e.stat()
            except (ValueError, OSError):
                continue
            key = (g['ip'], g.get('exchange') or '', g.get('segment') or '')
            out.setdefault(key, {})[d.isoformat()] = (st.st_size, st.st_mtime)
    return out


def _limited(scope):
    """True when `scope` restricts what may be seen (None = no access control)."""
    return scope is not None and not scope.all


def _visible(found, scope):
    """`found` reduced to the (server, exchange, segment) keys the scope allows."""
    if not _limited(scope):
        return found
    return {k: v for k, v in found.items() if scope.allows(k[0], k[1], k[2])}


def _ranked(configured, found_codes):
    """configured codes first (in order), then the other codes found, sorted."""
    order = [c['code'] for c in configured]
    return order + sorted(c for c in found_codes if c and c not in order)


def catalog(cfg, found, scope=None):
    """-> (exchanges, segments), each [{code, name}] in display order, including codes
    found in files but missing from the config (named by their code).  With a limited
    `scope` only the codes present in files the scope allows are listed."""
    limited = _limited(scope)
    found = _visible(found, scope)
    out = []
    for configured, idx in ((cfg['exchanges'], 1), (cfg['segments'], 2)):
        names = {c['code']: c['name'] for c in configured}
        present = {k[idx] for k in found}
        codes = _ranked(configured, present)
        if limited:
            codes = [c for c in codes if c in present]
        out.append([{'code': c, 'name': names.get(c, c)} for c in codes])
    return out[0], out[1]


def _seg_rank(cfg, found):
    """-> function (exchange, segment) -> sort key; old-style files (empty codes) last."""
    exs, segs = catalog(cfg, found)
    er = {c['code']: i for i, c in enumerate(exs)}
    sr = {c['code']: i for i, c in enumerate(segs)}
    return lambda ex, sg: (er.get(ex, len(er)), sr.get(sg, len(sr)))


def list_servers(cfg, found=None, scope=None):
    """-> [{ip, name, days, segments:[{exchange, segment, days}]}]; `days` counts distinct
    dates over all of the server's files.  A limited `scope` keeps only its servers and
    counts only the files it allows."""
    if found is None:
        found = scan(cfg)
    found = _visible(found, scope)
    rank = _seg_rank(cfg, found)
    by_ip = {}
    for (ip, ex, sg), days in found.items():
        by_ip.setdefault(ip, []).append((ex, sg, days))

    def entry(ip, name):
        segs = sorted(by_ip.get(ip, []), key=lambda t: rank(t[0], t[1]))
        dates = set()
        for _, _, days in segs:
            dates.update(days)
        return {'ip': ip, 'name': name, 'days': len(dates),
                'segments': [{'exchange': ex, 'segment': sg, 'days': len(days)}
                             for ex, sg, days in segs]}

    servers, seen = [], set()
    for s in cfg['servers']:
        if not _limited(scope) or scope.allows_server(s['ip']):
            servers.append(entry(s['ip'], s['name']))
        seen.add(s['ip'])
    for ip in sorted(by_ip, key=_natural):
        if ip not in seen:
            servers.append(entry(ip, ip))
    return servers


def list_reports(cfg, found=None, scope=None):
    """-> [{ip, name, exchange, segment, seg, date, size}] for every matching file; servers
    in config order first, then discovered ones; then exchange / segment in display order
    (old-style files last); newest date first. Raises OSError if unreadable.  A limited
    `scope` lists only files it allows."""
    if found is None:
        found = scan(cfg)
    found = _visible(found, scope)
    rank = _seg_rank(cfg, found)
    names = {s['ip']: s['name'] for s in cfg['servers']}
    ips = {k[0] for k in found}
    order = [s['ip'] for s in cfg['servers'] if s['ip'] in ips]
    order += sorted((ip for ip in ips if ip not in names), key=_natural)
    out = []
    for ip in order:
        keys = sorted((k for k in found if k[0] == ip), key=lambda k: rank(k[1], k[2]))
        for _, ex, sg in keys:
            days = found[(ip, ex, sg)]
            for d in sorted(days, reverse=True):
                out.append({'ip': ip, 'name': names.get(ip, ip), 'exchange': ex,
                            'segment': sg, 'seg': '%s_%s' % (ex, sg) if ex else '',
                            'date': d, 'size': days[d][0]})
    return out


def list_dates(cfg, ip, exchange='', segment='', scope=None):
    check_ip(ip)
    exchange, segment = check_seg(exchange, segment)
    if scope is not None:
        scope.require(ip, exchange, segment)
    try:
        days = scan(cfg).get((ip, exchange, segment), {})
    except OSError:
        days = {}
    return [{'date': d, 'size': days[d][0]} for d in sorted(days, reverse=True)]


def check_ip(ip):
    if not IP_RE.match(ip or ''):
        raise BadRequest('invalid server')


def check_seg(exchange, segment):
    """Both empty = old-style file; otherwise both must be capital-letter codes."""
    exchange, segment = exchange or '', segment or ''
    if not exchange and not segment:
        return '', ''
    if not CODE_RE.match(exchange) or not CODE_RE.match(segment):
        raise BadRequest('invalid exchange/segment')
    return exchange, segment


def parse_iso(s):
    if not ISO_RE.match(s or ''):
        raise BadRequest('invalid date (expected YYYY-MM-DD)')
    try:
        return datetime.datetime.strptime(s, '%Y-%m-%d').date()
    except ValueError:
        raise BadRequest('invalid date')


def resolve(cfg, ip, iso, exchange='', segment=''):
    """(server, ISO date[, exchange, segment]) -> (absolute path, file name).
    Never leaves cfg['dir']."""
    check_ip(ip)
    d = parse_iso(iso)
    exchange, segment = check_seg(exchange, segment)
    date = d.strftime(cfg['date_format'])
    if exchange:
        name = cfg['filename'].format(ip=ip, exchange=exchange, segment=segment, date=date)
    elif cfg['legacy_filename']:
        name = cfg['legacy_filename'].format(ip=ip, date=date)
    else:
        raise BadRequest('files without exchange/segment are disabled')
    # `ip`, `exchange` and `segment` are regex-validated (no separators) and the templates
    # have none, so the name is a plain file name; the check below is defence in depth.
    # Symlinked files are allowed.
    root = os.path.realpath(cfg['dir'])
    path = os.path.normpath(os.path.join(root, name))
    if os.path.dirname(path) != root:
        raise BadRequest('invalid file name')
    return path, name


# --------------------------------------------------------------------------
# Parsing / tailing
# --------------------------------------------------------------------------
def parse_line(line):
    """'99,2026-10-13 15:37:25' -> (epoch_ms_as_if_utc, 99) or None."""
    parts = line.split(',')
    if len(parts) < 2:
        return None
    try:
        value = float(parts[0].strip())
        if not math.isfinite(value):
            return None
        ts = parts[1].strip()
        if len(ts) < 19 or ts[10] not in ' T':
            return None
        days = datetime.date(int(ts[0:4]), int(ts[5:7]), int(ts[8:10])).toordinal() - EPOCH_ORD
        secs = days * 86400 + int(ts[11:13]) * 3600 + int(ts[14:16]) * 60 + int(ts[17:19])
    except (ValueError, OverflowError):
        return None
    if value.is_integer():
        value = int(value)
    return secs * 1000, value


def read_new(path, offset):
    """Read complete lines starting at byte `offset`.

    Returns dict(points=[t,v,t,v,...], offset, size, reset, more, modified).
    """
    st = os.stat(path)
    size = st.st_size
    reset = False
    if offset > size:  # file truncated / replaced
        offset = 0
        reset = True
    with open(path, 'rb') as f:
        f.seek(offset)
        buf = f.read(MAX_CHUNK)

    consumed = buf.rfind(b'\n') + 1
    if consumed == 0 and len(buf) >= MAX_CHUNK:
        consumed = len(buf)  # absurdly long line: skip it
    points = []
    for raw in buf[:consumed].split(b'\n'):
        p = parse_line(raw.decode('utf-8', 'ignore'))
        if p:
            points.extend(p)

    # Last line without trailing newline: accept it once the file has gone quiet.
    tail = buf[consumed:]
    if tail and offset + len(buf) >= size and time.time() - st.st_mtime > 2:
        p = parse_line(tail.decode('utf-8', 'ignore'))
        if p:
            points.extend(p)
            consumed = len(buf)

    new_off = offset + consumed
    return {
        'points': points,
        'offset': new_off,
        'size': size,
        'reset': reset,
        'more': consumed > 0 and new_off < size,
        'modified': time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(st.st_mtime)),
    }


def read_data(cfg, ip, iso, offset, exchange='', segment='', scope=None):
    """Resolve + tail. Reports a missing file as data rather than as an error.  With a
    `scope` the request is refused (Forbidden) before any file is touched, so an existing
    and a missing file look the same."""
    path, name = resolve(cfg, ip, iso, exchange, segment)
    if scope is not None:
        scope.require(ip, *check_seg(exchange, segment))
    try:
        out = read_new(path, offset)
    except FileNotFoundError:
        return {'missing': True, 'file': name}
    except OSError as e:
        return {'error': 'Cannot read %s: %s' % (name, e.strerror or e), 'file': name}
    out['file'] = name
    return out


# --------------------------------------------------------------------------
# API payloads (shared by the server and the tests)
# --------------------------------------------------------------------------
GENERIC_READ_ERROR = 'Cannot read the data directory'


def _read_error(cfg, e, scope):
    """Error text for an unreadable data directory; names the path only to unrestricted
    callers."""
    if _limited(scope):
        return GENERIC_READ_ERROR
    return 'Cannot read %s: %s' % (cfg['dir'], e.strerror or e)


def servers_payload(cfg, scope=None):
    """Body of /api/servers.  With a limited scope the data directory and the file name
    template are left out and only visible servers and codes are listed."""
    out = {'title': cfg['title'], 'today': datetime.date.today().isoformat(),
           'interval': cfg['interval_ms']}
    if not _limited(scope):
        out['dir'] = cfg['dir']
        out['filename'] = cfg['filename']
    out.update({'servers': [], 'exchanges': [], 'segments': [], 'error': None})
    try:
        found = scan(cfg)
        out['servers'] = list_servers(cfg, found, scope)
        out['exchanges'], out['segments'] = catalog(cfg, found, scope)
    except OSError as e:
        out['error'] = _read_error(cfg, e, scope)
    return out


def reports_payload(cfg, scope=None):
    """Body of /api/reports."""
    out = {'reports': [], 'exchanges': [], 'segments': [], 'error': None}
    try:
        found = scan(cfg)
        out['reports'] = list_reports(cfg, found, scope)
        out['exchanges'], out['segments'] = catalog(cfg, found, scope)
    except OSError as e:
        out['error'] = _read_error(cfg, e, scope)
    return out