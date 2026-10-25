"""
auth/session.py - the signed session cookie.

The cookie is `<payload>.<signature>`: base64url of a small JSON object
{u: user id, iat, exp, sv: session_version, j: random id} and an HMAC-SHA256 over it.
Nothing is stored per session on the server.  A cookie stops working when it expires, its
signature does not verify, the user's `session_version` moved on (password change,
disabling, "end sessions"), the user is disabled or gone, or it was signed out (in-memory
list of signed-out ids, kept until each would have expired anyway).
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time

COOKIE = 'mps_session'
ENV_KEY = 'MPS_SESSION_KEY'
MIN_KEY_CHARS = 32
MAX_TOKEN = 512


class SessionError(Exception):
    """The signing key cannot be used; the message says what to fix."""


# --------------------------------------------------------------------------- key
def load_key(key_file, environ=None):
    """-> key bytes.  `MPS_SESSION_KEY` wins; otherwise the key file, created (owner
    read/write only) with random content on first use."""
    env = (environ if environ is not None else os.environ).get(ENV_KEY)
    if env:
        if len(env) < MIN_KEY_CHARS:
            raise SessionError('%s must be at least %d characters' % (ENV_KEY, MIN_KEY_CHARS))
        return env.encode('utf-8')
    if not os.path.exists(key_file):
        try:
            fd = os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass                                    # another process created it first
        except OSError as e:
            raise SessionError('cannot create the session key file %s: %s'
                               % (key_file, e.strerror or e))
        else:
            with os.fdopen(fd, 'w') as f:
                f.write(secrets.token_hex(32) + '\n')
    if os.name != 'nt':
        try:
            mode = os.stat(key_file).st_mode & 0o777
        except OSError as e:
            raise SessionError('cannot read the session key file %s: %s'
                               % (key_file, e.strerror or e))
        if mode & 0o077:
            raise SessionError('the session key file %s is readable by other users (mode '
                               '%o); run chmod 600 on it' % (key_file, mode))
    try:
        with open(key_file, 'rb') as f:
            key = f.read().strip()
    except OSError as e:
        raise SessionError('cannot read the session key file %s: %s' % (key_file, e.strerror or e))
    if len(key) < MIN_KEY_CHARS:
        raise SessionError('the session key file %s is too short (need %d characters)'
                           % (key_file, MIN_KEY_CHARS))
    return key


# --------------------------------------------------------------------------- token
def _b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')


def _unb64(text):
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def _mac(key, body):
    return hmac.new(key, body.encode('ascii'), hashlib.sha256).digest()


def sign(key, user_id, session_version, ttl_seconds, now=None):
    """-> (cookie value, claims)."""
    now = int(time.time() if now is None else now)
    claims = {'u': user_id, 'iat': now, 'exp': now + int(ttl_seconds),
              'sv': session_version, 'j': secrets.token_hex(8)}
    body = _b64(json.dumps(claims, separators=(',', ':')).encode('ascii'))
    return '%s.%s' % (body, _b64(_mac(key, body))), claims


def verify(key, token, now=None):
    """-> claims, or None if the value is not a current cookie signed with this key."""
    if not isinstance(token, str) or not 0 < len(token) <= MAX_TOKEN or token.count('.') != 1:
        return None
    body, sig = token.split('.')
    try:
        given = _unb64(sig)
        if not hmac.compare_digest(given, _mac(key, body)):
            return None
        claims = json.loads(_unb64(body).decode('ascii'))
    except (ValueError, TypeError, UnicodeError):
        return None
    if not isinstance(claims, dict):
        return None
    for name in ('u', 'iat', 'exp', 'sv'):
        v = claims.get(name)
        if isinstance(v, bool) or not isinstance(v, int):
            return None
    if not isinstance(claims.get('j'), str):
        return None
    if claims['exp'] <= int(time.time() if now is None else now):
        return None
    return claims


# --------------------------------------------------------------------------- cookie
def cookie_header(token, acfg, max_age):
    """Set-Cookie value: HttpOnly, SameSite=Lax, limited to the app's path, Secure only
    when the public address is https."""
    out = '%s=%s; HttpOnly; SameSite=Lax; Path=%s; Max-Age=%d' % (
        COOKIE, token, acfg['path'], int(max_age))
    return out + '; Secure' if acfg['https'] else out


def clear_cookie_header(acfg):
    out = ('%s=; HttpOnly; SameSite=Lax; Path=%s; Max-Age=0; '
           'Expires=Thu, 01 Jan 1970 00:00:00 GMT' % (COOKIE, acfg['path']))
    return out + '; Secure' if acfg['https'] else out


def parse_cookie(header):
    """-> the session cookie value from a Cookie header, or None."""
    if not header or len(header) > 8192:
        return None
    for part in header.split(';'):
        name, _, value = part.strip().partition('=')
        if name == COOKIE:
            return value or None
    return None


# --------------------------------------------------------------------------- sign-out list
class Revoked:
    """Ids of cookies that were signed out, each kept until it would have expired."""

    def __init__(self, clock=time.time):
        self._clock = clock
        self._ids = {}
        self._lock = threading.Lock()

    def add(self, claims):
        now = self._clock()
        with self._lock:
            self._ids[claims['j']] = claims['exp']
            if len(self._ids) > 1000:
                self._ids = {j: e for j, e in self._ids.items() if e > now}

    def __contains__(self, jti):
        with self._lock:
            return jti in self._ids and self._ids[jti] > self._clock()


# --------------------------------------------------------------------------- request check
def authenticate(store, key, cookie_header_value, revoked=None, now=None):
    """-> (compiled user, claims) for a valid cookie of an enabled user, else (None, None)."""
    claims = verify(key, parse_cookie(cookie_header_value), now)
    if claims is None:
        return None, None
    if revoked is not None and claims['j'] in revoked:
        return None, None
    user = store.compiled(claims['u'])
    if user is None or not user['enabled'] or user['session_version'] != claims['sv']:
        return None, None
    return user, claims