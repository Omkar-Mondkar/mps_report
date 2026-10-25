"""
auth/admin.py - every management operation on users, groups, roles and grants.

One module, used by the web routes (auth/adminapi.py) and the command-line tool
(auth/cli.py), so the safeguards and the audit entries cannot differ between them.

  * `Admin(store, cfg)` - each method takes the acting `Actor` and returns plain data
  * writes go through the store's single write transaction; the safeguards are checked
    inside that same transaction, so a refused change leaves nothing behind
  * lists read one page (LIMIT/OFFSET, the audit log uses keyset paging)
  * `AdminError(code, message, data)` - 400 bad input, 404 not found, 409 the request is
    valid but the current state forbids it (stale screen, duplicate, needs confirmation,
    last SuperAdmin ...); the message is always safe to show

SQL is kept to what SQLite 3.7+ understands (no RETURNING, no upsert).
"""
import csv
import io
import re
import secrets
import sqlite3
import threading
import time

import mps_data as data
import otr_data as otr

from . import password as pw
from . import scope as sc
from . import store as st

PAGE_MAX = 200
BULK_MAX = 500                    # people per assign / member call
IMPORT_MAX_LINES = 10000
IMPORT_MAX_BYTES = 2 * 1024 * 1024
IMPORT_PROBLEMS_SHOWN = 200
IMPORT_TTL = 900                  # seconds a preview can be confirmed
IMPORT_TOKENS_MAX = 20
CATALOG_SECONDS = 60
AUDIT_PAGE_MAX = 500
AUDIT_EXPORT_MAX = 100000
FORMULA_CHARS = ('=', '+', '-', '@', '\t', '\r')
DENIED_EVENTS = ('login_failed', 'login_locked', 'refused', 'would_deny', 'would_narrow',
                 'password_change_failed')
SUPER = 'SuperAdmin'
ISO_DAY_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
ISO_TIME_RE = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z?$')

_WAITING = ("NOT EXISTS (SELECT 1 FROM user_roles x WHERE x.user_id = u.id) "
            "AND NOT EXISTS (SELECT 1 FROM user_groups x WHERE x.user_id = u.id) "
            "AND NOT EXISTS (SELECT 1 FROM grants x WHERE x.owner_type = 'user' "
            "AND x.owner_id = u.id)")
_USER_COLS = ('u.id, u.login, u.name, u.email, u.enabled, u.created, u.last_login, u.version, '
              '(u.password_hash IS NOT NULL) AS has_password')


class AdminError(Exception):
    def __init__(self, code, message, data=None):
        Exception.__init__(self, message)
        self.code = code
        self.message = message
        self.data = data or {}


class Actor:
    """Who is acting: the name written to the audit log and, for a signed-in person, the
    user id (needed for the "not yourself" rule)."""

    def __init__(self, name, user_id=None):
        self.name = name
        self.user_id = user_id

    @classmethod
    def cli(cls, os_user=''):
        return cls('cli:%s' % (os_user or 'unknown'))

    @classmethod
    def of(cls, user):
        return cls(user['login'], user['id'])


def conflict(reason, message, **extra):
    extra['reason'] = reason
    return AdminError(409, message, extra)


# ---------------------------------------------------------------------------- helpers
def like_escape(term):
    """Make `term` safe inside LIKE ... ESCAPE '\\' (the % _ and \\ it may contain)."""
    return term.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')


def paging(page, size, default=50):
    try:
        size = int(size)
    except (TypeError, ValueError):
        size = default
    size = max(1, min(size, PAGE_MAX))
    try:
        page = max(1, int(page))
    except (TypeError, ValueError):
        page = 1
    return page, size, (page - 1) * size


def need_int(value, what):
    if isinstance(value, bool) or not isinstance(value, int):
        try:
            if isinstance(value, str) and value.strip():
                return int(value)
        except ValueError:
            pass
        raise AdminError(400, '%s must be a number' % what)
    return value


def need_ids(values, what='people'):
    if not isinstance(values, list) or not values:
        raise AdminError(400, 'Choose at least one of the %s' % what)
    if len(values) > BULK_MAX:
        raise AdminError(400, 'At most %d %s per request' % (BULK_MAX, what))
    out = []
    for v in values:
        i = need_int(v, 'an id')
        if i not in out:
            out.append(i)
    return out


def safe_cell(value):
    """A spreadsheet runs cells that begin with = + - @ tab or CR as formulas; a leading
    apostrophe makes it text."""
    text = '' if value is None else str(value)
    return "'" + text if text.startswith(FORMULA_CHARS) else text


def grant_text(server, exchange, segment, dealer):
    """A grant in words, for lists and the command line (the browser has the same rule in
    web/js/access.js)."""
    if exchange == '*' and segment == '*':
        what = 'Every exchange and segment'
    elif exchange != '*' and segment != '*':
        what = '%s %s' % (exchange, segment)
    elif segment == '*':
        what = '%s, every segment' % exchange
    else:
        what = '%s of every exchange' % segment
    where = 'on every server' if server == '*' else 'on server %s' % server
    if dealer == '*':
        who = 'all dealers'
    elif dealer.endswith('*'):
        who = 'dealers starting %s' % dealer[:-1]
    else:
        who = 'dealer %s' % dealer
    return '%s %s, %s' % (what, where, who)


def _grant(row):
    return {'id': row['id'], 'server': row['server'], 'exchange': row['exchange'],
            'segment': row['segment'], 'dealer': row['dealer'],
            'text': grant_text(row['server'], row['exchange'], row['segment'], row['dealer'])}


def _chunks(items, n=400):
    for i in range(0, len(items), n):
        yield items[i:i + n]


def _marks(items):
    return ','.join('?' * len(items))


def _text(value, what, limit):
    value = value.strip() if isinstance(value, str) else ''
    if len(value) > limit or any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
        raise AdminError(400, '%s must be at most %d characters without control characters'
                         % (what, limit))
    return value


