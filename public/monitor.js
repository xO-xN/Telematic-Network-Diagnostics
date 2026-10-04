// Telematic Network Diagnostics — monitor page (issues #3–#5).
//
// The flower view: the WHOLE network's picture, identical on every
// site's monitor (each node self-reports over the hub room relay).
// Instrument panel layout shared with Local Diagnostics: verdict and
// fault attribution above the hub/star diagram and connection settings;
// per-site readings below, followed by this site's performer cards.
// The diagram, quality coloring and derived segment sums stay driven by
// server truth. Hub RTT readings remain neutral: high stable latency does
// not imply poor quality. Native disclosures hold event history and QR.
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
app.innerHTML = `
  <div class="brand">
    <svg viewBox="0 0 28 20" fill="none" aria-hidden="true"><path d="M14 4v12M4 10h20M6 3l16 14M6 17L22 3" stroke="currentColor" stroke-width="1.5"/><circle cx="14" cy="10" r="4" fill="var(--bg)" stroke="currentColor" stroke-width="1.5"/></svg><span>PNDS UTILITY</span>
  </div>
  <header><div><h1>Telematic Diagnostics</h1><p class="sub" id="sub-label"></p></div>
    <div class="activity"><span class="activity-value" id="site-count">00</span><span class="activity-label" id="sites-label"></span></div>
  </header>
  <section class="panel network-panel" aria-labelledby="overall-label">
    <div class="overall st-idle" id="banner">
      <div class="verdict"><span class="overall-label"><span class="dot on" aria-hidden="true"></span><span id="overall-label"></span></span>
        <p class="overall-copy" id="banner-copy" role="status"></p></div>
      <p class="attribution" id="banner-attribution"></p>
    </div>
    <div class="top-grid">
      <div class="star-panel" id="star-panel"><h2 id="network-title"></h2><div id="star"></div><p class="hint" id="star-hint"></p></div>
      <div id="form-panel"><h2 id="form-title"></h2>
        <div class="form-grid">
          <label><span id="l-url"></span><input id="f-url" placeholder="wss://hub.example.com" spellcheck="false" autocapitalize="off" /></label>
          <label><span id="l-token"></span><input id="f-token" type="password" placeholder="HUB_TOKEN" /></label>
          <label><span id="l-room"></span><input id="f-room" placeholder="default" spellcheck="false" autocapitalize="off" /><span class="derived-room hidden" id="f-room-derived"></span></label>
          <label><span id="l-node"></span><input id="f-node" placeholder="site name" /></label>
        </div>
        <div class="form-actions"><button type="button" id="b-connect"></button></div>
        <p class="hint" id="form-hint"></p>
        <details class="connection-log"><summary id="log-title"></summary><div class="log" id="log"></div></details>
      </div>
    </div>
    <div class="site-readings"><div class="section-head"><h2 id="readings-title"></h2><span class="section-note" id="readings-note"></span></div><div id="cards"></div></div>
  </section>
  <section class="panel local-panel" id="local-panel" aria-labelledby="local-title">
    <div class="section-head"><h2><span id="local-title" tabindex="-1"></span> <span class="count" id="local-count"></span></h2><span class="section-note" id="local-note"></span></div>
    <div class="local-cards" id="local-cards"></div>
  </section>
  <footer><p class="hint" id="footer-hint"></p><details class="remote"><summary><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="4.5" y="1.5" width="7" height="13" rx="1.5" stroke="currentColor"/><path d="M7 12h2" stroke="currentColor"/></svg><span id="join-label"></span></summary><div class="qr-row"><img src="/qr" id="qr-img" alt=""/><span id="scan-label"></span></div></details></footer>`;

const bannerEl = document.getElementById("banner");
const bannerCopyEl = document.getElementById("banner-copy");
const bannerAttributionEl = document.getElementById("banner-attribution");
const starEl = document.getElementById("star");
const localCardsEl = document.getElementById("local-cards");
const performerCards = new Map();
const localEmpty = el("p", "empty-local");
const localEvents = el("div", "events-line site-events");
const localCountEl = document.getElementById("local-count");
const cardsEl = document.getElementById("cards");
const urlInput = document.getElementById("f-url");
const tokenInput = document.getElementById("f-token");
const roomInput = document.getElementById("f-room");
const derivedRoomEl = document.getElementById("f-room-derived");
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

// Placeholder filling for the copy templates: numeric slots ({0}, {1})
// read the params array, named slots ({node}) read the params object.
function fmt(template, params) {
  return template.replace(/\{(\w+)\}/g, (whole, key) =>
    params && params[key] !== undefined ? params[key] : whole,
  );
}

