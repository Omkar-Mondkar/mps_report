/* Access view: who can sign in and what each person may see (SuperAdmins only).
 *
 * Five tabs (people waiting for access, users, groups, roles, audit log) over the
 * /api/admin/* routes. Lists are paged on the server; a search waits 300 ms after typing and
 * an answer that arrives after a newer request was made is dropped. Everything that comes
 * from data (names, e-mail addresses, dealer ids, audit details) is put on the page with
 * textContent, never as markup.
 *
 * The address names the view with v=access and keeps its own keys: at (tab), aq (search),
 * ap (page). Core is pure (also loadable from Node for tests); the rest needs the page.
 */
(function (root) {
  "use strict";

  var TABS = [
    { id: "pending", label: "Waiting for access" },
    { id: "users", label: "Users" },
    { id: "groups", label: "Groups" },
    { id: "roles", label: "Roles" },
    { id: "audit", label: "Audit log" },
  ];
  var DEFAULT_TAB = "users";
  var SIZES = [25, 50, 100, 200];
  var MIN_PASSWORD = 10; // the server's rule (auth/password.py)
  var DEALER_RE = /^(?:\*|[A-Za-z0-9_.@-]{1,64}\*?)$/;
  var DEALER_HELP =
    "Use * for all dealers, one dealer id (DESK1), or the start of ids followed by * (DESK1*). " +
    "A * is only allowed at the end.";

  /* ======================================================================
   * Core: rules that need no page
   * ==================================================================== */
  var Core = {
    TABS: TABS,
    DEFAULT_TAB: DEFAULT_TAB,
    SIZES: SIZES,
    MIN_PASSWORD: MIN_PASSWORD,
    DEALER_HELP: DEALER_HELP,

    tabIds: function () {
      return TABS.map(function (t) {
        return t.id;
      });
    },
    tabLabel: function (id) {
      for (var i = 0; i < TABS.length; i++)
        if (TABS[i].id === id) return TABS[i].label;
      return "";
    },

    /* {at, aq, ap} from the address -> {tab, q, page}; anything odd falls back to defaults */
    stateFromHash: function (h) {
      h = h || {};
      var page = parseInt(h.ap, 10);
      return {
        tab: Core.tabIds().indexOf(h.at) >= 0 ? h.at : DEFAULT_TAB,
        q: typeof h.aq === "string" ? h.aq.slice(0, 100) : "",
        page: page >= 1 && page <= 1000000 ? page : 1,
      };
    },
    /* the keys this view writes into the address (defaults left out) */
    hashParams: function (s) {
      return {
        at: s.tab === DEFAULT_TAB ? "" : s.tab,
        aq: s.q || "",
        ap: s.page > 1 ? s.page : "",
      };
    },

    /* query string of a list request; empty values are left out */
    listQuery: function (o) {
      var p = new URLSearchParams();
      ["q", "status", "role", "group"].forEach(function (k) {
        if (o[k] !== undefined && o[k] !== null && String(o[k]) !== "")
          p.set(k, String(o[k]));
      });
      p.set("page", String(o.page > 1 ? o.page : 1));
      p.set("size", String(o.size || 50));
      return p.toString();
    },
    /* query string of the audit viewer (and, with no before/size, of the CSV export) */
    auditQuery: function (f, before, size) {
      var p = new URLSearchParams();
      ["since", "until", "user", "event", "outcome"].forEach(function (k) {
        var v = f && typeof f[k] === "string" ? f[k].trim() : "";
        if (v) p.set(k, v);
      });
      if (before) p.set("before", String(before));
      if (size) p.set("size", String(size));
      return p.toString();
    },

    count: function (n) {
      return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    },
    plural: function (n, one, many) {
      return Core.count(n) + " " + (n === 1 ? one : many || one + "s");
    },
    pageInfo: function (total, page, size) {
      var pages = Math.max(1, Math.ceil(total / size));
      var from = total ? (page - 1) * size + 1 : 0;
      var to = Math.min(total, page * size);
      return {
        pages: pages,
        from: from,
        to: to,
        text: total
          ? Core.count(from) +
            "\u2013" +
            Core.count(to) +
            " of " +
            Core.count(total)
          : "0 of 0",
      };
    },

    /* A grant in words; the same sentences as grant_text() in auth/admin.py. */
    grantText: function (server, exchange, segment, dealer) {
      server = server || "*";
      exchange = exchange || "*";
      segment = segment || "*";
      dealer = dealer || "*";
      var what, where, who;
      if (exchange === "*" && segment === "*")
        what = "Every exchange and segment";
      else if (exchange !== "*" && segment !== "*")
        what = exchange + " " + segment;
      else if (segment === "*") what = exchange + ", every segment";
      else what = segment + " of every exchange";
      where = server === "*" ? "on every server" : "on server " + server;
      if (dealer === "*") who = "all dealers";
      else if (dealer.charAt(dealer.length - 1) === "*")
        who = "dealers starting " + dealer.slice(0, -1);
      else who = "dealer " + dealer;
      return what + " " + where + ", " + who;
    },
    /* why a dealer pattern cannot be saved, or "" */
    dealerProblem: function (text) {
      var d = String(text === undefined || text === null ? "" : text).trim();
      return d === "" || DEALER_RE.test(d) ? "" : DEALER_HELP;
    },
    /* "any", "seen" (in the discovered values) or "new" for a typed server/exchange/segment */
    valueKind: function (value, known) {
      var v = String(value || "").trim();
      if (v === "" || v === "*") return "any";
      return (known || []).indexOf(v) >= 0 ? "seen" : "new";
    },

    problemLine: function (p) {
      return (
        "Line " +
        p.line +
        (p.login ? " (" + p.login + ")" : "") +
        ": " +
        p.reason
      );
    },
    importSummary: function (r) {
      var parts = [];
      if (r.create) parts.push("create " + Core.plural(r.create, "new user"));
      if (r.change)
        parts.push("change " + Core.plural(r.change, "existing user"));
      if (r.skip)
        parts.push("leave " + Core.plural(r.skip, "user") + " as they are");
      if (!parts.length) return "Nothing to do.";
      var s = parts.join(", ");
      return s.charAt(0).toUpperCase() + s.slice(1) + ".";
    },
    importDone: function (r) {
      return (
        "Imported: " +
        Core.plural(r.created, "user") +
        " created, " +
        Core.plural(r.changed, "user") +
        " changed, " +
        Core.plural(r.skipped, "user") +
        " unchanged."
      );
    },

    fmtTime: function (iso) {
      if (!iso) return "never";
      var m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})Z?$/.exec(String(iso));
      return m ? m[1] + " " + m[2] + " UTC" : String(iso);
    },
    stateLabel: function (u) {
      if (!u.enabled) return "Disabled";
      return u.waiting ? "Waiting for access" : "Enabled";
    },
    viaText: function (via) {
      return (via || [])
        .map(function (v) {
          return v.type === "group" ? "through group " + v.group : "directly";
        })
        .join(" and ");
    },
    reachText: function (r) {
      if (!r) return "";
      var s;
      if (r.reports || (r.otr_servers && r.otr_servers.length)) {
        s = "Can open " + Core.plural(r.reports, "report");
        if (r.servers.length)
          s += " on " + Core.plural(r.servers.length, "server");
        if (r.otr_servers && r.otr_servers.length)
          s +=
            "; OTR snapshots of " + Core.plural(r.otr_servers.length, "server");
        s += ".";
      } else s = "Cannot open any report in the data found right now.";
      return r.note ? s + " (" + r.note + ")" : s;
    },
    newPasswordProblem: function (a, b) {
      if (typeof a !== "string" || a.length < MIN_PASSWORD)
        return "The password must be at least " + MIN_PASSWORD + " characters.";
      return a === b ? "" : "The two passwords do not match.";
    },
  };

  root.MPSAccessCore = Core;
  if (typeof module !== "undefined" && module.exports) module.exports = Core;
  if (typeof document === "undefined") return;

  /* ======================================================================
   * View
   * ==================================================================== */
  var host = document.getElementById("viewAccess");
  var Shell = root.MPSShell,
    UI = root.MPSUI,
    Sess = root.MPSSession;
  if (!host || !Shell || !UI || !Sess) return;

  var SEARCH_MS = 300,
    MAX_PICK = 500;

  var S = {
    active: false,
    built: false,
    tab: DEFAULT_TAB,
    detail: null, // {type: "user"|"group"|"role", id}
    lists: {
      pending: { q: "", page: 1, size: 50 },
      users: { q: "", page: 1, size: 50, status: "", role: "", group: "" },
      groups: { q: "", page: 1, size: 50 },
      roles: { q: "", page: 1, size: 50 },
    },
    members: { q: "", page: 1, size: 25 },
    audit: { f: {}, before: null, stack: [], size: 100 },
    sel: {}, // waiting people chosen: id -> login
    gsel: {}, // group members chosen: id -> login
    cache: {},
    req: 0, // list answers older than this are dropped
    dreq: 0, // same for detail panels
  };
  var D = {}; // DOM references

  /* ---------- small DOM helpers ---------- */
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function btn(text, cls, fn) {
    var b = el("button", cls, text);
    b.type = "button";
    if (fn) b.addEventListener("click", fn);
    return b;
  }
  function lnk(text, fn) {
    return btn(text, "lnk", fn);
  }
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }
  function cell(row, text, cls) {
    var td = el("td", cls, text);
    row.appendChild(td);
    return td;
  }
  function keys(map) {
    return Object.keys(map);
  }

  /* ---------- requests ---------- */
  function get(path, params) {
    return Sess.get("api/admin/" + path + (params ? "?" + params : ""));
  }
  function post(path, body) {
    return Sess.post("api/admin/" + path, body).then(function (r) {
      if (/^(roles|groups)(\/|$)/.test(path)) S.cache = {};
      return r;
    });
  }
  /* every role or group, for the choosers (a few pages at most) */
  function allOf(kind) {
    if (S.cache[kind]) return Promise.resolve(S.cache[kind]);
    var out = [];
    function more(page) {
      return get(kind, "page=" + page + "&size=200").then(function (r) {
        out = out.concat(r.items);
        if (r.items.length && out.length < r.total && page < 10)
          return more(page + 1);
        S.cache[kind] = out;
        return out;
      });
    }
    return more(1);
  }

  /* ---------- messages ---------- */
  function say(text) {
    D.msg.textContent = text || "";
    D.err.textContent = "";
  }
  function fail(e) {
    if (e && e.signedOut) return;
    D.err.textContent = (e && e.message) || "Something went wrong";
    D.msg.textContent = "";
  }

  /* ---------- the address and the hash ---------- */
  function persist() {
    var L = S.lists[S.tab] || { q: "", page: 1 };
    Shell.setHash(
      "access",
      Core.hashParams({
        tab: S.tab,
        q: S.detail ? "" : L.q,
        page: S.detail ? 1 : L.page,
      }),
    );
    document.title = "Access \u00b7 " + Core.tabLabel(S.tab);
  }

  /* ---------- confirmation and forms (see MPSUI.dialog) ---------- */
  function ask(title, message, label, danger, returnTo) {
    return new Promise(function (resolve) {
      var ok = false;
      UI.dialog({
        title: title,
        message: message,
        returnTo: returnTo,
        actions: [
          {
            label: label,
            kind: danger ? "danger" : "primary",
            run: function () {
              ok = true;
            },
          },
        ],
        onClose: function () {
          resolve(ok);
        },
      });
    });
  }

  function addField(body, f) {
    var row = el("label", f.type === "checkbox" ? "frow check" : "frow"),
      input;
    if (f.type === "select") {
      input = el("select", "fi");
      (f.items || []).forEach(function (it) {
        var o = el("option", null, it.label);
        o.value = String(it.value);
        input.appendChild(o);
      });
      if (f.value !== undefined) input.value = String(f.value);
    } else {
      input = el("input", f.type === "checkbox" ? "" : "fi");
      input.type = f.type || "text";
      if (f.type === "checkbox") input.checked = !!f.value;
      else input.value = f.value || "";
      input.maxLength = f.max || 254;
      input.autocomplete = f.autocomplete || "off";
      input.spellcheck = false;
    }
    if (f.type === "checkbox") {
      row.appendChild(input);
      row.appendChild(el("span", null, f.label));
    } else {
      row.appendChild(el("span", null, f.label));
      row.appendChild(input);
    }
    if (f.hint) {
      var hint = el("small", "hint", f.hint);
      row.appendChild(hint);
    }
    body.appendChild(row);
    return input;
  }

  /* o: {title, message, fields:[{key,label,type,value,items,hint,max,autocomplete}], action,
     kind, check(values) -> text|"", run(values) -> Promise, returnTo} */
  function formDialog(o) {
    var ctl = {};
    UI.dialog({
      title: o.title,
      message: o.message,
      returnTo: o.returnTo,
      build: function (body) {
        o.fields.forEach(function (f) {
          ctl[f.key] = addField(body, f);
        });
      },
      actions: [
        {
          label: o.action,
          kind: o.kind || "primary",
          run: function (api) {
            var v = {};
            o.fields.forEach(function (f) {
              v[f.key] =
                f.type === "checkbox" ? ctl[f.key].checked : ctl[f.key].value;
            });
            var why = o.check && o.check(v);
            if (why) {
              api.error(why);
              return false;
            }
            return o.run(v);
          },
        },
      ],
    });
  }

  /* ======================================================================
   * Lists
   * ==================================================================== */
  /* cfg: {path, state, cols:[{h, cls, cell(item, td)}], select:{map,max,onChange}, filters(bar,
     reload), empty, title, persist, onPaint(res)} -> {reload, search} */
  function listBlock(box, cfg) {
    var L = cfg.state,
      timer = 0,
      bar = el("div", "acc-bar"),
      search = el("input", "fi"),
      wrap = el("div", "tblwrap"),
      table = el("table", "ctable acctbl"),
      tbody = el("tbody"),
      info = el("div", "acc-info"),
      pager = el("div", "pager"),
      sizeSel = el("select", "fi mini"),
      prev = btn("\u2039 Previous"),
      next = btn("Next \u203a"),
      pageText = el("span"),
      all = null;

    function changed() {
      if (cfg.persist) persist();
    }

    search.type = "search";
    search.value = L.q;
    search.maxLength = 100;
    search.autocomplete = "off";
    search.spellcheck = false;
    search.placeholder = cfg.placeholder || "Search";
    search.setAttribute("aria-label", cfg.placeholder || "Search");
    function apply() {
      var v = search.value.trim();
      if (v === L.q) return;
      L.q = v;
      L.page = 1;
      changed();
      load();
    }
    search.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(apply, SEARCH_MS);
    });
    search.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        clearTimeout(timer);
        apply();
      }
    });
    bar.appendChild(search);
    if (cfg.filters)
      cfg.filters(bar, function () {
        L.page = 1;
        changed();
        load();
      });

    SIZES.forEach(function (n) {
      var o = el("option", null, n + " per page");
      o.value = String(n);
      sizeSel.appendChild(o);
    });
    sizeSel.value = String(L.size);
    sizeSel.setAttribute("aria-label", "Rows per page");
    sizeSel.addEventListener("change", function () {
      L.size = parseInt(sizeSel.value, 10) || 50;
      L.page = 1;
      changed();
      load();
    });

    var head = el("tr");
    if (cfg.select) {
      var th0 = el("th");
      all = el("input");
      all.type = "checkbox";
      all.setAttribute("aria-label", "Select everyone on this page");
      th0.appendChild(all);
      head.appendChild(th0);
    }
    cfg.cols.forEach(function (c) {
      head.appendChild(el("th", c.cls, c.h));
    });
    var thead = el("thead");
    thead.appendChild(head);
    table.appendChild(el("caption", "sr", cfg.title || "List"));
    table.appendChild(thead);
    table.appendChild(tbody);
    wrap.appendChild(table);

    prev.addEventListener("click", function () {
      L.page--;
      changed();
      load();
    });
    next.addEventListener("click", function () {
      L.page++;
      changed();
      load();
    });
    pager.appendChild(sizeSel);
    pager.appendChild(prev);
    pager.appendChild(pageText);
    pager.appendChild(next);

    box.appendChild(bar);
    box.appendChild(info);
    box.appendChild(wrap);
    box.appendChild(pager);

    var rows = []; // [{item, check}] of the page on screen
    function syncAll() {
      if (!all) return;
      var n = rows.filter(function (r) {
        return r.check.checked;
      }).length;
      all.checked = rows.length > 0 && n === rows.length;
      all.indeterminate = n > 0 && n < rows.length;
    }
    if (all)
      all.addEventListener("change", function () {
        var full = false;
        rows.forEach(function (r) {
          if (
            all.checked &&
            keys(cfg.select.map).length >= cfg.select.max &&
            !r.check.checked
          ) {
            full = true;
            return;
          }
          r.check.checked = all.checked;
          if (all.checked)
            cfg.select.map[r.item.id] = r.item.login || r.item.name;
          else delete cfg.select.map[r.item.id];
        });
        if (full)
          say("At most " + cfg.select.max + " people can be chosen at once.");
        syncAll();
        cfg.select.onChange();
      });

    function paintError(e) {
      clear(tbody);
      var tr = el("tr"),
        td = el(
          "td",
          "acc-empty",
          (e && e.message) || "The list could not be loaded.",
        );
      td.colSpan = cfg.cols.length + (cfg.select ? 1 : 0);
      td.setAttribute("role", "alert");
      td.appendChild(document.createTextNode(" "));
      td.appendChild(btn("Try again", "mini", load));
      tr.appendChild(td);
      tbody.appendChild(tr);
      info.textContent = "";
      rows = [];
      syncAll();
    }

    function paint(res) {
      clear(tbody);
      rows = [];
      if (!res.items.length) {
        var tr0 = el("tr"),
          td0 = el(
            "td",
            "acc-empty",
            L.q
              ? "Nothing found for \u201c" + L.q + "\u201d."
              : cfg.empty || "Nothing here yet.",
          );
        td0.colSpan = cfg.cols.length + (cfg.select ? 1 : 0);
        tr0.appendChild(td0);
        tbody.appendChild(tr0);
      }
      res.items.forEach(function (item) {
        var tr = el("tr");
        if (cfg.select) {
          var td = el("td"),
            cb = el("input");
          cb.type = "checkbox";
          cb.checked = !!cfg.select.map[item.id];
          cb.setAttribute("aria-label", "Select " + (item.login || item.name));
          cb.addEventListener("change", function () {
            if (cb.checked) {
              if (keys(cfg.select.map).length >= cfg.select.max) {
                cb.checked = false;
                say(
                  "At most " +
                    cfg.select.max +
                    " people can be chosen at once.",
                );
                return;
              }
              cfg.select.map[item.id] = item.login || item.name;
            } else delete cfg.select.map[item.id];
            syncAll();
            cfg.select.onChange();
          });
          td.appendChild(cb);
          tr.appendChild(td);
          rows.push({ item: item, check: cb });
        }
        cfg.cols.forEach(function (c) {
          var tdc = el("td", c.cls);
          c.cell(item, tdc);
          tr.appendChild(tdc);
        });
        tbody.appendChild(tr);
      });
      var pi = Core.pageInfo(res.total, res.page, res.size);
      info.textContent = pi.text;
      pageText.textContent =
        "Page " + Core.count(res.page) + " of " + Core.count(pi.pages);
      prev.disabled = res.page <= 1;
      next.disabled = res.page >= pi.pages;
      syncAll();
      if (cfg.onPaint) cfg.onPaint(res);
    }

    function load() {
      var mine = ++S.req;
      wrap.classList.add("acc-loading");
      get(
        cfg.path,
        Core.listQuery({
          q: L.q,
          status: L.status,
          role: L.role,
          group: L.group,
          page: L.page,
          size: L.size,
        }),
      ).then(
        function (res) {
          if (mine !== S.req || !S.active) return;
          wrap.classList.remove("acc-loading");
          var pages = Math.max(1, Math.ceil(res.total / res.size));
          if (!res.items.length && res.total > 0 && L.page > pages) {
            L.page = pages;
            changed();
            return load();
          }
          paint(res);
        },
        function (e) {
          if (mine !== S.req || !S.active) return;
          wrap.classList.remove("acc-loading");
          if (e && e.signedOut) return;
          paintError(e);
        },
      );
    }
    load();
    return { reload: load, search: search };
  }

  function userCols(openFn) {
    return [
      {
        h: "Sign-in name",
        cell: function (u, td) {
          td.appendChild(
            lnk(u.login, function () {
              openFn(u);
            }),
          );
        },
      },
      {
        h: "Name",
        cell: function (u, td) {
          td.textContent = u.name;
        },
      },
      {
        h: "E-mail",
        cell: function (u, td) {
          td.textContent = u.email;
        },
      },
      {
        h: "State",
        cell: function (u, td) {
          td.textContent = Core.stateLabel(u);
        },
      },
      {
        h: "Roles",
        cell: function (u, td) {
          td.textContent = u.roles.join(", ");
        },
      },
      {
        h: "Last sign-in",
        cell: function (u, td) {
          td.textContent = Core.fmtTime(u.last_login);
        },
      },
    ];
  }

  function fillSelect(sel, first, items, value) {
    clear(sel);
    var o0 = el("option", null, first);
    o0.value = "";
    sel.appendChild(o0);
    items.forEach(function (it) {
      var o = el("option", null, it.name);
      o.value = String(it.id);
      sel.appendChild(o);
    });
    sel.value = value ? String(value) : "";
  }

  /* ---------- tab: waiting for access ---------- */
  function clearSel(map) {
    keys(map).forEach(function (k) {
      delete map[k];
    });
  }

  function pendingTab() {
    var L = S.lists.pending,
      actions = el("div", "acc-bar"),
      count = el("span", "acc-count"),
      bRole = btn("Give a role\u2026"),
      bGroup = btn("Add to a group\u2026"),
      bRemove = btn("Remove\u2026"),
      bImport = btn("Import users\u2026", "", function () {
        openImport(bImport, function () {
          block.reload();
        });
      }),
      block;
    function sync() {
      var n = keys(S.sel).length;
      count.textContent = n
        ? Core.plural(n, "person", "people") + " chosen"
        : "No one chosen";
      [bRole, bGroup, bRemove].forEach(function (b) {
        b.disabled = !n;
      });
    }
    function ids() {
      return keys(S.sel).map(Number);
    }
    function assign(kind) {
      var n = ids().length;
      (kind === "role" ? allOf("roles") : allOf("groups")).then(function (
        list,
      ) {
        var items = list
          .filter(function (x) {
            return !x.manage;
          })
          .map(function (x) {
            return { value: x.id, label: x.name };
          });
        if (!items.length)
          return fail(new Error("There is nothing to choose from yet."));
        formDialog({
          title:
            (kind === "role" ? "Give a role to " : "Add to a group: ") +
            Core.plural(n, "person", "people"),
          message:
            kind === "role"
              ? "They get everything the role gives, at once."
              : "They get everything the group's roles give, at once.",
          fields: [
            {
              key: "pick",
              label: kind === "role" ? "Role" : "Group",
              type: "select",
              items: [
                {
                  value: "",
                  label:
                    kind === "role"
                      ? "Choose a role\u2026"
                      : "Choose a group\u2026",
                },
              ].concat(items),
            },
          ],
          check: function (v) {
            return v.pick
              ? ""
              : kind === "role"
                ? "Choose a role first."
                : "Choose a group first.";
          },
          action: kind === "role" ? "Give role" : "Add to group",
          returnTo: kind === "role" ? bRole : bGroup,
          run: function (v) {
            var body = { user_ids: ids() },
              name = "";
            items.forEach(function (it) {
              if (String(it.value) === v.pick) name = it.label;
            });
            body[kind === "role" ? "role_id" : "group_id"] = Number(v.pick);
            return post("pending/assign", body).then(function (r) {
              clearSel(S.sel);
              sync();
              say(
                (kind === "role"
                  ? "Gave the role \u201c"
                  : "Added to the group \u201c") +
                  name +
                  "\u201d to " +
                  Core.plural(r.assigned, "person", "people") +
                  ".",
              );
              block.reload();
            });
          },
        });
      }, fail);
    }
    bRole.addEventListener("click", function () {
      assign("role");
    });
    bGroup.addEventListener("click", function () {
      assign("group");
    });
    bRemove.addEventListener("click", function () {
      var n = ids().length;
      ask(
        "Remove " + Core.plural(n, "person", "people") + "?",
        "Their accounts are deleted from the list of people waiting for access. " +
          "Nobody else is affected.",
        "Remove",
        true,
        bRemove,
      ).then(function (ok) {
        if (!ok) return;
        post("pending/remove", { user_ids: ids() }).then(function (r) {
          clearSel(S.sel);
          sync();
          say("Removed " + Core.plural(r.removed, "person", "people") + ".");
          block.reload();
        }, fail);
      });
    });
    actions.appendChild(count);
    actions.appendChild(bRole);
    actions.appendChild(bGroup);
    actions.appendChild(bRemove);
    actions.appendChild(bImport);
    D.body.appendChild(
      el(
        "p",
        "acc-lead",
        "People who signed in but have no role, group or grant yet.",
      ),
    );
    D.body.appendChild(actions);
    block = listBlock(D.body, {
      path: "pending",
      state: L,
      persist: true,
      title: "People waiting for access",
      placeholder: "Search by name or e-mail",
      empty: "No one is waiting for access.",
      select: { map: S.sel, max: MAX_PICK, onChange: sync },
      cols: userCols(function (u) {
        openDetail("user", u.id, true);
      }).filter(function (c) {
        return c.h !== "State" && c.h !== "Roles";
      }),
    });
    sync();
  }

  /* ---------- tab: users ---------- */
  function usersTab() {
    var L = S.lists.users,
      selRole = el("select", "fi"),
      selGroup = el("select", "fi"),
      selStatus = el("select", "fi"),
      block;
    [
      ["", "Any state"],
      ["enabled", "Enabled"],
      ["disabled", "Disabled"],
      ["waiting", "Waiting for access"],
    ].forEach(function (p) {
      var o = el("option", null, p[1]);
      o.value = p[0];
      selStatus.appendChild(o);
    });
    selStatus.value = L.status;
    selStatus.setAttribute("aria-label", "State");
    selRole.setAttribute("aria-label", "Role");
    selGroup.setAttribute("aria-label", "Group");
    fillSelect(selRole, "Any role", [], L.role);
    fillSelect(selGroup, "Any group", [], L.group);
    allOf("roles").then(function (r) {
      fillSelect(selRole, "Any role", r, L.role);
    }, fail);
    allOf("groups").then(function (g) {
      fillSelect(selGroup, "Any group", g, L.group);
    }, fail);

    var top = el("div", "acc-bar");
    var bNew = btn("New user\u2026", "", function () {
      formDialog({
        title: "New user",
        message:
          "Leave the password empty for a person who signs in with Microsoft; they are linked when they first sign in.",
        fields: [
          { key: "login", label: "Sign-in name", max: 254 },
          { key: "name", label: "Name", max: 200 },
          { key: "email", label: "E-mail", max: 254 },
          {
            key: "password",
            label: "Password (optional)",
            type: "password",
            max: 1024,
            autocomplete: "new-password",
            hint: "At least " + MIN_PASSWORD + " characters.",
          },
        ],
        action: "Create user",
        returnTo: bNew,
        check: function (v) {
          if (!v.login.trim()) return "Enter a sign-in name.";
          return v.password && v.password.length < MIN_PASSWORD
            ? "The password must be at least " + MIN_PASSWORD + " characters."
            : "";
        },
        run: function (v) {
          return post("users", {
            login: v.login,
            name: v.name,
            email: v.email,
            password: v.password || undefined,
          }).then(function (u) {
            say("User " + u.login + " created.");
            openDetail("user", u.id, true);
          });
        },
      });
    });
    var bImport = btn("Import users\u2026", "", function () {
      openImport(bImport, function () {
        block.reload();
      });
    });
    top.appendChild(bNew);
    top.appendChild(bImport);
    D.body.appendChild(top);
    block = listBlock(D.body, {
      path: "users",
      state: L,
      persist: true,
      title: "Users",
      placeholder: "Search by sign-in name, name or e-mail",
      empty: "There are no users yet.",
      cols: userCols(function (u) {
        openDetail("user", u.id, true);
      }),
      filters: function (bar, reload) {
        bar.appendChild(selStatus);
        bar.appendChild(selRole);
        bar.appendChild(selGroup);
        selStatus.addEventListener("change", function () {
          L.status = selStatus.value;
          reload();
        });
        selRole.addEventListener("change", function () {
          L.role = selRole.value;
          reload();
        });
        selGroup.addEventListener("change", function () {
          L.group = selGroup.value;
          reload();
        });
      },
    });
  }

  /* ---------- tab: groups ---------- */
  function groupsTab() {
    var top = el("div", "acc-bar");
    var bNew = btn("New group\u2026", "", function () {
      formDialog({
        title: "New group",
        message:
          "A group collects people so a role can be given to all of them at once.",
        fields: [{ key: "name", label: "Group name", max: 64 }],
        action: "Create group",
        returnTo: bNew,
        check: function (v) {
          return v.name.trim() ? "" : "Enter a name.";
        },
        run: function (v) {
          return post("groups", { name: v.name }).then(function (g) {
            say("Group " + g.name + " created.");
            openDetail("group", g.id, true);
          });
        },
      });
    });
    top.appendChild(bNew);
    D.body.appendChild(top);
    listBlock(D.body, {
      path: "groups",
      state: S.lists.groups,
      persist: true,
      title: "Groups",
      placeholder: "Search groups",
      empty: "There are no groups yet.",
      cols: [
        {
          h: "Group",
          cell: function (g, td) {
            td.appendChild(
              lnk(g.name, function () {
                openDetail("group", g.id, true);
              }),
            );
          },
        },
        {
          h: "Members",
          cell: function (g, td) {
            td.textContent = Core.count(g.members);
          },
        },
        {
          h: "Roles",
          cell: function (g, td) {
            td.textContent = g.roles.join(", ");
          },
        },
      ],
    });
  }

  /* ---------- tab: roles ---------- */
  function rolesTab() {
    var top = el("div", "acc-bar");
    var bNew = btn("New role\u2026", "", function () {
      formDialog({
        title: "New role",
        message: "Add what the role may see (grants) after creating it.",
        fields: [
          { key: "name", label: "Role name", max: 64 },
          { key: "view_all", label: "Sees every report", type: "checkbox" },
        ],
        action: "Create role",
        returnTo: bNew,
        check: function (v) {
          return v.name.trim() ? "" : "Enter a name.";
        },
        run: function (v) {
          return post("roles", {
            name: v.name,
            view_all: v.view_all === true,
          }).then(function (r) {
            say("Role " + r.name + " created.");
            openDetail("role", r.id, true);
          });
        },
      });
    });
    top.appendChild(bNew);
    D.body.appendChild(top);
    listBlock(D.body, {
      path: "roles",
      state: S.lists.roles,
      persist: true,
      title: "Roles",
      placeholder: "Search roles",
      empty: "There are no roles.",
      cols: [
        {
          h: "Role",
          cell: function (r, td) {
            td.appendChild(
              lnk(r.name, function () {
                openDetail("role", r.id, true);
              }),
            );
          },
        },
        {
          h: "Kind",
          cell: function (r, td) {
            td.textContent = r.builtin ? "Built-in" : "Custom";
          },
        },
        {
          h: "People",
          cell: function (r, td) {
            td.textContent = Core.count(r.users);
          },
        },
        {
          h: "Grants",
          cell: function (r, td) {
            td.textContent = Core.count(r.grants);
          },
        },
        {
          h: "Sees every report",
          cell: function (r, td) {
            td.textContent = r.view_all || r.manage ? "Yes" : "No";
          },
        },
      ],
    });
  }

  /* ======================================================================
   * Detail pages
   * ==================================================================== */
  function openDetail(type, id, keepTab) {
    if (!keepTab) S.tab = type + "s";
    S.detail = { type: type, id: id };
    if (type === "group") {
      S.members = { q: "", page: 1, size: 25 };
      clearSel(S.gsel);
    }
    render();
    var h = D.body.querySelector("h2");
    if (h) h.focus();
  }
  function closeDetail() {
    S.detail = null;
    render();
    var s = D.body.querySelector("input[type=search]");
    if (s) s.focus();
  }

  function panel(title) {
    var sec = el("section", "panel acc-panel"),
      h = el("h3", null, title),
      body = el("div", "acc-pbody");
    sec.appendChild(h);
    sec.appendChild(body);
    return { sec: sec, body: body };
  }
  function head(title, backLabel) {
    var bar = el("div", "acc-head"),
      h = el("h2", null, title);
    h.tabIndex = -1;
    bar.appendChild(btn("\u2039 " + backLabel, "", closeDetail));
    bar.appendChild(h);
    return bar;
  }
  function pending(box) {
    clear(box);
    box.appendChild(el("p", "acc-empty", "Loading\u2026"));
  }
  /* run an action on the open item; the page is shown again afterwards */
  function act(promise, message) {
    return promise.then(
      function (r) {
        if (!S.active) return r;
        render();
        if (message) say(message);
        return r;
      },
      function (e) {
        if (e && e.status === 409 && S.active) render(); // show what is there now
        fail(e);
        return false;
      },
    );
  }

  function li(list) {
    var item = el("li", "acc-li");
    list.appendChild(item);
    return item;
  }
  function none(list, text) {
    list.appendChild(el("li", "acc-li muted", text));
  }
  function addRow(box, label, items, firstText, onAdd) {
    var row = el("div", "acc-bar"),
      sel = el("select", "fi");
    sel.setAttribute("aria-label", label);
    var o0 = el("option", null, firstText);
    o0.value = "";
    sel.appendChild(o0);
    items.forEach(function (it) {
      var o = el("option", null, it.name);
      o.value = String(it.id);
      sel.appendChild(o);
    });
    var b = btn("Add", "", function () {
      if (sel.value) onAdd(Number(sel.value), b);
    });
    row.appendChild(sel);
    row.appendChild(b);
    box.appendChild(row);
  }

  /* ---------- a user ---------- */
  function userDetail(id) {
    var mine = ++S.dreq;
    D.body.appendChild(head("User", Core.tabLabel(S.tab)));
    var holder = el("div");
    D.body.appendChild(holder);
    pending(holder);
    Promise.all([
      get("users/" + id),
      get("users/" + id + "/access"),
      allOf("roles"),
      allOf("groups"),
    ]).then(
      function (r) {
        if (mine !== S.dreq || !S.active) return;
        clear(holder);
        paintUser(holder, r[0], r[1], r[2], r[3]);
        D.body.querySelector("h2").textContent = r[0].login;
      },
      function (e) {
        if (mine !== S.dreq) return;
        clear(holder);
        holder.appendChild(
          el("p", "acc-empty", (e && e.message) || "Could not load this user."),
        );
        fail(e);
      },
    );
  }

  function paintUser(box, u, acc, allRoles, allGroups) {
    var grid = el("div", "acc-grid"),
      uid = u.id,
      p = panel("Account");

    // account
    var name = addField(p.body, { label: "Name", value: u.name, max: 200 }),
      email = addField(p.body, { label: "E-mail", value: u.email, max: 254 });
    var bar = el("div", "acc-bar");
    bar.appendChild(
      btn("Save name and e-mail", "", function () {
        act(
          post("users/" + uid + "/update", {
            name: name.value,
            email: email.value,
            version: u.version,
          }),
          "Saved.",
        );
      }),
    );
    p.body.appendChild(bar);
    var dl = el("dl", "acc-dl");
    function kv(k, v) {
      dl.appendChild(el("dt", null, k));
      dl.appendChild(el("dd", null, v));
    }
    kv("State", Core.stateLabel(u));
    kv("Last sign-in", Core.fmtTime(u.last_login));
    kv("Created", Core.fmtTime(u.created));
    kv("Local password", u.has_password ? "Set" : "Not set");
    p.body.appendChild(dl);
    var acts = el("div", "acc-bar");
    if (u.enabled)
      acts.appendChild(
        btn("Disable\u2026", "", function (e) {
          ask(
            "Disable " + u.login + "?",
            "1 person is affected: " +
              u.login +
              " is signed out at once and cannot sign in until you enable the account again.",
            "Disable",
            true,
            e.currentTarget,
          ).then(function (ok) {
            if (ok)
              act(
                post("users/" + uid + "/enabled", {
                  enabled: false,
                  version: u.version,
                }),
                u.login + " disabled.",
              );
          });
        }),
      );
    else
      acts.appendChild(
        btn("Enable", "", function () {
          act(
            post("users/" + uid + "/enabled", {
              enabled: true,
              version: u.version,
            }),
            u.login + " enabled.",
          );
        }),
      );
    acts.appendChild(
      btn("Set password\u2026", "", function (e) {
        formDialog({
          title: "Set a password for " + u.login,
          message: "Their other sessions end. The password is not shown again.",
          fields: [
            {
              key: "a",
              label: "New password",
              type: "password",
              max: 1024,
              autocomplete: "new-password",
            },
            {
              key: "b",
              label: "New password again",
              type: "password",
              max: 1024,
              autocomplete: "new-password",
            },
          ],
          action: "Set password",
          returnTo: e.currentTarget,
          check: function (v) {
            return Core.newPasswordProblem(v.a, v.b);
          },
          run: function (v) {
            return post("users/" + uid + "/password", { password: v.a }).then(
              function () {
                render();
                say("Password set.");
              },
            );
          },
        });
      }),
    );
    acts.appendChild(
      btn("End all sessions", "", function () {
        act(
          post("users/" + uid + "/sessions/end", {}),
          u.login + " is signed out everywhere.",
        );
      }),
    );
    if (!u.last_login)
      acts.appendChild(
        btn("Delete\u2026", "", function (e) {
          ask(
            "Delete " + u.login + "?",
            "1 person is affected. This account has never signed in, so it is removed completely.",
            "Delete",
            true,
            e.currentTarget,
          ).then(function (ok) {
            if (!ok) return;
            post("users/" + uid + "/delete", {}).then(function () {
              say(u.login + " deleted.");
              closeDetail();
            }, fail);
          });
        }),
      );
    p.body.appendChild(acts);
    grid.appendChild(p.sec);

    // roles
    var pr = panel("Roles"),
      rl = el("ul", "acc-list");
    if (!acc.roles.length) none(rl, "No role.");
    acc.roles.forEach(function (r) {
      var item = li(rl),
        direct = r.via.some(function (v) {
          return v.type === "direct";
        });
      item.appendChild(el("span", null, r.name));
      item.appendChild(el("small", "muted", " \u2013 " + Core.viaText(r.via)));
      if (direct)
        item.appendChild(
          btn("Remove", "mini", function (e) {
            function go() {
              act(
                post("users/" + uid + "/roles/remove", { role_id: r.id }),
                "Role " + r.name + " removed.",
              );
            }
            if (r.manage)
              ask(
                "Remove the SuperAdmin role?",
                "1 person is affected: " +
                  u.login +
                  " can no longer manage access.",
                "Remove role",
                true,
                e.currentTarget,
              ).then(function (ok) {
                if (ok) go();
              });
            else go();
          }),
        );
    });
    pr.body.appendChild(rl);
    var have = {};
    acc.roles.forEach(function (r) {
      if (
        r.via.some(function (v) {
          return v.type === "direct";
        })
      )
        have[r.id] = 1;
    });
    addRow(
      pr.body,
      "Role to add",
      allRoles.filter(function (r) {
        return !have[r.id];
      }),
      "Choose a role\u2026",
      function (rid) {
        act(
          post("users/" + uid + "/roles/add", { role_id: rid }),
          "Role added.",
        );
      },
    );
    grid.appendChild(pr.sec);

    // groups
    var pg = panel("Groups"),
      gl = el("ul", "acc-list");
    if (!u.groups.length) none(gl, "Not in any group.");
    u.groups.forEach(function (g) {
      var item = li(gl);
      item.appendChild(
        lnk(g.name, function () {
          openDetail("group", g.id);
        }),
      );
      item.appendChild(
        btn("Remove", "mini", function () {
          act(
            post("users/" + uid + "/groups/remove", { group_id: g.id }),
            "Removed from " + g.name + ".",
          );
        }),
      );
    });
    pg.body.appendChild(gl);
    var inGroup = {};
    u.groups.forEach(function (g) {
      inGroup[g.id] = 1;
    });
    addRow(
      pg.body,
      "Group to add",
      allGroups.filter(function (g) {
        return !inGroup[g.id];
      }),
      "Choose a group\u2026",
      function (gid) {
        act(
          post("users/" + uid + "/groups/add", { group_id: gid }),
          "Added to the group.",
        );
      },
    );
    grid.appendChild(pg.sec);

    // own grants
    var pgr = panel("Grants of their own"),
      grl = el("ul", "acc-list");
    pgr.body.appendChild(grl);
    fillGrants(
      grl,
      u.grants,
      { type: "user", id: uid, label: u.login },
      pgr.body,
    );
    grid.appendChild(pgr.sec);

    // Microsoft sign-in
    var pi = panel("Microsoft sign-in"),
      il = el("ul", "acc-list");
    if (!u.identities.length) none(il, "No Microsoft account is linked.");
    u.identities.forEach(function (idn) {
      var item = li(il);
      item.appendChild(
        el("span", null, idn.provider + " \u00b7 " + idn.subject),
      );
      item.appendChild(
        btn("Unlink\u2026", "mini", function (e) {
          ask(
            "Unlink the Microsoft account?",
            "1 person is affected: " +
              u.login +
              " cannot sign in with Microsoft until the account is linked again.",
            "Unlink",
            true,
            e.currentTarget,
          ).then(function (ok) {
            if (ok)
              act(
                post("users/" + uid + "/identities/unlink", {
                  provider: idn.provider,
                  subject: idn.subject,
                }),
                "Microsoft account unlinked.",
              );
          });
        }),
      );
    });
    pi.body.appendChild(il);
    grid.appendChild(pi.sec);

    // what they can see
    grid.appendChild(accessPanel(acc));
    box.appendChild(grid);
  }

  function accessPanel(acc) {
    var p = panel("What this person can see"),
      b = p.body;
    if (!acc.enabled)
      b.appendChild(
        el("p", null, "This account is disabled and cannot sign in."),
      );
    if (acc.manage)
      b.appendChild(el("p", null, "Can manage access and sees every report."));
    else if (acc.view_all)
      b.appendChild(
        el(
          "p",
          null,
          "Sees every report, through " +
            acc.roles
              .filter(function (r) {
                return r.view_all;
              })
              .map(function (r) {
                return "the role " + r.name;
              })
              .join(" and ") +
            ".",
        ),
      );
    if (acc.waiting)
      b.appendChild(el("p", null, "Nothing is shared with this person yet."));
    var gl = el("ul", "acc-list");
    acc.grants.forEach(function (g) {
      var item = li(gl);
      item.appendChild(el("span", null, g.text));
      item.appendChild(
        el(
          "small",
          "muted",
          g.owner.type === "user"
            ? " \u2013 their own grant"
            : " \u2013 from the role " + g.owner.name,
        ),
      );
    });
    if (acc.grants.length) b.appendChild(gl);
    b.appendChild(el("p", "acc-reach", Core.reachText(acc.reach)));
    return p.sec;
  }

  /* ---------- grants (shared by users and roles) ---------- */
  function fillGrants(list, grants, owner, box) {
    clear(list);
    if (!grants.length) none(list, "No grants.");
    grants.forEach(function (g) {
      var item = li(list);
      item.appendChild(el("span", null, g.text));
      item.appendChild(
        btn("Edit\u2026", "mini", function (e) {
          openGrantEditor(owner, g, e.currentTarget);
        }),
      );
      item.appendChild(
        btn("Remove", "mini", function () {
          act(post("grants/" + g.id + "/remove", {}), "Grant removed.");
        }),
      );
    });
    var bar = el("div", "acc-bar");
    bar.appendChild(
      btn("Add a grant\u2026", "", function (e) {
        openGrantEditor(owner, null, e.currentTarget);
      }),
    );
    box.appendChild(bar);
  }

  function openGrantEditor(owner, grant, returnTo) {
    get("catalog").then(function (cat) {
      var ctl = {},
        hints = {},
        known = {
          server: cat.servers.map(function (s) {
            return s.ip;
          }),
          exchange: cat.exchanges.map(function (x) {
            return x.code;
          }),
          segment: cat.segments.map(function (x) {
            return x.code;
          }),
        },
        names = {
          server: cat.servers.map(function (s) {
            return [s.ip, s.name];
          }),
          exchange: cat.exchanges.map(function (x) {
            return [x.code, x.name];
          }),
          segment: cat.segments.map(function (x) {
            return [x.code, x.name];
          }),
        },
        preview,
        dealerErr,
        dealerHint;
      var KIND = {
        any: "Any",
        seen: "Found in the data",
        new: "Not seen yet (it can still be saved)",
      };

      function values() {
        function v(k) {
          return ctl[k].value.trim() || "*";
        }
        return {
          server: v("server"),
          exchange: v("exchange"),
          segment: v("segment"),
          dealer: v("dealer"),
        };
      }
      function refresh() {
        var g = values(),
          why = Core.dealerProblem(ctl.dealer.value);
        ["server", "exchange", "segment"].forEach(function (k) {
          hints[k].textContent = KIND[Core.valueKind(ctl[k].value, known[k])];
        });
        dealerErr.textContent = why;
        dealerHint.hidden = !!why;
        ctl.dealer.setAttribute("aria-invalid", why ? "true" : "false");
        preview.textContent = why
          ? ""
          : "This reads: " +
            Core.grantText(g.server, g.exchange, g.segment, g.dealer);
      }

      UI.dialog({
        title: (grant ? "Change a grant of " : "Add a grant to ") + owner.label,
        message:
          "Choose from the files found, or pick \u201cAnother value\u201d to type one.",
        returnTo: returnTo,
        build: function (body) {
          [
            ["server", "Server", grant ? grant.server : "*"],
            ["exchange", "Exchange", grant ? grant.exchange : "*"],
            ["segment", "Segment", grant ? grant.segment : "*"],
          ].forEach(function (f) {
            var OTHER = "\u0000other",
              row = el("label", "frow"),
              sel = el("select", "fi"),
              input = el("input", "fi"),
              start = f[2] && f[2] !== "*" ? f[2] : "*";
            function opt(value, text) {
              var o = el("option", null, text);
              o.value = value;
              sel.appendChild(o);
            }
            opt("*", "Any");
            names[f[0]].forEach(function (n) {
              opt(
                n[0],
                n[1] && n[1] !== n[0] ? n[0] + " \u00b7 " + n[1] : n[0],
              );
            });
            opt(OTHER, "Another value\u2026");
            if (start === "*" || known[f[0]].indexOf(start) >= 0)
              sel.value = start;
            else {
              sel.value = OTHER;
              input.value = start;
            }
            input.maxLength = 64;
            input.autocomplete = "off";
            input.spellcheck = false;
            input.setAttribute("aria-label", f[1] + " value");
            input.hidden = sel.value !== OTHER;
            sel.addEventListener("change", function () {
              input.hidden = sel.value !== OTHER;
              if (!input.hidden) input.focus();
              refresh();
            });
            input.addEventListener("input", refresh);
            hints[f[0]] = el("small", "hint");
            row.appendChild(el("span", null, f[1]));
            row.appendChild(sel);
            row.appendChild(input);
            row.appendChild(hints[f[0]]);
            body.appendChild(row);
            ctl[f[0]] = {
              get value() {
                return sel.value === OTHER ? input.value : sel.value;
              },
            };
          });
          var drow = el("label", "frow"),
            dinput = el("input", "fi");
          dinput.value = grant ? grant.dealer : "*";
          dinput.maxLength = 65;
          dinput.autocomplete = "off";
          dinput.spellcheck = false;
          dinput.addEventListener("input", refresh);
          dealerErr = el("small", "hint bad");
          dealerErr.setAttribute("role", "alert");
          drow.appendChild(el("span", null, "Dealer"));
          drow.appendChild(dinput);
          dealerHint = el("small", "hint", DEALER_HELP);
          drow.appendChild(dealerHint);
          drow.appendChild(dealerErr);
          body.appendChild(drow);
          ctl.dealer = dinput;
          preview = el("p", "grant-preview");
          preview.setAttribute("role", "status");
          preview.setAttribute("aria-live", "polite");
          body.appendChild(preview);
          if (cat.error)
            body.appendChild(
              el("p", "hint", "Some choices may be missing: " + cat.error),
            );
          refresh();
        },
        actions: [
          {
            label: "Save grant",
            kind: "primary",
            run: function (api) {
              var why = Core.dealerProblem(ctl.dealer.value);
              if (why) {
                ctl.dealer.focus();
                return false;
              }
              var g = values();
              return (
                grant
                  ? post("grants/" + grant.id + "/update", g)
                  : post("grants/add", {
                      owner_type: owner.type,
                      owner_id: owner.id,
                      server: g.server,
                      exchange: g.exchange,
                      segment: g.segment,
                      dealer: g.dealer,
                    })
              ).then(function () {
                render();
                say("Grant saved.");
              });
            },
          },
        ],
      });
    }, fail);
  }

  /* ---------- a group ---------- */
  function groupDetail(id) {
    var mine = ++S.dreq;
    D.body.appendChild(head("Group", "Groups"));
    var holder = el("div");
    D.body.appendChild(holder);
    pending(holder);
    Promise.all([get("groups/" + id), allOf("roles")]).then(
      function (r) {
        if (mine !== S.dreq || !S.active) return;
        clear(holder);
        paintGroup(holder, r[0], r[1]);
        D.body.querySelector("h2").textContent = r[0].name;
      },
      function (e) {
        if (mine !== S.dreq) return;
        clear(holder);
        holder.appendChild(
          el(
            "p",
            "acc-empty",
            (e && e.message) || "Could not load this group.",
          ),
        );
        fail(e);
      },
    );
  }

  function paintGroup(box, g, allRoles) {
    var grid = el("div", "acc-grid"),
      p = panel("Group"),
      name = addField(p.body, { label: "Name", value: g.name, max: 64 }),
      bar = el("div", "acc-bar");
    bar.appendChild(
      btn("Rename", "", function () {
        act(
          post("groups/" + g.id + "/rename", {
            name: name.value,
            version: g.version,
          }),
          "Renamed.",
        );
      }),
    );
    bar.appendChild(
      btn("Delete group\u2026", "", function (e) {
        ask(
          "Delete the group " + g.name + "?",
          Core.plural(g.members, "member") +
            (g.members === 1 ? " is" : " are") +
            " affected: they lose what only this group gives them. The people themselves stay.",
          "Delete group",
          true,
          e.currentTarget,
        ).then(function (ok) {
          if (!ok) return;
          post("groups/" + g.id + "/delete", { confirm: true }).then(
            function () {
              say("Group " + g.name + " deleted.");
              closeDetail();
            },
            fail,
          );
        });
      }),
    );
    p.body.appendChild(bar);
    p.body.appendChild(el("p", "muted", Core.plural(g.members, "member")));
    grid.appendChild(p.sec);

    var pr = panel("Roles of this group"),
      rl = el("ul", "acc-list");
    if (!g.roles.length)
      none(rl, "No role. Members get nothing from this group yet.");
    g.roles.forEach(function (r) {
      var item = li(rl);
      item.appendChild(el("span", null, r.name));
      item.appendChild(
        btn("Remove", "mini", function () {
          act(
            post("groups/" + g.id + "/roles/remove", { role_id: r.id }),
            "Role " + r.name + " removed.",
          );
        }),
      );
    });
    pr.body.appendChild(rl);
    var have = {};
    g.roles.forEach(function (r) {
      have[r.id] = 1;
    });
    addRow(
      pr.body,
      "Role to add",
      allRoles.filter(function (r) {
        return !have[r.id];
      }),
      "Choose a role\u2026",
      function (rid) {
        act(
          post("groups/" + g.id + "/roles/add", { role_id: rid }),
          "Role added.",
        );
      },
    );
    grid.appendChild(pr.sec);
    box.appendChild(grid);

    var pm = panel("Members"),
      actions = el("div", "acc-bar"),
      count = el("span", "acc-count"),
      bAdd = btn("Add members\u2026", "", function () {
        openAddMembers(g, bAdd, function () {
          mblock.reload();
        });
      }),
      bDel = btn("Remove chosen", "", function () {
        var ids = keys(S.gsel).map(Number);
        post("groups/" + g.id + "/members/remove", { user_ids: ids }).then(
          function (r) {
            clearSel(S.gsel);
            syncM();
            say(
              "Removed " +
                Core.plural(r.changed, "member") +
                " from " +
                g.name +
                ".",
            );
            mblock.reload();
          },
          fail,
        );
      }),
      mblock;
    function syncM() {
      var n = keys(S.gsel).length;
      count.textContent = n
        ? Core.plural(n, "person", "people") + " chosen"
        : "No one chosen";
      bDel.disabled = !n;
    }
    actions.appendChild(count);
    actions.appendChild(bAdd);
    actions.appendChild(bDel);
    pm.body.appendChild(actions);
    box.appendChild(pm.sec);
    mblock = listBlock(pm.body, {
      path: "groups/" + g.id + "/members",
      state: S.members,
      title: "Members of " + g.name,
      placeholder: "Search members",
      empty: "This group has no members.",
      select: { map: S.gsel, max: MAX_PICK, onChange: syncM },
      cols: userCols(function (u) {
        openDetail("user", u.id);
      }).filter(function (c) {
        return c.h === "Sign-in name" || c.h === "Name";
      }),
    });
    syncM();
  }

  function openAddMembers(g, returnTo, done) {
    var chosen = {},
      token = 0,
      timer = 0,
      results,
      input,
      status;
    function find() {
      var mine = ++token;
      get(
        "users",
        "q=" + encodeURIComponent(input.value.trim()) + "&size=20",
      ).then(
        function (res) {
          if (mine !== token) return;
          clear(results);
          status.textContent = res.items.length
            ? "Showing " +
              res.items.length +
              " of " +
              Core.count(res.total) +
              ". Narrow the search to see others."
            : "No one found.";
          res.items.forEach(function (u) {
            var row = el("label", "frow check"),
              cb = el("input");
            cb.type = "checkbox";
            cb.checked = !!chosen[u.id];
            cb.addEventListener("change", function () {
              if (cb.checked) chosen[u.id] = u.login;
              else delete chosen[u.id];
            });
            row.appendChild(cb);
            row.appendChild(
              el("span", null, u.login + (u.name ? " \u2013 " + u.name : "")),
            );
            results.appendChild(row);
          });
        },
        function (e) {
          if (mine === token)
            status.textContent = (e && e.message) || "The search failed.";
        },
      );
    }
    UI.dialog({
      title: "Add members to " + g.name,
      returnTo: returnTo,
      build: function (body) {
        input = el("input", "fi");
        input.type = "search";
        input.placeholder = "Search people";
        input.setAttribute("aria-label", "Search people");
        input.maxLength = 100;
        input.autocomplete = "off";
        status = el("p", "hint");
        status.setAttribute("role", "status");
        results = el("div", "acc-pick");
        input.addEventListener("input", function () {
          clearTimeout(timer);
          timer = setTimeout(find, SEARCH_MS);
        });
        body.appendChild(input);
        body.appendChild(status);
        body.appendChild(results);
        find();
      },
      actions: [
        {
          label: "Add chosen",
          kind: "primary",
          run: function (api) {
            var ids = keys(chosen).map(Number);
            if (!ids.length) {
              api.error("Choose at least one person.");
              return false;
            }
            return post("groups/" + g.id + "/members/add", {
              user_ids: ids,
            }).then(function (r) {
              say(
                "Added " +
                  Core.plural(r.changed, "member") +
                  " to " +
                  g.name +
                  ".",
              );
              done();
            });
          },
        },
      ],
    });
  }

  /* ---------- a role ---------- */
  function roleDetail(id) {
    var mine = ++S.dreq;
    D.body.appendChild(head("Role", "Roles"));
    var holder = el("div");
    D.body.appendChild(holder);
    pending(holder);
    get("roles/" + id).then(
      function (r) {
        if (mine !== S.dreq || !S.active) return;
        clear(holder);
        paintRole(holder, r);
        D.body.querySelector("h2").textContent = r.name;
      },
      function (e) {
        if (mine !== S.dreq) return;
        clear(holder);
        holder.appendChild(
          el("p", "acc-empty", (e && e.message) || "Could not load this role."),
        );
        fail(e);
      },
    );
  }

  function paintRole(box, r) {
    var grid = el("div", "acc-grid"),
      p = panel("Role"),
      b = p.body;
    if (r.builtin) {
      b.appendChild(
        el(
          "p",
          null,
          "This is a built-in role and cannot be changed or deleted.",
        ),
      );
      b.appendChild(
        el(
          "p",
          null,
          r.manage
            ? "It can manage access and sees every report."
            : r.view_all
              ? "It sees every report."
              : "It sees only what is granted to the person or through their other roles.",
        ),
      );
    } else {
      var name = addField(b, { label: "Name", value: r.name, max: 64 }),
        va = addField(b, {
          label: "Sees every report",
          type: "checkbox",
          value: r.view_all,
        }),
        bar = el("div", "acc-bar");
      bar.appendChild(
        btn("Rename", "", function () {
          act(
            post("roles/" + r.id + "/rename", {
              name: name.value,
              version: r.version,
            }),
            "Renamed.",
          );
        }),
      );
      va.addEventListener("change", function () {
        act(
          post("roles/" + r.id + "/view_all", {
            view_all: va.checked,
            version: r.version,
          }),
          va.checked
            ? "The role now sees every report."
            : "The role no longer sees every report.",
        );
      });
      bar.appendChild(
        btn("Delete role\u2026", "", function (e) {
          ask(
            "Delete the role " + r.name + "?",
            Core.plural(r.users, "person", "people") +
              (r.users === 1 ? " is" : " are") +
              " affected: they lose what only this role gives them. The people themselves stay.",
            "Delete role",
            true,
            e.currentTarget,
          ).then(function (ok) {
            if (!ok) return;
            post("roles/" + r.id + "/delete", { confirm: true }).then(
              function () {
                say("Role " + r.name + " deleted.");
                closeDetail();
              },
              fail,
            );
          });
        }),
      );
      b.appendChild(bar);
    }
    b.appendChild(
      el(
        "p",
        "muted",
        "Held by " + Core.plural(r.users, "person", "people") + ".",
      ),
    );
    grid.appendChild(p.sec);

    var pg = panel("Groups with this role"),
      gl = el("ul", "acc-list");
    if (!r.groups.length) none(gl, "No group has this role.");
    r.groups.forEach(function (g) {
      var item = li(gl);
      item.appendChild(
        lnk(g.name, function () {
          openDetail("group", g.id);
        }),
      );
    });
    pg.body.appendChild(gl);
    grid.appendChild(pg.sec);

    var pgr = panel("Grants of this role");
    if (r.builtin)
      pgr.body.appendChild(
        el(
          "p",
          "muted",
          "Built-in roles do not take grants. Make a custom role to share particular reports.",
        ),
      );
    else {
      var grl = el("ul", "acc-list");
      pgr.body.appendChild(grl);
      fillGrants(
        grl,
        r.grants,
        { type: "role", id: r.id, label: r.name },
        pgr.body,
      );
    }
    grid.appendChild(pgr.sec);
    box.appendChild(grid);
  }

  /* ======================================================================
   * Import
   * ==================================================================== */
  function openImport(returnTo, done) {
    var preview = null,
      file,
      result,
      note;
    function readFile(f) {
      return new Promise(function (resolve, reject) {
        var rd = new FileReader();
        rd.onload = function () {
          resolve(String(rd.result));
        };
        rd.onerror = function () {
          reject(new Error("The file could not be read."));
        };
        rd.readAsText(f, "utf-8");
      });
    }
    function show(res) {
      clear(result);
      result.appendChild(el("p", "acc-sum", Core.importSummary(res)));
      if (res.problem_count) {
        result.appendChild(
          el(
            "p",
            "hint bad",
            Core.plural(res.problem_count, "line") +
              " cannot be imported. Nothing is imported until every line is right.",
          ),
        );
        var ul = el("ul", "acc-list acc-problems");
        res.problems.forEach(function (pr) {
          ul.appendChild(el("li", "acc-li", Core.problemLine(pr)));
        });
        result.appendChild(ul);
        if (res.problem_count > res.problems.length)
          result.appendChild(
            el(
              "p",
              "hint",
              "\u2026and " +
                Core.count(res.problem_count - res.problems.length) +
                " more.",
            ),
          );
      }
    }
    UI.dialog({
      title: "Import users from a CSV file",
      returnTo: returnTo,
      build: function (body) {
        body.appendChild(
          el(
            "p",
            "hint",
            "The first line names the columns: login,name,roles,groups. Separate several roles or groups with ;. " +
              "Up to 10,000 lines or 2 MB. The SuperAdmin role cannot be imported. Nothing changes until you confirm.",
          ),
        );
        file = el("input", "fi");
        file.type = "file";
        file.accept = ".csv,.txt,text/csv,text/plain";
        file.setAttribute("aria-label", "CSV file");
        file.addEventListener("change", function () {
          preview = null;
          clear(result);
        });
        note = el("p", "hint");
        result = el("div");
        result.setAttribute("role", "status");
        body.appendChild(file);
        body.appendChild(note);
        body.appendChild(result);
      },
      actions: [
        {
          label: "Check file",
          run: function (api) {
            var f = file.files && file.files[0];
            if (!f) {
              api.error("Choose a file first.");
              return false;
            }
            if (f.size > 2 * 1024 * 1024) {
              api.error("The file is larger than the limit of 2 MB.");
              return false;
            }
            return readFile(f)
              .then(function (text) {
                return post("import/preview", { csv: text });
              })
              .then(function (res) {
                preview = res;
                show(res);
                return false; // stay open for the confirmation
              });
          },
        },
        {
          label: "Import\u2026",
          kind: "primary",
          run: function (api) {
            if (!preview) {
              api.error("Check the file first.");
              return false;
            }
            if (preview.problem_count) {
              api.error(
                "Fix the lines listed and check the file again. Nothing was imported.",
              );
              return false;
            }
            return ask(
              "Import these users?",
              Core.importSummary(preview) +
                " " +
                Core.plural(preview.lines, "line") +
                " in the file.",
              "Import",
              false,
            ).then(function (ok) {
              if (!ok) return false;
              return post("import/commit", { token: preview.token }).then(
                function (res) {
                  say(Core.importDone(res));
                  done();
                },
              );
            });
          },
        },
      ],
    });
  }

  /* ======================================================================
   * Audit log
   * ==================================================================== */
  function auditTab() {
    var A = S.audit,
      form = el("div", "acc-bar"),
      ctl = {},
      info = el("div", "acc-info"),
      wrap = el("div", "tblwrap"),
      table = el("table", "ctable acctbl"),
      tbody = el("tbody"),
      pager = el("div", "pager"),
      newer = btn("\u2039 Newer"),
      older = btn("Older \u203a"),
      csv = el("a", "btnlike", "Export CSV");

    function field(key, label, type, ph) {
      var row = el("label", "frow inline"),
        i = el("input", "fi");
      i.type = type;
      i.value = A.f[key] || "";
      i.maxLength = 100;
      i.autocomplete = "off";
      i.spellcheck = false;
      if (ph) i.placeholder = ph;
      i.addEventListener("keydown", function (e) {
        if (e.key === "Enter") applyFilters();
      });
      row.appendChild(el("span", null, label));
      row.appendChild(i);
      form.appendChild(row);
      ctl[key] = i;
    }
    field("since", "From", "date");
    field("until", "To", "date");
    field("user", "Person", "text", "sign-in name");
    field("event", "Event", "text", "grant.add or user.*");
    var orow = el("label", "frow inline"),
      osel = el("select", "fi");
    [
      ["", "Any result"],
      ["ok", "Succeeded"],
      ["denied", "Denied"],
    ].forEach(function (o) {
      var op = el("option", null, o[1]);
      op.value = o[0];
      osel.appendChild(op);
    });
    osel.value = A.f.outcome || "";
    orow.appendChild(el("span", null, "Result"));
    orow.appendChild(osel);
    form.appendChild(orow);
    ctl.outcome = osel;
    form.appendChild(btn("Apply", "", applyFilters));
    form.appendChild(csv);

    function filters() {
      var f = {};
      keys(ctl).forEach(function (k) {
        f[k] = ctl[k].value.trim();
      });
      return f;
    }
    function link() {
      csv.href = "api/admin/audit.csv?" + Core.auditQuery(A.f);
    }
    function applyFilters() {
      A.f = filters();
      A.before = null;
      A.stack = [];
      link();
      load();
    }

    var th = el("tr");
    [
      "Time",
      "Person",
      "Event",
      "Result",
      "Subject",
      "Details",
      "Address",
    ].forEach(function (h) {
      th.appendChild(el("th", null, h));
    });
    var thead = el("thead");
    thead.appendChild(th);
    table.appendChild(el("caption", "sr", "Audit log"));
    table.appendChild(thead);
    table.appendChild(tbody);
    wrap.appendChild(table);
    info.setAttribute("role", "status");
    older.addEventListener("click", function () {
      A.stack.push(A.before);
      A.before = older.dataset.next;
      load();
    });
    newer.addEventListener("click", function () {
      A.before = A.stack.pop() || null;
      load();
    });
    pager.appendChild(newer);
    pager.appendChild(older);
    D.body.appendChild(form);
    D.body.appendChild(info);
    D.body.appendChild(wrap);
    D.body.appendChild(pager);
    link();

    function load() {
      var mine = ++S.req;
      wrap.classList.add("acc-loading");
      get("audit", Core.auditQuery(A.f, A.before, A.size)).then(
        function (res) {
          if (mine !== S.req || !S.active) return;
          wrap.classList.remove("acc-loading");
          clear(tbody);
          if (!res.items.length) {
            var tr0 = el("tr"),
              td0 = el("td", "acc-empty", "No entries match.");
            td0.colSpan = 7;
            tr0.appendChild(td0);
            tbody.appendChild(tr0);
          }
          res.items.forEach(function (e) {
            var tr = el("tr");
            cell(tr, Core.fmtTime(e.ts));
            cell(tr, e.actor);
            cell(tr, e.event);
            cell(
              tr,
              e.outcome === "denied" ? "Denied" : "Succeeded",
              e.outcome === "denied" ? "deny" : "",
            );
            cell(tr, e.subject);
            cell(tr, e.detail, "wrapc");
            cell(tr, e.addr);
            tbody.appendChild(tr);
          });
          info.textContent = res.items.length
            ? "Showing " +
              Core.plural(res.items.length, "entry", "entries") +
              ", newest first."
            : "";
          newer.disabled = !A.stack.length;
          older.disabled = !res.next;
          older.dataset.next = res.next || "";
        },
        function (e) {
          if (mine !== S.req || !S.active) return;
          wrap.classList.remove("acc-loading");
          fail(e);
        },
      );
    }
    load();
  }

  /* ======================================================================
   * Page structure and the view contract (see shell.js)
   * ==================================================================== */
  function paintTabs() {
    var list = D.tabs.querySelectorAll("[role=tab]");
    for (var i = 0; i < list.length; i++) {
      var on = list[i].getAttribute("data-tab") === S.tab;
      list[i].setAttribute("aria-selected", on ? "true" : "false");
      list[i].tabIndex = on ? 0 : -1;
      list[i].classList.toggle("on", on);
    }
  }

  function render() {
    paintTabs();
    clear(D.body);
    S.req++;
    S.dreq++;
    persist();
    if (S.detail) {
      var d = S.detail;
      if (d.type === "user") userDetail(d.id);
      else if (d.type === "group") groupDetail(d.id);
      else roleDetail(d.id);
      return;
    }
    ({
      pending: pendingTab,
      users: usersTab,
      groups: groupsTab,
      roles: rolesTab,
      audit: auditTab,
    })[S.tab]();
  }

  function chooseTab(id, focus) {
    S.tab = id;
    S.detail = null;
    say("");
    render();
    if (focus) {
      var t = D.tabs.querySelector('[data-tab="' + id + '"]');
      if (t) t.focus();
    }
  }

  function build() {
    S.built = true;
    D.tabs = el("div", "acc-tabs");
    D.tabs.setAttribute("role", "tablist");
    D.tabs.setAttribute("aria-label", "Access");
    TABS.forEach(function (t) {
      var b = btn(t.label, "acc-tab", function () {
        chooseTab(t.id, false);
      });
      b.setAttribute("role", "tab");
      b.setAttribute("data-tab", t.id);
      D.tabs.appendChild(b);
    });
    D.tabs.addEventListener("keydown", function (e) {
      var ids = Core.tabIds(),
        i = ids.indexOf(S.tab),
        n = null;
      if (e.key === "ArrowRight") n = (i + 1) % ids.length;
      else if (e.key === "ArrowLeft") n = (i + ids.length - 1) % ids.length;
      else if (e.key === "Home") n = 0;
      else if (e.key === "End") n = ids.length - 1;
      if (n === null) return;
      e.preventDefault();
      chooseTab(ids[n], true);
    });
    D.msg = el("div", "acc-msg");
    D.msg.setAttribute("role", "status");
    D.err = el("div", "acc-err");
    D.err.setAttribute("role", "alert");
    D.body = el("div", "acc-body");
    host.appendChild(D.tabs);
    host.appendChild(D.msg);
    host.appendChild(D.err);
    host.appendChild(D.body);
  }

  function enter(h) {
    S.active = true;
    if (!S.built) build();
    if (h && h.at !== undefined) {
      var st = Core.stateFromHash(h);
      if (st.tab !== S.tab) S.detail = null;
      S.tab = st.tab;
      if (S.lists[st.tab]) {
        S.lists[st.tab].q = st.q;
        S.lists[st.tab].page = st.page;
      }
    } else if (h && (h.aq || h.ap) && S.lists[S.tab]) {
      var s2 = Core.stateFromHash(h);
      S.lists[S.tab].q = s2.q;
      S.lists[S.tab].page = s2.page;
    }
    say("");
    render();
  }
  function leave() {
    S.active = false;
    S.req++;
    S.dreq++;
  }

  Shell.register({ id: "access", el: host, enter: enter, leave: leave });
})(typeof window !== "undefined" ? window : {});
