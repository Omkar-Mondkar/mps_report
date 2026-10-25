/* Page shell: a closable menu and one visible view at a time.
 *
 * A view registers { id, el, enter(hash), leave() } with MPSShell.register(). The shell shows
 * the view's container and calls enter(hashParams); the view calls leave() when another view
 * is chosen and must stop all of its network activity there. The address hash names the view
 * with `v` (omitted for the default MPS view, so links from before the menu existed keep
 * working); each view writes the rest of the hash itself through MPSShell.setHash().
 *
 * Core is pure (also loadable from Node for tests); the rest needs the page.
 */
(function (root) {
  "use strict";

  var DEFAULT = "mps";
  var REPORT_VIEWS = ["mps", "otr"];
  var VIEWS = ["mps", "otr", "access"]; // access: administrators only
  var MIN_PASSWORD = 10; // the server's rule (auth/password.py)
  var NARROW_QUERY = "(max-width: 899px)";

  /* ======================================================================
   * Core: hash and menu rules (no DOM)
   * ==================================================================== */
  var Core = {
    DEFAULT: DEFAULT,
    VIEWS: VIEWS,
    /* "#v=otr&os=1" -> {v: "otr", os: "1"} */
    parseHash: function (str) {
      var o = {};
      new URLSearchParams(String(str || "").replace(/^#/, "")).forEach(
        function (v, k) {
          o[k] = v;
        },
      );
      return o;
    },
    /* The view an address asks for; anything unknown or missing is the default view. */
    viewFromHash: function (h, ids) {
      ids = ids || VIEWS;
      if (h && typeof h.v === "string" && ids.indexOf(h.v) >= 0) return h.v;
      return ids.indexOf(DEFAULT) >= 0 || !ids.length ? DEFAULT : ids[0];
    },
    /* The views a signed-in user may open, from /api/me. Without sign-in (auth off, or an
       anonymous visitor while the server only audits) everything is open; a user who is
       still waiting for access, or has no data to see, gets none. */
    allowedViews: function (me) {
      if (!me || !me.auth) return REPORT_VIEWS.slice();
      if (me.pending || !Array.isArray(me.views)) return [];
      var out = REPORT_VIEWS.filter(function (v) {
        return me.views.indexOf(v) >= 0;
      });
      if (me.manage === true) out.push("access");
      return out;
    },
    /* "access" when the address asks for the Access view and this user may not open it
       (they get a no-access message instead of a different view); otherwise "". */
    deniedView: function (h, allowed) {
      return h && h.v === "access" && (allowed || []).indexOf("access") < 0
        ? "access"
        : "";
    },
    MIN_PASSWORD: MIN_PASSWORD,
    /* What is wrong with a change-password form, or "" when it can be sent. */
    passwordProblem: function (current, next, again) {
      if (!current) return "Enter your current password.";
      if (typeof next !== "string" || next.length < MIN_PASSWORD)
        return (
          "The new password must be at least " + MIN_PASSWORD + " characters."
        );
      if (next !== again) return "The two new passwords do not match.";
      if (next === current)
        return "The new password must be different from the current one.";
      return "";
    },
    /* The name shown in the header; empty when nobody is signed in. */
    whoLabel: function (me) {
      return me && me.auth ? String(me.name || me.login || "") : "";
    },
    /* "#v=<view>&k=v..." ; no `v` for the default view; empty values are left out. */
    buildHash: function (view, params) {
      var p = new URLSearchParams();
      if (view !== DEFAULT) p.set("v", view);
      Object.keys(params || {}).forEach(function (k) {
        var v = params[k];
        if (k === "v" || v === null || v === undefined || v === "") return;
        p.set(k, String(v));
      });
      var s = p.toString();
      return s ? "#" + s : "";
    },
    /* Menu starts closed on narrow screens, otherwise as the user last left it (open by
       default). */
    initialMenu: function (saved, narrow) {
      return !narrow && saved !== "closed";
    },
  };

  if (typeof module !== "undefined" && module.exports) module.exports = Core;
  if (typeof document === "undefined") return;

  /* ======================================================================
   * Shell
   * ==================================================================== */
  var $ = function (id) {
    return document.getElementById(id);
  };
  var views = {},
    allowed = null, // view ids this user may open; null until /api/me has answered
    cur = null,
    menuOpen = true,
    nav = $("sideMenu"),
    btn = $("menuBtn"),
    scrim = $("menuScrim"),
    nameEl = $("viewName"),
    items = nav.querySelectorAll(".mitem"),
    mq = window.matchMedia ? window.matchMedia(NARROW_QUERY) : null;

  function narrow() {
    return !!(mq && mq.matches);
  }
  function saveMenu(open) {
    try {
      localStorage.setItem("mps.menu", open ? "open" : "closed");
    } catch (e) {
      /* ignore */
    }
  }
  function savedMenu() {
    try {
      return localStorage.getItem("mps.menu");
    } catch (e) {
      return null;
    }
  }

  /* `remember` is false for changes the user did not ask for (start-up, window resizes) and
     is ignored on narrow screens, so a phone does not overwrite the desktop preference. */
  function setMenu(open, remember) {
    menuOpen = open;
    nav.hidden = !open;
    scrim.hidden = !(open && narrow());
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    if (remember && !narrow()) saveMenu(open);
  }
  function activeItem() {
    return nav.querySelector('.mitem[aria-current="page"]') || items[0];
  }

  function paintMenu() {
    for (var i = 0; i < items.length; i++) {
      var on = items[i].getAttribute("data-view") === cur;
      items[i].classList.toggle("on", on);
      if (on) items[i].setAttribute("aria-current", "page");
      else items[i].removeAttribute("aria-current");
      if (on) nameEl.textContent = items[i].textContent.trim();
    }
  }

  function viewIds() {
    return allowed || Object.keys(views);
  }

  function show(id) {
    if (!views[id] || (allowed && allowed.indexOf(id) < 0))
      id = Core.viewFromHash({}, viewIds());
    if (!views[id]) return;
    var prev = cur && views[cur];
    if (prev && cur !== id) {
      prev.leave();
      prev.el.hidden = true;
    }
    cur = id;
    for (var k in views) if (k !== id) views[k].el.hidden = true; // also the first view the page shows by default
    views[id].el.hidden = false;
    paintMenu();
    document.title = nameEl.textContent; // a view may refine it in enter()
    views[id].enter(Core.parseHash(location.hash));
  }

  function setHash(view, params) {
    var h = Core.buildHash(view, params);
    try {
      history.replaceState(null, "", h || location.pathname + location.search);
    } catch (e) {
      /* ignore */
    }
  }

  btn.addEventListener("click", function () {
    setMenu(!menuOpen, true);
    if (menuOpen) activeItem().focus();
  });
  $("menuClose").addEventListener("click", function () {
    setMenu(false, true);
    btn.focus();
  });
  scrim.addEventListener("click", function () {
    setMenu(false, true);
    btn.focus();
  });
  for (var i = 0; i < items.length; i++) {
    items[i].addEventListener("click", function () {
      var id = this.getAttribute("data-view");
      if (id !== cur) show(id);
      if (narrow()) {
        setMenu(false, false);
        btn.focus();
      }
    });
  }
  /* Escape closes the menu when the focus is in it or nowhere in particular; an Escape meant
     for a dropdown inside a view is left alone. On narrow screens the menu is an overlay, so
     Escape always closes it. */
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || !menuOpen || e.defaultPrevented) return;
    var t = e.target;
    if (
      narrow() ||
      t === btn ||
      t === document.body ||
      (t && nav.contains(t))
    ) {
      setMenu(false, true);
      btn.focus();
    }
  });
  function onWidthChange() {
    setMenu(Core.initialMenu(savedMenu(), narrow()), false);
  }
  if (mq) {
    if (mq.addEventListener) mq.addEventListener("change", onWidthChange);
    else if (mq.addListener) mq.addListener(onWidthChange);
  }
  window.addEventListener("hashchange", function () {
    if (!cur) return; // nothing is shown yet (or the access-pending panel is)
    var id = Core.viewFromHash(Core.parseHash(location.hash), viewIds());
    if (id !== cur) show(id);
  });

  /* ---------- who is signed in ---------- */
  function applyMe(me) {
    allowed = Core.allowedViews(me);
    for (var i = 0; i < items.length; i++)
      items[i].hidden = allowed.indexOf(items[i].getAttribute("data-view")) < 0;
    var label = Core.whoLabel(me),
      who = $("whoami");
    if (who) {
      who.hidden = !label;
      $("whoName").textContent = label;
    }
    var pwBtn = $("changePw");
    if (pwBtn) pwBtn.hidden = !(me && me.auth && me.has_password === true);
    return allowed.length > 0;
  }

  /* ---------- change own password ---------- */
  var noteTimer = 0;
  function note(text) {
    var n = $("shellNote");
    if (!n) return;
    n.textContent = text;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(function () {
      n.textContent = "";
    }, 8000);
  }

  function field(body, label, type, autocomplete) {
    var row = document.createElement("label"),
      span = document.createElement("span"),
      input = document.createElement("input");
    row.className = "frow";
    span.textContent = label;
    input.type = type;
    input.className = "fi";
    input.autocomplete = autocomplete;
    input.maxLength = 1024;
    row.appendChild(span);
    row.appendChild(input);
    body.appendChild(row);
    return input;
  }

  function openPasswordDialog() {
    var S = root.MPSSession,
      UI = root.MPSUI,
      f = {};
    if (!S || !UI || !UI.dialog) return;
    UI.dialog({
      title: "Change password",
      message:
        "Other places you are signed in with this account will be signed out. At least " +
        MIN_PASSWORD +
        " characters.",
      returnTo: $("changePw"),
      build: function (body) {
        f.cur = field(body, "Current password", "password", "current-password");
        f.a = field(body, "New password", "password", "new-password");
        f.b = field(body, "New password again", "password", "new-password");
      },
      actions: [
        {
          label: "Change password",
          kind: "primary",
          run: function (api) {
            var why = Core.passwordProblem(f.cur.value, f.a.value, f.b.value);
            if (why) {
              api.error(why); // nothing is sent
              return false;
            }
            return S.post("auth/password", {
              current: f.cur.value,
              new: f.a.value,
            }).then(function () {
              note("Password changed. Your other sessions were signed out.");
            });
          },
        },
      ],
    });
  }

  function showPending() {
    nav.hidden = true;
    scrim.hidden = true;
    btn.hidden = true;
    $("views").hidden = true;
    nameEl.textContent = "";
    document.title = "Access pending";
    var p = document.createElement("section"),
      h = document.createElement("h2"),
      t = document.createElement("p");
    p.className = "pending-panel";
    h.textContent = "Access pending";
    t.textContent =
      "You are signed in, but nothing has been shared with you yet. Ask an administrator to give you access.";
    p.appendChild(h);
    p.appendChild(t);
    $("layout").appendChild(p);
  }

  /* A direct address of the Access view by someone who may not open it: a message, and
     no request to the management routes is ever made. */
  function showNoAccess() {
    var views = $("views"),
      p = document.createElement("section"),
      h = document.createElement("h2"),
      t = document.createElement("p"),
      b = document.createElement("button");
    views.hidden = true;
    nameEl.textContent = "";
    document.title = "No access";
    p.className = "pending-panel";
    p.setAttribute("role", "alert");
    h.textContent = "No access";
    t.textContent = "You do not have access to this page.";
    b.type = "button";
    b.textContent = "Go to the reports";
    b.addEventListener("click", function () {
      try {
        history.replaceState(null, "", location.pathname + location.search);
      } catch (e) {
        /* ignore */
      }
      p.parentNode.removeChild(p);
      views.hidden = false;
      begin();
    });
    p.appendChild(h);
    p.appendChild(t);
    p.appendChild(b);
    $("layout").appendChild(p);
    b.focus();
  }

  function begin() {
    setMenu(Core.initialMenu(savedMenu(), narrow()), false);
    var h = Core.parseHash(location.hash);
    if (Core.deniedView(h, allowed)) return showNoAccess();
    show(Core.viewFromHash(h, viewIds()));
  }

  function start() {
    var out = $("signOut"),
      S = root.MPSSession;
    if (out && S) out.addEventListener("click", S.signOut);
    if ($("changePw"))
      $("changePw").addEventListener("click", openPasswordDialog);
    if (!S) return begin();
    S.me().then(
      function (me) {
        if (applyMe(me)) begin();
        else showPending();
      },
      function () {
        /* signed out: session.js is already sending the browser to the sign-in page */
      },
    );
  }

  root.MPSShell = {
    Core: Core,
    register: function (v) {
      views[v.id] = v;
    },
    show: show,
    setHash: setHash,
    current: function () {
      return cur;
    },
  };

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", start);
  else start();
})(typeof window !== "undefined" ? window : {});
