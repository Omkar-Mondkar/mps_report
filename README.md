# MPS Graph

Multi-dashboard viewer for **messages per second** (MPS) CSV files. It runs on the
server that holds the files (no ssh needed) and serves one web page with three
synchronized, zoomable charts: **line**, **bar** and **heatmap**.

Pick **Server -> Exchange -> Segment -> Date -> Interval** in the UI. The program translates the
selection into a file name, checks that the file exists, and shows the dashboard.
Files that are still being written are tailed live.

A closable **menu** (the button at the top left) switches between two reports: **MPS Report** (the
dashboard and Compare described above) and **OTR Report** (dealer-wise order-to-trade snapshots,
see [OTR Report](#otr-report)).

Standard library only. Python 3.6+. No `pip install`, no CDN: it works offline.

## Quick start

```bash
cd /path/to/MPS_Graph
python3 mps_graph.py --dir /else/home/oaa/MsgRatioPerSec --host 0.0.0.0 --port 8000
```

Open `http://<server>:8000/`.

By default it binds to `127.0.0.1` only. To keep it private, leave the default and use
an SSH tunnel from your PC instead of `--host 0.0.0.0`:

```bash
ssh -L 8000:127.0.0.1:8000 user@server      # then browse http://127.0.0.1:8000/
```

Run it in the background:

```bash
nohup python3 mps_graph.py --host 0.0.0.0 --port 8000 > mps_graph.log 2>&1 &
```

## Files

```
MPS_Graph/
  mps_graph.py        HTTP server and API (entry point)
  mps_data.py         config, file discovery, name resolution, tailing
  otr_data.py         OTR report: config keys, snapshot discovery, reading, exchange/segment of a token
  mps_access.py       command line for managing access on the server (users, roles, groups, grants, audit)
  auth/               everything about access control
    config.py         the optional `auth` settings of config.json
    store.py          SQLite store: users, roles, groups, grants, audit log
    scope.py          the one "may this user see this?" decision used by every data path
    password.py       scrypt password hashing and the password rules
    session.py        signed session cookies and the signing key
    limit.py          sign-in attempt limiter and the client address rule
    web.py            sign-in, sign-out, /api/me, audit hooks, --create-superadmin, start-up report
    admin.py          management rules (safeguards, import, audit reading), shared by the screens and the CLI
    adminapi.py       the /api/admin/* routes of the Access view
    cli.py            the commands of mps_access.py
  config.json         settings (optional, loaded automatically if present)
  web/
    index.html
    login.html        sign-in page (only used when access control is on)
    css/style.css
    js/session.js     requests with sign-in handling (401 -> sign-in page), /api/me
    js/login.js       sign-in page script
    js/widgets.js     animated dropdown component
    js/charts.js      chart engine (line / bar / heatmap, zoom, cards)
    js/app.js         MPS view: selectors, file check, loading and live polling
    js/compare.js     report comparison view (statistics core + overlay / hourly charts)
    js/peaks.js       message-rate search syntax parser (shared by dashboard and Compare)
    js/shell.js       header, menu and view switching (address and menu rules)
    js/otr.js         OTR view (analytics core + page)
    js/access.js      Access view (people, groups, roles, audit log; only for SuperAdmin)
tests/
  compare.test.js     node tests/compare.test.js   (comparison statistics)
  peaks.test.js       node tests/peaks.test.js     (rate search parser)
  shell.test.js       node tests/shell.test.js     (address and menu rules, who may open what)
  session.test.js     node tests/session.test.js   (401 / 403 handling, /api/me)
  otr.test.js         node tests/otr.test.js       (OTR analytics, filters, snapshot choice)
  access.test.js      node tests/access.test.js    (Access view: tabs, grant wording, dealer rule, import summary)
  test_reports.py     python -m unittest discover -s tests   (file names, config, reports API)
  test_otr.py         same command (OTR config, discovery, parsing, API)
  test_auth_*.py      same command (access control: config, store, scope, data filtering,
                      passwords/sessions, the server in off / audit / enforce mode, the
                      management rules, the /api/admin routes and mps_access.py)
  load_poll.py        python tests/load_poll.py    (polling load: latency and CPU, see Capacity)
  load_admin.py       python tests/load_admin.py   (polling while administering a large database)
```

Upload the whole folder; the `web/` directory must stay next to `mps_graph.py`.

## Input file format

One sample per line: `<messages>,<YYYY-MM-DD HH:MM:SS>`

```
99,2026-10-13 15:37:25
101,2026-10-13 15:37:26
```

Header or malformed lines are skipped. Timestamps are shown exactly as written
(no timezone conversion).

## File name translation

Default pattern (set in `config.json`):

```
MPS_Greek_{ip}_{exchange}_{segment}_{date}.csv        date format: %d%m%Y
```

| UI selection                          | File looked up                                  |
| ------------------------------------- | ----------------------------------------------- |
| `server_ip`, NSE, CM, 13 Oct 2026     | `<dir>/MPS_Greek_server_ip_NSE_CM_13102026.csv` |
| `server_ip`, Unspecified, 13 Oct 2026 | `<dir>/MPS_Greek_server_ip_13102026.csv`        |

`{exchange}` and `{segment}` are upper-case letter codes (for example `NSE`, `BSE`, `CM`, `FO`, `CD`).
Files written before segments existed (`MPS_Greek_{ip}_{date}.csv`, set with `legacy_filename`) are
still listed, as the **Unspecified** segment. Backup copies such as `<name>.csv_101500` do not end in
`.csv` and are ignored. The new pattern is tried first, so `10.0.0.1_NSE_CM` is never read as an IP.

An older `config.json` whose `filename` is `MPS_Greek_{ip}_{date}.csv` still works: that name is
treated as the old-file pattern, the new pattern is used for segment files, and a notice is printed
at start-up.

If the file is missing, the page shows a "file not found" panel with the exact name
and directory that were checked, plus one-click suggestions for the nearest available
dates. If it is today's file and is created later, the page picks it up automatically.

## Configuration

`config.json` (all keys optional; defaults shown by the shipped file):

| Key                  | Meaning                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `title`              | Heading shown in the page                                                                                                                                                                                          |
| `dir`                | Directory containing the CSV files                                                                                                                                                                                 |
| `filename`           | Name template; must contain `{ip}`, `{exchange}`, `{segment}` and `{date}` once each, and no `/` or `\`                                                                                                            |
| `legacy_filename`    | Template for files without exchange and segment (default `MPS_Greek_{ip}_{date}.csv`); `null` hides them                                                                                                           |
| `exchanges`          | Optional `[{"code": "NSE", "name": "NSE"}, ...]`: order and display names (default NSE, BSE)                                                                                                                       |
| `segments`           | Optional `[{"code": "CM", "name": "Cash"}, ...]`: order and display names (default CM, FO, CD)                                                                                                                     |
| `date_format`        | `strftime` format of `{date}` in the file name (default `%d%m%Y`)                                                                                                                                                  |
| `servers`            | Optional friendly names: `[{"name": "Greek A", "ip": "server_ip"}]`                                                                                                                                                |
| `interval_ms`        | How often the browser polls for new data (default 1000, minimum 200)                                                                                                                                               |
| `otr_dir`            | Directory with the OTR snapshot files (default `/home/oaa/Greek_Prod_OTR_Data`)                                                                                                                                    |
| `otr_filename`       | OTR file name template; must contain `{ip}`, `{date}` and `{time}` (`HHMMSS`) once each and no `/` or `\` (default `DealerWise_Order_Trade_Report_{ip}_{date}_{time}.csv`); `{date}` uses `date_format`            |
| `otr_threshold`      | Default "high OTR" threshold, a number of 0 or more (default 2000)                                                                                                                                                 |
| `otr_max_bytes`      | Largest OTR file that is read, in bytes (default 67108864 = 64 MB)                                                                                                                                                 |
| `otr_token_prefixes` | Leading digits of `lourtoken` -> exchange and segment, e.g. `{"101": "NSE_CM", "102": "NSE_FO", "50": "NSE_CD", "201": "BSE_CM", "202": "BSE_FO"}` (the longest matching prefix wins; others are shown as Unknown) |

Servers found in the directory but not listed in `servers` are still offered
(labelled with their IP), and so are exchanges and segments that are in the files but not in the
lists above (labelled with their code, after the configured ones). The server list is rediscovered
every minute, so new servers and new daily files show up without a restart.

### Access control settings

The optional `auth` object turns on sign-in and per-user access (see [Access control](#access-control)).
Without it, or with `"mode": "off"`, nothing changes: no sign-in, no filtering.

| Key (inside `auth`) | Meaning                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`              | `off` (default), `audit` (nobody blocked; what `enforce` would refuse is logged) or `enforce`                                                                 |
| `public_url`        | Address users type, with the proxy prefix, e.g. `http://host/mps/`. Required unless the mode is `off`. Cookie path, allowed origin and redirects come from it |
| `db`                | SQLite file holding users, roles, groups, grants and the audit log (default `mps_access.db` next to `config.json`)                                            |
| `key_file`          | File holding the key that signs session cookies (default `<db>.key`; created on first use, owner-only)                                                        |
| `session_hours`     | How long a sign-in lasts, a number above 0 and up to 720 (default 12)                                                                                         |

### Command-line options

| Option                      | Meaning                                                |
| --------------------------- | ------------------------------------------------------ |
| `--dir PATH`                | Data directory (overrides `config.json`)               |
| `--config FILE`             | Use another config file                                |
| `--host ADDR`               | Bind address (default `127.0.0.1`)                     |
| `--port N`                  | Port (default `8000`)                                  |
| `--interval MS`             | Poll interval (overrides `config.json`)                |
| `--auth-mode M`             | `off`, `audit` or `enforce` (overrides `auth.mode`)    |
| `--create-superadmin LOGIN` | Create a SuperAdmin (or reset its password), then exit |

## Using the UI

### Menu and views

The button at the top left (or the **x** inside the menu) opens and closes the menu. **MPS Report**
and **OTR Report** each keep their own selection. Choosing **MPS Report** shows the whole
dashboard exactly as before; while **OTR Report** is shown the MPS page stops polling for data, and it
resumes when you come back. Escape closes the menu; on a narrow window the menu opens over the page.
The menu state is remembered in the browser. The address records the view (`#v=otr&...` for OTR, no `v`
for MPS), so a refresh keeps the view and links from before the menu existed still open the MPS Report.

### MPS Report

- **Exchange** and **Segment**: only the exchanges and segments that have files for the chosen server
  (a selector with one choice is shown disabled). Changing the exchange keeps the segment when the new
  exchange has it, otherwise the first one. **Unspecified** appears only for servers with old-style
  files. Exactly one report is shown at a time; segments are never added together.
- **Date**: date picker with previous/next buttons that jump to the nearest day that has a file for
  the chosen segment.
- **Interval**:
  - _Last 5 min / 15 min / 30 min / 1 hour / 4 hours_: window ending at the latest sample
    (keeps following new data on live files)
  - _Full day_
  - _Market hours_ (09:15-15:30)
  - _Custom..._ with From / To time inputs
- **Status pill / file chip**: LIVE, IDLE, PAUSED, FILE NOT FOUND, plus the file name, size and
  last-modified time.
- **Pause / Follow latest / Reset view**: freeze polling; jump back to the newest sample; go back
  to the selected interval.
- **Find a message rate**: type a rate to list every sample in the visible window with that value.
  Accepted forms: an exact rate (`150`), an inclusive range (`100-200`) or a comparison (`>150`,
  `>=150`, `<50`, `<=50`); spaces and thousands commas are ignored. The result shows the exact count
  and the searched time range, then the matching times in ascending order (200 at a time, with a
  button to show more). Click a time to centre the charts on it and mark it. The search follows the
  visible window (zoom, pan, interval) and re-runs as new samples arrive on a live file. Clicking a
  result moves the charts without narrowing the window, so the list stays as it was until you zoom,
  pan or change the interval. The box is cleared when you
  change server or date. The dashboard counts samples; Compare counts distinct seconds (they are the
  same for files with one sample per second).

Your selection is saved in the URL hash (`s`, `x`, `g`, `d`, `i`) and in the browser, so a refresh
restores it and a link can be shared. Links from before segments existed (`s` and `d` only) open the
first available segment.

### Comparing reports

Click **Compare** in the MPS Report toolbar to compare two to six reports (a report is one server, one exchange
and segment, on one date).
The button becomes **Back to dashboard**; live polling of the dashboard is paused while comparing.

- **Reports** picker: tick any combination of reports, grouped by server and segment. Filter with
  the text box (server, segment code or date) and the **All exchanges** / **All segments** selects.
  Shortcuts: per-group **Last 3** / **Last 6** days (one server and segment), and **Same date, all
  listed servers...**, which acts on the reports left after filtering (set Segment to FO first to
  compare the FO reports of every server for one day). Reports are labelled
  `Greek A · NSE CM · 2026-10-13`. A seventh report is refused with a message; untick one first.
- **Interval**: _Full day_, _Market hours_ (09:15-15:30) or _Custom..._ (From / To). Statistics, the
  overlay chart and the hourly chart all use the chosen interval.
- **Overlay chart**: one line per report on a shared time-of-day axis (so different dates line up).
  Wheel zooms, drag pans, **Reset zoom** restores the interval. Click a legend entry to hide or show
  a series. Zoomed out, each line shows the average with a min-max band.
- **Summary table**: samples, average, min, peak, the time it happened, how many times it happened
  (**Count**), 95th percentile and total messages per report. The Peak, Peak at and Count columns
  are highlighted. The **Base** radio picks the baseline (default: first selected report);
  the Δ columns show the absolute and percent change of average, peak and total against it.
  Percent is shown as n/a when the baseline value is 0.
- **Multiple peaks**: **Count** is the number of distinct seconds (within the chosen interval) at
  which the peak value was reached. When it is more than 1, **Peak at** shows the earliest time and
  a **+N more** button that lists every time in ascending order. Click a time to mark that moment on
  the overlay chart (the mark is cleared when you change the reports or the interval).
- **Find a message rate**: the same search syntax as the dashboard, run on every selected report within
  the chosen interval (for example Market hours searches only 09:15-15:30). Each report shows its
  match count, first and last matching time and a **show times** button for the full list (200 at a
  time). Click a time to mark it on the overlay chart. Reports that are still loading or unavailable,
  or have no samples in the interval, are labelled as such instead of showing 0.
- **Hourly chart**: average messages per second per hour, grouped by report.
- **Refresh** reloads the file list and all selected reports. Reports are a snapshot taken when
  loaded, so a report for a live (today) file does not update by itself; click **Refresh** to reload it.
- Times are compared as written in the files (no timezone conversion), so reports from servers in
  different timezones are aligned by their own clock time.

The selection is stored in the URL hash (`#m=cmp&c=<ip>@<date>[@<EXCH_SEG>],...`, for example
`10.0.0.1@2026-10-13@NSE_CM`; the old form `<ip>@<date>` still means the old-style file) and in the
browser, so a refresh restores it and the link can be shared. Reports that no longer exist are dropped silently; a report
whose file cannot be read is listed as unavailable and the others are still compared.

### Charts

- **Line** and **Bar** show messages per second. When zoomed out, samples are grouped; the line
  chart then shows an average line with a min-max band, the bar chart an average bar with a faint max bar.
- **Heatmap**: one column per minute, one row per second of the minute, colour = messages per second
  (dark = low, yellow = high). Use it to spot bursts and quiet periods at a glance.
- Mouse wheel zooms at the cursor, drag pans, Shift+wheel pans, double-click shows the full range.
  All three charts share one time axis. Hovering one chart highlights the same moment in the others.

### Metric cards

- **Latest**, **Window peak** and **Overall peak** are clickable and jump to that sample, with a marker
  on all charts for a few seconds. The overall peak card is highlighted.
- **Repeated peaks**: when the peak value occurred more than once, the card shows the count (for
  example "Overall peak x3": Window peak counts the visible window, Overall peak the whole loaded
  day) and the hint "Click for next peak". Each click (or Enter / Space) jumps to the next occurrence in
  time order, shows "Next peak (k of N)" and wraps from the last occurrence to the first. Zooming,
  panning, changing the interval, picking another card, or new samples arriving restarts the sequence.
  A peak that occurred once behaves as before.
- Window avg / total, overall avg, total messages and sample count update with the visible window.

## OTR Report

Choose **OTR Report** in the menu to read the dealer-wise order and trade snapshots written by the
report job, for example
`/home/oaa/Greek_Prod_OTR_Data/DealerWise_Order_Trade_Report_10.0.0.1_15102026_150000.csv`:

```
user,lourtoken,symbol,series,opt_type,strike,Expiry_date,sum(gorder),sum(trade),otr
USER1,102035747,NIFTY,OPTIDX,PE,30000.0000000,2001-12-28 14:30:00,2,0,2
USER1,102033206,NIFTY,OPTIDX,CE,23000.0000000,2012-12-29 14:30:00,100,89,1.1236

```

Every file is one finished snapshot (nothing is tailed). `otr` is orders divided by trades; the file
value is used for each row.

- **Server / Date / Time**: pick a snapshot; the newest one is chosen by default, and choosing a server
  or date selects its newest snapshot. The **Server** dropdown (here and in the MPS Report) has a search
  box: type part of a server name or IP (several words must all match). The **Date** works like the MPS
  Report one: `‹` / `›` step to the previous / next date that has snapshots, and the calendar can pick
  any date; a date without snapshots shows "No OTR snapshots for ..." with the nearest dates to jump
  to. **Refresh** reloads the file list and the snapshot. The list is
  also refreshed every minute while the view is open; if a newer snapshot of the chosen date appears a
  notice offers it (the view never switches snapshot by itself). The file chip shows the file name,
  size, when it was generated, the number of rows and how many bad lines were skipped.
- **Highlight OTR above**: threshold, default 2000 (`otr_threshold`), saved in the browser. A row or
  group is **high** when its OTR is strictly above it (2000 is not high; 2000.0001 is). Highs are
  shown in red **and** with a `HIGH` badge. A bad entry keeps the previous threshold and shows an error.
- **Summary cards**: rows, dealers, contracts (distinct tokens), total orders and trades, overall OTR,
  rows above the threshold (count and share), the share of all orders those rows carry, and the
  highest row OTR. Every card follows the filters.
- **Filters**: User, Exchange, Segment, Series, Option type, a text search (user, symbol or token),
  **only above threshold** and **Clear filters**. They apply to every card, table and chart on the page.
  Exchange and segment come from the leading digits of `lourtoken` (`otr_token_prefixes`); tokens
  with an unknown prefix are listed as **Unknown**.
- **Breakdowns**: by dealer, symbol, exchange and segment, series and option type, and expiry (top 10
  by default, **Show all**, sortable headers). The OTR of a group is its total orders divided by its
  total trades, not the average of its rows' OTR. A group with no trades shows its orders as the OTR
  and a `no trades` badge. Click a name to filter the whole report to it (symbol and expiry filters
  appear as removable chips).
- **OTR distribution**: bars of how many rows (and orders) fall in each band: up to 1, 1 - 2, 2 - 10,
  10 - 100, 100 - threshold and above the threshold.
- **Top 10** rows by OTR and by orders, and the **Rows** table (sortable, 100 per page, default OTR
  descending, `Rows 1-100 of 25,000`).
- When there are no files, the page names the directory and the file pattern it looked for; a missing
  or unreadable snapshot is reported with the file name and the nearest available snapshots.

The selection is stored in the URL hash (`#v=otr&os=<ip>&od=<YYYY-MM-DD>&ot=<HHMMSS>`) and in the
browser. The page uses plain JavaScript (no framework or build step) so it keeps working offline from
the single folder; the menu is a small shell (`shell.js`) and each report is a module with its own
tested logic.

## Access control

Optional sign-in with per-user access. It is **off by default**: without an `auth` section (or with
`"mode": "off"`) there is no sign-in, nothing is filtered and the program behaves exactly as before.

### Modes

| Mode      | What happens                                                                                                                                                                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`     | No sign-in, no filtering (default).                                                                                                                                                                                                                |
| `audit`   | Nobody is blocked or filtered. People may sign in; what `enforce` would have refused or narrowed is written to the audit log (`would_deny`, `would_narrow`). Use it to check the rules before they bite.                                           |
| `enforce` | Sign-in is required. Pages redirect to the sign-in page, API calls answer 401 without a session and 403 (`Access denied`) outside the user's access. If the access store cannot be read the server refuses requests (it never falls back to open). |

Set it in `config.json` (`auth.mode`, see [Access control settings](#access-control-settings)) or for one run with
`--auth-mode`.

### Roles and what a user can see

- **SuperAdmin**: sees everything and is the only role that manages access (the **Access** view, see
  [Managing access](#managing-access)).
- **Admin**: sees everything (all servers, exchanges, segments, dealers), cannot manage access.
- **User**: sees only what has been granted to them.
- A **grant** is `server, exchange, segment, dealer`; each part is a value or `*`. For example
  `10.0.0.1, NSE, FO, *` is "NSE F&O on 10.0.0.1"; `*, NSE, *, DESK1*` is "dealers starting with `DESK1` on
  NSE, any server". The **dealer** is `*`, an exact user id, or a prefix ending in `*` (`DESK1*` matches
  `DESK1` and `DESK12`, not `DESK` or `XDESK1`). A user's access is the union of their grants and
  those of their roles and groups.
- The dealer part only narrows the **OTR Report** (rows of other dealers are removed, and so are the
  counts and totals made from them). MPS files are per server, exchange and segment, so MPS access
  depends on those three.
- Files without exchange and segment in the name (and OTR tokens whose exchange is unknown) are
  visible only with a grant whose exchange and segment are both `*`.
- A user who is signed in but has no grants sees an **Access pending** page. Menu entries a user has
  nothing to show in are hidden. A limited user is not told the data directory or file name patterns.
- A request for something outside a user's access (for example a direct URL) gets the same `403` whether
  or not the file exists, so file names cannot be probed.
- Changes made in the store apply on the user's next request (within about a second). Disabling a user,
  changing their password, or signing out ends their sessions.

### First SuperAdmin

Run this on the server (it only touches the access database, so the dashboard may be running or stopped):

```bash
python3 mps_graph.py --create-superadmin alice          # prompts twice for a password (10+ characters)
```

It creates the SuperAdmin `alice`, or resets that user's password and ends their old sessions if they
already exist. It writes an audit entry. Everyone else is added in the Access view or with
`mps_access.py` (see [Managing access](#managing-access)).

### Setting it up

1. Add to `config.json`:

   ```json
   "auth": {
     "mode": "audit",
     "public_url": "http://your-host/mps/",
     "db": "/var/lib/mps_graph/mps_access.db",
     "session_hours": 12
   }
   ```

   `public_url` is the address users type, **with the proxy prefix**. It decides the cookie path, the
   allowed `Origin` of sign-in requests and where redirects go, so it must be exact. `db` should be
   outside the web folder and writable by the user that runs the program; the signing key for session
   cookies is created next to it (`<db>.key`, owner-only) unless you set `key_file`, or put the key in the
   environment variable `MPS_SESSION_KEY` (at least 32 characters; it wins over the file). Keep the key
   private: anyone who has it can forge a session. The key and the database files must not be
   in a place that is served or backed up to untrusted storage.

2. Create the first SuperAdmin (above) and start the server. The start-up lines show the mode, the store,
   and warnings (see below).
3. Roll out in this order: `off` (today) -> `audit` (people sign in, nothing is blocked, review the
   `would_deny` / `would_narrow` entries) -> `enforce`.
4. **Roll back** by setting `"mode": "off"` (or starting with `--auth-mode off`) and restarting. The
   database is kept; nothing else changes.

Start-up warnings you may see: plain-HTTP `public_url` that is not `localhost` (the session cookie then
goes without the `Secure` flag and the password crosses the network in clear text), `enforce` with no
SuperAdmin yet, and listening on an address other than loopback (anyone who can reach the
port bypasses the proxy). Access control refuses to start when Python has no `hashlib.scrypt` (it needs
OpenSSL 1.1 or newer).

### Behind Apache (or another reverse proxy)

```
ProxyPass        /mps/ http://127.0.0.1:8008/
ProxyPassReverse /mps/ http://127.0.0.1:8008/
```

Start the program with `--host 127.0.0.1 --port 8008` so that the proxy is the only way in. The proxy strips
`/mps/`, which is why `public_url` carries it. `mod_proxy` adds `X-Forwarded-For`; the program uses
it for audit entries and for the sign-in limiter **only when the request comes from the local machine**
(and takes the last entry, the one the proxy added), so a client cannot fake its address.

**HTTPS is strongly recommended** (Apache `mod_ssl`, `public_url` starting with `https://`, which also
turns on the `Secure` cookie flag) but it is not required: plain HTTP works and prints the warning above.
Without HTTPS anyone on the network path can read passwords and session cookies.

### Sign-in rules

- Sign-in needs the user id and password; wrong password, unknown user and disabled user all give the
  same message. After 5 failures for one user id (or many from one address) further attempts are
  refused with a growing wait (30 s up to 15 min) that ends by itself.
- Passwords are stored as scrypt hashes (never in plain text, never in logs or the audit log).
  A signed-in user can change their own password; that ends their other sessions.
- The session is a signed cookie (`HttpOnly`, `SameSite=Lax`, limited to the `public_url` path,
  `Secure` for HTTPS). Sign-out ends it at once on this server (the list of signed-out sessions is
  kept in memory, so it is forgotten at a restart; a cookie then still works until its own expiry
  unless the user was disabled or changed their password).
- State-changing requests (`/auth/*`) must be `POST` with JSON, the header `X-MPS: 1`, and, when the
  browser sends an `Origin`, the origin of `public_url`. Anything else is refused and audited.

### Audit log

Every sign-in, failure, sign-out, refusal and change to users and grants is added to the `audit` table
of the database (time, who, event, subject, detail, address) and cannot be changed or deleted
through the program (database triggers refuse it). Passwords and cookie values are never written.
Repeated identical refusals are logged once a minute. Read it in the **Audit log** tab of the Access
view (filters, paging, CSV export) or on the server with `python3 mps_access.py audit tail`.

### Managing access

A SuperAdmin sees an **Access** entry in the menu (nobody else does; the address `#v=access` shows
"No access" to anyone else and no management request is made). It has five tabs:

- **Waiting for access**: people who signed in but have no role, group or grant. Tick some (or the whole
  page, up to 500), then _Give a role_, _Add to a group_, or _Remove_ (deletes a never-approved account).
- **Users**: search by sign-in name, name or e-mail, filter by state, role or group. Open a person to
  change name and e-mail, disable or enable, set a password, end their sessions, unlink a Microsoft
  account, give roles and groups, add grants, and read **What this person can see** in plain words (the
  same decision the data uses). _New user_ creates one; a user who never signed in can be deleted.
- **Groups**: a named set of people and roles (their access adds up).
- **Roles**: the built-in SuperAdmin, Admin and User cannot be renamed or deleted; custom roles hold
  grants and may be set to "sees everything".
- **Audit log**: filters (dates, person, event, result), _Newer / Older_, and _Export CSV_.

A grant is edited with server, exchange and segment choices (any value can also be typed) and a dealer
field; the dialog shows how it reads, e.g. _BSE, every segment on server 10.0.0.1, dealers starting
DESK1_. A dealer pattern that is not `*`, an id or a prefix ending in `*` cannot be saved.

Typical set-up of a desk: create a role "Desk 1" with the grant `*, NSE, FO, DESK1*`, create a group
"Desk 1" and give it that role, then open _Waiting for access_, tick the people and _Add to a group_.

**Microsoft sign-ins** (when the separate Azure login change is on) arrive in _Waiting for access_ and
get nothing until a SuperAdmin approves them there.

**Import** (_Import users..._ in Users or Waiting for access): a CSV whose first line is
`login,name,roles,groups`; several roles or groups in one cell are separated by `;`. _Check file_
reports what would be created or changed and lists every problem with its line and reason. If there is
even one problem nothing is imported. The SuperAdmin role is refused in an import and in bulk
assignment; give it from the person's own page. Up to 10,000 lines or 2 MB.

**Safeguards** (refused with a message; the command line obeys them too, except the rule about yourself,
which needs a signed-in person): the last enabled SuperAdmin cannot be removed, disabled or deleted; you
cannot change your own roles, groups, state or account in ways that lock you out (another SuperAdmin
must do it); built-in roles cannot be changed or given grants; a group or role in use is deleted only
after confirmation; every change is written to the audit log. Two people editing the same thing do not
overwrite each other: the later one is told to reload.

On the server, without the browser:

```bash
python3 mps_access.py user add bob --name "Bob" --ask-password
python3 mps_access.py role assign bob User
python3 mps_access.py grant add --user bob --server 10.0.0.1 --exchange NSE --segment FO --dealer 'DESK1*'
python3 mps_access.py access bob              # what bob can see and why
python3 mps_access.py audit tail
```

`user`, `role`, `group`, `grant`, `access` and `audit` each list their actions with `--help`. Use
`--config` or `--db` to point at another config or database file.

### Capacity

Measured with `python tests/load_poll.py` (one poller thread per browser, one request a second, an
occasional OTR snapshot, a data file growing a line a second). The server and the load client ran on the
same Windows laptop (Python 3.14), so the client competes for CPU: use the numbers to compare modes, not as
absolute limits for a production host. One Python process uses one core for requests, so capacity is
bounded by that core.

| Pollers | Mode      | Mean ms | p50 ms | p95 ms | Server CPU (one core = 100%) | Failed requests |
| ------: | --------- | ------: | -----: | -----: | ---------------------------: | --------------: |
|     100 | `off`     |    23.0 |    5.3 |   50.6 |                          28% |       3 of 1581 |
|     100 | `enforce` |    24.6 |    5.7 |   29.1 |                          29% |       0 of 1581 |
|     300 | `off`     |     468 |   20.2 |   2672 |                         100% |     145 refused |
|     300 | `enforce` |     249 |   13.7 |   1957 |                          88% |      75 refused |
|     500 | `off`     |     744 |    142 |   3454 |                         119% |    1007 refused |
|     500 | `enforce` |    1059 |    171 |   4134 |                         119% |    1237 refused |

At 300 and 500 pollers the machine is overloaded in both modes (the numbers vary from run to run and the
client shares the CPU), so only the 100-poller rows compare the modes fairly.

- `enforce` adds no measurable cost over `off` at 100 pollers (the typical request is the same), so
  the planned read cache was **not** needed. The sign-in check is a signature check plus a cached
  lookup; the store is read about once a second, not per request.
- Around 300 simultaneous pollers one core is full **with or without** access control and the listen queue
  overflows (connections refused). The listen backlog is now 256 (it was Python's default of 5). For 300
  to 500 pollers, re-measure on the production Linux host with `load_poll.py` (ideally with the client on
  another machine) and, if needed, raise `interval_ms` (for example to 2000) to halve the request rate.
  Capacity is a property of the single-process server, not of access control.

Run it yourself: `python tests/load_poll.py --pollers 100 300 500 --modes off enforce --seconds 20`.

#### Capacity while administering access

Measured with `python tests/load_admin.py --pollers 100 --seconds 30` in `enforce` mode against a database
of 10,000 users, 500 groups and 100,000 grants. For the second half a SuperAdmin repeats, back to back:
a 10,000-line CSV import (preview and commit), three user-list pages, an audit page and a full audit
export. Same laptop and caveats as above.

| 100 pollers                   | p50 ms | p95 ms | p99 ms | max ms | Failed requests |
| ----------------------------- | -----: | -----: | -----: | -----: | --------------: |
| polling alone                 |    5.1 |   19.4 |    867 |   1265 |               0 |
| polling during administration |    6.2 |   24.1 |   53.5 |    128 |               0 |

| Administration call (p50 / p95) | ms        |
| ------------------------------- | --------- |
| import preview, 10,000 lines    | 82 / 112  |
| import commit, 10,000 lines     | 583 / 933 |
| user list page (of 10,000)      | 58 / 115  |
| audit page                      | 8 / 27    |
| audit export (CSV, whole log)   | 478 / 716 |

Polling is not slowed by the administration work (the slow tail of the first phase is the pollers' start-up
and is not repeated). The import commit writes in one transaction (about 0.6 s); the poll path only reads,
so it is not blocked, and no chunking was needed.

## HTTP API

Read-only JSON endpoints used by the page:

| Endpoint                                               | Returns                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/servers`                                     | Servers (each with its exchange/segment combinations and day counts), configured and discovered `exchanges` and `segments`, poll interval                                                                                                                               |
| `GET /api/dates?ip=<ip>[&exchange=&segment=]`          | Available dates for one server and segment                                                                                                                                                                                                                              |
| `GET /api/data?ip=&date=&offset=[&exchange=&segment=]` | Samples of one report, read in chunks from a byte offset                                                                                                                                                                                                                |
| `GET /api/reports`                                     | Every available report (one per server, segment and date), see below                                                                                                                                                                                                    |
| `GET /api/otr/files`                                   | OTR directory, file pattern, default threshold, and servers with their dates and snapshot times (`error` is set if the directory cannot be read)                                                                                                                        |
| `GET /api/otr/data?ip=&date=&time=`                    | One OTR snapshot as rows `[user, token, symbol, series, optType, strike, expiry, orders, trades, otr, exchange, segment]`, with file name, size, modified time and skipped line count; `{missing: true}` when the file does not exist, `{error}` when it cannot be read |
| `GET /api/me`                                          | Who is signed in and what the page may show: `{auth, mode, login, name, roles, view_all, manage, pending, views}`; with access control off, `{auth: false, views: ["mps", "otr"]}`                                                                                      |

With access control on, the data endpoints answer **401** without a valid session and **403**
(`Access denied`) for a server, exchange, segment or dealer the user has no grant for. They also
leave out what the user may not see: a limited user gets no `dir`, `filename` or OTR `size`.
`POST /auth/login`, `/auth/logout` and `/auth/password` take JSON and need the `X-MPS: 1` header.
The Access view uses `/api/admin/*` (`GET` to read, `POST` with JSON to change); it answers 403 to anyone
who is not a SuperAdmin and does not exist when access control is off.

`exchange` and `segment` are given together (upper-case letters) or both left out, which means the
old-style file; anything else is a 400.

`/api/reports` returns configured servers first (in config order), then discovered ones; within a
server, exchanges and segments follow the configured order, newest date first. `exchange` and
`segment` are empty for old-style files. `error` is `null` unless the data directory cannot be
read, in which case `reports` is empty:

```json
{
  "reports": [
    {
      "ip": "10.0.0.1",
      "name": "10.0.0.1",
      "date": "2026-10-13",
      "exchange": "NSE",
      "segment": "CM",
      "size": 800282
    }
  ],
  "error": null
}
```

## Security notes

- Only files matching the configured name pattern inside `dir` can be read. Server and date
  inputs are validated, and anything that would resolve outside `dir` is rejected. The same holds for
  OTR files and `otr_dir` (ip, date and time are validated; the file is opened read-only).
- OTR values from files are shown as text, never as HTML.
- Static files are served only from `web/` (`css/` and `js/` with a fixed name pattern).
  `config.json` and the Python files are not reachable.
- There is **no authentication unless you turn on access control** (see [Access control](#access-control)).
  Without it keep the default `127.0.0.1` bind and use an SSH tunnel, or restrict access with a
  firewall if you use `--host 0.0.0.0`.
- Run it as a user that has read access to the data directory (`root` is not required).

## Troubleshooting

| Symptom                                     | Check                                                                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| "No MPS files found"                        | `--dir` / `dir` is correct and file names match `filename` and `date_format`                                |
| "Cannot read the data directory"            | Directory exists and the user running the script can read it                                                |
| Server missing from the dropdown            | The file name must match the pattern exactly (IP, `_`, exchange, `_`, segment, `_`, date, `.csv`)           |
| Segment missing from the dropdown           | No file for that exchange and segment on this server; codes must be upper case                              |
| Old files show as "Unspecified"             | They have no exchange/segment in the name; this is expected                                                 |
| File name has a space or two IPs            | `hostname -i` printed several addresses when the file was written; such names are not listed                |
| "FILE NOT FOUND" for a date                 | The day's file does not exist for that server; use the suggested dates                                      |
| Page cannot be reached from your PC         | Bind with `--host 0.0.0.0` (or use an SSH tunnel) and open the port in the firewall                         |
| Port already in use                         | Pick another port with `--port`                                                                             |
| Empty charts on a live file                 | No complete line has been written yet; the page updates as soon as data arrives                             |
| OTR Report: "No OTR files found"            | `otr_dir` is correct and file names match `otr_filename` and `date_format` (`<ip>_<DDMMYYYY>_<HHMMSS>.csv`) |
| OTR Report: "Cannot read the OTR directory" | `otr_dir` exists and the user running the script can read it                                                |
| OTR snapshot "not found"                    | The file was removed or the link is old; use the suggested snapshots                                        |
| OTR snapshot cannot be read                 | The error names the problem: a missing column, an empty file, or a file over `otr_max_bytes`                |
| OTR exchange shows "Unknown"                | The token's leading digits are not in `otr_token_prefixes`; add them                                        |
| The menu shows but a view is blank          | The browser has cached old scripts; hard refresh (Ctrl+F5) after uploading `web/`                           |
