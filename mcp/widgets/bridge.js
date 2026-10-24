/* Phase widget bridge — minimal MCP Apps (SEP-1865) client, hand-rolled.
 *
 * Why hand-rolled instead of the official @modelcontextprotocol/ext-apps
 * App class: widgets are served as self-contained HTML inside a sandboxed
 * iframe under a strict CSP. An inline bridge needs no CDN fetch and no
 * build step, so it works under the strictest host sandbox. The wire
 * protocol here mirrors the official App class exactly:
 *
 *   app -> host (request):  ui/initialize { appCapabilities, appInfo, protocolVersion }
 *   app -> host (notify):   ui/notifications/initialized
 *   app -> host (request):  tools/call { name, arguments }   (host forwards to the MCP server)
 *   app -> host (request):  ui/message { role: "user", content: [{ type: "text", text }] }
 *   app -> host (request):  ui/open-link { url }
 *   host -> app (notify):   ui/notifications/tool-input { arguments }
 *   host -> app (notify):   ui/notifications/tool-result <CallToolResult>
 *   host -> app (notify):   ui/notifications/host-context-changed { ... }
 *   app -> host (notify):   ui/notifications/size-changed { width, height }
 *
 * Tool input/result notifications are replayed to late subscribers, so a
 * widget that registers handlers after connect() still gets its data.
 * If no host answers the handshake (widget opened standalone in a browser),
 * the bridge resolves in standalone mode and widgets render their fallback
 * state instead of hanging.
 */
(function () {
  "use strict";
  var PROTOCOL_VERSION = "2026-01-26";
  var nextId = 1;
  var pending = {};
  var toolInput = null;
  var toolResult = null;
  var hostContext = null;
  var connected = false;
  var standalone = false;
  var inputListeners = [];
  var resultListeners = [];

  function post(msg) {
    try { window.parent.postMessage(msg, "*"); } catch (e) { /* no host */ }
  }

  function request(method, params, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (standalone) { reject(new Error("No host connected.")); return; }
      var id = nextId++;
      pending[id] = { resolve: resolve, reject: reject };
      post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
      setTimeout(function () {
        if (pending[id]) {
          delete pending[id];
          reject(new Error("Host did not respond to " + method + "."));
        }
      }, timeoutMs || 30000);
    });
  }

  function emit(list, value) {
    for (var i = 0; i < list.length; i++) {
      try { list[i](value); } catch (e) { /* listener error must not break the bridge */ }
    }
  }

  window.addEventListener("message", function (ev) {
    var m = ev.data;
    if (!m || typeof m !== "object" || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
      var p = pending[m.id];
      if (p) {
        delete pending[m.id];
        if (m.error) p.reject(new Error((m.error && m.error.message) || "Host error."));
        else p.resolve(m.result);
      }
      return;
    }
    if (m.method === "ui/notifications/tool-input") {
      toolInput = m.params || {};
      emit(inputListeners, toolInput);
    } else if (m.method === "ui/notifications/tool-result") {
      toolResult = m.params || {};
      emit(resultListeners, toolResult);
    } else if (m.method === "ui/notifications/host-context-changed") {
      hostContext = m.params || {};
    }
  });

  function onToolInput(cb) {
    inputListeners.push(cb);
    if (toolInput) { try { cb(toolInput); } catch (e) {} }
  }
  function onToolResult(cb) {
    resultListeners.push(cb);
    if (toolResult) { try { cb(toolResult); } catch (e) {} }
  }

  var connectPromise = null;
  function connect() {
    if (connectPromise) return connectPromise;
    connectPromise = new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        standalone = true;
        resolve({ standalone: true });
      }, 1500);
      request("ui/initialize", {
        appInfo: { name: "phase-widget", version: "1.0.0" },
        appCapabilities: {},
        protocolVersion: PROTOCOL_VERSION,
      }, 1400).then(function (res) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        connected = true;
        hostContext = (res && res.hostContext) || null;
        post({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
        resolve({ standalone: false, hostContext: hostContext });
      }).catch(function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        standalone = true;
        resolve({ standalone: true });
      });
    });
    return connectPromise;
  }

  function callServerTool(name, args) {
    return request("tools/call", { name: name, arguments: args || {} });
  }

  function sendMessage(text) {
    return request("ui/message", {
      role: "user",
      content: [{ type: "text", text: text }],
    });
  }

  function openLink(url) {
    return request("ui/open-link", { url: url });
  }

  function notifySize() {
    var w = Math.ceil(window.innerWidth);
    var h = Math.ceil(document.documentElement.getBoundingClientRect().height);
    post({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { width: w, height: h } });
  }

  function autoResize() {
    if (!("ResizeObserver" in window)) return;
    var pendingFrame = false;
    var ro = new ResizeObserver(function () {
      if (pendingFrame) return;
      pendingFrame = true;
      requestAnimationFrame(function () {
        pendingFrame = false;
        if (!standalone) notifySize();
      });
    });
    ro.observe(document.documentElement);
    ro.observe(document.body);
  }

  /* Parse a tools/call result into structured data: prefer
   * structuredContent, else parse the first text block as JSON. */
  function resultData(result) {
    if (!result) return null;
    if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
    var blocks = result.content || [];
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i] && blocks[i].type === "text" && typeof blocks[i].text === "string") {
        try { return JSON.parse(blocks[i].text); } catch (e) { return { text: blocks[i].text }; }
      }
    }
    return null;
  }

  function resultError(result) {
    if (!result) return "No response from the server.";
    if (result.isError) {
      var d = resultData(result);
      if (d && d.error) return d.message || d.error;
      if (d && d.text) return d.text;
      return "The server reported an error.";
    }
    return null;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  window.PhaseBridge = {
    connect: connect,
    onToolInput: onToolInput,
    onToolResult: onToolResult,
    callServerTool: callServerTool,
    sendMessage: sendMessage,
    openLink: openLink,
    notifySize: notifySize,
    autoResize: autoResize,
    resultData: resultData,
    resultError: resultError,
    escapeHtml: escapeHtml,
    isConnected: function () { return connected; },
    isStandalone: function () { return standalone; },
    getToolInput: function () { return toolInput; },
    getToolResult: function () { return toolResult; },
  };
})();
