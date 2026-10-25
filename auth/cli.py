"""
auth/cli.py - the command-line management tool (started by mps_access.py).

It runs the same `Admin` operations as the web screens, under the same rules and with the
same audit entries, straight on the access database, so it works with the server stopped
and also with it running (the server notices a change within a second).  The audit actor is
`cli:<operating-system user>`.

    python3 mps_access.py user list --q smith --status waiting
    python3 mps_access.py user add jane.doe --name "Jane Doe" --ask-password
    python3 mps_access.py role create "FO desk"
    python3 mps_access.py group add "NSE FO desk"
    python3 mps_access.py group role add "NSE FO desk" "FO desk"
    python3 mps_access.py grant add --role "FO desk" --exchange NSE --segment FO
    python3 mps_access.py group member add "NSE FO desk" jane.doe
    python3 mps_access.py access jane.doe
    python3 mps_access.py audit tail -n 20
"""
import argparse
import getpass
import os
import sys

import mps_data as data
import otr_data as otr

from . import admin as adm
from . import config as auth_config
from . import password as pw
from . import store as st

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class CliError(Exception):
    pass


# ---------------------------------------------------------------------------- parsing
def build_parser():
    ap = argparse.ArgumentParser(
        prog='mps_access.py', description='Manage MPS dashboard access from the host.')
    ap.add_argument('--config', help='JSON config (default: config.json next to this script)')
    ap.add_argument('--db', help='access database file (overrides "auth.db" in the config)')
    top = ap.add_subparsers(dest='cmd', metavar='COMMAND')
    top.required = True

    user = top.add_parser('user', help='users').add_subparsers(dest='sub', metavar='ACTION')
    user.required = True
    p = user.add_parser('list', help='list users, one page')
    p.add_argument('--q', default='', help='search sign-in name, name or e-mail')
    p.add_argument('--status', default='', choices=['', 'enabled', 'disabled', 'waiting'])
    p.add_argument('--page', type=int, default=1)
    p.add_argument('--size', type=int, default=50)
    p = user.add_parser('add', help='create a user')
    p.add_argument('login')
    p.add_argument('--name', default='')
    p.add_argument('--email', default='')
    p.add_argument('--ask-password', action='store_true', help='also set a local password')
    for name in ('enable', 'disable'):
        user.add_parser(name, help='%s a user' % name).add_argument('login')
    user.add_parser('passwd', help='set a local password (ends the user\'s sessions)'
                    ).add_argument('login')

    role = top.add_parser('role', help='roles').add_subparsers(dest='sub', metavar='ACTION')
    role.required = True
    role.add_parser('list', help='list roles')
    p = role.add_parser('create', help='create a custom role')
    p.add_argument('name')
    p.add_argument('--view-all', action='store_true', help='the role sees every report')
    for name in ('assign', 'unassign'):
        p = role.add_parser(name, help='%s a role to or from a user' % name)
        p.add_argument('login')
        p.add_argument('role')

    group = top.add_parser('group', help='groups').add_subparsers(dest='sub', metavar='ACTION')
    group.required = True
    group.add_parser('list', help='list groups')
    group.add_parser('add', help='create a group').add_argument('name')
    member = group.add_parser('member', help='group members').add_subparsers(
        dest='action', metavar='ACTION')
    member.required = True
    for name in ('add', 'remove'):
        p = member.add_parser(name, help='%s members' % name)
        p.add_argument('group')
        p.add_argument('logins', nargs='+')
    grole = group.add_parser('role', help='roles of a group').add_subparsers(
        dest='action', metavar='ACTION')
    grole.required = True
    for name in ('add', 'remove'):
        p = grole.add_parser(name, help='%s a role of a group' % name)
        p.add_argument('group')
        p.add_argument('role')

    grant = top.add_parser('grant', help='grants').add_subparsers(dest='sub', metavar='ACTION')
    grant.required = True
    p = grant.add_parser('list', help='list the grants of a user or role')
    owner = p.add_mutually_exclusive_group(required=True)
    owner.add_argument('--user')
    owner.add_argument('--role')
    p = grant.add_parser('add', help='add a grant to a user or custom role')
    owner = p.add_mutually_exclusive_group(required=True)
    owner.add_argument('--user')
    owner.add_argument('--role')
    p.add_argument('--server', default='*')
    p.add_argument('--exchange', default='*')
    p.add_argument('--segment', default='*')
    p.add_argument('--dealer', default='*', help='*, one id, or a prefix such as DESK1*')
    grant.add_parser('remove', help='remove a grant by number').add_argument('id', type=int)

    top.add_parser('access', help='what one user can see and why').add_argument('login')

    audit = top.add_parser('audit', help='audit log').add_subparsers(dest='sub', metavar='ACTION')
    audit.required = True
    p = audit.add_parser('tail', help='the latest entries')
    p.add_argument('-n', type=int, default=20)
    p.add_argument('--event')
    p.add_argument('--user')
    p.add_argument('--outcome', choices=['ok', 'denied'])
    return ap


