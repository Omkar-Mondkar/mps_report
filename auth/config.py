"""
auth/config.py - validation of the optional `auth` section of config.json.

    "auth": {
        "mode": "off",                       # off | audit | enforce
        "public_url": "http://host/mps/",    # required unless mode is off
        "db": "mps_access.db",               # SQLite file (relative to the config file)
        "key_file": "mps_access.db.key",     # session signing key (created on first use)
        "session_hours": 12
    }

Without an `auth` section the mode is `off` and the server behaves as it did before access
control existed.  Errors are raised as mps_data.ConfigError, naming the setting.
"""
import os
import re
from urllib.parse import urlsplit

import mps_data as data

MODES = ('off', 'audit', 'enforce')
DEFAULT_DB = 'mps_access.db'
DEFAULT_SESSION_HOURS = 12
MAX_SESSION_HOURS = 720
PATH_RE = re.compile(r'^[A-Za-z0-9._~/%-]*$')
LOCAL_HOSTS = ('localhost', '127.0.0.1', '::1')


def _public_url(value):
    """-> (normalised url ending in '/', origin, path, is_https, is_local)."""
    if not isinstance(value, str) or not value.strip():
        raise data.ConfigError('"auth.public_url" must be set when "auth.mode" is not "off" '
                               '(for example "http://host/mps/")')
    if re.search(r'[\s\x00-\x1f\x7f]', value):
        raise data.ConfigError('"auth.public_url" must not contain spaces or control characters')
    try:
        u = urlsplit(value)
        host = u.hostname
        u.port  # noqa: B018  (raises ValueError for a bad port)
    except ValueError:
        raise data.ConfigError('"auth.public_url" %r is not a valid address' % value)
    if u.scheme not in ('http', 'https') or not host:
        raise data.ConfigError('"auth.public_url" must start with http:// or https:// and '
                               'name a host (got %r)' % value)
    if u.username is not None or u.password is not None or u.query or u.fragment:
        raise data.ConfigError('"auth.public_url" must not hold credentials, a query or a '
                               'fragment')
    path = u.path or '/'
    if not path.endswith('/'):
        path += '/'
    if not PATH_RE.match(path):
        raise data.ConfigError('"auth.public_url" path %r holds unsupported characters' % path)
    origin = '%s://%s' % (u.scheme, u.netloc.lower())
    return (origin + path, origin, path, u.scheme == 'https', host.lower() in LOCAL_HOSTS)


def _writable(path):
    folder = os.path.dirname(path) or '.'
    if not os.path.isdir(folder):
        return 'folder %s does not exist' % folder
    if os.path.exists(path):
        if not os.path.isfile(path):
            return 'it is not a file'
        if not os.access(path, os.R_OK | os.W_OK):
            return 'the file is not readable and writable'
    elif not os.access(folder, os.W_OK):
        return 'folder %s is not writable' % folder
    return None


def load_auth_config(cfg, base_dir, mode=None, need_public_url=True):
    """Validate cfg['auth'] and return the derived settings (a new dict).

    `mode` overrides the configured mode (the --auth-mode option).  `need_public_url` is
    False for the command-line bootstrap, which does not serve pages."""
    raw = cfg.get('auth')
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise data.ConfigError('"auth" must be an object')

    chosen = mode if mode is not None else raw.get('mode', 'off')
    if not isinstance(chosen, str) or chosen not in MODES:
        raise data.ConfigError('"auth.mode" must be one of %s (got %r)'
                               % (', '.join('"%s"' % m for m in MODES), chosen))

    hours = raw.get('session_hours', DEFAULT_SESSION_HOURS)
    if (isinstance(hours, bool) or not isinstance(hours, (int, float))
            or not 0 < hours <= MAX_SESSION_HOURS):
        raise data.ConfigError('"auth.session_hours" must be a number greater than 0 and at '
                               'most %d' % MAX_SESSION_HOURS)

    db = raw.get('db', DEFAULT_DB)
    if not isinstance(db, str) or not db.strip():
        raise data.ConfigError('"auth.db" must be a file path')
    db = os.path.abspath(os.path.join(base_dir, db))
    key_file = raw.get('key_file') or db + '.key'
    if not isinstance(key_file, str):
        raise data.ConfigError('"auth.key_file" must be a file path')
    key_file = os.path.abspath(os.path.join(base_dir, key_file))

    out = {'mode': chosen, 'db': db, 'key_file': key_file,
           'session_hours': hours, 'session_seconds': int(hours * 3600),
           'public_url': '', 'origin': '', 'path': '/', 'https': False, 'local': False}

    if chosen != 'off' and need_public_url:
        (out['public_url'], out['origin'], out['path'],
         out['https'], out['local']) = _public_url(raw.get('public_url'))
    if chosen != 'off' or not need_public_url:
        why = _writable(db)
        if why:
            raise data.ConfigError('"auth.db" %s cannot be used: %s' % (db, why))
    return out