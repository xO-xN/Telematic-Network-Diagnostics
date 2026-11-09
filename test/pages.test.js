// Real DOM runtime tests. jsdom is a development-only dependency and is not
// included in the utility runtime bundle.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ROOT = path.join(__dirname, "..");
const { JSDOM } = require("jsdom");
const read = file => fs.readFileSync(path.join(ROOT, file), "utf8");
const { events } = require("../public/shared");
function fixture(t, search = "") {
  const errors = [], emitted = [], listeners = new Map(), timers = new Map(); let sequence = 0;
  const dom = new JSDOM('<main id="app"></main>', { url: "http://127.0.0.1:6869/" + search, runScripts: "outside-only" });
  const w = dom.window, d = w.document;
  w.ResizeObserver = class { observe() {} };
  Object.defineProperty(w.HTMLElement.prototype, "clientWidth", { get() { return this.id === "map-stage" ? 680 : 0; } });
  Object.defineProperty(w.HTMLElement.prototype, "clientHeight", { get() { return this.id === "map-stage" ? 340 : 0; } });
  w.setTimeout = (fn, delay) => { const id = ++sequence; timers.set(id, { fn, delay }); return id; };
  w.clearTimeout = id => timers.delete(id);
  const socket = {
    connected: true, ackTimeout: null,
    on(name, handler) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(handler); },
    timeout(delay) { this.ackTimeout = delay; return this; },
    emit(...args) {
      const callback = args.at(-1);
      if (this.ackTimeout !== null && typeof callback === "function") args[args.length - 1] = result => callback(null, result);
      this.ackTimeout = null; emitted.push(args); return this;
    },
  };
  w.io = () => socket;
  w.__PNDS_PORTS__ = { performerPort: 6868, monitorPort: 6869 };
  w.addEventListener("error", event => errors.push(event.message));
  w.document.write = () => {};
  for (const file of ["public/shared.js", "public/geography.js", "public/land.js"]) w.eval(read(file));
  for (const script of read("public/index.html").matchAll(/<script>([\s\S]*?)<\/script>/g)) w.eval(script[1]);
  for (const file of ["lib/theme-follow.js", "lib/locale-follow.js", "public/monitor.js"]) w.eval(read(file));
  const get = id => d.getElementById(id);
  const deliver = (name, value) => { if (name === "disconnect") socket.connected = false; else if (name === "connect") socket.connected = true; for (const handler of listeners.get(name) || []) handler(value); };
  t.after(() => { assert.deepEqual(errors, []); dom.window.close(); });
  return { w, d, get, emitted, deliver, timers, socket, state(value) { deliver(events.state, structuredClone(value)); }, hover(id) { const mark = [...d.querySelectorAll(".map-mark")].find(node => node.dataset.node === id); get("map-stage").dispatchEvent(new w.MouseEvent("pointermove", { clientX: parseFloat(mark.style.left), clientY: parseFloat(mark.style.top), bubbles: true })); }, leave() { get("map-stage").dispatchEvent(new w.MouseEvent("pointerleave")); }, active() { return d.querySelector('tr[data-active="true"]')?.dataset.row; } };
}
const place = (label, latitude, longitude, source = "ip") => ({ label, latitude, longitude, source });
function sample() {
  const summary = { rttP50: 12, rttP95: 16, iqrMs: 1.2, lossRate: 0, reconnects: 0, samples: 60 };
  return { configured: true, activeConfig: { url: "https://hub.example", token: "example-token", room: "work_1", nodeId: "北京西城" }, env: {}, overall: { status: "green" }, leg: { connected: true, everConnected: true, status: "green", reason: "linkGood", summary, network: { ip: "192.0.2.1", location: place("北京西城", 39.91, 116.37), hubLocation: place("南京", 32.04, 118.77, "configured"), manualLocationSupported: true }, events: [], peers: { "北京大兴": { connected: true, status: "green", reason: "linkGood", summary: { ...summary, rttP50: 15 }, agoMs: 1000, network: { ip: "192.0.2.2", location: place("北京大兴", 39.73, 116.34) } }, "武汉": { connected: true, status: "green", reason: "linkGood", summary: { ...summary, rttP50: 32 }, network: { location: place("武汉", 30.6, 114.3) } }, "内蒙古": { connected: true, status: "green", reason: "linkGood", summary, network: { location: place("呼和浩特", 40.84, 111.75) } } } } };
}
const button = (p, id, selector = ".node-name") => [...p.d.querySelectorAll(selector)].find(node => node.dataset.node === id);
const submit = (p, id) => p.get(id).dispatchEvent(new p.w.Event("submit", { bubbles: true, cancelable: true }));
const input = (p, id, value) => { p.get(id).value = value; p.get(id).dispatchEvent(new p.w.Event("input", { bubbles: true })); };
const positions = p => [...p.d.querySelectorAll(".map-mark")].map(node => [node.dataset.node, node.style.left, node.style.top]);

