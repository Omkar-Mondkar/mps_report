"""ai/resolve.py - Relative date resolution, enum validation, and RBAC scope intersection."""
import datetime
import re
from .schema import INTENTS, MAX_TOP_N, MAX_DAYS_WINDOW, DEFAULT_TOP_N

ISO_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
TIME_RE = re.compile(r'^\d{6}$')


class ResolveError(ValueError):
    """Raised when parameters cannot be validated or resolved."""
    pass


class AccessDeniedError(PermissionError):
    """Raised when the resolved query violates the user's Scope."""
    pass


def resolve_date(expr, reference_date=None):
    """
    Resolve relative or ISO date expressions into an ISO date string (YYYY-MM-DD).
    Supports: 'today', 'yesterday', 'last_N_days', or 'YYYY-MM-DD'.
    """
    today = reference_date or datetime.date.today()
    if not expr:
        return today.isoformat()

    expr = str(expr).strip().lower()
    if expr == 'today':
        return today.isoformat()
    if expr == 'yesterday':
        return (today - datetime.timedelta(days=1)).isoformat()

    m_last = re.match(r'^last_?(\d+)_?days?$', expr)
    if m_last:
        days = min(int(m_last.group(1)), MAX_DAYS_WINDOW)
        return (today - datetime.timedelta(days=days)).isoformat()

    if ISO_RE.match(expr):
        try:
            d = datetime.datetime.strptime(expr, '%Y-%m-%d').date()
            return d.isoformat()
        except ValueError:
            raise ResolveError(f"Invalid date: {expr}")

    raise ResolveError(f"Cannot resolve date expression: {expr}")


def resolve_and_validate(spec, cfg, scope=None):
    """
    Validate spec values against config and user's Scope.
    Returns cleaned resolved_spec dict.
    Raises ResolveError or AccessDeniedError.
    """
    if not isinstance(spec, dict):
        raise ResolveError("QuerySpec must be a dictionary")

    intent = spec.get('intent')
    if intent not in INTENTS:
        raise ResolveError(f"Unknown query intent: {intent}")

    # Resolve dates
    date_from = resolve_date(spec.get('date_from'))
    date_to = resolve_date(spec.get('date_to') or spec.get('date_from'))
    if date_from > date_to:
        date_from, date_to = date_to, date_from

    # Prevent excessively large date ranges
    d1 = datetime.datetime.strptime(date_from, '%Y-%m-%d').date()
    d2 = datetime.datetime.strptime(date_to, '%Y-%m-%d').date()
    if (d2 - d1).days > MAX_DAYS_WINDOW:
        d1 = d2 - datetime.timedelta(days=MAX_DAYS_WINDOW)
        date_from = d1.isoformat()

    # Resolve server
    known_servers = {s['name'].lower(): s for s in cfg.get('servers', [])}
    known_servers.update({s['ip'].lower(): s for s in cfg.get('servers', [])})
    server_req = spec.get('server')
    server_ip = None
    server_name = None

    if server_req:
        s_match = known_servers.get(str(server_req).strip().lower())
        if s_match:
            server_ip = s_match['ip']
            server_name = s_match.get('name') or s_match['ip']
        else:
            server_ip = str(server_req).strip()
            server_name = server_ip
    elif cfg.get('servers'):
        # Default to first server in config if none specified
        first_srv = cfg['servers'][0]
        server_ip = first_srv['ip']
        server_name = first_srv.get('name') or first_srv['ip']

    # Validate Exchange & Segment
    exchange = spec.get('exchange')
    segment = spec.get('segment')
    if exchange:
        exchange = str(exchange).upper()
        valid_exchanges = {e['code'] for e in cfg.get('exchanges', [])}
        if valid_exchanges and exchange not in valid_exchanges:
            raise ResolveError(f"Invalid exchange: {exchange}. Allowed: {', '.join(sorted(valid_exchanges))}")
    if segment:
        segment = str(segment).upper()
        valid_segments = {s['code'] for s in cfg.get('segments', [])}
        if valid_segments and segment not in valid_segments:
            raise ResolveError(f"Invalid segment: {segment}. Allowed: {', '.join(sorted(valid_segments))}")

    # Threshold
    threshold = spec.get('threshold')
    if threshold is not None:
        try:
            threshold = float(threshold)
            if threshold < 0:
                threshold = 0.0
        except (ValueError, TypeError):
            threshold = cfg.get('otr_threshold', 2000.0)
    elif intent == 'otr_breaches':
        threshold = cfg.get('otr_threshold', 2000.0)

    # Top N
    top_n = spec.get('top_n')
    if top_n is not None:
        try:
            top_n = max(1, min(int(top_n), MAX_TOP_N))
        except (ValueError, TypeError):
            top_n = DEFAULT_TOP_N
    else:
        top_n = DEFAULT_TOP_N

    # Consecutive days
    days = spec.get('days')
    if days is not None:
        try:
            days = max(1, min(int(days), MAX_DAYS_WINDOW))
        except (ValueError, TypeError):
            days = 5

    # Dealer
    dealer = spec.get('dealer')
    if dealer:
        dealer = str(dealer).strip()

    # Time
    time_val = spec.get('time')
    if time_val:
        time_val = str(time_val).strip()
        if not TIME_RE.match(time_val):
            time_val = None

    # RBAC Scope Check
    if scope is not None:
        if server_ip and not scope.allows_server(server_ip):
            raise AccessDeniedError(f"Access denied to server {server_name or server_ip}")
        if exchange and segment:
            if server_ip and not scope.allows(server_ip, exchange, segment):
                raise AccessDeniedError(f"Access denied to {exchange} {segment} on {server_name}")
            elif not scope.allows_pair(exchange, segment):
                raise AccessDeniedError(f"Access denied to {exchange} {segment}")
        if dealer and server_ip:
            df = scope.dealer_filter(server_ip, exchange or '', segment or '')
            if df is not None and not df.matches(dealer):
                raise AccessDeniedError(f"Access denied to dealer {dealer}")

    return {
        'intent': intent,
        'server_ip': server_ip,
        'server_name': server_name,
        'exchange': exchange,
        'segment': segment,
        'threshold': threshold,
        'date_from': date_from,
        'date_to': date_to,
        'time': time_val,
        'dealer': dealer,
        'days': days,
        'top_n': top_n,
    }
