"""
otr_data.py - data layer for the dealer-wise order/trade (OTR) report.

  * config keys (otr_*) validation, applied on top of mps_data.load_config()
  * discovery of OTR snapshot files: server -> date -> snapshot times
  * reading one snapshot (whole file, read-only, size capped) into compact rows
  * exchange / segment derived from the leading digits of `lourtoken`

A snapshot is a finished csv named like
    DealerWise_Order_Trade_Report_<ip>_<DDMMYYYY>_<HHMMSS>.csv
with the header
    user,lourtoken,symbol,series,opt_type,strike,Expiry_date,sum(gorder),sum(trade),otr
"""
import csv
import datetime
import math
import os
import re
import threading
import time
from collections import OrderedDict

import mps_data as data

DEFAULT_OTR_DIR = '/home/oaa/Greek_Prod_OTR_Data'
DEFAULT_OTR_FILENAME = 'DealerWise_Order_Trade_Report_{ip}_{date}_{time}.csv'
DEFAULT_THRESHOLD = 2000
DEFAULT_MAX_BYTES = 64 * 1024 * 1024
DEFAULT_PREFIXES = {'101': 'NSE_CM', '102': 'NSE_FO', '50': 'NSE_CD',
                    '201': 'BSE_CM', '202': 'BSE_FO'}

OTR_FIELDS = ('{ip}', '{date}', '{time}')
FIELD_RX = {
    '{ip}': data.FIELD_RX['{ip}'],
    '{date}': data.FIELD_RX['{date}'],
    '{time}': r'(?P<time>[0-9]{6})',
}
TIME_RE = re.compile(r'^(\d{2})(\d{2})(\d{2})$')
PREFIX_RE = re.compile(r'^[0-9]{1,12}$')
PAIR_RE = re.compile(r'^([A-Z]{2,8})_([A-Z]{2,8})$')

# header name (lower case) of every column the report needs, in output order
COLUMNS = ('user', 'lourtoken', 'symbol', 'series', 'opt_type', 'strike',
           'expiry_date', 'sum(gorder)', 'sum(trade)', 'otr')


# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------
def _compile(name):
    if not isinstance(name, str):
        raise data.ConfigError('"otr_filename" must be a string')
    for f in OTR_FIELDS:
        if name.count(f) != 1:
            raise data.ConfigError('"otr_filename" must contain %s exactly once' % f)
    if '/' in name or '\\' in name:
        raise data.ConfigError('"otr_filename" must be a plain file name (no directories)')
    rx = ''
    for part in re.split(r'(\{[a-z]+\})', name):
        rx += FIELD_RX[part] if part in OTR_FIELDS else re.escape(part)
    return re.compile('^' + rx + '$')


def _prefixes(raw):
    if not isinstance(raw, dict):
        raise data.ConfigError('"otr_token_prefixes" must be an object like {"101": "NSE_CM"}')
    out = {}
    for prefix, pair in raw.items():
        prefix = str(prefix)
        if not PREFIX_RE.match(prefix):
            raise data.ConfigError('bad "otr_token_prefixes" key %r (expected digits)' % prefix)
        m = PAIR_RE.match(pair) if isinstance(pair, str) else None
        if not m:
            raise data.ConfigError('bad "otr_token_prefixes" value %r for %s '
                                   '(expected EXCHANGE_SEGMENT such as NSE_FO)' % (pair, prefix))
        out[prefix] = (m.group(1), m.group(2))
    return out


def load_otr_config(cfg):
    """Validate the otr_* keys of an already loaded config and add the derived values.
    Raises mps_data.ConfigError."""
    cfg['otr_dir'] = os.path.abspath(cfg.get('otr_dir') or DEFAULT_OTR_DIR)
    cfg['otr_filename'] = cfg.get('otr_filename') or DEFAULT_OTR_FILENAME
    cfg['_otr_rx'] = _compile(cfg['otr_filename'])

    thr = cfg.get('otr_threshold', DEFAULT_THRESHOLD)
    if (isinstance(thr, bool) or not isinstance(thr, (int, float))
            or not math.isfinite(thr) or thr < 0):
        raise data.ConfigError('"otr_threshold" must be a number of 0 or more')
    cfg['otr_threshold'] = thr

    mx = cfg.get('otr_max_bytes', DEFAULT_MAX_BYTES)
    if isinstance(mx, bool) or not isinstance(mx, int) or mx < 1:
        raise data.ConfigError('"otr_max_bytes" must be a positive whole number')
    cfg['otr_max_bytes'] = mx

    cfg['_otr_prefixes'] = _prefixes(cfg.get('otr_token_prefixes', DEFAULT_PREFIXES))
    # longest prefix first, so the first match is the longest one
    cfg['_otr_prefix_order'] = sorted(cfg['_otr_prefixes'], key=lambda p: (-len(p), p))
    return cfg