test("nearest geographic node previews its row/details, restores folding and keeps exact positions", t => {
  const p = fixture(t); p.state(sample()); const before = positions(p);
  assert.equal(p.get("map-labels").textContent.replaceAll("本站", ""), "");
  assert.equal(p.d.querySelectorAll(".self-tag:not([hidden])").length, 1);
  assert.equal(p.get("node-detail").open, false);
  p.hover("北京大兴"); assert.equal(p.active(), "北京大兴"); assert.match(p.get("selected-name").textContent, /大兴/); assert.equal(p.get("node-detail").open, true);
  p.hover("北京西城"); assert.equal(p.active(), "北京西城");
  p.leave(); assert.equal(p.active(), "北京西城"); assert.equal(p.get("node-detail").open, false); assert.deepEqual(positions(p), before);
  button(p, "北京大兴").click(); p.hover("武汉"); p.leave(); assert.equal(p.active(), "北京大兴"); assert.equal(p.get("node-detail").open, true);
});
test("live readings preserve row/marker identity, keyboard focus, selection, folds and drafts", t => {
  const p = fixture(t), data = sample(); p.state(data);
  const name = button(p, "北京大兴"), mark = button(p, "北京大兴", ".map-mark"), edge = p.d.querySelector('[data-node="北京大兴"].edge');
  name.focus(); assert.equal(p.active(), "北京大兴"); name.click(); p.get("connection").open = true;
  input(p, "f-node", "editing a name"); const before = positions(p);
  data.leg.peers["北京大兴"].summary.rttP50 = 29; p.state(data);
  assert.equal(button(p, "北京大兴"), name); assert.equal(button(p, "北京大兴", ".map-mark"), mark); assert.equal(p.d.activeElement, name);
  assert.equal(p.get("connection").open, true); assert.equal(p.get("f-node").value, "editing a name"); assert.equal(p.active(), "北京大兴"); assert.deepEqual(positions(p), before); assert.equal(p.d.querySelector('[data-node="北京大兴"].edge'), edge);
  assert.match(p.get("detail-p50").textContent, /29/);
  name.blur(); button(p, "武汉").focus(); assert.equal(p.active(), "武汉"); button(p, "武汉").blur(); assert.equal(p.active(), "北京大兴");
});
test("identity colors do not collide for the usual four nodes or shuffle on roster/quality updates", t => {
  const p = fixture(t), data = sample(); p.state(data);
  const colors = new Map([...p.d.querySelectorAll("tr[data-row]")].map(row => [row.dataset.row, row.style.getPropertyValue("--node-color")]));
  assert.equal(new Set(colors.values()).size, 4);
  data.leg.peers["武汉"].status = "red"; data.overall = { status: "red", attributionNodeId: "武汉" }; p.state(data);
  for (const row of p.d.querySelectorAll("tr[data-row]")) assert.equal(row.style.getPropertyValue("--node-color"), colors.get(row.dataset.row));
  delete data.leg.peers["内蒙古"]; p.state(data); assert.equal(p.d.querySelector('tr[data-row="北京大兴"]').style.getPropertyValue("--node-color"), colors.get("北京大兴"));
});
test("unknown locations are listed without invented geographic nodes; topology still includes everyone", t => {
  const p = fixture(t), data = sample(); data.leg.network.hubLocation = null; for (const value of [data.leg, ...Object.values(data.leg.peers)]) value.network.location = null; p.state(data);
  assert.equal(p.d.querySelectorAll(".map-mark").length, 0); assert.equal(p.d.querySelectorAll(".unknown-mark").length, 4); assert.equal(p.get("hub-layer").children.length, 0); assert.equal(p.get("map-empty").hidden, false);
  p.d.querySelector('[data-view="topology"]').click(); assert.equal(p.d.querySelectorAll(".map-mark").length, 4); assert.equal(p.get("hub-layer").children.length, 1);
  p.d.querySelector('[data-view="geography"]').click(); assert.equal(p.get("hub-layer").children.length, 0);
});
test("disconnected and stale nodes hide old readings, with unknown remotes separated from real remote staleness", t => {
  const p = fixture(t), data = sample(); data.leg.connected = false; data.leg.reason = "transport"; for (const value of Object.values(data.leg.peers)) value.unknown = true; p.state(data);
  assert.match(p.get("banner-title").textContent, /本站与 HUB 断开/); button(p, "北京大兴").click(); assert.equal(p.get("detail-p50").textContent, "—"); assert.match(p.get("detail-reason").textContent, /无法确认/);
  const stable = sample(); stable.leg.peers["北京大兴"].connected = false; stable.leg.peers["北京大兴"].stale = true; stable.leg.peers["北京大兴"].agoMs = 8000; p.state(stable);
  assert.match(p.get("selected-summary").textContent, /数据中断/); assert.equal(p.get("detail-p50").textContent, "—"); assert.match(p.get("detail-location").textContent, /上次位置/);
});
test("App configuration is read-only and never automatically resubmitted on snapshots or socket reconnect", t => {
  const p = fixture(t), data = sample(); data.env = { hubUrl: data.activeConfig.url, hubToken: data.activeConfig.token, hubRoom: data.activeConfig.room, nodeId: data.activeConfig.nodeId }; p.state(data); p.state(data); p.deliver("connect");
  assert.equal(p.get("connection-editor").hidden, true); assert.equal(p.get("f-room").hidden, true); assert.equal(p.get("f-room-derived").textContent, "work_1"); assert.equal(p.emitted.length, 0);
  data.leg.connected = false; p.state(data); p.get("retry").click(); assert.deepEqual(JSON.parse(JSON.stringify(p.emitted[0][1])), data.activeConfig);
});
test("standalone saved config applies once, malformed storage is harmless, edits survive locale changes", t => {
  const p = fixture(t); p.w.localStorage.setItem("tnd-hub-config", JSON.stringify({ url: "https://saved.example", token: "saved", room: "saved-room", nodeId: "saved-node" }));
  p.state({ configured: false, activeConfig: null, env: {}, leg: null, overall: null }); p.state({ configured: false, activeConfig: null, env: {}, leg: null, overall: null }); assert.equal(p.emitted.length, 1);
  input(p, "f-node", "edited"); p.w.dispatchEvent(new p.w.MessageEvent("message", { data: { type: "pnds:locale", version: 1, locale: "en" } })); assert.equal(p.get("f-node").value, "edited"); assert.equal(p.d.documentElement.lang, "en");
  submit(p, "connection-form"); assert.equal(p.emitted.at(-1)[1].nodeId, "edited");
});
test("manual correction supports legacy hubs, optional labels, zero coordinates, validation, clear and finite acknowledgement", t => {
  const p = fixture(t), data = sample(); data.leg.network.manualLocationSupported = false; p.state(data); assert.equal(p.get("location-editor").hidden, false);
  input(p, "location-latitude", ""); input(p, "location-longitude", "0"); submit(p, "location-form"); assert.equal(p.emitted.length, 0); assert.match(p.get("location-feedback").textContent, /有效纬度/);
  input(p, "location-label", ""); input(p, "location-latitude", "0"); submit(p, "location-form");
  const request = p.emitted.at(-1); assert.equal(request[0], events.setLocation); assert.deepEqual(JSON.parse(JSON.stringify(request[1])), { label: "", latitude: 0, longitude: 0 }); assert.equal(p.get("location-save").disabled, true);
  p.deliver("disconnect"); assert.equal(p.get("location-save").disabled, false); request[2]({ ok: true }); assert.match(p.get("location-feedback").textContent, /未能更新/);
  p.deliver("connect"); p.state(data);
  p.get("location-reset").click(); const reset = p.emitted.at(-1); assert.equal(reset[1], null); reset[2]({ ok: true }); assert.match(p.get("location-feedback").textContent, /已恢复/);
  submit(p, "location-form"); const timer = [...p.timers.values()].find(value => value.delay === 5000); assert.ok(timer); timer.fn(); assert.equal(p.get("location-save").disabled, false);
});
test("manual drafts stay during measurement but clear on node/room/url changes and ignore obsolete ack", t => {
  const p = fixture(t), data = sample(); p.state(data); input(p, "location-label", "a draft"); p.state(data); assert.equal(p.get("location-label").value, "a draft");
  submit(p, "location-form"); const request = p.emitted.at(-1); data.activeConfig.room = "different-room"; data.leg.network.location = null; p.state(data);
  assert.equal(p.get("location-label").value, ""); assert.equal(p.get("location-feedback").textContent, ""); request[2]({ ok: true }); assert.equal(p.get("location-feedback").textContent, "");
});
test("theme changes update all identity colors without rebuilding interaction or moving nodes", t => {
  const p = fixture(t, "?theme=pond"), data = sample(); p.state(data); const name = button(p, "北京大兴"), before = positions(p), bridge = require("../lib/theme-follow");
  for (const theme of ["sand", "stage", "brutal", "pond"]) {
    p.w.dispatchEvent(new p.w.MessageEvent("message", { data: { type: "pnds:theme", version: 1, theme, palette: bridge.THEME_PALETTES[theme] } }));
    assert.equal(p.d.documentElement.getAttribute("data-utility-theme"), theme); assert.equal(button(p, "北京大兴"), name); assert.deepEqual(positions(p), before);
  }
});

