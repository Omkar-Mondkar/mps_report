"""
auth/adminapi.py - the /api/admin/* routes, kept out of the HTTP handler so they can be
tested without a socket.

    handle(admin, by, method, path, query, body, addr) -> (status, payload, extra)

`extra` is None for a JSON answer or {'csv': filename} when `payload` is CSV text.  The
caller has already established that the person is a signed-in SuperAdmin and, for POST,
that the forged-request rules passed; this module only maps routes to Admin operations
and AdminError to a status.  No stack trace or internal text leaves it.
"""
import re

from .admin import AdminError, need_int

PREFIX = '/api/admin/'
NOT_FOUND = (404, {'error': 'Not found'}, None)

_ID = r'(\d{1,12})'


def _q(q, name, default=''):
    return q.get(name, default)


# ---------------------------------------------------------------------------- GET
def _get_routes(a):
    return [
        (r'users', lambda q, m: a.user_list(
            _q(q, 'q'), _q(q, 'status'), _q(q, 'role') or None, _q(q, 'group') or None,
            _q(q, 'page', 1), _q(q, 'size', 50))),
        (r'users/%s' % _ID, lambda q, m: a.user_get(int(m[0]))),
        (r'users/%s/access' % _ID, lambda q, m: a.access(int(m[0]))),
        (r'groups', lambda q, m: a.group_list(_q(q, 'q'), _q(q, 'page', 1), _q(q, 'size', 50))),
        (r'groups/%s' % _ID, lambda q, m: a.group_get(int(m[0]))),
        (r'groups/%s/members' % _ID, lambda q, m: a.group_members(
            int(m[0]), _q(q, 'q'), _q(q, 'page', 1), _q(q, 'size', 50))),
        (r'roles', lambda q, m: a.role_list(_q(q, 'q'), _q(q, 'page', 1), _q(q, 'size', 50))),
        (r'roles/%s' % _ID, lambda q, m: a.role_get(int(m[0]))),
        (r'pending', lambda q, m: a.pending_list(
            _q(q, 'q'), _q(q, 'page', 1), _q(q, 'size', 50))),
        (r'audit', lambda q, m: a.audit_query(
            _q(q, 'since') or None, _q(q, 'until') or None, _q(q, 'user') or None,
            _q(q, 'event') or None, _q(q, 'outcome') or None, _q(q, 'before') or None,
            _q(q, 'size', 100))),
        (r'catalog', lambda q, m: a.catalog()),
    ]


# ---------------------------------------------------------------------------- POST
def _flag(body, key):
    return body.get(key) is True


def _need_bool(body, key):
    if not isinstance(body.get(key), bool):
        raise AdminError(400, '%s must be true or false' % key)
    return body[key]


