"""
auth/web.py - the web-facing side of access control, kept out of the HTTP handler so it
can be tested without a socket.

    AuthContext   sign-in, sign-out, password change, the current-user payload, the
                  forged-request rules, throttled auditing, and the audit-mode rehearsal
    startup_report / bootstrap_superadmin   used by mps_graph's start-up

The handler asks `principal()` once per request and passes the user's Scope down to the
data functions; nothing here reads data files except `views_for` (once per page load).
"""
import json
import math
import sqlite3
import sys
import threading
import time

from . import admin as adm
from . import adminapi
from . import limit as auth_limit
from . import password as pw
from . import session as ses
from . import store as st
import mps_data as data
import otr_data as otr

MAX_BODY = 8192
ADMIN_BODY = 64 * 1024                 # bulk id lists and the like
ADMIN_IMPORT_BODY = 6 * 1024 * 1024   # a 2 MB CSV, after JSON escaping
ADMIN_IMPORT_PATH = adminapi.PREFIX + 'import/preview'
AUDIT_REPEAT_SECONDS = 60
ALL_VIEWS = ['mps', 'otr']

MSG_INVALID = 'Invalid user id or password'
MSG_FORBIDDEN = 'Request refused'


class AuthError(Exception):
    """A refused request: HTTP status, a message that is safe to show, optional wait."""

    def __init__(self, code, message, retry_after=None):
        Exception.__init__(self, message)
        self.code = code
        self.message = message
        self.retry_after = retry_after


def off_me():
    return {'auth': False, 'mode': 'off', 'login': '', 'name': '', 'roles': [],
            'view_all': True, 'manage': False, 'views': list(ALL_VIEWS), 'pending': False,
            'has_password': False}


def views_for(cfg, user):
    """Views a user can open, judged by the data they may see: MPS when some report is
    visible, OTR when some OTR server and exchange/segment is.  Full access gets both."""
    if user['view_all']:
        return list(ALL_VIEWS)
    scope = user['scope']
    views = []
    try:
        if any(scope.allows(*key) for key in data.scan(cfg)):
            views.append('mps')
    except OSError:
        if user['grants']:
            views.append('mps')
    pairs = list(cfg['_otr_prefixes'].values()) + [('', '')]
    if any(scope.allows_pair(*pair) for pair in pairs):
        try:
            if any(scope.allows_server(ip) for ip in otr.scan_otr(cfg)):
                views.append('otr')
        except OSError:
            pass
    return views


