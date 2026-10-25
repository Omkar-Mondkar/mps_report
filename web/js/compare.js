/* Report comparison: pure statistics core (also loadable from Node for tests) and the Compare view.
 * Core API: window.MPSCompareCore. UI: window.MPSCompare (see bottom). */
(function (root) {
  "use strict";

  /* ======================================================================
   * Core: reductions, interval slicing, statistics, deltas (no DOM)
   * ==================================================================== */
  var DAY = 86400;
  var IP_RE = /^[0-9A-Za-z][0-9A-Za-z.:_-]{0,63}$/;
  var ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
  var MARKET = [9 * 3600 + 15 * 60, 15 * 3600 + 30 * 60];

  function dayStartMs(iso) {
    var a = iso.split("-").map(Number);
    return Date.UTC(a[0], a[1] - 1, a[2]);
  }

  /* One report -> one Float32Array of DAY slots (seconds since midnight), NaN = no sample. */
  function newSeries() {
    var a = new Float32Array(DAY);
    for (var i = 0; i < DAY; i++) a[i] = NaN;
    return a;
  }

  /* Add flat [t, v, t, v, ...] samples (epoch ms "as if UTC") taken on `iso`.
   * Samples outside that calendar day are ignored; if a second appears twice the last value wins. */
  function addPoints(series, iso, points) {
    var base = dayStartMs(iso),
      added = 0,
      i,
      s;
    for (i = 0; i + 1 < points.length; i += 2) {
      s = Math.floor((points[i] - base) / 1000);
      if (s >= 0 && s < DAY) {
        series[s] = points[i + 1];
        added++;
      }
    }
    return added;
  }

  /* Per-minute min / avg / max (1440 buckets) for drawing a zoomed-out line. */
  function minuteBuckets(series) {
    var mn = new Float32Array(1440),
      av = new Float32Array(1440),
      mx = new Float32Array(1440),
      m,
      s,
      v,
      n,
      sum,
      lo,
      hi;
    for (m = 0; m < 1440; m++) {
      n = 0;
      sum = 0;
      lo = Infinity;
      hi = -Infinity;
      for (s = m * 60; s < m * 60 + 60; s++) {
        v = series[s];
        if (v !== v) continue;
        n++;
        sum += v;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      mn[m] = n ? lo : NaN;
      av[m] = n ? sum / n : NaN;
      mx[m] = n ? hi : NaN;
    }
    return { min: mn, avg: av, max: mx };
  }

  /* Interval choice -> {from, to} in seconds of day, `to` exclusive. null if invalid. */
  function intervalRange(kind, fromSec, toSec) {
    if (kind === "market") return { from: MARKET[0], to: MARKET[1] + 1 };
    if (kind === "custom") {
      if (
        fromSec == null ||
        toSec == null ||
        !(fromSec >= 0) ||
        !(toSec > fromSec) ||
        toSec >= DAY
      )
        return null;
      return { from: fromSec, to: toSec + 1 };
    }
    return { from: 0, to: DAY };
  }

  /* Statistics over series[from, to). Empty -> count 0 and null values (never zeros).
   * maxAt is the first second at which the peak occurred; maxTimes lists every such second
   * (ascending) and maxCount is its length. */
  function stats(series, from, to) {
    var vals = [],
      total = 0,
      mn = Infinity,
      mx = -Infinity,
      mxAt = -1,
      mxTimes = [],
      s,
      v;
    for (s = from; s < to; s++) {
      v = series[s];
      if (v !== v) continue;
      vals.push(v);
      total += v;
      if (v < mn) mn = v;
      if (v > mx) {
        mx = v;
        mxAt = s;
        mxTimes = [s];
      } else if (v === mx) {
        mxTimes.push(s);
      }
    }
    var n = vals.length;
    if (!n)
      return {
        count: 0,
        avg: null,
        min: null,
        max: null,
        maxAt: null,
        maxCount: 0,
        maxTimes: [],
        p95: null,
        total: null,
      };
    vals.sort(function (a, b) {
      return a - b;
    });
    return {
      count: n,
      avg: total / n,
      min: mn,
      max: mx,
      maxAt: mxAt,
      maxCount: mxTimes.length,
      maxTimes: mxTimes,
      p95: vals[Math.ceil(0.95 * n) - 1], // nearest-rank
      total: total,
    };
  }

  /* Seconds in [from, to) whose value satisfies test(v). first/last are null when count is 0.
   * times is ascending and holds every match; callers cap how many they render. */
  function search(series, from, to, test) {
    var times = [],
      s,
      v;
    for (s = from; s < to; s++) {
      v = series[s];
      if (v === v && test(v)) times.push(s);
    }
    return {
      count: times.length,
      first: times.length ? times[0] : null,
      last: times.length ? times[times.length - 1] : null,
      times: times,
    };
  }

  /* Average per hour of day within [from, to); null for hours without samples. */
  function hourly(series, from, to) {
    var out = [],
      h,
      s,
      lo,
      hi,
      n,
      sum,
      v;
    for (h = 0; h < 24; h++) {
      lo = Math.max(from, h * 3600);
      hi = Math.min(to, h * 3600 + 3600);
      n = 0;
      sum = 0;
      for (s = lo; s < hi; s++) {
        v = series[s];
        if (v === v) {
          n++;
          sum += v;
        }
      }
      out.push(n ? sum / n : null);
    }
    return out;
  }

  /* value vs baseline -> {abs, pct}; pct is null when the baseline is 0 or a side is missing. */
  function delta(val, base) {
    if (val == null || base == null) return { abs: null, pct: null };
    return {
      abs: val - base,
      pct: base === 0 ? null : ((val - base) / base) * 100,
    };
  }
  function deltas(row, base) {
    return {
      avg: delta(row.avg, base.avg),
      max: delta(row.max, base.max),
      total: delta(row.total, base.total),
    };
  }

  /* A report is (server, date, exchange, segment). Old-style files have no exchange or
   * segment (both ""). Token: "ip@YYYY-MM-DD" for those, "ip@YYYY-MM-DD@NSE_CM" otherwise. */
  function token(ip, date, exchange, segment) {
    var t = ip + "@" + date;
    return exchange && segment ? t + "@" + exchange + "_" + segment : t;
  }
  /* token -> {ip, date, exchange, segment} or null when it is not a valid token. */
  function parseToken(t) {
    var a = typeof t === "string" ? t.split("@") : [],
      m;
    if (a.length < 2 || a.length > 3) return null;
    if (!IP_RE.test(a[0]) || !ISO_RE.test(a[1])) return null;
    if (a.length === 2)
      return { ip: a[0], date: a[1], exchange: "", segment: "" };
    m = /^([A-Z]{2,8})_([A-Z]{2,8})$/.exec(a[2]);
    return m ? { ip: a[0], date: a[1], exchange: m[1], segment: m[2] } : null;
  }
  /* "NSE CM", or "Unspecified" for old-style files. */
  function segLabel(exchange, segment) {
    return exchange && segment ? exchange + " " + segment : "Unspecified";
  }
  /* "Greek A \u00b7 NSE CM \u00b7 2026-10-13"; old-style files: "Greek A \u00b7 2026-10-13". */
  function reportLabel(r) {
    return (
      r.name +
      " \u00b7 " +
      (r.exchange && r.segment
        ? r.exchange + " " + r.segment + " \u00b7 "
        : "") +
      r.date
    );
  }
  /* Dashboard selection rule. `segs` = a server's [{exchange, segment}] in display order.
   * Keep the wanted exchange if the server has it (else take the first); within it keep the
   * wanted segment if present (else take the first). null/undefined = no preference.
   * -> {exchange, segment} or null when the server has no files. */
  function chooseSeg(segs, exchange, segment) {
    var inEx, i;
    if (!segs || !segs.length) return null;
    for (i = 0; i < segs.length; i++) if (segs[i].exchange === exchange) break;
    if (i === segs.length) exchange = segs[0].exchange;
    inEx = segs.filter(function (s) {
      return s.exchange === exchange;
    });
    for (i = 0; i < inEx.length; i++)
      if (inEx[i].segment === segment)
        return { exchange: exchange, segment: segment };
    return { exchange: exchange, segment: inEx[0].segment };
  }

  var Core = {
    DAY: DAY,
    MARKET: MARKET,
    dayStartMs: dayStartMs,
    newSeries: newSeries,
    addPoints: addPoints,
    minuteBuckets: minuteBuckets,
    intervalRange: intervalRange,
    stats: stats,
    search: search,
    hourly: hourly,
    delta: delta,
    deltas: deltas,
    token: token,
    parseToken: parseToken,
    segLabel: segLabel,
    reportLabel: reportLabel,
    chooseSeg: chooseSeg,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = Core;
  root.MPSCompareCore = Core;

  /* ======================================================================
   * UI (browser only)
   * ==================================================================== */
  if (typeof document === "undefined") return;

  var $ = function (id) {
    return document.getElementById(id);
  };
  var MAXR = 6;
  var PALETTE = [
    "#4cc9f0",
    "#f9a03f",
    "#3ddc84",
    "#ff6b9a",
    "#b48cff",
    "#f2d24b",
  ];
  var COL = {
    grid: "rgba(131,146,176,.14)",
    axis: "rgba(131,146,176,.4)",
    text: "#8392b0",
  };
  var IV = [
    { value: "full", label: "Full day", sub: "00:00 \u2013 24:00" },
    { value: "market", label: "Market hours", sub: "09:15 \u2013 15:30" },
    { value: "custom", label: "Custom\u2026" },
  ];
  var TSTEPS = [
    1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600,
  ];
  var STORE = "mps.cmp";

  /* ---------- small helpers ---------- */
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function p2(n) {
    return (n < 10 ? "0" : "") + n;
  }
  function fmtHMS(s, short) {
    var h = Math.floor(s / 3600),
      m = Math.floor((s % 3600) / 60),
      r = s % 60;
    return p2(h) + ":" + p2(m) + (short ? "" : ":" + p2(r));
  }
  function fmtInt(n) {
    return Math.round(n).toLocaleString("en-US");
  }
  function fmtNum(n) {
    return (Math.round(n * 10) / 10).toLocaleString("en-US");
  }
  function fmtY(v) {
    return v >= 1000
      ? String(+(v / 1000).toFixed(2)) + "k"
      : String(+v.toFixed(2));
  }
  function niceStep(raw) {
    var e = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)),
      f = raw / e;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e;
  }
  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }
  function hexA(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return (
      "rgba(" +
      (n >> 16) +
      "," +
      ((n >> 8) & 255) +
      "," +
      (n & 255) +
      "," +
      a +
      ")"
    );
  }
  function hmsSec(s) {
    var m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s || "");
    return m ? +m[1] * 3600 + +m[2] * 60 + (+m[3] || 0) : null;
  }
  function api(path, params) {
    return MPSSession.get("api/" + path + "?" + new URLSearchParams(params));
  }
  function drawTip(ctx, W, H, x, y, title, rows) {
    var pad = 8,
      lh = 16,
      w = ctx.measureText(title).width,
      i,
      tw;
    ctx.font = "12px system-ui, sans-serif";
    w = ctx.measureText(title).width;
    for (i = 0; i < rows.length; i++) {
      tw = ctx.measureText(rows[i].text).width + 16;
      if (tw > w) w = tw;
    }
    var bw = w + pad * 2,
      bh = lh * (rows.length + 1) + pad * 2 - 4,
      bx = x + 14,
      by = y - bh / 2;
    if (bx + bw > W - 4) bx = x - 14 - bw;
    bx = Math.max(4, bx);
    by = clamp(by, 4, Math.max(4, H - bh - 4));
    ctx.fillStyle = "rgba(16,23,42,.95)";
    ctx.strokeStyle = "#33446b";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(bx + 0.5, by + 0.5, bw, bh);
    ctx.fill();
    ctx.stroke();
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = "#dbe3f3";
    ctx.fillText(title, bx + pad, by + pad + 4);
    rows.forEach(function (r, k) {
      var ry = by + pad + 4 + lh * (k + 1);
      ctx.fillStyle = r.color;
      ctx.fillRect(bx + pad, ry - 4, 8, 8);
      ctx.fillStyle = r.dim ? "#8392b0" : "#dbe3f3";
      ctx.fillText(r.text, bx + pad + 14, ry);
    });
  }

  /* ---------- canvas plumbing shared by both charts ---------- */
  function Plot(canvas, draw) {
    var self = {
        W: 0,
        H: 0,
        pw: 10,
        ph: 10,
        dpr: 1,
        ctx: canvas.getContext("2d"),
      },
      M = { l: 58, r: 18, t: 14, b: 40 },
      raf = 0;
    self.M = M;
    self.canvas = canvas;
    self.size = function () {
      var r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      var d = window.devicePixelRatio || 1,
        w = Math.round(r.width * d),
        h = Math.round(r.height * d);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      self.dpr = d;
      self.W = r.width;
      self.H = r.height;
      self.pw = Math.max(10, r.width - M.l - M.r);
      self.ph = Math.max(10, r.height - M.t - M.b);
      return true;
    };
    self.redraw = function () {
      if (raf) return;
      raf = requestAnimationFrame(function () {
        raf = 0;
        if (!self.size()) return;
        self.ctx.setTransform(self.dpr, 0, 0, self.dpr, 0, 0);
        self.ctx.clearRect(0, 0, self.W, self.H);
        draw(self);
      });
    };
    return self;
  }
  function yAxis(P, ymax, step) {
    var ctx = P.ctx,
      M = P.M,
      v,
      y;
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 1;
    for (v = 0; v <= ymax + step / 2; v += step) {
      y = Math.round(M.t + P.ph - (v / ymax) * P.ph) + 0.5;
      ctx.strokeStyle = COL.grid;
      ctx.beginPath();
      ctx.moveTo(M.l, y);
      ctx.lineTo(M.l + P.pw, y);
      ctx.stroke();
      ctx.fillStyle = COL.text;
      ctx.fillText(fmtY(v), M.l - 8, y);
    }
    ctx.strokeStyle = COL.axis;
    ctx.beginPath();
    ctx.moveTo(M.l + 0.5, M.t);
    ctx.lineTo(M.l + 0.5, M.t + P.ph + 0.5);
    ctx.lineTo(M.l + P.pw, M.t + P.ph + 0.5);
    ctx.stroke();
  }
  function niceMax(mx) {
    if (!(mx > 0)) return { ymax: 1, step: 0.2 };
    var step = niceStep((mx * 1.05) / 5);
    return { ymax: Math.ceil((mx * 1.05) / step) * step, step: step };
  }

  /* ---------- overlay line chart ---------- */
  function LineChart(canvas) {
    var items = [],
      dom = { x0: 0, x1: DAY },
      view = { x0: 0, x1: DAY },
      hover = null,
      drag = null,
      mark = null,
      yinfo = { ymax: 1, step: 0.2 };
    var P = Plot(canvas, draw);
    var M = P.M;

    function X(s) {
      return M.l + ((s - view.x0) / (view.x1 - view.x0)) * P.pw;
    }
    function secAt(px) {
      return view.x0 + ((px - M.l) / P.pw) * (view.x1 - view.x0);
    }
    function Y(v) {
      return M.t + P.ph - (v / yinfo.ymax) * P.ph;
    }
    function maxIn(it, a, b, spp) {
      var mx = 0,
        i,
        v,
        lo,
        hi;
      if (spp >= 60) {
        lo = clamp(Math.floor(a / 60), 0, 1439);
        hi = clamp(Math.ceil(b / 60), 0, 1440);
        for (i = lo; i < hi; i++) {
          v = it.buckets.max[i];
          if (v > mx) mx = v;
        }
      } else {
        lo = clamp(Math.floor(a), 0, DAY);
        hi = clamp(Math.ceil(b), 0, DAY);
        for (i = lo; i < hi; i++) {
          v = it.series[i];
          if (v > mx) mx = v;
        }
      }
      return mx;
    }
    function column(it, s0, s1, spp) {
      var n = 0,
        sum = 0,
        lo = Infinity,
        hi = -Infinity,
        m,
        m0,
        m1,
        q0,
        q1,
        v,
        bk;
      if (spp >= 60) {
        bk = it.buckets;
        m0 = Math.floor(s0 / 60);
        m1 = Math.max(m0 + 1, Math.ceil(s1 / 60));
        for (m = Math.max(0, m0); m < Math.min(1440, m1); m++) {
          v = bk.avg[m];
          if (v !== v) continue;
          n++;
          sum += v;
          if (bk.min[m] < lo) lo = bk.min[m];
          if (bk.max[m] > hi) hi = bk.max[m];
        }
      } else {
        q0 = Math.floor(s0);
        q1 = Math.max(q0 + 1, Math.ceil(s1));
        for (m = Math.max(0, q0); m < Math.min(DAY, q1); m++) {
          v = it.series[m];
          if (v !== v) continue;
          n++;
          sum += v;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      return n ? { avg: sum / n, min: lo, max: hi } : null;
    }
    function drawSeries(ctx, it, a, b, spp) {
      var i,
        s,
        v,
        pen = false,
        c;
      ctx.strokeStyle = it.color;
      ctx.lineWidth = 1.6;
      ctx.lineJoin = "round";
      if (spp <= 1.5) {
        ctx.beginPath();
        for (
          s = Math.max(0, Math.floor(a));
          s < Math.min(DAY, Math.ceil(b));
          s++
        ) {
          v = it.series[s];
          if (v !== v) {
            pen = false;
            continue;
          }
          if (pen) ctx.lineTo(X(s + 0.5), Y(v));
          else ctx.moveTo(X(s + 0.5), Y(v));
          pen = true;
        }
        ctx.stroke();
        return;
      }
      var n = Math.ceil(P.pw),
        cols = new Array(n);
      for (i = 0; i < n; i++)
        cols[i] = column(it, a + i * spp, a + (i + 1) * spp, spp);
      ctx.fillStyle = hexA(it.color, 0.16);
      for (i = 0; i < n; i++) {
        c = cols[i];
        if (c)
          ctx.fillRect(M.l + i, Y(c.max), 1, Math.max(1, Y(c.min) - Y(c.max)));
      }
      ctx.beginPath();
      for (i = 0; i < n; i++) {
        c = cols[i];
        if (!c) {
          pen = false;
          continue;
        }
        if (pen) ctx.lineTo(M.l + i + 0.5, Y(c.avg));
        else ctx.moveTo(M.l + i + 0.5, Y(c.avg));
        pen = true;
      }
      ctx.stroke();
    }
    function valueAt(it, t, spp) {
      var half = Math.max(0, spp / 2),
        c = column(it, Math.floor(t - half), Math.ceil(t + half), 0);
      return c ? c.avg : null;
    }

    function draw() {
      var ctx = P.ctx,
        a = view.x0,
        b = view.x1,
        span = b - a,
        spp = span / P.pw,
        vis = items.filter(function (it) {
          return it.visible;
        }),
        mx = 0,
        i,
        step,
        t,
        x;
      vis.forEach(function (it) {
        mx = Math.max(mx, maxIn(it, a, b, spp));
      });
      yinfo = niceMax(mx);
      yAxis(P, yinfo.ymax, yinfo.step);

      step = TSTEPS[TSTEPS.length - 1];
      for (i = 0; i < TSTEPS.length; i++)
        if (span / TSTEPS[i] <= P.pw / 80) {
          step = TSTEPS[i];
          break;
        }
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (t = Math.ceil(a / step) * step; t <= b; t += step) {
        x = Math.round(X(t)) + 0.5;
        ctx.strokeStyle = COL.grid;
        ctx.beginPath();
        ctx.moveTo(x, M.t);
        ctx.lineTo(x, M.t + P.ph);
        ctx.stroke();
        ctx.fillStyle = COL.text;
        ctx.fillText(fmtHMS(t, step >= 60), x, M.t + P.ph + 8);
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(M.l, M.t, P.pw, P.ph);
      ctx.clip();
      vis.forEach(function (it) {
        drawSeries(ctx, it, a, b, spp);
      });
      ctx.restore();

      if (hover && hover.px >= M.l && hover.px <= M.l + P.pw) {
        var ht = clamp(secAt(hover.px), a, b),
          rows = [];
        x = Math.round(X(ht)) + 0.5;
        ctx.strokeStyle = "rgba(219,227,243,.35)";
        ctx.beginPath();
        ctx.moveTo(x, M.t);
        ctx.lineTo(x, M.t + P.ph);
        ctx.stroke();
        vis.forEach(function (it) {
          var v = valueAt(it, ht, spp);
          if (v !== null) {
            ctx.fillStyle = it.color;
            ctx.beginPath();
            ctx.arc(x, Y(v), 3.5, 0, 6.2832);
            ctx.fill();
          }
          rows.push({
            color: it.color,
            text: it.label + ": " + (v === null ? "\u2013" : fmtNum(v)),
            dim: v === null,
          });
        });
        drawTip(
          ctx,
          P.W,
          P.H,
          hover.px,
          hover.py,
          fmtHMS(Math.floor(ht)),
          rows,
        );
      }
      if (mark && mark.sec + 1 >= a && mark.sec <= b) {
        var mx0 = Math.round(X(mark.sec + 0.5)) + 0.5,
          shown = vis.some(function (it) {
            return it.tok === mark.tok;
          }),
          mw,
          mbx;
        ctx.save();
        ctx.strokeStyle = mark.color;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(mx0, M.t);
        ctx.lineTo(mx0, M.t + P.ph);
        ctx.stroke();
        ctx.setLineDash([]);
        if (shown) {
          ctx.fillStyle = mark.color;
          ctx.beginPath();
          ctx.arc(mx0, clamp(Y(mark.v), M.t, M.t + P.ph), 5, 0, 6.2832);
          ctx.fill();
          ctx.strokeStyle = "#0d1220";
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        ctx.font = "12px system-ui, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        mw = ctx.measureText(mark.text).width + 14;
        mbx = mx0 + 8 + mw > M.l + P.pw ? mx0 - 8 - mw : mx0 + 8;
        mbx = Math.max(M.l + 2, mbx);
        ctx.fillStyle = "rgba(16,23,42,.95)";
        ctx.strokeStyle = mark.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(mbx + 0.5, M.t + 4.5, mw, 22);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#dbe3f3";
        ctx.fillText(mark.text, mbx + 7, M.t + 15.5);
        ctx.restore();
      }
      if (!vis.length) {
        ctx.fillStyle = COL.text;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(
          "All series are hidden \u2013 click a legend entry",
          M.l + P.pw / 2,
          M.t + P.ph / 2,
        );
      }
    }

    function clampView() {
      var span = clamp(
        view.x1 - view.x0,
        Math.min(10, dom.x1 - dom.x0),
        dom.x1 - dom.x0,
      );
      view.x0 = clamp(view.x0, dom.x0, dom.x1 - span);
      view.x1 = view.x0 + span;
    }
    function rel(e) {
      var r = canvas.getBoundingClientRect();
      return { px: e.clientX - r.left, py: e.clientY - r.top };
    }
    canvas.addEventListener("mousemove", function (e) {
      var p = rel(e);
      if (drag) {
        var span = drag.x1 - drag.x0,
          d = ((p.px - drag.px) / P.pw) * span;
        view.x0 = drag.x0 - d;
        view.x1 = drag.x1 - d;
        clampView();
      }
      hover = p;
      P.redraw();
    });
    canvas.addEventListener("mouseleave", function () {
      hover = null;
      P.redraw();
    });
    canvas.addEventListener("mousedown", function (e) {
      drag = { px: rel(e).px, x0: view.x0, x1: view.x1 };
      canvas.classList.add("grab");
    });
    window.addEventListener("mouseup", function () {
      if (drag) canvas.classList.remove("grab");
      drag = null;
    });
    canvas.addEventListener("dblclick", function () {
      api_reset();
    });
    canvas.addEventListener(
      "wheel",
      function (e) {
        e.preventDefault();
        var p = rel(e),
          span = view.x1 - view.x0;
        if (e.shiftKey) {
          var d = (e.deltaY / 400) * span;
          view.x0 += d;
          view.x1 += d;
        } else {
          var f = Math.exp(e.deltaY * 0.0015),
            c = clamp(secAt(p.px), view.x0, view.x1);
          view.x0 = c - (c - view.x0) * f;
          view.x1 = c + (view.x1 - c) * f;
        }
        clampView();
        hover = p;
        P.redraw();
      },
      { passive: false },
    );
    function api_reset() {
      view.x0 = dom.x0;
      view.x1 = dom.x1;
      P.redraw();
    }

    return {
      setItems: function (list) {
        items = list;
        P.redraw();
      },
      setDomain: function (x0, x1) {
        dom = { x0: x0, x1: x1 };
        view = { x0: x0, x1: x1 };
        P.redraw();
      },
      reset: api_reset,
      setMark: function (m) {
        mark = m || null;
        if (mark && (mark.sec < view.x0 || mark.sec + 1 > view.x1)) {
          var span = view.x1 - view.x0;
          view.x0 = mark.sec + 0.5 - span / 2;
          view.x1 = view.x0 + span;
          clampView();
        }
        P.redraw();
      },
      redraw: P.redraw,
    };
  }

  /* ---------- hourly grouped bars ---------- */
  function BarChart(canvas) {
    var items = [],
      h0 = 0,
      h1 = 24,
      hover = null;
    var P = Plot(canvas, draw);
    var M = P.M;

    function draw() {
      var ctx = P.ctx,
        vis = items.filter(function (it) {
          return it.visible;
        }),
        nh = h1 - h0,
        gw = P.pw / nh,
        mx = 0,
        h,
        k,
        v,
        yi;
      vis.forEach(function (it) {
        it.hourly.forEach(function (x, i) {
          if (x !== null && i >= h0 && i < h1 && x > mx) mx = x;
        });
      });
      yi = niceMax(mx);
      yAxis(P, yi.ymax, yi.step);
      var Y = function (val) {
        return M.t + P.ph - (val / yi.ymax) * P.ph;
      };
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      var every = gw < 22 ? 2 : 1;
      for (h = h0; h < h1; h++) {
        if ((h - h0) % every === 0) {
          ctx.fillStyle = COL.text;
          ctx.fillText(p2(h), M.l + (h - h0 + 0.5) * gw, M.t + P.ph + 8);
        }
      }
      var hh =
        hover && hover.px >= M.l && hover.px <= M.l + P.pw
          ? h0 + Math.floor((hover.px - M.l) / gw)
          : -1;
      if (hh >= h0 && hh < h1) {
        ctx.fillStyle = "rgba(131,146,176,.1)";
        ctx.fillRect(M.l + (hh - h0) * gw, M.t, gw, P.ph);
      }
      var n = vis.length,
        bw = Math.max(2, Math.min(28, (gw * 0.8) / Math.max(1, n)));
      for (h = h0; h < h1; h++) {
        var gx = M.l + (h - h0 + 0.5) * gw - (bw * n) / 2;
        for (k = 0; k < n; k++) {
          v = vis[k].hourly[h];
          if (v === null) continue;
          ctx.fillStyle = vis[k].color;
          ctx.fillRect(
            gx + k * bw,
            Y(v),
            Math.max(1, bw - 1),
            M.t + P.ph - Y(v),
          );
        }
      }
      if (hh >= h0 && hh < h1) {
        var rows = vis.map(function (it) {
          var x = it.hourly[hh];
          return {
            color: it.color,
            text: it.label + ": " + (x === null ? "\u2013" : fmtNum(x)),
            dim: x === null,
          };
        });
        drawTip(
          ctx,
          P.W,
          P.H,
          hover.px,
          hover.py,
          p2(hh) + ":00 \u2013 " + p2(hh) + ":59 (avg)",
          rows,
        );
      }
    }
    canvas.addEventListener("mousemove", function (e) {
      var r = canvas.getBoundingClientRect();
      hover = { px: e.clientX - r.left, py: e.clientY - r.top };
      P.redraw();
    });
    canvas.addEventListener("mouseleave", function () {
      hover = null;
      P.redraw();
    });
    return {
      setItems: function (list, from, to) {
        items = list;
        h0 = Math.floor(from / 3600);
        h1 = Math.max(h0 + 1, Math.ceil(to / 3600));
        P.redraw();
      },
      redraw: P.redraw,
    };
  }

  /* ---------- state ---------- */
  var S = {
    active: false,
    inited: false,
    reports: [],
    have: {},
    sel: [],
    base: null,
    iv: "full",
    cache: {},
    hidden: {},
    colors: {},
    gen: 0,
    run: { n: 0 },
    range: { from: 0, to: DAY },
    rangeBad: false,
    loadedAt: null,
    reportsErr: null,
    label: {},
    open: {},
    mark: null,
    focusKey: null,
    q: "",
    qOpen: {},
  };
  var pick, ivSel, line, bars;

  function labelOf(tok) {
    return S.label[tok] || tok;
  }
  function syncColors() {
    var used = {},
      keep = {};
    S.sel.forEach(function (t) {
      keep[t] = 1;
      if (S.colors[t]) used[S.colors[t]] = 1;
    });
    Object.keys(S.colors).forEach(function (t) {
      if (!keep[t]) delete S.colors[t];
    });
    S.sel.forEach(function (t) {
      if (S.colors[t]) return;
      for (var i = 0; i < PALETTE.length; i++)
        if (!used[PALETTE[i]]) {
          S.colors[t] = PALETTE[i];
          used[PALETTE[i]] = 1;
          return;
        }
      S.colors[t] = PALETTE[0];
    });
  }
  function setReports(list) {
    S.reports = list || [];
    S.have = {};
    S.label = {};
    S.reports.forEach(function (r) {
      var t = Core.token(r.ip, r.date, r.exchange, r.segment);
      S.have[t] = r;
      S.label[t] = Core.reportLabel(r);
    });
    pick.setReports(S.reports);
  }

  /* ---------- persistence (URL hash + local storage) ---------- */
  function persist() {
    var p = new URLSearchParams();
    p.set("m", "cmp");
    if (S.sel.length) p.set("c", S.sel.join(","));
    if (S.base && S.sel.indexOf(S.base) >= 0) p.set("b", S.base);
    p.set("i", S.iv);
    if (S.iv === "custom") {
      p.set("f", $("cmpFrom").value);
      p.set("t", $("cmpTo").value);
    }
    history.replaceState(null, "", "#" + p.toString());
    try {
      localStorage.setItem(
        STORE,
        JSON.stringify({
          c: S.sel,
          b: S.base,
          i: S.iv,
          f: $("cmpFrom").value,
          t: $("cmpTo").value,
        }),
      );
    } catch (e) {
      /* ignore */
    }
  }
  function loadSaved() {
    try {
      var o = JSON.parse(localStorage.getItem(STORE) || "{}");
      return o && typeof o === "object" ? o : {};
    } catch (e) {
      return {};
    }
  }
  function validTokens(list) {
    var seen = {},
      out = [];
    (Array.isArray(list) ? list : []).forEach(function (t) {
      if (
        typeof t === "string" &&
        Core.parseToken(t) &&
        S.have[t] &&
        !seen[t] &&
        out.length < MAXR
      ) {
        seen[t] = 1;
        out.push(t);
      }
    });
    return out;
  }

  /* ---------- loading ---------- */
  function segParams(p, off) {
    var o = { ip: p.ip, date: p.date, offset: off };
    if (p.exchange) {
      o.exchange = p.exchange;
      o.segment = p.segment;
    }
    return o;
  }
  function pending() {
    return S.sel.filter(function (t) {
      return !S.cache[t];
    });
  }
  function pump() {
    var todo = pending();
    while (S.run.n < 2 && todo.length) loadReport(todo.shift());
  }
  function loadReport(tok) {
    var gen = S.gen,
      run = S.run,
      p = Core.parseToken(tok),
      series = Core.newSeries(),
      off = 0,
      e = (S.cache[tok] = { status: "loading", pct: 0 });
    run.n++;

    function aborted() {
      if (gen !== S.gen) {
        run.n--;
        return true;
      }
      if (S.sel.indexOf(tok) < 0) {
        delete S.cache[tok];
        run.n--;
        pump();
        return true;
      }
      return false;
    }
    function fail(status, msg) {
      e.status = status;
      e.msg = msg;
      run.n--;
      pump();
      render();
    }
    function step() {
      if (aborted()) return;
      api("data", segParams(p, off))
        .then(function (j) {
          if (aborted()) return;
          if (j.error) return fail("error", j.error);
          if (j.missing)
            return fail("missing", "file not found (" + j.file + ")");
          if (j.reset) series = Core.newSeries();
          Core.addPoints(series, p.date, j.points);
          off = j.offset;
          e.pct = j.size ? Math.min(1, off / j.size) : 1;
          e.file = j.file;
          e.size = j.size;
          if (j.more) {
            renderChip();
            setTimeout(step, 0);
            return;
          }
          e.series = series;
          e.buckets = Core.minuteBuckets(series);
          e.status = "ok";
          S.loadedAt = new Date();
          run.n--;
          pump();
          render();
        })
        .catch(function (err) {
          if (e.status !== "loading") {
            /* already settled (e.g. render threw); don't double-count */
            if (window.console) console.error(err);
            return;
          }
          if (gen !== S.gen) {
            run.n--;
            return;
          }
          fail(
            "error",
            err instanceof TypeError ? "server unreachable" : err.message,
          );
        });
    }
    step();
    renderChip();
  }
  function resetLoads() {
    S.gen++;
    S.cache = {};
    S.run = { n: 0 };
  }

  /* ---------- rendering ---------- */
  function state() {
    var ok = [],
      loading = [],
      bad = [];
    S.sel.forEach(function (t) {
      var c = S.cache[t];
      if (c && c.status === "ok") ok.push(t);
      else if (c && (c.status === "missing" || c.status === "error"))
        bad.push(t);
      else loading.push(t);
    });
    return { ok: ok, loading: loading, bad: bad };
  }
  function renderChip() {
    var st = state(),
      chip = $("cmpChip"),
      cls = "",
      text;
    if (S.reportsErr) {
      cls = "missing";
      text = "directory unavailable";
    } else if (!S.sel.length) text = "no reports selected";
    else if (st.loading.length) {
      text =
        "loading " +
        (S.sel.length - st.loading.length) +
        " / " +
        S.sel.length +
        " reports\u2026";
    } else {
      cls = st.bad.length ? "missing" : "ok";
      text =
        st.ok.length +
        " of " +
        S.sel.length +
        " loaded" +
        (S.loadedAt
          ? " \u00b7 loaded at " +
            p2(S.loadedAt.getHours()) +
            ":" +
            p2(S.loadedAt.getMinutes()) +
            ":" +
            p2(S.loadedAt.getSeconds())
          : "");
    }
    if (S.rangeBad) {
      cls = "missing";
      text = "custom interval: To must be after From";
    }
    chip.className = "chip " + cls;
    $("cmpChipText").textContent = text;
    document.body.classList.toggle("busy", S.active && st.loading.length > 0);
  }
  function showEmpty(title, msg) {
    $("cmpEmptyTitle").textContent = title;
    $("cmpEmptyMsg").textContent = msg || "";
    $("cmpEmpty").hidden = false;
    $("cmpBody").hidden = true;
    S.focusKey = null;
  }
  function fmtDelta(d, isInt) {
    var f = isInt ? fmtInt : fmtNum,
      td = el("td"),
      abs,
      pct;
    if (d.abs === null) {
      td.className = "na";
      td.textContent = "\u2013";
      return td;
    }
    abs = (d.abs > 0 ? "+" : d.abs < 0 ? "\u2212" : "") + f(Math.abs(d.abs));
    pct =
      d.pct === null
        ? "n/a"
        : (d.pct > 0 ? "+" : d.pct < 0 ? "\u2212" : "") +
          Math.abs(d.pct).toFixed(1) +
          "%";
    td.className = d.abs > 0 ? "up" : d.abs < 0 ? "down" : "";
    td.textContent = abs + " (" + pct + ")";
    return td;
  }
  /* ---------- peak times, time lists and the chart marker ---------- */
  var LIST_PAGE = 200;
  function restoreFocus(rootEl) {
    var k = S.focusKey,
      f = null,
      all,
      i;
    S.focusKey = null;
    if (!k) return;
    all = rootEl.querySelectorAll("[data-k]");
    for (i = 0; i < all.length; i++)
      if (all[i].getAttribute("data-k") === k) f = all[i];
    if (f) f.focus();
  }
  function markTime(tok, sec) {
    var c = S.cache[tok],
      v;
    if (!c || !c.series) return;
    v = c.series[sec];
    if (v !== v) return;
    S.mark = { tok: tok, sec: sec };
    line.setMark({
      tok: tok,
      sec: sec,
      v: v,
      color: S.colors[tok],
      text: labelOf(tok) + ": " + fmtInt(v) + " at " + fmtHMS(sec),
    });
    render();
    $("c-cmp-line").scrollIntoView({ block: "nearest" });
  }
  function clearMark() {
    S.mark = null;
    if (line) line.setMark(null);
  }
  function resetPeakUi() {
    S.open = {};
    S.qOpen = {};
    clearMark();
  }
  function timeButton(tok, sec, scope) {
    var b = el("button", "ptime", fmtHMS(sec)),
      on = !!S.mark && S.mark.tok === tok && S.mark.sec === sec;
    b.type = "button";
    b.setAttribute("data-k", scope + ":t:" + tok + ":" + sec);
    b.title = "Mark " + fmtHMS(sec) + " on the chart";
    b.setAttribute("aria-pressed", on ? "true" : "false");
    if (on) b.className += " on";
    b.onclick = function () {
      S.focusKey = b.getAttribute("data-k");
      markTime(tok, sec);
    };
    return b;
  }
  /* Ascending times as buttons; at most `shown` of them, then a control that shows more. */
  function timeList(tok, times, shown, scope, more) {
    var box = el("div", "ptimes"),
      n = Math.min(shown, times.length),
      i,
      b;
    for (i = 0; i < n; i++) box.appendChild(timeButton(tok, times[i], scope));
    if (n < times.length) {
      b = el(
        "button",
        "pmore",
        fmtInt(times.length - n) +
          " not shown \u2013 show " +
          fmtInt(Math.min(LIST_PAGE, times.length - n)) +
          " more",
      );
      b.type = "button";
      b.setAttribute("data-k", scope + ":more:" + tok);
      b.onclick = function () {
        S.focusKey = b.getAttribute("data-k");
        more();
      };
      box.appendChild(b);
    }
    return box;
  }
  function peakAtCell(tok, s) {
    var td = el("td", "pk pkat"),
      extra = s.maxCount - 1,
      open = S.open[tok],
      b;
    td.appendChild(document.createTextNode(fmtHMS(s.maxAt)));
    if (extra > 0) {
      b = el("button", "pmore", open ? "hide" : "+" + fmtInt(extra) + " more");
      b.type = "button";
      b.setAttribute("data-k", "pk:o:" + tok);
      b.setAttribute("aria-expanded", open ? "true" : "false");
      b.title = open
        ? "Hide the times of the peak"
        : "The peak value occurred " + fmtInt(s.maxCount) + " times; show when";
      b.onclick = function () {
        S.focusKey = b.getAttribute("data-k");
        if (S.open[tok]) delete S.open[tok];
        else S.open[tok] = LIST_PAGE;
        render();
      };
      td.appendChild(b);
      if (open)
        td.appendChild(
          timeList(tok, s.maxTimes, open, "pk", function () {
            S.open[tok] = open + LIST_PAGE;
            render();
          }),
        );
    }
    return td;
  }
  function renderTable(rows, baseTok) {
    var t = $("cmpTable"),
      head = el("tr"),
      heads = [
        ["Base", ""],
        ["Report", "l"],
        ["Samples", ""],
        ["Avg", ""],
        ["Min", ""],
        ["Peak", "pk"],
        ["Peak at", "pk"],
        ["Count", "pk"],
        ["P95", ""],
        ["Total", ""],
        ["\u0394 Avg", ""],
        ["\u0394 Peak", ""],
        ["\u0394 Total", ""],
      ];
    t.textContent = "";
    heads.forEach(function (h, i) {
      var th = el("th", h[1], h[0]);
      if (i === 0) th.title = "Baseline for the \u0394 columns";
      if (h[0] === "Count")
        th.title = "Number of seconds at which the peak value occurred";
      head.appendChild(th);
    });
    var thead = el("thead");
    thead.appendChild(head);
    t.appendChild(thead);
    var body = el("tbody");
    S.sel.forEach(function (tok) {
      var tr = el("tr"),
        r = rows[tok],
        c = S.cache[tok],
        td,
        cb,
        dot;
      td = el("td", "l");
      if (r) {
        cb = el("input");
        cb.type = "radio";
        cb.name = "cmpBase";
        cb.checked = tok === baseTok;
        cb.setAttribute("aria-label", "Use " + labelOf(tok) + " as baseline");
        cb.onchange = function () {
          S.base = tok;
          render();
          persist();
        };
        td.appendChild(cb);
      }
      tr.appendChild(td);
      td = el("td", "rep l");
      dot = el("i");
      dot.style.background = S.colors[tok];
      td.appendChild(dot);
      td.appendChild(document.createTextNode(labelOf(tok)));
      tr.appendChild(td);
      if (!r) {
        td = el(
          "td",
          "na",
          c && (c.status === "missing" || c.status === "error")
            ? "unavailable: " + c.msg
            : "loading\u2026",
        );
        td.colSpan = 11;
        td.style.textAlign = "left";
        tr.appendChild(td);
        body.appendChild(tr);
        return;
      }
      var s = r.st;
      if (!s.count) {
        tr.className = "nodata";
        td = el("td", "na", "no data in interval");
        td.colSpan = 11;
        td.style.textAlign = "left";
        tr.appendChild(td);
      } else {
        [
          [fmtInt(s.count), ""],
          [fmtNum(s.avg), ""],
          [fmtNum(s.min), ""],
          [fmtNum(s.max), "pk"],
          null,
          [fmtInt(s.maxCount), "pk"],
          [fmtNum(s.p95), ""],
          [fmtInt(s.total), ""],
        ].forEach(function (x) {
          tr.appendChild(x ? el("td", x[1] || null, x[0]) : peakAtCell(tok, s));
        });
        if (tok === baseTok) {
          td = el("td", "na", "baseline");
          td.colSpan = 3;
          td.style.textAlign = "center";
          tr.appendChild(td);
        } else {
          var d = r.dl;
          tr.appendChild(fmtDelta(d.avg));
          tr.appendChild(fmtDelta(d.max));
          tr.appendChild(fmtDelta(d.total, true));
        }
      }
      if (tok === baseTok) tr.className += " base";
      body.appendChild(tr);
    });
    t.appendChild(body);
  }
  function renderLegend(okToks) {
    var box = $("cmpLegend");
    box.textContent = "";
    okToks.forEach(function (tok) {
      var b = el("button"),
        i = el("i");
      b.type = "button";
      b.className = S.hidden[tok] ? "off" : "";
      b.title =
        "Click to " + (S.hidden[tok] ? "show" : "hide") + " this series";
      b.setAttribute("aria-pressed", S.hidden[tok] ? "false" : "true");
      i.style.background = S.colors[tok];
      b.appendChild(i);
      b.appendChild(document.createTextNode(labelOf(tok)));
      b.onclick = function () {
        S.hidden[tok] = !S.hidden[tok];
        renderLegend(okToks);
        refreshCharts();
      };
      box.appendChild(b);
    });
  }
  var chartItems = [];
  function refreshCharts() {
    chartItems.forEach(function (it) {
      it.visible = !S.hidden[it.tok];
    });
    line.setItems(chartItems);
    bars.setItems(chartItems, S.range.from, S.range.to);
  }
  /* ---------- rate search ---------- */
  function renderSearch(st, rows) {
    var P = window.MPSPeaks,
      parsed = P.parseRate(S.q),
      msg = $("cQmsg"),
      t = $("cQtable"),
      head = el("tr"),
      body = el("tbody"),
      thead = el("thead");
    $("cQx").hidden = !S.q;
    t.textContent = "";
    msg.className = "smsg";
    if (parsed.empty) {
      msg.textContent = "";
      return;
    }
    if (!parsed.ok) {
      msg.textContent = parsed.error;
      msg.className = "smsg err";
      return;
    }
    msg.className = "smsg res";
    msg.textContent =
      "Rate " +
      parsed.label +
      " between " +
      fmtHMS(S.range.from) +
      " and " +
      fmtHMS(Math.min(S.range.to - 1, DAY - 1)) +
      ".";
    [
      ["Report", "l"],
      ["Matches", ""],
      ["First", ""],
      ["Last", ""],
      ["Times", ""],
    ].forEach(function (h) {
      head.appendChild(el("th", h[1] || null, h[0]));
    });
    thead.appendChild(head);
    t.appendChild(thead);
    S.sel.forEach(function (tok) {
      var tr = el("tr"),
        td = el("td", "rep l"),
        dot = el("i"),
        c = S.cache[tok],
        r,
        res,
        open,
        b;
      dot.style.background = S.colors[tok];
      td.appendChild(dot);
      td.appendChild(document.createTextNode(labelOf(tok)));
      tr.appendChild(td);
      if (st.ok.indexOf(tok) < 0 || !rows[tok]) {
        td = el(
          "td",
          "na",
          c && (c.status === "missing" || c.status === "error")
            ? "unavailable: " + c.msg
            : "loading\u2026",
        );
        td.colSpan = 4;
        td.style.textAlign = "left";
        tr.appendChild(td);
      } else if (!rows[tok].st.count) {
        td = el("td", "na", "no data in interval");
        td.colSpan = 4;
        td.style.textAlign = "left";
        tr.appendChild(td);
      } else {
        res = Core.search(c.series, S.range.from, S.range.to, parsed.test);
        tr.appendChild(el("td", "pk", fmtInt(res.count)));
        tr.appendChild(
          el("td", null, res.count ? fmtHMS(res.first) : "\u2013"),
        );
        tr.appendChild(el("td", null, res.count ? fmtHMS(res.last) : "\u2013"));
        td = el("td", "pkat");
        if (res.count) {
          open = S.qOpen[tok];
          b = el("button", "pmore", open ? "hide" : "show times");
          b.type = "button";
          b.setAttribute("data-k", "sr:o:" + tok);
          b.setAttribute("aria-expanded", open ? "true" : "false");
          b.onclick = function () {
            S.focusKey = b.getAttribute("data-k");
            if (S.qOpen[tok]) delete S.qOpen[tok];
            else S.qOpen[tok] = LIST_PAGE;
            render();
          };
          td.appendChild(b);
          if (open)
            td.appendChild(
              timeList(tok, res.times, open, "sr", function () {
                S.qOpen[tok] = open + LIST_PAGE;
                render();
              }),
            );
        } else td.textContent = "\u2013";
        tr.appendChild(td);
      }
      body.appendChild(tr);
    });
    t.appendChild(body);
  }
  function render() {
    if (!S.active) return;
    renderChip();
    var st = state(),
      issues = $("cmpIssues");
    if (S.mark && st.ok.indexOf(S.mark.tok) < 0) clearMark();
    if (S.reportsErr) {
      showEmpty("Cannot read the data directory", S.reportsErr);
      return;
    }
    if (!S.reports.length) {
      showEmpty(
        "No reports available",
        "No MPS files were found in the data directory.",
      );
      return;
    }
    if (S.sel.length < 2) {
      showEmpty(
        "Select at least two reports",
        "Open \u201cReports\u201d above and tick two to " +
          MAXR +
          " reports (any servers and dates) to compare them.",
      );
      return;
    }
    if (st.ok.length < 2) {
      if (st.loading.length) {
        showEmpty(
          "Loading reports\u2026",
          S.sel.length - st.loading.length + " of " + S.sel.length + " loaded.",
        );
      } else {
        showEmpty(
          "Fewer than two reports are available",
          st.bad
            .map(function (t) {
              return labelOf(t) + ": " + S.cache[t].msg;
            })
            .join(" \u2022 "),
        );
      }
      return;
    }
    $("cmpEmpty").hidden = true;
    $("cmpBody").hidden = false;

    issues.textContent = "";
    st.bad.forEach(function (t) {
      issues.appendChild(
        el("div", null, labelOf(t) + " is unavailable: " + S.cache[t].msg),
      );
    });
    issues.hidden = !st.bad.length;

    var baseTok = S.base && st.ok.indexOf(S.base) >= 0 ? S.base : st.ok[0],
      rows = {},
      base;
    chartItems = [];
    st.ok.forEach(function (tok) {
      var c = S.cache[tok];
      rows[tok] = { st: Core.stats(c.series, S.range.from, S.range.to) };
      chartItems.push({
        tok: tok,
        label: labelOf(tok),
        color: S.colors[tok],
        series: c.series,
        buckets: c.buckets,
        hourly: Core.hourly(c.series, S.range.from, S.range.to),
        visible: !S.hidden[tok],
      });
    });
    base = rows[baseTok].st;
    st.ok.forEach(function (tok) {
      rows[tok].dl = Core.deltas(rows[tok].st, base);
    });
    $("cmpRange").textContent =
      fmtHMS(S.range.from) +
      " \u2013 " +
      fmtHMS(Math.min(S.range.to - 1, DAY - 1)) +
      "  \u00b7  baseline: " +
      labelOf(baseTok);
    renderTable(rows, baseTok);
    renderLegend(st.ok);
    renderSearch(st, rows);
    refreshCharts();
    restoreFocus($("cmpBody"));
  }

  /* ---------- controls ---------- */
  function applyInterval(resetView) {
    var r = Core.intervalRange(
      S.iv,
      hmsSec($("cmpFrom").value),
      hmsSec($("cmpTo").value),
    );
    S.rangeBad = !r;
    if (r) {
      S.range = r;
      if (resetView) line.setDomain(r.from, r.to);
    }
  }
  function onPick(tokens) {
    S.sel = tokens;
    if (S.base && tokens.indexOf(S.base) < 0) S.base = null;
    clearMark();
    syncColors();
    pump();
    render();
    persist();
  }
  function init() {
    pick = MPSUI.multiPick($("cmpPick"), {
      max: MAXR,
      onChange: onPick,
      token: function (r) {
        return Core.token(r.ip, r.date, r.exchange, r.segment);
      },
    });
    ivSel = MPSUI.select($("cmpInterval"), {
      onChange: function (v) {
        S.iv = v;
        $("cmpCustom").hidden = v !== "custom";
        resetPeakUi();
        applyInterval(true);
        render();
        persist();
      },
    });
    ivSel.setItems(IV);
    ["cmpFrom", "cmpTo"].forEach(function (id) {
      $(id).addEventListener("change", function () {
        resetPeakUi();
        applyInterval(true);
        render();
        persist();
      });
    });
    line = LineChart($("c-cmp-line"));
    bars = BarChart($("c-cmp-hour"));
    $("cmpReset").onclick = function () {
      line.reset();
    };
    $("cmpRefresh").onclick = refresh;
    var qTimer = 0,
      applyQ = function () {
        clearTimeout(qTimer);
        S.q = $("cQ").value;
        S.qOpen = {};
        render();
      };
    $("cQ").addEventListener("input", function () {
      clearTimeout(qTimer);
      qTimer = setTimeout(applyQ, 200);
    });
    $("cQ").addEventListener("keydown", function (e) {
      if (e.key === "Enter") applyQ();
    });
    $("cQx").onclick = function () {
      $("cQ").value = "";
      applyQ();
      $("cQ").focus();
    };
    window.addEventListener("resize", function () {
      if (S.active) {
        line.redraw();
        bars.redraw();
      }
    });
  }
  function fetchReports() {
    return api("reports", {})
      .then(function (j) {
        S.reportsErr = j.error || null;
        setReports(j.reports || []);
      })
      .catch(function (e) {
        S.reportsErr =
          e instanceof TypeError ? "Server unreachable" : e.message;
        setReports([]);
      });
  }
  function refresh() {
    if (!S.active) return;
    resetLoads();
    resetPeakUi();
    S.loadedAt = null;
    fetchReports().then(function () {
      S.sel = validTokens(S.sel);
      syncColors();
      pick.setSelected(S.sel);
      pump();
      render();
      persist();
    });
  }
  function enter(h) {
    h = h || {};
    if (!S.inited) {
      init();
      S.inited = true;
    }
    S.active = true;
    var saved = loadSaved(),
      fromHash = h.m === "cmp",
      src = fromHash
        ? { c: (h.c || "").split(","), b: h.b, i: h.i, f: h.f, t: h.t }
        : saved;
    resetLoads();
    resetPeakUi();
    S.loadedAt = null;
    S.sel = [];
    S.base = null;
    renderChip();
    showEmpty("Loading\u2026", "");
    fetchReports().then(function () {
      if (!S.active) return;
      S.sel = validTokens(src.c);
      S.base =
        typeof src.b === "string" && S.sel.indexOf(src.b) >= 0 ? src.b : null;
      S.iv = IV.some(function (x) {
        return x.value === src.i;
      })
        ? src.i
        : "full";
      if (hmsSec(src.f) !== null) $("cmpFrom").value = src.f;
      if (hmsSec(src.t) !== null) $("cmpTo").value = src.t;
      $("cmpCustom").hidden = S.iv !== "custom";
      ivSel.setValue(S.iv);
      pick.setSelected(S.sel);
      syncColors();
      applyInterval(true);
      pump();
      render();
      persist();
    });
  }
  function leave() {
    S.active = false;
    resetLoads();
    resetPeakUi();
    pick && pick.close();
    document.body.classList.remove("busy");
  }

  root.MPSCompare = {
    enter: enter,
    leave: leave,
    isActive: function () {
      return S.active;
    },
  };
})(typeof window !== "undefined" ? window : {});