let state = null;
let formPrefilled = false;
// What the auto-start sends: the config loaded at startup, REPLACED by
// whatever the operator later submits — so a transient socket
// reconnect can never submit a half-edited form, and never rolls a
// manual session edit back to the startup values either (issue #15:
// hand edits hold for the whole session; only the next PAGE LOAD
// restores the env).
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

// The App-present prefill (issue #15): env values win FIELD BY FIELD
// over the saved form — the App's node settings are the live
// configuration, and an old browser memory must never silently mask
// them; the saved values fill only what the env leaves empty (the
// priority inversion of #3's "localStorage wins" dual-channel shape).
// A manual edit still saves to localStorage, and the next page load
// lets the env override it again — hand edits are session-only by
// construction, with no extra state anywhere.
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
    url: env.hubUrl || saved.url || "",
    token: env.hubToken || saved.token || "",
    room: env.hubRoom || saved.room || "",
    nodeId: env.nodeId || saved.nodeId || "",
  };

  urlInput.value = config.url;
  tokenInput.value = config.token;
  roomInput.value = config.room;
  nodeInput.value = config.nodeId;

  applyRoomDisplay(env.hubRoom || "");

  if (config.url && config.token) {
    autoConfig = config;
    socket.emit(P.events.hubConfig, config);
  }
}

// The room slot's two shapes (issue #15): an env room means the App
// derived it ({project id}_{group}) — the input exits and a read-only
// line shows the full name to verify against. The hidden input keeps
// carrying the value, so submits and the connect button's dirty check
// ride it exactly as before. No env room → the operator hand-fills,
// unchanged since #3.
function applyRoomDisplay(envRoom) {
  const appPresent = Boolean(envRoom);

  derivedRoomEl.textContent = envRoom || "";
  derivedRoomEl.classList.toggle("hidden", !appPresent);
  roomInput.classList.toggle("hidden", appPresent);
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

  // The submission is the session's intent from here on: a later
  // socket reconnect re-sends IT, not the startup config (issue #15).
  autoConfig = config;
  socket.emit(P.events.hubConfig, config);
  return true;
}

// ------------------------------------------------------------
// Connect button state machine (#12)
// ------------------------------------------------------------

// The form-vs-live-config dirty check: trimmed values, exact string
// compare — case-sensitive, no scheme/host normalization (a different
// spelling is a different config). The one asymmetry is the two
// server-applied defaults: an empty room means "default", and an empty
// node name means "the server picks" — both compare clean against
// whatever is actually live.
function formMatchesActive(active) {
  if (!active) {
    return false;
  }

  return (
    urlInput.value.trim() === active.url &&
    tokenInput.value.trim() === active.token &&
    (roomInput.value.trim() === active.room ||
      (roomInput.value.trim() === "" && active.room === P.defaultRoom)) &&
    (nodeInput.value.trim() === active.nodeId || nodeInput.value.trim() === "")
  );
}