class AuthContext:
    def __init__(self, acfg, store, key, limiter=None, revoked=None, clock=time.time):
        self.acfg = acfg
        self.store = store
        self.key = key
        self.limiter = limiter or auth_limit.Limiter()
        self.revoked = revoked or ses.Revoked()
        self._clock = clock
        self._seen = {}
        self._admin = None
        self._admin_lock = threading.Lock()
        self.mode = acfg['mode']
        self.login_url = acfg['public_url'] + 'login'
        self.home_url = acfg['public_url']

    @property
    def enforcing(self):
        return self.mode == 'enforce'

    # ------------------------------------------------------------ audit
    def audit(self, event, actor='', subject='', detail='', addr=''):
        self.store.audit(event, actor=actor, subject=subject, detail=detail, addr=addr)

    def audit_throttled(self, event, actor='', subject='', detail='', addr=''):
        """Like audit(), but the same (event, actor, subject) is written at most once a
        minute so a page that polls every second cannot flood the log."""
        now = self._clock()
        key = (event, actor, subject)
        last = self._seen.get(key)
        if last is not None and now - last < AUDIT_REPEAT_SECONDS:
            return False
        if len(self._seen) > 5000:
            self._seen = {k: t for k, t in self._seen.items() if now - t < AUDIT_REPEAT_SECONDS}
        self._seen[key] = now
        try:
            self.audit(event, actor, subject, detail, addr)
        except Exception as e:      # a log write must not turn a refusal into a crash
            print('warning: audit write failed: %s' % e, file=sys.stderr)
            return False
        return True

    # ------------------------------------------------------------ who is asking
    def principal(self, cookie_header):
        """-> (compiled user, claims) or (None, None).  May raise if the store fails."""
        return ses.authenticate(self.store, self.key, cookie_header, self.revoked)

    def _cookie(self, user):
        token, _ = self._sign(user)
        return ses.cookie_header(token, self.acfg, self.acfg['session_seconds'])

    def _sign(self, user):
        token, claims = ses.sign(self.key, user['id'], user['session_version'],
                                 self.acfg['session_seconds'])
        return token, claims

    def clear_cookie(self):
        return ses.clear_cookie_header(self.acfg)

    # ------------------------------------------------------------ forged requests
    def check_post(self, headers):
        """The rules for every state-changing request.  `headers` is the request's
        header mapping (case-insensitive)."""
        if headers.get('X-MPS') != '1':
            raise AuthError(403, MSG_FORBIDDEN)
        origin = headers.get('Origin')
        if origin is not None and origin.lower() != self.acfg['origin']:
            raise AuthError(403, MSG_FORBIDDEN)
        ctype = (headers.get('Content-Type') or '').split(';')[0].strip().lower()
        if ctype != 'application/json':
            raise AuthError(415, 'Expected a JSON request')

    @staticmethod
    def parse_body(raw):
        try:
            body = json.loads(raw.decode('utf-8'))
        except (ValueError, UnicodeError):
            raise AuthError(400, 'Invalid request')
        if not isinstance(body, dict):
            raise AuthError(400, 'Invalid request')
        return body

    # ------------------------------------------------------------ sign-in / out
    def login(self, login, password, addr):
        """-> (Set-Cookie value, compiled user).  Raises AuthError."""
        if (not isinstance(login, str) or not isinstance(password, str)
                or not login.strip() or not password):
            raise AuthError(400, 'Enter a user id and a password')
        if len(login) > 254 or len(password) > pw.MAX_LENGTH:
            raise AuthError(401, MSG_INVALID)
        name = login.strip().lower()
        wait = self.limiter.check(name, addr)
        if wait > 0:
            self.audit_throttled('login_locked', name, '', '', addr)
            raise AuthError(429, 'Too many attempts. Try again in %d seconds.'
                            % math.ceil(wait), retry_after=math.ceil(wait))
        record = self.store.get_login_record(name)
        stored = record['password_hash'] if record else None
        ok = pw.verify_or_dummy(password, stored)
        if not (ok and record and record['enabled']):
            reason = ('unknown user' if record is None else 'disabled' if not record['enabled']
                      else 'no password' if stored is None else 'wrong password')
            self.limiter.failure(name, addr)
            self.audit('login_failed', name, '', reason, addr)
            raise AuthError(401, MSG_INVALID)
        self.limiter.success(name)
        user = self.store.compiled(record['id'])
        self.store.touch_login(record['id'])
        self.audit('login', name, '', '', addr)
        return self._cookie(user), user

    def logout(self, user, claims, addr):
        self.revoked.add(claims)
        self.audit('logout', user['login'], '', '', addr)

    def change_password(self, user, current, new, addr):
        """-> Set-Cookie value for this browser's new session.  Other sessions end."""
        if not isinstance(current, str) or not isinstance(new, str):
            raise AuthError(400, 'Give the current and the new password')
        name = user['login']
        wait = self.limiter.check(name, addr)
        if wait > 0:
            raise AuthError(429, 'Too many attempts. Try again in %d seconds.'
                            % math.ceil(wait), retry_after=math.ceil(wait))
        record = self.store.get_login_record(name)
        stored = record['password_hash'] if record else None
        if not pw.verify_or_dummy(current, stored) or not record:
            self.limiter.failure(name, addr)
            self.audit('password_change_failed', name, '', 'wrong current password', addr)
            raise AuthError(403, 'The current password is not correct')
        try:
            new_hash = pw.hash_password(new)
        except pw.PasswordError as e:
            raise AuthError(400, str(e))
        self.limiter.success(name)
        self.store.set_password_hash(user['id'], new_hash, actor=name, addr=addr)
        fresh = self.store.compiled(user['id'])
        return self._cookie(fresh)

    # ------------------------------------------------------------ administration
    def admin_gate(self, user, path, addr):
        """Every /api/admin/ request passes here first: signed in (401) and holding the
        management right (403), in audit mode as well as enforce mode."""
        if user is None:
            raise AuthError(401, 'Sign in required')
        if not user['manage']:
            self.audit_throttled('refused', user['login'], path,
                                 'management right required', addr)
            raise AuthError(403, 'Access denied')

    def admin_ops(self, cfg):
        with self._admin_lock:
            if self._admin is None:
                self._admin = adm.Admin(self.store, cfg)
            return self._admin

    def admin_call(self, user, method, path, query, body, cfg, addr):
        """-> (status, payload, extra), see adminapi.handle."""
        return adminapi.handle(self.admin_ops(cfg), adm.Actor.of(user), method, path, query,
                               body, addr)

    # ------------------------------------------------------------ /api/me
    def me(self, user, cfg):
        if user is None:                       # audit mode, not signed in
            out = off_me()
            out['mode'] = self.mode
            return out
        record = self.store.get_login_record(user['login'])
        out = {'auth': True, 'mode': self.mode, 'login': user['login'],
               'name': user['name'] or user['login'], 'roles': list(user['roles']),
               'view_all': user['view_all'], 'manage': user['manage'],
               'has_password': bool(record and record['password_hash'])}
        if self.enforcing:
            out['pending'] = user['pending']
            out['views'] = [] if user['pending'] else views_for(cfg, user)
        else:                                  # audit: nothing is narrowed
            out.update({'view_all': True, 'pending': False, 'views': list(ALL_VIEWS)})
        return out

    # ------------------------------------------------------------ refusals and rehearsal
    def anonymous(self, path, addr):
        """A request without a session (enforce: refused, audit: would be refused)."""
        event = 'refused' if self.enforcing else 'would_deny'
        self.audit_throttled(event, 'anonymous', path, 'no session', addr)

    def refused(self, user, path, q, addr, event='refused'):
        detail = ' '.join('%s=%s' % (k, q[k][:64]) for k in ('ip', 'exchange', 'segment', 'date',
                                                               'time') if k in q)
        self.audit_throttled(event, user['login'] if user else 'anonymous', path, detail, addr)

    def rehearse(self, user, path, q, cfg, full, addr):
        """Audit mode: `full` is the unrestricted answer that is about to be served.  Log
        what enforce mode would have refused or narrowed.  Never raises."""
        try:
            if user is None:
                return self.anonymous(path, addr)
            if user['view_all']:
                return
            scope = user['scope']
            ip, ex, sg = q.get('ip', ''), q.get('exchange', ''), q.get('segment', '')
            if path in ('/api/dates', '/api/data'):
                if not scope.allows(ip, ex or '', sg or ''):
                    self.refused(user, path, q, addr, 'would_deny')
            elif path == '/api/otr/data':
                if not scope.allows_server(ip):
                    self.refused(user, path, q, addr, 'would_deny')
                elif 'rows' in full:
                    got = otr.read_otr(cfg, ip, q.get('date', ''), q.get('time', ''), scope)
                    if len(got.get('rows', ())) != len(full['rows']):
                        self.refused(user, path, q, addr, 'would_narrow')
            elif path == '/api/servers':
                if data.servers_payload(cfg, scope)['servers'] != full['servers']:
                    self.refused(user, path, q, addr, 'would_narrow')
            elif path == '/api/reports':
                if len(data.reports_payload(cfg, scope)['reports']) != len(full['reports']):
                    self.refused(user, path, q, addr, 'would_narrow')
            elif path == '/api/otr/files':
                if otr.list_otr(cfg, scope)['servers'] != full['servers']:
                    self.refused(user, path, q, addr, 'would_narrow')
        except Exception:                       # audit mode must never break a request
            pass


