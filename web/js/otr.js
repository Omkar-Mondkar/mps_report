/* OTR report: dealer-wise order-to-trade snapshots with analytics.
 *
 * Core (window.MPSOtrCore, also loadable from Node for tests) holds all of the logic: filtering,
 * summary, group OTR, breakdowns, bands, rankings, sorting, threshold rules and snapshot
 * selection. It has no DOM. The view below it builds the page for the shell (shell.js).
 *
 * Row (from /api/otr/data):
 *   [user, token, symbol, series, optType, strike, expiry, orders, trades, otr, exchange, segment]
 * OTR of a row is the file's value; OTR of a group of rows is sum(orders) / sum(trades), or
 * sum(orders) when the group has no trades. "High" always means strictly above the threshold.
 */
(function (root) {
  "use strict";

  /* ======================================================================
   * Core
   * ==================================================================== */
  var F = {
    USER: 0,
    TOKEN: 1,
    SYMBOL: 2,
    SERIES: 3,
    TYPE: 4,
    STRIKE: 5,
    EXPIRY: 6,
    ORDERS: 7,
    TRADES: 8,
    OTR: 9,
    EX: 10,
    SEG: 11,
  };
  var UNKNOWN = "(unknown)"; // filter value of rows whose token has no known prefix
  var NONE = "(none)"; // filter / group value of an empty expiry or series
  var IP_RE = /^[0-9A-Za-z][0-9A-Za-z.:_-]{0,63}$/;
  var ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
  var TIME_RE = /^\d{6}$/;
  var MONTHS = {
    JAN: 1,
    FEB: 2,
    MAR: 3,
    APR: 4,
    MAY: 5,
    JUN: 6,
    JUL: 7,
    AUG: 8,
    SEP: 9,
    OCT: 10,
    NOV: 11,
    DEC: 12,
  };

  function dict() {
    return Object.create(null);
  }
  function count(o) {
    return Object.keys(o).length;
  }
  function exLabel(r) {
    return r[F.EX] ? r[F.EX] + " " + r[F.SEG] : "Unknown";
  }
  function seriesLabel(r) {
    return [r[F.SERIES], r[F.TYPE]].filter(Boolean).join(" ") || NONE;
  }
  /* 27OCT2026 / 2026-10-27 -> 20261027; anything else -> null */
  function expiryNum(s) {
    var m = /^(\d{1,2})([A-Za-z]{3})(\d{4})$/.exec(s || "");
    if (m && MONTHS[m[2].toUpperCase()])
      return +m[3] * 10000 + MONTHS[m[2].toUpperCase()] * 100 + +m[1];
    m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    return m ? +m[1] * 10000 + +m[2] * 100 + +m[3] : null;
  }
  function expiryKey(s) {
    var n = expiryNum(s);
    return n === null ? s || "" : n;
  }
  /* numbers before text; text compared case-insensitively */
  function compareValues(a, b) {
    var an = typeof a === "number",
      bn = typeof b === "number";
    if (an && bn) return a - b;
    if (an) return -1;
    if (bn) return 1;
    a = String(a).toLowerCase();
    b = String(b).toLowerCase();
    return a < b ? -1 : a > b ? 1 : 0;
  }
  /* stable sort by key(item), direction "asc" | "desc" */
  function sortBy(list, key, dir, tie) {
    var sign = dir === "desc" ? -1 : 1;
    return list
      .map(function (item, i) {
        return { item: item, i: i, k: key(item) };
      })
      .sort(function (x, y) {
        var c = compareValues(x.k, y.k) * sign;
        if (c) return c;
        if (tie) {
          c = tie(x.item, y.item);
          if (c) return c;
        }
        return x.i - y.i;
      })
      .map(function (o) {
        return o.item;
      });
  }
  function fmtNum(n, dec) {
    if (typeof n !== "number" || !isFinite(n)) return "\u2013";
    return n.toLocaleString("en-US", { maximumFractionDigits: dec || 0 });
  }

  /* columns of the rows table: key, heading, display value, text (left aligned) */
  var COLS = [
    { key: "user", label: "User", text: true, get: pick(F.USER) },
    { key: "token", label: "Token", text: true, get: pick(F.TOKEN) },
    { key: "exch", label: "Exchange / segment", text: true, get: exLabel },
    { key: "symbol", label: "Symbol", text: true, get: pick(F.SYMBOL) },
    { key: "series", label: "Series", text: true, get: pick(F.SERIES) },
    { key: "type", label: "Type", text: true, get: pick(F.TYPE) },
    { key: "strike", label: "Strike", get: pick(F.STRIKE) },
    {
      key: "expiry",
      label: "Expiry",
      text: true,
      get: pick(F.EXPIRY),
      sort: function (r) {
        return expiryKey(r[F.EXPIRY]);
      },
    },
    { key: "orders", label: "Orders", get: pick(F.ORDERS) },
    { key: "trades", label: "Trades", get: pick(F.TRADES) },
    { key: "otr", label: "OTR", get: pick(F.OTR) },
  ];
  function pick(i) {
    return function (r) {
      return r[i];
    };
  }

  /* breakdown dimensions: group key / label of a row, filter that selects a group */
  var DIMS = {
    dealer: {
      label: function (r) {
        return r[F.USER];
      },
      filter: function (r) {
        return { user: r[F.USER] };
      },
    },
    symbol: {
      label: function (r) {
        return r[F.SYMBOL];
      },
      filter: function (r) {
        return { symbol: r[F.SYMBOL] };
      },
    },
    exch: {
      label: exLabel,
      filter: function (r) {
        return {
          exchange: r[F.EX] || UNKNOWN,
          segment: r[F.SEG] || UNKNOWN,
        };
      },
    },
    series: {
      label: seriesLabel,
      filter: function (r) {
        return { series: r[F.SERIES] || NONE, optType: r[F.TYPE] || NONE };
      },
    },
    expiry: {
      label: function (r) {
        return r[F.EXPIRY] || NONE;
      },
      filter: function (r) {
        return { expiry: r[F.EXPIRY] || NONE };
      },
      sort: function (r) {
        return expiryKey(r[F.EXPIRY]);
      },
    },
  };

  function stamp(date, time) {
    return Date.UTC(
      +date.slice(0, 4),
      +date.slice(5, 7) - 1,
      +date.slice(8, 10),
      +time.slice(0, 2),
      +time.slice(2, 4),
      +time.slice(4, 6),
    );
  }
  function serverOf(servers, ip) {
    for (var i = 0; i < servers.length; i++)
      if (servers[i].ip === ip) return servers[i];
    return null;
  }
  function dateOf(srv, date) {
    for (var i = 0; i < srv.dates.length; i++)
      if (srv.dates[i].date === date) return srv.dates[i];
    return null;
  }

  var Core = {
    F: F,
    UNKNOWN: UNKNOWN,
    NONE: NONE,
    COLS: COLS,
    expiryNum: expiryNum,
    compareValues: compareValues,
    fmtNum: fmtNum,

    /* ---- numbers ---- */
    /* OTR of a group: orders / trades, or the orders when there are no trades */
    groupOtr: function (orders, trades) {
      return trades > 0 ? orders / trades : orders;
    },
    isHigh: function (otr, thr) {
      return otr > thr;
    },
    fmtInt: function (n) {
      return fmtNum(n, 0);
    },
    fmtOtr: function (n) {
      return fmtNum(n, 4);
    },
    fmtPct: function (p) {
      return typeof p === "number" && isFinite(p)
        ? fmtNum(Math.round(p * 10) / 10, 1) + "%"
        : "\u2013";
    },
    fmtTime: function (t) {
      return TIME_RE.test(t || "")
        ? t.slice(0, 2) + ":" + t.slice(2, 4) + ":" + t.slice(4, 6)
        : String(t || "");
    },
    /* Threshold typed by the user: a plain number of 0 or more (thousands commas allowed). */
    validateThreshold: function (text) {
      var s = String(text == null ? "" : text).trim();
      if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
      if (!/^\d+(\.\d+)?$/.test(s) || !isFinite(Number(s)))
        return { ok: false, error: "Enter a number of 0 or more" };
      return { ok: true, value: Number(s) };
    },

    /* ---- rows ---- */
    /* f: {user, exchange, segment, series, optType, symbol, expiry, text, onlyHigh}; empty =
       any. Exchange / segment / series / optType / expiry use UNKNOWN / NONE for empty values. */
    filter: function (rows, f, thr) {
      f = f || {};
      var text = String(f.text || "")
        .trim()
        .toLowerCase();
      return rows.filter(function (r) {
        if (f.user && r[F.USER] !== f.user) return false;
        if (f.exchange && (r[F.EX] || UNKNOWN) !== f.exchange) return false;
        if (f.segment && (r[F.SEG] || UNKNOWN) !== f.segment) return false;
        if (f.series && (r[F.SERIES] || NONE) !== f.series) return false;
        if (f.optType && (r[F.TYPE] || NONE) !== f.optType) return false;
        if (f.symbol && r[F.SYMBOL] !== f.symbol) return false;
        if (f.expiry && (r[F.EXPIRY] || NONE) !== f.expiry) return false;
        if (f.onlyHigh && !(r[F.OTR] > thr)) return false;
        if (
          text &&
          r[F.USER].toLowerCase().indexOf(text) < 0 &&
          r[F.SYMBOL].toLowerCase().indexOf(text) < 0 &&
          r[F.TOKEN].toLowerCase().indexOf(text) < 0
        )
          return false;
        return true;
      });
    },
    /* distinct values for the filter selectors */
    options: function (rows) {
      var u = dict(),
        e = dict(),
        g = dict(),
        s = dict(),
        t = dict();
      rows.forEach(function (r) {
        u[r[F.USER]] = 1;
        e[r[F.EX] || UNKNOWN] = 1;
        g[r[F.SEG] || UNKNOWN] = 1;
        s[r[F.SERIES] || NONE] = 1;
        t[r[F.TYPE] || NONE] = 1;
      });
      function list(o) {
        return Object.keys(o).sort(compareValues);
      }
      return {
        users: list(u),
        exchanges: list(e),
        segments: list(g),
        series: list(s),
        types: list(t),
      };
    },
    /* cards: all numbers describe `rows` (already filtered) */
    summary: function (rows, thr) {
      var users = dict(),
        tokens = dict(),
        orders = 0,
        trades = 0,
        flagged = 0,
        flaggedOrders = 0,
        max = null;
      rows.forEach(function (r) {
        users[r[F.USER]] = 1;
        tokens[r[F.TOKEN]] = 1;
        orders += r[F.ORDERS];
        trades += r[F.TRADES];
        if (r[F.OTR] > thr) {
          flagged++;
          flaggedOrders += r[F.ORDERS];
        }
        if (!max || r[F.OTR] > max[F.OTR]) max = r;
      });
      var n = rows.length;
      return {
        rows: n,
        dealers: count(users),
        contracts: count(tokens),
        orders: orders,
        trades: trades,
        otr: n ? Core.groupOtr(orders, trades) : null,
        noTrades: n > 0 && trades === 0,
        flagged: flagged,
        flaggedPct: n ? (flagged / n) * 100 : null,
        flaggedOrders: flaggedOrders,
        flaggedOrdersPct: orders > 0 ? (flaggedOrders / orders) * 100 : null,
        max: max
          ? {
              otr: max[F.OTR],
              user: max[F.USER],
              symbol: max[F.SYMBOL],
              token: max[F.TOKEN],
            }
          : null,
      };
    },
    /* dim: dealer | symbol | exch | series | expiry.
       -> [{label, rows, orders, trades, otr, noTrades, high, isHigh, sortKey, filter}] */
    groupBy: function (rows, dim, thr) {
      var d = DIMS[dim],
        map = dict(),
        out = [];
      rows.forEach(function (r) {
        var label = d.label(r),
          g = map[label];
        if (!g) {
          g = map[label] = {
            label: label,
            rows: 0,
            orders: 0,
            trades: 0,
            high: 0,
            sortKey: d.sort ? d.sort(r) : label,
            filter: d.filter(r),
          };
          out.push(g);
        }
        g.rows++;
        g.orders += r[F.ORDERS];
        g.trades += r[F.TRADES];
        if (r[F.OTR] > thr) g.high++;
      });
      out.forEach(function (g) {
        g.otr = Core.groupOtr(g.orders, g.trades);
        g.noTrades = g.trades === 0;
        g.isHigh = g.otr > thr;
      });
      return out;
    },
    /* col: label | rows | orders | trades | otr | high */
    sortGroups: function (groups, col, dir) {
      return sortBy(
        groups,
        function (g) {
          return col === "label" ? g.sortKey : g[col];
        },
        dir,
        function (a, b) {
          return compareValues(a.sortKey, b.sortKey);
        },
      );
    },
    /* Disjoint bands covering every row: <= 1, 1-2, 2-10, 10-100, 100-thr, > thr (bands whose
       lower edge is not below the threshold are folded away). */
    bands: function (rows, thr) {
      var edges = [1, 2, 10, 100].filter(function (e) {
          return e < thr;
        }),
        out = [],
        i;
      edges.push(thr);
      for (i = 0; i < edges.length; i++)
        out.push({
          lo: i ? edges[i - 1] : null,
          hi: edges[i],
          high: false,
          label: i
            ? fmtNum(edges[i - 1], 4) + " \u2013 " + fmtNum(edges[i], 4)
            : "\u2264 " + fmtNum(edges[0], 4),
          rows: 0,
          orders: 0,
        });
      out.push({
        lo: thr,
        hi: null,
        high: true,
        label: "> " + fmtNum(thr, 4),
        rows: 0,
        orders: 0,
      });
      rows.forEach(function (r) {
        var v = r[F.OTR];
        for (var k = 0; k < out.length; k++) {
          var b = out[k];
          if ((b.lo === null || v > b.lo) && (b.hi === null || v <= b.hi)) {
            b.rows++;
            b.orders += r[F.ORDERS];
            return;
          }
        }
      });
      var totalRows = rows.length,
        totalOrders = rows.reduce(function (s, r) {
          return s + r[F.ORDERS];
        }, 0);
      out.forEach(function (b) {
        b.pctRows = totalRows ? (b.rows / totalRows) * 100 : 0;
        b.pctOrders = totalOrders ? (b.orders / totalOrders) * 100 : 0;
      });
      return out;
    },
    /* field: "otr" (ties: more orders first) | "orders" (ties: higher OTR first) */
    topBy: function (rows, field, n) {
      var a = field === "otr" ? F.OTR : F.ORDERS,
        b = field === "otr" ? F.ORDERS : F.OTR;
      return rows
        .map(function (r, i) {
          return { r: r, i: i };
        })
        .sort(function (x, y) {
          return y.r[a] - x.r[a] || y.r[b] - x.r[b] || x.i - y.i;
        })
        .slice(0, n)
        .map(function (o) {
          return o.r;
        });
    },
    /* col: a COLS key, dir: "asc" | "desc" */
    sortRows: function (rows, col, dir) {
      var c = COLS.filter(function (x) {
        return x.key === col;
      })[0];
      if (!c) return rows.slice();
      return sortBy(rows, c.sort || c.get, dir);
    },

    /* ---- snapshots ---- */
    /* {ip, date, time} from untrusted text; fields that are not valid become "" */
    parseWant: function (o) {
      o = o || {};
      return {
        ip: typeof o.ip === "string" && IP_RE.test(o.ip) ? o.ip : "",
        date: typeof o.date === "string" && ISO_RE.test(o.date) ? o.date : "",
        time: typeof o.time === "string" && TIME_RE.test(o.time) ? o.time : "",
      };
    },
    hasSnapshot: function (servers, sel) {
      var s = sel && serverOf(servers, sel.ip),
        d = s && dateOf(s, sel.date);
      return !!d && d.times.indexOf(sel.time) >= 0;
    },
    /* Choose what to show. Unknown server -> first server; unknown date or time -> the newest.
       With `honor`, a valid choice for a known server is kept even if its file is not listed: a
       complete date+time (a link to a removed snapshot says so) or a date with no snapshots at
       all (the page then says no snapshots exist for it). null when there are no servers. */
    pickSnapshot: function (servers, want, honor) {
      want = Core.parseWant(want);
      if (!servers.length) return null;
      var srv = serverOf(servers, want.ip) || servers[0];
      if (
        honor &&
        srv.ip === want.ip &&
        want.date &&
        (want.time || !dateOf(srv, want.date))
      )
        return { ip: srv.ip, date: want.date, time: want.time };
      var d = dateOf(srv, want.date) || srv.dates[0];
      if (!d) return { ip: srv.ip, date: "", time: "" };
      return {
        ip: srv.ip,
        date: d.date,
        time: d.times.indexOf(want.time) >= 0 ? want.time : d.times[0],
      };
    },
    /* The date picked in the date box: its newest snapshot, or an empty time when the server has
       no snapshot on that date. null for an invalid date or unknown server. */
    chooseDate: function (servers, sel, date) {
      var s = sel && serverOf(servers, sel.ip);
      if (!s || typeof date !== "string" || !ISO_RE.test(date)) return null;
      var d = dateOf(s, date),
        newest = d && d.times.length ? d.times.slice().sort().pop() : "";
      return { ip: s.ip, date: date, time: newest };
    },
    /* nearest earlier (dir < 0) or later (dir > 0) date that has snapshots on the server, or null */
    neighborDate: function (servers, sel, dir) {
      var s = sel && serverOf(servers, sel.ip),
        best = null;
      if (!s || !sel.date) return null;
      s.dates.forEach(function (d) {
        if (!d.times.length) return;
        if (dir < 0 ? d.date >= sel.date : d.date <= sel.date) return;
        if (best === null || (dir < 0 ? d.date > best : d.date < best))
          best = d.date;
      });
      return best;
    },
    /* up to n other dates that have snapshots, closest to the selected date first, newest first on
       a tie; returned newest first as plain ISO dates */
    nearestDates: function (servers, sel, n) {
      var s = sel && serverOf(servers, sel.ip),
        out = [];
      if (!s || !sel.date) return [];
      var target = stamp(sel.date, "000000");
      s.dates.forEach(function (d) {
        if (!d.times.length || d.date === sel.date) return;
        var at = stamp(d.date, "000000");
        out.push({ date: d.date, diff: Math.abs(at - target), at: at });
      });
      out.sort(function (a, b) {
        return a.diff - b.diff || b.at - a.at;
      });
      return out
        .slice(0, n)
        .map(function (o) {
          return o.date;
        })
        .sort()
        .reverse();
    },
    /* newest snapshot time of the selected date when it is newer than the selected one */
    newerSnapshot: function (servers, sel) {
      var s = sel && serverOf(servers, sel.ip),
        d = s && dateOf(s, sel.date);
      if (!d || !d.times.length) return null;
      var newest = d.times.slice().sort().pop();
      return newest > sel.time ? newest : null;
    },
    /* up to n other snapshots of the same server, closest in time first */
    nearestSnapshots: function (servers, sel, n) {
      var s = sel && serverOf(servers, sel.ip),
        out = [];
      if (!s || !sel.date || !sel.time) return [];
      var target = stamp(sel.date, sel.time);
      s.dates.forEach(function (d) {
        d.times.forEach(function (t) {
          var at = stamp(d.date, t);
          if (d.date === sel.date && t === sel.time) return;
          out.push({
            date: d.date,
            time: t,
            at: at,
            diff: Math.abs(at - target),
          });
        });
      });
      out.sort(function (a, b) {
        return a.diff - b.diff || b.at - a.at;
      });
      return out.slice(0, n).map(function (o) {
        return { date: o.date, time: o.time };
      });
    },
  };

  root.MPSOtrCore = Core;
  if (typeof module !== "undefined" && module.exports) module.exports = Core;
  if (typeof document === "undefined") return;

  /* ======================================================================
   * View
   * ==================================================================== */
  var host = document.getElementById("viewOtr");
  var Shell = root.MPSShell,
    UI = root.MPSUI;
  if (!host || !Shell || !UI) return;

  var PAGE = 100, // rows per page
    TOP = 10, // groups shown before "Show all"
    REFRESH_MS = 60000,
    STORE = "mps.otr",
    THR_STORE = "mps.otrThr";

  var S = {
    active: false,
    started: false,
    built: false,
    servers: [],
    cfg: { dir: "", filename: "", threshold: 2000 },
    listErr: "",
    sel: null, // {ip, date, time}
    loaded: null, // key of the snapshot whose rows are in S.data
    data: null, // {file, size, modified, rows, skipped}
    opts: null,
    thr: 2000,
    thrReady: false,
    filters: blankFilters(),
    sort: { col: "otr", dir: "desc" },
    page: 0,
    gsort: {},
    gall: {},
    req: 0,
    timer: 0,
  };
  var D = {}; // DOM references

  function blankFilters() {
    return {
      user: "",
      exchange: "",
      segment: "",
      series: "",
      optType: "",
      symbol: "",
      expiry: "",
      text: "",
      onlyHigh: false,
    };
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function button(text, cls, fn) {
    var b = el("button", cls, text);
    b.type = "button";
    if (fn) b.onclick = fn;
    return b;
  }
  function saveItem(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch (e) {
      /* ignore */
    }
  }
  function loadItem(k) {
    try {
      return localStorage.getItem(k);
    } catch (e) {
      return null;
    }
  }
  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }
  function prettyDate(iso) {
    return new Date(
      Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)),
    ).toLocaleDateString("en-GB", {
      weekday: "short",
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  function api(path, params) {
    return MPSSession.get(
      "api/otr/" + path + "?" + new URLSearchParams(params),
    );
  }
  function setBusy(b) {
    document.body.classList.toggle("busy", b);
    if (D.body) D.body.classList.toggle("otr-loading", b);
  }

  /* ---------- selection, address and storage ---------- */
  function persist() {
    var s = S.sel;
    Shell.setHash("otr", s ? { os: s.ip, od: s.date, ot: s.time } : {});
    if (s) saveItem(STORE, JSON.stringify(s));
    document.title = s
      ? "OTR Report \u00b7 " +
        s.ip +
        " \u00b7 " +
        s.date +
        (s.time ? " " + Core.fmtTime(s.time) : "")
      : "OTR Report";
  }
  function wantFromHash(h) {
    return Core.parseWant({ ip: h.os, date: h.od, time: h.ot });
  }
  function wantFromStore() {
    try {
      return Core.parseWant(JSON.parse(loadItem(STORE) || "{}"));
    } catch (e) {
      return Core.parseWant({});
    }
  }
  function savedThreshold() {
    var v = Core.validateThreshold(loadItem(THR_STORE));
    return v.ok ? v.value : null;
  }

  /* ---------- building the page (once) ---------- */
  function field(label, node, cls) {
    var f = el("div", "field" + (cls ? " " + cls : ""));
    var l = el("label", null, label);
    if (node.id) l.htmlFor = node.id;
    f.appendChild(l);
    f.appendChild(node);
    return f;
  }
  function panel(title, color) {
    var p = el("section", "panel"),
      h = el("h2"),
      b = el("b");
    b.style.background = color;
    h.appendChild(b);
    h.appendChild(document.createTextNode(title));
    p.appendChild(h);
    return { panel: p, head: h };
  }
  function select(id, label, key) {
    var s = el("select", "mdate");
    s.id = id;
    s.setAttribute("aria-label", label);
    s.onchange = function () {
      S.filters[key] = s.value;
      S.page = 0;
      render();
    };
    return s;
  }
  /* a custom dropdown (widgets.js) living in its own box */
  function dropdown(cls, opts) {
    var box = el("div", cls);
    return { box: box, ui: UI.select(box, opts) };
  }

  function build() {
    S.built = true;

    /* snapshot selectors */
    var controls = el("section", "controls");
    var sv = dropdown(null, {
      placeholder: "No servers",
      search: true,
      searchPlaceholder: "Search servers\u2026",
      onChange: function (v) {
        chooseSnapshot({ ip: v, date: S.sel && S.sel.date });
      },
    });
    var tm = dropdown("sm", {
      placeholder: "\u2014",
      onChange: function (v) {
        if (S.sel) chooseSnapshot({ ip: S.sel.ip, date: S.sel.date, time: v });
      },
    });
    D.selServer = sv.ui;
    D.selTime = tm.ui;

    /* date navigator, like the MPS Report one: previous / calendar / next */
    var db = el("div", "datebox");
    D.prev = button("\u2039", null, function () {
      stepDate(-1);
    });
    D.prev.id = "otr-prev";
    D.prev.title = "Previous available date";
    D.prev.setAttribute("aria-label", "Previous date");
    D.dateIn = el("input");
    D.dateIn.type = "date";
    D.dateIn.id = "otr-date";
    D.dateIn.onchange = function () {
      var v = D.dateIn.value;
      if (!ISO_RE.test(v)) {
        D.dateIn.value = S.sel ? S.sel.date : "";
        return;
      }
      if (S.sel && v !== S.sel.date) chooseDate(v);
    };
    D.next = button("\u203a", null, function () {
      stepDate(1);
    });
    D.next.id = "otr-next";
    D.next.title = "Next available date";
    D.next.setAttribute("aria-label", "Next date");
    db.appendChild(D.prev);
    db.appendChild(D.dateIn);
    db.appendChild(D.next);
    controls.appendChild(field("Server", sv.box));
    controls.appendChild(field("Date", db)).firstChild.htmlFor = "otr-date";
    controls.appendChild(field("Time", tm.box));

    D.refresh = button("Refresh", null, refreshAll);
    D.refresh.title = "Reload the file list and the selected snapshot";
    var rf = el("div", "field");
    rf.appendChild(el("label", null, "\u00a0"));
    rf.appendChild(D.refresh);
    controls.appendChild(rf);

    D.thr = el("input", "sq otr-thr");
    D.thr.id = "otr-thr";
    D.thr.type = "text";
    D.thr.setAttribute("inputmode", "decimal");
    D.thr.autocomplete = "off";
    D.thr.spellcheck = false;
    D.thr.maxLength = 12;
    D.thr.setAttribute("aria-describedby", "otr-thr-err");
    D.thr.onchange = applyThreshold;
    D.thr.onkeydown = function (e) {
      if (e.key === "Enter") applyThreshold();
    };
    D.thrErr = el("div", "otr-err");
    D.thrErr.id = "otr-thr-err";
    D.thrErr.setAttribute("role", "status");
    var tf = field("Highlight OTR above", D.thr);
    tf.appendChild(D.thrErr);
    controls.appendChild(tf);

    D.chip = el("div", "chip");
    D.chip.appendChild(el("i"));
    D.chipText = el("span", null, "\u2026");
    D.chip.appendChild(D.chipText);
    controls.appendChild(D.chip);
    host.appendChild(controls);

    /* newer snapshot notice */
    D.note = el("div", "otr-note");
    D.note.hidden = true;
    D.noteText = el("span");
    D.noteBtn = button("Load it");
    D.note.appendChild(D.noteText);
    D.note.appendChild(D.noteBtn);
    host.appendChild(D.note);

    /* empty / error state */
    D.empty = el("div", "empty");
    D.empty.hidden = true;
    D.empty.appendChild(el("div", "mark", "!"));
    D.emptyTitle = el("h3");
    D.emptyMsg = el("p");
    D.emptySug = el("div", "sug");
    D.empty.appendChild(D.emptyTitle);
    D.empty.appendChild(D.emptyMsg);
    D.empty.appendChild(D.emptySug);
    host.appendChild(D.empty);

    /* report body */
    D.body = el("div");
    D.body.hidden = true;
    host.appendChild(D.body);

    D.cards = el("div", "otr-cards");
    D.body.appendChild(D.cards);

    /* filters */
    var fb = el("section", "controls");
    D.fUser = select("otr-f-user", "Filter by user", "user");
    D.fEx = select("otr-f-ex", "Filter by exchange", "exchange");
    D.fSeg = select("otr-f-seg", "Filter by segment", "segment");
    D.fSeries = select("otr-f-series", "Filter by series", "series");
    D.fType = select("otr-f-type", "Filter by option type", "optType");
    fb.appendChild(field("User", D.fUser));
    fb.appendChild(field("Exchange", D.fEx));
    fb.appendChild(field("Segment", D.fSeg));
    fb.appendChild(field("Series", D.fSeries));
    fb.appendChild(field("Option type", D.fType));
    D.fText = el("input", "sq");
    D.fText.id = "otr-f-text";
    D.fText.type = "search";
    D.fText.placeholder = "user, symbol or token";
    D.fText.autocomplete = "off";
    D.fText.spellcheck = false;
    D.fText.maxLength = 60;
    var tt = 0;
    D.fText.oninput = function () {
      clearTimeout(tt);
      tt = setTimeout(function () {
        S.filters.text = D.fText.value;
        S.page = 0;
        render();
      }, 200);
    };
    fb.appendChild(field("Search", D.fText, "grow"));
    var hl = el("label", "checkline");
    D.fHigh = el("input");
    D.fHigh.type = "checkbox";
    D.fHigh.onchange = function () {
      S.filters.onlyHigh = D.fHigh.checked;
      S.page = 0;
      render();
    };
    D.fHighText = el("span");
    hl.appendChild(D.fHigh);
    hl.appendChild(D.fHighText);
    var hf = el("div", "field");
    hf.appendChild(el("label", null, "\u00a0"));
    hf.appendChild(hl);
    fb.appendChild(hf);
    var cf = el("div", "field");
    cf.appendChild(el("label", null, "\u00a0"));
    D.clear = button("Clear filters", null, clearFilters);
    cf.appendChild(D.clear);
    fb.appendChild(cf);
    D.chips = el("div", "fchips");
    fb.appendChild(D.chips);
    D.body.appendChild(fb);

    /* breakdowns */
    D.dims = [
      { id: "dealer", title: "By dealer", color: "#4cc9f0", name: "Dealer" },
      { id: "symbol", title: "By symbol", color: "#3ddc84", name: "Symbol" },
      {
        id: "exch",
        title: "By exchange and segment",
        color: "#f9a03f",
        name: "Exchange / segment",
      },
      {
        id: "series",
        title: "By series and option type",
        color: "#b388ff",
        name: "Series / type",
      },
      { id: "expiry", title: "By expiry", color: "#ff8fab", name: "Expiry" },
    ];
    var grid = el("div", "otr-grid");
    D.dims.forEach(function (d) {
      var p = panel(d.title, d.color);
      d.box = el("div", "tblwrap");
      d.more = el("div", "moreline");
      p.panel.appendChild(d.box);
      p.panel.appendChild(d.more);
      grid.appendChild(p.panel);
    });
    D.body.appendChild(grid);
    D.body.appendChild(el("div", "otr-gap"));

    /* distribution and rankings */
    var pd = panel("OTR distribution (rows and orders per band)", "#ff6b6b");
    D.bands = el("div", "otr-bands");
    pd.panel.appendChild(D.bands);
    D.body.appendChild(pd.panel);

    var rk = el("div", "otr-grid");
    var p1 = panel("Top 10 by OTR", "#ff6b6b"),
      p2 = panel("Top 10 by orders", "#4cc9f0");
    D.topOtr = el("div", "tblwrap");
    D.topOrders = el("div", "tblwrap");
    p1.panel.appendChild(D.topOtr);
    p2.panel.appendChild(D.topOrders);
    rk.appendChild(p1.panel);
    rk.appendChild(p2.panel);
    D.body.appendChild(rk);
    D.body.appendChild(el("div", "otr-gap"));

    /* rows table */
    var pt = panel("Rows", "#8392b0");
    D.table = el("div", "tblwrap");
    D.pager = el("div", "pager");
    pt.panel.appendChild(D.table);
    pt.panel.appendChild(D.pager);
    D.body.appendChild(pt.panel);
  }

  /* ---------- loading ---------- */
  function showState(title, msg, sug, label) {
    D.emptyTitle.textContent = title;
    D.emptyMsg.textContent = msg || "";
    D.emptySug.textContent = "";
    if (sug && sug.length) {
      D.emptySug.appendChild(el("span", null, label || "Nearest snapshots:"));
      sug.forEach(function (x) {
        D.emptySug.appendChild(
          button(
            prettyDate(x.date) + (x.time ? " " + Core.fmtTime(x.time) : ""),
            null,
            function () {
              if (x.time)
                chooseSnapshot({ ip: S.sel.ip, date: x.date, time: x.time });
              else chooseDate(x.date);
            },
          ),
        );
      });
    }
    D.body.hidden = true;
    D.empty.hidden = false;
  }
  function showBody() {
    D.empty.hidden = true;
    D.body.hidden = false;
  }
  function setChip(cls, text) {
    D.chip.className = "chip " + cls;
    D.chipText.textContent = text;
  }

  function loadList() {
    return api("files", {})
      .then(function (j) {
        S.servers = j.servers || [];
        S.cfg = {
          dir: j.dir,
          filename: j.filename,
          threshold: typeof j.threshold === "number" ? j.threshold : 2000,
        };
        S.listErr = j.error || "";
      })
      .catch(function (e) {
        S.servers = [];
        S.listErr = e instanceof TypeError ? "Server unreachable" : e.message;
      });
  }

  function pickInitial(h) {
    var fromHash = wantFromHash(h),
      honor = !!(fromHash.ip && fromHash.date);
    return Core.pickSnapshot(
      S.servers,
      fromHash.ip ? fromHash : wantFromStore(),
      honor,
    );
  }

  function chooseSnapshot(want) {
    var next = Core.pickSnapshot(S.servers, want, false);
    if (!next) return;
    S.sel = next;
    persist();
    paintSelectors();
    updateNote();
    load();
  }
  /* a date from the calendar or a suggestion; may have no snapshots (load() then says so) */
  function chooseDate(iso) {
    var next = S.sel && Core.chooseDate(S.servers, S.sel, iso);
    if (!next) return paintSelectors();
    S.sel = next;
    persist();
    paintSelectors();
    updateNote();
    load();
  }
  function stepDate(dir) {
    var iso = S.sel && Core.neighborDate(S.servers, S.sel, dir);
    if (iso) chooseDate(iso);
  }

  function paintSelectors() {
    var sel = S.sel,
      srv =
        sel &&
        S.servers.filter(function (s) {
          return s.ip === sel.ip;
        })[0],
      items = S.servers.map(function (s) {
        return {
          value: s.ip,
          label: s.name,
          sub: s.name === s.ip ? s.dates.length + " days" : s.ip,
        };
      });
    if (sel && !srv)
      items.push({ value: sel.ip, label: sel.ip, sub: "not found" });
    D.selServer.setItems(items);
    D.selServer.setValue(sel ? sel.ip : null);
    D.selServer.setDisabled(!items.length);

    var newest = "",
      now = new Date(),
      today =
        now.getFullYear() +
        "-" +
        ("0" + (now.getMonth() + 1)).slice(-2) +
        "-" +
        ("0" + now.getDate()).slice(-2);
    if (srv)
      srv.dates.forEach(function (d) {
        if (d.times.length && d.date > newest) newest = d.date;
      });
    D.dateIn.value = sel && sel.date ? sel.date : "";
    D.dateIn.max = newest > today ? newest : today;
    D.dateIn.disabled = !S.servers.length;
    D.prev.disabled = !sel || !Core.neighborDate(S.servers, sel, -1);
    D.next.disabled = !sel || !Core.neighborDate(S.servers, sel, 1);

    var day =
        srv &&
        srv.dates.filter(function (d) {
          return sel && d.date === sel.date;
        })[0],
      times = day
        ? day.times.map(function (t) {
            return { value: t, label: Core.fmtTime(t) };
          })
        : [];
    if (
      sel &&
      sel.time &&
      !times.some(function (t) {
        return t.value === sel.time;
      })
    )
      times.unshift({
        value: sel.time,
        label: Core.fmtTime(sel.time),
        sub: "not found",
      });
    D.selTime.setItems(times);
    D.selTime.setValue(sel ? sel.time : null);
    D.selTime.setDisabled(!times.length);
  }

  function updateNote() {
    var newer = S.sel && Core.newerSnapshot(S.servers, S.sel);
    D.note.hidden = !newer;
    if (!newer) return;
    D.noteText.textContent = S.sel.time
      ? "A newer snapshot of this date is available (" +
        Core.fmtTime(newer) +
        ")."
      : "Snapshots are now available for this date (" +
        Core.fmtTime(newer) +
        ").";
    D.noteBtn.onclick = function () {
      chooseSnapshot({ ip: S.sel.ip, date: S.sel.date, time: newer });
    };
  }

  /* the selected date has no snapshot on this server: say so, like the MPS report does */
  function showNoDate() {
    var sel = S.sel,
      srv = serverOf(S.servers, sel.ip);
    S.req++;
    setBusy(false);
    S.data = null;
    S.loaded = null;
    setChip("missing", sel.date + " \u2014 no snapshots");
    showState(
      "No OTR snapshots for " +
        prettyDate(sel.date) +
        " \u00b7 " +
        (srv ? srv.name : sel.ip),
      "Looked for " +
        (S.cfg.filename || "a snapshot") +
        (S.cfg.dir ? " in " + S.cfg.dir : "") +
        ". It will appear here once a snapshot is written.",
      Core.nearestDates(S.servers, sel, 4).map(function (d) {
        return { date: d };
      }),
      "Nearest dates:",
    );
  }

  function load() {
    var sel = S.sel;
    if (!sel || !sel.date) return;
    if (!sel.time) return showNoDate();
    var req = ++S.req;
    setBusy(true);
    setChip("", "loading\u2026");
    api("data", { ip: sel.ip, date: sel.date, time: sel.time })
      .then(function (j) {
        if (req !== S.req) return;
        setBusy(false);
        if (j.error)
          return failed("Cannot read this snapshot", j.error, j.file);
        if (j.missing) {
          S.data = null;
          S.loaded = null;
          setChip("missing", j.file + " \u2014 not found");
          return showState(
            "Snapshot not found",
            "Looked for " +
              j.file +
              (S.cfg.dir ? " in " + S.cfg.dir : "") +
              ".",
            Core.nearestSnapshots(S.servers, sel, 4),
          );
        }
        var key = [sel.ip, sel.date, sel.time].join("|"),
          same = key === S.loaded;
        S.data = j;
        S.opts = Core.options(j.rows);
        S.loaded = key;
        if (!same) {
          S.filters = blankFilters();
          S.page = 0;
          S.gall = {};
        }
        setChip(
          "ok",
          j.file +
            " \u00b7 " +
            fmtBytes(j.size) +
            " \u00b7 generated " +
            j.modified.slice(11) +
            " \u00b7 " +
            Core.fmtInt(j.rows.length) +
            " rows" +
            (j.skipped ? " \u00b7 " + j.skipped + " lines skipped" : ""),
        );
        fillFilters();
        showBody();
        render();
      })
      .catch(function (e) {
        if (req !== S.req) return;
        setBusy(false);
        failed(
          "Cannot reach the server",
          e instanceof TypeError ? "Server unreachable" : e.message,
        );
      });
  }
  function failed(title, msg, file) {
    S.data = null;
    S.loaded = null;
    setChip("missing", file ? file + " \u2014 error" : "error");
    showState(title, msg);
  }

  /* Reload the file list and the selected snapshot (the Refresh button, and on entering). */
  function refreshAll() {
    loadList().then(function () {
      if (!S.active) return;
      resolveSelection();
      load();
    });
  }
  function resolveSelection() {
    applyDefaultThreshold();
    if (!S.servers.length) {
      S.sel = null;
      paintSelectors();
      D.note.hidden = true;
      setBusy(false);
      S.data = null;
      S.loaded = null;
      setChip("missing", "no OTR files");
      showState(
        S.listErr ? "Cannot read the OTR directory" : "No OTR files found",
        S.listErr ||
          (S.cfg.dir
            ? "Nothing matching " + S.cfg.filename + " in " + S.cfg.dir + "."
            : "There are no OTR snapshots you can see yet."),
      );
      persist();
      return false;
    }
    if (!S.sel) S.sel = pickInitial(Shell.Core.parseHash(location.hash));
    else if (!S.sel.date) S.sel = pickInitial({});
    else if (!S.sel.time)
      S.sel = Core.chooseDate(S.servers, S.sel, S.sel.date) || S.sel;
    paintSelectors();
    updateNote();
    persist();
    return true;
  }
  /* Periodic list refresh: update the selectors and the notice; never switch snapshots. */
  function refreshList() {
    loadList().then(function () {
      if (!S.active || !S.servers.length || !S.sel) return;
      paintSelectors();
      updateNote();
      if (S.data && !Core.hasSnapshot(S.servers, S.sel)) load();
    });
  }

  /* ---------- threshold ---------- */
  function applyDefaultThreshold() {
    if (S.thrReady) return;
    S.thrReady = true;
    var saved = savedThreshold();
    S.thr = saved !== null ? saved : S.cfg.threshold;
    D.thr.value = String(S.thr);
  }
  function applyThreshold() {
    var v = Core.validateThreshold(D.thr.value);
    if (!v.ok) {
      D.thr.setAttribute("aria-invalid", "true");
      D.thrErr.textContent = v.error + " (kept " + Core.fmtNum(S.thr, 4) + ")";
      return;
    }
    D.thr.removeAttribute("aria-invalid");
    D.thrErr.textContent = "";
    S.thrReady = true;
    S.thr = v.value;
    D.thr.value = String(v.value);
    saveItem(THR_STORE, String(v.value));
    S.page = 0;
    render();
  }

  /* ---------- filters ---------- */
  /* options = All + values; returns the kept selection ("" when it no longer exists) */
  function fillSelect(sel, values, current) {
    sel.textContent = "";
    sel.appendChild(new Option("All", ""));
    values.forEach(function (v) {
      sel.appendChild(new Option(v, v));
    });
    sel.value = values.indexOf(current) >= 0 ? current : "";
    return sel.value;
  }
  function fillFilters() {
    var o = S.opts,
      f = S.filters;
    f.user = fillSelect(D.fUser, o.users, f.user);
    f.exchange = fillSelect(D.fEx, o.exchanges, f.exchange);
    f.segment = fillSelect(D.fSeg, o.segments, f.segment);
    f.series = fillSelect(D.fSeries, o.series, f.series);
    f.optType = fillSelect(D.fType, o.types, f.optType);
    D.fText.value = f.text;
    D.fHigh.checked = f.onlyHigh;
  }
  function clearFilters() {
    S.filters = blankFilters();
    S.page = 0;
    fillFilters();
    render();
  }
  function applyFilter(patch) {
    var f = S.filters;
    Object.keys(patch).forEach(function (k) {
      f[k] = patch[k];
    });
    S.page = 0;
    syncFilters();
    render();
  }
  function syncFilters() {
    var f = S.filters;
    [
      [D.fUser, "user"],
      [D.fEx, "exchange"],
      [D.fSeg, "segment"],
      [D.fSeries, "series"],
      [D.fType, "optType"],
    ].forEach(function (p) {
      if (p[0].value !== f[p[1]]) p[0].value = f[p[1]];
    });
    if (D.fText.value !== f.text) D.fText.value = f.text;
    D.fHigh.checked = f.onlyHigh;
  }
  function anyFilter() {
    var f = S.filters;
    return !!(
      f.user ||
      f.exchange ||
      f.segment ||
      f.series ||
      f.optType ||
      f.symbol ||
      f.expiry ||
      f.text.trim() ||
      f.onlyHigh
    );
  }

  /* ---------- rendering ---------- */
  function focusedKey() {
    var a = document.activeElement;
    return a && host.contains(a) ? a.getAttribute("data-fk") : null;
  }
  function restoreFocus(k) {
    if (!k) return;
    var n = host.querySelector('[data-fk="' + k + '"]');
    if (n) n.focus();
  }

  function render() {
    if (!S.data) return;
    var fk = focusedKey(),
      all = S.data.rows,
      fr = Core.filter(all, S.filters, S.thr);
    D.fHighText.textContent = "Only OTR above " + Core.fmtNum(S.thr, 4);
    renderCards(fr, all.length);
    renderChips();
    D.dims.forEach(function (d) {
      renderGroups(d, fr);
    });
    renderBands(fr);
    D.topOtr.textContent = "";
    D.topOtr.appendChild(rankTable(Core.topBy(fr, "otr", 10)));
    D.topOrders.textContent = "";
    D.topOrders.appendChild(rankTable(Core.topBy(fr, "orders", 10)));
    renderTable(fr, all.length);
    restoreFocus(fk);
  }

  function card(label, value, sub, hot, badge) {
    var c = el("div", "card" + (hot ? " hot" : ""));
    c.appendChild(el("span", null, label));
    var b = el("b", null, value);
    if (badge) b.appendChild(el("span", "badge nt", badge));
    c.appendChild(b);
    c.appendChild(el("small", null, sub || "\u00a0"));
    return c;
  }
  function renderCards(fr, total) {
    var s = Core.summary(fr, S.thr),
      c = D.cards,
      empty = !s.rows,
      dash = "\u2013";
    c.textContent = "";
    c.appendChild(
      card(
        "Rows",
        Core.fmtInt(s.rows),
        s.rows !== total ? "of " + Core.fmtInt(total) + " in snapshot" : "",
      ),
    );
    c.appendChild(card("Dealers", empty ? dash : Core.fmtInt(s.dealers)));
    c.appendChild(card("Contracts", empty ? dash : Core.fmtInt(s.contracts)));
    c.appendChild(card("Total orders", empty ? dash : Core.fmtInt(s.orders)));
    c.appendChild(card("Total trades", empty ? dash : Core.fmtInt(s.trades)));
    c.appendChild(
      card(
        "Overall OTR",
        empty ? dash : Core.fmtOtr(s.otr),
        "orders \u00f7 trades",
        !empty && Core.isHigh(s.otr, S.thr),
        s.noTrades ? "no trades" : "",
      ),
    );
    c.appendChild(
      card(
        "Above " + Core.fmtNum(S.thr, 4),
        empty
          ? dash
          : Core.fmtInt(s.flagged) + " (" + Core.fmtPct(s.flaggedPct) + ")",
        "rows with OTR above the threshold",
        s.flagged > 0,
      ),
    );
    c.appendChild(
      card(
        "Orders in those rows",
        Core.fmtPct(s.flaggedOrdersPct),
        empty ? "" : Core.fmtInt(s.flaggedOrders) + " orders",
        s.flagged > 0,
      ),
    );
    c.appendChild(
      card(
        "Highest row OTR",
        s.max ? Core.fmtOtr(s.max.otr) : dash,
        s.max ? s.max.user + " \u00b7 " + s.max.symbol + " " + s.max.token : "",
        !!s.max && Core.isHigh(s.max.otr, S.thr),
      ),
    );
  }

  function renderChips() {
    var f = S.filters;
    D.chips.textContent = "";
    [
      ["symbol", "Symbol"],
      ["expiry", "Expiry"],
    ].forEach(function (p) {
      if (!f[p[0]]) return;
      var chip = el("span", "fchip", p[1] + ": " + f[p[0]]),
        x = button("\u00d7", null, function () {
          var patch = {};
          patch[p[0]] = "";
          applyFilter(patch);
        });
      x.setAttribute("aria-label", "Remove " + p[1] + " filter");
      chip.appendChild(x);
      D.chips.appendChild(chip);
    });
    D.clear.disabled = !anyFilter();
  }

  function sortHead(th, key, label, st, fk, onSort) {
    var b = button(label, "sortb", function () {
      onSort(key);
    });
    b.setAttribute("data-fk", fk);
    var on = st.col === key;
    th.setAttribute(
      "aria-sort",
      on ? (st.dir === "asc" ? "ascending" : "descending") : "none",
    );
    if (on) b.textContent = label + (st.dir === "asc" ? " \u25b2" : " \u25bc");
    th.appendChild(b);
    return th;
  }
  function nextSort(st, key) {
    if (st.col === key) st.dir = st.dir === "asc" ? "desc" : "asc";
    else {
      st.col = key;
      st.dir = "asc";
    }
  }
  function cell(text, cls) {
    return el("td", cls || null, text);
  }
  function otrCell(v, nt) {
    var td = el("td", Core.isHigh(v, S.thr) ? "hi" : null, Core.fmtOtr(v));
    if (Core.isHigh(v, S.thr)) td.appendChild(el("span", "badge", "HIGH"));
    if (nt) td.appendChild(el("span", "badge nt", "no trades"));
    return td;
  }

  function renderGroups(d, fr) {
    var st = S.gsort[d.id] || (S.gsort[d.id] = { col: "otr", dir: "desc" }),
      groups = Core.sortGroups(Core.groupBy(fr, d.id, S.thr), st.col, st.dir),
      shown = S.gall[d.id] ? groups : groups.slice(0, TOP),
      t = el("table", "ctable"),
      hr = el("tr");
    d.box.textContent = "";
    d.more.textContent = "";
    if (!groups.length) {
      d.box.appendChild(el("div", "otr-msg", "No rows."));
      return;
    }
    [
      ["label", d.name],
      ["rows", "Rows"],
      ["orders", "Orders"],
      ["trades", "Trades"],
      ["otr", "OTR"],
      ["high", "Rows above"],
    ].forEach(function (c) {
      hr.appendChild(
        sortHead(
          el("th"),
          c[0],
          c[1],
          st,
          "g-" + d.id + "-" + c[0],
          function (k) {
            nextSort(st, k);
            render();
          },
        ),
      );
    });
    t.appendChild(el("thead")).appendChild(hr);
    var tb = el("tbody");
    shown.forEach(function (g) {
      var tr = el("tr", g.isHigh ? "hi" : null),
        td = el("td", "l"),
        b = button(g.label, "lnk", function () {
          applyFilter(g.filter);
        });
      b.title = "Filter the report to " + g.label;
      td.appendChild(b);
      tr.appendChild(td);
      tr.appendChild(cell(Core.fmtInt(g.rows)));
      tr.appendChild(cell(Core.fmtInt(g.orders)));
      tr.appendChild(cell(Core.fmtInt(g.trades)));
      tr.appendChild(otrCell(g.otr, g.noTrades));
      tr.appendChild(
        cell(g.high ? Core.fmtInt(g.high) : "\u2013", g.high ? "hi" : "na"),
      );
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    d.box.appendChild(t);
    if (groups.length > TOP) {
      var m = button(
        S.gall[d.id]
          ? "Show top " + TOP
          : "Show all " + Core.fmtInt(groups.length),
        "mini",
        function () {
          S.gall[d.id] = !S.gall[d.id];
          render();
        },
      );
      m.setAttribute("data-fk", "more-" + d.id);
      d.more.appendChild(m);
    }
  }

  function renderBands(fr) {
    var bands = Core.bands(fr, S.thr);
    D.bands.textContent = "";
    bands.forEach(function (b) {
      var row = el("div", "band" + (b.high ? " hi" : "")),
        lab = el("span", "bl", b.label),
        track = el("div", "track"),
        fill = el("div", "fill"),
        val = el(
          "span",
          "bv",
          Core.fmtInt(b.rows) +
            " rows (" +
            Core.fmtPct(b.pctRows) +
            ") \u00b7 " +
            Core.fmtInt(b.orders) +
            " orders (" +
            Core.fmtPct(b.pctOrders) +
            ")",
        );
      if (b.high && b.rows) lab.appendChild(el("span", "badge", "HIGH"));
      fill.style.width = b.pctRows.toFixed(2) + "%";
      track.appendChild(fill);
      row.appendChild(lab);
      row.appendChild(track);
      row.appendChild(val);
      D.bands.appendChild(row);
    });
  }

  function rankTable(rows) {
    var t = el("table", "ctable"),
      hr = el("tr");
    ["#", "User", "Symbol", "Token", "Orders", "Trades", "OTR"].forEach(
      function (h, i) {
        hr.appendChild(el("th", i >= 1 && i <= 3 ? "l" : null, h));
      },
    );
    t.appendChild(el("thead")).appendChild(hr);
    var tb = el("tbody");
    rows.forEach(function (r, i) {
      var tr = el("tr", Core.isHigh(r[F.OTR], S.thr) ? "hi" : null);
      tr.appendChild(cell(String(i + 1)));
      tr.appendChild(cell(r[F.USER], "l"));
      tr.appendChild(cell(r[F.SYMBOL], "l"));
      tr.appendChild(cell(r[F.TOKEN], "l"));
      tr.appendChild(cell(Core.fmtInt(r[F.ORDERS])));
      tr.appendChild(cell(Core.fmtInt(r[F.TRADES])));
      tr.appendChild(otrCell(r[F.OTR], r[F.TRADES] === 0));
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    if (!rows.length) {
      var w = el("div");
      w.appendChild(el("div", "otr-msg", "No rows."));
      return w;
    }
    return t;
  }

  function renderTable(fr, total) {
    var n = fr.length,
      pages = Math.max(1, Math.ceil(n / PAGE));
    D.table.textContent = "";
    D.pager.textContent = "";
    if (!n) {
      var m = el("div", "otr-msg", "No rows match the filters. ");
      m.appendChild(button("Clear filters", "mini", clearFilters));
      D.table.appendChild(m);
      D.pager.appendChild(
        el(
          "span",
          "pinfo",
          "Rows 0 of 0 \u00b7 " + Core.fmtInt(total) + " in snapshot",
        ),
      );
      return;
    }
    if (S.page >= pages) S.page = pages - 1;
    var sorted = Core.sortRows(fr, S.sort.col, S.sort.dir),
      from = S.page * PAGE,
      slice = sorted.slice(from, from + PAGE),
      t = el("table", "ctable"),
      hr = el("tr");
    Core.COLS.forEach(function (c) {
      var th = el("th", c.text ? "l" : null);
      hr.appendChild(
        sortHead(th, c.key, c.label, S.sort, "t-" + c.key, function (k) {
          nextSort(S.sort, k);
          S.page = 0;
          render();
        }),
      );
    });
    t.appendChild(el("thead")).appendChild(hr);
    var tb = el("tbody");
    slice.forEach(function (r) {
      var tr = el("tr", Core.isHigh(r[F.OTR], S.thr) ? "hi" : null);
      tr.appendChild(cell(r[F.USER], "l"));
      tr.appendChild(cell(r[F.TOKEN], "l"));
      tr.appendChild(cell(r[F.EX] ? r[F.EX] + " " + r[F.SEG] : "Unknown", "l"));
      tr.appendChild(cell(r[F.SYMBOL], "l"));
      tr.appendChild(cell(r[F.SERIES], "l"));
      tr.appendChild(cell(r[F.TYPE], "l"));
      tr.appendChild(
        cell(
          typeof r[F.STRIKE] === "number"
            ? Core.fmtNum(r[F.STRIKE], 4)
            : r[F.STRIKE],
        ),
      );
      tr.appendChild(cell(r[F.EXPIRY], "l"));
      tr.appendChild(cell(Core.fmtInt(r[F.ORDERS])));
      tr.appendChild(cell(Core.fmtInt(r[F.TRADES])));
      tr.appendChild(otrCell(r[F.OTR], r[F.TRADES] === 0));
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    D.table.appendChild(t);

    var info =
      "Rows " +
      Core.fmtInt(from + 1) +
      "-" +
      Core.fmtInt(from + slice.length) +
      " of " +
      Core.fmtInt(n) +
      (n !== total ? " \u00b7 " + Core.fmtInt(total) + " in snapshot" : "");
    D.pager.appendChild(el("span", "pinfo", info));
    var prev = button("\u2039 Previous", null, function () {
        S.page--;
        render();
      }),
      next = button("Next \u203a", null, function () {
        S.page++;
        render();
      });
    prev.disabled = S.page <= 0;
    next.disabled = S.page >= pages - 1;
    prev.setAttribute("data-fk", "prev");
    next.setAttribute("data-fk", "next");
    D.pager.appendChild(prev);
    D.pager.appendChild(
      el("span", null, "Page " + (S.page + 1) + " of " + Core.fmtInt(pages)),
    );
    D.pager.appendChild(next);
  }

  /* ---------- view contract (see shell.js) ---------- */
  function enter() {
    S.active = true;
    if (!S.built) build();
    document.title = "OTR Report";
    if (!S.started) {
      S.started = true;
      loadList().then(function () {
        if (!S.active) return;
        if (resolveSelection()) load();
      });
    } else {
      refreshAll();
    }
    clearInterval(S.timer);
    S.timer = setInterval(refreshList, REFRESH_MS);
  }
  function leave() {
    S.active = false;
    S.req++; // answers still in flight are ignored
    clearInterval(S.timer);
    S.timer = 0;
    setBusy(false);
  }
  Shell.register({ id: "otr", el: host, enter: enter, leave: leave });
})(typeof window !== "undefined" ? window : {});
