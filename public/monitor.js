// Telematic Network Diagnostics — monitor page (issues #3–#5).
//
// The flower view: the WHOLE network's picture, identical on every
// site's monitor (each node self-reports over the hub room relay).
// Layout in the Local Network Diagnostics visual language:
//
//   overall banner  — worst leg across all nodes, hub AND local →
//                     green/yellow/red "suitable for performance"
//                     verdict + plain attribution ("问题在 B 站本地腿")
//   star diagram    — hub centered, nodes ringed; spokes carry each
//                     node's self-reported RTT p50 (number only) and
//                     quality color; outer rings carry the site's
//                     local-leg worst; own node marked 本站; offline
//                     spokes dashed. Pure inline SVG.
//   local panel     — THIS site's performers: per-performer status,
//                     metrics and event log (the local legs, #5)
//   node cards      — per node: quality + reason, hub-leg p50/p95,
//                     performer count, and the DERIVED end-to-end
//                     numbers (site pair = two hub legs; performer
//                     pair = local + hub + hub + local; big number,
//                     small composition formula)
//   form + log + QR — the #3 connect form, hub-leg event log,
//                     performer QR
//
// RTT numbers are never colored anywhere — only quality is.
//
// All copy renders through the shared bilingual tables (shared.js
// `copy`), picked by the current locale (locale-follow.js follows the
// App language — the page re-renders live on every language switch;
// default Chinese, this project's historical UI).

const P = window.PNDS;
const L = window.PNDS_LOCALE;

const SVG_NS = "http://www.w3.org/2000/svg";

const app = document.getElementById("app");

// The skeleton is built once; every label-carrying node gets an id so
// render() can re-word the chrome without touching the form inputs (a
// language switch must never wipe what the operator is typing).
app.innerHTML =
  "<header>" +
  "<h1>Telematic Network Diagnostics</h1>" +
  '<span class="sub" id="sub-label"></span>' +
  "</header>" +
  '<div class="overall st-idle" id="banner">' +
  '<span class="dot"></span>' +
  '<span class="overall-label" id="overall-label"></span>' +
  '<span class="overall-copy" id="banner-copy">…</span>' +
  '<span class="attribution" id="banner-attribution"></span>' +
  "</div>" +
  // Balanced two-column row: the connection form on the left, the
  // star diagram on the right, equal widths (stacks on narrow
  // screens).
  '<div class="two-col">' +
  '<div class="panel" id="form-panel">' +
  '<h3 id="form-title"></h3>' +
  '<div class="form-grid">' +
  '<label><span id="l-url"></span><input id="f-url" placeholder="wss://hub.example.com" /></label>' +
  '<label><span id="l-token"></span><input id="f-token" type="password" placeholder="HUB_TOKEN" /></label>' +
  '<label><span id="l-room"></span><input id="f-room" placeholder="default" /></label>' +
  '<label><span id="l-node"></span><input id="f-node" placeholder="site name" /></label>' +
  "</div>" +
  '<div class="form-actions">' +
  '<button id="b-connect"></button>' +
  "</div>" +
  '<div class="hint" id="form-hint"></div>' +
  "</div>" +
  '<div class="panel star-panel" id="star-panel">' +
  '<div id="star"></div>' +
  '<div class="hint" id="star-hint"></div>' +
  "</div>" +
  "</div>" +
  '<div class="panel wide" id="local-panel">' +
  '<h3><span id="local-title"></span> <span class="count" id="local-count"></span></h3>' +
  '<div class="local-cards" id="local-cards"></div>' +
  "</div>" +
  '<div id="cards"></div>' +
  '<div class="panel" id="log-panel">' +
  "<h3 id=\"log-title\"></h3>" +
  '<div class="log" id="log"></div>' +
  "</div>" +
  '<div class="qr-row">' +
  '<img src="/qr" id="qr-img" alt="" />' +
  '<span class="sub" id="scan-label"></span>' +
  "</div>";

