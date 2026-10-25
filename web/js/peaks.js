/* Rate expressions for the message-rate search (shared by the dashboard and Compare).
 * parseRate(text) -> {ok:true, test(v), label} | {ok:false, empty:boolean, error}
 * Accepted: N, A-B (inclusive), >N, >=N, <N, <=N. Pure; also loadable from Node for tests. */
(function (root) {
  "use strict";

  var HELP =
    "Use a rate (150), a range (100-200) or a comparison (>=150, <50).";
  var NUM = "(\\d+(?:\\.\\d+)?)";
  var RE_EXACT = new RegExp("^" + NUM + "$");
  var RE_RANGE = new RegExp("^" + NUM + "-" + NUM + "$");
  var RE_CMP = new RegExp("^(>=|<=|>|<)" + NUM + "$");

  function bad(msg) {
    return { ok: false, empty: false, error: msg };
  }

  function parseRate(text) {
    var s = String(text == null ? "" : text).replace(/[\s,]/g, ""),
      m,
      a,
      b;
    if (!s) return { ok: false, empty: true, error: "" };

    if ((m = RE_EXACT.exec(s))) {
      a = Math.fround(+m[1]);
      return {
        ok: true,
        label: "= " + m[1],
        test: function (v) {
          return v === a || v === +m[1];
        },
      };
    }
    if ((m = RE_RANGE.exec(s))) {
      a = +m[1];
      b = +m[2];
      if (a > b)
        return bad(
          "In a range the first number must not be larger than the second. " +
            HELP,
        );
      return {
        ok: true,
        label: m[1] + " \u2013 " + m[2],
        test: function (v) {
          return v >= a && v <= b;
        },
      };
    }
    if ((m = RE_CMP.exec(s))) {
      a = +m[2];
      switch (m[1]) {
        case ">":
          return {
            ok: true,
            label: "> " + m[2],
            test: function (v) {
              return v > a;
            },
          };
        case ">=":
          return {
            ok: true,
            label: "\u2265 " + m[2],
            test: function (v) {
              return v >= a;
            },
          };
        case "<":
          return {
            ok: true,
            label: "< " + m[2],
            test: function (v) {
              return v < a;
            },
          };
        default:
          return {
            ok: true,
            label: "\u2264 " + m[2],
            test: function (v) {
              return v <= a;
            },
          };
      }
    }
    return bad("Not a valid rate expression. " + HELP);
  }

  var API = { parseRate: parseRate, HELP: HELP };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.MPSPeaks = API;
})(typeof window !== "undefined" ? window : {});
