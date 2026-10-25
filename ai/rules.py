"""ai/rules.py - Fast deterministic regex parser for common query patterns (<2ms)."""
import re
from .schema import new_query_spec, DEFAULT_THRESHOLD

# Regex patterns for fast extraction
RE_HELP = re.compile(r'^\s*(help|what can you do|\?|examples?)\s*$', re.IGNORECASE)

# Threshold: "otr > 2500", "otr >= 2000", "above 3000", "> 2000", "over 1500"
RE_THR = re.compile(r'(?:otr|breach(?:es)?|ratio)?\s*(?:>|>=|above|over|exceeding)\s*(\d+(?:\.\d+)?)', re.IGNORECASE)

# Top N: "top 10", "top 5"
RE_TOP = re.compile(r'\btop\s+(\d+)\b', re.IGNORECASE)

# Consecutive days: "5 consecutive days", "consecutive 3 days", "breaches for 5 days"
RE_CONSECUTIVE = re.compile(r'(?:for\s+)?(\d+)\s+consecutive\s+days|\bconsecutive\s+(\d+)\s+days|\bbreaches\s+for\s+(\d+)\s+days', re.IGNORECASE)

# Exchange & Segment
RE_PAIR = re.compile(r'\b(NSE|BSE)[_\s]+(CM|FO|CD)\b', re.IGNORECASE)
RE_EXCHANGE = re.compile(r'\b(NSE|BSE)\b', re.IGNORECASE)
RE_SEGMENT = re.compile(r'\b(CM|FO|CD)\b', re.IGNORECASE)

# Dealer / User: "dealer D101", "user U12", "dealer=1023"
RE_DEALER = re.compile(r'\b(?:dealer|user)\s*[:=]?\s*([A-Za-z0-9_*]+)\b', re.IGNORECASE)

# Relative dates: "today", "yesterday", "last 7 days", "last week"
RE_TODAY = re.compile(r'\btoday\b', re.IGNORECASE)
RE_YESTERDAY = re.compile(r'\byesterday\b', re.IGNORECASE)
RE_LAST_N_DAYS = re.compile(r'\blast\s+(\d+)\s+days\b', re.IGNORECASE)

# ISO date: YYYY-MM-DD or DD-MM-YYYY
RE_ISO_DATE = re.compile(r'\b(\d{4}-\d{2}-\d{2})\b')
RE_DDMMYYYY = re.compile(r'\b(\d{2})[-/](\d{2})[-/](\d{4})\b')

# Server: "server Greek", "on Greek", "Greek server"
RE_SERVER = re.compile(r'\b(?:server\s+([A-Za-z0-9_.-]+)|(?:on\s+([A-Za-z0-9_.-]+)\s+server)|(?:server=([A-Za-z0-9_.-]+)))\b', re.IGNORECASE)

# MPS intents
RE_MPS_PEAK = re.compile(r'\b(peak|highest|max|maximum)\s+(?:mps|rate|messages?)\b|\bmps\s+(?:peak|high)\b', re.IGNORECASE)
RE_MPS_SERIES = re.compile(r'\bmps\s+(?:timeseries|series|trend|chart|graph|history)\b|\bmps\s+(?:today|yesterday|\d{4}-\d{2}-\d{2})\b', re.IGNORECASE)

# OTR intents
RE_OTR_BREACH = re.compile(r'\b(otr|breach(?:es)?|order\s+trade|order-to-trade)\b', re.IGNORECASE)
RE_OTR_SUMMARY = re.compile(r'\b(summary|overview|stats)\b', re.IGNORECASE)


def match_rules(text):
    """
    Parse a natural language query using regex rules.
    Returns a QuerySpec dict on successful match, or None to fall back to LLM.
    """
    if not text or not isinstance(text, str):
        return None
    s = text.strip()
    if not s:
        return None

    if RE_HELP.match(s):
        return new_query_spec(intent='help')

    # Detect Exchange / Segment
    exchange, segment = None, None
    m_pair = RE_PAIR.search(s)
    if m_pair:
        exchange = m_pair.group(1).upper()
        segment = m_pair.group(2).upper()
    else:
        m_ex = RE_EXCHANGE.search(s)
        if m_ex:
            exchange = m_ex.group(1).upper()
        m_seg = RE_SEGMENT.search(s)
        if m_seg:
            segment = m_seg.group(1).upper()

    # Detect Server
    server = None
    m_srv = RE_SERVER.search(s)
    if m_srv:
        server = m_srv.group(1) or m_srv.group(2) or m_srv.group(3)
    elif 'greek' in s.lower():
        server = 'Greek'

    # Detect Dealer
    dealer = None
    m_dlr = RE_DEALER.search(s)
    if m_dlr:
        dealer = m_dlr.group(1)

    # Detect Top N
    top_n = None
    m_top = RE_TOP.search(s)
    if m_top:
        top_n = int(m_top.group(1))

    # Detect Threshold
    threshold = None
    m_thr = RE_THR.search(s)
    if m_thr:
        threshold = float(m_thr.group(1))

    # Detect Dates
    date_from, date_to = None, None
    if RE_TODAY.search(s):
        date_from = 'today'
        date_to = 'today'
    elif RE_YESTERDAY.search(s):
        date_from = 'yesterday'
        date_to = 'yesterday'
    else:
        m_last = RE_LAST_N_DAYS.search(s)
        if m_last:
            days_count = int(m_last.group(1))
            date_from = f'last_{days_count}_days'
            date_to = 'today'
        else:
            m_iso = RE_ISO_DATE.search(s)
            if m_iso:
                date_from = m_iso.group(1)
                date_to = m_iso.group(1)
            else:
                m_dmy = RE_DDMMYYYY.search(s)
                if m_dmy:
                    date_from = f"{m_dmy.group(3)}-{m_dmy.group(2)}-{m_dmy.group(1)}"
                    date_to = date_from

    # Consecutive days check
    m_cons = RE_CONSECUTIVE.search(s)
    if m_cons:
        days = int(m_cons.group(1) or m_cons.group(2) or m_cons.group(3) or 5)
        return new_query_spec(
            intent='otr_consecutive',
            server=server,
            exchange=exchange,
            segment=segment,
            threshold=threshold or DEFAULT_THRESHOLD,
            date_from=date_from or f'last_{days}_days',
            date_to=date_to or 'today',
            dealer=dealer,
            days=days,
            top_n=top_n
        )

    # MPS peak or timeseries check
    if RE_MPS_PEAK.search(s):
        return new_query_spec(
            intent='mps_peak',
            server=server,
            exchange=exchange,
            segment=segment,
            date_from=date_from or 'today',
            date_to=date_to or date_from or 'today'
        )

    if RE_MPS_SERIES.search(s) and not RE_OTR_BREACH.search(s):
        return new_query_spec(
            intent='mps_timeseries',
            server=server,
            exchange=exchange,
            segment=segment,
            date_from=date_from or 'today',
            date_to=date_to or date_from or 'today'
        )

    # OTR Breaches or top
    if threshold is not None or RE_OTR_BREACH.search(s) or dealer is not None:
        intent = 'otr_top' if (top_n is not None and threshold is None) else 'otr_breaches'
        if RE_OTR_SUMMARY.search(s):
            intent = 'otr_summary'
        return new_query_spec(
            intent=intent,
            server=server,
            exchange=exchange,
            segment=segment,
            threshold=threshold or (DEFAULT_THRESHOLD if intent == 'otr_breaches' else None),
            date_from=date_from or 'today',
            date_to=date_to or date_from or 'today',
            dealer=dealer,
            top_n=top_n
        )

    return None
