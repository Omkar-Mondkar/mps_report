"""
auth/store.py - SQLite store for users, roles, groups, grants and the audit log.

  * one file, standard library only, WAL mode, ordered migrations (`schema_version`)
  * every write bumps `acl_version` in the same transaction; a request-time check reads it
    at most once a second, which is how a change made through any process reaches the
    in-process cache of compiled users within a second
  * `compiled(user_id)` -> effective roles, `view_all`, `manage` and grants of one user,
    held in a cache and rebuilt only after `acl_version` changes
  * the audit table has no update or delete function (and triggers refuse both)

SQL is kept to what SQLite 3.7+ understands (no RETURNING, no upsert).
"""
import collections
import contextlib
import datetime
import json
import re
import sqlite3
import threading
import time

from mps_data import CODE_RE, IP_RE

from .scope import Scope

BUILTIN_ROLES = (('SuperAdmin', 1, 1), ('Admin', 1, 0), ('User', 0, 0))   # name, view_all, manage
LOGIN_RE = re.compile(r'^[^\s\x00-\x1f\x7f]{1,254}$')
NAME_RE = re.compile(r'^[^\x00-\x1f\x7f]{1,64}$')
DEALER_RE = re.compile(r'^(?:\*|[A-Za-z0-9_.@-]{1,64}\*?)$')
ANY = '*'
RECHECK_SECONDS = 1.0
POOL_SIZE = 8
MAX_DETAIL = 2000


class StoreError(ValueError):
    """A rule of the store was broken (duplicate, built-in role, bad value ...)."""


_MIGRATIONS = [
    (1, [
        '''CREATE TABLE users (
             id INTEGER PRIMARY KEY,
             login TEXT NOT NULL UNIQUE,
             name TEXT NOT NULL DEFAULT '',
             email TEXT NOT NULL DEFAULT '',
             password_hash TEXT,
             enabled INTEGER NOT NULL DEFAULT 1,
             session_version INTEGER NOT NULL DEFAULT 0,
             created TEXT NOT NULL,
             last_login TEXT)''',
        '''CREATE TABLE identities (
             provider TEXT NOT NULL,
             subject TEXT NOT NULL,
             user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
             PRIMARY KEY (provider, subject))''',
        '''CREATE TABLE roles (
             id INTEGER PRIMARY KEY,
             name TEXT NOT NULL UNIQUE,
             builtin INTEGER NOT NULL DEFAULT 0,
             view_all INTEGER NOT NULL DEFAULT 0,
             manage INTEGER NOT NULL DEFAULT 0,
             CHECK (manage = 0 OR (builtin = 1 AND name = 'SuperAdmin')))''',
        '''CREATE TABLE "groups" (
             id INTEGER PRIMARY KEY,
             name TEXT NOT NULL UNIQUE)''',
        '''CREATE TABLE user_groups (
             user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
             group_id INTEGER NOT NULL REFERENCES "groups"(id) ON DELETE CASCADE,
             PRIMARY KEY (user_id, group_id))''',
        '''CREATE TABLE user_roles (
             user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
             role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
             PRIMARY KEY (user_id, role_id))''',
        '''CREATE TABLE group_roles (
             group_id INTEGER NOT NULL REFERENCES "groups"(id) ON DELETE CASCADE,
             role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
             PRIMARY KEY (group_id, role_id))''',
        '''CREATE TABLE grants (
             id INTEGER PRIMARY KEY,
             owner_type TEXT NOT NULL CHECK (owner_type IN ('user', 'role')),
             owner_id INTEGER NOT NULL,
             server TEXT NOT NULL,
             exchange TEXT NOT NULL,
             segment TEXT NOT NULL,
             dealer TEXT NOT NULL,
             UNIQUE (owner_type, owner_id, server, exchange, segment, dealer))''',
        '''CREATE TABLE audit (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             ts TEXT NOT NULL,
             actor TEXT NOT NULL DEFAULT '',
             event TEXT NOT NULL,
             subject TEXT NOT NULL DEFAULT '',
             detail TEXT NOT NULL DEFAULT '',
             addr TEXT NOT NULL DEFAULT '')''',
        '''CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit
             BEGIN SELECT RAISE(ABORT, 'audit entries cannot be changed'); END''',
        '''CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit
             BEGIN SELECT RAISE(ABORT, 'audit entries cannot be deleted'); END''',
        'CREATE INDEX grants_owner ON grants(owner_type, owner_id)',
        'CREATE INDEX user_groups_group ON user_groups(group_id)',
        'CREATE INDEX audit_ts ON audit(ts)',
        "INSERT INTO meta(key, value) VALUES ('acl_version', '1')",
    ] + ["INSERT INTO roles(name, builtin, view_all, manage) VALUES ('%s', 1, %d, %d)" % r
         for r in BUILTIN_ROLES]),
    (2, [      # add-access-admin-ui: edit-conflict versions and indexes for big lists
        'ALTER TABLE users ADD COLUMN version INTEGER NOT NULL DEFAULT 1',
        'ALTER TABLE "groups" ADD COLUMN version INTEGER NOT NULL DEFAULT 1',
        'ALTER TABLE roles ADD COLUMN version INTEGER NOT NULL DEFAULT 1',
        'CREATE INDEX users_enabled ON users(enabled)',
        'CREATE INDEX user_roles_role ON user_roles(role_id)',
        'CREATE INDEX group_roles_role ON group_roles(role_id)',
        'CREATE INDEX audit_actor ON audit(actor)',
        'CREATE INDEX audit_subject ON audit(subject)',
    ]),
]
SCHEMA_VERSION = _MIGRATIONS[-1][0]


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def norm_login(login):
    login = (login or '').strip().lower() if isinstance(login, str) else ''
    if not LOGIN_RE.match(login):
        raise StoreError('user id must be 1-254 characters without spaces')
    return login