def classify(cfg, token):
    """lourtoken -> (exchange, segment) by longest matching prefix, ('', '') if none."""
    for p in cfg['_otr_prefix_order']:
        if token.startswith(p):
            return cfg['_otr_prefixes'][p]
    return '', ''


# --------------------------------------------------------------------------
# Discovery
# --------------------------------------------------------------------------
def _valid_time(t):
    m = TIME_RE.match(t or '')
    return bool(m) and int(m.group(1)) < 24 and int(m.group(2)) < 60 and int(m.group(3)) < 60


def check_time(t):
    if not _valid_time(t):
        raise data.BadRequest('invalid time (expected HHMMSS)')
    return t


def scan_otr(cfg):
    """-> {ip: {iso_date: [HHMMSS, ...] newest first}}.  Raises OSError if the directory
    is unreadable."""
    found = {}
    with os.scandir(cfg['otr_dir']) as it:
        for e in it:
            m = cfg['_otr_rx'].match(e.name)
            if not m:
                continue
            g = m.groupdict()
            if not _valid_time(g['time']):
                continue
            try:
                if not e.is_file():
                    continue
                d = datetime.datetime.strptime(g['date'], cfg['date_format']).date()
            except (ValueError, OSError):
                continue
            found.setdefault(g['ip'], {}).setdefault(d.isoformat(), set()).add(g['time'])
    return {ip: {d: sorted(ts, reverse=True) for d, ts in days.items()}
            for ip, days in found.items()}


def catalog_otr(cfg):
    """-> (exchanges, segments), each [{code, name}]: the configured lists first, then any
    code that only appears in the token prefixes."""
    out = []
    for configured, idx in ((cfg['exchanges'], 0), (cfg['segments'], 1)):
        names = {c['code']: c['name'] for c in configured}
        order = [c['code'] for c in configured]
        extra = sorted({pair[idx] for pair in cfg['_otr_prefixes'].values()} - set(order))
        out.append([{'code': c, 'name': names.get(c, c)} for c in order + extra])
    return out[0], out[1]


def list_otr(cfg, scope=None):
    """-> the /api/otr/files payload.  Unreadable directory -> error text and no servers.
    A limited `scope` sees only its servers and the exchange/segment pairs it is granted,
    and neither the directory nor the file name template."""
    limited = data._limited(scope)
    out = {}
    if not limited:
        out['dir'] = cfg['otr_dir']
        out['filename'] = cfg['otr_filename']
    out.update({'threshold': cfg['otr_threshold'], 'servers': [], 'error': None})
    out['exchanges'], out['segments'] = _visible_catalog(cfg, scope)
    try:
        found = scan_otr(cfg)
    except OSError as e:
        out['error'] = (data.GENERIC_READ_ERROR if limited
                        else 'Cannot read %s: %s' % (cfg['otr_dir'], e.strerror or e))
        return out
    if limited:
        found = {ip: days for ip, days in found.items() if scope.allows_server(ip)}
    names = {s['ip']: s['name'] for s in cfg['servers']}
    order = [s['ip'] for s in cfg['servers'] if s['ip'] in found]
    order += sorted((ip for ip in found if ip not in names), key=data._natural)
    for ip in order:
        days = found[ip]
        out['servers'].append({
            'ip': ip, 'name': names.get(ip, ip),
            'dates': [{'date': d, 'times': days[d]} for d in sorted(days, reverse=True)]})
    return out


