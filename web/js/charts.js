/* Chart engine: line + bar + heatmap sharing one zoomable time axis, and the metric cards.
 * Public API: window.MPSChart (see bottom of file). Data loading / selectors live in app.js. */
window.MPSChart = (function () {
  "use strict";
  var $ = function (id) {
    return document.getElementById(id);
  };

  /* ---------- state ---------- */
  var M = { l: 58, r: 18, t: 14, b: 40 };
  var T = [],
    V = [];
  var total = 0,
    maxV = -Infinity,
    maxT = 0,
    maxTs = []; // every timestamp (ascending) at which the overall maximum occurred
  var step = null; // frozen peak stepping state: { kind, times, i, v }
  var changeCb = null,
    changeTimer = 0,
    changeKind = "";
  /* Debounced notice to the search UI: "view" = the user changed the window, "data" = samples changed. */
  function notifyChange(kind) {
    if (!changeCb) return;
    if (kind === "view" || !changeKind) changeKind = kind;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(function () {
      var k = changeKind;
      changeTimer = 0;
      changeKind = "";
      if (changeCb) changeCb(k);
    }, 150);
  }
  var dataStep = 1000;
  var view = { x0: 0, x1: 1 },
    target = { x0: 0, x1: 1 };
  var ymax = 1,
    ymaxT = 1,
    hmax = 1,
    grow = 1,
    introT = 0;
  var pin = null,
    lastStat = null,
    PIN_MS = 5000;
  var hover = { px: null, py: null, chart: -1 };
  var drag = null;
  var L = { w: 0, h: 0, pw: 10, ph: 10 };
  var raf = 0,
    lastTs = 0;

  var COL = {
    grid: "rgba(131,146,176,.14)",
    axis: "rgba(131,146,176,.4)",
    text: "#8392b0",
    dim: "#5d6b88",
  };

  /* ---------- helpers ---------- */
  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }
  function p2(n) {
    return (n < 10 ? "0" : "") + n;
  }
  function fmtTime(t, step) {
    var d = new Date(t),
      s = p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes());
    return step < 60000 ? s + ":" + p2(d.getUTCSeconds()) : s;
  }
  function fmtDate(t) {
    var d = new Date(t);
    return (
      d.getUTCFullYear() +
      "-" +
      p2(d.getUTCMonth() + 1) +
      "-" +
      p2(d.getUTCDate())
    );
  }
  function fmtFull(t) {
    return fmtDate(t) + " " + fmtTime(t, 1000);
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
  function fmtDur(ms) {
    var s = Math.round(ms / 1000),
      d = Math.floor(s / 86400),
      h = Math.floor((s % 86400) / 3600),
      m = Math.floor((s % 3600) / 60),
      r = [];
    s = s % 60;
    if (d) r.push(d + "d");
    if (h) r.push(h + "h");
    if (m) r.push(m + "m");
    if (s || !r.length) r.push(s + "s");
    return r.join(" ");
  }
  function niceStep(raw) {
    var e = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)),
      f = raw / e;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e;
  }
  function lowerBound(a, x) {
    var lo = 0,
      hi = a.length;
    while (lo < hi) {
      var m = (lo + hi) >> 1;
      if (a[m] < x) lo = m + 1;
      else hi = m;
    }
    return lo;
  }
  function rgba(c, a) {
    return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")";
  }
  function easeOut(p) {
    return 1 - Math.pow(1 - p, 3);
  }

  var HSTOPS = [
    [0, [12, 16, 48]],
    [0.25, [64, 48, 140]],
    [0.5, [181, 54, 122]],
    [0.75, [240, 120, 48]],
    [1, [252, 230, 110]],
  ];
  var HLUT = (function () {
    var out = [],
      i,
      s,
      p,
      a,
      b,
      f,
      ch;
    for (i = 0; i < 256; i++) {
      p = i / 255;
      s = 1;
      while (s < HSTOPS.length - 1 && p > HSTOPS[s][0]) s++;
      a = HSTOPS[s - 1];
      b = HSTOPS[s];
      f = (p - a[0]) / (b[0] - a[0]);
      ch = [0, 1, 2].map(function (j) {
        return Math.round(a[1][j] + (b[1][j] - a[1][j]) * f);
      });
      out.push("rgb(" + ch.join(",") + ")");
    }
    return out;
  })();
  function heatColor(r) {
    return HLUT[Math.round(clamp(r, 0, 1) * 255)];
  }
  var HEMPTY = "rgba(131,146,176,.07)";
  var HG = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080];

  /* ---------- bounds / view ---------- */
  function bLo() {
    return T[0] - dataStep / 2;
  }
  function bHi() {
    return T[T.length - 1] + dataStep / 2;
  }
  function minSpan() {
    return Math.max(4000, dataStep * 5);
  }
  function clampTarget() {
    if (!T.length) return;
    var lo = bLo(),
      hi = bHi(),
      full = Math.max(hi - lo, minSpan());
    var span = clamp(target.x1 - target.x0, minSpan(), full);
    var x0 = target.x0;
    if (x0 + span > hi) x0 = hi - span;
    if (x0 < lo) x0 = lo;
    target.x0 = x0;
    target.x1 = x0 + span;
  }
  function isFollowing() {
    return T.length > 0 && target.x1 >= bHi() - 1;
  }
  function setFull() {
    step = null;
    notifyChange("view");
    target.x0 = bLo();
    target.x1 = bHi();
    clampTarget();
    requestRender();
  }
  function setWindow(spanMs) {
    if (!T.length) return;
    step = null;
    notifyChange("view");
    target.x1 = bHi();
    target.x0 = target.x1 - spanMs;
    clampTarget();
    requestRender();
  }
  function setRange(x0, x1) {
    if (!T.length) return;
    step = null;
    notifyChange("view");
    target.x0 = x0;
    target.x1 = x1;
    clampTarget();
    requestRender();
  }
  function resetData() {
    T = [];
    V = [];
    total = 0;
    maxV = -Infinity;
    maxT = 0;
    maxTs = [];
    step = null;
    notifyChange("data");
    pin = null;
    lastStat = null;
    dataStep = 1000;
    hover.px = null;
    hover.py = null;
    requestRender();
  }

  /* ---------- data ---------- */
  function calcStep() {
    var n = T.length;
    if (n < 2) {
      dataStep = 1000;
      return;
    }
    var d = [],
      from = Math.max(1, n - 200);
    for (var i = from; i < n; i++) {
      var x = T[i] - T[i - 1];
      if (x > 0) d.push(x);
    }
    if (!d.length) {
      dataStep = 1000;
      return;
    }
    d.sort(function (a, b) {
      return a - b;
    });
    dataStep = d[d.length >> 1];
  }
  function sortData() {
    var idx = T.map(function (_, i) {
      return i;
    });
    idx.sort(function (a, b) {
      return T[a] - T[b];
    });
    var nt = new Array(idx.length),
      nv = new Array(idx.length);
    for (var i = 0; i < idx.length; i++) {
      nt[i] = T[idx[i]];
      nv[i] = V[idx[i]];
    }
    T = nt;
    V = nv;
  }
  function appendPoints(p) {
    var had = T.length > 0,
      oldLo = had ? bLo() : 0,
      oldHi = had ? bHi() : 0;
    var wasEnd = had && target.x1 >= oldHi - 1,
      wasStart = had && target.x0 <= oldLo + 1;
    var unsorted = false,
      last = had ? T[T.length - 1] : -Infinity;
    for (var i = 0; i < p.length; i += 2) {
      var t = p[i],
        v = p[i + 1];
      if (t < last) unsorted = true;
      else last = t;
      T.push(t);
      V.push(v);
      total += v;
      if (v > maxV) {
        maxV = v;
        maxT = t;
        maxTs = [t];
      } else if (v === maxV) maxTs.push(t);
    }
    if (p.length) {
      step = null;
      notifyChange("data");
    }
    if (unsorted) {
      sortData();
      maxTs.sort(function (a, b) {
        return a - b;
      });
      if (maxTs.length) maxT = maxTs[0];
    }
    calcStep();
    if (!had) {
      target.x0 = bLo();
      target.x1 = bHi();
      view.x0 = target.x0;
      view.x1 = target.x1;
      grow = 0;
      introT = performance.now();
    } else if (wasEnd) {
      if (wasStart) {
        target.x0 = bLo();
        target.x1 = bHi();
      } else {
        var d = bHi() - oldHi;
        target.x0 += d;
        target.x1 += d;
      }
    }
    clampTarget();
    requestRender();
  }
  /* ---------- stats ---------- */
  var els = {};
  [
    "latest",
    "latest-t",
    "wavg",
    "wmax",
    "wmax-t",
    "wmax-c",
    "wmax-h",
    "wsum",
    "avg",
    "max",
    "max-t",
    "max-c",
    "max-h",
    "total",
    "n",
  ].forEach(function (k) {
    els[k] = $("s-" + k);
  });
  var cardEl = {},
    cardTitle = {};
  function setT(e, s) {
    if (e.textContent !== s) e.textContent = s;
  }
  /* Peak cards: count of occurrences, and the frozen "k of N" position while stepping. */
  function peakCard(kind, id, live) {
    var lab = "",
      hint = "",
      ttl = cardTitle[kind],
      N;
    if (step && step.kind === kind) {
      N = step.times.length;
      lab = " \u00d7" + N;
      hint = "Next peak (" + (step.i + 1) + " of " + N + ")";
      ttl = "Click to go to the next of the " + N + " occurrences of this peak";
    } else if (live > 1) {
      lab = " \u00d7" + live;
      hint = "Click for next peak";
      ttl = "This peak occurred " + live + " times; click to step through them";
    }
    setT(els[id + "-c"], lab);
    setT(els[id + "-h"], hint);
    if (cardEl[kind] && ttl !== undefined && cardEl[kind].title !== ttl)
      cardEl[kind].title = ttl;
  }
  function updateStats(S) {
    var n = T.length,
      st = S.stat;
    setT(els.latest, n ? fmtInt(V[n - 1]) : "\u2013");
    setT(els["latest-t"], n ? fmtFull(T[n - 1]) : "\u00a0");
    setT(els["wmax-t"], st.n ? fmtFull(st.maxT) : "\u00a0");
    setT(els["max-t"], n ? fmtFull(maxT) : "\u00a0");
    peakCard("wpeak", "wmax", st.n ? st.cnt : 0);
    peakCard("peak", "max", n ? maxTs.length : 0);
    setT($("hmax"), fmtInt(hmax));
    setT(
      $("hsub"),
      S.heat
        ? "column = " + fmtDur(S.heat.colMs) + " \u00b7 row = second of minute"
        : "",
    );
    setT(els.wavg, st.n ? fmtNum(st.sum / st.n) : "\u2013");
    setT(els.wmax, st.n ? fmtInt(st.max) : "\u2013");
    setT(els.wsum, st.n ? fmtInt(st.sum) : "\u2013");
    setT(els.avg, n ? fmtNum(total / n) : "\u2013");
    setT(els.max, n ? fmtInt(maxV) : "\u2013");
    setT(els.total, n ? fmtInt(total) : "\u2013");
    setT(els.n, fmtInt(n));
    setT(
      $("range"),
      n
        ? fmtFull(view.x0) +
            "  \u2192  " +
            fmtFull(view.x1) +
            "   (" +
            fmtDur(view.x1 - view.x0) +
            ")"
        : "\u00a0",
    );
  }

  /* ---------- series (raw or binned to ~2px) ---------- */
  function computeSeries(pw) {
    var S = {
      x: [],
      avg: [],
      min: [],
      max: [],
      cnt: [],
      binned: false,
      bw: 0,
      stat: { n: 0, sum: 0, max: 0, maxT: 0, cnt: 0 },
    };
    var n = T.length;
    if (!n) return S;
    var span = view.x1 - view.x0;
    var i0 = Math.max(0, lowerBound(T, view.x0 - dataStep) - 1);
    var i1 = Math.min(n - 1, lowerBound(T, view.x1 + dataStep));
    var nb = Math.max(1, Math.floor(pw / 2)),
      st = S.stat,
      i,
      v,
      t;
    st.max = -Infinity;
    if (i1 - i0 + 1 <= nb) {
      for (i = i0; i <= i1; i++) {
        t = T[i];
        v = V[i];
        S.x.push(t);
        S.avg.push(v);
        S.min.push(v);
        S.max.push(v);
        S.cnt.push(1);
        if (t >= view.x0 && t <= view.x1) {
          st.n++;
          st.sum += v;
          if (v > st.max) {
            st.max = v;
            st.maxT = t;
            st.cnt = 1;
          } else if (v === st.max) st.cnt++;
        }
      }
    } else {
      var bw = span / nb,
        k = NaN,
        sum = 0,
        c = 0,
        mn = 0,
        mx = 0;
      S.binned = true;
      S.bw = bw;
      var flush = function () {
        if (!c) return;
        S.x.push((k + 0.5) * bw);
        S.avg.push(sum / c);
        S.min.push(mn);
        S.max.push(mx);
        S.cnt.push(c);
      };
      for (i = i0; i <= i1; i++) {
        t = T[i];
        v = V[i];
        var kk = Math.floor(t / bw);
        if (kk !== k) {
          flush();
          k = kk;
          sum = 0;
          c = 0;
          mn = Infinity;
          mx = -Infinity;
        }
        sum += v;
        c++;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
        if (t >= view.x0 && t <= view.x1) {
          st.n++;
          st.sum += v;
          if (v > st.max) {
            st.max = v;
            st.maxT = t;
            st.cnt = 1;
          } else if (v === st.max) st.cnt++;
        }
      }
      flush();
    }
    return S;
  }
  function segments(S) {
    var thr = Math.max(dataStep * 5.5, S.binned ? S.bw * 3 : 0),
      segs = [],
      s = 0,
      i;
    for (i = 1; i < S.x.length; i++)
      if (S.x[i] - S.x[i - 1] > thr) {
        segs.push([s, i - 1]);
        s = i;
      }
    if (S.x.length) segs.push([s, S.x.length - 1]);
    return segs;
  }

  /* ---------- heatmap grid: column = N minutes, row = second of minute ---------- */
  function computeHeat(pw) {
    if (!T.length) return null;
    var span = view.x1 - view.x0,
      need = 2 / ((pw * 60000) / span),
      g = HG[HG.length - 1],
      i,
      k;
    for (i = 0; i < HG.length; i++)
      if (HG[i] >= need) {
        g = HG[i];
        break;
      }
    var colMs = g * 60000,
      c0 = Math.floor(view.x0 / colMs),
      c1 = Math.floor(view.x1 / colMs),
      nc = c1 - c0 + 1;
    var sum = new Float64Array(nc * 60),
      cnt = new Uint32Array(nc * 60),
      mx = 0;
    var i0 = lowerBound(T, c0 * colMs),
      i1 = lowerBound(T, (c1 + 1) * colMs);
    for (i = i0; i < i1; i++) {
      var t = T[i];
      k = (Math.floor(t / colMs) - c0) * 60 + Math.floor((t % 60000) / 1000);
      sum[k] += V[i];
      cnt[k]++;
    }
    for (k = 0; k < cnt.length; k++)
      if (cnt[k]) {
        var a = sum[k] / cnt[k];
        if (a > mx) mx = a;
      }
    return { g: g, colMs: colMs, c0: c0, nc: nc, sum: sum, cnt: cnt, max: mx };
  }
  function heatCell(H, t) {
    var i = Math.floor(t / H.colMs) - H.c0;
    return i >= 0 && i < H.nc
      ? { i: i, r: Math.floor((t % 60000) / 1000) }
      : null;
  }
  function cellRect(H, i, r) {
    var rowH = L.ph / 60;
    var xa = Math.floor(X((H.c0 + i) * H.colMs)),
      xb = Math.ceil(X((H.c0 + i + 1) * H.colMs));
    var ya = Math.floor(M.t + r * rowH),
      yb = Math.ceil(M.t + (r + 1) * rowH);
    return { x: xa, y: ya, w: Math.max(1, xb - xa), h: Math.max(1, yb - ya) };
  }

  /* ---------- coordinate transforms ---------- */
  function X(t) {
    return M.l + ((t - view.x0) / (view.x1 - view.x0)) * L.pw;
  }
  function Y(v) {
    return M.t + L.ph - (v / ymax) * L.ph * grow;
  }
  function base() {
    return M.t + L.ph;
  }

  /* ---------- chart painters ---------- */
  function drawLine(g, S, c) {
    var i,
      segs = segments(S);
    if (S.binned) {
      g.strokeStyle = rgba(c, 0.28);
      g.lineWidth = 1;
      g.beginPath();
      for (i = 0; i < S.x.length; i++) {
        var x = Math.round(X(S.x[i])) + 0.5;
        g.moveTo(x, Y(S.max[i]));
        g.lineTo(x, Y(S.min[i]));
      }
      g.stroke();
    }
    g.strokeStyle = rgba(c, 1);
    g.lineWidth = 2;
    g.lineJoin = "round";
    segs.forEach(function (sg) {
      g.beginPath();
      for (i = sg[0]; i <= sg[1]; i++) {
        if (i === sg[0]) g.moveTo(X(S.x[i]), Y(S.avg[i]));
        else g.lineTo(X(S.x[i]), Y(S.avg[i]));
      }
      g.stroke();
    });
    var dense = S.x.length > 1 ? X(S.x[1]) - X(S.x[0]) : 99;
    g.fillStyle = rgba(c, 1);
    segs.forEach(function (sg) {
      if (!S.binned && (dense > 9 || sg[0] === sg[1])) {
        for (i = sg[0]; i <= sg[1]; i++) {
          g.beginPath();
          g.arc(X(S.x[i]), Y(S.avg[i]), 2.6, 0, 6.2832);
          g.fill();
        }
      }
    });
  }
  function drawHeat(g, S) {
    var H = S.heat;
    if (!H) return;
    var rowH = L.ph / 60,
      gy = rowH > 4 ? 1 : 0,
      i,
      r,
      k,
      cnt;
    g.globalAlpha = grow;
    for (i = 0; i < H.nc; i++) {
      var xa = Math.floor(X((H.c0 + i) * H.colMs)),
        xb = Math.ceil(X((H.c0 + i + 1) * H.colMs));
      if (xb < M.l || xa > M.l + L.pw) continue;
      var gx = xb - xa > 5 ? 1 : 0;
      for (r = 0; r < 60; r++) {
        k = i * 60 + r;
        cnt = H.cnt[k];
        var ya = Math.floor(M.t + r * rowH),
          yb = Math.ceil(M.t + (r + 1) * rowH);
        g.fillStyle = cnt ? heatColor(H.sum[k] / cnt / hmax) : HEMPTY;
        g.fillRect(xa, ya, xb - xa - gx, yb - ya - gy);
      }
    }
    g.globalAlpha = 1;
  }
  function drawBar(g, S, c) {
    var ppm = L.pw / (view.x1 - view.x0),
      b = base(),
      i,
      w;
    if (S.binned) {
      w = Math.max(1, S.bw * ppm);
      g.fillStyle = rgba(c, 0.3);
      for (i = 0; i < S.x.length; i++) {
        var yM = Y(S.max[i]);
        g.fillRect(X(S.x[i]) - w / 2, yM, w, b - yM);
      }
      g.fillStyle = rgba(c, 1);
      for (i = 0; i < S.x.length; i++) {
        var yA = Y(S.avg[i]);
        g.fillRect(X(S.x[i]) - w / 2, yA, w, b - yA);
      }
    } else {
      w = Math.max(1, dataStep * ppm * (dataStep * ppm > 4 ? 0.8 : 1));
      g.fillStyle = rgba(c, 1);
      for (i = 0; i < S.x.length; i++) {
        var y = Y(S.avg[i]);
        g.fillRect(X(S.x[i]) - w / 2, y, w, b - y);
      }
    }
  }

  /* ---------- axes ---------- */
  var STEPS = [
    1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600,
    43200, 86400, 172800, 604800,
  ].map(function (s) {
    return s * 1000;
  });
  function timeTicks() {
    var span = view.x1 - view.x0,
      want = Math.max(2, L.pw / 120),
      step = STEPS[STEPS.length - 1],
      i,
      out = [];
    for (i = 0; i < STEPS.length; i++)
      if (span / STEPS[i] <= want) {
        step = STEPS[i];
        break;
      }
    for (var t = Math.ceil(view.x0 / step) * step; t <= view.x1; t += step)
      out.push(t);
    return { step: step, ticks: out };
  }
  function drawAxes(g, c, tt) {
    var b = base(),
      right = c.w - M.r,
      i;
    g.font = '11px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
    g.lineWidth = 1;
    // y
    var ystep = niceStep(ymax / Math.max(2, L.ph / 42));
    g.textAlign = "right";
    g.textBaseline = "middle";
    if (c.heat) {
      [0, 15, 30, 45, 59].forEach(function (s) {
        g.fillStyle = COL.text;
        g.fillText(":" + p2(s), M.l - 8, M.t + ((s + 0.5) / 60) * L.ph);
      });
    } else {
      for (i = 0; i * ystep <= ymax; i++) {
        var v = i * ystep,
          y = Math.round(b - (v / ymax) * L.ph) + 0.5;
        g.strokeStyle = COL.grid;
        g.beginPath();
        g.moveTo(M.l, y);
        g.lineTo(right, y);
        g.stroke();
        g.fillStyle = COL.text;
        g.fillText(fmtY(v), M.l - 8, y);
      }
    }
    // x
    g.textAlign = "center";
    g.textBaseline = "top";
    tt.ticks.forEach(function (t, idx) {
      var x = Math.round(X(t)) + 0.5;
      if (x < M.l || x > right) return;
      g.strokeStyle = c.heat ? COL.axis : COL.grid;
      g.beginPath();
      g.moveTo(x, c.heat ? b : M.t);
      g.lineTo(x, c.heat ? b + 4 : b);
      g.stroke();
      if (tt.step >= 86400000) {
        g.fillStyle = COL.text;
        g.fillText(fmtDate(t), x, b + 7);
        return;
      }
      g.fillStyle = COL.text;
      g.fillText(fmtTime(t, tt.step), x, b + 7);
      if (idx === 0 || t % 86400000 === 0) {
        g.fillStyle = COL.dim;
        g.fillText(fmtDate(t), x, b + 21);
      }
    });
    g.strokeStyle = COL.axis;
    g.beginPath();
    g.moveTo(M.l + 0.5, M.t);
    g.lineTo(M.l + 0.5, b + 0.5);
    g.lineTo(right, b + 0.5);
    g.stroke();
  }

  /* ---------- hover ---------- */
  function rrect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.lineTo(x + w - r, y);
    g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r);
    g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h);
    g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r);
    g.quadraticCurveTo(x, y, x + r, y);
    g.closePath();
  }
  function drawHover(g, c, ci, S) {
    if (hover.px === null) return;
    if (c.heat) {
      drawHeatHover(g, c, S.heat);
      return;
    }
    if (!S.x.length) return;
    var t = view.x0 + ((hover.px - M.l) / L.pw) * (view.x1 - view.x0);
    var i = lowerBound(S.x, t);
    if (i >= S.x.length) i = S.x.length - 1;
    else if (i > 0 && t - S.x[i - 1] < S.x[i] - t) i--;
    var x = X(S.x[i]);
    if (Math.abs(x - hover.px) > 45) return;
    var y = Y(S.avg[i]),
      b = base();
    g.save();
    g.setLineDash([4, 4]);
    g.strokeStyle = "rgba(219,227,243,.45)";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(Math.round(x) + 0.5, M.t);
    g.lineTo(Math.round(x) + 0.5, b);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = "#fff";
    g.strokeStyle = rgba(c.rgb, 1);
    g.lineWidth = 2;
    g.beginPath();
    g.arc(x, y, 4, 0, 6.2832);
    g.fill();
    g.stroke();
    if (ci === hover.chart) {
      var lines;
      if (S.binned) {
        lines = [
          fmtFull(S.x[i] - S.bw / 2) +
            " \u2192 " +
            fmtTime(S.x[i] + S.bw / 2, 1000),
          "avg  " + fmtNum(S.avg[i]),
          "min  " + fmtInt(S.min[i]),
          "max  " + fmtInt(S.max[i]),
          "samples  " + S.cnt[i],
        ];
      } else {
        lines = [fmtFull(S.x[i]), "msgs/s  " + fmtNum(S.avg[i])];
      }
      drawTip(g, c, lines, x, y, c.rgb);
    }
    g.restore();
  }
  function drawTip(g, c, lines, x, y, rgb) {
    var w = 0,
      j,
      b = base();
    g.save();
    g.font = '12px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
    for (j = 0; j < lines.length; j++)
      w = Math.max(w, g.measureText(lines[j]).width);
    w += 18;
    var h = lines.length * 17 + 10;
    var bx = x + 14;
    if (bx + w > c.w - 4) bx = x - 14 - w;
    var by = clamp(y - h / 2, M.t, Math.max(M.t, b - h));
    rrect(g, bx, by, w, h, 6);
    g.fillStyle = "rgba(8,12,22,.94)";
    g.fill();
    g.strokeStyle = rgba(rgb, 0.7);
    g.lineWidth = 1;
    g.stroke();
    g.textAlign = "left";
    g.textBaseline = "top";
    for (j = 0; j < lines.length; j++) {
      g.fillStyle = j === 0 ? "#fff" : COL.text;
      g.fillText(lines[j], bx + 9, by + 6 + j * 17);
    }
    g.restore();
  }
  function drawHeatHover(g, c, H) {
    if (!H) return;
    var span = view.x1 - view.x0,
      t = view.x0 + ((hover.px - M.l) / L.pw) * span,
      cell,
      own = charts[hover.chart] === c;
    if (own) {
      if (hover.py === null) return;
      var row = Math.floor(((hover.py - M.t) / L.ph) * 60),
        col = Math.floor(t / H.colMs) - H.c0;
      if (row < 0 || row > 59 || col < 0 || col >= H.nc) return;
      cell = { i: col, r: row };
    } else {
      var j = lowerBound(T, t);
      if (j >= T.length) j = T.length - 1;
      else if (j > 0 && t - T[j - 1] < T[j] - t) j--;
      if ((Math.abs(T[j] - t) / span) * L.pw > 45) return;
      cell = heatCell(H, T[j]);
      if (!cell) return;
    }
    var r = cellRect(H, cell.i, cell.r);
    g.save();
    g.strokeStyle = "#fff";
    g.lineWidth = 1.5;
    g.strokeRect(r.x - 0.5, r.y - 0.5, r.w + 1, r.h + 1);
    g.restore();
    if (!own) return;
    var k = cell.i * 60 + cell.r,
      cnt = H.cnt[k],
      cs = (H.c0 + cell.i) * H.colMs,
      lines;
    if (H.g === 1) {
      lines = [
        fmtFull(cs + cell.r * 1000),
        cnt ? "msgs/s  " + fmtNum(H.sum[k] / cnt) : "no data",
      ];
    } else {
      lines = [
        fmtFull(cs) + " \u2192 " + fmtTime(cs + H.colMs, 1000),
        "second  :" + p2(cell.r),
        cnt ? "avg  " + fmtNum(H.sum[k] / cnt) : "no data",
      ];
      if (cnt) lines.push("samples  " + cnt);
    }
    drawTip(g, c, lines, r.x + r.w / 2, r.y + r.h / 2, [255, 255, 255]);
  }
  function drawPin(g, c, S) {
    if (!pin) return;
    var age = performance.now() - pin.at;
    if (age > PIN_MS) {
      pin = null;
      return;
    }
    var fade = age > PIN_MS - 1000 ? (PIN_MS - age) / 1000 : 1,
      pulse = (age % 1000) / 1000,
      x = X(pin.t),
      col = pin.rgb,
      cx,
      cy;
    if (x < M.l - 2 || x > M.l + L.pw + 2) return;
    g.save();
    g.globalAlpha = fade;
    if (c.heat) {
      var H = S.heat,
        cell = H && heatCell(H, pin.t);
      if (!cell) {
        g.restore();
        return;
      }
      var r = cellRect(H, cell.i, cell.r),
        e = pulse * 8;
      g.strokeStyle = rgba(col, 1);
      g.lineWidth = 2;
      g.strokeRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
      g.globalAlpha = fade * (1 - pulse);
      g.strokeRect(r.x - 1 - e, r.y - 1 - e, r.w + 2 + 2 * e, r.h + 2 + 2 * e);
      g.globalAlpha = fade;
      cx = r.x + r.w / 2;
      cy = r.y + r.h / 2;
    } else {
      cx = x;
      cy = Y(pin.v);
      g.setLineDash([4, 4]);
      g.strokeStyle = rgba(col, 0.8);
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(Math.round(x) + 0.5, M.t);
      g.lineTo(Math.round(x) + 0.5, base());
      g.stroke();
      g.setLineDash([]);
      g.globalAlpha = fade * (1 - pulse);
      g.strokeStyle = rgba(col, 1);
      g.lineWidth = 2;
      g.beginPath();
      g.arc(cx, cy, 6 + pulse * 12, 0, 6.2832);
      g.stroke();
      g.globalAlpha = fade;
      g.fillStyle = rgba(col, 1);
      g.strokeStyle = "#fff";
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(cx, cy, 5, 0, 6.2832);
      g.fill();
      g.stroke();
    }
    drawTip(g, c, pin.lines, cx, cy, col);
    g.restore();
  }

  /* ---------- render loop ---------- */
  function render(S, tt) {
    charts.forEach(function (c, ci) {
      var g = c.g;
      L.w = c.w;
      L.h = c.h;
      L.pw = Math.max(10, c.w - M.l - M.r);
      L.ph = Math.max(10, c.h - M.t - M.b);
      g.clearRect(0, 0, c.w, c.h);
      drawAxes(g, c, tt);
      g.save();
      g.beginPath();
      g.rect(M.l, M.t - 2, L.pw, L.ph + 2);
      g.clip();
      c.draw(g, S, c.rgb);
      g.restore();
      drawPin(g, c, S);
      drawHover(g, c, ci, S);
    });
  }
  function frame() {
    raf = 0;
    var now = performance.now(),
      dt = lastTs ? Math.min(100, now - lastTs) : 16,
      busy = false;
    lastTs = now;
    var k = 1 - Math.exp(-dt / 90),
      span = Math.max(1, target.x1 - target.x0);
    if (
      Math.abs(target.x0 - view.x0) > span * 1e-4 ||
      Math.abs(target.x1 - view.x1) > span * 1e-4
    ) {
      view.x0 += (target.x0 - view.x0) * k;
      view.x1 += (target.x1 - view.x1) * k;
      busy = true;
    } else {
      view.x0 = target.x0;
      view.x1 = target.x1;
    }
    if (introT) {
      var p = Math.min(1, (now - introT) / 900);
      grow = easeOut(p);
      if (p < 1) busy = true;
      else introT = 0;
    }
    var c0 = charts[0];
    L.pw = Math.max(10, c0.w - M.l - M.r);
    L.ph = Math.max(10, c0.h - M.t - M.b);
    var S = computeSeries(L.pw);
    S.heat = computeHeat(L.pw);
    lastStat = S.stat;
    ymaxT = Math.max(1, (S.stat.n ? S.stat.max : maxV) * 1.1);
    if (Math.abs(ymaxT - ymax) > ymaxT * 0.002) {
      ymax += (ymaxT - ymax) * k;
      busy = true;
    } else ymax = ymaxT;
    var hT = Math.max(1, S.heat ? S.heat.max : 1);
    if (Math.abs(hT - hmax) > hT * 0.002) {
      hmax += (hT - hmax) * k;
      busy = true;
    } else hmax = hT;
    render(S, T.length ? timeTicks() : { step: 1000, ticks: [] });
    if (pin) busy = true;
    updateStats(S);
    if (busy) requestRender();
    else lastTs = 0;
  }
  function requestRender() {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  /* ---------- canvases / events ---------- */
  function resize(c) {
    var r = c.cv.parentNode.getBoundingClientRect(),
      dpr = window.devicePixelRatio || 1;
    c.w = Math.max(100, Math.floor(r.width));
    c.h = Math.max(100, Math.floor(r.height));
    c.cv.width = Math.round(c.w * dpr);
    c.cv.height = Math.round(c.h * dpr);
    c.g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  var charts = [
    { key: "line", rgb: [76, 201, 240], draw: drawLine },
    { key: "bar", rgb: [249, 160, 63], draw: drawBar },
    { key: "heat", rgb: [240, 120, 48], draw: drawHeat, heat: true },
  ];
  charts.forEach(function (c, ci) {
    var cv = (c.cv = $("c-" + c.key));
    c.g = cv.getContext("2d");
    resize(c);
    cv.addEventListener(
      "wheel",
      function (e) {
        if (!T.length) return;
        e.preventDefault();
        step = null;
        notifyChange("view");
        var dy = e.deltaY,
          dx = e.deltaX;
        if (e.deltaMode === 1) {
          dy *= 16;
          dx *= 16;
        }
        var span = target.x1 - target.x0;
        if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
          var d = ((dy || dx) / L.pw) * span;
          target.x0 += d;
          target.x1 += d;
        } else {
          var frac = clamp((e.offsetX - M.l) / L.pw, 0, 1),
            anchor = target.x0 + frac * span;
          var ns = clamp(
            span * Math.exp(dy * 0.0015),
            minSpan(),
            Math.max(bHi() - bLo(), minSpan()),
          );
          target.x0 = anchor - frac * ns;
          target.x1 = target.x0 + ns;
        }
        clampTarget();
        requestRender();
      },
      { passive: false },
    );
    cv.addEventListener("pointerdown", function (e) {
      if (e.button !== 0 || !T.length) return;
      drag = { x: e.clientX, x0: target.x0, x1: target.x1 };
      cv.setPointerCapture(e.pointerId);
      cv.classList.add("grab");
    });
    cv.addEventListener("pointermove", function (e) {
      if (drag) {
        step = null;
        notifyChange("view");
        var dt = (-(e.clientX - drag.x) / L.pw) * (drag.x1 - drag.x0);
        target.x0 = drag.x0 + dt;
        target.x1 = drag.x1 + dt;
        clampTarget();
        view.x0 = target.x0;
        view.x1 = target.x1;
      }
      var px = e.offsetX;
      hover.px = px >= M.l && px <= c.w - M.r ? px : null;
      hover.py = e.offsetY;
      hover.chart = ci;
      requestRender();
    });
    function endDrag() {
      drag = null;
      cv.classList.remove("grab");
    }
    cv.addEventListener("pointerup", endDrag);
    cv.addEventListener("pointercancel", endDrag);
    cv.addEventListener("pointerleave", function () {
      hover.px = null;
      requestRender();
    });
    cv.addEventListener("dblclick", setFull);
  });
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(function () {
      charts.forEach(resize);
      requestRender();
    });
    charts.forEach(function (c) {
      ro.observe(c.cv.parentNode);
    });
  } else {
    window.addEventListener("resize", function () {
      charts.forEach(resize);
      requestRender();
    });
  }

  /* ---------- metric cards: jump to the sample ---------- */
  /* Times (ascending) at which the window maximum occurs, inside the current animated view. */
  function windowPeakTimes() {
    var out = [],
      i = lowerBound(T, view.x0),
      m = lastStat.max;
    for (; i < T.length && T[i] <= view.x1; i++) if (V[i] === m) out.push(T[i]);
    return out;
  }
  function goTo(kind) {
    var n = T.length,
      t,
      v,
      rgb,
      label,
      pos = "",
      times;
    if (!n) return;
    if (kind === "latest") {
      step = null;
      t = T[n - 1];
      v = V[n - 1];
      rgb = [61, 220, 132];
      label = "Latest";
    } else {
      if (kind === "peak") {
        rgb = [255, 107, 107];
        label = "Overall peak";
      } else {
        if (!lastStat || !lastStat.n) return;
        rgb = [255, 184, 77];
        label = "Window peak";
      }
      if (step && step.kind !== kind) step = null;
      if (step) step.i = (step.i + 1) % step.times.length;
      else {
        times = kind === "peak" ? maxTs : windowPeakTimes();
        v = kind === "peak" ? maxV : lastStat.max;
        if (times.length > 1) step = { kind: kind, times: times, i: 0, v: v };
      }
      if (step) {
        t = step.times[step.i];
        v = step.v;
        pos = "  (" + (step.i + 1) + " of " + step.times.length + ")";
      } else t = kind === "peak" ? maxT : lastStat.maxT;
    }
    showAt(t, v, rgb, label + "  " + fmtInt(v) + pos, kind === "latest");
  }
  /* Centre the charts on a sample (span capped at 2 minutes) and pin a marker on it. */
  function showAt(t, v, rgb, head, latest) {
    var span = Math.max(minSpan(), Math.min(target.x1 - target.x0, 120000));
    if (latest) {
      target.x1 = bHi();
      target.x0 = target.x1 - span;
    } else {
      target.x0 = t - span / 2;
      target.x1 = t + span / 2;
    }
    clampTarget();
    pin = {
      t: t,
      v: v,
      rgb: rgb,
      lines: [head, fmtFull(t)],
      at: performance.now(),
    };
    requestRender();
  }
  Array.prototype.forEach.call(
    document.querySelectorAll(".card[data-go]"),
    function (el) {
      var kind = el.getAttribute("data-go");
      cardEl[kind] = el;
      cardTitle[kind] = el.getAttribute("title");
      el.onclick = function () {
        goTo(kind);
      };
      el.onkeydown = function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          goTo(kind);
        }
      };
    },
  );

  /* ---------- public API ---------- */
  requestRender();
  return {
    append: appendPoints, // flat [t0, v0, t1, v1, ...] (ms as-if-UTC, count)
    reset: resetData,
    setFull: setFull,
    setWindow: setWindow, // last N ms, following the newest sample
    setRange: setRange, // [x0, x1] in ms
    isFollowing: isFollowing,
    hasData: function () {
      return T.length > 0;
    },
    count: function () {
      return T.length;
    },
    lastTime: function () {
      return T.length ? T[T.length - 1] : null;
    },
    viewSpan: function () {
      return target.x1 - target.x0;
    },
    /* Rate search over the target window (or an explicit {x0, x1} range):
     * returns { count, times (ascending ms), x0, x1 }. */
    find: function (test, range) {
      var x0 = range ? range.x0 : target.x0,
        x1 = range ? range.x1 : target.x1,
        times = [],
        i = lowerBound(T, x0);
      for (; i < T.length && T[i] <= x1; i++) if (test(V[i])) times.push(T[i]);
      return { count: times.length, times: times, x0: x0, x1: x1 };
    },
    /* Centre on the sample at time t and pin a marker. Does not notify onChange. */
    mark: function (t) {
      var i = lowerBound(T, t);
      if (i >= T.length || T[i] !== t) return;
      showAt(t, V[i], [76, 201, 240], "Match  " + fmtInt(V[i]), false);
    },
    /* cb(kind) after user view changes ("view") or sample changes ("data"), debounced. */
    onChange: function (cb) {
      changeCb = cb;
    },
  };
})();
