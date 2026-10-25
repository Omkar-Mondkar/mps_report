"""ai/service.py - End-to-end AI service entry point."""
import time
from .dispatcher import parse_query
from .resolve import resolve_and_validate, ResolveError, AccessDeniedError
from .executor import execute_query
from .formatter import format_success, format_error


def handle_ask(query_text, cfg, scope=None):
    """
    Handle a user query end-to-end:
    parse -> resolve & scope guard -> execute -> format response.
    """
    start_t = time.perf_counter()
    source = 'rules'
    try:
        if not query_text or not isinstance(query_text, str) or not query_text.strip():
            return format_error("Please enter a question or query.", source=source, took_ms=0.0)

        spec, source, parse_ms = parse_query(query_text, cfg=cfg)

        if spec.get('intent') == 'help':
            res = execute_query(spec, cfg, scope)
            elapsed_ms = (time.perf_counter() - start_t) * 1000.0
            return format_success(res, source=source, took_ms=elapsed_ms)

        resolved_spec = resolve_and_validate(spec, cfg, scope=scope)
        result = execute_query(resolved_spec, cfg, scope=scope)
        elapsed_ms = (time.perf_counter() - start_t) * 1000.0
        return format_success(result, source=source, took_ms=elapsed_ms)

    except AccessDeniedError as e:
        elapsed_ms = (time.perf_counter() - start_t) * 1000.0
        return format_error(str(e), source=source, took_ms=elapsed_ms, status_code=403)
    except ResolveError as e:
        elapsed_ms = (time.perf_counter() - start_t) * 1000.0
        return format_error(str(e), source=source, took_ms=elapsed_ms, status_code=400)
    except Exception as e:
        elapsed_ms = (time.perf_counter() - start_t) * 1000.0
        return format_error(f"Internal error executing query: {e}", source=source, took_ms=elapsed_ms, status_code=500)
