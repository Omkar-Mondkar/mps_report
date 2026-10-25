"""ai/executor.py - Query execution engine for OTR & MPS with DuckDB / Python cache."""
import datetime
import os
from collections import defaultdict
import mps_data as data
import otr_data as otr
from .resolve import AccessDeniedError

# Try importing duckdb if available
try:
    import duckdb
    HAS_DUCKDB = True
except ImportError:
    duckdb = None
    HAS_DUCKDB = False


def execute_query(spec, cfg, scope=None):
    """
    Execute resolved QuerySpec within user scope.
    Returns:
        dict: {
            "intent": intent,
            "spec": spec,
            "summary": str,
            "table": {"columns": list, "rows": list},
            "chart": dict or None,
            "ui_action": dict or None,
        }
    """
    intent = spec.get('intent')

    if intent == 'help':
        return _execute_help(spec)
    elif intent in ('otr_breaches', 'otr_top', 'otr_summary'):
        return _execute_otr_snapshot(spec, cfg, scope)
    elif intent == 'otr_consecutive':
        return _execute_otr_consecutive(spec, cfg, scope)
    elif intent == 'mps_peak':
        return _execute_mps_peak(spec, cfg, scope)
    elif intent == 'mps_timeseries':
        return _execute_mps_timeseries(spec, cfg, scope)
    else:
        return {
            "intent": intent,
            "summary": f"Query intent '{intent}' is not yet implemented.",
            "table": {"columns": [], "rows": []},
            "chart": None,
            "ui_action": None
        }


def _execute_help(spec):
    err = spec.get('_error')
    text = (
        "**AI Query Assistant Help**\n\n"
        "You can ask natural language questions about OTR and MPS data:\n"
        "- **OTR Breaches**: *'Show breaches above 2000 in NSE FO yesterday'*\n"
        "- **Top Dealers**: *'Top 10 dealers by OTR in BSE CM'*\n"
        "- **Consecutive Breaches**: *'Dealers with breaches for 5 consecutive days'*\n"
        "- **Peak Message Rate**: *'Peak MPS on Greek yesterday'*\n"
        "- **MPS Trend**: *'MPS timeseries for NSE FO today'*\n"
        "- **Dealer Search**: *'Breaches for dealer D101'*\n"
    )
    if err:
        text += f"\n\n*Notice: {err}*"
    return {
        "intent": "help",
        "summary": text,
        "table": {"columns": [], "rows": []},
        "chart": None,
        "ui_action": None
    }


