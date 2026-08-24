// Telematic Network Diagnostics — monitor page (issues #3–#4).
//
// The flower view: the WHOLE network's picture, identical on every
// site's monitor (each node self-reports over the hub room relay).
// Layout in the Local Network Diagnostics visual language:
//
//   overall banner  — worst hub leg (and, from #5, worst local leg)
//                     across all nodes → green/yellow/red "suitable
//                     for performance" verdict + plain attribution
//   star diagram    — hub centered, nodes ringed; spokes carry each
//                     node's self-reported RTT p50 (number only) and
//                     quality color; outer rings carry the local-leg
//                     status (gray until #5); own node marked 本站;
//                     offline spokes dashed. Pure inline SVG.
//   node cards      — per node: quality + reason, hub-leg p50/p95,
//                     performer count, and the DERIVED end-to-end
//                     numbers (site pair = two hub legs; big number,
//                     small composition formula)
//   form + log + QR — the #3 connect form, event log, performer QR
//
// RTT numbers are never colored anywhere — only quality is.

const P = window.PNDS;

const SVG_NS = "http://www.w3.org/2000/svg";

const app = document.getElementById("app");

app.innerHTML =
  "<header>" +
  "<h1>Telematic Network Diagnostics</h1>" +
  '<span class="sub">Monitor — flower view</span>' +
  "</header>" +
  '<div class="overall st-idle" id="banner">' +
  '<span class="dot"></span>' +
  '<span class="overall-label">Overall</span>' +
  '<span class="overall-copy" id="banner-copy">…</span>' +
  '<span class="attribution" id="banner-attribution"></span>' +
  "</div>" +
  // Balanced two-column row: the connection form on the left, the
  // star diagram on the right, equal widths (stacks on narrow
  // screens).
  '<div class="two-col">' +
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
  '<div class="panel star-panel" id="star-panel">' +
  '<div id="star"></div>' +
  '<div class="hint">辐条 = hub 腿（标注 RTT p50，颜色 = 质量）· 外环 = 本地腿（灰 = 无数据）</div>' +
  "</div>" +
  "</div>" +
  '<div id="cards"></div>' +
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
const bannerAttributionEl = document.getElementById("banner-attribution");
const starEl = document.getElementById("star");
const cardsEl = document.getElementById("cards");
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

function leg() {
  return state && state.leg ? state.leg : null;
}

function ownName() {
  return (state && state.config && state.config.nodeId) || "This node";
}

