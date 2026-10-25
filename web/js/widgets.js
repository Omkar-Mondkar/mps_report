/* Small UI widgets. window.MPSUI.select(root, opts) -> animated, keyboard-friendly dropdown.
 * items: [{value, label, sub?, disabled?}, {group: 'Heading'}]
 * opts.search: true adds a search box at the top of the list (always shown); it filters the options
 * by label and sub-label, every typed word must match. opts.searchPlaceholder sets its hint.
 * window.MPSUI.multiPick(root, opts) -> checkbox report picker for Compare mode (see below).
 */
window.MPSUI = (function () {
  "use strict";

  var selectSeq = 0;

  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function select(root, opts) {
    opts = opts || {};
    root.classList.add("select");
    var btn = h("button", "btn"),
      left = h("span", "left"),
      val = h("span", "val"),
      vsub = h("small", "vsub"),
      caret = h("span", "caret"),
      menu = h("div", "menu");
    btn.type = "button";
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    var search = !!opts.search,
      seq = ++selectSeq,
      list = search ? h("div", "mopts") : menu,
      query = search ? h("input", "msearch") : null,
      noMatch = h("div", "opt dis", "No matches");
    list.setAttribute("role", "listbox");
    list.id = "mps-sel-" + seq;
    if (search) {
      menu.classList.add("withsearch");
      query.type = "text";
      query.placeholder = opts.searchPlaceholder || "Search\u2026";
      query.autocomplete = "off";
      query.spellcheck = false;
      query.maxLength = 60;
      query.setAttribute("aria-label", opts.searchPlaceholder || "Search");
      query.setAttribute("aria-controls", list.id);
      noMatch.hidden = true;
      menu.appendChild(query);
      menu.appendChild(list);
    }
    left.appendChild(val);
    left.appendChild(vsub);
    btn.appendChild(left);
    btn.appendChild(caret);
    root.appendChild(btn);
    root.appendChild(menu);

    var items = [],
      value = null,
      act = -1,
      isOpen = false,
      nodes = [],
      gnodes = [];

    function indexOf(v) {
      for (var i = 0; i < items.length; i++)
        if (!items[i].group && items[i].value === v) return i;
      return -1;
    }
    function paintButton() {
      var i = indexOf(value);
      if (i < 0) {
        val.textContent = opts.placeholder || "\u2014";
        vsub.textContent = "";
        return;
      }
      val.textContent = items[i].label;
      vsub.textContent = items[i].sub || "";
    }
    function paintMenu() {
      list.textContent = "";
      nodes = [];
      gnodes = [];
      if (!items.length) {
        list.appendChild(h("div", "opt dis", "No options"));
        return;
      }
      items.forEach(function (it, i) {
        if (it.group) {
          gnodes[i] = h("div", "grp", it.group);
          list.appendChild(gnodes[i]);
          nodes[i] = null;
          return;
        }
        var o = h(
          "div",
          "opt" +
            (it.disabled ? " dis" : "") +
            (it.value === value ? " sel" : ""),
        );
        o.setAttribute("role", "option");
        o.id = list.id + "-" + i;
        o.dataset.i = i;
        o.appendChild(h("span", null, it.label));
        if (it.sub) o.appendChild(h("small", null, it.sub));
        list.appendChild(o);
        nodes[i] = o;
      });
      if (search) {
        list.appendChild(noMatch);
        applyQuery();
      }
    }
    /* Hide the options that do not match every typed word (label and sub-label), and a group
       heading when none of its options is left. */
    function applyQuery() {
      var terms = query.value.toLowerCase().split(/\s+/).filter(Boolean),
        shown = 0,
        heading = -1;
      items.forEach(function (it, i) {
        if (it.group) {
          heading = i;
          gnodes[i].hidden = true;
          return;
        }
        var text = (it.label + " " + (it.sub || "")).toLowerCase(),
          ok = terms.every(function (t) {
            return text.indexOf(t) >= 0;
          });
        nodes[i].hidden = !ok;
        if (ok) {
          shown++;
          if (heading >= 0) gnodes[heading].hidden = false;
        }
      });
      noMatch.hidden = shown > 0 || !items.length;
      if (!selectable(act)) {
        act = -1;
        move(1);
      }
      paintActive();
    }
    function paintActive() {
      nodes.forEach(function (n, i) {
        if (n) n.classList.toggle("active", i === act);
      });
      if (search) {
        if (nodes[act])
          query.setAttribute("aria-activedescendant", nodes[act].id);
        else query.removeAttribute("aria-activedescendant");
      }
      if (nodes[act]) nodes[act].scrollIntoView({ block: "nearest" });
    }
    function selectable(i) {
      return (
        items[i] &&
        !items[i].group &&
        !items[i].disabled &&
        !(nodes[i] && nodes[i].hidden)
      );
    }
    function move(dir) {
      var i = act;
      for (var n = 0; n < items.length; n++) {
        i = (i + dir + items.length) % items.length;
        if (selectable(i)) {
          act = i;
          break;
        }
      }
      paintActive();
    }
    function open() {
      if (isOpen || btn.disabled) return;
      isOpen = true;
      root.classList.add("open");
      btn.setAttribute("aria-expanded", "true");
      if (search) {
        query.value = "";
        applyQuery();
      }
      act = indexOf(value);
      if (act < 0) {
        act = -1;
        move(1);
      } else paintActive();
      if (search) query.focus();
    }
    function close() {
      if (!isOpen) return;
      isOpen = false;
      root.classList.remove("open");
      btn.setAttribute("aria-expanded", "false");
      if (search && document.activeElement === query) btn.focus();
    }
    function choose(i) {
      if (!selectable(i)) return;
      var changed = items[i].value !== value;
      value = items[i].value;
      paintButton();
      paintMenu();
      close();
      if (changed && opts.onChange) opts.onChange(value, items[i]);
    }

    btn.addEventListener("click", function () {
      isOpen ? close() : open();
    });
    function onKey(e) {
      var k = e.key,
        typing = e.target === query;
      if (k === "ArrowDown" || k === "ArrowUp") {
        e.preventDefault();
        if (!isOpen) open();
        else move(k === "ArrowDown" ? 1 : -1);
      } else if (k === "Enter" || (k === " " && !typing)) {
        e.preventDefault();
        if (isOpen) choose(act);
        else open();
      } else if (k === "Escape") {
        if (typing) e.preventDefault(); // keeps the page menu open
        close();
      } else if (k === "Tab") {
        close();
      } else if ((k === "Home" || k === "End") && !typing) {
        if (!isOpen) return;
        e.preventDefault();
        act = k === "Home" ? -1 : 0;
        move(k === "Home" ? 1 : -1);
      }
    }
    btn.addEventListener("keydown", onKey);
    if (search) {
      query.addEventListener("keydown", onKey);
      query.addEventListener("input", applyQuery);
    }
    menu.addEventListener("click", function (e) {
      var o = e.target.closest ? e.target.closest(".opt") : null;
      if (o && o.dataset.i != null) choose(+o.dataset.i);
    });
    menu.addEventListener("mousemove", function (e) {
      var o = e.target.closest ? e.target.closest(".opt") : null;
      if (
        o &&
        o.dataset.i != null &&
        +o.dataset.i !== act &&
        selectable(+o.dataset.i)
      ) {
        act = +o.dataset.i;
        paintActive();
      }
    });
    document.addEventListener("pointerdown", function (e) {
      if (isOpen && !root.contains(e.target)) close();
    });

    paintButton();
    paintMenu();
    return {
      setItems: function (list) {
        items = list || [];
        if (indexOf(value) < 0) value = null;
        paintButton();
        paintMenu();
      },
      setValue: function (v) {
        value = v;
        paintButton();
        paintMenu();
      }, // never fires onChange
      getValue: function () {
        return value;
      },
      setDisabled: function (d) {
        btn.disabled = !!d;
        if (d) close();
      },
    };
  }

  /* multiPick(root, opts) -> checkbox report picker (any combination, at most opts.max).
   * Reports: [{ip, name, date, exchange, segment, size}] ordered server, exchange, segment, newest
   * date first. exchange/segment are "" for old-style files (shown as "Unspecified").
   * opts.token(report) builds the token (one definition, shared with compare.js).
   * opts.onChange(tokensInPickOrder) fires on user changes only; set* methods never fire it.
   * The Exchange / Segment / text filters narrow the list and the "Same date" shortcut. */
  function multiPick(root, opts) {
    opts = opts || {};
    var max = opts.max || 6;
    root.classList.add("mpick");
    var btn = h("button", "btn"),
      lab = h("span", "val"),
      caret = h("span", "caret"),
      panel = h("div", "mpanel"),
      filter = h("input", "mfilter"),
      fil = h("div", "mquick"),
      exSel = h("select", "mdate"),
      sgSel = h("select", "mdate"),
      quick = h("div", "mquick"),
      dateSel = h("select", "mdate"),
      clearBtn = h("button", "mclear", "Clear"),
      list = h("div", "mlist"),
      msg = h("div", "mmsg");
    btn.type = "button";
    btn.setAttribute("aria-haspopup", "dialog");
    btn.setAttribute("aria-expanded", "false");
    clearBtn.type = "button";
    filter.type = "search";
    filter.placeholder = "Filter by server, segment or date\u2026";
    filter.setAttribute("aria-label", "Filter reports");
    exSel.setAttribute("aria-label", "Filter by exchange");
    sgSel.setAttribute("aria-label", "Filter by segment");
    dateSel.setAttribute("aria-label", "Same date, all listed servers");
    msg.setAttribute("role", "status");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Select reports to compare");
    btn.appendChild(lab);
    btn.appendChild(caret);
    fil.appendChild(exSel);
    fil.appendChild(sgSel);
    quick.appendChild(dateSel);
    quick.appendChild(clearBtn);
    panel.appendChild(filter);
    panel.appendChild(fil);
    panel.appendChild(quick);
    panel.appendChild(list);
    panel.appendChild(msg);
    root.appendChild(btn);
    root.appendChild(panel);

    var reports = [],
      sel = [],
      isOpen = false,
      msgTimer = 0;

    var NONE = "-"; /* filter value for old-style files */
    function tok(r) {
      return opts.token(r);
    }
    function segText(r) {
      return r.exchange && r.segment
        ? r.exchange + " " + r.segment
        : "Unspecified";
    }
    /* the reports the text, Exchange and Segment filters let through */
    function visible() {
      var q = filter.value.trim().toLowerCase(),
        ex = exSel.value,
        sg = sgSel.value;
      return reports.filter(function (r) {
        if (ex && (r.exchange || NONE) !== ex) return false;
        if (sg && (r.segment || NONE) !== sg) return false;
        if (!q) return true;
        return (
          (
            r.name +
            " " +
            r.ip +
            " " +
            r.exchange +
            " " +
            r.segment +
            " " +
            r.exchange +
            "_" +
            r.segment +
            " " +
            r.date +
            " " +
            pretty(r.date)
          )
            .toLowerCase()
            .indexOf(q) >= 0
        );
      });
    }
    function gkey(r) {
      return r.ip + "|" + r.exchange + "|" + r.segment;
    }
    function pretty(iso) {
      var a = iso.split("-").map(Number);
      return new Date(Date.UTC(a[0], a[1] - 1, a[2])).toLocaleDateString(
        "en-GB",
        {
          weekday: "short",
          day: "2-digit",
          month: "short",
          year: "numeric",
          timeZone: "UTC",
        },
      );
    }
    function say(text) {
      clearTimeout(msgTimer);
      msg.textContent = text || "";
      if (text)
        msgTimer = setTimeout(function () {
          msg.textContent = "";
        }, 4000);
    }
    function paintButton() {
      lab.textContent = sel.length
        ? "Reports \u00b7 " + sel.length + " selected"
        : "Select reports\u2026";
    }
    function changed() {
      paintButton();
      if (opts.onChange) opts.onChange(sel.slice());
    }
    /* fill a filter select from the codes present in the reports, keeping the choice */
    function paintFilter(selEl, all, field) {
      var keep = selEl.value,
        seen = {},
        codes = [],
        first = h("option", null, all);
      reports.forEach(function (r) {
        var c = r[field] || NONE;
        if (!seen[c]) {
          seen[c] = 1;
          codes.push(c);
        }
      });
      selEl.textContent = "";
      first.value = "";
      selEl.appendChild(first);
      codes.forEach(function (c) {
        var o = h("option", null, c === NONE ? "Unspecified" : c);
        o.value = c;
        selEl.appendChild(o);
      });
      selEl.value = seen[keep] ? keep : "";
    }
    function paintFilters() {
      paintFilter(exSel, "All exchanges", "exchange");
      paintFilter(sgSel, "All segments", "segment");
    }
    function paintDates() {
      var seen = {},
        dates = [];
      visible().forEach(function (r) {
        if (!seen[r.date]) {
          seen[r.date] = 1;
          dates.push(r.date);
        }
      });
      dates.sort().reverse();
      dateSel.textContent = "";
      var first = h("option", null, "Same date, all listed servers\u2026");
      first.value = "";
      dateSel.appendChild(first);
      dates.forEach(function (d) {
        var o = h("option", null, pretty(d));
        o.value = d;
        dateSel.appendChild(o);
      });
    }
    function paintList() {
      var groups = [],
        byKey = {},
        shown = 0;
      list.textContent = "";
      paintDates();
      visible().forEach(function (r) {
        var k = gkey(r);
        if (!byKey[k]) {
          byKey[k] = { key: k, r: r, items: [] };
          groups.push(byKey[k]);
        }
        byKey[k].items.push(r);
      });
      groups.forEach(function (g) {
        var head = h("div", "mgrp"),
          title = h(
            "span",
            null,
            g.r.name +
              (g.r.exchange && g.r.segment ? " \u00b7 " + segText(g.r) : ""),
          );
        head.appendChild(title);
        if (g.r.name !== g.r.ip) head.appendChild(h("small", null, g.r.ip));
        if (!g.r.exchange || !g.r.segment)
          head.appendChild(h("small", null, "Unspecified"));
        [3, 6].forEach(function (n) {
          var b = h("button", "mlast", "Last " + n);
          b.type = "button";
          b.title =
            "Select the " + n + " most recent days of this server and segment";
          b.dataset.k = g.key;
          b.dataset.n = n;
          head.appendChild(b);
        });
        list.appendChild(head);
        g.items.forEach(function (r) {
          var row = h("label", "mrow"),
            cb = h("input"),
            t = tok(r);
          cb.type = "checkbox";
          cb.value = t;
          cb.checked = sel.indexOf(t) >= 0;
          row.appendChild(cb);
          row.appendChild(h("span", null, pretty(r.date)));
          row.appendChild(h("small", null, r.date));
          list.appendChild(row);
          shown++;
        });
      });
      if (!shown)
        list.appendChild(
          h(
            "div",
            "mnone",
            reports.length
              ? "No reports match the filters"
              : "No reports available",
          ),
        );
    }
    function setSel(tokens, note) {
      var dropped = tokens.length > max;
      sel = tokens.slice(0, max);
      paintList();
      changed();
      say(dropped ? note || "Limited to " + max + " reports." : "");
    }

    list.addEventListener("change", function (e) {
      var cb = e.target,
        i;
      if (!cb || cb.type !== "checkbox") return;
      i = sel.indexOf(cb.value);
      if (cb.checked) {
        if (sel.length >= max) {
          cb.checked = false;
          say("You can compare at most " + max + " reports. Untick one first.");
          return;
        }
        if (i < 0) sel.push(cb.value);
      } else if (i >= 0) sel.splice(i, 1);
      say("");
      changed();
    });
    list.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest(".mlast") : null;
      if (!b) return;
      var n = +b.dataset.n,
        k = b.dataset.k,
        tokens = reports
          .filter(function (r) {
            return gkey(r) === k;
          })
          .slice(0, n)
          .map(tok);
      setSel(tokens);
    });
    dateSel.addEventListener("change", function () {
      var d = dateSel.value;
      dateSel.value = "";
      if (!d) return;
      var tokens = visible()
        .filter(function (r) {
          return r.date === d;
        })
        .map(tok);
      setSel(
        tokens,
        "Limited to " +
          max +
          " reports; " +
          tokens.length +
          " reports match this date.",
      );
    });
    clearBtn.addEventListener("click", function () {
      setSel([]);
    });
    filter.addEventListener("input", paintList);
    exSel.addEventListener("change", paintList);
    sgSel.addEventListener("change", paintList);

    function open() {
      if (isOpen) return;
      isOpen = true;
      root.classList.add("open");
      btn.setAttribute("aria-expanded", "true");
    }
    function close() {
      if (!isOpen) return;
      isOpen = false;
      root.classList.remove("open");
      btn.setAttribute("aria-expanded", "false");
    }
    btn.addEventListener("click", function () {
      isOpen ? close() : open();
    });
    root.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isOpen) {
        close();
        btn.focus();
      }
    });
    document.addEventListener("pointerdown", function (e) {
      if (isOpen && !root.contains(e.target)) close();
    });

    paintButton();
    paintList();
    return {
      setReports: function (rs) {
        reports = rs || [];
        var have = {};
        reports.forEach(function (r) {
          have[tok(r)] = 1;
        });
        sel = sel.filter(function (t) {
          return have[t];
        });
        paintFilters();
        paintList();
        paintButton();
      },
      setSelected: function (tokens) {
        sel = (tokens || []).slice(0, max);
        paintList();
        paintButton();
      },
      getSelected: function () {
        return sel.slice();
      },
      close: close,
    };
  }

  /* dialog(opts) -> modal window made of elements (no markup from data, no inner HTML).
   *   opts.title    heading text
   *   opts.message  optional plain paragraph above the body
   *   opts.build    function (bodyElement, api) that fills the body
   *   opts.actions  [{label, kind: "primary"|"danger"|"", run: function (api) -> any|Promise}]
   *                 an action closes the dialog unless run() returns false or rejects (the
   *                 rejection message is shown in the dialog and it stays open)
   *   opts.cancelLabel  text of the button that closes without doing anything (default "Cancel")
   *   opts.focus    element inside the body to focus first (default: Cancel for a "danger"
   *                 action, else the first control)
   *   opts.onClose  function () called once after the dialog is gone
   * Tab stays inside the dialog, Escape and Cancel close it leaving everything unchanged, and
   * the focus returns to the element that had it before. Several dialogs may be stacked; the
   * top one answers Escape. */
  var dialogSeq = 0,
    FOCUSABLE =
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  function dialog(opts) {
    opts = opts || {};
    var before = document.activeElement,
      scrim = h("div", "modal-scrim"),
      box = h("div", "modal"),
      title = h("h2", "mtitle", opts.title || ""),
      body = h("div", "mbody"),
      err = h("div", "merr"),
      foot = h("div", "mfoot"),
      cancel = h("button", null, opts.cancelLabel || "Cancel"),
      buttons = [],
      closed = false,
      api;
    title.id = "mps-dlg-" + ++dialogSeq;
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-labelledby", title.id);
    err.setAttribute("role", "alert");
    cancel.type = "button";
    box.appendChild(title);
    if (opts.message) box.appendChild(h("p", "mmsg2", opts.message));
    box.appendChild(body);
    box.appendChild(err);
    foot.appendChild(cancel);
    box.appendChild(foot);
    scrim.appendChild(box);

    function busy(b) {
      buttons.concat([cancel]).forEach(function (x) {
        x.disabled = !!b;
      });
      box.classList.toggle("working", !!b);
    }
    function close() {
      if (closed) return;
      closed = true;
      if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
      var back = document.body.contains(before) ? before : opts.returnTo;
      if (back && back.focus) back.focus();
      if (opts.onClose) opts.onClose();
    }
    api = {
      el: box,
      body: body,
      close: close,
      busy: busy,
      error: function (text) {
        err.textContent = text || "";
      },
    };
    (opts.actions || []).forEach(function (a) {
      var b = h("button", a.kind || "", a.label);
      b.type = "button";
      b.addEventListener("click", function () {
        err.textContent = "";
        var out;
        try {
          out = a.run ? a.run(api) : undefined;
        } catch (e) {
          err.textContent = (e && e.message) || "Something went wrong";
          return;
        }
        if (out === false) return;
        if (out && typeof out.then === "function") {
          busy(true);
          out.then(
            function (v) {
              busy(false);
              if (v !== false) close();
            },
            function (e) {
              busy(false);
              err.textContent = (e && e.message) || "Something went wrong";
            },
          );
        } else close();
      });
      buttons.push(b);
      foot.appendChild(b);
    });
    cancel.addEventListener("click", close);

    /* capture phase: runs before a dropdown inside the dialog sees the key, so an Escape that
       only closes an open dropdown does not close the dialog as well */
    box.addEventListener(
      "keydown",
      function (e) {
        if (e.key === "Escape") {
          if (e.target.closest && e.target.closest(".select.open")) return;
          e.preventDefault();
          e.stopPropagation();
          if (!cancel.disabled) close();
        } else if (
          e.key === "Enter" &&
          e.target.tagName === "INPUT" &&
          /^(text|password|email|search)$/.test(e.target.type) &&
          !(e.target.closest && e.target.closest(".select"))
        ) {
          /* Enter in a text field presses the primary button, as in any form */
          for (var i = 0; i < buttons.length; i++) {
            if (buttons[i].className === "primary" && !buttons[i].disabled) {
              e.preventDefault();
              buttons[i].click();
              break;
            }
          }
        } else if (e.key === "Tab") {
          var list = Array.prototype.filter.call(
            box.querySelectorAll(FOCUSABLE),
            function (n) {
              return n.offsetParent !== null || n === document.activeElement;
            },
          );
          if (!list.length) return;
          var first = list[0],
            last = list[list.length - 1],
            at = document.activeElement;
          if (e.shiftKey && (at === first || !box.contains(at))) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && (at === last || !box.contains(at))) {
            e.preventDefault();
            first.focus();
          }
        }
      },
      true,
    );

    document.body.appendChild(scrim);
    if (opts.build) opts.build(body, api);
    var danger = (opts.actions || []).some(function (a) {
      return a.kind === "danger";
    });
    var start =
      opts.focus || (danger ? cancel : box.querySelector(FOCUSABLE) || cancel);
    if (start.focus) start.focus();
    return api;
  }

  /* calendar(input, opts) -> custom micro-animated date picker popup attached to input */
  function calendar(input, opts) {
    opts = opts || {};
    input.type = "text";
    input.readOnly = true;
    input.classList.add("mps-cal-input");

    var parent = input.parentNode;
    if (parent) parent.classList.add("datebox");

    var popup = h("div", "mps-cal-popup");
    popup.hidden = true;

    // Header
    var header = h("div", "mps-cal-header");
    var prevBtn = h("button", "mps-cal-btn", "\u2039");
    prevBtn.type = "button";
    prevBtn.title = "Previous month";
    var titleBtn = h("span", "mps-cal-title");
    var nextBtn = h("button", "mps-cal-btn", "\u203a");
    nextBtn.type = "button";
    nextBtn.title = "Next month";
    header.appendChild(prevBtn);
    header.appendChild(titleBtn);
    header.appendChild(nextBtn);

    // Quick Jump Row
    var quick = h("div", "mps-cal-quick");
    var todayChip = h("button", "mps-cal-chip", "Today");
    todayChip.type = "button";
    var latestChip = h("button", "mps-cal-chip", "Latest");
    latestChip.type = "button";
    quick.appendChild(todayChip);
    quick.appendChild(latestChip);

    // Weekdays row
    var week = h("div", "mps-cal-week");
    ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].forEach(function (w) {
      week.appendChild(h("span", null, w));
    });

    // Days grid
    var grid = h("div", "mps-cal-grid");

    popup.appendChild(header);
    popup.appendChild(quick);
    popup.appendChild(week);
    popup.appendChild(grid);

    // Always append popup to document.body so it is never clipped or mispositioned by container overflow
    document.body.appendChild(popup);

    var MONTH_NAMES = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"
    ];

    var curDate = input.value || "";
    var viewYear, viewMonth;
    var available = Object.create(null);
    var isOpen = false;

    function initViewDate() {
      var d = curDate && /^\d{4}-\d{2}-\d{2}$/.test(curDate) ? new Date(curDate + "T00:00:00") : new Date();
      if (isNaN(d.getTime())) d = new Date();
      viewYear = d.getFullYear();
      viewMonth = d.getMonth();
    }
    initViewDate();

    function pad2(n) {
      return n < 10 ? "0" + n : String(n);
    }

    function toIso(y, m, d) {
      return y + "-" + pad2(m + 1) + "-" + pad2(d);
    }

    function paint() {
      titleBtn.textContent = MONTH_NAMES[viewMonth] + " " + viewYear;
      grid.textContent = "";

      var todayIso = new Date().toISOString().substring(0, 10);
      var firstDay = new Date(viewYear, viewMonth, 1);
      var startDay = (firstDay.getDay() + 6) % 7;
      var daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
      var daysInPrev = new Date(viewYear, viewMonth, 0).getDate();

      // Days of previous month
      for (var p = startDay - 1; p >= 0; p--) {
        var pDay = daysInPrev - p;
        var prevM = viewMonth === 0 ? 11 : viewMonth - 1;
        var prevY = viewMonth === 0 ? viewYear - 1 : viewYear;
        var pIso = toIso(prevY, prevM, pDay);
        grid.appendChild(createDayCell(pDay, pIso, true, false, false, false));
      }

      // Days of current month
      for (var d = 1; d <= daysInMonth; d++) {
        var iso = toIso(viewYear, viewMonth, d);
        var isSel = iso === curDate;
        var isToday = iso === todayIso;
        var hasData = !!available[iso];
        grid.appendChild(createDayCell(d, iso, false, isSel, isToday, hasData));
      }

      // Trailing days for next month
      var totalCells = startDay + daysInMonth;
      var remaining = (7 - (totalCells % 7)) % 7;
      for (var n = 1; n <= remaining; n++) {
        var nextM = viewMonth === 11 ? 0 : viewMonth + 1;
        var nextY = viewMonth === 11 ? viewYear + 1 : viewYear;
        var nIso = toIso(nextY, nextM, n);
        grid.appendChild(createDayCell(n, nIso, true, false, false, false));
      }
    }

    function createDayCell(dayNum, iso, otherMonth, isSel, isToday, hasData) {
      var cls = "mps-cal-day";
      if (otherMonth) cls += " other-month";
      if (isSel) cls += " selected";
      if (isToday) cls += " today";
      if (hasData) cls += " has-data";

      var el = h("div", cls);
      el.dataset.iso = iso;
      var num = h("span", "mps-cal-num", String(dayNum));
      el.appendChild(num);
      if (hasData) {
        var dot = h("span", "mps-cal-dot");
        el.appendChild(dot);
      }
      return el;
    }

    function updatePosition() {
      if (!isOpen && popup.hidden) return;
      var rect = input.getBoundingClientRect();
      var popW = 280;
      var popH = 330;

      // Align horizontally with the input, clamped inside viewport
      var left = rect.left;
      if (left + popW > window.innerWidth - 12) {
        left = window.innerWidth - popW - 12;
      }
      if (left < 12) left = 12;

      // Position directly below the input (or flip above if near bottom)
      var top = rect.bottom + 6;
      if (top + popH > window.innerHeight - 12 && rect.top > popH + 12) {
        top = rect.top - popH - 6;
      }

      popup.style.top = Math.round(top) + "px";
      popup.style.left = Math.round(left) + "px";
    }

    function open() {
      if (isOpen) return;
      initViewDate();
      paint();
      popup.hidden = false;
      updatePosition();
      window.addEventListener("scroll", updatePosition, true);
      window.addEventListener("resize", updatePosition);
      setTimeout(function () {
        popup.classList.add("open");
      }, 10);
      isOpen = true;
    }

    function close() {
      if (!isOpen) return;
      popup.classList.remove("open");
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
      isOpen = false;
      setTimeout(function () {
        if (!isOpen) popup.hidden = true;
      }, 180);
    }

    function pick(iso) {
      curDate = iso;
      input.value = iso;
      close();
      if (opts.onChange) opts.onChange(iso);
      input.dispatchEvent(new Event("change"));
      if (input.onchange) input.onchange();
    }

    input.addEventListener("click", function (e) {
      e.stopPropagation();
      isOpen ? close() : open();
    });

    prevBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (viewMonth === 0) {
        viewMonth = 11;
        viewYear--;
      } else {
        viewMonth--;
      }
      paint();
    });

    nextBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (viewMonth === 11) {
        viewMonth = 0;
        viewYear++;
      } else {
        viewMonth++;
      }
      paint();
    });

    todayChip.addEventListener("click", function (e) {
      e.stopPropagation();
      var todayIso = new Date().toISOString().substring(0, 10);
      pick(todayIso);
    });

    latestChip.addEventListener("click", function (e) {
      e.stopPropagation();
      var keys = Object.keys(available).sort();
      if (keys.length > 0) {
        pick(keys[keys.length - 1]);
      } else {
        var todayIso = new Date().toISOString().substring(0, 10);
        pick(todayIso);
      }
    });

    grid.addEventListener("click", function (e) {
      var cell = e.target.closest ? e.target.closest(".mps-cal-day") : null;
      if (cell && cell.dataset.iso) {
        e.stopPropagation();
        pick(cell.dataset.iso);
      }
    });

    document.addEventListener("pointerdown", function (e) {
      if (isOpen && !popup.contains(e.target) && e.target !== input) {
        close();
      }
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isOpen) {
        close();
      }
    });

    return {
      setValue: function (iso) {
        curDate = iso || "";
        input.value = curDate;
        if (isOpen) paint();
      },
      getValue: function () {
        return curDate;
      },
      setAvailableDates: function (dates) {
        available = Object.create(null);
        (dates || []).forEach(function (d) {
          available[d] = true;
        });
        if (isOpen) paint();
      },
      open: open,
      close: close,
    };
  }

  return { select: select, multiPick: multiPick, dialog: dialog, calendar: calendar };
})();

