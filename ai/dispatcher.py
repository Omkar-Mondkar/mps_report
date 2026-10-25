"""ai/dispatcher.py - Route queries to fast regex rules first, falling back to Ollama."""
import time
from .rules import match_rules
from .llm import query_ollama, OllamaError
from .schema import new_query_spec


def parse_query(text, cfg=None):
    """
    Parse a user query into a QuerySpec.
    Returns:
        (spec, source, latency_ms)
        source: 'rules' or 'ollama'
    """
    start_t = time.perf_counter()

    # 1. Fast Rules Path (<2ms)
    rule_spec = match_rules(text)
    if rule_spec is not None:
        latency_ms = (time.perf_counter() - start_t) * 1000.0
        return rule_spec, 'rules', latency_ms

    # 2. Ollama LLM Fallback
    try:
        llm_spec = query_ollama(text, cfg=cfg)
        latency_ms = (time.perf_counter() - start_t) * 1000.0
        return llm_spec, 'ollama', latency_ms
    except OllamaError as e:
        latency_ms = (time.perf_counter() - start_t) * 1000.0
        # If Ollama is unreachable, return a help intent with error details
        fallback = new_query_spec(intent='help')
        fallback['_error'] = str(e)
        return fallback, 'fallback', latency_ms
