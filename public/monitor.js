// Internet diagnostics only. Server snapshots own measurement/quality truth;
// this page owns presentation, transient hover and the pinned detail selection.
(() => {
  const P = window.PNDS, L = window.PNDS_LOCALE, G = window.PNDS_GEOGRAPHY;
  const app = document.getElementById("app"), SVG_NS = "http://www.w3.org/2000/svg";
  const el = id => document.getElementById(id);
  const copy = () => (P.copy[L.current()] || P.copy["zh-CN"]).internet;
  const tables = () => P.copy[L.current()] || P.copy["zh-CN"];
  const fmt = (text, values) => text.replace(/\{(\w+)\}/g, (whole, key) => values?.[key] ?? whole);
  const text = (id, value) => { el(id).textContent = value; };
  const metric = (value, digits = 0, suffix = "") => Number.isFinite(value) ? value.toFixed(digits) + suffix : "—";
  const svg = (name, attrs, className) => {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
    if (className) node.setAttribute("class", className);
    return node;
  };
  app.innerHTML = `
    <div class="brand">PNDS UTILITY</div>
    <header><div><h1>Telematic Diagnostics</h1><p class="sub" data-copy="sub"></p><p class="hub-address" id="hub-address"></p></div><div class="activity"><span class="activity-value" id="site-count">00</span><span class="activity-label" data-copy="sites"></span></div></header>
    <section class="panel" aria-labelledby="banner-title">
      <div class="overall st-idle" id="banner"><div class="verdict"><strong><span class="dot" aria-hidden="true"></span><span id="banner-title"></span></strong><p id="banner-copy" role="status"></p></div><div class="connection-status"><span id="online-count"></span><button type="button" id="retry" hidden data-copy="reconnect"></button></div></div>
      <div class="map-panel"><div class="map-toolbar"><h2 id="map-title"></h2><div class="view-toggle" id="view-toggle" role="group"><button type="button" data-view="topology" data-copy="topology" aria-pressed="false"></button><button type="button" data-view="geography" data-copy="geography" aria-pressed="true"></button></div></div>
        <div class="map-stage" id="map-stage"><svg id="map-svg" role="img"><defs><clipPath id="map-clip"><rect id="map-clip-rect"/></clipPath></defs><g clip-path="url(#map-clip)"><g id="land-layer" class="land-layer"></g><g id="edges"></g><g id="hub-layer"></g></g></svg><div id="marks"></div><div id="map-labels"></div><div class="map-empty" id="map-empty" hidden><strong data-copy="emptyMap"></strong><span data-copy="emptyHint"></span></div><div class="map-scale" id="map-scale" hidden><span id="scale-line"></span><span id="scale-value"></span></div></div>
        <div class="unknown-nodes" id="unknown-nodes" hidden><span data-copy="unknownLocation"></span></div><div class="map-meta"><span data-copy="legend"></span><span id="map-hint"></span></div>
      </div>
      <section class="readings" aria-labelledby="readings-title"><div class="section-head"><h2 id="readings-title" data-copy="readings"></h2><span data-copy="window"></span></div><table><thead><tr><th data-copy="node"></th><th data-copy="status"></th><th data-copy="rtt"></th><th data-copy="jitter"></th><th data-copy="loss"></th></tr></thead><tbody id="node-rows"></tbody></table><p class="fineprint" data-copy="fineprint"></p></section>
      <details class="node-detail" id="node-detail"><summary><strong id="selected-name"></strong><span id="selected-summary"></span></summary><div class="detail-body"><dl class="detail-grid"><div><dt data-copy="p50"></dt><dd id="detail-p50"></dd></div><div><dt data-copy="p95"></dt><dd id="detail-p95"></dd></div><div><dt data-copy="iqr"></dt><dd id="detail-iqr"></dd></div><div><dt data-copy="lossRate"></dt><dd id="detail-loss"></dd></div><div><dt data-copy="reconnects"></dt><dd id="detail-reconnects"></dd></div><div><dt data-copy="dataSource"></dt><dd id="detail-source"></dd></div><div><dt data-copy="location"></dt><dd id="detail-location"></dd></div><div><dt data-copy="ip"></dt><dd id="detail-ip"></dd></div></dl><p class="detail-reason" id="detail-reason"></p>
      <details class="location-editor" id="location-editor" hidden><summary data-copy="editLocation"></summary><p class="fineprint" data-copy="locationNote"></p><form id="location-form"><div class="location-fields"><label><span data-copy="locationLabel"></span><input id="location-label" maxlength="96" autocomplete="off"/></label><label><span data-copy="latitude"></span><input id="location-latitude" type="number" min="-90" max="90" step="any" required/></label><label><span data-copy="longitude"></span><input id="location-longitude" type="number" min="-180" max="180" step="any" required/></label></div><div class="form-actions"><button id="location-save" type="submit" data-copy="saveLocation"></button><button id="location-reset" type="button" data-copy="resetLocation"></button></div><p id="location-feedback" class="form-feedback" role="status"></p></form></details></div></details>
      <details class="disclosure" id="connection"><summary data-copy="connection"></summary><dl class="config-grid"><div><dt data-copy="hub"></dt><dd id="config-hub"></dd></div><div><dt data-copy="formRoom"></dt><dd id="config-room"></dd></div><div><dt data-copy="formNode"></dt><dd id="config-node"></dd></div><div><dt data-copy="location"></dt><dd id="config-hub-location"></dd></div></dl><p class="fineprint" id="app-config-note" data-copy="appConfig" hidden></p><details id="connection-editor"><summary data-copy="formTitle"></summary><form id="connection-form"><div class="form-grid"><label><span data-copy="formUrl"></span><input id="f-url" placeholder="wss://hub.example.com" spellcheck="false" autocapitalize="off"/></label><label><span data-copy="formToken"></span><input id="f-token" type="password" autocomplete="off"/></label><label><span data-copy="formRoom"></span><input id="f-room" spellcheck="false" autocapitalize="off"/><span class="derived-room" id="f-room-derived" hidden></span></label><label><span data-copy="formNode"></span><input id="f-node"/></label></div><div class="form-actions"><button type="submit" id="b-connect"></button></div></form></details></details>
      <details class="disclosure" id="event-history"><summary data-copy="events"></summary><ol class="event-list" id="event-list"></ol></details>
    </section>`;

  // Geographic land is shipped locally, not fetched or tiled at runtime.
  for (const shift of [-960, 0, 960]) {
    const path = svg("path", { d: window.PNDS_LAND_PATH, transform: `translate(${shift} 0)` }, "land");
    el("land-layer").append(path);
  }
  let state = null, nodes = [], selected = null, hovered = null, focused = null;
  let view = "geography", previewing = false, previousOpen = false, layoutKey = "";
  let formPrefilled = false, locationDirty = false, locationKey = "", locationPending = false;
  let observationLost = false;
  let feedbackKey = "", configurationKey = "", locationRequest = 0, locationTimer = null;
  const records = new Map(), colorSlots = new Map();
  let plotted = [];
  const activeId = () => hovered || focused || selected;
  const socket = io("http://" + location.hostname + ":" + P.performerPort, { reconnection: true });
  const ownName = () => state?.activeConfig?.nodeId || state?.env?.nodeId || copy().self;
  const placeName = place => place.label || place.latitude.toFixed(3) + ", " + place.longitude.toFixed(3);
  const locationOf = node => G.validLocation(node.network?.location) ? node.network.location : null;
  const hubLocation = () => G.validLocation(state?.leg?.network?.hubLocation) ? state.leg.network.hubLocation : null;
  const reason = node => {
    if (observationLost) return copy().observationRecover;
    if (node.unknown) return copy().unknownReason;
    if (node.stale) return copy().staleReason;
    const value = tables().hubReasons[node.reason];
    return value ? fmt(value, node.reasonParams) : node.reason || "";
  };
  function isConnecting() {
    const leg = state?.leg;
    return Boolean(leg && !leg.connected && !leg.everConnected && !leg.events?.some(event => event.type === "connect failed"));
  }
  function nodeTitle(node) {
    return node.unknown ? copy().unknownRemote : node.stale ? copy().stale : copy().quality[node.status] || copy().quality.gray;
  }
  function nodeList() {
    const leg = state?.leg;
    if (!state) return [];
    const own = { ...(leg || {}), id: ownName(), self: true, status: leg?.status || "idle" };
    const peers = Object.entries(leg?.peers || {}).sort(([a], [b]) => a.localeCompare(b)).map(([id, peer]) => ({ ...peer, id, self: false, unknown: peer.unknown || !leg.connected }));
    return [own, ...peers].map(node => ({ ...node, connected: node.connected && !observationLost, unknown: node.unknown || observationLost, status: node.unknown || observationLost ? "gray" : node.status, readable: Boolean(!observationLost && node.connected && !node.unknown && !node.stale && node.status !== "gray") }));
  }
  function slot(id) {
    if (!colorSlots.has(id)) {
      let index = G.hash(id) % 5;
      const used = new Set(colorSlots.values());
      if (used.size < 5) while (used.has(index)) index = (index + 1) % 5;
      colorSlots.set(id, index);
    }
    return `var(--node-${colorSlots.get(id)})`;
  }
  function loadSavedConfig() {
    try { const value = JSON.parse(localStorage.getItem(P.storageKeys.hubConfig) || "null"); return value && typeof value === "object" ? value : {}; }
    catch { return {}; }
  }
  function prefillForm() {
    if (formPrefilled || !state) return;
    formPrefilled = true;
    const saved = loadSavedConfig(), env = state.env || {}, active = state.activeConfig || {};
    const config = { url: env.hubUrl || active.url || saved.url || "", token: env.hubToken || active.token || saved.token || "", room: env.hubRoom || active.room || saved.room || "", nodeId: env.nodeId || active.nodeId || saved.nodeId || "" };
    for (const [key, field] of [["url", "url"], ["token", "token"], ["room", "room"], ["nodeId", "node"]]) el("f-" + field).value = config[key];
    el("f-room").hidden = Boolean(env.hubRoom);
    el("f-room-derived").hidden = !env.hubRoom;
    text("f-room-derived", env.hubRoom || "");
    // The server already starts App-provided config. Only a first,
    // unconfigured standalone session may use its saved browser config.
    if (socket.connected && !observationLost && !state.configured && !env.hubUrl && config.url && config.token) socket.emit(P.events.hubConfig, config);
  }
  function formConfig() { return { url: el("f-url").value.trim(), token: el("f-token").value.trim(), room: el("f-room").value.trim(), nodeId: el("f-node").value.trim() }; }
  function formMatches(config) {
    if (!config) return false;
    const value = formConfig();
    return value.url === config.url && value.token === config.token && (value.room === config.room || !value.room && config.room === P.defaultRoom) && (value.nodeId === config.nodeId || !value.nodeId);
  }
  function renderConnect() {
    const connected = state?.leg?.connected, clean = formMatches(state?.activeConfig);
    text("b-connect", connected && clean && !observationLost ? copy().connected : isConnecting() ? copy().connectingButton : state?.configured ? copy().reconnect : copy().connect);
    el("b-connect").disabled = Boolean(!socket.connected || observationLost || connected && clean || isConnecting());
    el("retry").hidden = !state?.configured || Boolean(connected);
    el("retry").disabled = !socket.connected || observationLost || isConnecting();
    text("retry", isConnecting() ? copy().connectingButton : copy().reconnect);
  }
  function makeNode(node) {
    const row = document.createElement("tr"); row.dataset.row = node.id;
    const nameCell = document.createElement("td"), name = document.createElement("button");
    name.type = "button"; name.className = "node-name"; name.dataset.node = node.id;
    const swatch = document.createElement("span"); swatch.className = "identity-dot"; swatch.setAttribute("aria-hidden", "true");
    const nameText = document.createElement("span"), badge = document.createElement("small");
    name.append(swatch, nameText, badge); nameCell.append(name); row.append(nameCell);
    const status = document.createElement("td"), statusWrap = document.createElement("span"); statusWrap.className = "node-status";
    const statusDot = document.createElement("span"); statusDot.className = "dot"; statusDot.setAttribute("aria-hidden", "true");
    const statusText = document.createElement("span"), age = document.createElement("small"); age.className = "node-age";
    statusWrap.append(statusDot, statusText); status.append(statusWrap, age); row.append(status);
    const readings = [0, 1, 2].map(() => { const cell = document.createElement("td"); row.append(cell); return cell; });
    el("node-rows").append(row);
    const mark = document.createElement("button"); mark.type = "button"; mark.dataset.node = node.id;
    const point = document.createElement("span"); point.className = "point"; point.setAttribute("aria-hidden", "true");
    const unknownName = document.createElement("span"); unknownName.className = "unknown-name";
    mark.append(point, unknownName);
    const edge = svg("path", {}, "edge"); edge.dataset.node = node.id; el("edges").append(edge);
    const tag = document.createElement("span"); tag.className = "self-tag"; el("map-labels").append(tag);
    for (const button of [name, mark]) {
      button.addEventListener("click", event => {
        const hit = button === mark && mark.classList.contains("map-mark") && event.detail > 0 ? nearest(event) : null;
        selected = hit?.id || node.id; hovered = null; focused = null; previewing = false; el("node-detail").open = true; syncInteraction();
      });
      button.addEventListener("focus", () => { focused = node.id; syncInteraction(); });
      button.addEventListener("blur", () => { if (focused === node.id) { focused = null; syncInteraction(); } });
      button.addEventListener("pointerenter", event => { if (event.pointerType !== "touch" && (button === name || mark.classList.contains("unknown-mark"))) setHover(node.id); });
      button.addEventListener("pointerleave", () => { if (button === name || mark.classList.contains("unknown-mark")) setHover(null); });
    }
    return { row, name, nameText, badge, status, statusText, age, readings, mark, unknownName, edge, tag };
  }
  function reconcileNodes() {
    const ids = new Set(nodes.map(node => node.id));
    for (const [id, record] of records) {
      if (ids.has(id)) continue;
      const wasFocused = record.row.contains(document.activeElement) || record.mark === document.activeElement;
      for (const part of [record.row, record.mark, record.edge, record.tag]) part.remove();
      records.delete(id);
      if (hovered === id) hovered = null;
      if (focused === id) focused = null;
      if (wasFocused) records.get(nodes[0]?.id)?.name.focus();
    }
    for (const id of colorSlots.keys()) if (!ids.has(id)) colorSlots.delete(id);
    if (ids.size <= 5) {
      const used = new Set();
      for (const [id, index] of colorSlots) {
        if (used.has(index)) colorSlots.delete(id);
        else used.add(index);
      }
    }
    // Seed new names in id order without changing surviving unique slots.
    for (const id of nodes.map(node => node.id).sort()) slot(id);
    for (const [index, node] of nodes.entries()) {
      const record = records.get(node.id) || makeNode(node); records.set(node.id, record);
      const order = el("node-rows").children[index];
      if (order !== record.row) el("node-rows").insertBefore(record.row, order || null);
      for (const part of [record.row, record.mark, record.edge, record.tag]) part.style.setProperty("--node-color", slot(node.id));
      record.nameText.textContent = node.id; record.badge.textContent = node.self ? copy().self : "";
      P.setStatus(record.status, node.status); record.statusText.textContent = nodeTitle(node);
      record.age.textContent = node.stale ? fmt(copy().staleAge, [Math.max(1, Math.floor((node.agoMs || 0) / 1000))]) : "";
      record.readings[0].textContent = node.readable ? metric(node.summary?.rttP50) : "—";
      record.readings[1].textContent = node.readable ? metric(node.summary?.iqrMs, 1) : "—";
      record.readings[2].textContent = node.readable ? metric(Number.isFinite(node.summary?.lossRate) ? node.summary.lossRate * 100 : null, 1) : "—";
      const description = node.id + (node.self ? " · " + copy().self : "") + " · " + nodeTitle(node);
      record.name.setAttribute("aria-label", description); record.mark.setAttribute("aria-label", description);
      record.mark.dataset.unknown = String(Boolean(node.unknown)); record.edge.classList.toggle("offline", !node.connected || node.unknown);
      record.unknownName.textContent = node.id; record.tag.textContent = copy().self;
    }
  }
  function renderBanner() {
    const leg = state?.leg, m = copy();
    let title, explanation, status;
    if (observationLost) { title = m.observationLost; explanation = m.observationRecover; status = "gray"; }
    else if (!state?.configured) { title = m.unconfigured; explanation = m.unconfiguredReason; status = "idle"; }
    else if (isConnecting()) { title = m.connecting; explanation = m.connectingReason; status = "gray"; }
    else if (!leg?.connected) { title = leg?.reason === "invalidToken" ? m.authFailed : m.disconnected; explanation = reason(nodes[0]); status = "red"; }
    else {
      status = state.overall?.status || "gray";
      title = status === "gray" ? m.sampling : tables().overall[status] || m.sampling;
      const bad = nodes.find(node => node.id === state.overall?.attributionNodeId);
      explanation = status === "green" ? m.stableReason : bad ? bad.id + " · " + reason(bad) : m.samplingReason;
    }
    P.setStatus(el("banner"), status); text("banner-title", title); text("banner-copy", explanation);
    const count = nodes.filter(node => node.connected && !node.unknown && !node.stale).length;
    text("site-count", leg?.connected && !observationLost ? String(count).padStart(2, "0") : "—");
    text("online-count", leg?.connected && !observationLost ? fmt(m.online, [count, nodes.length]) : fmt(m.known, [nodes.length]));
  }
  function renderConnection() {
    const config = state?.activeConfig || {}, env = state?.env || {}, hub = hubLocation();
    const address = config.url || env.hubUrl || "—";
    text("hub-address", copy().hub + " · " + address + (hub?.label ? " · " + hub.label : ""));
    text("config-hub", address); text("config-room", config.room || env.hubRoom || "—"); text("config-node", ownName());
    text("config-hub-location", hub ? placeName(hub) + " · " + sourceLabel(hub) : copy().hubUnknown);
    el("app-config-note").hidden = !env.hubUrl;
    el("connection-editor").hidden = Boolean(env.hubUrl && env.hubToken && env.hubRoom && env.nodeId);
    renderConnect();
  }
  function ago(milliseconds) {
    const a = tables().ago, seconds = Math.floor((milliseconds || 0) / 1000);
    return seconds < 1 ? a.just : seconds < 60 ? seconds + a.seconds : Math.floor(seconds / 60) + a.minutes;
  }
  function renderEvents() {
    const list = el("event-list"), events = state?.leg?.events || [];
    list.replaceChildren();
    if (!events.length) { const item = document.createElement("li"); item.textContent = copy().noEvents; list.append(item); }
    for (const event of events) {
      const item = document.createElement("li"), time = document.createElement("time"), value = document.createElement("span");
      time.textContent = ago(event.agoMs);
      const detail = tables().eventDetails[event.detail] || event.detail || "";
      value.textContent = (tables().events[event.type] || event.type) + (detail ? " · " + detail : "");
      item.append(time, value); list.append(item);
    }
  }
  function sourceLabel(location) { return location.source === "manual" ? copy().manualSource : location.source === "configured" ? copy().configuredSource : copy().ipSource; }
  function updateDetail() {
    const node = nodes.find(node => node.id === activeId());
    el("node-detail").hidden = !node;
    if (!node) return;
    const place = locationOf(node), m = copy(), summary = node.summary || {};
    el("node-detail").style.setProperty("--node-color", slot(node.id));
    text("selected-name", node.id + (node.self ? " · " + m.self : ""));
    text("selected-summary", node.readable ? "p95 " + metric(summary.rttP95, 0, " ms") + " · " + fmt(m.shortReconnects, [summary.reconnects || 0]) : nodeTitle(node));
    text("detail-p50", node.readable ? metric(summary.rttP50, 0, " ms") : "—");
    text("detail-p95", node.readable ? metric(summary.rttP95, 0, " ms") : "—");
    text("detail-iqr", node.readable ? metric(summary.iqrMs, 1, " ms") : "—");
    text("detail-loss", node.readable ? metric(Number.isFinite(summary.lossRate) ? summary.lossRate * 100 : null, 1, "%") : "—");
    text("detail-reconnects", node.readable ? fmt(m.reconnectCount, [summary.reconnects || 0]) : "—");
    text("detail-source", node.unknown ? m.unknownRemote : node.self ? m.ownMeasurement : fmt(m.reported, [ago(node.agoMs)]));
    text("detail-location", place ? placeName(place) + " · " + sourceLabel(place) + (!node.connected ? " · " + m.lastLocation : "") : m.unknownLocation);
    text("detail-ip", node.network?.ip || "—"); text("detail-reason", reason(node));
    el("location-editor").hidden = !node.self || !state?.configured;
    if (node.self && !locationDirty) {
      const key = JSON.stringify(place);
      if (key !== locationKey) {
        locationKey = key; el("location-label").value = place?.label || "";
        el("location-latitude").value = place?.latitude ?? ""; el("location-longitude").value = place?.longitude ?? "";
      }
    }
    text("location-feedback", feedbackKey ? m[feedbackKey] : "");
  }
  function syncInteraction() {
    const temporary = Boolean(hovered || focused), active = activeId();
    if (temporary && !previewing) { previousOpen = el("node-detail").open; previewing = true; }
    if (temporary) el("node-detail").open = true;
    else if (previewing) { el("node-detail").open = previousOpen; previewing = false; }
    for (const [id, record] of records) {
      record.row.dataset.active = String(id === active); record.mark.dataset.active = String(id === active);
      record.edge.classList.toggle("chosen", id === active);
      record.name.setAttribute("aria-pressed", String(id === selected)); record.mark.setAttribute("aria-pressed", String(id === selected));
    }
    el("node-detail").dataset.preview = String(temporary); updateDetail();
  }
  function setHover(id) { if (id !== hovered) { hovered = id; syncInteraction(); } }
  function nearest(event) { const bounds = el("map-stage").getBoundingClientRect(); return G.nearest(plotted, event.clientX - bounds.left, event.clientY - bounds.top); }
  function layout() {
    const stage = el("map-stage"), width = stage.clientWidth, height = stage.clientHeight;
    if (!width || !height) return;
    const geographic = view === "geography", hub = hubLocation();
    const key = JSON.stringify([view, width, height, hub, nodes.map(node => [node.id, locationOf(node)])]);
    if (key === layoutKey) return;
    layoutKey = key;
    el("map-svg").setAttribute("viewBox", `0 0 ${width} ${height}`);
    el("map-clip-rect").setAttribute("width", width); el("map-clip-rect").setAttribute("height", height);
    const locations = nodes.map(locationOf).filter(Boolean); if (hub) locations.push(hub);
    const camera = G.fitCamera(locations, width, height);
    el("land-layer").style.display = geographic && camera ? "" : "none";
    if (camera) el("land-layer").setAttribute("transform", `translate(${camera.ox} ${camera.oy}) scale(${camera.sx} ${camera.sy})`);
    const hubPoint = geographic ? hub && camera ? G.position(hub, camera) : null : { x: width / 2, y: height / 2 - 4 };
    el("hub-layer").replaceChildren();
    if (hubPoint) el("hub-layer").append(svg("rect", { x: hubPoint.x - 6, y: hubPoint.y - 6, width: 12, height: 12 }, "hub-point"));
    el("map-empty").hidden = !geographic || Boolean(camera);
    let unknown = 0; plotted = [];
    for (const [index, node] of nodes.entries()) {
      const record = records.get(node.id), place = locationOf(node);
      const point = geographic ? place && camera ? G.position(place, camera) : null : { x: width / 2 + Math.cos(-Math.PI / 2 + index * 2 * Math.PI / nodes.length) * Math.min(width * .32, 170), y: height / 2 - 4 + Math.sin(-Math.PI / 2 + index * 2 * Math.PI / nodes.length) * Math.min(height * .32, 112) };
      record.tag.hidden = !node.self || !point; record.edge.style.display = point && hubPoint ? "" : "none";
      if (point) {
        if (record.mark.parentElement !== el("marks")) el("marks").append(record.mark);
        record.mark.className = "map-mark"; record.mark.style.left = point.x + "px"; record.mark.style.top = point.y + "px";
        record.tag.style.left = point.x + "px"; record.tag.style.top = Math.min(height - 28, point.y + 16) + "px";
        plotted.push({ ...point, id: node.id });
        if (hubPoint) record.edge.setAttribute("d", geographic ? `M${hubPoint.x},${hubPoint.y} Q${hubPoint.x},${hubPoint.y + (point.y - hubPoint.y) * .55} ${point.x},${point.y}` : `M${hubPoint.x},${hubPoint.y} L${point.x},${point.y}`);
      } else {
        unknown++;
        if (record.mark.parentElement !== el("unknown-nodes")) el("unknown-nodes").append(record.mark);
        record.mark.className = "unknown-mark"; record.mark.style.removeProperty("left"); record.mark.style.removeProperty("top");
      }
    }
    el("unknown-nodes").hidden = unknown === 0;
    el("map-scale").hidden = !geographic || !camera;
    if (camera) {
      const km = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000].filter(value => value * camera.pixelsPerKm <= (width < 480 ? 54 : 80)).at(-1) || 1;
      el("scale-line").style.inlineSize = km * camera.pixelsPerKm + "px"; text("scale-value", fmt(copy().approxScale, [km]));
    }
  }
  function render() {
    for (const node of app.querySelectorAll("[data-copy]")) node.textContent = copy()[node.dataset.copy];
    el("view-toggle").setAttribute("aria-label", copy().viewLabel);
    for (const button of app.querySelectorAll("[data-view]")) button.setAttribute("aria-pressed", String(button.dataset.view === view));
    text("map-title", view === "geography" ? copy().mapTitle : copy().topologyTitle);
    el("map-svg").setAttribute("aria-label", view === "geography" ? copy().mapDescription : copy().topologyDescription);
    nodes = nodeList();
    if (!nodes.some(node => node.id === selected)) selected = nodes[0]?.id || null;
    if (!nodes.some(node => node.id === hovered)) hovered = null;
    if (!nodes.some(node => node.id === focused)) focused = null;
    prefillForm(); reconcileNodes(); renderBanner(); renderConnection(); renderEvents(); layout(); syncInteraction();
    const unknown = nodes.some(node => !locationOf(node));
    text("map-hint", view === "geography" && !hubLocation() ? copy().hubUnknown : view === "geography" && unknown ? copy().mapPartial : copy().hover);
    // Label/locale changes do not alter the camera or marker positions.
    if (view === "geography" && !el("map-scale").hidden) {
      const km = el("scale-value").textContent.match(/[\d.]+/)?.[0]; if (km) text("scale-value", fmt(copy().approxScale, [km]));
    }
  }
  socket.on(P.events.state, next => {
    observationLost = false;
    const nextKey = JSON.stringify([next.activeConfig?.url, next.activeConfig?.room, next.activeConfig?.nodeId]);
    if (configurationKey && configurationKey !== nextKey) {
      locationDirty = false; locationKey = ""; feedbackKey = "";
      clearTimeout(locationTimer); locationRequest++; locationPending = false;
      el("location-save").disabled = false; el("location-reset").disabled = false;
    }
    configurationKey = nextKey; state = next; render();
  });
  L.subscribe(render);
  app.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => { view = button.dataset.view; render(); }));
  el("map-stage").addEventListener("pointermove", event => { if (event.pointerType !== "touch") setHover(nearest(event)?.id || null); });
  el("map-stage").addEventListener("pointerleave", () => setHover(null));
  el("connection-form").addEventListener("submit", event => {
    event.preventDefault(); const config = formConfig(); if (!socket.connected || observationLost || !config.url || !config.token) return;
    try { localStorage.setItem(P.storageKeys.hubConfig, JSON.stringify(config)); } catch { /* Connection remains usable when browser storage is unavailable. */ }
    socket.emit(P.events.hubConfig, config);
  });
  for (const input of el("connection-form").querySelectorAll("input")) input.addEventListener("input", renderConnect);
  el("retry").addEventListener("click", () => { if (socket.connected && !observationLost && state?.activeConfig) socket.emit(P.events.hubConfig, { ...state.activeConfig }); });
  for (const input of el("location-form").querySelectorAll("input")) input.addEventListener("input", () => { locationDirty = true; feedbackKey = ""; text("location-feedback", ""); });
  function finishLocation(request, value, result) {
    if (request !== locationRequest || !locationPending) return;
    clearTimeout(locationTimer); locationPending = false;
    el("location-save").disabled = false; el("location-reset").disabled = false;
    feedbackKey = result?.ok ? value ? "locationSaved" : "locationReset" : "locationFailed";
    if (result?.ok) { locationDirty = false; locationKey = ""; }
    updateDetail();
  }
  function applyLocation(value) {
    if (locationPending) return;
    if (!socket.connected || observationLost) { feedbackKey = "locationFailed"; text("location-feedback", copy()[feedbackKey]); return; }
    const request = ++locationRequest;
    locationPending = true; feedbackKey = "locationSaving"; text("location-feedback", copy()[feedbackKey]);
    el("location-save").disabled = true; el("location-reset").disabled = true;
    locationTimer = setTimeout(() => finishLocation(request, value, { ok: false }), 5000);
    // The synchronous connected/fresh-state guard prevents offline queueing.
    // Keep reliable delivery while connected; timeout releases a missing ACK.
    socket.timeout(5000).emit(P.events.setLocation, value, (error, result) => finishLocation(request, value, error ? { ok: false } : result));
  }
  socket.on("disconnect", () => {
    observationLost = true; finishLocation(locationRequest, null, { ok: false }); render();
  });
  el("location-form").addEventListener("submit", event => {
    event.preventDefault();
    const label = el("location-label").value.trim(), latitudeText = el("location-latitude").value.trim(), longitudeText = el("location-longitude").value.trim();
    const value = { label, latitude: Number(latitudeText), longitude: Number(longitudeText) };
    if (!latitudeText || !longitudeText || !G.validLocation(value)) { feedbackKey = "locationInvalid"; text("location-feedback", copy()[feedbackKey]); return; }
    applyLocation(value);
  });
  el("location-reset").addEventListener("click", () => applyLocation(null));
  new ResizeObserver(layout).observe(el("map-stage"));
  render();
})();