# --------------------------------------------------------------------------- start-up
def startup_report(acfg, store=None, host='127.0.0.1', scrypt_ok=None):
    """-> [(level, text)] with level 'info', 'warning' or 'error'.  An 'error' means the
    server must not start."""
    out = []
    mode = acfg['mode']
    if mode == 'off':
        return [('info', 'Access   : off (no sign-in, no filtering)')]
    out.append(('info', 'Access   : mode %s, store %s' % (mode, acfg['db'])))
    if scrypt_ok is None:
        scrypt_ok = pw.available()
    if not scrypt_ok:
        out.append(('error', 'this Python has no hashlib.scrypt (needs OpenSSL 1.1 or '
                             'newer); passwords cannot be checked, so access control '
                             'cannot start'))
    if not acfg['https'] and not acfg['local']:
        out.append(('warning', 'auth.public_url %s is plain http: the session cookie cannot be '
                               'marked Secure and passwords travel unencrypted; put the '
                               'dashboard behind HTTPS when you can' % acfg['public_url']))
    if host not in ('127.0.0.1', '::1', 'localhost'):
        out.append(('warning', 'listening on %s: anyone who can reach this port directly '
                               'bypasses the reverse proxy; bind to 127.0.0.1 when a proxy '
                               'sits in front' % host))
    if mode == 'audit':
        out.append(('info', 'audit mode: nobody is blocked; what enforce mode would refuse is '
                            'written to the audit log'))
    if mode == 'enforce' and store is not None and store.count_superadmins() == 0:
        out.append(('warning', 'no SuperAdmin exists, so nobody can manage access; run '
                               'python3 mps_graph.py --create-superadmin LOGIN'))
    return out