// Four states, from server truth alone (a page refresh or another
// device renders the same button): 未连接 → 连接; submitted → first
// connect → 连接中…; connected && form == activeConfig → 已连接;
// connected && form ≠ activeConfig → 重新连接. Connected means the
// TRANSPORT is up — a yellow or red metric never un-words「已连接」
// (connection state ≠ health state).
function renderConnectButton() {
  const m = T().monitor;
  const leg = state && state.leg ? state.leg : null;

  let label = m.connect;
  let disabled = false;

  if (leg && !leg.connected && !leg.everConnected) {
    label = m.connecting;
    disabled = true;
  } else if (leg && leg.connected && formMatchesActive(state.activeConfig)) {
    label = m.connected;
    disabled = true;
  } else if (leg && leg.connected) {
    label = m.reconnect;
  }

  connectButton.textContent = label;
  connectButton.disabled = disabled;
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
  return (
    (state && state.activeConfig && state.activeConfig.nodeId) ||
    T().monitor.ownFallback
  );
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
  nodeInput.setAttribute("placeholder", m.formNodePlaceholder);
  renderConnectButton();
  chromeEls.formHint.textContent = m.formHint;
  chromeEls.starHint.textContent = m.starHint;
  chromeEls.localTitle.textContent = m.localTitle;
  chromeEls.logTitle.textContent = m.logTitle;
  chromeEls.scan.textContent = m.scan;
  chromeEls.qrImg.setAttribute("alt", m.qrAlt);

  for (const [id, value] of Object.entries({
    "sites-label": m.sites,
    "network-title": m.networkTitle,
    "readings-title": m.readingsTitle,
    "readings-note": m.readingsNote,
    "local-note": m.localNote,
    "join-label": m.join,
    "footer-hint": m.footerHint,
  }))
    document.getElementById(id).textContent = value;
  const info = leg();
  const onlineSites = info
    ? Number(Boolean(info.connected)) +
      sortedPeers(info).filter(([, peer]) => peer.connected).length
    : 0;
  document.getElementById("site-count").textContent = String(
    onlineSites,
  ).padStart(2, "0");
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
    // The template keys carry the status capitalized ("Red" /
    // "Yellow") and the self variant unprefixed.
    const statusWord = status.charAt(0).toUpperCase() + status.slice(1);
    const key =
      "attrib" + (overall.attributionSelf ? "Self" : "") + legWord + statusWord;

    bannerAttributionEl.textContent = fmt(t.monitor[key] || "", {
      node: overall.attributionNodeId,
    });
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
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", T().monitor.starHint);

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
      node.connected && Number.isFinite(node.p50)
        ? Math.round(node.p50) + " ms"
        : "—",
      "spoke-label",
    );

    label.setAttribute("text-anchor", "middle");
    svg.append(label);

    // Node: outer ring = the site's local-leg worst (gray = no data),
    // inner dot = hub-leg quality.
    const ring = svgEl("circle", { cx: x, cy: y, r: 17 });
    ring.setAttribute(
      "class",
      "node-ring " + statusClass(node.localWorst || "gray"),
    );
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
    // Name only — no card carries a phase marker (#11); probing stays
    // on the wire, it just has nothing to paint (see the note above
    // renderPerformerCard for why).
    el("span", "node-name-label", name),
    el("span", "tag", t.monitor.selfTag),
    el("span", "status-word", statusWord(info.status)),
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

  const rows = el("div", "rows");
  const summary = info.summary || {};

  rows.append(
    metricRow(t.monitor.rttP50, formatMs(summary.rttP50)),
    metricRow(t.monitor.rttP95, formatMs(summary.rttP95)),
    metricRow(t.monitor.oneWay, formatMs(summary.oneWayEstimateMs, 1)),
    metricRow(t.monitor.jitterIqr, formatMs(summary.iqrMs, 1)),
    metricRow(t.monitor.loss, formatPct(summary.lossRate)),
    metricRow(t.monitor.performers, String(local ? local.performers : 0)),
    metricRow(
      t.monitor.localLeg,
      localStatus ? statusWord(localStatus) : t.monitor.noData,
    ),
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
    el("span", "node-name-label", nodeId),
    el("span", "status-word", statusWord(status)),
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
        ownName() +
          " → " +
          nodeId +
          " · " +
          Math.round(ownP50) +
          " + " +
          Math.round(peerP50) +
          " ms",
      ),
    );
  } else {
    siteBlock.append(
      el("div", "big", "—"),
      el(
        "div",
        "formula",
        peer.connected ? t.monitor.waitSite : t.monitor.peerUnreachable,
      ),
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
        t.monitor.segLocal +
          " " +
          Math.round(ownLocalP50) +
          " + " +
          t.monitor.segHub +
          " " +
          Math.round(ownP50) +
          " + " +
          t.monitor.segHub +
          " " +
          Math.round(peerP50) +
          " + " +
          t.monitor.segLocal +
          " " +
          Math.round(peerLocalP50) +
          " ms",
      ),
    );
  } else {
    perfBlock.append(
      el("div", "big", "—"),
      el(
        "div",
        "formula",
        peer.connected ? t.monitor.waitPerf : t.monitor.peerUnreachable,
      ),
    );
  }

  card.append(perfBlock);

  const rows = el("div", "rows");

  rows.append(
    metricRow(t.monitor.rttP50, formatMs(summary.rttP50)),
    metricRow(t.monitor.rttP95, formatMs(summary.rttP95)),
    metricRow(
      t.monitor.performers,
      String(peer.local ? peer.local.performers : 0),
    ),
    metricRow(
      t.monitor.localLeg,
      peer.local && peer.local.status
        ? statusWord(peer.local.status)
        : t.monitor.noData,
    ),
  );
  card.append(rows);

  return card;
}

