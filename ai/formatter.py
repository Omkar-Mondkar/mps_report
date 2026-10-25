"""ai/formatter.py - Format assistant responses for the web UI."""


def format_success(result, source='rules', took_ms=0.0):
    """Format successful execution result into the API response schema."""
    return {
        "ok": True,
        "answer": result.get("summary", ""),
        "table": result.get("table", {"columns": [], "rows": []}),
        "chart": result.get("chart"),
        "ui_action": result.get("ui_action"),
        "meta": {
            "took_ms": round(took_ms, 1),
            "source": source,
            "intent": result.get("intent")
        }
    }


def format_error(error_msg, source='rules', took_ms=0.0, status_code=400):
    """Format an error result into the API response schema."""
    return {
        "ok": False,
        "error": str(error_msg),
        "answer": f"**Error**: {error_msg}",
        "table": {"columns": [], "rows": []},
        "chart": None,
        "ui_action": None,
        "meta": {
            "took_ms": round(took_ms, 1),
            "source": source
        }
    }