def _execute_otr_snapshot(spec, cfg, scope):
    server_ip = spec.get('server_ip')
    date = spec.get('date_to') or spec.get('date_from')
    exchange = spec.get('exchange')
    segment = spec.get('segment')
    threshold = spec.get('threshold') or cfg.get('otr_threshold', 2000.0)
    dealer = spec.get('dealer')
    top_n = spec.get('top_n', 20)
    intent = spec.get('intent')

    try:
        scan = otr.scan_otr(cfg)
    except OSError as e:
        return {
            "intent": intent,
            "summary": f"Could not read OTR data directory (`{cfg.get('otr_dir')}`): {e}",
            "table": {"columns": [], "rows": []},
            "chart": None,
            "ui_action": None
        }

    # If server_ip was not specified or not in scan, pick first available server
    if (not server_ip or server_ip not in scan) and scan:
        server_ip = sorted(scan.keys())[0]

    days_map = scan.get(server_ip, {})
    if not days_map:
        return {
            "intent": intent,
            "summary": f"No OTR data found for server {spec.get('server_name') or server_ip}.",
            "table": {"columns": [], "rows": []},
            "chart": None,
            "ui_action": None
        }

    # Find matching date or nearest previous date
    sorted_days = sorted(days_map.keys(), reverse=True)
    target_date = date if date in days_map else None
    if not target_date:
        # Pick the most recent available date
        target_date = sorted_days[0]

    times = days_map.get(target_date, [])
    if not times:
        return {
            "intent": intent,
            "summary": f"No snapshot files found for date {target_date}.",
            "table": {"columns": [], "rows": []},
            "chart": None,
            "ui_action": None
        }

    latest_time = spec.get('time') or times[0]
    read_res = otr.read_otr(cfg, server_ip, target_date, latest_time, scope)
    if read_res.get('error'):
        return {
            "intent": intent,
            "summary": f"Error reading snapshot: {read_res['error']}",
            "table": {"columns": [], "rows": []},
            "chart": None,
            "ui_action": None
        }
    if read_res.get('missing'):
        return {
            "intent": intent,
            "summary": f"Snapshot file {read_res.get('file', '')} is missing.",
            "table": {"columns": [], "rows": []},
            "chart": None,
            "ui_action": None
        }

    rows = read_res.get('rows', [])
    # Row format: [user, token, symbol, series, opt_type, strike, expiry, orders, trades, otr, exchange, segment]
    # Filter by exchange, segment, dealer
    filtered = []
    for r in rows:
        if exchange and r[10] != exchange:
            continue
        if segment and r[11] != segment:
            continue
        if dealer and not (r[0] == dealer or r[0].startswith(dealer)):
            continue
        filtered.append(r)

    cols = ["Dealer", "Symbol", "Orders", "Trades", "OTR", "Exch/Seg"]

    if intent == 'otr_summary':
        total_orders = sum(r[7] for r in filtered)
        total_trades = sum(r[8] for r in filtered)
        overall_otr = round(total_orders / total_trades, 2) if total_trades > 0 else total_orders
        breaches_cnt = sum(1 for r in filtered if r[9] > threshold)
        summary_text = (
            f"**OTR Summary for {target_date} ({latest_time})**\n\n"
            f"- Total Records: **{len(filtered):,}**\n"
            f"- Total Orders: **{total_orders:,}**\n"
            f"- Total Trades: **{total_trades:,}**\n"
            f"- Overall OTR: **{overall_otr:,}**\n"
            f"- Breaches (> {threshold}): **{breaches_cnt:,}**"
        )
        # Top 5 symbols by breach
        sym_counts = defaultdict(int)
        for r in filtered:
            if r[9] > threshold:
                sym_counts[r[2]] += 1
        top_syms = sorted(sym_counts.items(), key=lambda x: x[1], reverse=True)[:5]
        chart = {
            "type": "pie",
            "title": f"Breaches by Symbol (> {threshold})",
            "data": {
                "labels": [s[0] for s in top_syms],
                "values": [s[1] for s in top_syms]
            }
        } if top_syms else None

        return {
            "intent": intent,
            "summary": summary_text,
            "table": {"columns": [], "rows": []},
            "chart": chart,
            "ui_action": {
                "view": "otr",
                "server": server_ip,
                "exchange": exchange or "",
                "segment": segment or "",
                "date": target_date,
                "threshold": threshold
            }
        }

    # Intent is otr_breaches or otr_top
    if intent == 'otr_breaches':
        breach_rows = [r for r in filtered if r[9] > threshold]
        breach_rows.sort(key=lambda r: r[9], reverse=True)
        display_rows = breach_rows[:top_n]
        count_total = len(breach_rows)
        summary_text = (
            f"Found **{count_total:,}** breaches with OTR > **{threshold}** on **{target_date}** "
            f"({latest_time}) for server **{spec.get('server_name') or server_ip}**."
        )
    else:  # otr_top
        filtered.sort(key=lambda r: r[9], reverse=True)
        display_rows = filtered[:top_n]
        count_total = len(filtered)
        summary_text = (
            f"Top **{len(display_rows)}** records by OTR on **{target_date}** "
            f"({latest_time}) for server **{spec.get('server_name') or server_ip}**."
        )

    table_data = []
    for r in display_rows:
        table_data.append([
            r[0],                    # dealer
            r[2],                    # symbol
            f"{r[7]:,}",             # orders
            f"{r[8]:,}",             # trades
            f"{r[9]:.2f}",           # otr
            f"{r[10]} {r[11]}"       # exchange segment
        ])

    # Top dealer chart (bar chart)
    chart = None
    if display_rows:
        chart_items = display_rows[:8]
        chart = {
            "type": "bar",
            "title": f"Top OTR on {target_date}",
            "data": {
                "labels": [f"{r[0]} ({r[2]})" for r in chart_items],
                "values": [round(r[9], 1) for r in chart_items]
            }
        }

    ui_action = {
        "view": "otr",
        "server": server_ip,
        "exchange": exchange or "",
        "segment": segment or "",
        "date": target_date,
        "threshold": threshold
    }

    return {
        "intent": intent,
        "summary": summary_text,
        "table": {"columns": cols, "rows": table_data},
        "chart": chart,
        "ui_action": ui_action
    }


