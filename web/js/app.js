/* Dashboard controller: Server -> Exchange -> Segment -> Date -> Interval selectors, file check,
   data loading / live tail. */
(function () {
  "use strict";

  var $ = function (id) {
    return document.getElementById(id);
  };
  var chart = window.MPSChart,
    UI = window.MPSUI,
    compare = window.MPSCompare,
    Core = window.MPSCompareCore;

  var INTERVALS = [
    { group: "Live window" },
    { value: "last5", label: "Last 5 min", sec: 300 },
    { value: "last15", label: "Last 15 min", sec: 900 },
    { value: "last30", label: "Last 30 min", sec: 1800 },
    { value: "last1h", label: "Last 1 hour", sec: 3600 },
    { value: "last4h", label: "Last 4 hours", sec: 14400 },
    { group: "Fixed range" },
    { value: "full", label: "Full day" },
    { value: "market", label: "Market hours", sub: "09:15 \u2013 15:30" },
    { value: "custom", label: "Custom\u2026" },
  ];
  var MARKET = [9 * 3600 + 15 * 60, 15 * 3600 + 30 * 60];
  var ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
  var SENT =
    "-"; /* hash / selector value for old files without exchange and segment */

  var state = {
    ip: null,
    exchange: null, // "" = old-style files ("Unspecified")
    segment: null,
    exchanges: [], // [{code, name}] display order, from the server
    segments: [],
    date: null,
    interval: "full",
    dates: [],
    dir: "",
    today: "",
    pollMs: 1000,
    gen: 0,
    timer: 0,
    offset: 0,
    fileOk: null,
    needApply: true,
    paused: false,
    err: "",
    lastNew: 0,
    servers: [],
    compare: false,
    active: false, // this view is the one shown (set by the shell)
    ready: false, // the server list has been loaded
    started: false, // start() has run at least once
    docTitle: "",
  };

  /* ---------- helpers ---------- */
  function p2(n) {
    return (n < 10 ? "0" : "") + n;
  }
  function parts(iso) {
    return iso.split("-").map(Number);
  }
  function dayStart(iso) {
    var a = parts(iso);
    return Date.UTC(a[0], a[1] - 1, a[2]);
  }
  function addDays(iso, n) {
    var t = new Date(dayStart(iso) + n * 86400000);
    return (
      t.getUTCFullYear() +
      "-" +
      p2(t.getUTCMonth() + 1) +
      "-" +
      p2(t.getUTCDate())
    );
  }
  function prettyDate(iso) {
    return new Date(dayStart(iso)).toLocaleDateString("en-GB", {
      weekday: "short",
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  function hmsMs(s) {
    var m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s || "");
    return m ? (+m[1] * 3600 + +m[2] * 60 + (+m[3] || 0)) * 1000 : null;
  }
  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }
  function api(path, params) {
    return MPSSession.get("api/" + path + "?" + new URLSearchParams(params));
  }
  function store(k, v) {
    try {
      localStorage.setItem("mps." + k, v);
    } catch (e) {
      /* ignore */
    }
  }
  function load(k) {
    try {
      return localStorage.getItem("mps." + k);
    } catch (e) {
      return null;
    }
  }

  /* ---------- URL hash (shareable / survives refresh) ---------- */
  function readHash() {
    var o = {};
    new URLSearchParams(location.hash.slice(1)).forEach(function (v, k) {
      o[k] = v;
    });
    return o;
  }
  function writeHash() {
    var p = new URLSearchParams();
    if (state.ip) p.set("s", state.ip);
    if (state.ip && state.exchange !== null) {
      p.set("x", state.exchange || SENT);
      p.set("g", state.segment || SENT);
    }
    if (state.date) p.set("d", state.date);
    p.set("i", state.interval);
    if (state.interval === "custom") {
      p.set("f", $("tFrom").value);
      p.set("t", $("tTo").value);
    }
    history.replaceState(null, "", "#" + p.toString());
  }

  /* ---------- selectors ---------- */
  var selServer = UI.select($("selServer"), {
    placeholder: "No servers",
    search: true,
    searchPlaceholder: "Search servers\u2026",
    onChange: function (v) {
      state.ip = v;
      store("ip", v);
      pickSeg(state.exchange, state.segment);
      start();
    },
  });
  var selExchange = UI.select($("selExchange"), {
    placeholder: "\u2014",
    onChange: function (v) {
      pickSeg(v === SENT ? "" : v, state.segment);
      start();
    },
  });
  var selSegment = UI.select($("selSegment"), {
    placeholder: "\u2014",
    onChange: function (v) {
      state.segment = v === SENT ? "" : v;
      store("sg", state.segment || SENT);
      start();
    },
  });
  var selInterval = UI.select($("selInterval"), {
    onChange: function (v) {
      state.interval = v;
      store("iv", v);
      $("customBox").hidden = v !== "custom";
      applyInterval();
      writeHash();
    },
  });
  selInterval.setItems(INTERVALS);

  function serverItems() {
    return state.servers.map(function (s) {
      var sub = s.days + (s.days === 1 ? " day" : " days");
      return {
        value: s.ip,
        label: s.name,
        sub: s.name === s.ip ? sub : s.ip + " \u00b7 " + sub,
      };
    });
  }

  function curServer() {
    return (
      state.servers.filter(function (x) {
        return x.ip === state.ip;
      })[0] || null
    );
  }
  /* The server's exchange/segment combinations that have files, in display order. A server
     with no files yet is offered every configured combination. */
  function segsOf(s) {
    if (s && s.segments && s.segments.length) return s.segments;
    var out = [];
    state.exchanges.forEach(function (e) {
      state.segments.forEach(function (g) {
        out.push({ exchange: e.code, segment: g.code, days: 0 });
      });
    });
    return out;
  }
  function nameOf(list, code) {
    for (var i = 0; i < list.length; i++)
      if (list[i].code === code) return list[i].name;
    return code;
  }
  function exchangeItems() {
    var seen = {},
      out = [];
    segsOf(curServer()).forEach(function (x) {
      if (seen[x.exchange]) return;
      seen[x.exchange] = 1;
      out.push({
        value: x.exchange || SENT,
        label: x.exchange ? nameOf(state.exchanges, x.exchange) : "Unspecified",
      });
    });
    return out;
  }
  function segmentItems() {
    return segsOf(curServer())
      .filter(function (x) {
        return x.exchange === state.exchange;
      })
      .map(function (x) {
        var n = x.segment ? nameOf(state.segments, x.segment) : "",
          sub = [];
        if (n && n !== x.segment) sub.push(n);
        if (x.days) sub.push(x.days + (x.days === 1 ? " day" : " days"));
        return {
          value: x.segment || SENT,
          label: x.segment || "Unspecified",
          sub: sub.join(" \u00b7 "),
        };
      });
  }
  function paintSeg() {
    var ex = exchangeItems(),
      sg = segmentItems();
    selExchange.setItems(ex);
    selExchange.setValue(state.exchange ? state.exchange : SENT);
    selExchange.setDisabled(ex.length < 2);
    selSegment.setItems(sg);
    selSegment.setValue(state.segment ? state.segment : SENT);
    selSegment.setDisabled(sg.length < 2);
  }
  /* Apply the selection rule (keep the wanted exchange/segment when the server has it, else
     the first available) and repaint both selectors. Does not reload. */
  function pickSeg(ex, sg) {
    var c = Core.chooseSeg(segsOf(curServer()), ex, sg) || {
      exchange: "",
      segment: "",
    };
    state.exchange = c.exchange;
    state.segment = c.segment;
    store("ex", c.exchange || SENT);
    store("sg", c.segment || SENT);
    paintSeg();
  }
  /* exchange/segment query parameters; none for old-style files */
  function segQuery(o) {
    if (state.exchange) {
      o.exchange = state.exchange;
      o.segment = state.segment;
    }
    return o;
  }
  function segSuffix() {
    return state.exchange
      ? " \u00b7 " + Core.segLabel(state.exchange, state.segment)
      : "";
  }

  var dateCal = UI.calendar($("dateIn"), {
    onChange: function (iso) {
      setDate(iso);
    },
  });

  function setDate(iso) {
    if (!ISO_RE.test(iso || "")) return;
    state.date = iso;
    $("dateIn").value = iso;
    dateCal.setValue(iso);
    start();
  }
  function neighbor(dir) {
    var ds = state.dates.slice().sort(),
      i;
    if (!ds.length) return addDays(state.date, dir);
    if (dir < 0) {
      for (i = ds.length - 1; i >= 0; i--) if (ds[i] < state.date) return ds[i];
    } else {
      for (i = 0; i < ds.length; i++) if (ds[i] > state.date) return ds[i];
    }
    return null;
  }
  function updateNav() {
    $("dPrev").disabled = !state.date || !neighbor(-1);
    $("dNext").disabled = !state.date || !neighbor(1);
    dateCal.setAvailableDates(state.dates);
  }
  $("dPrev").onclick = function () {
    var d = neighbor(-1);
    if (d) setDate(d);
  };
  $("dNext").onclick = function () {
    var d = neighbor(1);
    if (d) setDate(d);
  };
  $("dateIn").addEventListener("change", function () {
    if (this.value && this.value !== state.date) setDate(this.value);
  });
  ["tFrom", "tTo"].forEach(function (id) {
    $(id).addEventListener("change", function () {
      applyInterval();
      writeHash();
    });
  });

  /* ---------- interval ---------- */
  function applyInterval() {
    if (!chart.hasData() || !state.date) return;
    var v = state.interval,
      base = dayStart(state.date),
      i,
      it;
    if (v === "full") return chart.setFull();
    if (v === "market")
      return chart.setRange(base + MARKET[0] * 1000, base + MARKET[1] * 1000);
    if (v === "custom") {
      var a = hmsMs($("tFrom").value),
        b = hmsMs($("tTo").value);
      if (a === null || b === null || b <= a) return;
      return chart.setRange(base + a, base + b);
    }
    for (i = 0; i < INTERVALS.length; i++) {
      it = INTERVALS[i];
      if (it.value === v && it.sec) return chart.setWindow(it.sec * 1000);
    }
  }

  /* ---------- status / chip / empty state ---------- */
  function updateStatus() {
    var cls = "",
      txt;
    if (state.err) {
      cls = "err";
      txt = state.err;
    } else if (state.fileOk === false) {
      cls = "err";
      txt = "FILE NOT FOUND";
    } else if (state.paused) txt = "PAUSED";
    else if (state.lastNew && Date.now() - state.lastNew < 5000) {
      cls = "live";
      txt = "LIVE";
    } else if (state.fileOk === null) txt = "LOADING";
    else txt = chart.hasData() ? "IDLE \u00b7 no new data" : "WAITING FOR DATA";
    $("status").className = "pill " + cls;
    if ($("stext").textContent !== txt) $("stext").textContent = txt;
    $("bFollow").className = chart.isFollowing() ? "on" : "";
  }
  function setChip(cls, text) {
    $("fileChip").className = "chip " + cls;
    $("fileText").textContent = text;
  }
  function setBusy(b) {
    document.body.classList.toggle("busy", b);
    $("dash").classList.toggle("loading", b);
  }
  function showEmpty(title, msg, sug) {
    $("emptyTitle").textContent = title;
    $("emptyMsg").textContent = msg || "";
    var box = $("emptySug");
    box.textContent = "";
    if (sug && sug.length) {
      var lab = document.createElement("span");
      lab.textContent = "Available dates:";
      box.appendChild(lab);
      sug.forEach(function (d) {
        var b = document.createElement("button");
        b.type = "button";
        b.textContent = prettyDate(d);
        b.onclick = function () {
          setDate(d);
        };
        box.appendChild(b);
      });
    }
    $("dash").hidden = true;
    $("empty").hidden = false;
  }
  function showDash() {
    $("empty").hidden = true;
    $("dash").hidden = false;
  }
  function nearestDates(n) {
    if (!state.date) return [];
    var t = dayStart(state.date);
    return state.dates
      .slice()
      .sort(function (a, b) {
        return Math.abs(dayStart(a) - t) - Math.abs(dayStart(b) - t);
      })
      .slice(0, n)
      .sort()
      .reverse();
  }
  function showMissing(file) {
    state.fileOk = false;
    setChip("missing", file + " \u2014 not found");
    var near = nearestDates(4);
    showEmpty(
      "No data file for " + prettyDate(state.date) + segSuffix(),
      "Looked for " +
        file +
        (state.dir ? " in " + state.dir : "") +
        ". If this is today\u2019s file it will appear here once it is created.",
      near,
    );
    setBusy(false);
  }

  /* ---------- loading ---------- */
  function start() {
    var gen = ++state.gen;
    state.started = true;
    clearTimeout(state.timer);
    chart.reset();
    search.reset();
    state.offset = 0;
    state.fileOk = null;
    state.needApply = true;
    state.lastNew = 0;
    state.err = "";
    setBusy(true);
    setChip("", "checking file\u2026");
    updateStatus();

    api("dates", segQuery({ ip: state.ip }))
      .catch(function () {
        return { dates: [] };
      })
      .then(function (j) {
        if (gen !== state.gen) return;
        state.dates = j.dates.map(function (x) {
          return x.date;
        });
        if (!state.date) {
          state.date =
            state.dates.indexOf(state.today) >= 0 || !state.dates.length
              ? state.today
              : state.dates[0];
        }
        $("dateIn").value = state.date;
        var s = state.servers.filter(function (x) {
          return x.ip === state.ip;
        })[0];
        document.title = state.docTitle =
          (s ? s.name : state.ip) +
          segSuffix() +
          " \u00b7 " +
          state.date +
          " \u00b7 MPS Report";
        writeHash();
        updateNav();
        tick(gen);
      });
  }

  function tick(gen) {
    if (gen !== state.gen) return;
    if (state.paused) {
      state.timer = setTimeout(function () {
        tick(gen);
      }, 300);
      return;
    }
    var wait = state.pollMs;
    api(
      "data",
      segQuery({ ip: state.ip, date: state.date, offset: state.offset }),
    )
      .then(function (j) {
        if (gen !== state.gen) return;
        state.err = "";
        if (j.error) {
          state.err = j.error;
          wait = 3000;
        } else if (j.missing) {
          showMissing(j.file);
          wait = 4000;
        } else {
          if (state.fileOk !== true) {
            state.fileOk = true;
            showDash();
          }
          if (j.reset) {
            chart.reset();
            state.needApply = true;
          }
          state.offset = j.offset;
          if (j.points.length) {
            chart.append(j.points);
            state.lastNew = Date.now();
          }
          setChip(
            "ok",
            j.file +
              " \u00b7 " +
              fmtBytes(j.size) +
              " \u00b7 updated " +
              j.modified.slice(11),
          );
          if (j.more) wait = 0;
          else {
            if (state.needApply && chart.hasData()) {
              state.needApply = false;
              applyInterval();
            }
            setBusy(false);
            if (state.lastNew && Date.now() - state.lastNew > 60000)
              wait = Math.max(wait, 5000);
          }
        }
      })
      .catch(function (e) {
        if (gen !== state.gen) return;
        state.err = e instanceof TypeError ? "Server unreachable" : e.message;
        wait = 3000;
      })
      .then(function () {
        if (gen !== state.gen) return;
        updateStatus();
        state.timer = setTimeout(function () {
          tick(gen);
        }, wait);
      });
  }

  /* ---------- toolbar ---------- */
  $("bPause").onclick = function () {
    state.paused = !state.paused;
    this.textContent = state.paused ? "Resume" : "Pause";
    this.className = state.paused ? "on" : "";
    updateStatus();
  };
  $("bFollow").onclick = function () {
    chart.setWindow(chart.viewSpan());
    updateStatus();
  };
  $("bReset").onclick = applyInterval;

  /* ---------- rate search (dashboard) ---------- */
  var search = (function () {
    var PAGE = 200,
      P = window.MPSPeaks,
      q = $("dQ"),
      clr = $("dQx"),
      msg = $("dQmsg"),
      box = $("dQlist"),
      st = { limit: PAGE, frozen: null, marked: null, focus: null, timer: 0 };
    function hms(t) {
      var d = new Date(t);
      return (
        p2(d.getUTCHours()) +
        ":" +
        p2(d.getUTCMinutes()) +
        ":" +
        p2(d.getUTCSeconds())
      );
    }
    function num(n) {
      return n.toLocaleString("en-US");
    }
    function button(cls, text, key) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = cls;
      b.textContent = text;
      b.setAttribute("data-k", key);
      return b;
    }
    function run() {
      var parsed = P.parseRate(q.value),
        r,
        n,
        i,
        b;
      clr.hidden = !q.value;
      box.textContent = "";
      msg.className = "smsg";
      if (parsed.empty) {
        msg.textContent = "";
        st.frozen = null;
        st.marked = null;
        return;
      }
      if (!parsed.ok) {
        msg.textContent = parsed.error;
        msg.className = "smsg err";
        return;
      }
      if (!chart.hasData()) {
        msg.textContent = "";
        return;
      }
      r = chart.find(parsed.test, st.frozen);
      msg.className = "smsg res";
      msg.textContent =
        (r.count
          ? num(r.count) +
            (r.count === 1 ? " sample matches " : " samples match ")
          : "No samples match ") +
        parsed.label +
        " between " +
        hms(r.x0) +
        " and " +
        hms(r.x1) +
        ".";
      n = Math.min(st.limit, r.count);
      r.times.slice(0, n).forEach(function (t) {
        var on = st.marked === t,
          tb = button("ptime" + (on ? " on" : ""), hms(t), "t:" + t);
        tb.title = "Go to " + hms(t) + " and mark it on the charts";
        tb.setAttribute("aria-pressed", on ? "true" : "false");
        tb.onclick = function () {
          st.frozen = { x0: r.x0, x1: r.x1 };
          st.marked = t;
          st.focus = "t:" + t;
          chart.mark(t);
          run();
        };
        box.appendChild(tb);
      });
      if (n < r.count) {
        b = button(
          "pmore",
          num(r.count - n) +
            " not shown \u2013 show " +
            num(Math.min(PAGE, r.count - n)) +
            " more",
          "more",
        );
        b.onclick = function () {
          st.limit += PAGE;
          st.focus = "more";
          run();
        };
        box.appendChild(b);
      }
      if (st.focus) {
        var all = box.querySelectorAll("[data-k]");
        for (i = 0; i < all.length; i++)
          if (all[i].getAttribute("data-k") === st.focus) all[i].focus();
        st.focus = null;
      }
    }
    function changed() {
      st.limit = PAGE;
      st.frozen = null;
      st.marked = null;
      run();
    }
    q.addEventListener("input", function () {
      clearTimeout(st.timer);
      st.timer = setTimeout(changed, 300);
    });
    q.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        clearTimeout(st.timer);
        changed();
      }
    });
    clr.onclick = function () {
      q.value = "";
      clearTimeout(st.timer);
      changed();
      q.focus();
    };
    /* "view": the user moved or zoomed the window; "data": samples changed. */
    chart.onChange(function (kind) {
      if (kind === "view") st.frozen = null;
      run();
    });
    return {
      reset: function () {
        q.value = "";
        clearTimeout(st.timer);
        changed();
      },
    };
  })();

  /* ---------- compare mode ---------- */
  function setMode(on, hash) {
    state.compare = on;
    $("dashView").hidden = on;
    $("cmpView").hidden = !on;
    ["status", "bPause", "bFollow", "bReset"].forEach(function (id) {
      $(id).hidden = on;
    });
    $("bCompare").textContent = on ? "Back to dashboard" : "Compare";
    $("bCompare").className = on ? "on" : "";
    $("bCompare").setAttribute("aria-pressed", on ? "true" : "false");
    if (on) {
      state.gen++; // stop dashboard polling while comparing
      clearTimeout(state.timer);
      setBusy(false);
      compare.enter(hash);
    } else {
      compare.leave();
      if (state.ip) start();
    }
  }
  $("bCompare").onclick = function () {
    setMode(!state.compare, {});
  };

  /* ---------- init ---------- */
  function refreshServers() {
    if (!state.active) return; // no requests while another view is shown
    api("servers", {})
      .then(function (j) {
        if (j.error || !j.servers.length) return;
        state.servers = j.servers;
        state.exchanges = j.exchanges || [];
        state.segments = j.segments || [];
        state.today = j.today;
        selServer.setItems(serverItems());
        $("dateIn").max = j.today;
        if (state.ip) {
          var was = state.exchange + "|" + state.segment;
          pickSeg(state.exchange, state.segment);
          if (!state.compare && was !== state.exchange + "|" + state.segment) {
            start(); // the selected files are gone: follow the first available
            return;
          }
          api("dates", segQuery({ ip: state.ip }))
            .then(function (d) {
              state.dates = d.dates.map(function (x) {
                return x.date;
              });
              updateNav();
            })
            .catch(function () {});
        }
      })
      .catch(function () {});
  }

  function init() {
    api("servers", {})
      .then(function (j) {
        state.pollMs = j.interval;
        state.dir = j.dir;
        state.today = j.today;
        state.servers = j.servers;
        state.exchanges = j.exchanges || [];
        state.segments = j.segments || [];
        $("title").textContent = j.title;
        $("dateIn").max = j.today;
        if (j.error) {
          setChip("missing", "directory unavailable");
          showEmpty("Cannot read the data directory", j.error);
          setBusy(false);
          return;
        }
        if (!j.servers.length) {
          setChip("missing", "no MPS files");
          setBusy(false);
          showEmpty(
            "No MPS files found",
            j.dir
              ? "Nothing matching " + j.filename + " in " + j.dir + "."
              : "There are no MPS reports you can see yet.",
          );
          return;
        }
        var h = readHash(),
          known = function (ip) {
            return j.servers.some(function (s) {
              return s.ip === ip;
            });
          };
        state.ip = known(h.s)
          ? h.s
          : known(load("ip"))
            ? load("ip")
            : j.servers[0].ip;
        state.date = ISO_RE.test(h.d || "") ? h.d : null;
        /* exchange/segment: from a link that has them, else the saved choice, else (a link
           from before segments existed) the first available. An unknown combination is
           ignored. */
        var dec = function (v) {
            return v == null ? null : v === SENT ? "" : v;
          },
          wantEx = null,
          wantSg = null;
        if (h.x != null && h.g != null) {
          wantEx = dec(h.x);
          wantSg = dec(h.g);
        } else if (!known(h.s)) {
          wantEx = dec(load("ex"));
          wantSg = dec(load("sg"));
        }
        if (
          !segsOf(curServer()).some(function (x) {
            return x.exchange === wantEx && x.segment === wantSg;
          })
        )
          wantEx = wantSg = null;
        selServer.setItems(serverItems());
        selServer.setValue(state.ip);
        pickSeg(wantEx, wantSg);
        var validIv = function (v) {
          return (
            !!v &&
            INTERVALS.some(function (x) {
              return x.value === v;
            })
          );
        };
        var iv = validIv(h.i) ? h.i : validIv(load("iv")) ? load("iv") : "full";
        state.interval = iv;
        if (hmsMs(h.f) !== null) $("tFrom").value = h.f;
        if (hmsMs(h.t) !== null) $("tTo").value = h.t;
        $("customBox").hidden = iv !== "custom";
        selInterval.setValue(iv);
        state.ready = true;
        if (state.active) {
          if (h.m === "cmp") setMode(true, h);
          else start();
        }
        setInterval(refreshServers, 60000);
      })
      .catch(function (e) {
        setChip("missing", "server unreachable");
        setBusy(false);
        showEmpty("Cannot reach the server", e.message);
      });
  }

  /* ---------- view contract (see shell.js) ---------- */
  /* Shown: resume where the view was left. init() does the first start. */
  function enterView() {
    state.active = true;
    if (!state.ready) return;
    document.title = state.docTitle || "MPS Report";
    if (state.compare) {
      compare.enter({});
    } else if (!state.ip) {
      return;
    } else if (!state.started || state.fileOk === null || !state.date) {
      start();
    } else {
      writeHash();
      updateStatus();
      tick(++state.gen); // continue from the saved offset
    }
  }
  /* Hidden: stop every request and timer; the state is kept. */
  function leaveView() {
    state.active = false;
    state.gen++; // answers still in flight are ignored
    clearTimeout(state.timer);
    if (state.compare) compare.leave();
    setBusy(false);
  }
  if (window.MPSShell)
    window.MPSShell.register({
      id: "mps",
      el: $("viewMps"),
      enter: enterView,
      leave: leaveView,
    });

  selInterval.setValue("full");
  setInterval(updateStatus, 500);
  init();
})();