const bannerEl = document.getElementById("banner");
const bannerCopyEl = document.getElementById("banner-copy");
const bannerAttributionEl = document.getElementById("banner-attribution");
const starEl = document.getElementById("star");
const localCardsEl = document.getElementById("local-cards");
const localCountEl = document.getElementById("local-count");
const cardsEl = document.getElementById("cards");
const urlInput = document.getElementById("f-url");
const tokenInput = document.getElementById("f-token");
const roomInput = document.getElementById("f-room");
const nodeInput = document.getElementById("f-node");
const connectButton = document.getElementById("b-connect");
const logEl = document.getElementById("log");
const chromeEls = {
  sub: document.getElementById("sub-label"),
  overallLabel: document.getElementById("overall-label"),
  formTitle: document.getElementById("form-title"),
  formUrl: document.getElementById("l-url"),
  formToken: document.getElementById("l-token"),
  formRoom: document.getElementById("l-room"),
  formNode: document.getElementById("l-node"),
  formHint: document.getElementById("form-hint"),
  starHint: document.getElementById("star-hint"),
  localTitle: document.getElementById("local-title"),
  logTitle: document.getElementById("log-title"),
  scan: document.getElementById("scan-label"),
  qrImg: document.getElementById("qr-img"),
};

// The copy table of the current locale (Chinese fallback — the table
// the page rendered before locale following existed).
function T() {
  return P.copy[L.current()] || P.copy["zh-CN"];
}

// {0}/{1} placeholder filling for reason templates and the like.
function fmt(template, params) {
  return template.replace(/\{(\d+)\}/g, (whole, index) =>
    params && params[index] !== undefined ? params[index] : whole,
  );
}

let state = null;
let formPrefilled = false;
// The config loaded at startup (localStorage / env prefill): the only
// thing auto-submit ever sends, so a transient socket reconnect can
// never submit a half-edited form.
let autoConfig = null;

const socket = io("http://" + location.hostname + ":" + P.performerPort, {
  reconnection: true,
});

socket.on(P.events.state, (data) => {
  state = data;
  render();
});

// The App language switch re-renders the whole console through the new
// locale's copy table (latest value wins; same value re-pushes change
// nothing). The form inputs are NOT rebuilt — the operator's typing
// survives a mid-edit language switch.
L.subscribe(render);

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

const statusClass = P.statusClass;
const setStatus = P.setStatus;

function leg() {
  return state && state.leg ? state.leg : null;
}

function localState() {
  return state && state.local ? state.local : null;
}

function ownName() {
  return (state && state.config && state.config.nodeId) || T().monitor.ownFallback;
}

