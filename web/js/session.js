/* Signed-in session handling shared by every view.
 *
 * Every request to the server goes through get() / post(): a 401 means the session ended, so
 * the page remembers where the user was (the address hash) and goes to the sign-in page; any
 * other failure rejects with the server's own message (a 403 says "Access denied").
 *
 * Core takes its browser parts as arguments so it can be tested in Node.
 */
(function (root) {
  "use strict";

  var RETURN_KEY = "mps.returnHash";
  var FULL_ME = { auth: false, views: ["mps", "otr"], pending: false };

  function SignedOut() {
    var e = new Error("Signed out");
    e.signedOut = true;
    return e;
  }

  function createClient(deps) {
    var meP = null;

    function parse(r) {
      return r.json().then(
        function (j) {
          return j;
        },
        function () {
          return {};
        },
      );
    }

    function settle(r) {
      if (r.status === 401) {
        deps.signIn();
        throw SignedOut();
      }
      return parse(r).then(function (j) {
        if (!r.ok) {
          var e = new Error((j && j.error) || "HTTP " + r.status);
          e.status = r.status; // the answer's own fields (reason, affected, problems) stay available
          e.data = j || {};
          throw e;
        }
        return j;
      });
    }

    function get(url) {
      return deps.fetch(url, { cache: "no-store" }).then(settle);
    }

    function post(url, body) {
      return deps
        .fetch(url, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-MPS": "1" },
          body: JSON.stringify(body || {}),
        })
        .then(settle);
    }

    /* who is signed in, asked once; a server that cannot say gives full access so the page
       behaves as it always did */
    function me() {
      if (!meP)
        meP = get("api/me").catch(function (e) {
          if (e && e.signedOut) throw e;
          return FULL_ME;
        });
      return meP;
    }

    return { get: get, post: post, me: me };
  }

  var Core = {
    RETURN_KEY: RETURN_KEY,
    FULL_ME: FULL_ME,
    createClient: createClient,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = Core;
  if (typeof window === "undefined" || typeof document === "undefined") return;

  var client = createClient({
    fetch: function (url, opts) {
      return window.fetch(url, opts);
    },
    signIn: function () {
      try {
        sessionStorage.setItem(RETURN_KEY, location.hash || "");
      } catch (e) {
        /* ignore */
      }
      location.replace("login");
    },
  });

  root.MPSSession = {
    Core: Core,
    get: client.get,
    post: client.post,
    me: client.me,
    signOut: function () {
      return client
        .post("auth/logout", {})
        .catch(function () {})
        .then(function () {
          try {
            sessionStorage.removeItem(RETURN_KEY);
          } catch (e) {
            /* ignore */
          }
          location.replace("login");
        });
    },
  };
})(typeof window !== "undefined" ? window : {});
