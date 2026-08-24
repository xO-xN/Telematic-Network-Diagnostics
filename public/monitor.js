// Telematic Network Diagnostics — monitor page (issue #3).
//
// Operator console in the Local Network Diagnostics visual language:
// light theme, centered column. Shows THIS node's hub leg (score
// server ↔ public hub): live RTT p50/p95 as plain numbers (never
// colored — latency magnitude is not a quality signal), the quality
// color (jitter/loss/reconnects only), the one-way estimate ≈ RTT/2,
// and the connect/disconnect event log.
//
// The connection form (hub URL / token / room / node name) persists in
// localStorage and prefills from the App's env injection (PNDS_* env
// vars, delivered inside the hub:state broadcast). Opening the page
// auto-connects when a usable config exists — zero buttons.

const P = window.PNDS;

const app = document.getElementById("app");

app.innerHTML =
  "<header>" +
  "<h1>Telematic Network Diagnostics</h1>" +
  '<span class="sub">Monitor — hub leg</span>' +
  "</header>" +
  '<div class="overall st-idle" id="banner">' +
  '<span class="dot"></span>' +
  '<span class="overall-label">Hub leg</span>' +
  '<span class="overall-copy" id="banner-copy">…</span>' +
  "</div>" +
  '<div class="client-card st-idle" id="node-card">' +
  '<div class="head"><span class="dot" id="node-dot"></span>' +
  '<span id="node-name">This node</span>' +
  '<span class="status-word" id="node-status">—</span></div>' +
  '<div class="copy" id="node-copy"></div>' +
  '<div class="reason" id="node-reason"></div>' +
  '<div id="node-rows"></div>' +
  "</div>" +
  '<div class="panel" id="form-panel">' +
  "<h3>Hub 连接 · Hub connection</h3>" +
  '<div class="form-grid">' +
  '<label>Hub URL<input id="f-url" placeholder="wss://hub.example.com" /></label>' +
  '<label>Token<input id="f-token" type="password" placeholder="HUB_TOKEN" /></label>' +
  '<label>Room<input id="f-room" placeholder="default" /></label>' +
  '<label>Node 节点名<input id="f-node" placeholder="site name" /></label>' +
  "</div>" +
  '<div class="form-actions">' +
  '<button id="b-connect">连接 · Connect</button>' +
  "</div>" +
  '<div class="hint">表单保存在浏览器 localStorage，重开无需重填；' +
  "App 注入的 env（PNDS_HUB_URL 等）会作为预填默认值。</div>" +
  "</div>" +
  '<div class="panel" id="log-panel">' +
  "<h3>事件 · Events</h3>" +
  '<div class="log" id="log"></div>' +
  "</div>" +
  '<div class="qr-row">' +
  '<img src="/qr" alt="QR code for the performer page" />' +
  '<span class="sub">Scan to open the performer page</span>' +
  "</div>";

const bannerEl = document.getElementById("banner");
const bannerCopyEl = document.getElementById("banner-copy");
const nodeNameEl = document.getElementById("node-name");
const nodeStatusEl = document.getElementById("node-status");
const nodeCopyEl = document.getElementById("node-copy");
const nodeReasonEl = document.getElementById("node-reason");
const nodeRowsEl = document.getElementById("node-rows");
const urlInput = document.getElementById("f-url");
const tokenInput = document.getElementById("f-token");
const roomInput = document.getElementById("f-room");
const nodeInput = document.getElementById("f-node");
const connectButton = document.getElementById("b-connect");
const logEl = document.getElementById("log");

let state = null;
let formPrefilled = false;
// The config loaded at startup (localStorage / env prefill): the only
// thing auto-submit ever sends, so a transient socket reconnect can
// never submit a half-edited form.
let autoConfig = null;

const socket = io("http://" + location.hostname + ":" + P.performerPort, {
  reconnection: true,
});

socket.on(P.events.hubState, (data) => {
  state = data;
  render();
});

// Auto-start (zero buttons): whenever the socket (re)connects, submit
// the STARTUP config if it is usable. The server no-ops an identical
// config, so page refreshes and socket reconnects never reset the
// measurement. Runs after the first state broadcast at the latest (the
// env prefill needs it), so this also fires from prefillForm().
socket.on("connect", () => {
  if (autoConfig) {
    socket.emit(P.events.hubConfig, autoConfig);
  }
});

connectButton.addEventListener("click", () => submitConfig(true));

// ------------------------------------------------------------
// Form: localStorage persistence + env prefill
// ------------------------------------------------------------

function loadSavedConfig() {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(P.storageKeys.hubConfig) || "null",
    );

    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// localStorage (the operator's explicit choice) wins over the env
