#!/usr/bin/env python3
"""
mps_graph.py - multi-dashboard "messages per second" viewer.

Run it on the server that holds the MPS csv files (no ssh needed):

    python3 mps_graph.py                                  # uses ./config.json if present
    python3 mps_graph.py --dir /else/home/oaa/MsgRatioPerSec --host 0.0.0.0 --port 8000

In the browser pick Server -> Exchange -> Segment -> Date -> Interval. The report is turned
into a file name (default MPS_Greek_<ip>_<EXCH>_<SEG>_<DDMMYYYY>.csv; older files without
exchange/segment are shown as "Unspecified"), checked for existence, and the dashboard
(line / bar / heatmap) is shown. Live files are tailed.

A menu switches between the MPS Report (above) and the OTR Report: dealer-wise order/trade
snapshots (DealerWise_Order_Trade_Report_<ip>_<DDMMYYYY>_<HHMMSS>.csv in `otr_dir`) with
analytics and every OTR above `otr_threshold` (default 2000) highlighted.

Layout:
    mps_graph.py   HTTP server + API         web/index.html
    mps_data.py    config, discovery, tail   web/css/style.css
    otr_data.py    OTR files + parsing       web/js/{widgets,peaks,charts,compare,otr,shell,app}.js
    config.json    optional settings

API (read-only): /api/servers /api/reports /api/dates /api/data (MPS),
                 /api/otr/files /api/otr/data?ip=&date=YYYY-MM-DD&time=HHMMSS (OTR)

Python 3.6+, standard library only. Default bind is 127.0.0.1; use
`ssh -L 8000:127.0.0.1:8000 host` or --host 0.0.0.0 to reach it remotely.
"""
import argparse
import getpass
import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from urllib.parse import parse_qs, urlparse

from auth import config as auth_config
from auth import limit as auth_limit
from auth import session as auth_session
from auth import store as auth_store
from auth import web as auth_web
from auth import adminapi
import mps_data as data
import otr_data as otr
from auth.scope import Forbidden
import ai.service as ai_service

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, 'web')
STATIC_RE = re.compile(r'^/((?:css|js)/[A-Za-z0-9_.-]+\.(?:css|js))$')
TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
}
CSP = ("default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
       "connect-src 'self'; img-src data:")
# with access control on, pages may not be framed and forms may only post to ourselves
CSP_AUTH = CSP + "; form-action 'self'; frame-ancestors 'none'"
PAGES = ('/', '/index.html')
API_PATHS = ('/api/servers', '/api/reports', '/api/dates', '/api/data',
             '/api/otr/files', '/api/otr/data')
POST_ROUTES = ('/auth/login', '/auth/logout', '/auth/password')