# ---------------------------------------------------------------------------- Admin
class Admin:
    def __init__(self, store, cfg=None, hasher=None, clock=time.time):
        self.store = store
        self.cfg = cfg
        self._hash = hasher or pw.hash_password
        self._clock = clock
        self._imports = {}
        self._imports_lock = threading.Lock()
        self._catalog = None
        self._catalog_lock = threading.Lock()

    # ------------------------------------------------------------------ plumbing
    def _tx(self):
        return self.store._tx()

    def _use(self):
        return self.store._use()

    def _audit(self, c, by, event, subject='', detail=None, addr=''):
        self.store._audit(c, by.name, event, subject, detail, addr)

    def _convert(self, fn, *args, **kw):
        try:
            return fn(*args, **kw)
        except st.StoreError as e:
            raise AdminError(400, str(e))

    @staticmethod
    def _version(value):
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, int):
            raise AdminError(400, 'version must be a number')
        return value

    @staticmethod
    def _touch(c, table, row_id, version, what):
        """Bump the item's version; refuse when `version` is given and no longer current."""
        if version is None:
            cur = c.execute('UPDATE %s SET version = version + 1 WHERE id = ?' % table, (row_id,))
        else:
            cur = c.execute('UPDATE %s SET version = version + 1 WHERE id = ? AND version = ?'
                            % table, (row_id, version))
        if cur.rowcount == 0:
            if c.execute('SELECT 1 FROM %s WHERE id = ?' % table, (row_id,)).fetchone():
                raise conflict('stale', 'Someone else changed this %s. Reload it and try '
                                        'again.' % what)
            raise AdminError(404, 'No such %s' % what)

    @staticmethod
    def _not_self(by, user_ids, what):
        if by.user_id is not None and by.user_id in user_ids:
            raise conflict('safeguard', 'You cannot change your own %s; another SuperAdmin '
                                        'must do it.' % what)

    def _guard_supers(self, c, before):
        if before > 0 and self.store.count_superadmins(c) == 0:
            raise conflict('safeguard', 'Refused: at least one enabled SuperAdmin must remain.')

    @staticmethod
    def _user_row(c, user_id):
        row = c.execute('SELECT id, login, name, email, enabled, last_login FROM users '
                        'WHERE id = ?', (user_id,)).fetchone()
        if row is None:
            raise AdminError(404, 'No such user')
        return row

    @staticmethod
    def _role_row(c, role_id):
        row = c.execute('SELECT id, name, builtin, view_all, manage, version FROM roles '
                        'WHERE id = ?', (role_id,)).fetchone()
        if row is None:
            raise AdminError(404, 'No such role')
        return row

    @staticmethod
    def _custom_role(c, role_id):
        row = Admin._role_row(c, role_id)
        if row['builtin']:
            raise conflict('builtin', 'The built-in role %s cannot be changed.' % row['name'])
        return row

    @staticmethod
    def _group_row(c, group_id):
        row = c.execute('SELECT id, name, version FROM "groups" WHERE id = ?',
                        (group_id,)).fetchone()
        if row is None:
            raise AdminError(404, 'No such group')
        return row

    # ================================================================== users
    @staticmethod
    def _user_item(row):
        return {'id': row['id'], 'login': row['login'], 'name': row['name'],
                'email': row['email'], 'enabled': bool(row['enabled']),
                'has_password': bool(row['has_password']), 'created': row['created'],
                'last_login': row['last_login'], 'version': row['version']}

    def _decorate(self, c, items):
        """Add the direct role names and the waiting flag to one page of users."""
        if not items:
            return items
        ids = [i['id'] for i in items]
        roles = {}
        for r in c.execute('SELECT ur.user_id, r.name FROM user_roles ur JOIN roles r '
                           'ON r.id = ur.role_id WHERE ur.user_id IN (%s) ORDER BY r.id'
                           % _marks(ids), ids):
            roles.setdefault(r['user_id'], []).append(r['name'])
        waiting = {r['id'] for r in c.execute(
            'SELECT u.id FROM users u WHERE u.id IN (%s) AND %s' % (_marks(ids), _WAITING), ids)}
        for i in items:
            i['roles'] = roles.get(i['id'], [])
            i['waiting'] = i['id'] in waiting
        return items

    def _user_page(self, where, args, page, size, order, offset):
        sql_where = (' WHERE ' + ' AND '.join(where)) if where else ''
        with self._use() as c:
            total = c.execute('SELECT COUNT(*) AS n FROM users u' + sql_where, args).fetchone()['n']
            rows = c.execute('SELECT %s FROM users u%s ORDER BY %s LIMIT ? OFFSET ?'
                             % (_USER_COLS, sql_where, order), args + [size, offset]).fetchall()
            items = self._decorate(c, [self._user_item(r) for r in rows])
        return {'items': items, 'total': total, 'page': page, 'size': size}

    @staticmethod
    def _search_where(q, where, args):
        q = (q or '').strip()
        if q:
            pat = '%' + like_escape(q) + '%'
            where.append("(u.login LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\' "
                         "OR u.email LIKE ? ESCAPE '\\')")
            args.extend([pat, pat, pat])

    def user_list(self, q='', status='', role=None, group=None, page=1, size=50):
        page, size, offset = paging(page, size)
        where, args = [], []
        self._search_where(q, where, args)
        if status == 'enabled':
            where.append('u.enabled = 1')
        elif status == 'disabled':
            where.append('u.enabled = 0')
        elif status == 'waiting':
            where.append('(%s)' % _WAITING)
        elif status:
            raise AdminError(400, 'status must be enabled, disabled or waiting')
        if role not in (None, ''):
            rid = need_int(role, 'role')
            where.append('(EXISTS (SELECT 1 FROM user_roles x WHERE x.user_id = u.id '
                         'AND x.role_id = ?) OR EXISTS (SELECT 1 FROM user_groups ug '
                         'JOIN group_roles gr ON gr.group_id = ug.group_id '
                         'WHERE ug.user_id = u.id AND gr.role_id = ?))')
            args.extend([rid, rid])
        if group not in (None, ''):
            where.append('EXISTS (SELECT 1 FROM user_groups x WHERE x.user_id = u.id '
                         'AND x.group_id = ?)')
            args.append(need_int(group, 'group'))
        return self._user_page(where, args, page, size, 'u.login', offset)

    def user_get(self, user_id):
        with self._use() as c:
            row = c.execute('SELECT %s FROM users u WHERE u.id = ?' % _USER_COLS,
                            (user_id,)).fetchone()
            if row is None:
                raise AdminError(404, 'No such user')
            out = self._user_item(row)
            out['roles'] = [{'id': r['id'], 'name': r['name'], 'builtin': bool(r['builtin'])}
                            for r in c.execute(
                                'SELECT r.id, r.name, r.builtin FROM user_roles ur JOIN roles r '
                                'ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY r.id',
                                (user_id,))]
            out['groups'] = [dict(r) for r in c.execute(
                'SELECT g.id, g.name FROM user_groups ug JOIN "groups" g ON g.id = ug.group_id '
                'WHERE ug.user_id = ? ORDER BY g.name', (user_id,))]
            out['group_roles'] = [dict(r) for r in c.execute(
                'SELECT r.id, r.name, g.id AS group_id, g.name AS "group" FROM user_groups ug '
                'JOIN "groups" g ON g.id = ug.group_id '
                'JOIN group_roles gr ON gr.group_id = g.id JOIN roles r ON r.id = gr.role_id '
                'WHERE ug.user_id = ? ORDER BY g.name, r.id', (user_id,))]
            out['grants'] = [_grant(r) for r in c.execute(
                "SELECT * FROM grants WHERE owner_type = 'user' AND owner_id = ? ORDER BY id",
                (user_id,))]
            out['identities'] = [dict(r) for r in c.execute(
                'SELECT provider, subject FROM identities WHERE user_id = ? '
                'ORDER BY provider, subject', (user_id,))]
            out['waiting'] = bool(c.execute(
                'SELECT 1 FROM users u WHERE u.id = ? AND %s' % _WAITING, (user_id,)).fetchone())
        return out

    def user_create(self, login, by, name='', email='', password=None, enabled=True, addr=''):
        login = self._convert(st.norm_login, login)
        name = _text(name, 'Name', 200)
        email = _text(email, 'E-mail', 254)
        hashed = self._hash_new(password) if password else None
        with self._tx() as c:
            same = c.execute('SELECT login FROM users WHERE login = ?', (login,)).fetchone()
            if same:
                raise conflict('duplicate', 'A user "%s" already exists (sign-in names ignore '
                                            'letter case).' % same['login'])
            cur = c.execute(
                'INSERT INTO users(login, name, email, password_hash, enabled, created) '
                'VALUES (?, ?, ?, ?, ?, ?)',
                (login, name, email, hashed, 1 if enabled else 0, st.now_iso()))
            self._audit(c, by, 'user.create', login,
                        {'name': name, 'enabled': bool(enabled), 'password': bool(hashed)}, addr)
            uid = cur.lastrowid
        return self.user_get(uid)

    def _hash_new(self, password):
        if not pw.available():
            raise AdminError(400, 'This Python cannot hash passwords (no hashlib.scrypt)')
        try:
            pw.check_policy(password)
            return self._hash(password)
        except pw.PasswordError as e:
            raise AdminError(400, str(e))

    def user_update(self, user_id, by, name=None, email=None, version=None, addr=''):
        version = self._version(version)
        with self._tx() as c:
            row = self._user_row(c, user_id)
            new_name = row['name'] if name is None else _text(name, 'Name', 200)
            new_email = row['email'] if email is None else _text(email, 'E-mail', 254)
            self._touch(c, 'users', user_id, version, 'user')
            c.execute('UPDATE users SET name = ?, email = ? WHERE id = ?',
                      (new_name, new_email, user_id))
            self._audit(c, by, 'user.update', row['login'],
                        {'before': {'name': row['name'], 'email': row['email']},
                         'after': {'name': new_name, 'email': new_email}}, addr)
        return self.user_get(user_id)

    def user_set_enabled(self, user_id, enabled, by, version=None, addr=''):
        version = self._version(version)
        self._not_self(by, [user_id], 'enabled state')
        with self._tx() as c:
            before = self.store.count_superadmins(c)
            row = self._user_row(c, user_id)
            self._touch(c, 'users', user_id, version, 'user')
            bump = '' if enabled else ', session_version = session_version + 1'
            c.execute('UPDATE users SET enabled = ?%s WHERE id = ?' % bump,
                      (1 if enabled else 0, user_id))
            self._audit(c, by, 'user.enable' if enabled else 'user.disable', row['login'], '', addr)
            if not enabled:
                self._guard_supers(c, before)
        return self.user_get(user_id)

    def user_set_password(self, user_id, password, by, addr=''):
        hashed = self._hash_new(password)
        with self._tx() as c:
            row = self._user_row(c, user_id)
            c.execute('UPDATE users SET password_hash = ?, session_version = session_version + 1 '
                      'WHERE id = ?', (hashed, user_id))
            self._audit(c, by, 'user.password', row['login'], '', addr)
        return self.user_get(user_id)

    def user_end_sessions(self, user_id, by, addr=''):
        with self._tx() as c:
            row = self._user_row(c, user_id)
            c.execute('UPDATE users SET session_version = session_version + 1 WHERE id = ?',
                      (user_id,))
            self._audit(c, by, 'user.sessions_ended', row['login'], '', addr)
        return {'ok': True}

    def user_unlink_identity(self, user_id, provider, subject, by, addr=''):
        with self._tx() as c:
            row = self._user_row(c, user_id)
            cur = c.execute('DELETE FROM identities WHERE user_id = ? AND provider = ? '
                            'AND subject = ?', (user_id, str(provider), str(subject)))
            if cur.rowcount == 0:
                raise AdminError(404, 'That Microsoft identity is not linked to this user')
            self._audit(c, by, 'user.identity_unlink', row['login'],
                        {'provider': str(provider)}, addr)
        return self.user_get(user_id)

    def user_delete(self, user_id, by, addr=''):
        self._not_self(by, [user_id], 'own account')
        with self._tx() as c:
            before = self.store.count_superadmins(c)
            row = self._user_row(c, user_id)
            if row['last_login']:
                raise conflict('signed_in', 'Only a user who has never signed in can be '
                                            'deleted. Disable this user instead.')
            c.execute("DELETE FROM grants WHERE owner_type = 'user' AND owner_id = ?", (user_id,))
            c.execute('DELETE FROM users WHERE id = ?', (user_id,))
            self._audit(c, by, 'user.delete', row['login'], '', addr)
            self._guard_supers(c, before)
        return {'ok': True}

    # ---- roles and groups of one user
    def _link_user(self, table, col, user_id, other_id, add, by, event, addr):
        self._not_self(by, [user_id], 'roles and groups')
        with self._tx() as c:
            before = self.store.count_superadmins(c)
            user = self._user_row(c, user_id)
            if col == 'role_id':
                other = self._role_row(c, other_id)
            else:
                other = self._group_row(c, other_id)
            if add:
                cur = c.execute('INSERT OR IGNORE INTO %s(user_id, %s) VALUES (?, ?)'
                                % (table, col), (user_id, other_id))
            else:
                cur = c.execute('DELETE FROM %s WHERE user_id = ? AND %s = ?' % (table, col),
                                (user_id, other_id))
            changed = cur.rowcount > 0
            if changed:
                self._audit(c, by, event, user['login'], other['name'], addr)
                if not add:
                    self._guard_supers(c, before)
        return changed

    def user_role_add(self, user_id, role_id, by, addr=''):
        return self._link_user('user_roles', 'role_id', user_id, role_id, True, by,
                               'user.role_add', addr)

    def user_role_remove(self, user_id, role_id, by, addr=''):
        return self._link_user('user_roles', 'role_id', user_id, role_id, False, by,
                               'user.role_remove', addr)

    def user_group_add(self, user_id, group_id, by, addr=''):
        return self._link_user('user_groups', 'group_id', user_id, group_id, True, by,
                               'group.member_add', addr)

    def user_group_remove(self, user_id, group_id, by, addr=''):
        return self._link_user('user_groups', 'group_id', user_id, group_id, False, by,
                               'group.member_remove', addr)

    # ================================================================== groups
    def group_list(self, q='', page=1, size=50):
        page, size, offset = paging(page, size)
        where, args = '', []
        q = (q or '').strip()
        if q:
            where = " WHERE g.name LIKE ? ESCAPE '\\'"
            args = ['%' + like_escape(q) + '%']
        with self._use() as c:
            total = c.execute('SELECT COUNT(*) AS n FROM "groups" g' + where, args).fetchone()['n']
            rows = c.execute('SELECT g.id, g.name, g.version FROM "groups" g%s ORDER BY g.name '
                             'LIMIT ? OFFSET ?' % where, args + [size, offset]).fetchall()
            items = [dict(r) for r in rows]
            ids = [i['id'] for i in items]
            members, roles = {}, {}
            if ids:
                for r in c.execute('SELECT group_id, COUNT(*) AS n FROM user_groups '
                                   'WHERE group_id IN (%s) GROUP BY group_id' % _marks(ids), ids):
                    members[r['group_id']] = r['n']
                for r in c.execute('SELECT gr.group_id, r.name FROM group_roles gr JOIN roles r '
                                   'ON r.id = gr.role_id WHERE gr.group_id IN (%s) ORDER BY r.id'
                                   % _marks(ids), ids):
                    roles.setdefault(r['group_id'], []).append(r['name'])
            for i in items:
                i['members'] = members.get(i['id'], 0)
                i['roles'] = roles.get(i['id'], [])
        return {'items': items, 'total': total, 'page': page, 'size': size}

    def group_get(self, group_id):
        with self._use() as c:
            row = self._group_row(c, group_id)
            out = dict(row)
            out['members'] = c.execute('SELECT COUNT(*) AS n FROM user_groups WHERE group_id = ?',
                                       (group_id,)).fetchone()['n']
            out['roles'] = [dict(r) for r in c.execute(
                'SELECT r.id, r.name FROM group_roles gr JOIN roles r ON r.id = gr.role_id '
                'WHERE gr.group_id = ? ORDER BY r.id', (group_id,))]
        return out

    def group_create(self, name, by, addr=''):
        name = self._convert(st._name, name, 'group name')
        with self._tx() as c:
            if c.execute('SELECT 1 FROM "groups" WHERE name = ?', (name,)).fetchone():
                raise conflict('duplicate', 'A group "%s" already exists.' % name)
            cur = c.execute('INSERT INTO "groups"(name) VALUES (?)', (name,))
            self._audit(c, by, 'group.create', name, '', addr)
            gid = cur.lastrowid
        return self.group_get(gid)

    def group_rename(self, group_id, name, by, version=None, addr=''):
        version = self._version(version)
        name = self._convert(st._name, name, 'group name')
        with self._tx() as c:
            row = self._group_row(c, group_id)
            if c.execute('SELECT 1 FROM "groups" WHERE name = ? AND id <> ?',
                         (name, group_id)).fetchone():
                raise conflict('duplicate', 'A group "%s" already exists.' % name)
            self._touch(c, '"groups"', group_id, version, 'group')
            c.execute('UPDATE "groups" SET name = ? WHERE id = ?', (name, group_id))
            self._audit(c, by, 'group.rename', row['name'], {'to': name}, addr)
        return self.group_get(group_id)

    def group_delete(self, group_id, by, confirm=False, addr=''):
        with self._tx() as c:
            before = self.store.count_superadmins(c)
            row = self._group_row(c, group_id)
            n = c.execute('SELECT COUNT(*) AS n FROM user_groups WHERE group_id = ?',
                          (group_id,)).fetchone()['n']
            if n and not confirm:
                raise conflict('confirm', 'The group "%s" has %d member%s who would lose what '
                                          'only this group gives them. Confirm to delete it.'
                               % (row['name'], n, '' if n == 1 else 's'),
                               affected=n, confirm=True)
            c.execute('DELETE FROM "groups" WHERE id = ?', (group_id,))
            self._audit(c, by, 'group.delete', row['name'], {'members': n}, addr)
            self._guard_supers(c, before)
        return {'ok': True, 'affected': n}

    def group_members(self, group_id, q='', page=1, size=50):
        page, size, offset = paging(page, size)
        with self._use() as c:
            self._group_row(c, group_id)
        where = ['u.id IN (SELECT user_id FROM user_groups WHERE group_id = ?)']
        args = [group_id]
        self._search_where(q, where, args)
        return self._user_page(where, args, page, size, 'u.login', offset)

    def _members_change(self, group_id, user_ids, add, by, addr):
        user_ids = need_ids(user_ids)
        self._not_self(by, user_ids, 'groups')
        with self._tx() as c:
            before = self.store.count_superadmins(c)
            group = self._group_row(c, group_id)
            changed = 0
            for uid in user_ids:
                user = c.execute('SELECT login FROM users WHERE id = ?', (uid,)).fetchone()
                if user is None:
                    raise AdminError(404, 'No such user')
                if add:
                    cur = c.execute('INSERT OR IGNORE INTO user_groups(user_id, group_id) '
                                    'VALUES (?, ?)', (uid, group_id))
                else:
                    cur = c.execute('DELETE FROM user_groups WHERE user_id = ? AND group_id = ?',
                                    (uid, group_id))
                if cur.rowcount > 0:
                    changed += 1
                    self._audit(c, by, 'group.member_add' if add else 'group.member_remove',
                                user['login'], group['name'], addr)
            if not add:
                self._guard_supers(c, before)
        return {'changed': changed}

    def group_members_add(self, group_id, user_ids, by, addr=''):
        return self._members_change(group_id, user_ids, True, by, addr)

    def group_members_remove(self, group_id, user_ids, by, addr=''):
        return self._members_change(group_id, user_ids, False, by, addr)

    def _group_role(self, group_id, role_id, add, by, addr):
        with self._tx() as c:
            before = self.store.count_superadmins(c)
            group = self._group_row(c, group_id)
            role = self._role_row(c, role_id)
            if add:
                cur = c.execute('INSERT OR IGNORE INTO group_roles(group_id, role_id) '
                                'VALUES (?, ?)', (group_id, role_id))
            else:
                cur = c.execute('DELETE FROM group_roles WHERE group_id = ? AND role_id = ?',
                                (group_id, role_id))
            if cur.rowcount > 0:
                self._audit(c, by, 'group.role_add' if add else 'group.role_remove',
                            group['name'], role['name'], addr)
                if not add:
                    self._guard_supers(c, before)
        return cur.rowcount > 0

    def group_role_add(self, group_id, role_id, by, addr=''):
        return self._group_role(group_id, role_id, True, by, addr)

    def group_role_remove(self, group_id, role_id, by, addr=''):
        return self._group_role(group_id, role_id, False, by, addr)

    # ================================================================== roles
    def _role_users(self, c, role_id):
        return c.execute(
            'SELECT COUNT(*) AS n FROM (SELECT user_id FROM user_roles WHERE role_id = ? '
            'UNION SELECT ug.user_id FROM group_roles gr JOIN user_groups ug '
            'ON ug.group_id = gr.group_id WHERE gr.role_id = ?)', (role_id, role_id)).fetchone()['n']

    def role_list(self, q='', page=1, size=50):
        page, size, offset = paging(page, size)
        where, args = '', []
        q = (q or '').strip()
        if q:
            where = " WHERE r.name LIKE ? ESCAPE '\\'"
            args = ['%' + like_escape(q) + '%']
        with self._use() as c:
            total = c.execute('SELECT COUNT(*) AS n FROM roles r' + where, args).fetchone()['n']
            items = []
            for r in c.execute('SELECT r.id, r.name, r.builtin, r.view_all, r.manage, r.version '
                               'FROM roles r%s ORDER BY r.id LIMIT ? OFFSET ?' % where,
                               args + [size, offset]).fetchall():
                item = dict(r)
                for k in ('builtin', 'view_all', 'manage'):
                    item[k] = bool(item[k])
                item['users'] = self._role_users(c, r['id'])
                item['grants'] = c.execute(
                    "SELECT COUNT(*) AS n FROM grants WHERE owner_type = 'role' AND owner_id = ?",
                    (r['id'],)).fetchone()['n']
                items.append(item)
        return {'items': items, 'total': total, 'page': page, 'size': size}

    def role_get(self, role_id):
        with self._use() as c:
            row = self._role_row(c, role_id)
            out = dict(row)
            for k in ('builtin', 'view_all', 'manage'):
                out[k] = bool(out[k])
            out['users'] = self._role_users(c, role_id)
            out['grants'] = [_grant(g) for g in c.execute(
                "SELECT * FROM grants WHERE owner_type = 'role' AND owner_id = ? ORDER BY id",
                (role_id,))]
            out['groups'] = [dict(g) for g in c.execute(
                'SELECT g.id, g.name FROM group_roles gr JOIN "groups" g ON g.id = gr.group_id '
                'WHERE gr.role_id = ? ORDER BY g.name LIMIT 200', (role_id,))]
        return out

    def role_create(self, name, by, view_all=False, addr=''):
        name = self._convert(st._name, name, 'role name')
        with self._tx() as c:
            if c.execute('SELECT 1 FROM roles WHERE name = ?', (name,)).fetchone():
                raise conflict('duplicate', 'A role "%s" already exists.' % name)
            cur = c.execute('INSERT INTO roles(name, builtin, view_all, manage) '
                            'VALUES (?, 0, ?, 0)', (name, 1 if view_all else 0))
            self._audit(c, by, 'role.create', name, {'view_all': bool(view_all)}, addr)
            rid = cur.lastrowid
        return self.role_get(rid)

    def role_rename(self, role_id, name, by, version=None, addr=''):
        version = self._version(version)
        name = self._convert(st._name, name, 'role name')
        with self._tx() as c:
            row = self._custom_role(c, role_id)
            if c.execute('SELECT 1 FROM roles WHERE name = ? AND id <> ?',
                         (name, role_id)).fetchone():
                raise conflict('duplicate', 'A role "%s" already exists.' % name)
            self._touch(c, 'roles', role_id, version, 'role')
            c.execute('UPDATE roles SET name = ? WHERE id = ?', (name, role_id))
            self._audit(c, by, 'role.rename', row['name'], {'to': name}, addr)
        return self.role_get(role_id)

    def role_set_view_all(self, role_id, view_all, by, version=None, addr=''):
        version = self._version(version)
        with self._tx() as c:
            row = self._custom_role(c, role_id)
            self._touch(c, 'roles', role_id, version, 'role')
            c.execute('UPDATE roles SET view_all = ? WHERE id = ?',
                      (1 if view_all else 0, role_id))
            self._audit(c, by, 'role.update', row['name'],
                        {'view_all': {'before': bool(row['view_all']), 'after': bool(view_all)}},
                        addr)
        return self.role_get(role_id)

    def role_delete(self, role_id, by, confirm=False, addr=''):
        with self._tx() as c:
            row = self._custom_role(c, role_id)
            n = self._role_users(c, role_id)
            if n and not confirm:
                raise conflict('confirm', 'The role "%s" is held by %d user%s, who would lose '
                                          'what only this role gives them. Confirm to delete it.'
                               % (row['name'], n, '' if n == 1 else 's'),
                               affected=n, confirm=True)
            c.execute("DELETE FROM grants WHERE owner_type = 'role' AND owner_id = ?", (role_id,))
            c.execute('DELETE FROM roles WHERE id = ?', (role_id,))
            self._audit(c, by, 'role.delete', row['name'], {'users': n}, addr)
        return {'ok': True, 'affected': n}

    # ================================================================== grants
    @staticmethod
    def _grant_owner(c, owner_type, owner_id):
        if owner_type == 'user':
            row = c.execute('SELECT login AS label FROM users WHERE id = ?',
                            (owner_id,)).fetchone()
        elif owner_type == 'role':
            row = c.execute('SELECT name AS label, builtin FROM roles WHERE id = ?',
                            (owner_id,)).fetchone()
            if row is not None and row['builtin']:
                raise conflict('builtin', 'The built-in role %s cannot be given grants.'
                               % row['label'])
        else:
            raise AdminError(400, 'A grant belongs to a user or a role')
        if row is None:
            raise AdminError(404, 'No such %s' % owner_type)
        return '%s:%s' % (owner_type, row['label'])

    def _check_grant(self, server, exchange, segment, dealer):
        for v in (server, exchange, segment, dealer):
            if not isinstance(v, str):
                raise AdminError(400, 'A grant needs a server, exchange, segment and dealer '
                                      '(use * for any)')
        self._convert(st.check_grant, server, exchange, segment, dealer)

    @staticmethod
    def _grant_exists(c, owner_type, owner_id, server, exchange, segment, dealer, skip=None):
        row = c.execute('SELECT id FROM grants WHERE owner_type = ? AND owner_id = ? AND server = ? '
                        'AND exchange = ? AND segment = ? AND dealer = ?',
                        (owner_type, owner_id, server, exchange, segment, dealer)).fetchone()
        return row is not None and row['id'] != skip

    def grant_add(self, owner_type, owner_id, server, exchange, segment, dealer, by, addr=''):
        self._check_grant(server, exchange, segment, dealer)
        with self._tx() as c:
            owner = self._grant_owner(c, owner_type, owner_id)
            if self._grant_exists(c, owner_type, owner_id, server, exchange, segment, dealer):
                raise conflict('duplicate', 'That grant already exists.')
            cur = c.execute('INSERT INTO grants(owner_type, owner_id, server, exchange, segment, '
                            'dealer) VALUES (?, ?, ?, ?, ?, ?)',
                            (owner_type, owner_id, server, exchange, segment, dealer))
            self._audit(c, by, 'grant.add', owner,
                        {'server': server, 'exchange': exchange, 'segment': segment,
                         'dealer': dealer}, addr)
            gid = cur.lastrowid
        return self.grant_get(gid)

    def grant_get(self, grant_id):
        with self._use() as c:
            row = c.execute('SELECT * FROM grants WHERE id = ?', (grant_id,)).fetchone()
        if row is None:
            raise AdminError(404, 'No such grant')
        out = _grant(row)
        out['owner_type'], out['owner_id'] = row['owner_type'], row['owner_id']
        return out

    def grant_update(self, grant_id, server, exchange, segment, dealer, by, addr=''):
        self._check_grant(server, exchange, segment, dealer)
        with self._tx() as c:
            old = c.execute('SELECT * FROM grants WHERE id = ?', (grant_id,)).fetchone()
            if old is None:
                raise AdminError(404, 'No such grant')
            owner = self._grant_owner(c, old['owner_type'], old['owner_id'])
            if self._grant_exists(c, old['owner_type'], old['owner_id'], server, exchange,
                                  segment, dealer, skip=grant_id):
                raise conflict('duplicate', 'That grant already exists.')
            c.execute('UPDATE grants SET server = ?, exchange = ?, segment = ?, dealer = ? '
                      'WHERE id = ?', (server, exchange, segment, dealer, grant_id))
            self._audit(c, by, 'grant.update', owner,
                        {'before': {'server': old['server'], 'exchange': old['exchange'],
                                    'segment': old['segment'], 'dealer': old['dealer']},
                         'after': {'server': server, 'exchange': exchange, 'segment': segment,
                                   'dealer': dealer}}, addr)
        return self.grant_get(grant_id)

    def grant_remove(self, grant_id, by, addr=''):
        with self._tx() as c:
            old = c.execute('SELECT * FROM grants WHERE id = ?', (grant_id,)).fetchone()
            if old is None:
                raise AdminError(404, 'No such grant')
            if old['owner_type'] == 'user':
                row = c.execute('SELECT login AS label FROM users WHERE id = ?',
                                (old['owner_id'],)).fetchone()
            else:
                row = c.execute('SELECT name AS label FROM roles WHERE id = ?',
                                (old['owner_id'],)).fetchone()
            c.execute('DELETE FROM grants WHERE id = ?', (grant_id,))
            self._audit(c, by, 'grant.remove',
                        '%s:%s' % (old['owner_type'], row['label'] if row else old['owner_id']),
                        {'server': old['server'], 'exchange': old['exchange'],
                         'segment': old['segment'], 'dealer': old['dealer']}, addr)
        return {'ok': True}

    # ================================================================== effective access
    def access(self, user_id):
        """What one user can see and why."""
        with self._use() as c:
            user = c.execute('SELECT id, login, name, email, enabled FROM users WHERE id = ?',
                             (user_id,)).fetchone()
            if user is None:
                raise AdminError(404, 'No such user')
            roles = {}
            for r in c.execute('SELECT r.id, r.name, r.view_all, r.manage FROM user_roles ur '
                               'JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? '
                               'ORDER BY r.id', (user_id,)):
                e = roles.setdefault(r['id'], {'id': r['id'], 'name': r['name'],
                                               'view_all': bool(r['view_all']),
                                               'manage': bool(r['manage']), 'via': []})
                e['via'].append({'type': 'direct'})
            for r in c.execute('SELECT r.id, r.name, r.view_all, r.manage, g.id AS gid, '
                               'g.name AS gname FROM user_groups ug '
                               'JOIN "groups" g ON g.id = ug.group_id '
                               'JOIN group_roles gr ON gr.group_id = g.id '
                               'JOIN roles r ON r.id = gr.role_id WHERE ug.user_id = ? '
                               'ORDER BY r.id, g.name', (user_id,)):
                e = roles.setdefault(r['id'], {'id': r['id'], 'name': r['name'],
                                               'view_all': bool(r['view_all']),
                                               'manage': bool(r['manage']), 'via': []})
                e['via'].append({'type': 'group', 'group': r['gname'], 'group_id': r['gid']})
            grants = []
            for g in c.execute("SELECT * FROM grants WHERE owner_type = 'user' AND owner_id = ? "
                               "ORDER BY id", (user_id,)):
                item = _grant(g)
                item['owner'] = {'type': 'user', 'name': user['login']}
                grants.append(item)
            role_ids = sorted(roles)
            if role_ids:
                names = {rid: roles[rid]['name'] for rid in role_ids}
                for g in c.execute("SELECT * FROM grants WHERE owner_type = 'role' AND "
                                   "owner_id IN (%s) ORDER BY owner_id, id" % _marks(role_ids),
                                   role_ids):
                    item = _grant(g)
                    item['owner'] = {'type': 'role', 'name': names[g['owner_id']]}
                    grants.append(item)
        role_list = [roles[rid] for rid in role_ids]
        manage = any(r['manage'] for r in role_list)
        view_all = manage or any(r['view_all'] for r in role_list)
        scope = sc.Scope([(g['server'], g['exchange'], g['segment'], g['dealer'])
                          for g in grants], all=view_all)
        out = {'id': user['id'], 'login': user['login'], 'name': user['name'],
               'enabled': bool(user['enabled']), 'roles': role_list, 'grants': grants,
               'view_all': view_all, 'manage': manage,
               'waiting': not view_all and not grants}
        out.update(self._reach(scope))
        return out

    def _reach(self, scope):
        cat = self._catalog_full()
        servers, exchanges, segments, reports = set(), set(), set(), 0
        for ip, ex, sg in cat['keys']:
            if scope.allows(ip, ex, sg):
                servers.add(ip)
                if ex:
                    exchanges.add(ex)
                if sg:
                    segments.add(sg)
                reports += 1
        otr_servers = sorted((ip for ip in cat['otr_servers'] if scope.allows_server(ip)),
                             key=data._natural)
        return {'reach': {'servers': sorted(servers, key=data._natural),
                          'exchanges': sorted(exchanges), 'segments': sorted(segments),
                          'reports': reports, 'otr_servers': otr_servers,
                          'note': cat['error']}}

    # ================================================================== catalog
    def _catalog_full(self):
        now = self._clock()
        with self._catalog_lock:
            if self._catalog and now - self._catalog[0] < CATALOG_SECONDS:
                return self._catalog[1]
        cat = self._scan()
        with self._catalog_lock:
            self._catalog = (now, cat)
        return cat

    def _scan(self):
        cfg = self.cfg
        out = {'keys': [], 'otr_servers': [], 'servers': [], 'exchanges': [], 'segments': [],
               'error': None}
        if cfg is None:
            out['error'] = 'No data directory is configured'
            return out
        found, otr_found = {}, {}
        try:
            found = data.scan(cfg)
        except OSError as e:
            out['error'] = 'Cannot read %s: %s' % (cfg.get('dir'), e.strerror or e)
        try:
            otr_found = otr.scan_otr(cfg)
        except (OSError, KeyError):
            pass
        names = {s['ip']: s['name'] for s in cfg.get('servers', [])}
        ips = [s['ip'] for s in cfg.get('servers', [])]
        seen = {k[0] for k in found} | set(otr_found)
        ips += sorted((ip for ip in seen if ip not in names), key=data._natural)
        ex, sg = data.catalog(cfg, found)
        if cfg.get('_otr_prefixes') is not None:
            try:
                oex, osg = otr.catalog_otr(cfg)
            except (KeyError, AttributeError):
                oex, osg = [], []
            have = {c['code'] for c in ex}
            ex = ex + [c for c in oex if c['code'] not in have]
            have = {c['code'] for c in sg}
            sg = sg + [c for c in osg if c['code'] not in have]
        out.update({'keys': sorted(found), 'otr_servers': sorted(otr_found),
                    'servers': [{'ip': ip, 'name': names.get(ip, ip)} for ip in ips],
                    'exchanges': ex, 'segments': sg})
        return out

    def catalog(self):
        cat = self._catalog_full()
        return {'servers': cat['servers'], 'exchanges': cat['exchanges'],
                'segments': cat['segments'], 'error': cat['error']}

    # ================================================================== waiting for access
    def pending_list(self, q='', page=1, size=50):
        page, size, offset = paging(page, size)
        where, args = ['(%s)' % _WAITING], []
        self._search_where(q, where, args)
        return self._user_page(where, args, page, size, 'u.created DESC, u.id DESC', offset)

    def pending_assign(self, user_ids, by, role_id=None, group_id=None, addr=''):
        user_ids = need_ids(user_ids)
        if (role_id is None) == (group_id is None):
            raise AdminError(400, 'Choose either a role or a group to give')
        self._not_self(by, user_ids, 'roles and groups')
        with self._tx() as c:
            if role_id is not None:
                other = self._role_row(c, need_int(role_id, 'role'))
                if other['manage']:
                    raise conflict('safeguard', 'The SuperAdmin role is given to one person at '
                                                'a time, from the person\'s own page.')
                table, col, event = 'user_roles', 'role_id', 'user.role_add'
                oid = other['id']
            else:
                other = self._group_row(c, need_int(group_id, 'group'))
                table, col, event = 'user_groups', 'group_id', 'group.member_add'
                oid = other['id']
            n = 0
            for uid in user_ids:
                user = c.execute('SELECT login FROM users WHERE id = ?', (uid,)).fetchone()
                if user is None:
                    raise AdminError(404, 'No such user')
                cur = c.execute('INSERT OR IGNORE INTO %s(user_id, %s) VALUES (?, ?)'
                                % (table, col), (uid, oid))
                if cur.rowcount > 0:
                    n += 1
                    self._audit(c, by, event, user['login'], other['name'], addr)
        return {'assigned': n}

    def pending_remove(self, user_ids, by, addr=''):
        user_ids = need_ids(user_ids)
        self._not_self(by, user_ids, 'own account')
        with self._tx() as c:
            for uid in user_ids:
                user = c.execute('SELECT u.login FROM users u WHERE u.id = ? AND %s' % _WAITING,
                                 (uid,)).fetchone()
                if user is None:
                    raise conflict('not_waiting', 'Only people who are waiting for access can '
                                                  'be removed here.')
                c.execute('DELETE FROM users WHERE id = ?', (uid,))
                self._audit(c, by, 'user.delete', user['login'], 'waiting for access', addr)
        return {'removed': len(user_ids)}

    # ================================================================== bulk import
    def _purge_imports(self, now):
        for token in [t for t, e in self._imports.items() if e['expires'] <= now]:
            del self._imports[token]

    def import_preview(self, text, by):
        if isinstance(text, bytes):
            if len(text) > IMPORT_MAX_BYTES:
                raise AdminError(400, 'The file is larger than the limit of 2 MB')
            try:
                text = text.decode('utf-8-sig')
            except UnicodeError:
                raise AdminError(400, 'The file must be UTF-8 text')
        elif not isinstance(text, str):
            raise AdminError(400, 'Send the file content as text')
        elif len(text.encode('utf-8')) > IMPORT_MAX_BYTES:
            raise AdminError(400, 'The file is larger than the limit of 2 MB')
        text = text.lstrip('\ufeff')
        reader = csv.reader(io.StringIO(text, newline=''))
        try:
            header = next(reader)
        except StopIteration:
            raise AdminError(400, 'The file is empty')
        except csv.Error as e:
            raise AdminError(400, 'The file is not valid CSV: %s' % e)
        cols = [h.strip().lower() for h in header]
        if 'login' not in cols:
            raise AdminError(400, 'The first line must name the columns: login,name,roles,groups')
        idx = {name: cols.index(name) for name in ('login', 'name', 'roles', 'groups')
               if name in cols}
        rows = []
        try:
            for row in reader:
                if not any(cell.strip() for cell in row):
                    continue
                rows.append((reader.line_num, row))
                if len(rows) > IMPORT_MAX_LINES:
                    raise AdminError(400, 'The file has more than the limit of %d users'
                                     % IMPORT_MAX_LINES)
        except csv.Error as e:
            raise AdminError(400, 'The file is not valid CSV: %s' % e)

        problems = []

        def problem(line, login, reason):
            problems.append({'line': line, 'login': login, 'reason': reason})

        def cell(row, key):
            i = idx.get(key)
            return row[i].strip() if i is not None and i < len(row) else ''

        with self._use() as c:
            roles = {r['name']: r['id'] for r in c.execute('SELECT id, name FROM roles')}
            super_ids = {r['id'] for r in c.execute('SELECT id FROM roles WHERE manage = 1')}
            groups = {g['name']: g['id'] for g in c.execute('SELECT id, name FROM "groups"')}
            parsed, firsts = [], {}
            for line, row in rows:
                raw_login = cell(row, 'login')
                try:
                    login = st.norm_login(raw_login)
                except st.StoreError:
                    problem(line, raw_login[:80], 'not a valid sign-in name')
                    continue
                if login in firsts:
                    problem(line, login, 'appears twice (first on line %d)' % firsts[login])
                    continue
                firsts[login] = line
                name = cell(row, 'name')
                if len(name) > 200 or any(ord(ch) < 32 for ch in name):
                    problem(line, login, 'the name is too long or has control characters')
                    continue
                bad = False
                role_ids, group_ids = [], []
                for part in (p.strip() for p in cell(row, 'roles').split(';')):
                    if not part:
                        continue
                    if part not in roles:
                        problem(line, login, 'unknown role "%s"' % part[:60])
                        bad = True
                    elif roles[part] in super_ids:
                        problem(line, login, 'the SuperAdmin role cannot be imported')
                        bad = True
                    elif roles[part] not in role_ids:
                        role_ids.append(roles[part])
                for part in (p.strip() for p in cell(row, 'groups').split(';')):
                    if not part:
                        continue
                    if part not in groups:
                        problem(line, login, 'unknown group "%s"' % part[:60])
                        bad = True
                    elif groups[part] not in group_ids:
                        group_ids.append(groups[part])
                if not bad:
                    parsed.append({'line': line, 'login': login, 'name': name,
                                   'roles': role_ids, 'groups': group_ids})
            # what exists already, to tell create / change / skip
            logins = [p['login'] for p in parsed]
            existing = {}
            for chunk in _chunks(logins):
                for r in c.execute('SELECT id, login, name FROM users WHERE login IN (%s)'
                                   % _marks(chunk), chunk):
                    existing[r['login']] = {'id': r['id'], 'name': r['name'],
                                            'roles': set(), 'groups': set()}
            ids = {e['id']: e for e in existing.values()}
            for chunk in _chunks(sorted(ids)):
                for r in c.execute('SELECT user_id, role_id FROM user_roles WHERE user_id IN (%s)'
                                   % _marks(chunk), chunk):
                    ids[r['user_id']]['roles'].add(r['role_id'])
                for r in c.execute('SELECT user_id, group_id FROM user_groups '
                                   'WHERE user_id IN (%s)' % _marks(chunk), chunk):
                    ids[r['user_id']]['groups'].add(r['group_id'])
        plan, counts = [], {'create': 0, 'change': 0, 'skip': 0}
        for p in parsed:
            e = existing.get(p['login'])
            if e is None:
                action = 'create'
            else:
                if by.user_id is not None and e['id'] == by.user_id and (p['roles'] or p['groups']):
                    problem(p['line'], p['login'], 'you cannot change your own roles or groups')
                    continue
                new_name = bool(p['name']) and p['name'] != e['name']
                new_links = (set(p['roles']) - e['roles']) or (set(p['groups']) - e['groups'])
                action = 'change' if new_name or new_links else 'skip'
            counts[action] += 1
            plan.append(dict(p, action=action, user_id=e['id'] if e else None))
        problems.sort(key=lambda x: x['line'])
        now = self._clock()
        token = secrets.token_urlsafe(24)
        with self._imports_lock:
            self._purge_imports(now)
            while len(self._imports) >= IMPORT_TOKENS_MAX:
                del self._imports[min(self._imports, key=lambda t: self._imports[t]['expires'])]
            self._imports[token] = {'plan': plan, 'actor': by.name, 'problems': problems,
                                    'expires': now + IMPORT_TTL}
        out = dict(counts)
        out.update({'token': token, 'lines': len(rows), 'ok': not problems,
                    'problem_count': len(problems),
                    'problems': problems[:IMPORT_PROBLEMS_SHOWN], 'expires_in': IMPORT_TTL})
        return out

    def import_commit(self, token, by, addr=''):
        now = self._clock()
        with self._imports_lock:
            self._purge_imports(now)
            entry = self._imports.get(token) if isinstance(token, str) else None
        if entry is None:
            raise conflict('expired', 'This preview has expired. Upload the file again.')
        if entry['actor'] != by.name:
            raise AdminError(403, 'This preview belongs to someone else')
        if entry['problems']:
            raise conflict('problems', 'Nothing was imported: %d line%s ha%s problems.'
                           % (len(entry['problems']), '' if len(entry['problems']) == 1 else 's',
                              's' if len(entry['problems']) == 1 else 've'),
                           problems=entry['problems'][:IMPORT_PROBLEMS_SHOWN])
        created = changed = 0
        try:
            with self._tx() as c:
                for p in entry['plan']:
                    if p['action'] == 'skip':
                        continue
                    if p['action'] == 'create':
                        cur = c.execute(
                            'INSERT INTO users(login, name, email, password_hash, enabled, '
                            'created) VALUES (?, ?, ?, NULL, 1, ?)',
                            (p['login'], p['name'], '', st.now_iso()))
                        uid = cur.lastrowid
                        created += 1
                        event = 'user.create'
                    else:
                        uid = p['user_id']
                        if p['name']:
                            c.execute('UPDATE users SET name = ?, version = version + 1 '
                                      'WHERE id = ?', (p['name'], uid))
                        changed += 1
                        event = 'user.import_update'
                    for rid in p['roles']:
                        c.execute('INSERT OR IGNORE INTO user_roles(user_id, role_id) '
                                  'VALUES (?, ?)', (uid, rid))
                    for gid in p['groups']:
                        c.execute('INSERT OR IGNORE INTO user_groups(user_id, group_id) '
                                  'VALUES (?, ?)', (uid, gid))
                    self._audit(c, by, event, p['login'],
                                {'import': True, 'name': p['name'], 'roles': p['roles'],
                                 'groups': p['groups']}, addr)
                self._audit(c, by, 'import.commit', '',
                            {'created': created, 'changed': changed,
                             'skipped': sum(1 for p in entry['plan'] if p['action'] == 'skip')},
                            addr)
        except sqlite3.IntegrityError:
            raise conflict('changed', 'Something changed since the preview (a user, role or '
                                      'group was added or removed). Nothing was imported; '
                                      'upload the file again.')
        with self._imports_lock:
            self._imports.pop(token, None)
        return {'created': created, 'changed': changed,
                'skipped': sum(1 for p in entry['plan'] if p['action'] == 'skip')}

    # ================================================================== audit viewer
    @staticmethod
    def _audit_where(since, until, user, event, outcome, before_id):
        where, args = [], []
        if since:
            if ISO_DAY_RE.match(since):
                since += 'T00:00:00Z'
            elif not ISO_TIME_RE.match(since):
                raise AdminError(400, 'since must look like 2026-10-21 or 2026-10-21T09:30:00Z')
            where.append('a.ts >= ?')
            args.append(since if since.endswith('Z') else since + 'Z')
        if until:
            if ISO_DAY_RE.match(until):
                until += 'T23:59:59Z'
            elif not ISO_TIME_RE.match(until):
                raise AdminError(400, 'until must look like 2026-10-21 or 2026-10-21T09:30:00Z')
            where.append('a.ts <= ?')
            args.append(until if until.endswith('Z') else until + 'Z')
        if user:
            u = str(user).strip().lower()
            where.append("(a.actor = ? OR a.subject = ? OR a.subject = ?)")
            args.extend([u, u, 'user:' + u])
        if event:
            event = str(event)
            if event.endswith('*'):
                where.append("a.event LIKE ? ESCAPE '\\'")
                args.append(like_escape(event[:-1]) + '%')
            else:
                where.append('a.event = ?')
                args.append(event)
        if outcome == 'denied':
            where.append('a.event IN (%s)' % _marks(DENIED_EVENTS))
            args.extend(DENIED_EVENTS)
        elif outcome == 'ok':
            where.append('a.event NOT IN (%s)' % _marks(DENIED_EVENTS))
            args.extend(DENIED_EVENTS)
        elif outcome:
            raise AdminError(400, 'outcome must be ok or denied')
        if before_id not in (None, ''):
            where.append('a.id < ?')
            args.append(need_int(before_id, 'before_id'))
        return where, args

    @staticmethod
    def _audit_item(row):
        item = dict(row)
        item['outcome'] = 'denied' if row['event'] in DENIED_EVENTS else 'ok'
        return item

    def audit_query(self, since=None, until=None, user=None, event=None, outcome=None,
                    before_id=None, size=100):
        try:
            size = max(1, min(int(size), AUDIT_PAGE_MAX))
        except (TypeError, ValueError):
            size = 100
        where, args = self._audit_where(since, until, user, event, outcome, before_id)
        sql = 'SELECT a.id, a.ts, a.actor, a.event, a.subject, a.detail, a.addr FROM audit a'
        if where:
            sql += ' WHERE ' + ' AND '.join(where)
        sql += ' ORDER BY a.id DESC LIMIT ?'
        with self._use() as c:
            rows = c.execute(sql, args + [size]).fetchall()
        items = [self._audit_item(r) for r in rows]
        return {'items': items, 'size': size,
                'next': items[-1]['id'] if len(items) == size else None}

    def audit_csv(self, since=None, until=None, user=None, event=None, outcome=None):
        where, args = self._audit_where(since, until, user, event, outcome, None)
        sql = 'SELECT a.id, a.ts, a.actor, a.event, a.subject, a.detail, a.addr FROM audit a'
        if where:
            sql += ' WHERE ' + ' AND '.join(where)
        sql += ' ORDER BY a.id DESC LIMIT ?'
        out = io.StringIO()
        w = csv.writer(out, lineterminator='\r\n')
        w.writerow(['id', 'time', 'user', 'event', 'outcome', 'subject', 'detail', 'address'])
        with self._use() as c:
            for r in c.execute(sql, args + [AUDIT_EXPORT_MAX]):
                w.writerow([safe_cell(v) for v in (
                    r['id'], r['ts'], r['actor'], r['event'],
                    'denied' if r['event'] in DENIED_EVENTS else 'ok',
                    r['subject'], r['detail'], r['addr'])])
        return out.getvalue()