"""
auth/password.py - password hashing (scrypt, standard library only).

Stored format: scrypt$<n>$<r>$<p>$<salt hex>$<hash hex>.  The parameters travel with the
hash, so raising them later leaves existing hashes valid.  A password is never returned,
logged or audited; hashing runs behind a small semaphore so a burst of sign-ins cannot
use all the memory scrypt needs.
"""
import hashlib
import hmac
import os
import threading

SCHEME = 'scrypt'
N = 2 ** 14
R = 8
P = 1
SALT_BYTES = 16
KEY_BYTES = 32
MIN_LENGTH = 10
MAX_LENGTH = 1024
MAX_N = 2 ** 20                 # refuse absurd parameters from a damaged row
CONCURRENCY = 4

_gate = threading.BoundedSemaphore(CONCURRENCY)
_dummy = None
_dummy_lock = threading.Lock()


class PasswordError(ValueError):
    """The password does not meet the rules; the message says why."""


def available():
    """True if this Python can run scrypt (needs OpenSSL 1.1+)."""
    return hasattr(hashlib, 'scrypt')


def check_policy(password):
    if not isinstance(password, str):
        raise PasswordError('password must be text')
    if len(password) < MIN_LENGTH:
        raise PasswordError('password must be at least %d characters' % MIN_LENGTH)
    if len(password) > MAX_LENGTH:
        raise PasswordError('password must be at most %d characters' % MAX_LENGTH)


def _derive(password, salt, n, r, p):
    maxmem = 128 * n * r * p + 4 * 1024 * 1024
    with _gate:
        return hashlib.scrypt(password.encode('utf-8'), salt=salt, n=n, r=r, p=p,
                              maxmem=maxmem, dklen=KEY_BYTES)


def hash_password(password, n=N, r=R, p=P):
    """-> the stored string.  Applies the length rules."""
    check_policy(password)
    salt = os.urandom(SALT_BYTES)
    key = _derive(password, salt, n, r, p)
    return '%s$%d$%d$%d$%s$%s' % (SCHEME, n, r, p, salt.hex(), key.hex())


def _parse(stored):
    try:
        scheme, n, r, p, salt, key = stored.split('$')
        n, r, p = int(n), int(r), int(p)
        salt, key = bytes.fromhex(salt), bytes.fromhex(key)
    except (AttributeError, ValueError):
        return None
    if scheme != SCHEME or not (2 <= n <= MAX_N) or n & (n - 1) or not (1 <= r <= 32) \
            or not (1 <= p <= 16) or not salt or len(key) != KEY_BYTES:
        return None
    return n, r, p, salt, key


def verify(password, stored):
    """True if `password` matches the stored string; False for anything malformed."""
    parsed = _parse(stored)
    if parsed is None or not isinstance(password, str) or len(password) > MAX_LENGTH:
        return False
    n, r, p, salt, key = parsed
    return hmac.compare_digest(_derive(password, salt, n, r, p), key)


def _dummy_hash():
    global _dummy
    with _dummy_lock:
        if _dummy is None:
            _dummy = hash_password('not-a-real-password-0000')
        return _dummy


def verify_or_dummy(password, stored):
    """Like verify(), but spends the same time when there is no stored hash (unknown login
    or an account without a password), so timing does not reveal which logins exist."""
    if stored is None:
        verify(password, _dummy_hash())
        return False
    return verify(password, stored)