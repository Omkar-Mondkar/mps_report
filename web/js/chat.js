/* web/js/chat.js - AI Query Assistant interactive floating widget with Canvas charts. */
(function (root) {
  "use strict";

  var state = {
    open: false,
    expanded: false,
    loading: false,
    history: []
  };

  var PALETTE = [
    "#4cc9f0", "#4361ee", "#3ddc84", "#f72585", "#7209b7",
    "#f9a03f", "#4895ef", "#560bad", "#b5179e", "#06d6a0"
  ];

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function renderMarkdown(text) {
    if (!text) return "";
    var lines = text.split("\n");
    var html = [];
    var inList = false;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) {
        if (inList) { html.push("</ul>"); inList = false; }
        continue;
      }

      // Bullet points
      if (line.indexOf("- ") === 0 || line.indexOf("* ") === 0) {
        if (!inList) { html.push("<ul style='margin:4px 0 8px 18px;padding:0;'>"); inList = true; }
        var content = formatInline(line.substring(2));
        html.push("<li>" + content + "</li>");
        continue;
      }
      if (inList) { html.push("</ul>"); inList = false; }

      // Headings
      if (line.indexOf("### ") === 0) {
        html.push("<h4 style='margin:8px 0 4px 0;font-size:12px;color:#4cc9f0;'>" + formatInline(line.substring(4)) + "</h4>");
      } else if (line.indexOf("## ") === 0 || line.indexOf("# ") === 0) {
        html.push("<h3 style='margin:10px 0 4px 0;font-size:13px;color:#fff;'>" + formatInline(line.replace(/^#+\s*/, "")) + "</h3>");
      } else {
        html.push("<p style='margin:0 0 6px 0;'>" + formatInline(line) + "</p>");
      }
    }
    if (inList) html.push("</ul>");
    return html.join("");
  }

  function formatInline(str) {
    str = escapeHtml(str);
    // Bold: **text**
    str = str.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
    // Italic: *text*
    str = str.replace(/\*(.*?)\*/g, "<em>$1</em>");
    // Code: `code`
    str = str.replace(/`(.*?)`/g, "<code style='background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:3px;'>$1</code>");
    return str;
  }

  function initChat() {
    createElements();
    attachEvents();
    renderWelcome();
  }

  function createElements() {
    // 1. Floating trigger button
    var btn = document.createElement("button");
    btn.id = "aiChatBtn";
    btn.type = "button";
    btn.setAttribute("aria-label", "AI Query Assistant");
    btn.title = "Ask AI Assistant (OTR / MPS)";
    btn.innerHTML = "&#10024;"; // Sparkles icon
    document.body.appendChild(btn);

    // 2. Chat Modal Container
    var modal = document.createElement("div");
    modal.id = "aiChatModal";
    modal.hidden = true;
    modal.innerHTML = [
      '<div id="aiChatHeader">',
      '  <div class="title-box">',
      '    <span style="font-size:16px;">&#10024;</span>',
      '    <h3>AI Assistant</h3>',
      '    <span class="badge" id="aiChatBadge">Fast Rules + Ollama</span>',
      '  </div>',
      '  <div class="controls">',
      '    <button id="aiChatExpand" class="icon-btn" title="Expand / Shrink">&#x26F6;</button>',
      '    <button id="aiChatClose" class="icon-btn" title="Close">&times;</button>',
      '  </div>',
      '</div>',
      '<div id="aiChatMessages"></div>',
      '<div id="aiChatSuggestions">',
      '  <button type="button" class="ai-chip" data-q="OTR breaches > 2000 in NSE FO yesterday">OTR breaches > 2000</button>',
      '  <button type="button" class="ai-chip" data-q="Dealers with breaches for 5 consecutive days">5 Consecutive Days</button>',
      '  <button type="button" class="ai-chip" data-q="Peak MPS on Greek yesterday">Peak MPS Greek</button>',
      '  <button type="button" class="ai-chip" data-q="Top 10 dealers by OTR in BSE CM">Top 10 BSE CM</button>',
      '  <button type="button" class="ai-chip" data-q="help">Help</button>',
      '</div>',
      '<div id="aiChatFooter">',
      '  <input type="text" id="aiChatInput" placeholder="Ask a question (e.g. OTR breaches > 2000 yesterday)..." autocomplete="off" spellcheck="false" />',
      '  <button type="button" id="aiChatSend">Send</button>',
      '</div>'
    ].join("");
    document.body.appendChild(modal);
  }

  function attachEvents() {
    var btn = $("aiChatBtn");
    var modal = $("aiChatModal");
    var close = $("aiChatClose");
    var expand = $("aiChatExpand");
    var send = $("aiChatSend");
    var input = $("aiChatInput");
    var chips = $("aiChatSuggestions");

    btn.addEventListener("click", function () {
      state.open = !state.open;
      modal.hidden = !state.open;
      if (state.open) {
        input.focus();
        scrollToBottom();
      }
    });

    close.addEventListener("click", function () {
      state.open = false;
      modal.hidden = true;
    });

    expand.addEventListener("click", function () {
      state.expanded = !state.expanded;
      modal.classList.toggle("expanded", state.expanded);
      expand.title = state.expanded ? "Restore" : "Expand";
      // Redraw any charts in the active chat when container size changes
      redrawActiveCharts();
    });

    send.addEventListener("click", submitQuery);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submitQuery();
      }
    });

    chips.addEventListener("click", function (e) {
      if (e.target && e.target.classList.contains("ai-chip")) {
        var q = e.target.getAttribute("data-q");
        if (q) {
          input.value = q;
          submitQuery();
        }
      }
    });
  }

  function renderWelcome() {
    var msgs = $("aiChatMessages");
    var el = document.createElement("div");
    el.className = "ai-msg assistant";
    el.innerHTML = [
      '<div class="summary-text">',
      '  <p><strong>Welcome to the MPS/OTR AI Assistant!</strong></p>',
      '  <p>Ask operational questions in natural language. Queries are parsed instantly with fast regex rules and verified against your permissions.</p>',
      '</div>'
    ].join("");
    msgs.appendChild(el);
  }

  function submitQuery() {
    var input = $("aiChatInput");
    var text = (input.value || "").trim();
    if (!text || state.loading) return;

    input.value = "";
    appendUserMessage(text);
    setLoading(true);

    var postFn = function (endpoint, body) {
      if (window.MPSSession && typeof window.MPSSession.post === "function") {
        return window.MPSSession.post(endpoint, body);
      }
      return fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-MPS": "1" },
        body: JSON.stringify(body || {})
      }).then(function (res) {
        return res.text().then(function (text) {
          var data;
          try {
            data = JSON.parse(text);
          } catch (e) {
            var msg = "HTTP " + res.status;
            if (text && text.indexOf("<title>") >= 0) {
              var m = text.match(/<title>([^<]+)<\/title>/i);
              if (m) msg += " (" + m[1].trim() + ")";
            } else if (text && text.length < 200) {
              msg += ": " + text.trim();
            }
            throw new Error(msg);
          }
          if (!res.ok) {
            var err = new Error((data && (data.error || data.answer)) || ("HTTP " + res.status));
            err.data = data;
            throw err;
          }
          return data;
        });
      });
    };

    postFn("api/ai/ask", { query: text })
      .then(function (data) {
        setLoading(false);
        if (data) {
          appendAssistantResponse(data);
        } else {
          appendErrorMessage("Empty response received from server.");
        }
      })
      .catch(function (err) {
        setLoading(false);
        var msg = (err && err.data && err.data.answer) ? err.data.answer : (err && err.message ? err.message : String(err));
        appendErrorMessage("Failed to contact query assistant: " + msg);
      });
  }

  function setLoading(loading) {
    state.loading = loading;
    var send = $("aiChatSend");
    var input = $("aiChatInput");
    send.disabled = loading;
    send.textContent = loading ? "..." : "Send";
    if (loading) {
      var msgs = $("aiChatMessages");
      var loader = document.createElement("div");
      loader.id = "aiChatLoading";
      loader.className = "ai-msg assistant";
      loader.innerHTML = '<span style="color:#8392b0;font-style:italic;">Processing query...</span>';
      msgs.appendChild(loader);
      scrollToBottom();
    } else {
      var loader = $("aiChatLoading");
      if (loader) loader.parentNode.removeChild(loader);
    }
  }

  function appendUserMessage(text) {
    var msgs = $("aiChatMessages");
    var el = document.createElement("div");
    el.className = "ai-msg user";
    el.textContent = text;
    msgs.appendChild(el);
    scrollToBottom();
  }

  function appendErrorMessage(msg) {
    var msgs = $("aiChatMessages");
    var el = document.createElement("div");
    el.className = "ai-msg assistant";
    el.innerHTML = '<div style="color:#ff6b6b;">' + escapeHtml(msg) + "</div>";
    msgs.appendChild(el);
    scrollToBottom();
  }

  function appendAssistantResponse(data) {
    var msgs = $("aiChatMessages");
    var el = document.createElement("div");
    el.className = "ai-msg assistant";

    var html = ['<div class="summary-text">' + renderMarkdown(data.answer || "") + '</div>'];

    // Table
    var table = data.table;
    if (table && table.columns && table.columns.length > 0 && table.rows && table.rows.length > 0) {
      html.push('<div class="tbl-wrapper"><table class="ai-table"><thead><tr>');
      for (var c = 0; c < table.columns.length; c++) {
        html.push('<th>' + escapeHtml(table.columns[c]) + '</th>');
      }
      html.push('</tr></thead><tbody>');
      for (var r = 0; r < table.rows.length; r++) {
        html.push('<tr>');
        var row = table.rows[r];
        for (var d = 0; d < row.length; d++) {
          html.push('<td>' + escapeHtml(String(row[d])) + '</td>');
        }
        html.push('</tr>');
      }
      html.push('</tbody></table></div>');
    }

    // Chart Box
    var chart = data.chart;
    var canvasId = "ai-chart-" + Date.now() + "-" + Math.floor(Math.random() * 1000);
    if (chart && chart.data && chart.data.labels && chart.data.labels.length > 0) {
      html.push('<div class="ai-chart-box">');
      if (chart.title) {
        html.push('<div class="chart-title">' + escapeHtml(chart.title) + '</div>');
      }
      html.push('<canvas id="' + canvasId + '" class="ai-chart-canvas"></canvas>');
      html.push('</div>');
    }

    // UI Action Button
    var action = data.ui_action;
    var actionBtnId = "ai-action-" + Date.now();
    if (action && action.view) {
      html.push(
        '<button type="button" id="' + actionBtnId + '" class="ai-sync-btn">' +
        '&#x2197; Apply to ' + (action.view === 'otr' ? 'OTR Dashboard' : 'MPS Report') +
        '</button>'
      );
    }

    // Metadata footer
    var meta = data.meta || {};
    var srcLabel = meta.source === 'rules' ? 'Fast Rules' : (meta.source === 'ollama' ? 'Local Ollama' : 'Direct');
    html.push(
      '<div class="ai-meta">' +
      '<span>Latency: ' + (meta.took_ms || 0) + 'ms</span>' +
      '&bull;<span>Source: ' + srcLabel + '</span>' +
      (meta.intent ? '&bull;<span>Intent: ' + meta.intent + '</span>' : '') +
      '</div>'
    );

    el.innerHTML = html.join("");
    msgs.appendChild(el);
    scrollToBottom();

    // Render Canvas chart if present
    if (chart && chart.data) {
      setTimeout(function () {
        renderCanvasChart(canvasId, chart);
      }, 30);
    }

    // Hook up UI Action button
    if (action) {
      var actBtn = $(actionBtnId);
      if (actBtn) {
        actBtn.addEventListener("click", function () {
          applyUiAction(action);
        });
      }
    }
  }

  function applyUiAction(act) {
    if (!act || !act.view) return;

    // Switch view via Shell menu item
    var navItem = document.querySelector('.mitem[data-view="' + act.view + '"]');
    if (navItem) {
      navItem.click();
    }

    // Apply OTR parameters
    if (act.view === 'otr') {
      setTimeout(function () {
        if (act.threshold !== undefined) {
          var thrInput = document.querySelector("#viewOtr input[type='text']") || $("otrThreshold");
          if (thrInput) {
            thrInput.value = act.threshold;
            if (thrInput.onchange) thrInput.onchange();
            thrInput.dispatchEvent(new Event("change"));
          }
        }
      }, 100);
    }

    // Close or minimize chat if user wants to see dashboard
    state.open = false;
    $("aiChatModal").hidden = true;
  }

  function renderCanvasChart(canvasId, chart) {
    var canvas = $(canvasId);
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Handle high DPI displays
    var rect = canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    var w = rect.width || canvas.clientWidth || 380;
    var h = rect.height || canvas.clientHeight || 160;

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    var type = chart.type || "bar";
    var labels = chart.data.labels || [];
    var values = chart.data.values || [];

    if (type === "line") {
      drawLineChart(ctx, w, h, labels, values);
    } else if (type === "pie") {
      drawPieChart(ctx, w, h, labels, values);
    } else {
      drawBarChart(ctx, w, h, labels, values);
    }
    canvas._chartData = chart;
  }

  function redrawActiveCharts() {
    var canvases = document.querySelectorAll(".ai-chart-canvas");
    for (var i = 0; i < canvases.length; i++) {
      var c = canvases[i];
      if (c._chartData) {
        renderCanvasChart(c.id, c._chartData);
      }
    }
  }

  function drawBarChart(ctx, w, h, labels, values) {
    ctx.clearRect(0, 0, w, h);
    var maxVal = 1;
    for (var i = 0; i < values.length; i++) {
      if (values[i] > maxVal) maxVal = values[i];
    }

    var padL = 36, padR = 12, padT = 16, padB = 28;
    var chartW = w - padL - padR;
    var chartH = h - padT - padB;
    var n = values.length;
    var barW = Math.max(12, Math.min(36, (chartW / n) * 0.65));
    var step = chartW / n;

    // Grid line
    ctx.strokeStyle = "rgba(39, 51, 79, 0.6)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, h - padB);
    ctx.lineTo(w - padR, h - padB);
    ctx.stroke();

    for (var i = 0; i < n; i++) {
      var val = values[i];
      var barH = (val / maxVal) * (chartH - 8);
      var x = padL + i * step + (step - barW) / 2;
      var y = h - padB - barH;

      // Bar
      ctx.fillStyle = PALETTE[i % PALETTE.length];
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x, y, barW, barH, [4, 4, 0, 0]) : ctx.rect(x, y, barW, barH);
      ctx.fill();

      // Value label on top
      ctx.fillStyle = "#dbe3f3";
      ctx.font = "10px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(val >= 1000 ? (val / 1000).toFixed(1) + "k" : val, x + barW / 2, y - 4);

      // Category label below
      var lbl = labels[i] || "";
      if (lbl.length > 8) lbl = lbl.substring(0, 7) + "…";
      ctx.fillStyle = "#8392b0";
      ctx.fillText(lbl, x + barW / 2, h - padB + 14);
    }
  }

  function drawLineChart(ctx, w, h, labels, values) {
    ctx.clearRect(0, 0, w, h);
    var maxVal = 1;
    for (var i = 0; i < values.length; i++) {
      if (values[i] > maxVal) maxVal = values[i];
    }

    var padL = 40, padR = 16, padT = 16, padB = 28;
    var chartW = w - padL - padR;
    var chartH = h - padT - padB;
    var n = values.length;
    if (n < 2) return;

    // Axis line
    ctx.strokeStyle = "rgba(39, 51, 79, 0.6)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, h - padB);
    ctx.lineTo(w - padR, h - padB);
    ctx.stroke();

    var points = [];
    var step = chartW / (n - 1);
    for (var i = 0; i < n; i++) {
      var x = padL + i * step;
      var y = h - padB - (values[i] / maxVal) * (chartH - 10);
      points.push({ x: x, y: y });
    }

    // Line path
    ctx.strokeStyle = "#4cc9f0";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (var i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();

    // Area fill below
    ctx.lineTo(points[points.length - 1].x, h - padB);
    ctx.lineTo(points[0].x, h - padB);
    ctx.closePath();
    ctx.fillStyle = "rgba(76, 201, 240, 0.12)";
    ctx.fill();

    // Dots and labels
    for (var i = 0; i < points.length; i++) {
      ctx.fillStyle = "#3ddc84";
      ctx.beginPath();
      ctx.arc(points[i].x, points[i].y, 3, 0, Math.PI * 2);
      ctx.fill();

      // Subsampled labels
      if (n <= 8 || i % Math.ceil(n / 6) === 0 || i === n - 1) {
        ctx.fillStyle = "#8392b0";
        ctx.font = "9px sans-serif";
        ctx.textAlign = "center";
        var lbl = labels[i] || "";
        ctx.fillText(lbl, points[i].x, h - padB + 14);
      }
    }
  }

  function drawPieChart(ctx, w, h, labels, values) {
    ctx.clearRect(0, 0, w, h);
    var total = 0;
    for (var i = 0; i < values.length; i++) total += values[i];
    if (total <= 0) return;

    var cx = Math.min(w * 0.4, 90);
    var cy = h / 2;
    var r = Math.min(cx - 10, cy - 10);
    var startAngle = -Math.PI / 2;

    for (var i = 0; i < values.length; i++) {
      var sliceAngle = (values[i] / total) * Math.PI * 2;
      ctx.fillStyle = PALETTE[i % PALETTE.length];
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, startAngle, startAngle + sliceAngle);
      ctx.closePath();
      ctx.fill();
      startAngle += sliceAngle;
    }

    // Legend on the right side
    var legX = cx + r + 24;
    var legY = 24;
    ctx.font = "10px sans-serif";
    ctx.textAlign = "left";

    for (var i = 0; i < values.length; i++) {
      ctx.fillStyle = PALETTE[i % PALETTE.length];
      ctx.fillRect(legX, legY - 8, 10, 10);

      ctx.fillStyle = "#dbe3f3";
      var pct = ((values[i] / total) * 100).toFixed(0);
      var text = (labels[i] || "") + " (" + pct + "%)";
      ctx.fillText(text, legX + 16, legY);
      legY += 18;
      if (legY > h - 10) break;
    }
  }

  function scrollToBottom() {
    var msgs = $("aiChatMessages");
    if (msgs) {
      setTimeout(function () {
        msgs.scrollTop = msgs.scrollHeight;
      }, 20);
    }
  }

  // Auto-initialize when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initChat);
  } else {
    initChat();
  }

})(typeof window !== "undefined" ? window : {});
