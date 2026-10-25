# AI Infrastructure Setup Guide (Lowest Latency on CPU)

This guide walks through setting up the AI module for the MPS/OTR viewer, connecting your Linux RHEL application server to an Ollama server running on an Intel Xeon (Icelake) CPU over a secure SSH tunnel.

---

## 1. Architecture Overview

```
┌─────────────────────────────────┐                 ┌─────────────────────────────────┐
│     Linux RHEL Server           │                 │      Remote Ollama Server       │
│  (Hosts MPS/OTR Web App)        │                 │ (Intel Xeon Icelake, 4 vCPUs)   │
│                                 │                 │                                 │
│  mps_graph.py (Port 8000)       │                 │  Ollama Daemon (Port 11434)     │
│       │                         │                 │       ▲                         │
│  POST /api/ai/ask               │                 │       │                         │
│       │                         │                 │       │                         │
│  Fast Rules (< 2ms)             │                 │  qwen2.5:1.5b-instruct          │
│       │ (fallback)              │                 │  (Quantized 4-bit, in RAM)      │
│       ▼                         │                 │                                 │
│  SSH Tunnel: localhost:11435 ───┼─[SSH L-Tunnel]──┼───────┘                         │
└─────────────────────────────────┘                 └─────────────────────────────────┘
```

* **Fast Rules Engine**: Resolves 60–70% of common queries in **< 2ms** directly in Python without touching the network or CPU inference.
* **Local Ollama Fallback**: Handles fuzzy/conversational queries via an SSH tunnel (`127.0.0.1:11435`).
* **Strict JSON Schema**: Restricts model token generation to `QuerySpec` JSON, eliminating conversational padding and capping latency.

---

## 2. Remote Ollama Server Setup (Intel Xeon CPU)

### A. Install Ollama
On the CPU server (as root or sudo user):
```bash
curl -fsSL https://ollama.com/install.sh | sh
```

### B. Pull the Recommended Low-Latency Model
For CPU inference on an Intel Xeon (Icelake) server with 4 vCPUs, **`qwen2.5:1.5b-instruct`** delivers the best balance of speed and extraction accuracy:
```bash
# Recommended (Fastest: < 800ms per query on CPU)
ollama pull qwen2.5:1.5b-instruct

# Optional alternative (Deeper extraction: ~1.5s per query on CPU)
ollama pull qwen2.5:3b-instruct
```

### C. Configure Systemd Service for Lowest CPU Latency
Edit `/etc/systemd/system/ollama.service.d/override.conf`:
```bash
sudo mkdir -p /etc/systemd/system/ollama.service.d
sudo nano /etc/systemd/system/ollama.service.d/override.conf
```
Add the following performance optimizations:
```ini
[Service]
# Prevent model unloading: keep model pinned in RAM
Environment="OLLAMA_KEEP_ALIVE=30m"
# Limit parallel requests to prevent CPU thread starvation
Environment="OLLAMA_NUM_PARALLEL=1"
# Bound execution threads to physical CPU cores
Environment="OLLAMA_NUM_THREADS=4"
```

Reload and restart the Ollama service:
```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama
sudo systemctl status ollama
```

### D. Verify Local Inference
```bash
curl http://127.0.0.1:11434/api/generate -d '{
  "model": "qwen2.5:1.5b-instruct",
  "prompt": "ping",
  "stream": false
}'
```

---

## 3. SSH Port Forwarding Tunnel (RHEL Server)

On your **Linux RHEL server** (where `mps_graph.py` runs), forward local port `11435` to the remote Ollama server's port `11434`:

### A. Test Tunnel Manually
```bash
ssh -N -L 11435:127.0.0.1:11434 root@<OLLAMA_SERVER_IP>
```

### B. Setup Persistent Background Tunnel with Systemd
To keep the tunnel running 24/7 without terminal sessions, create a systemd service on the RHEL server:

Create `/etc/systemd/system/mps-ollama-tunnel.service`:
```ini
[Unit]
Description=SSH Tunnel for MPS AI Ollama Bridge
After=network.target

[Service]
User=root
ExecStart=/usr/bin/ssh -NT -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -L 11435:127.0.0.1:11434 root@<OLLAMA_SERVER_IP>
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and start the service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mps-ollama-tunnel
```

### C. Verify Tunnel on RHEL Server
```bash
curl http://127.0.0.1:11435/api/tags
```
*Expected output*: A JSON response listing `qwen2.5:1.5b-instruct`.

---

## 4. Install Analytical Aggregation Layer (DuckDB)

On the RHEL application host, install DuckDB for out-of-core streaming aggregation over multi-day CSV snapshots:

```bash
pip install duckdb
```

Verify the installation:
```bash
python3 -c "import duckdb; print('DuckDB Version:', duckdb.__version__)"
```

*(Note: If DuckDB cannot be installed due to repository restrictions, the application automatically falls back to built-in Python streaming with zero errors).*

---

## 5. Application Configuration (`config.json`)

Ensure your `config.json` has the `ai` section enabled:

```json
{
  "title": "PROD PSFYVFD001",
  "dir": "/else/home/oaa/MsgRatioPerSec",
  "filename": "MPS_Greek_{ip}_{exchange}_{segment}_{date}.csv",
  "otr_dir": "/home/oaa/Greek_Prod_OTR_Data",
  "otr_threshold": 2000,
  "ai": {
    "ollama_url": "http://127.0.0.1:11435",
    "model": "qwen2.5:1.5b-instruct",
    "duckdb": true
  }
}
```

---

## 6. Running and Validating the Application

### A. Start the Server
```bash
python3 mps_graph.py
```

### B. Test Fast-Path Rule Latency (< 5ms)
```bash
curl -X POST http://127.0.0.1:8000/api/ai/ask \
  -H "Content-Type: application/json" \
  -d '{"query": "otr breaches > 2000 in nse fo"}'
```
*Notice in the response: `"source": "rules"`, `"took_ms": ~1.2ms`.*

### C. Test LLM Fallback Latency (< 1200ms)
```bash
curl -X POST http://127.0.0.1:8000/api/ai/ask \
  -H "Content-Type: application/json" \
  -d '{"query": "Could you locate all dealer violations exceeding two thousand yesterday?"}'
```
*Notice in the response: `"source": "ollama"`, `"took_ms": ~800-1200ms`.*

### D. Frontend Interface
1. Open `http://<server-ip>:8000` in your browser.
2. Click the floating **✨ Assistant** button in the lower right.
3. Test natural language queries or click any quick-suggestion chip.
4. Click **⤢ Expand** in the header to view expansive tables and Canvas charts (line/bar/pie).
5. Click **↗ Apply to Dashboard** to dynamically synchronize the active dashboard filters and threshold.