def _name(value, what):
    value = value.strip() if isinstance(value, str) else ''
    if not NAME_RE.match(value):
        raise StoreError('%s must be 1-64 characters' % what)
    return value


def check_grant(server, exchange, segment, dealer):
    if server != ANY and not IP_RE.match(server or ''):
        raise StoreError('invalid server in grant')
    for value, what in ((exchange, 'exchange'), (segment, 'segment')):
        if value != ANY and not CODE_RE.match(value or ''):
            raise StoreError('invalid %s in grant (capital letters or "*")' % what)
    if not DEALER_RE.match(dealer or ''):
        raise StoreError('invalid dealer pattern: use "*" (all dealers), one exact id such as '
                         'DESK1, or a prefix with a single "*" at the end such as DESK1*')


class Store:
    def __init__(self, path, clock=time.monotonic):
        self.path = path
        self._clock = clock
        self._pool = collections.deque()
        self._pool_lock = threading.Lock()
        self._lock = threading.Lock()
        self._cache = {}
        self._gen = 0
        self.stats = {'compiles': 0, 'version_reads': 0}
        try:
            self._migrate()
            self._version = self._read_version()
        except BaseException:
            self.close()
            raise
        self._checked = self._clock()

    # ------------------------------------------------------------------ connections
    def _connect(self):
        c = sqlite3.connect(self.path, timeout=5, isolation_level=None,
                            check_same_thread=False)
        c.row_factory = sqlite3.Row
        c.execute('PRAGMA busy_timeout = 5000')
        c.execute('PRAGMA foreign_keys = ON')
        return c

    @contextlib.contextmanager
    def _use(self):
        with self._pool_lock:
            c = self._pool.pop() if self._pool else None
        if c is None:
            c = self._connect()
        try:
            yield c
        finally:
            if c.in_transaction:
                c.execute('ROLLBACK')
            with self._pool_lock:
                if len(self._pool) < POOL_SIZE:
                    self._pool.append(c)
                    c = None
            if c is not None:
                c.close()

    def close(self):
        with self._pool_lock:
            while self._pool:
                self._pool.pop().close()

    @contextlib.contextmanager
    def _tx(self, bump=True):
        """One write transaction; bumps acl_version unless `bump` is false."""
        with self._use() as c:
            c.execute('BEGIN IMMEDIATE')
            try:
                yield c
                if bump:
                    c.execute("UPDATE meta SET value = CAST(value AS INTEGER) + 1 "
                              "WHERE key = 'acl_version'")
                c.execute('COMMIT')
            except BaseException:
                if c.in_transaction:
                    c.execute('ROLLBACK')
                raise
        if bump:
            self._invalidate()

    # ------------------------------------------------------------------ migrations
    def _migrate(self):
        with self._use() as c:
            c.execute('PRAGMA journal_mode = WAL')
            c.execute('BEGIN IMMEDIATE')
            try:
                c.execute('CREATE TABLE IF NOT EXISTS meta '
                          '(key TEXT PRIMARY KEY, value TEXT NOT NULL)')
                row = c.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()
                have = int(row['value']) if row else 0
                if have > SCHEMA_VERSION:
                    raise StoreError('%s was written by a newer version (schema %d, this '
                                     'program understands %d)' % (self.path, have, SCHEMA_VERSION))
                for version, statements in _MIGRATIONS:
                    if version > have:
                        for sql in statements:
                            c.execute(sql)
                        c.execute("DELETE FROM meta WHERE key = 'schema_version'")
                        c.execute("INSERT INTO meta(key, value) VALUES ('schema_version', ?)",
                                  (str(version),))
                c.execute('COMMIT')
            except BaseException:
                if c.in_transaction:
                    c.execute('ROLLBACK')
                raise

    # ------------------------------------------------------------------ acl version / cache
    def _read_version(self):
        self.stats['version_reads'] += 1
        with self._use() as c:
            row = c.execute("SELECT value FROM meta WHERE key = 'acl_version'").fetchone()
        return int(row['value'])

    def acl_version(self):
        return self._read_version()

    def _invalidate(self):
        v = self._read_version()
        with self._lock:
            self._version = v
            self._cache.clear()
            self._gen += 1
            self._checked = self._clock()

    def _refresh(self):
        now = self._clock()
        if now - self._checked < RECHECK_SECONDS:
            return
        with self._lock:
            if now - self._checked < RECHECK_SECONDS:
                return
            self._checked = now
        v = self._read_version()
        with self._lock:
            if v != self._version:
                self._version = v
                self._cache.clear()
                self._gen += 1

    def compiled(self, user_id):
        """-> the effective access of one user (shared, read-only) or None if unknown."""
        self._refresh()
        with self._lock:
            if user_id in self._cache:
                return self._cache[user_id]
            gen = self._gen
        u = self._compile(user_id)
        with self._lock:
            if gen == self._gen:
                self._cache[user_id] = u
        return u

    def _compile(self, user_id):
        self.stats['compiles'] += 1
        with self._use() as c:
            row = c.execute('SELECT id, login, name, email, enabled, session_version, '
                            '(password_hash IS NOT NULL) AS has_password '
                            'FROM users WHERE id = ?', (user_id,)).fetchone()
            if row is None:
                return None
            roles = c.execute(
                'SELECT id, name, view_all, manage FROM roles WHERE id IN ('
                '  SELECT role_id FROM user_roles WHERE user_id = ?'
                '  UNION SELECT gr.role_id FROM group_roles gr'
                '        JOIN user_groups ug ON ug.group_id = gr.group_id WHERE ug.user_id = ?)'
                ' ORDER BY id', (user_id, user_id)).fetchall()
            role_ids = [r['id'] for r in roles]
            marks = ','.join('?' * len(role_ids))
            sql = ("SELECT DISTINCT server, exchange, segment, dealer FROM grants "
                   "WHERE (owner_type = 'user' AND owner_id = ?)")
            args = [user_id]
            if role_ids:
                sql += " OR (owner_type = 'role' AND owner_id IN (%s))" % marks
                args += role_ids
            grants = [(g['server'], g['exchange'], g['segment'], g['dealer'])
                      for g in c.execute(sql, args)]
        is_super = any(r['manage'] or r['name'] == 'SuperAdmin' for r in roles)
        view_all = is_super or any(r['view_all'] for r in roles)
        is_admin = view_all and not is_super and any(r['name'] == 'Admin' for r in roles)
        return {
            'id': row['id'], 'login': row['login'], 'name': row['name'],
            'email': row['email'], 'enabled': bool(row['enabled']),
            'session_version': row['session_version'], 'has_password': bool(row['has_password']),
            'roles': [r['name'] for r in roles], 'super': is_super, 'admin': is_admin,
            'view_all': view_all, 'manage': is_super, 'grants': grants,
            'pending': not view_all and not grants,
            'scope': Scope(grants, all=view_all),
        }

    # ------------------------------------------------------------------ audit
    def _audit(self, c, actor, event, subject='', detail=None, addr=''):
        if detail is None:
            text = ''
        elif isinstance(detail, str):
            text = detail
        else:
            text = json.dumps(detail, sort_keys=True, separators=(',', ':'), default=str)
        c.execute('INSERT INTO audit(ts, actor, event, subject, detail, addr) '
                  'VALUES (?, ?, ?, ?, ?, ?)',
                  (now_iso(), str(actor or '')[:254], event, str(subject or '')[:254],
                   text[:MAX_DETAIL], str(addr or '')[:64]))

    def audit(self, event, actor='', subject='', detail='', addr=''):
        """Append one entry.  Named fields only: callers pass what happened, never a
        password or cookie."""
        with self._tx(bump=False) as c:
            self._audit(c, actor, event, subject, detail, addr)

    def audit_list(self, limit=100, before_id=None, event=None, actor=None):
        sql, args, where = 'SELECT * FROM audit', [], []
        if before_id is not None:
            where.append('id < ?')
            args.append(before_id)
        if event:
            where.append('event = ?')
            args.append(event)
        if actor:
            where.append('actor = ?')
            args.append(actor)
        if where:
            sql += ' WHERE ' + ' AND '.join(where)
        sql += ' ORDER BY id DESC LIMIT ?'
        args.append(max(1, min(int(limit), 1000)))
        with self._use() as c:
            return [dict(r) for r in c.execute(sql, args)]

    # ------------------------------------------------------------------ users
    @staticmethod
    def _user(row):
        return {'id': row['id'], 'login': row['login'], 'name': row['name'],
                'email': row['email'], 'enabled': bool(row['enabled']),
                'session_version': row['session_version'],
                'has_password': bool(row['has_password']),
                'created': row['created'], 'last_login': row['last_login']}

    _USER_COLS = ('id, login, name, email, enabled, session_version, created, last_login, '
                  '(password_hash IS NOT NULL) AS has_password')

    def get_user(self, user_id):
        with self._use() as c:
            row = c.execute('SELECT %s FROM users WHERE id = ?' % self._USER_COLS,
                            (user_id,)).fetchone()
        return self._user(row) if row else None

    def get_user_by_login(self, login):
        try:
            login = norm_login(login)
        except StoreError:
            return None
        with self._use() as c:
            row = c.execute('SELECT %s FROM users WHERE login = ?' % self._USER_COLS,
                            (login,)).fetchone()
        return self._user(row) if row else None

    def get_login_record(self, login):
        """-> {id, enabled, password_hash} for the sign-in check only, or None."""
        try:
            login = norm_login(login)
        except StoreError:
            return None
        with self._use() as c:
            row = c.execute('SELECT id, enabled, password_hash FROM users WHERE login = ?',
                            (login,)).fetchone()
        return ({'id': row['id'], 'enabled': bool(row['enabled']),
                 'password_hash': row['password_hash']} if row else None)

    def create_user(self, login, name='', email='', password_hash=None, enabled=True,
                    actor='', addr=''):
        login = norm_login(login)
        with self._tx() as c:
            try:
                cur = c.execute(
                    'INSERT INTO users(login, name, email, password_hash, enabled, created) '
                    'VALUES (?, ?, ?, ?, ?, ?)',
                    (login, str(name or '')[:200], str(email or '')[:254], password_hash,
                     1 if enabled else 0, now_iso()))
            except sqlite3.IntegrityError:
                raise StoreError('user %s already exists' % login)
            self._audit(c, actor, 'user.create', login,
                        {'name': name or '', 'enabled': bool(enabled),
                         'password': bool(password_hash)}, addr)
            return cur.lastrowid

    def update_user(self, user_id, name=None, email=None, actor='', addr=''):
        with self._tx() as c:
            row = self._need_user(c, user_id)
            new_name = row['name'] if name is None else str(name)[:200]
            new_email = row['email'] if email is None else str(email)[:254]
            c.execute('UPDATE users SET name = ?, email = ? WHERE id = ?',
                      (new_name, new_email, user_id))
            self._audit(c, actor, 'user.update', row['login'],
                        {'before': {'name': row['name'], 'email': row['email']},
                         'after': {'name': new_name, 'email': new_email}}, addr)

    def set_password_hash(self, user_id, password_hash, actor='', addr=''):
        """Replace the stored hash and end every session of the user."""
        with self._tx() as c:
            row = self._need_user(c, user_id)
            c.execute('UPDATE users SET password_hash = ?, session_version = session_version + 1 '
                      'WHERE id = ?', (password_hash, user_id))
            self._audit(c, actor, 'user.password', row['login'], '', addr)

    def set_enabled(self, user_id, enabled, actor='', addr=''):
        with self._tx() as c:
            row = self._need_user(c, user_id)
            bump = 'session_version + 1' if not enabled else 'session_version'
            c.execute('UPDATE users SET enabled = ?, session_version = %s WHERE id = ?' % bump,
                      (1 if enabled else 0, user_id))
            self._audit(c, actor, 'user.enable' if enabled else 'user.disable',
                        row['login'], '', addr)

    def end_sessions(self, user_id, actor='', addr=''):
        with self._tx() as c:
            row = self._need_user(c, user_id)
            c.execute('UPDATE users SET session_version = session_version + 1 WHERE id = ?',
                      (user_id,))
            self._audit(c, actor, 'user.sessions_ended', row['login'], '', addr)

    def delete_user(self, user_id, actor='', addr=''):
        with self._tx() as c:
            row = self._need_user(c, user_id)
            c.execute("DELETE FROM grants WHERE owner_type = 'user' AND owner_id = ?", (user_id,))
            c.execute('DELETE FROM users WHERE id = ?', (user_id,))
            self._audit(c, actor, 'user.delete', row['login'], '', addr)

    def touch_login(self, user_id):
        with self._tx(bump=False) as c:
            c.execute('UPDATE users SET last_login = ? WHERE id = ?', (now_iso(), user_id))

    @staticmethod
    def _need_user(c, user_id):
        row = c.execute('SELECT id, login, name, email FROM users WHERE id = ?',
                        (user_id,)).fetchone()
        if row is None:
            raise StoreError('no such user')
        return row

    def ensure_superadmin(self, login, password_hash, actor='', addr=''):
        """Create the user (or reset the existing one's password and enable it) and make it
        a SuperAdmin.  Ends the user's existing sessions.  -> (user_id, created)."""
        login = norm_login(login)
        with self._tx() as c:
            row = c.execute('SELECT id FROM users WHERE login = ?', (login,)).fetchone()
            if row is None:
                uid = c.execute(
                    'INSERT INTO users(login, name, password_hash, enabled, created) '
                    'VALUES (?, ?, ?, 1, ?)', (login, login, password_hash, now_iso())).lastrowid
                created = True
            else:
                uid, created = row['id'], False
                c.execute('UPDATE users SET password_hash = ?, enabled = 1, '
                          'session_version = session_version + 1 WHERE id = ?',
                          (password_hash, uid))
            c.execute("INSERT OR IGNORE INTO user_roles(user_id, role_id) "
                      "SELECT ?, id FROM roles WHERE name = 'SuperAdmin'", (uid,))
            self._audit(c, actor, 'superadmin.create' if created else 'superadmin.reset',
                        login, '', addr)
        return uid, created

    _SUPER_SQL = (
        'SELECT COUNT(*) AS n FROM users u WHERE u.enabled = 1 AND ('
        ' EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id'
        '         WHERE ur.user_id = u.id AND r.manage = 1)'
        ' OR EXISTS (SELECT 1 FROM user_groups ug'
        '         JOIN group_roles gr ON gr.group_id = ug.group_id'
        '         JOIN roles r ON r.id = gr.role_id'
        '         WHERE ug.user_id = u.id AND r.manage = 1))')

    def count_superadmins(self, conn=None):
        """Enabled users holding the management right directly or through a group.  Pass
        `conn` to count inside an open transaction."""
        if conn is not None:
            return conn.execute(self._SUPER_SQL).fetchone()['n']
        with self._use() as c:
            return c.execute(self._SUPER_SQL).fetchone()['n']

    # ------------------------------------------------------------------ roles
    def list_roles(self):
        with self._use() as c:
            return [dict(r) for r in c.execute(
                'SELECT id, name, builtin, view_all, manage FROM roles ORDER BY id')]

    def get_role_by_name(self, name):
        with self._use() as c:
            row = c.execute('SELECT id, name, builtin, view_all, manage FROM roles '
                            'WHERE name = ?', (name,)).fetchone()
        return dict(row) if row else None

    def create_role(self, name, view_all=False, actor='', addr=''):
        name = _name(name, 'role name')
        with self._tx() as c:
            try:
                cur = c.execute('INSERT INTO roles(name, builtin, view_all, manage) '
                                'VALUES (?, 0, ?, 0)', (name, 1 if view_all else 0))
            except sqlite3.IntegrityError:
                raise StoreError('role %s already exists' % name)
            self._audit(c, actor, 'role.create', name, {'view_all': bool(view_all)}, addr)
            return cur.lastrowid

    @staticmethod
    def _custom_role(c, role_id):
        row = c.execute('SELECT id, name, builtin, view_all FROM roles WHERE id = ?',
                        (role_id,)).fetchone()
        if row is None:
            raise StoreError('no such role')
        if row['builtin']:
            raise StoreError('built-in role %s cannot be changed' % row['name'])
        return row

    def rename_role(self, role_id, new_name, actor='', addr=''):
        new_name = _name(new_name, 'role name')
        with self._tx() as c:
            row = self._custom_role(c, role_id)
            try:
                c.execute('UPDATE roles SET name = ? WHERE id = ?', (new_name, role_id))
            except sqlite3.IntegrityError:
                raise StoreError('role %s already exists' % new_name)
            self._audit(c, actor, 'role.rename', row['name'], {'to': new_name}, addr)

    def set_role_view_all(self, role_id, view_all, actor='', addr=''):
        with self._tx() as c:
            row = self._custom_role(c, role_id)
            c.execute('UPDATE roles SET view_all = ? WHERE id = ?',
                      (1 if view_all else 0, role_id))
            self._audit(c, actor, 'role.update', row['name'],
                        {'view_all': {'before': bool(row['view_all']), 'after': bool(view_all)}},
                        addr)

    def delete_role(self, role_id, actor='', addr=''):
        with self._tx() as c:
            row = self._custom_role(c, role_id)
            c.execute("DELETE FROM grants WHERE owner_type = 'role' AND owner_id = ?", (role_id,))
            c.execute('DELETE FROM roles WHERE id = ?', (role_id,))
            self._audit(c, actor, 'role.delete', row['name'], '', addr)

    # ------------------------------------------------------------------ groups
    def create_group(self, name, actor='', addr=''):
        name = _name(name, 'group name')
        with self._tx() as c:
            try:
                cur = c.execute('INSERT INTO "groups"(name) VALUES (?)', (name,))
            except sqlite3.IntegrityError:
                raise StoreError('group %s already exists' % name)
            self._audit(c, actor, 'group.create', name, '', addr)
            return cur.lastrowid

    def get_group_by_name(self, name):
        with self._use() as c:
            row = c.execute('SELECT id, name FROM "groups" WHERE name = ?', (name,)).fetchone()
        return dict(row) if row else None

    def rename_group(self, group_id, new_name, actor='', addr=''):
        new_name = _name(new_name, 'group name')
        with self._tx() as c:
            row = c.execute('SELECT name FROM "groups" WHERE id = ?', (group_id,)).fetchone()
            if row is None:
                raise StoreError('no such group')
            try:
                c.execute('UPDATE "groups" SET name = ? WHERE id = ?', (new_name, group_id))
            except sqlite3.IntegrityError:
                raise StoreError('group %s already exists' % new_name)
            self._audit(c, actor, 'group.rename', row['name'], {'to': new_name}, addr)

    def delete_group(self, group_id, actor='', addr=''):
        with self._tx() as c:
            row = c.execute('SELECT name FROM "groups" WHERE id = ?', (group_id,)).fetchone()
            if row is None:
                raise StoreError('no such group')
            c.execute('DELETE FROM "groups" WHERE id = ?', (group_id,))
            self._audit(c, actor, 'group.delete', row['name'], '', addr)

    # ------------------------------------------------------------------ memberships
    def _link(self, table, left, right, a, b, add, event, actor, addr, subject_sql):
        """Insert or delete one (a, b) row; audits only when something changed."""
        with self._tx() as c:
            try:
                if add:
                    cur = c.execute('INSERT OR IGNORE INTO %s(%s, %s) VALUES (?, ?)'
                                    % (table, left, right), (a, b))
                else:
                    cur = c.execute('DELETE FROM %s WHERE %s = ? AND %s = ?'
                                    % (table, left, right), (a, b))
            except sqlite3.IntegrityError:
                raise StoreError('no such %s or %s' % (left[:-3], right[:-3]))
            if add and cur.rowcount == 0:
                return False
            if cur.rowcount > 0:
                self._audit(c, actor, event, subject_sql(c, a), self._label(c, right, b), addr)
            return cur.rowcount > 0

    @staticmethod
    def _label(c, column, value):
        table = {'role_id': 'roles', 'group_id': '"groups"'}[column]
        row = c.execute('SELECT name FROM %s WHERE id = ?' % table, (value,)).fetchone()
        return row['name'] if row else str(value)

    @staticmethod
    def _user_label(c, uid):
        row = c.execute('SELECT login FROM users WHERE id = ?', (uid,)).fetchone()
        return row['login'] if row else str(uid)

    @staticmethod
    def _group_label(c, gid):
        row = c.execute('SELECT name FROM "groups" WHERE id = ?', (gid,)).fetchone()
        return row['name'] if row else str(gid)

    def add_user_role(self, user_id, role_id, actor='', addr=''):
        return self._link('user_roles', 'user_id', 'role_id', user_id, role_id, True,
                          'user.role_add', actor, addr, self._user_label)

    def remove_user_role(self, user_id, role_id, actor='', addr=''):
        return self._link('user_roles', 'user_id', 'role_id', user_id, role_id, False,
                          'user.role_remove', actor, addr, self._user_label)

    def add_user_group(self, user_id, group_id, actor='', addr=''):
        return self._link('user_groups', 'user_id', 'group_id', user_id, group_id, True,
                          'group.member_add', actor, addr, self._user_label)

    def remove_user_group(self, user_id, group_id, actor='', addr=''):
        return self._link('user_groups', 'user_id', 'group_id', user_id, group_id, False,
                          'group.member_remove', actor, addr, self._user_label)

    def add_group_role(self, group_id, role_id, actor='', addr=''):
        return self._link('group_roles', 'group_id', 'role_id', group_id, role_id, True,
                          'group.role_add', actor, addr, self._group_label)

    def remove_group_role(self, group_id, role_id, actor='', addr=''):
        return self._link('group_roles', 'group_id', 'role_id', group_id, role_id, False,
                          'group.role_remove', actor, addr, self._group_label)

    # ------------------------------------------------------------------ grants
    def add_grant(self, owner_type, owner_id, server=ANY, exchange=ANY, segment=ANY,
                  dealer=ANY, actor='', addr=''):
        if owner_type not in ('user', 'role'):
            raise StoreError('a grant belongs to a user or a role')
        check_grant(server, exchange, segment, dealer)
        with self._tx() as c:
            if owner_type == 'user':
                owner = c.execute('SELECT login AS label FROM users WHERE id = ?',
                                  (owner_id,)).fetchone()
            else:
                owner = c.execute('SELECT name AS label FROM roles WHERE id = ?',
                                  (owner_id,)).fetchone()
            if owner is None:
                raise StoreError('no such %s' % owner_type)
            cur = c.execute('INSERT OR IGNORE INTO grants(owner_type, owner_id, server, '
                            'exchange, segment, dealer) VALUES (?, ?, ?, ?, ?, ?)',
                            (owner_type, owner_id, server, exchange, segment, dealer))
            row = c.execute('SELECT id FROM grants WHERE owner_type = ? AND owner_id = ? '
                            'AND server = ? AND exchange = ? AND segment = ? AND dealer = ?',
                            (owner_type, owner_id, server, exchange, segment, dealer)).fetchone()
            if cur.rowcount > 0:
                self._audit(c, actor, 'grant.add', '%s:%s' % (owner_type, owner['label']),
                            {'server': server, 'exchange': exchange, 'segment': segment,
                             'dealer': dealer}, addr)
            return row['id']

    def remove_grant(self, grant_id, actor='', addr=''):
        with self._tx() as c:
            g = c.execute('SELECT * FROM grants WHERE id = ?', (grant_id,)).fetchone()
            if g is None:
                raise StoreError('no such grant')
            if g['owner_type'] == 'user':
                o = c.execute('SELECT login AS label FROM users WHERE id = ?',
                              (g['owner_id'],)).fetchone()
            else:
                o = c.execute('SELECT name AS label FROM roles WHERE id = ?',
                              (g['owner_id'],)).fetchone()
            c.execute('DELETE FROM grants WHERE id = ?', (grant_id,))
            self._audit(c, actor, 'grant.remove',
                        '%s:%s' % (g['owner_type'], o['label'] if o else g['owner_id']),
                        {'server': g['server'], 'exchange': g['exchange'],
                         'segment': g['segment'], 'dealer': g['dealer']}, addr)

    def list_grants(self, owner_type, owner_id):
        with self._use() as c:
            return [dict(r) for r in c.execute(
                'SELECT id, server, exchange, segment, dealer FROM grants '
                'WHERE owner_type = ? AND owner_id = ? ORDER BY id', (owner_type, owner_id))]