test("node-color slots survive active peers while departed names do not exhaust the palette", t => {
  const p = fixture(t), data = sample(), peer = structuredClone(data.leg.peers["北京大兴"]);
  data.leg.peers = { anchor: peer };
  p.state(data);
  const color = id => p.d.querySelector(`tr[data-row="${id}"]`).style.getPropertyValue("--node-color");
  const anchorColor = color("anchor"), ownColor = color("北京西城");
  for (let round = 0; round < 30; round++) {
    data.leg.peers = { anchor: peer, [`new-${round}-a`]: peer, [`new-${round}-b`]: peer };
    p.state(data);
    const colors = [...p.d.querySelectorAll("tr[data-row]")].map(row => row.style.getPropertyValue("--node-color"));
    assert.equal(new Set(colors).size, 4, `four active identities stay distinct after round ${round}`);
    assert.equal(color("anchor"), anchorColor); assert.equal(color("北京西城"), ownColor);
  }
});

test("a roster shrinking below five repairs old duplicate slots without recoloring unique survivors", t => {
  const p = fixture(t), data = sample(), peer = structuredClone(data.leg.peers["北京大兴"]);
  data.leg.peers = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`extra-${index}`, peer]));
  p.state(data);
  const before = new Map([...p.d.querySelectorAll("tr[data-row]")].map(row => [row.dataset.row, row.style.getPropertyValue("--node-color")]));
  const groups = new Map();
  for (const [id, color] of before) { if (!groups.has(color)) groups.set(color, []); groups.get(color).push(id); }
  const duplicate = [...groups.values()].find(ids => ids.length > 1), unique = [...groups.values()].find(ids => ids.length === 1)[0];
  const keep = new Set(["北京西城", ...duplicate, unique]);
  data.leg.peers = Object.fromEntries(Object.entries(data.leg.peers).filter(([id]) => keep.has(id)));
  p.state(data);
  const after = new Map([...p.d.querySelectorAll("tr[data-row]")].map(row => [row.dataset.row, row.style.getPropertyValue("--node-color")]));
  assert.ok(after.size <= 5); assert.equal(new Set(after.values()).size, after.size); assert.equal(after.get(unique), before.get(unique));
});