def _post_routes(a, by, addr):
    def user_create(b, m):
        return a.user_create(b.get('login'), by, b.get('name', ''), b.get('email', ''),
                             b.get('password') or None, b.get('enabled', True) is not False, addr)

    def ids(b):
        return b.get('user_ids')

    return [
        (r'users', user_create),
        (r'users/%s/update' % _ID, lambda b, m: a.user_update(
            int(m[0]), by, b.get('name'), b.get('email'), b.get('version'), addr)),
        (r'users/%s/enabled' % _ID, lambda b, m: a.user_set_enabled(
            int(m[0]), _need_bool(b, 'enabled'), by, b.get('version'), addr)),
        (r'users/%s/password' % _ID, lambda b, m: a.user_set_password(
            int(m[0]), b.get('password'), by, addr)),
        (r'users/%s/sessions/end' % _ID, lambda b, m: a.user_end_sessions(int(m[0]), by, addr)),
        (r'users/%s/identities/unlink' % _ID, lambda b, m: a.user_unlink_identity(
            int(m[0]), b.get('provider'), b.get('subject'), by, addr)),
        (r'users/%s/delete' % _ID, lambda b, m: a.user_delete(int(m[0]), by, addr)),
        (r'users/%s/roles/add' % _ID, lambda b, m: {'changed': a.user_role_add(
            int(m[0]), need_int(b.get('role_id'), 'role'), by, addr)}),
        (r'users/%s/roles/remove' % _ID, lambda b, m: {'changed': a.user_role_remove(
            int(m[0]), need_int(b.get('role_id'), 'role'), by, addr)}),
        (r'users/%s/groups/add' % _ID, lambda b, m: {'changed': a.user_group_add(
            int(m[0]), need_int(b.get('group_id'), 'group'), by, addr)}),
        (r'users/%s/groups/remove' % _ID, lambda b, m: {'changed': a.user_group_remove(
            int(m[0]), need_int(b.get('group_id'), 'group'), by, addr)}),
        (r'groups', lambda b, m: a.group_create(b.get('name'), by, addr)),
        (r'groups/%s/rename' % _ID, lambda b, m: a.group_rename(
            int(m[0]), b.get('name'), by, b.get('version'), addr)),
        (r'groups/%s/delete' % _ID, lambda b, m: a.group_delete(
            int(m[0]), by, _flag(b, 'confirm'), addr)),
        (r'groups/%s/members/add' % _ID, lambda b, m: a.group_members_add(
            int(m[0]), ids(b), by, addr)),
        (r'groups/%s/members/remove' % _ID, lambda b, m: a.group_members_remove(
            int(m[0]), ids(b), by, addr)),
        (r'groups/%s/roles/add' % _ID, lambda b, m: {'changed': a.group_role_add(
            int(m[0]), need_int(b.get('role_id'), 'role'), by, addr)}),
        (r'groups/%s/roles/remove' % _ID, lambda b, m: {'changed': a.group_role_remove(
            int(m[0]), need_int(b.get('role_id'), 'role'), by, addr)}),
        (r'roles', lambda b, m: a.role_create(b.get('name'), by, _flag(b, 'view_all'), addr)),
        (r'roles/%s/rename' % _ID, lambda b, m: a.role_rename(
            int(m[0]), b.get('name'), by, b.get('version'), addr)),
        (r'roles/%s/view_all' % _ID, lambda b, m: a.role_set_view_all(
            int(m[0]), _need_bool(b, 'view_all'), by, b.get('version'), addr)),
        (r'roles/%s/delete' % _ID, lambda b, m: a.role_delete(
            int(m[0]), by, _flag(b, 'confirm'), addr)),
        (r'grants/add', lambda b, m: a.grant_add(
            b.get('owner_type'), need_int(b.get('owner_id'), 'owner'), b.get('server', '*'),
            b.get('exchange', '*'), b.get('segment', '*'), b.get('dealer', '*'), by, addr)),
        (r'grants/%s/update' % _ID, lambda b, m: a.grant_update(
            int(m[0]), b.get('server', '*'), b.get('exchange', '*'), b.get('segment', '*'),
            b.get('dealer', '*'), by, addr)),
        (r'grants/%s/remove' % _ID, lambda b, m: a.grant_remove(int(m[0]), by, addr)),
        (r'pending/assign', lambda b, m: a.pending_assign(
            ids(b), by, b.get('role_id'), b.get('group_id'), addr)),
        (r'pending/remove', lambda b, m: a.pending_remove(ids(b), by, addr)),
        (r'import/preview', lambda b, m: a.import_preview(b.get('csv'), by)),
        (r'import/commit', lambda b, m: a.import_commit(b.get('token'), by, addr)),
    ]


def _dispatch(routes, rest, arg):
    for pattern, fn in routes:
        m = re.fullmatch(pattern, rest)
        if m:
            return fn(arg, m.groups())
    return None


def handle(admin, by, method, path, query, body, addr=''):
    """-> (status, payload, extra).  See the module docstring."""
    if not path.startswith(PREFIX):
        return NOT_FOUND
    rest = path[len(PREFIX):]
    try:
        if method == 'GET':
            if rest == 'audit.csv':
                text = admin.audit_csv(
                    _q(query, 'since') or None, _q(query, 'until') or None,
                    _q(query, 'user') or None, _q(query, 'event') or None,
                    _q(query, 'outcome') or None)
                return 200, text, {'csv': 'audit.csv'}
            out = _dispatch(_get_routes(admin), rest, query)
        elif method == 'POST':
            out = _dispatch(_post_routes(admin, by, addr), rest, body or {})
        else:
            return NOT_FOUND
        if out is None:
            return NOT_FOUND
        return 200, out, None
    except AdminError as e:
        payload = {'error': e.message}
        payload.update(e.data)
        return e.code, payload, None