def _visible_catalog(cfg, scope):
    """catalog_otr() limited to the codes of the pairs the scope is granted."""
    exchanges, segments = catalog_otr(cfg)
    if not data._limited(scope):
        return exchanges, segments
    pairs = [pair for pair in cfg['_otr_prefixes'].values() if scope.allows_pair(*pair)]
    ex_ok = {p[0] for p in pairs}
    sg_ok = {p[1] for p in pairs}
    return ([c for c in exchanges if c['code'] in ex_ok],
            [c for c in segments if c['code'] in sg_ok])


# --------------------------------------------------------------------------
# Reading
# --------------------------------------------------------------------------
def resolve_otr(cfg, ip, iso, hhmmss):
    """(server, ISO date, HHMMSS) -> (absolute path, file name).  Never leaves otr_dir."""
    data.check_ip(ip)
    d = data.parse_iso(iso)
    check_time(hhmmss)
    name = cfg['otr_filename'].format(ip=ip, date=d.strftime(cfg['date_format']), time=hhmmss)
    root = os.path.realpath(cfg['otr_dir'])
    path = os.path.normpath(os.path.join(root, name))
    if os.path.dirname(path) != root:
        raise data.BadRequest('invalid file name')
    return path, name


def _num(text):
    """'12' -> 12, '2.5' -> 2.5; None when blank, not a number, or not finite."""
    try:
        v = float(text.strip())
    except ValueError:
        return None
    if not math.isfinite(v):
        return None
    return int(v) if v.is_integer() else v


def _strike(text):
    text = text.strip()
    v = _num(text)
    return text if v is None else v


def read_otr(cfg, ip, iso, hhmmss, scope=None):
    """Resolve + parse one snapshot.  A missing file is reported as data, not an error.

    With a `scope` the server is checked before any file is touched (Forbidden), parsed
    snapshots are shared through a bounded cache, and a limited scope gets only the rows
    of its exchange/segment/dealer grants: counts, totals and the skipped count describe
    what it may see and the file size is left out."""
    path, name = resolve_otr(cfg, ip, iso, hhmmss)
    if scope is not None:
        scope.require_server(ip)
    try:
        st = os.stat(path)
        if st.st_size > cfg['otr_max_bytes']:
            return {'error': '%s is %d bytes, over the limit of %d bytes (otr_max_bytes)'
                             % (name, st.st_size, cfg['otr_max_bytes']), 'file': name}
        if scope is None:
            with open(path, 'r', encoding='utf-8-sig', errors='replace', newline='') as f:
                rows, skipped, err = _parse(cfg, csv.reader(f), name)
            log = None
        else:
            rows, skipped, err, log = _cached_parse(cfg, path, name, st)
    except FileNotFoundError:
        return {'missing': True, 'file': name}
    except (OSError, csv.Error) as e:
        return {'error': 'Cannot read %s: %s' % (name, getattr(e, 'strerror', None) or e),
                'file': name}
    if err:
        return {'error': err, 'file': name}
    modified = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(st.st_mtime))
    if not data._limited(scope):
        return {'file': name, 'size': st.st_size, 'modified': modified,
                'columns': list(COLUMNS), 'rows': rows, 'skipped': skipped}
    rows, skipped = _filter(cfg, ip, rows, skipped, log, scope)
    return {'file': name, 'modified': modified, 'columns': list(COLUMNS), 'rows': rows,
            'skipped': skipped}


def _filter(cfg, ip, rows, skipped, log, scope):
    """-> (visible rows, visible skipped count) for a limited scope.

    A skipped line counts only if it can be tied to something the scope may see: its
    dealer and token are read like a row's.  A line that cannot be attributed (too short,
    or beyond the logged ones) counts only for a scope that sees every dealer of every
    token on this server, i.e. one that holds an any/any/any grant for it."""
    filters = {}

    def dealer_filter(ex, sg):
        if (ex, sg) not in filters:
            filters[(ex, sg)] = scope.dealer_filter(ip, ex, sg)
        return filters[(ex, sg)]

    def visible(user, ex, sg):
        f = dealer_filter(ex, sg)
        return f is None or (not f.empty and f.matches(user))

    out = [r for r in rows if visible(r[0], r[10], r[11])]
    count = 0
    for entry in log:
        if entry is None:
            count += 1 if dealer_filter('', '') is None else 0
        else:
            user, token = entry
            ex, sg = classify(cfg, token)
            count += 1 if visible(user, ex, sg) else 0
    count += (skipped - len(log)) if dealer_filter('', '') is None else 0
    return out, count