// The local panel: THIS site's performers, one compact card each —
// status (LND rules: latency participates on a LAN), metrics, and the
// per-performer event log (connected / disconnected / reconnected).
// Site-level events (a deletion — the performer's voluntary exit #10
// or the monitor's「x」#13 — deletes the card, so the trail lives here
// instead) render as one muted line under the cards.
function renderLocal() {
  const local = localState();
  const entries = Object.entries(local?.clients || {}).sort(
    ([a], [b]) => Number(a) - Number(b),
  );
  const ids = new Set(entries.map(([id]) => id));
  for (const [id, card] of performerCards) {
    if (!ids.has(id)) {
      const wasFocused = card.contains(document.activeElement);
      card.remove();
      performerCards.delete(id);
      if (wasFocused) document.getElementById("local-title").focus();
    }
  }
  localCountEl.textContent =
    entries.length > 0 ? fmt(T().monitor.countOnline, [local.performers]) : "";
  localEmpty.textContent = T().monitor.emptyLocal;
  if (entries.length === 0) {
    if (!localEmpty.parentNode) localCardsEl.append(localEmpty);
  } else localEmpty.remove();
  entries.forEach(([id, client], index) => {
    let card = performerCards.get(id);
    if (!card) {
      card = renderPerformerCard(id, client);
      performerCards.set(id, card);
    } else {
      updatePerformerCard(card, id, client);
    }
    const position = localCardsEl.children[index];
    if (position !== card) localCardsEl.insertBefore(card, position || null);
  });
  // Empty copy and site trail live after the keyed cards, never inside one.
  localEvents.textContent = eventsLineText(
    local?.events || [],
    localEventLabel,
  );
  if (local?.events?.length) {
    if (!localEvents.parentNode) localCardsEl.append(localEvents);
  } else localEvents.remove();
}

// The compact "label · ago" trail the performer cards and the
// site-level line both render from — newest first, last three.
function eventsLineText(events, labelFor) {
  return events
    .slice(-3)
    .reverse()
    .map((event) => labelFor(event) + " " + agoText(event.agoMs))
    .join(" · ");
}

// No card anywhere carries a burst/calm marker (#11): the numbers are
// load-scoped (burst samples only, steady across the cycle), so a
// phase marker would only flicker every 2 s — and the phase itself is
// the measurement's business, not the operator's.
function renderPerformerCard(id, client) {
  const card = el("div", "client-card");
  const head = el("div", "head");
  const removeButton = el("button", "remove-btn", "×");
  removeButton.type = "button";
  removeButton.addEventListener("click", () =>
    socket.emit(P.events.remove, { id: Number(id) }),
  );
  head.append(
    el("span", "dot on"),
    el("span", "client-name"),
    el("span", "status-word"),
    removeButton,
  );
  card.append(
    head,
    el("div", "copy"),
    el("div", "reason"),
    el("div", "rows"),
    el("div", "events-line"),
  );
  card.setAttribute("data-client-id", id);
  updatePerformerCard(card, id, client);
  return card;
}

function updatePerformerCard(card, id, client) {
  const t = T();
  const [head, copy, reason, rows, events] = card.children;
  card.className = "client-card " + statusClass(client.status);
  head.children[1].textContent = fmt(t.monitor.performer, [id]);
  head.children[2].textContent = client.connected
    ? statusWord(client.status)
    : t.monitor.offline;
  head.children[3].setAttribute("aria-label", t.monitor.remove);
  copy.textContent = t.localStatus[client.status] || "";
  reason.textContent = reasonLine(
    client.connected ? client.reason : "disconnected",
    null,
    t.localReasons,
  );
  const metrics = client.metrics || {};
  rows.textContent = "";
  rows.append(
    metricRow(t.monitor.rttP50, formatMs(metrics.rttP50)),
    metricRow(t.monitor.rttP95, formatMs(metrics.rttP95)),
    metricRow(t.monitor.jitterP95, formatMs(metrics.jitterP95)),
    metricRow(t.monitor.loss, formatPct(metrics.lossRate)),
  );
  events.textContent = eventsLineText(client.events || [], (event) =>
    eventLabel(event.type),
  );
  events.hidden = !client.events?.length;
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
        (event.detail ? " — " + detailText(event.detail) : "") +
          "  ·  " +
          agoText(event.agoMs),
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

function statusWord(status) {
  return T().monitor.statusWord[status] || status || T().monitor.noData;
}

function formatMs(value, digits = 0) {
  return Number.isFinite(value) ? value.toFixed(digits) + " ms" : "—";
}

function formatPct(value) {
  return Number.isFinite(value) ? (value * 100).toFixed(1) + "%" : "—";
}

function eventLabel(type) {
  const t = T();

  return t.events[type] || type.charAt(0).toUpperCase() + type.slice(1);
}

// Site-level local events name their client: the copy template carries
// a {0} slot ("client {0} 退出（performer）") filled with the id.
function localEventLabel(event) {
  const template = T().events[event.type];

  return template === undefined
    ? eventLabel(event.type)
    : fmt(template, [event.client]);
}

// Event details the server itself words carry a key mapped through
// the table; external diagnostics (socket.io reasons, error messages)
// stay verbatim.
function detailText(detail) {
  return T().eventDetails[detail] || detail;
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
