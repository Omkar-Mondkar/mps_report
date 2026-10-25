"""ai/llm.py - Lightweight, low-latency Ollama client using standard library urllib."""
import json
import logging
import urllib.error
import urllib.request
from .schema import QUERY_SPEC_JSON_SCHEMA, new_query_spec

DEFAULT_OLLAMA_URL = "http://127.0.0.1:11435"
DEFAULT_MODEL = "qwen2.5:1.5b-instruct"
DEFAULT_TIMEOUT_SEC = 5.0

SYSTEM_PROMPT = """You are a trading systems query extraction engine. Translate user operational queries into a QuerySpec JSON.
Only extract explicitly mentioned or implied parameters.
Supported intents: otr_breaches, otr_top, otr_consecutive, otr_summary, mps_peak, mps_timeseries, help.
Exchanges: NSE, BSE. Segments: CM, FO, CD.
Dates: emit 'today', 'yesterday', 'last_N_days', or 'YYYY-MM-DD'.
Examples:
- "Show breaches above 2000 in NSE FO yesterday" -> {"intent":"otr_breaches","threshold":2000,"exchange":"NSE","segment":"FO","date_from":"yesterday","date_to":"yesterday"}
- "Dealers with breaches for 5 consecutive days" -> {"intent":"otr_consecutive","days":5,"date_from":"last_5_days","date_to":"today"}
- "Peak MPS rate on Greek today" -> {"intent":"mps_peak","server":"Greek","date_from":"today","date_to":"today"}
- "Top 10 dealers by OTR" -> {"intent":"otr_top","top_n":10}
"""

logger = logging.getLogger(__name__)


class OllamaError(Exception):
    pass


def query_ollama(text, cfg=None, timeout=DEFAULT_TIMEOUT_SEC):
    """
    Query Ollama /api/chat with constrained JSON schema.
    Returns a QuerySpec dict or raises OllamaError.
    """
    ai_cfg = (cfg or {}).get('ai', {})
    base_url = ai_cfg.get('ollama_url', DEFAULT_OLLAMA_URL).rstrip('/')
    url = f"{base_url}/api/chat"
    model = ai_cfg.get('model', DEFAULT_MODEL)

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": text}
        ],
        "format": QUERY_SPEC_JSON_SCHEMA,
        "stream": False,
        "keep_alive": "30m",
        "options": {
            "temperature": 0.0,
            "num_predict": 128,
        }
    }

    req_data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(
        url,
        data=req_data,
        headers={"Content-Type": "application/json"}
    )

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode('utf-8')
            res = json.loads(body)
            msg_content = res.get('message', {}).get('content', '')
            parsed = json.loads(msg_content)
            return new_query_spec(**parsed)
    except urllib.error.URLError as e:
        logger.warning(f"Ollama connection failed at {url}: {e}")
        raise OllamaError(f"Could not connect to Ollama service at {url} (verify SSH tunnel on port 11435): {e}")
    except (json.JSONDecodeError, KeyError) as e:
        logger.warning(f"Failed to parse Ollama response: {e}")
        raise OllamaError(f"Invalid response from Ollama: {e}")
    except Exception as e:
        logger.warning(f"Ollama unexpected error: {e}")
        raise OllamaError(f"LLM query error: {e}")