# Parsed snapshots shared by every viewer: key (path, size, mtime_ns) -> parse result.
# Bounded by entry count and by the total number of rows held.
CACHE_ENTRIES = 8
CACHE_ROWS = 2000000
MAX_SKIP_LOG = 10000
_cache = OrderedDict()
_cache_rows = 0
_cache_lock = threading.Lock()      # guards _cache / _cache_rows (short holds)
_parse_lock = threading.Lock()      # one parse at a time: a burst of viewers parses once
stats = {'parses': 0}


def _cache_get(key):
    with _cache_lock:
        hit = _cache.get(key)
        if hit is not None:
            _cache.move_to_end(key)
        return hit


def _cache_put(key, value):
    global _cache_rows
    size = len(value[0])
    with _cache_lock:
        for old in [k for k in _cache if k[0] == key[0]]:     # an older version of the file
            _cache_rows -= len(_cache.pop(old)[0])
        if size > CACHE_ROWS:
            return
        _cache[key] = value
        _cache_rows += size
        while len(_cache) > CACHE_ENTRIES or _cache_rows > CACHE_ROWS:
            _, dropped = _cache.popitem(last=False)
            _cache_rows -= len(dropped[0])


def cache_clear():
    global _cache_rows
    with _cache_lock:
        _cache.clear()
        _cache_rows = 0


def _cached_parse(cfg, path, name, st):
    """-> (rows, skipped, error, skipped log).  The result is shared: do not modify it."""
    key = (path, st.st_size, st.st_mtime_ns)
    hit = _cache_get(key)
    if hit is not None:
        return hit
    with _parse_lock:
        hit = _cache_get(key)
        if hit is not None:
            return hit
        log = []
        with open(path, 'r', encoding='utf-8-sig', errors='replace', newline='') as f:
            rows, skipped, err = _parse(cfg, csv.reader(f), name, log)
        stats['parses'] += 1
        value = (rows, skipped, err, log)
        if not err:
            _cache_put(key, value)
        return value


def _log_skip(log, r, iu, it):
    if log is not None and len(log) < MAX_SKIP_LOG:
        log.append((r[iu].strip(), r[it].strip()) if len(r) > max(iu, it) else None)


def _parse(cfg, reader, name, skipped_log=None):
    """-> (rows, skipped, error).  Row = [user, token, symbol, series, optType, strike,
    expiry, orders, trades, otr, exchange, segment].

    `skipped_log`, if given, receives one entry per skipped line (up to MAX_SKIP_LOG):
    (user, token) when the line has both, else None."""
    header = None
    for line in reader:
        if any(c.strip() for c in line):
            header = [c.strip().lower() for c in line]
            break
    if header is None:
        return [], 0, '%s is empty' % name
    pos = {}
    for i, h in enumerate(header):
        pos.setdefault(h, i)
    missing = [c for c in COLUMNS if c not in pos]
    if missing:
        return [], 0, 'Column %s is missing in %s' % (
            ', '.join('"%s"' % c for c in missing), name)
    idx = [pos[c] for c in COLUMNS]
    need = max(idx) + 1
    iu, it, isy, ise, iop, ist, iex, ior, itr, iot = idx

    rows, skipped = [], 0
    for r in reader:
        if not any(c.strip() for c in r):
            continue
        if len(r) < need:
            skipped += 1
            _log_skip(skipped_log, r, iu, it)
            continue
        orders, trades, otr = _num(r[ior]), _num(r[itr]), _num(r[iot])
        if orders is None or trades is None or otr is None:
            skipped += 1
            _log_skip(skipped_log, r, iu, it)
            continue
        token = r[it].strip()
        ex, sg = classify(cfg, token)
        rows.append([r[iu].strip(), token, r[isy].strip(), r[ise].strip(), r[iop].strip(),
                     _strike(r[ist]), r[iex].strip(), orders, trades, otr, ex, sg])
    return rows, skipped, None