class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 256      # the default of 5 drops connections when hundreds poll together


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype, headers=None):
        try:
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            if ctype.startswith('text/html'):
                auth = getattr(self.server, 'auth', None)
                self.send_header('Content-Security-Policy', CSP if auth is None else CSP_AUTH)
            for name, value in headers or ():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, obj, code=200, headers=None):
        self._send(code, json.dumps(obj, separators=(',', ':')).encode(), 'application/json',
                   headers)

    def _redirect(self, location):
        self._send(302, b'', 'text/plain', [('Location', location)])

    def _static(self, rel):
        path = os.path.realpath(os.path.join(WEB, rel))
        if not path.startswith(os.path.realpath(WEB) + os.sep) or not os.path.isfile(path):
            return self._send(404, b'Not found', 'text/plain')
        with open(path, 'rb') as f:
            body = f.read()
        self._send(200, body, TYPES.get(os.path.splitext(path)[1], 'application/octet-stream'))

    def _addr(self):
        return auth_limit.client_addr(self.client_address[0],
                                      self.headers.get('X-Forwarded-For'))

    @staticmethod
    def _api(path, q, cfg, scope):
        """-> the JSON-able answer of a data route, or None for an unknown route.  `scope`
        None means unrestricted.  Raises BadRequest / Forbidden."""
        if path == '/api/servers':
            return data.servers_payload(cfg, scope)
        if path == '/api/reports':
            return data.reports_payload(cfg, scope)
        if path == '/api/dates':
            return {'dates': data.list_dates(
                cfg, q.get('ip', ''), q.get('exchange', ''), q.get('segment', ''), scope)}
        if path == '/api/data':
            try:
                offset = max(0, int(q.get('offset', '0')))
            except ValueError:
                offset = 0
            return data.read_data(cfg, q.get('ip', ''), q.get('date', ''), offset,
                                  q.get('exchange', ''), q.get('segment', ''), scope)
        if path == '/api/otr/files':
            return otr.list_otr(cfg, scope)
        if path == '/api/otr/data':
            return otr.read_otr(cfg, q.get('ip', ''), q.get('date', ''), q.get('time', ''),
                                scope)
        return None

    def do_GET(self):
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        cfg = self.server.cfg
        auth = getattr(self.server, 'auth', None)
        user, addr = None, ''
        try:
            m = STATIC_RE.match(url.path)
            if m:
                return self._static(m.group(1))

            if auth is None:                    # access control off: the original path
                if url.path in PAGES:
                    return self._static('index.html')
                if url.path == '/api/me':
                    return self._json(auth_web.off_me())
                out = self._api(url.path, q, cfg, None)
                if out is None:
                    return self._send(404, b'Not found', 'text/plain')
                return self._json(out)

            addr = self._addr()
            try:
                user, _ = auth.principal(self.headers.get('Cookie'))
            except Exception as e:
                if auth.enforcing:              # fail closed
                    raise
                print('warning: access store error (audit mode keeps serving): %s' % e,
                      file=sys.stderr)

            if url.path in ('/login', '/login.html'):
                if user is not None:
                    return self._redirect(auth.home_url)
                return self._static('login.html')
            if url.path == '/api/me':
                if user is None and auth.enforcing:
                    return self._json({'error': 'Sign in required'}, 401)
                return self._json(auth.me(user, cfg))

            if url.path.startswith(adminapi.PREFIX):
                return self._admin(auth, user, url, q, addr, cfg)

            if user is None and auth.enforcing:
                if url.path in PAGES or url.path in API_PATHS:
                    auth.anonymous(url.path, addr)
                if url.path in PAGES:
                    return self._redirect(auth.login_url)
                if url.path in API_PATHS:
                    return self._json({'error': 'Sign in required'}, 401)
                return self._send(404, b'Not found', 'text/plain')

            if url.path in PAGES:
                return self._static('index.html')
            scope = user['scope'] if auth.enforcing else None
            out = self._api(url.path, q, cfg, scope)
            if out is None:
                return self._send(404, b'Not found', 'text/plain')
            if not auth.enforcing:
                auth.rehearse(user, url.path, q, cfg, out, addr)
            return self._json(out)
        except data.BadRequest as e:
            self._json({'error': str(e)}, 400)
        except Forbidden:
            if auth is not None:
                auth.refused(user, url.path, q, addr)
            self._json({'error': 'Access denied'}, 403)
        except Exception as e:  # keep the server alive; report to the client
            if auth is not None and auth.enforcing:
                print('error: %s %s: %r' % (self.command, url.path, e), file=sys.stderr)
                return self._json({'error': 'internal error'}, 500)
            self._json({'error': 'internal error: %s' % e}, 500)

    def _body(self, auth, limit=auth_web.MAX_BODY):
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            length = -1
        if length <= 0:
            raise auth_web.AuthError(400, 'Invalid request')
        if length > limit:
            raise auth_web.AuthError(413, 'Request too large')
        return auth.parse_body(self.rfile.read(length))

    def _admin(self, auth, user, url, q, addr, cfg):
        """One /api/admin/ request (GET or POST): the management check comes first, so a
        request that may not proceed is refused before its body is read."""
        try:
            auth.admin_gate(user, url.path, addr)
            body = None
            if self.command == 'POST':
                limit = (auth_web.ADMIN_IMPORT_BODY if url.path == auth_web.ADMIN_IMPORT_PATH
                         else auth_web.ADMIN_BODY)
                body = self._body(auth, limit)
            code, payload, extra = auth.admin_call(user, self.command, url.path, q, body,
                                                   cfg, addr)
        except auth_web.AuthError as e:
            wait = [('Retry-After', str(e.retry_after))] if e.retry_after else None
            return self._json({'error': e.message}, e.code, wait)
        if extra and 'csv' in extra:
            return self._send(code, payload.encode('utf-8'), 'text/csv; charset=utf-8',
                              [('Content-Disposition', 'attachment; filename="%s"' % extra['csv'])])
        self._json(payload, code)

    def do_POST(self):
        url = urlparse(self.path)
        auth = getattr(self.server, 'auth', None)

        if url.path == '/api/ai/ask':
            try:
                length = int(self.headers.get('Content-Length') or 0)
            except ValueError:
                length = -1
            if length <= 0 or length > 65536:
                return self._json({'error': 'Invalid request body'}, 400)
            try:
                raw_body = self.rfile.read(length)
                body = json.loads(raw_body.decode('utf-8'))
            except Exception:
                return self._json({'error': 'Invalid JSON body'}, 400)

            user = None
            scope = None
            if auth is not None:
                try:
                    user, _ = auth.principal(self.headers.get('Cookie'))
                except Exception:
                    user = None
                if user is None and auth.enforcing:
                    return self._json({'error': 'Sign in required'}, 401)
                scope = user['scope'] if (user and auth.enforcing) else None

            query_text = body.get('query', '')
            res = ai_service.handle_ask(query_text, self.server.cfg, scope=scope)
            login = user['login'] if user else 'anonymous'
            took_ms = res.get('meta', {}).get('took_ms', 0)
            src = res.get('meta', {}).get('source', '')
            print("[AI Query] user=%s src=%s took=%.1fms query=%r" % (login, src, took_ms, query_text[:60]))
            return self._json(res, 200 if res.get('ok') else 400)

        if auth is None or not (url.path in POST_ROUTES or url.path.startswith(adminapi.PREFIX)):
            return self._send(404, b'Not found', 'text/plain')
        addr = self._addr()
        try:
            try:
                auth.check_post(self.headers)
            except auth_web.AuthError:
                auth.audit_throttled('refused', 'anonymous', 'POST ' + url.path,
                                     'forged-request rules', addr)
                raise
            if url.path.startswith(adminapi.PREFIX):
                user, _ = auth.principal(self.headers.get('Cookie'))
                return self._admin(auth, user, url, {}, addr, self.server.cfg)
            body = self._body(auth)
            if url.path == '/auth/login':
                cookie, user = auth.login(body.get('login'), body.get('password'), addr)
                return self._json({'ok': True, 'name': user['name'] or user['login']},
                                  headers=[('Set-Cookie', cookie)])
            user, claims = auth.principal(self.headers.get('Cookie'))
            if url.path == '/auth/logout':
                if user is not None:
                    auth.logout(user, claims, addr)
                return self._json({'ok': True}, headers=[('Set-Cookie', auth.clear_cookie())])
            if user is None:
                raise auth_web.AuthError(401, 'Sign in required')
            cookie = auth.change_password(user, body.get('current'), body.get('new'), addr)
            self._json({'ok': True}, headers=[('Set-Cookie', cookie)])
        except auth_web.AuthError as e:
            wait = [('Retry-After', str(e.retry_after))] if e.retry_after else None
            self._json({'error': e.message}, e.code, wait)
        except Exception as e:
            print('error: POST %s: %r' % (url.path, e), file=sys.stderr)
            self._json({'error': 'internal error'}, 500)

    def log_message(self, *args):
        pass


