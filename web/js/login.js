/* Sign-in page: posts the credentials, then returns to the dashboard.
   The dashboard remembers the view the user was on (session.js keeps it in
   sessionStorage under "mps.returnHash") and restores it after sign-in. */
(function () {
  "use strict";

  var form = document.getElementById("loginForm");
  var userEl = document.getElementById("user");
  var passEl = document.getElementById("pass");
  var goEl = document.getElementById("go");
  var errEl = document.getElementById("err");

  function busy(on) {
    goEl.disabled = on;
    goEl.classList.toggle("busy", on);
    userEl.disabled = on;
    passEl.disabled = on;
  }

  function fail(msg) {
    errEl.textContent = msg;
    busy(false);
    passEl.value = "";
    passEl.focus();
  }

  function home() {
    var hash = "";
    try {
      hash = sessionStorage.getItem("mps.returnHash") || "";
      sessionStorage.removeItem("mps.returnHash");
    } catch (e) {
      hash = "";
    }
    if (!/^#[A-Za-z0-9_=&.%,~-]*$/.test(hash)) hash = "";
    location.replace("./" + hash);
  }

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    errEl.textContent = "";
    var login = userEl.value.trim();
    if (!login || !passEl.value) {
      errEl.textContent = "Enter a user id and a password";
      return;
    }
    busy(true);
    fetch("auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-MPS": "1" },
      body: JSON.stringify({ login: login, password: passEl.value }),
    })
      .then(function (r) {
        return r
          .json()
          .catch(function () {
            return {};
          })
          .then(function (j) {
            return { ok: r.ok, body: j };
          });
      })
      .then(function (res) {
        if (res.ok) return home();
        fail(res.body.error || "Sign-in failed");
      })
      .catch(function () {
        fail("Cannot reach the server");
      });
  });
})();