# ---------------------------------------------------------------------------- helpers
class Tool:
    def __init__(self, admin, store, actor, out, read_password):
        self.a, self.store, self.actor, self.out = admin, store, actor, out
        self.read_password = read_password

    def say(self, text=''):
        print(text, file=self.out)

    # name -> id
    def user_id(self, login):
        row = self.store.get_user_by_login(login)
        if row is None:
            raise CliError('no user "%s"' % login)
        return row['id']

    def role_id(self, name):
        row = self.store.get_role_by_name(name)
        if row is None:
            raise CliError('no role "%s"' % name)
        return row['id']

    def group_id(self, name):
        row = self.store.get_group_by_name(name)
        if row is None:
            raise CliError('no group "%s"' % name)
        return row['id']

    def ask_password(self, who):
        first = self.read_password('New password for %s: ' % who)
        if first != self.read_password('Repeat the password: '):
            raise CliError('the passwords do not match; nothing was changed')
        return first

    # commands
    def user(self, args):
        a = self.a
        if args.sub == 'list':
            page = a.user_list(args.q, args.status, None, None, args.page, args.size)
            for u in page['items']:
                state = 'disabled' if not u['enabled'] else 'waiting' if u['waiting'] else 'enabled'
                self.say('%-24s %-9s %-24s %s' % (u['login'], state, u['name'],
                                                  ', '.join(u['roles'])))
            self.say('%d user(s), page %d of %d' % (
                page['total'], page['page'], max(1, -(-page['total'] // page['size']))))
        elif args.sub == 'add':
            password = self.ask_password(args.login) if args.ask_password else None
            u = a.user_create(args.login, self.actor, args.name, args.email, password)
            self.say('user %s created%s' % (u['login'], ' with a password' if password else ''))
        elif args.sub in ('enable', 'disable'):
            u = a.user_set_enabled(self.user_id(args.login), args.sub == 'enable', self.actor)
            self.say('user %s %sd' % (u['login'], args.sub))
        elif args.sub == 'passwd':
            uid = self.user_id(args.login)
            a.user_set_password(uid, self.ask_password(args.login), self.actor)
            self.say('password of %s set; its sessions ended' % args.login.strip().lower())

    def role(self, args):
        a = self.a
        if args.sub == 'list':
            for r in a.role_list(size=adm.PAGE_MAX)['items']:
                kind = 'built-in' if r['builtin'] else 'custom'
                self.say('%-24s %-9s %5d user(s)%s' % (
                    r['name'], kind, r['users'], '  sees everything' if r['view_all'] else ''))
        elif args.sub == 'create':
            r = a.role_create(args.name, self.actor, args.view_all)
            self.say('role %s created' % r['name'])
        else:
            uid, rid = self.user_id(args.login), self.role_id(args.role)
            if args.sub == 'assign':
                changed = a.user_role_add(uid, rid, self.actor)
            else:
                changed = a.user_role_remove(uid, rid, self.actor)
            self.say('%s: %s' % (args.login, ('role %s %s' % (args.role, args.sub + 'ed'))
                                 if changed else 'nothing to change'))

    def group(self, args):
        a = self.a
        if args.sub == 'list':
            for g in a.group_list(size=adm.PAGE_MAX)['items']:
                self.say('%-28s %5d member(s)  roles: %s' % (g['name'], g['members'],
                                                             ', '.join(g['roles']) or '-'))
        elif args.sub == 'add':
            g = a.group_create(args.name, self.actor)
            self.say('group %s created' % g['name'])
        elif args.sub == 'member':
            gid = self.group_id(args.group)
            ids = [self.user_id(login) for login in args.logins]
            fn = a.group_members_add if args.action == 'add' else a.group_members_remove
            self.say('%d change(s) in group %s' % (fn(gid, ids, self.actor)['changed'], args.group))
        else:
            gid, rid = self.group_id(args.group), self.role_id(args.role)
            fn = a.group_role_add if args.action == 'add' else a.group_role_remove
            self.say('%s' % ('done' if fn(gid, rid, self.actor) else 'nothing to change'))

    def grant(self, args):
        a = self.a
        if args.sub == 'remove':
            a.grant_remove(args.id, self.actor)
            return self.say('grant %d removed' % args.id)
        if args.user:
            owner_type, owner_id = 'user', self.user_id(args.user)
        else:
            owner_type, owner_id = 'role', self.role_id(args.role)
        if args.sub == 'add':
            g = a.grant_add(owner_type, owner_id, args.server, args.exchange, args.segment,
                            args.dealer, self.actor)
            return self.say('grant %d: %s' % (g['id'], g['text']))
        grants = (a.user_get(owner_id)['grants'] if owner_type == 'user'
                  else a.role_get(owner_id)['grants'])
        for g in grants:
            self.say('%5d  %s' % (g['id'], g['text']))
        self.say('%d grant(s)' % len(grants))

    def access(self, args):
        out = self.a.access(self.user_id(args.login))
        self.say('%s (%s)' % (out['login'], 'enabled' if out['enabled'] else 'disabled'))
        if out['waiting']:
            self.say('  waiting for access: no role, group or grant gives anything yet')
        for r in out['roles']:
            via = ', '.join('direct' if v['type'] == 'direct' else 'group ' + v['group']
                            for v in r['via'])
            self.say('  role %-20s via %s%s' % (
                r['name'], via, '  (sees everything)' if r['view_all'] else ''))
        for g in out['grants']:
            self.say('  grant from %s %s: %s' % (g['owner']['type'], g['owner']['name'], g['text']))
        reach = out['reach']
        self.say('  reaches %d report(s) on server(s): %s' % (
            reach['reports'], ', '.join(reach['servers']) or '-'))
        if reach.get('note'):
            self.say('  note: %s' % reach['note'])

    def audit(self, args):
        items = self.a.audit_query(user=args.user, event=args.event, outcome=args.outcome,
                                   size=max(1, min(args.n, adm.AUDIT_PAGE_MAX)))['items']
        for e in reversed(items):
            self.say('%s  %-18s %-14s %-24s %s' % (e['ts'], e['event'], e['actor'], e['subject'],
                                                   e['detail']))


# ---------------------------------------------------------------------------- main
def open_tool(args, out, read_password, os_user):
    cfg_path = args.config
    if not cfg_path and os.path.isfile(os.path.join(HERE, 'config.json')):
        cfg_path = os.path.join(HERE, 'config.json')
    try:
        cfg = otr.load_otr_config(data.load_config(cfg_path))
        base = os.path.dirname(os.path.abspath(cfg_path)) if cfg_path else HERE
        acfg = auth_config.load_auth_config(cfg, base, need_public_url=False)
    except data.ConfigError as e:
        raise CliError(str(e))
    db = os.path.abspath(args.db) if args.db else acfg['db']
    if not pw.available():
        raise CliError('this Python has no hashlib.scrypt; passwords cannot be set')
    store = st.Store(db)
    return Tool(adm.Admin(store, cfg), store, adm.Actor.cli(os_user), out, read_password), store


def main(argv=None, out=None, err=None, read_password=getpass.getpass, os_user=None):
    out = out or sys.stdout
    err = err or sys.stderr
    args = build_parser().parse_args(argv)
    if os_user is None:
        try:
            os_user = getpass.getuser()
        except Exception:
            os_user = ''
    store = None
    try:
        tool, store = open_tool(args, out, read_password, os_user)
        getattr(tool, args.cmd)(args)
        return 0
    except adm.AdminError as e:
        print('error: %s' % e.message, file=err)
        return 1
    except (CliError, st.StoreError) as e:
        print('error: %s' % e, file=err)
        return 1
    finally:
        if store is not None:
            store.close()