def _execute_otr_consecutive(spec, cfg, scope):
    """Find dealers that breached threshold for N consecutive days."""
    server_ip = spec.get('server_ip')
    threshold = spec.get('threshold') or cfg.get('otr_threshold', 2000.0)
    consecutive_days = spec.get('days', 5)
    exchange = spec.get('exchange')
    segment = spec.get('segment')

    try:
        scan = otr.scan_otr(cfg)
    except OSError as e:
        return {
            "intent": "otr_consecutive",
            "summary": f"Could not read OTR data directory (`{cfg.get('otr_dir')}`): {e}",
            "table": {"columns": [], "rows": []},
            "chart": None,
            "ui_action": None
        }

    if (not server_ip or server_ip not in scan) and scan:
        server_ip = sorted(scan.keys())[0]

    days_map = scan.get(server_ip, {})
    all_dates = sorted(days_map.keys(), reverse=True)

    if len(all_dates) < consecutive_days:
        return {
            "intent": "otr_consecutive",
            "summary": f"Only {len(all_dates)} days of data available; requested {consecutive_days} consecutive days.",
            "table": {"columns": [], "rows": []},
            "chart": None,
            "ui_action": None
        }

    target_window = all_dates[:consecutive_days]
    target_window.reverse()  # oldest to newest

    # Set of breaching dealers per day
    daily_breachers = []
    for d in target_window:
        times = days_map[d]
        read_res = otr.read_otr(cfg, server_ip, d, times[0], scope)
        rows = read_res.get('rows', [])
        breachers = set()
        for r in rows:
            if exchange and r[10] != exchange:
                continue
            if segment and r[11] != segment:
                continue
            if r[9] > threshold:
                breachers.add(r[0])
        daily_breachers.append((d, breachers))

    # Intersection of dealers breaching on all days
    common_dealers = set(daily_breachers[0][1])
    for _, breachers in daily_breachers[1:]:
        common_dealers &= breachers

    summary_text = (
        f"Found **{len(common_dealers)}** dealer(s) with OTR breaches (> **{threshold}**) "
        f"for **{consecutive_days} consecutive days** between **{target_window[0]}** and **{target_window[-1]}**."
    )

    cols = ["Dealer", f"Consecutive Days ({consecutive_days})", "Status"]
    table_rows = []
    for dlr in sorted(common_dealers):
        table_rows.append([dlr, str(consecutive_days), "Breached All Days"])

    chart = None
    if daily_breachers:
        chart = {
            "type": "line",
            "title": f"Breaching Dealers per Day (> {threshold})",
            "data": {
                "labels": [d[0] for d in daily_breachers],
                "values": [len(d[1]) for d in daily_breachers]
            }
        }

    return {
        "intent": "otr_consecutive",
        "summary": summary_text,
        "table": {"columns": cols, "rows": table_rows},
        "chart": chart,
        "ui_action": {
            "view": "otr",
            "server": server_ip,
            "exchange": exchange or "",
            "segment": segment or "",
            "threshold": threshold,
            "date": target_window[-1]
        }
    }