def bootstrap_superadmin(store, login, password, actor):
    """Create the SuperAdmin (or reset its password).  -> (user id, created).  Raises
    st.StoreError for a bad login and pw.PasswordError for a weak password."""
    pw.check_policy(password)
    return store.ensure_superadmin(login, pw.hash_password(password), actor=actor)


def cli_create_superadmin(acfg, login, read_password, os_user=''):
    """The `--create-superadmin LOGIN` command: ask for the password twice (the caller
    supplies a no-echo reader), create or reset the user, record it in the audit log.
    -> (exit code, message)."""
    if not pw.available():
        return 1, 'this Python has no hashlib.scrypt (needs OpenSSL 1.1 or newer)'
    first = read_password('Password for %s: ' % login)
    if first != read_password('Repeat the password: '):
        return 1, 'the passwords do not match; nothing was changed'
    try:
        store = st.Store(acfg['db'])
    except sqlite3.Error as e:
        return 1, 'cannot open the access store %s: %s' % (acfg['db'], e)
    try:
        _, created = bootstrap_superadmin(store, login, first, 'cli:%s' % (os_user or 'unknown'))
    except (st.StoreError, pw.PasswordError) as e:
        return 1, 'nothing was changed: %s' % e
    finally:
        store.close()
    return 0, ('SuperAdmin %s created' if created else
               'Password of SuperAdmin %s reset (its sessions ended)') % login.strip().lower()


def open_context(acfg, environ=None):
    """Open the store and key and build the AuthContext.  Raises ses.SessionError or
    st.StoreError (the caller turns them into a start-up message)."""
    key = ses.load_key(acfg['key_file'], environ)
    try:
        store = st.Store(acfg['db'])
    except sqlite3.Error as e:
        raise st.StoreError('cannot open the access store %s: %s' % (acfg['db'], e))
    return AuthContext(acfg, store, key)