function sortedPeers(info) {
  return Object.entries(info.peers || {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}

function render() {
  // The env prefill rides the state broadcast: the initial render at
  // load runs BEFORE the first state arrives (state is null there)
  // and must not spend prefillForm's once-guard on an empty env.
  if (state) {
    prefillForm(); // first state-bearing render only (guard inside)
  }

  // The chrome re-words on every render — including the ones a locale
  // switch triggers, when nothing else changed.
  const m = T().monitor;

  chromeEls.sub.textContent = m.sub;
  chromeEls.overallLabel.textContent = m.overallLabel;
  chromeEls.formTitle.textContent = m.formTitle;
  chromeEls.formUrl.textContent = m.formUrl;
  chromeEls.formToken.textContent = m.formToken;
  chromeEls.formRoom.textContent = m.formRoom;
  chromeEls.formNode.textContent = m.formNode;
  connectButton.textContent = m.connect;
  chromeEls.formHint.textContent = m.formHint;
  chromeEls.starHint.textContent = m.starHint;
  chromeEls.localTitle.textContent = m.localTitle;
  chromeEls.logTitle.textContent = m.logTitle;
  chromeEls.scan.textContent = m.scan;
  chromeEls.qrImg.setAttribute("alt", m.qrAlt);

  renderBanner();
  renderStar();
  renderLocal();
  renderCards();
  renderLog();
}

// The reason line: a key from the wire mapped through the current
// locale's table (params fill the {0}/{1} placeholders). An unknown
// key — e.g. prose relayed by a peer still on an older release —
// renders verbatim, never blank.
function reasonLine(key, params, table) {
  if (!key) {
    return "";
  }

  const template = table[key];
  return template === undefined ? key : fmt(template, params);
}

function renderBanner() {
  const t = T();
  const overall = state ? state.overall : null;
  const status = overall ? overall.status : "idle";

  setStatus(bannerEl, status);
  bannerCopyEl.textContent = t.overall[status] || "";

  // Plain attribution copy: which site's which leg is the problem —
  // hub (公网腿) or local (本地腿). Yellow softens the wording; red
  // blames outright. One template per leg/verb/self combination, {node}
  // filled with the peer's id.
  bannerAttributionEl.textContent = "";

  if (
    overall &&
    overall.attributionNodeId &&
    (status === "red" || status === "yellow")
  ) {
    const legWord = overall.attributionLeg === "local" ? "Local" : "Hub";
    const verb = status.charAt(0).toUpperCase() + status.slice(1);
    const key =
      "attrib" + (overall.attributionSelf ? "Self" : "") + legWord + verb;
    const template = t.monitor[key] || "";

    bannerAttributionEl.textContent = template.replace(
      /\{node\}/g,
      overall.attributionNodeId,
    );
  }
}

// The star diagram: hub centered, own node + peers ringed. Rebuilt on
// every state (a handful of nodes — rebuilding beats diffing).
function renderStar() {
  starEl.textContent = "";

  const info = leg();

  if (!info) {
    starEl.append(el("div", "hint", T().monitor.starNotConnected));
    return;
  }

  const nodes = [
    {
      name: ownName(),
      self: true,
      status: info.status,
      connected: info.connected,
      p50: info.summary ? info.summary.rttP50 : null,
      // The own site's local-leg worst (null = no performer yet → the
      // outer ring stays gray).
      localWorst: localState() ? localState().status : null,
    },
  ];

  for (const [nodeId, peer] of sortedPeers(info)) {
    nodes.push({
      name: nodeId,
      self: false,
      status: peer.status, // snapshot already coerced offline → red
      connected: peer.connected,
      p50: peer.summary ? peer.summary.rttP50 : null,
      localWorst: peer.local ? peer.local.status : null,
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

    // Node: outer ring = the site's local-leg worst (gray = no data),
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
      const badge = svgText(x, y - 27, T().monitor.selfBadge, "self-badge");

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
  const t = T();
  const card = el("div", "client-card " + statusClass(info.status));
  const head = el("div", "head");
  const local = localState();
  const localStatus = local ? local.status : null;

  head.append(
    el("span", "dot on"),
    el(
      "span",
      null,
      name + (info.probing === "burst" ? " · " + t.monitor.burst : ""),
    ),
    el("span", "tag", t.monitor.selfTag),
    el("span", "status-word", info.status.toUpperCase()),
  );
  card.append(
    head,
    el("div", "copy", t.hubStatus[info.status] || ""),
    el(
      "div",
      "reason",
      reasonLine(info.reason, info.reasonParams, t.hubReasons),
    ),
  );

  const rows = el("div");
  const summary = info.summary || {};

  rows.append(
    metricRow(t.monitor.rttP50, formatMs(summary.rttP50)),
    metricRow(t.monitor.rttP95, formatMs(summary.rttP95)),
    metricRow(t.monitor.oneWay, formatMs(summary.oneWayEstimateMs, 1)),
    metricRow(t.monitor.jitterIqr, formatMs(summary.iqrMs, 1)),
    metricRow(t.monitor.loss, formatPct(summary.lossRate)),
    metricRow(t.monitor.performers, String(local ? local.performers : 0)),
    metricRow(t.monitor.localLeg, localStatus || t.monitor.noData),
  );
  card.append(rows);

  return card;
}

function renderPeerCard(nodeId, peer, own) {
  const t = T();
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
    el("div", "copy", t.hubStatus[status] || ""),
    el(
      "div",
      "reason",
      peer.connected
        ? reasonLine(peer.reason, peer.reasonParams, t.hubReasons)
        : reasonLine("unreachable", [], t.hubReasons),
    ),
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

  siteBlock.append(el("div", "derived-k", t.monitor.sitePair));

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
      el("div", "formula", peer.connected ? t.monitor.waitSite : t.monitor.peerUnreachable),
    );
  }

  card.append(siteBlock);

  // Performer pair = local + hub + hub + local — four segments, both
  // local p50s being the sites' worst-online-performer medians. Null
  // while any segment is unmeasured; a disconnected peer shows "—"
  // (same rule as the site pair).
  const ownLocalP50 = localState() ? localState().p50 : null;
  const peerLocalP50 = peer.local ? peer.local.p50 : null;
  const perfTotal = peer.connected
    ? P.derivedPerformerPair(ownLocalP50, ownP50, peerP50, peerLocalP50)
    : null;

  const perfBlock = el("div", "derived");

  perfBlock.append(el("div", "derived-k", t.monitor.perfPair));

  if (perfTotal !== null) {
    perfBlock.append(
      el("div", "big", "≈ " + Math.round(perfTotal) + " ms"),
      el(
        "div",
        "formula",
        t.monitor.segLocal + " " + Math.round(ownLocalP50) +
          " + " + t.monitor.segHub + " " + Math.round(ownP50) +
          " + " + t.monitor.segHub + " " + Math.round(peerP50) +
          " + " + t.monitor.segLocal + " " + Math.round(peerLocalP50) + " ms",
      ),
    );
  } else {
    perfBlock.append(
      el("div", "big", "—"),
      el("div", "formula", peer.connected ? t.monitor.waitPerf : t.monitor.peerUnreachable),
    );
  }

  card.append(perfBlock);

  const rows = el("div");

  rows.append(
    metricRow(t.monitor.rttP50, formatMs(summary.rttP50)),
    metricRow(t.monitor.rttP95, formatMs(summary.rttP95)),
    metricRow(t.monitor.performers, String(peer.local ? peer.local.performers : 0)),
    metricRow(
      t.monitor.localLeg,
      (peer.local && peer.local.status) || t.monitor.noData,
    ),
  );
  card.append(rows);

  return card;
}

// The local panel: THIS site's performers, one compact card each —
// status (LND rules: latency participates on a LAN), metrics, and the
// per-performer event log (connected / disconnected / reconnected).
function renderLocal() {
  localCardsEl.textContent = "";

  const local = localState();

  if (!local) {
    return;
  }

  const entries = Object.entries(local.clients || {}).sort(
    ([a], [b]) => Number(a) - Number(b),
  );

  localCountEl.textContent =
    entries.length > 0 ? fmt(T().monitor.countOnline, [local.performers]) : "";

  if (entries.length === 0) {
    localCardsEl.append(el("div", "hint", T().monitor.emptyLocal));
    return;
  }

  for (const [id, client] of entries) {
    localCardsEl.append(renderPerformerCard(local.probing, id, client));
  }
}

function renderPerformerCard(probing, id, client) {
  const t = T();
  const card = el("div", "client-card " + statusClass(client.status));
  const head = el("div", "head");

  head.append(
    el("span", "dot on"),
    el(
      "span",
      null,
      t.monitor.performer + id + (probing === "burst" ? " · " + t.monitor.burst : ""),
    ),
    el("span", "status-word", client.status.toUpperCase()),
  );
  card.append(
    head,
    el("div", "copy", t.localStatus[client.status] || ""),
    el(
      "div",
      "reason",
      client.connected
        ? reasonLine(client.reason, null, t.localReasons)
        : reasonLine("disconnected", null, t.localReasons),
    ),
  );

  const metrics = client.metrics || {};
  const rows = el("div");

  rows.append(
    metricRow(t.monitor.rttP50, formatMs(metrics.rttP50)),
    metricRow(t.monitor.rttP95, formatMs(metrics.rttP95)),
    metricRow(t.monitor.jitterP95, formatMs(metrics.jitterP95)),
    metricRow(t.monitor.loss, formatPct(metrics.lossRate)),
  );
  card.append(rows);

  // Last three events: the full connected → disconnected → reconnected
  // story fits on one compact line.
  const recent = (client.events || []).slice(-3).reverse();

  if (recent.length > 0) {
    card.append(
      el(
        "div",
        "events-line",
        recent
          .map((event) => eventLabel(event.type) + " " + agoText(event.agoMs))
          .join(" · "),
      ),
    );
  }

  return card;
}

function renderLog() {
  const t = T();

  logEl.textContent = "";
  const info = leg();
  const events = info ? info.events || [] : [];

  if (events.length === 0) {
    logEl.append(el("div", "entry", t.monitor.noEvents));
    return;
  }

  for (const event of events.slice(-8).reverse()) {
    const entry = el("div", "entry");
    const type = el("b", null, eventLabel(event.type));

    entry.append(
      type,
      document.createTextNode(
        (event.detail ? " — " + detailText(event.detail, t) : "") +
          "  ·  " + agoText(event.agoMs),
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
  const t = T();

  return (
    t.events[type] || type.charAt(0).toUpperCase() + type.slice(1)
  );
}

// Event details the server itself words carry a key mapped through
// the table; external diagnostics (socket.io reasons, error messages)
// stay verbatim.
function detailText(detail, t) {
  return t.eventDetails[detail] || detail;
}

function agoText(agoMs) {
  const t = T();

  if (typeof agoMs !== "number") {
    return "";
  }

  if (agoMs < 1000) {
    return t.ago.just;
  }

  if (agoMs < 60000) {
    return Math.round(agoMs / 1000) + t.ago.seconds;
  }

  return Math.round(agoMs / 60000) + t.ago.minutes;
}

render();