// defaults; env fills whatever was never saved (parent #1: env 存在时
// 作预填默认值 — the dual-channel Phase 0 shape).
//
// Runs ONCE per page load (see render): the state broadcast ticks at
// 1 Hz and must never clobber what the operator is typing.
function prefillForm() {
  if (formPrefilled) {
    return;
  }

  formPrefilled = true;

  const saved = loadSavedConfig();
  const env = (state && state.env) || {};
  const config = {
    url: saved.url || env.hubUrl || "",
    token: saved.token || env.hubToken || "",
    room: saved.room || env.hubRoom || "",
    nodeId: saved.nodeId || env.nodeId || "",
  };

  urlInput.value = config.url;
  tokenInput.value = config.token;
  roomInput.value = config.room;
  nodeInput.value = config.nodeId;

  if (config.url && config.token) {
    autoConfig = config;
    socket.emit(P.events.hubConfig, config);
  }
}

function submitConfig(save) {
  const config = {
    url: urlInput.value.trim(),
    token: tokenInput.value.trim(),
    room: roomInput.value.trim(),
    nodeId: nodeInput.value.trim(),
  };

  if (!config.url || !config.token) {
    return false;
  }

  if (save) {
    localStorage.setItem(P.storageKeys.hubConfig, JSON.stringify(config));
  }

  socket.emit(P.events.hubConfig, config);
  return true;
}

// ------------------------------------------------------------
// Rendering
// ------------------------------------------------------------

const STATUS_CLASSES = ["st-idle", "st-gray", "st-green", "st-yellow", "st-red"];

function statusClass(status) {
  return "st-" + (status || "idle");
}

function setStatus(element, status) {
  element.classList.remove(...STATUS_CLASSES);
  element.classList.add(statusClass(status));
}

function render() {
  prefillForm(); // first render only (guard inside)
  renderBanner();
  renderNodeCard();
  renderLog();
}

function leg() {
  return state && state.leg ? state.leg : null;
}

function renderBanner() {
  const info = leg();

  setStatus(bannerEl, info ? info.status : "idle");
  bannerCopyEl.textContent = P.statusCopy[info ? info.status : "idle"] || "";
}

function renderNodeCard() {
  const info = leg();
  const card = document.getElementById("node-card");

  setStatus(card, info ? info.status : "idle");

  const config = state && state.config ? state.config : null;
  nodeNameEl.textContent = config
    ? config.nodeId + (info && info.probing === "burst" ? " · burst" : "")
    : "This node";
  // The probe cycle (burst ↔ calm) runs automatically, LND-style; the
  // chip in the name reflects whichever phase is live.

  nodeStatusEl.textContent = info ? info.status.toUpperCase() : "—";
  nodeCopyEl.textContent = info ? P.statusCopy[info.status] || "" : "";
  nodeReasonEl.textContent = info ? info.reason || "" : "";

  nodeRowsEl.textContent = "";

  if (info) {
    const summary = info.summary || {};

    nodeRowsEl.append(
      metricRow("RTT p50 典型往返", formatMs(summary.rttP50)),
      metricRow("RTT p95 尾部往返", formatMs(summary.rttP95)),
      metricRow("One-way ≈ RTT/2 单程估计", formatMs(summary.oneWayEstimateMs, 1)),
      metricRow("Jitter (IQR) 抖动", formatMs(summary.iqrMs, 1)),
      metricRow("Loss 丢包", formatPct(summary.lossRate)),
      metricRow("Reconnects 重连 (15s)", String(summary.reconnects ?? "—")),
      metricRow("Samples 样本 (15s)", String(summary.samples ?? "—")),
    );
  }
}

function renderLog() {
  logEl.textContent = "";
  const info = leg();
  const events = info ? info.events || [] : [];

  if (events.length === 0) {
    logEl.append(el("div", "entry", "No events yet"));
    return;
  }

  for (const event of events.slice(-8).reverse()) {
    const entry = el("div", "entry");
    const type = el("b", null, eventLabel(event.type));

    entry.append(
      type,
      document.createTextNode(
        (event.detail ? " — " + event.detail : "") + "  ·  " + agoText(event.agoMs),
      ),
    );
    logEl.append(entry);
  }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function metricRow(label, value) {
  const row = el("div", "row");
  row.append(el("span", "k", label), el("span", "v", value));
  return row;
}

function formatMs(value, digits = 0) {
  return typeof value === "number" ? value.toFixed(digits) + " ms" : "—";
}

function formatPct(value) {
  return typeof value === "number" ? (value * 100).toFixed(1) + "%" : "—";
}

function eventLabel(type) {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function agoText(agoMs) {
  if (typeof agoMs !== "number") {
    return "";
  }

  if (agoMs < 1000) {
    return "just now";
  }

  if (agoMs < 60000) {
    return Math.round(agoMs / 1000) + "s ago";
  }

  return Math.round(agoMs / 60000) + "m ago";
}

render();
