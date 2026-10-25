"""
auth/scope.py - the one access decision used by every data path.

A Scope is built once per user from the grants they hold (see auth/store.py) and passed down
to the data layer.  A grant is (server, exchange, segment, dealer) where each part is a
value or '*' (any); a dealer is '*', an exact user id or a prefix ending in '*'.

  * `all` (SuperAdmin / Admin / a role with "view all") allows everything.
  * Files written before exchange and segment existed have exchange == segment == '' and
    match only grants whose exchange and segment are both '*'.  The same holds for OTR
    tokens whose exchange cannot be determined.
  * Nothing here touches the file system or the store.
"""

DENIED = 'access denied'


class Forbidden(Exception):
    """The user may not see what was asked for.  The message is fixed so that a refusal
    never says whether the thing exists."""

    def __init__(self):
        Exception.__init__(self, DENIED)


class DealerFilter:
    """Dealers allowed for one (server, exchange, segment).  `matches(user)`."""
    __slots__ = ('exact', 'prefixes')

    def __init__(self, exact=(), prefixes=()):
        self.exact = frozenset(exact)
        self.prefixes = tuple(sorted(set(prefixes)))

    def matches(self, user):
        return user in self.exact or (bool(self.prefixes) and user.startswith(self.prefixes))

    @property
    def empty(self):
        return not self.exact and not self.prefixes


class Scope:
    __slots__ = ('all', '_by_server', '_any_server')

    def __init__(self, grants=(), all=False):
        self.all = bool(all)
        self._by_server = {}
        self._any_server = []
        for server, exchange, segment, dealer in grants:
            entry = (exchange, segment, dealer)
            if server == '*':
                self._any_server.append(entry)
            else:
                self._by_server.setdefault(server, []).append(entry)

    @classmethod
    def everything(cls):
        return cls(all=True)

    def _matching(self, server, exchange, segment):
        """Dealer patterns of every grant that covers (server, exchange, segment)."""
        for entries in (self._by_server.get(server, ()), self._any_server):
            for ex, sg, dealer in entries:
                if (ex == '*' or ex == exchange) and (sg == '*' or sg == segment):
                    yield dealer

    def allows(self, server, exchange='', segment=''):
        if self.all:
            return True
        for _ in self._matching(server, exchange, segment):
            return True
        return False

    def allows_server(self, server):
        return self.all or bool(self._by_server.get(server)) or bool(self._any_server)

    def allows_pair(self, exchange, segment):
        """True if some grant, on any server, covers this exchange and segment."""
        if self.all:
            return True
        for entries in list(self._by_server.values()) + [self._any_server]:
            for ex, sg, _ in entries:
                if (ex == '*' or ex == exchange) and (sg == '*' or sg == segment):
                    return True
        return False

    def dealer_filter(self, server, exchange='', segment=''):
        """None when every dealer is allowed, otherwise a DealerFilter (possibly empty)."""
        if self.all:
            return None
        exact, prefixes = [], []
        for dealer in self._matching(server, exchange, segment):
            if dealer == '*':
                return None
            if dealer.endswith('*'):
                prefixes.append(dealer[:-1])
            else:
                exact.append(dealer)
        return DealerFilter(exact, prefixes)

    def require(self, server, exchange='', segment=''):
        if not self.allows(server, exchange, segment):
            raise Forbidden()

    def require_server(self, server):
        if not self.allows_server(server):
            raise Forbidden()