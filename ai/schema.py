"""ai/schema.py - QuerySpec schema and allowed constants."""

INTENTS = {
    'otr_breaches',      # Breaches strictly above threshold
    'otr_top',           # Top dealers/symbols by OTR
    'otr_consecutive',   # Dealers with consecutive breaches over N days
    'otr_summary',       # Snapshot / overall OTR metrics
    'mps_peak',          # Maximum messages-per-second rate
    'mps_timeseries',    # MPS rate points over a day or interval
    'help',              # Usage instructions / guidance
}

DEFAULT_INTENT = 'otr_breaches'
DEFAULT_THRESHOLD = 2000.0
DEFAULT_TOP_N = 20
MAX_TOP_N = 100
MAX_DAYS_WINDOW = 30

QUERY_SPEC_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "intent": {
            "type": "string",
            "enum": list(INTENTS)
        },
        "server": {
            "type": ["string", "null"]
        },
        "exchange": {
            "type": ["string", "null"],
            "enum": ["NSE", "BSE", None]
        },
        "segment": {
            "type": ["string", "null"],
            "enum": ["CM", "FO", "CD", None]
        },
        "threshold": {
            "type": ["number", "null"]
        },
        "date_from": {
            "type": ["string", "null"],
            "description": "ISO date YYYY-MM-DD or relative like 'today', 'yesterday'"
        },
        "date_to": {
            "type": ["string", "null"],
            "description": "ISO date YYYY-MM-DD or relative like 'today', 'yesterday'"
        },
        "time": {
            "type": ["string", "null"],
            "description": "Snapshot time HHMMSS or null"
        },
        "dealer": {
            "type": ["string", "null"],
            "description": "Dealer / user ID or pattern (e.g. D101) or null"
        },
        "days": {
            "type": ["integer", "null"],
            "description": "Number of days for consecutive breach queries (e.g. 5)"
        },
        "top_n": {
            "type": ["integer", "null"]
        }
    },
    "required": ["intent"]
}


def new_query_spec(intent=DEFAULT_INTENT, **kwargs):
    """Return a validated default QuerySpec dictionary."""
    if intent not in INTENTS:
        intent = DEFAULT_INTENT
    spec = {
        'intent': intent,
        'server': kwargs.get('server'),
        'exchange': kwargs.get('exchange'),
        'segment': kwargs.get('segment'),
        'threshold': kwargs.get('threshold'),
        'date_from': kwargs.get('date_from'),
        'date_to': kwargs.get('date_to'),
        'time': kwargs.get('time'),
        'dealer': kwargs.get('dealer'),
        'days': kwargs.get('days'),
        'top_n': kwargs.get('top_n') or DEFAULT_TOP_N,
    }
    return spec