test("offline control submissions never emit or replay on observer reconnect", t => {
  const p = fixture(t), data = sample(); p.state(data); p.deliver("disconnect");
  const before = p.emitted.length;
  submit(p, "location-form"); assert.equal(p.emitted.length, before); assert.match(p.get("location-feedback").textContent, /未能更新/); assert.equal(p.get("location-save").disabled, false);
  p.get("location-reset").click(); submit(p, "connection-form"); p.get("retry").dispatchEvent(new p.w.MouseEvent("click"));
  assert.equal(p.emitted.length, before); assert.equal(p.get("b-connect").disabled, true); assert.equal(p.get("retry").disabled, true);
  p.deliver("connect"); submit(p, "location-form"); submit(p, "connection-form"); assert.equal(p.emitted.length, before, "a transport reconnect alone does not authorize stale controls");
  p.state(data); assert.equal(p.emitted.length, before, "fresh data does not replay rejected submissions");
});

test("observer disconnect keeps locations and selection but readings stay unconfirmed until fresh state", t => {
  const p = fixture(t), data = sample(); p.state(data); button(p, "北京大兴").click(); input(p, "f-node", "editing");
  const before = positions(p), mark = button(p, "北京大兴", ".map-mark");
  p.deliver("disconnect");
  assert.match(p.get("banner-title").textContent, /诊断数据连接中断/); assert.equal(p.get("banner").classList.contains("st-gray"), true);
  assert.equal(p.active(), "北京大兴"); assert.equal(p.get("detail-p50").textContent, "—"); assert.match(p.get("selected-summary").textContent, /待确认/); assert.deepEqual(positions(p), before); assert.equal(button(p, "北京大兴", ".map-mark"), mark);
  for (const row of p.d.querySelectorAll("tr[data-row]")) assert.equal(row.children[2].textContent, "—");
  p.deliver("connect"); assert.match(p.get("banner-title").textContent, /诊断数据连接中断/); assert.equal(p.get("detail-p50").textContent, "—"); assert.equal(p.get("b-connect").disabled, true);
  p.state(data); assert.match(p.get("banner-title").textContent, /公网链路稳定/); assert.equal(p.get("detail-p50").textContent, "15 ms"); assert.equal(p.active(), "北京大兴"); assert.equal(p.get("f-node").value, "editing"); assert.equal(p.get("b-connect").disabled, false); assert.deepEqual(positions(p), before);
});