def main():
    ap = argparse.ArgumentParser(description='Multi-dashboard messages-per-second viewer.')
    ap.add_argument('--config', help='JSON config (default: config.json next to this script, if present)')
    ap.add_argument('--dir', help='directory holding the MPS csv files (overrides config)')
    ap.add_argument('--host', default='127.0.0.1', help='bind address (default 127.0.0.1)')
    ap.add_argument('--port', type=int, default=8000, help='port (default 8000)')
    ap.add_argument('--interval', type=int, help='browser poll interval in ms (overrides config)')
    ap.add_argument('--auth-mode', choices=auth_config.MODES,
                    help='access control mode (overrides "auth.mode" in the config)')
    ap.add_argument('--create-superadmin', metavar='LOGIN',
                    help='create (or reset the password of) a SuperAdmin and exit')
    args = ap.parse_args()

    cfg_path = args.config
    if not cfg_path and os.path.isfile(os.path.join(HERE, 'config.json')):
        cfg_path = os.path.join(HERE, 'config.json')
    try:
        cfg = otr.load_otr_config(
            data.load_config(cfg_path, dir=args.dir, interval_ms=args.interval))
        acfg = auth_config.load_auth_config(
            cfg, os.path.dirname(os.path.abspath(cfg_path)) if cfg_path else HERE,
            mode=args.auth_mode, need_public_url=not args.create_superadmin)
    except data.ConfigError as e:
        sys.exit('error: %s' % e)

    if cfg.get('notice'):
        print('notice   : %s' % cfg['notice'], file=sys.stderr)

    if args.create_superadmin:
        try:
            os_user = getpass.getuser()
        except Exception:
            os_user = ''
        code, message = auth_web.cli_create_superadmin(
            acfg, args.create_superadmin, getpass.getpass, os_user)
        print(message, file=sys.stderr if code else sys.stdout)
        sys.exit(code)

    auth = None
    if acfg['mode'] != 'off':
        try:
            auth = auth_web.open_context(acfg)
        except (auth_session.SessionError, auth_store.StoreError) as e:
            sys.exit('error: %s' % e)
    report = auth_web.startup_report(acfg, auth.store if auth else None, args.host)
    for level, text in report:
        if level == 'info':
            print(text)
        else:
            print('%s: %s' % (level, text), file=sys.stderr)
    if any(level == 'error' for level, _ in report):
        sys.exit(1)

    try:
        found = data.list_servers(cfg)
        print('Data dir : %s  (%d server(s) found)' % (cfg['dir'], len(found)))
    except OSError as e:
        print('warning: cannot read %s: %s' % (cfg['dir'], e.strerror or e), file=sys.stderr)

    srv = Server((args.host, args.port), Handler)
    srv.cfg = cfg
    srv.auth = auth
    print('Serving  : http://%s:%d/  (Ctrl+C to stop)' % (args.host, args.port))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == '__main__':
    main()