def _execute_mps_peak(spec, cfg, scope):
    server_ip = spec.get('server_ip')
    exchange = spec.get('exchange') or 'NSE'
    segment = spec.get('segment') or 'FO'
    date = spec.get('date_to') or spec.get('date_from')

    if scope is not None:
        scope.require(server_ip, exchange, segment)

    try:
        path, fname = data.resolve(cfg, server_ip, date, exchange, segment)
    except data.BadRequest as e:
        return {
            "intent": "mps_peak",
            "summary": f"Could not locate report: {e}",
            "table": {"columns": [], "rows": []},
            "chart": None,
            "ui_action": None
        }

    if not os.path.isfile(path):
        return {
            "intent": "mps_peak",
            "summary": f"No MPS data file found for {server_ip} {exchange} {segment} on {date}.",
            "table": {"columns": [], "rows": []},
            "chart": None,
            "ui_action": None
        }

    max_count = 0
    max_ts = ""
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        for line in f:
            parts = line.strip().split(',')
            if len(parts) >= 2:
                try:
                    cnt = float(parts[0])
                    if cnt > max_count:
                        max_count = cnt
                        max_ts = parts[1]
                except ValueError:
                    continue

    summary_text = (
        f"**Peak MPS for {exchange} {segment} on {date}**\n\n"
        f"- Server: **{spec.get('server_name') or server_ip}**\n"
        f"- Peak Rate: **{max_count:,.0f}** messages/sec\n"
        f"- Timestamp: **{max_ts}**"
    )

    return {
        "intent": "mps_peak",
        "summary": summary_text,
        "table": {
            "columns": ["Metric", "Value"],
            "rows": [
                ["Server", spec.get('server_name') or server_ip],
                ["Exchange / Segment", f"{exchange} {segment}"],
                ["Peak MPS", f"{max_count:,.0f}"],
                ["Timestamp", max_ts]
            ]
        },
        "chart": None,
        "ui_action": {
            "view": "mps",
            "server": server_ip,
            "exchange": exchange,
            "segment": segment,
            "date": date
        }
    }


def _execute_mps_timeseries(spec, cfg, scope):
    server_ip = spec.get('server_ip')
    exchange = spec.get('exchange') or 'NSE'
    segment = spec.get('segment') or 'FO'
    date = spec.get('date_to') or spec.get('date_from')

    if scope is not None:
        scope.require(server_ip, exchange, segment)

    try:
        path, fname = data.resolve(cfg, server_ip, date, exchange, segment)
    except data.BadRequest as e:
        return {
            "intent": "mps_timeseries",
            "summary": f"Could not locate report: {e}",
            "table": {"columns": [], "rows": []},
            "chart": None,
            "ui_action": None
        }

    if not os.path.isfile(path):
        return {
            "intent": "mps_timeseries",
            "summary": f"No MPS data file found for {server_ip} {exchange} {segment} on {date}.",
            "table": {"columns": [], "rows": []},
            "chart": None,
            "ui_action": None
        }

    # Aggregate by hour
    hourly = defaultdict(list)
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        for line in f:
            parts = line.strip().split(',')
            if len(parts) >= 2:
                try:
                    cnt = float(parts[0])
                    ts = parts[1].strip()
                    if len(ts) >= 13:
                        hour = ts[11:13] + ":00"
                        hourly[hour].append(cnt)
                except ValueError:
                    continue

    hours = sorted(hourly.keys())
    chart = None
    table_rows = []
    if hours:
        avg_values = [round(sum(hourly[h]) / len(hourly[h]), 1) for h in hours]
        max_values = [round(max(hourly[h]), 1) for h in hours]
        for h, avg_val, max_val in zip(hours, avg_values, max_values):
            table_rows.append([h, f"{avg_val:,.1f}", f"{max_val:,.0f}"])

        chart = {
            "type": "line",
            "title": f"MPS Average Rate by Hour ({exchange} {segment})",
            "data": {
                "labels": hours,
                "values": avg_values
            }
        }

    summary_text = f"Hourly MPS breakdown for **{exchange} {segment}** on **{date}**."
    return {
        "intent": "mps_timeseries",
        "summary": summary_text,
        "table": {
            "columns": ["Hour", "Avg MPS", "Peak MPS"],
            "rows": table_rows
        },
        "chart": chart,
        "ui_action": {
            "view": "mps",
            "server": server_ip,
            "exchange": exchange,
            "segment": segment,
            "date": date
        }
    }
