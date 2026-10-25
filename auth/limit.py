"""
auth/limit.py - brute-force limiter for sign-in, and the client address rule.

  * per login: after 5 consecutive failures the login is locked for 30 s; each further
    failure doubles the lock up to 15 minutes.  The lock ends by itself; a success clears
    the count.  Unknown logins are tracked the same way, so the behaviour does not reveal
    which logins exist.
  * per address: more than 20 failures in 5 minutes block that address until the oldest
    of them is 5 minutes old.
  * `check()` is asked before the password is looked at, so a locked login costs no
    scrypt work.  Memory is bounded.
"""
import ipaddress
import threading
import time
from collections import OrderedDict, deque

FREE_FAILURES = 5
BASE_LOCK = 30
MAX_LOCK = 900
IDLE_RESET = 3600
ADDR_FAILURES = 20
ADDR_WINDOW = 300
MAX_TRACKED = 20000
TRUSTED_PEERS = ('127.0.0.1', '::1')


class Limiter:
    def __init__(self, clock=time.monotonic, max_tracked=MAX_TRACKED):
        self._clock = clock
        self._max = max_tracked
        self._logins = OrderedDict()        # login -> [failures, locked_until, last_failure]
        self._addrs = OrderedDict()         # address -> deque of failure times
        self._lock = threading.Lock()

    @staticmethod
    def _key(login):
        return str(login or '').strip().lower()[:254]

    def check(self, login, addr):
        """-> 0 if the attempt may go ahead, else the seconds to wait."""
        now = self._clock()
        key = self._key(login)
        wait = 0.0
        with self._lock:
            entry = self._logins.get(key)
            if entry and entry[1] > now:
                wait = entry[1] - now
            times = self._addrs.get(addr)
            if times is not None:
                while times and now - times[0] >= ADDR_WINDOW:
                    times.popleft()
                if len(times) >= ADDR_FAILURES:
                    wait = max(wait, ADDR_WINDOW - (now - times[0]))
        return wait

    def failure(self, login, addr):
        now = self._clock()
        key = self._key(login)
        with self._lock:
            entry = self._logins.pop(key, None)
            if entry is None or now - entry[2] > IDLE_RESET:
                entry = [0, 0.0, now]
            entry[0] += 1
            entry[2] = now
            if entry[0] >= FREE_FAILURES:
                entry[1] = now + min(BASE_LOCK * 2 ** (entry[0] - FREE_FAILURES), MAX_LOCK)
            self._logins[key] = entry
            while len(self._logins) > self._max:
                self._logins.popitem(last=False)
            times = self._addrs.pop(addr, None)
            if times is None:
                times = deque()
            times.append(now)
            while times and now - times[0] >= ADDR_WINDOW:
                times.popleft()
            self._addrs[addr] = times
            while len(self._addrs) > self._max:
                self._addrs.popitem(last=False)

    def success(self, login, addr=None):
        with self._lock:
            self._logins.pop(self._key(login), None)


def client_addr(peer, forwarded_for=None):
    """The address to attribute a request to.  `X-Forwarded-For` counts only when the
    connection comes from this machine (the reverse proxy); then the last entry, the one
    the proxy itself added, is used."""
    peer = str(peer or '')
    if peer.startswith('::ffff:'):
        peer = peer[7:]
    if peer in TRUSTED_PEERS and forwarded_for:
        last = forwarded_for.split(',')[-1].strip()
        try:
            return str(ipaddress.ip_address(last))
        except ValueError:
            pass
    return peer