function sortedPeers(info) {
  return Object.entries(info.peers || {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}

function render() {
  prefillForm(); // first render only (guard inside)
  renderBanner();
  renderStar();
  renderCards();
  renderLog();
}

function renderBanner() {
  const overall = state ? state.overall : null;
  const status = overall ? overall.status : "idle";

  setStatus(bannerEl, status);
  bannerCopyEl.textContent = P.overallCopy[status] || "";

  // Plain attribution copy: which site's public (hub) leg is the
  // problem. Yellow softens the wording; red blames outright.
  bannerAttributionEl.textContent = "";

  if (
    overall &&
    overall.attributionNodeId &&
    (status === "red" || status === "yellow")
  ) {
    const where = overall.attributionSelf
      ? "本站公网腿"
      : overall.attributionNodeId + " 公网腿";
    const verb = status === "red" ? "问题在" : "临界：";

    bannerAttributionEl.textContent = verb + where;
  }
}

// The star diagram: hub centered, own node + peers ringed. Rebuilt on
// every state (a handful of nodes — rebuilding beats diffing).
function renderStar() {
  starEl.textContent = "";

  const info = leg();

  if (!info) {
    starEl.append(el("div", "hint", "未连接 hub — 连接后显示全网星型图"));
    return;
  }

  const nodes = [
    {
      name: ownName(),
      self: true,
      status: info.status,
      connected: info.connected,
      p50: info.summary ? info.summary.rttP50 : null,
      localWorst: null, // #5 reports the own local leg's worst status
    },
  ];

  for (const [nodeId, peer] of sortedPeers(info)) {
    nodes.push({
      name: nodeId,
      self: false,
      status: peer.status, // snapshot already coerced offline → red
      connected: peer.connected,
      p50: peer.summary ? peer.summary.rttP50 : null,
      localWorst: peer.localWorst || null,
    });
  }

  const size = 360;
  const center = size / 2;
  const radius = 118;
  const svg = svgEl("svg", {
    viewBox: "0 0 " + size + " " + size,
  });
  svg.setAttribute("class", "star-svg");

  // Hub first (spokes draw over it).
  const hubCore = svgEl("circle", { cx: center, cy: center, r: 15 });
  hubCore.setAttribute("class", "hub-core");
  svg.append(hubCore, svgText(center, center + 33, "HUB", "hub-label"));

  nodes.forEach((node, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / nodes.length;
    const x = center + radius * Math.cos(angle);
    const y = center + radius * Math.sin(angle);

    // Spoke: quality color; dashed when the node's leg is offline.
    const spoke = svgEl("line", {
      x1: center,
      y1: center,
      x2: x,
      y2: y,
    });

    spoke.setAttribute("class", "spoke " + statusClass(node.status));

    if (!node.connected) {
      spoke.setAttribute("stroke-dasharray", "7 6");
    }

    svg.append(spoke);

    // Spoke label: the self-reported RTT p50 — a number, never
    // colored. Offline peers show "—": the last relayed number must
    // not read as a live estimate on a broken leg.
    const label = svgText(
      (center + x) / 2,
      (center + y) / 2 - 7,
      node.connected && typeof node.p50 === "number"
        ? Math.round(node.p50) + " ms"
        : "—",
      "spoke-label",
    );

    label.setAttribute("text-anchor", "middle");
    svg.append(label);

    // Node: outer ring = local-leg worst (gray until #5 reports it),
    // inner dot = hub-leg quality.
    const ring = svgEl("circle", { cx: x, cy: y, r: 17 });
    ring.setAttribute("class", "node-ring " + statusClass(node.localWorst || "gray"));
    const core = svgEl("circle", { cx: x, cy: y, r: 8 });
    core.setAttribute("class", "node-core " + statusClass(node.status));
    svg.append(ring, core);

    const nameLabel = svgText(x, y + 35, node.name, "node-name");

    nameLabel.setAttribute("text-anchor", "middle");
    svg.append(nameLabel);

    if (node.self) {
      const badge = svgText(x, y - 27, "本站", "self-badge");

      badge.setAttribute("text-anchor", "middle");
      svg.append(badge);
    }
  });

  starEl.append(svg);
}

// The card grid: own card first, then one per peer (name order).
function renderCards() {
  cardsEl.textContent = "";

  const info = leg();

  if (!info) {
    return;
  }

  cardsEl.append(renderOwnCard(ownName(), info));

  for (const [nodeId, peer] of sortedPeers(info)) {
    cardsEl.append(renderPeerCard(nodeId, peer, info));
  }
}

function renderOwnCard(name, info) {
  const card = el("div", "client-card " + statusClass(info.status));
  const head = el("div", "head");

  head.append(
    el("span", "dot on"),
    el("span", null, name + (info.probing === "burst" ? " · burst" : "")),
    el("span", "tag", "本站"),
    el("span", "status-word", info.status.toUpperCase()),
  );
  card.append(
    head,
    el("div", "copy", P.statusCopy[info.status] || ""),
    el("div", "reason", info.reason || ""),
  );

  const rows = el("div");
  const summary = info.summary || {};

  rows.append(
    metricRow("RTT p50 典型往返", formatMs(summary.rttP50)),
    metricRow("RTT p95 尾部往返", formatMs(summary.rttP95)),
    metricRow("One-way ≈ RTT/2 单程估计", formatMs(summary.oneWayEstimateMs, 1)),
    metricRow("Jitter (IQR) 抖动", formatMs(summary.iqrMs, 1)),
    metricRow("Loss 丢包", formatPct(summary.lossRate)),
    metricRow("Performers 演奏者", String(info.performerCount ?? 0)),
  );
  card.append(rows);

  return card;
}

function renderPeerCard(nodeId, peer, own) {
  const status = peer.status; // snapshot already coerced offline → red
  const card = el("div", "client-card " + statusClass(status));
  const head = el("div", "head");

  head.append(
    el("span", "dot on"),
    el("span", null, nodeId),
    el("span", "status-word", status.toUpperCase()),
  );
  card.append(
    head,
    el("div", "copy", P.statusCopy[status] || ""),
    el("div", "reason", peer.connected ? peer.reason || "" : "Hub unreachable"),
  );

  const summary = peer.summary || {};

  // The DERIVED site-pair number: this site → that site ≈ two hub-leg
  // p50s. Big number, small composition formula (parent #1: 推导值,
  // 大数字 + 小字构成式). Null while either segment is unmeasured.
  // The derived blocks. A disconnected peer shows "—": an estimate
  // built from its last relay (up to 30 s old) must not read as live
  // on a leg the diagram itself draws as broken.
  const ownP50 = own.summary ? own.summary.rttP50 : null;
  const peerP50 = summary.rttP50;
  const total = peer.connected ? P.derivedSitePair(ownP50, peerP50) : null;

  const siteBlock = el("div", "derived");

  siteBlock.append(el("div", "derived-k", "站点对 Site pair"));

  if (total !== null) {
    siteBlock.append(
      el("div", "big", "≈ " + Math.round(total) + " ms"),
      el(
        "div",
        "formula",
        ownName() + " → " + nodeId + " · " +
          Math.round(ownP50) + " + " + Math.round(peerP50) + " ms",
      ),
    );
  } else {
    siteBlock.append(
      el("div", "big", "—"),
      el("div", "formula", peer.connected ? "等待两段测量" : "对端不可达"),
    );
  }

  card.append(siteBlock);

  // Performer pair = local + hub + hub + local — four segments. The
  // formula lights up when #5 starts reporting local legs; until then
  // the placeholder names exactly what is missing.
  const perfTotal = P.derivedPerformerPair(
    null, // own local-leg p50 — measured from #5 on
    ownP50,
    peerP50,
    null, // peer local-leg p50 — relayed from #5 on
  );

  const perfBlock = el("div", "derived");

  perfBlock.append(el("div", "derived-k", "演奏者对 Performer pair"));

  if (perfTotal !== null) {
    perfBlock.append(
      el("div", "big", "≈ " + Math.round(perfTotal) + " ms"),
      el("div", "formula", "本地 + hub + hub + 本地"),
    );
  } else {
    perfBlock.append(
      el("div", "big", "—"),
      el("div", "formula", "等待本地腿测量（#5）"),
    );
  }

  card.append(perfBlock);

  const rows = el("div");

  rows.append(
    metricRow("RTT p50 典型往返", formatMs(summary.rttP50)),
    metricRow("RTT p95 尾部往返", formatMs(summary.rttP95)),
    metricRow("Performers 演奏者", String(peer.performerCount ?? 0)),
    metricRow("Local leg 本地腿", peer.localWorst || "无数据 · n/a"),
  );
  card.append(rows);

  return card;
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

function svgEl(tag, attributes) {
  const node = document.createElementNS(SVG_NS, tag);

  for (const name of Object.keys(attributes || {})) {
    node.setAttribute(name, attributes[name]);
  }

  return node;
}

function svgText(x, y, text, className) {
  const node = svgEl("text", { x, y });
  node.setAttribute("class", className);
  node.textContent = text;
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
