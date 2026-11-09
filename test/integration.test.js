// Real loopback transports around the score-server boundary. Each fixture
// gets its own copied project and OS-assigned ports; no App/dev server or
// public IP/location service is involved.
const assert = require("node:assert/strict");
const test = require("node:test");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { Server } = require("socket.io");
const { io } = require("socket.io-client");
const { events: EVENTS } = require("../public/shared");
const { findFreePort, stopProcess } = require("./helpers");

const PROJECT_ROOT = path.join(__dirname, "..");
const HUB_TOKEN = "integration-hub-token-0123456789";
const LOCATION = { label: "北京西城", latitude: 39.9123, longitude: 116.3658 };
const HUB_LOCATION = { label: "测试中继", latitude: 32.04, longitude: 118.77, source: "configured" };

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function scoreFixture(t, hubConfig = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), ".tnd-internet-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["server.js", "lib", "public"]) {
    fs.cpSync(path.join(PROJECT_ROOT, name), path.join(root, name), { recursive: true });
  }
  fs.symlinkSync(path.join(PROJECT_ROOT, "node_modules"), path.join(root, "node_modules"), "dir");
  const listeners = [];
  for (let index = 0; index < 2; index++) {
    const listener = net.createServer();
    await new Promise((resolve, reject) => {
      listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve);
    });
    listeners.push(listener);
  }
  const services = listeners.map((listener, index) => ({
    role: index ? "monitor" : "performer", fd: index + 3, port: listener.address().port,
  }));
  const performerPort = services[0].port, monitorPort = services[1].port;
  const manifest = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "manifest.json"), "utf8"));
  Object.assign(manifest.scoreServer, { performerPort, monitorPort });
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest));
  const env = {
    ...process.env,
    PNDS_HOST_IP: "127.0.0.1",
    PNDS_RUNTIME_PORTS: JSON.stringify({ version: 1, runId: "tnd-integration",
      reportPath: path.join(root, "bound.json"), services }),
    PNDS_HUB_URL: hubConfig.url || "",
    PNDS_HUB_TOKEN: hubConfig.token || "",
    PNDS_HUB_ROOM: hubConfig.room || "",
    PNDS_NODE_ID: hubConfig.nodeId || "",
  };
  delete env.PNDS_SHARED_LIBRARIES;
  const child = spawn(process.execPath, ["server.js", "--audio-mode", "none"], {
    cwd: root, env, stdio: ["ignore", "pipe", "pipe", ...listeners.map(listener => listener._handle.fd)],
  });
  await Promise.all(listeners.map(listener => new Promise(resolve => listener.close(resolve))));
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => { output = (output + chunk.toString()).slice(-4000); });
  }
  t.after(() => stopProcess(child));
  const performerUrl = `http://127.0.0.1:${performerPort}`;
  const monitorUrl = `http://127.0.0.1:${monitorPort}`;
  let health;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`score server exited: ${output}`);
    try {
      health = await (await fetch(`${performerUrl}/__pnds/health`)).json();
      if (health.status === "ready") break;
    } catch { /* The spawned server has not bound yet. */ }
    await delay(50);
  }
  assert.equal(health?.status, "ready", `score server did not become ready: ${output}`);
  return { child, performerUrl, monitorUrl, performerPort, monitorPort, health };
}

async function observer(t, url, options = {}) {
  const socket = io(url, { reconnection: false, timeout: 3000, ...options });
  let latest;
  const waiting = new Set();
  socket.on(EVENTS.state, (state) => {
    latest = state;
    for (const check of waiting) check(state);
  });
  t.after(() => socket.close());
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return {
    socket,
    state(predicate, timeoutMs = 12000) {
      if (latest && predicate(latest)) return Promise.resolve(latest);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(check);
          reject(new Error("diagnostic state timeout"));
        }, timeoutMs);
        const check = (state) => {
          if (!predicate(state)) return;
          waiting.delete(check);
          clearTimeout(timer);
          resolve(state);
        };
        waiting.add(check);
      });
    },
  };
}

// Freeze the old wire shape here. The demo HUB in hub/hub.js now has
// network metadata too, so spawning that source would no longer exercise
// a truly old relay even when its loopback address has no location.
async function legacyHub(t) {
  const httpServer = http.createServer();
  const relay = new Server(httpServer);
  relay.use((socket, next) => {
    if (socket.handshake.auth.token !== HUB_TOKEN) return next(new Error("invalid hub token"));
    next();
  });
  relay.on("connection", (socket) => {
    const { node, room = "default" } = socket.handshake.auth;
    const stamp = (body) => ({ ...body, from: node, hubReceivedAt: Date.now() });
    socket.join(room);
    socket.emit("welcome", { room, node, hubTime: Date.now() });
    socket.on("echo", (body) => socket.emit("echo", stamp(body)));
    socket.on("relay", (body) => socket.to(room).emit("relay", stamp(body)));
    // No network metadata, location command, or location acknowledgement.
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  let closing;
  const close = () => closing ||= new Promise((resolve) => relay.close(resolve));
  t.after(close);
  return { close, url: `http://127.0.0.1:${httpServer.address().port}` };
}

// The extended HUB wire contract over a real Socket.IO/HTTP connection.
// This fixture deliberately supplies fixed data, not an IP lookup. The
// standalone legacy HUB above separately guards compatibility.
async function networkHub(t) {
  const httpServer = http.createServer();
  const relay = new Server(httpServer);
  let joins = 0;
  let corrections = 0;
  relay.use((socket, next) => {
    if (socket.handshake.auth.token !== HUB_TOKEN) return next(new Error("invalid hub token"));
    next();
  });
  relay.on("connection", (socket) => {
    joins += 1;
    const { node, room = "default" } = socket.handshake.auth;
    const ip = "203.0.113.12";
    const automatic = { label: "测试城市", latitude: 40, longitude: 116, source: "ip" };
    let location = automatic;
    const network = () => ({ ip, location, hubLocation: HUB_LOCATION, manualLocationSupported: true });
    socket.join(room);
    socket.emit("welcome", { room, node, hubTime: Date.now(), network: network() });
    socket.on("echo", (body) => socket.emit("echo", { ...body, from: node, hubReceivedAt: Date.now() }));
    socket.on("relay", (body) => socket.to(room).emit("relay", {
      ...body, from: node, hubReceivedAt: Date.now(), network: network(),
    }));
    socket.on("location", (value, acknowledge) => {
      corrections += 1;
      location = value === null ? automatic : { ...value, source: "manual" };
      socket.emit("network", network());
      if (typeof acknowledge === "function") acknowledge({ ok: true });
    });
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => relay.close(resolve)));
  return {
    url: `http://127.0.0.1:${httpServer.address().port}`,
    get joins() { return joins; },
    get corrections() { return corrections; },
    dropTransport() { for (const socket of relay.sockets.sockets.values()) socket.conn.close(); },
    disconnectAll() { relay.disconnectSockets(true); },
  };
}

function setLocation(socket, value) {
  return new Promise((resolve, reject) => {
    socket.timeout(2000).emit(EVENTS.setLocation, value, (error, result) => {
      if (error) reject(error); else resolve(result);
    });
  });
}

test("internet-only: both HTTP entries keep health/theme/locale/shared assets; observers never join or get local probes", async (t) => {
  const fixture = await scoreFixture(t);
  assert.equal(fixture.health.projectId, "telematic-network-diagnostics");
  assert.equal(fixture.health.audioMode, "none");
  assert.equal(fixture.health.audio.status, "disabled");
  assert.equal(fixture.health.audio.target, null);
  assert.equal(fixture.health.scoreServer.performerPort, fixture.performerPort);
  assert.equal(fixture.health.scoreServer.monitorPort, fixture.monitorPort);
  for (const url of [fixture.performerUrl, fixture.monitorUrl]) {
    const html = await (await fetch(url)).text();
    assert.match(html, /Telematic/);
    assert.match(html, /monitor\.js/);
    assert.doesNotMatch(html, /performer\.js/);
    assert.equal((await fetch(`${url}/__pnds/health`)).status, 200);
    assert.match(await (await fetch(`${url}/__pnds/theme-follow.js`)).text(), /PNDS_THEME/);
    assert.match(await (await fetch(`${url}/__pnds/locale-follow.js`)).text(), /PNDS_LOCALE/);
    assert.equal((await fetch(`${url}/__pnds/shared/socket.io.js`)).status, 200);
    assert.match(await (await fetch(`${url}/__config.js`)).text(), new RegExp(String(fixture.performerPort)));
    assert.equal((await fetch(`${url}/qr`)).status, 404);
  }
  const page = await observer(t, fixture.performerUrl);
  const idle = await page.state((state) => !state.configured);
  assert.deepEqual(Object.keys(idle).sort(), ["activeConfig", "configured", "env", "leg", "overall"]);
  assert.equal(idle.leg, null);
  assert.equal(idle.overall, null);
  assert.equal(idle.activeConfig, null);
  assert.deepEqual(await setLocation(page.socket, LOCATION), { ok: false, error: "notConfigured" });
  const localTraffic = [];
  for (const event of ["probe", "joined", "removed", "rejected"]) {
    page.socket.on(event, () => localTraffic.push(event));
  }
  page.socket.emit("join", { token: "obsolete-phone-token" });
  page.socket.emit("ack", { seq: 1, t0: 1, t1: 2 });
  page.socket.emit("remove", { id: 1 });
  page.socket.emit("leave");
  await delay(2200);
  assert.deepEqual(localTraffic, []);
  assert.equal(page.socket.connected, true, "obsolete performer messages have no effect on an observer");
});

test("legacy HUB: env auto-connect, live internet measurements, two-node relay without geolocation", async (t) => {
  const hub = await legacyHub(t);
  const config = { url: hub.url, token: HUB_TOKEN, room: "rehearsal", nodeId: "node-a" };
  const a = await scoreFixture(t, config);
  const b = await scoreFixture(t, { ...config, nodeId: "node-b" });
  const pageA = await observer(t, a.performerUrl);
  const pageB = await observer(t, b.performerUrl);
  const state = await pageA.state((value) => value.leg?.summary?.samples >= 5 && value.leg.peers["node-b"]?.summary?.samples >= 5);
  assert.deepEqual(state.activeConfig, config);
  assert.equal(state.env.hubRoom, "rehearsal");
  assert.equal(state.leg.status, "green");
  assert.equal(state.overall.status, "green");
  assert.equal(state.overall.attributionLeg, "hub");
  assert.ok(state.leg.summary.rttP50 >= 0);
  assert.ok(state.leg.summary.rttP95 >= state.leg.summary.rttP50);
  assert.equal(state.leg.summary.oneWayEstimateMs, Math.round(state.leg.summary.rttP50 / 2 * 10) / 10);
  assert.equal(state.local, undefined);
  assert.equal(state.leg.local, undefined);
  assert.equal(state.leg.peers["node-b"].local, undefined);
  assert.equal(state.leg.network?.manualLocationSupported, false, "legacy welcome omits the extended capability");
  assert.equal(state.leg.network?.location ?? null, null, "old HUB cannot invent IP coordinates");
  assert.equal(state.leg.network?.hubLocation ?? null, null);
  assert.equal(state.leg.peers["node-b"].network?.location ?? null, null);
  await pageB.state((value) => value.leg?.peers["node-a"]?.connected);
  const connectedEvents = state.leg.events.filter((event) => event.type === "connected").map((event) => event.at);
  pageA.socket.emit(EVENTS.hubConfig, config);
  const later = await pageA.state((value) => value.leg?.summary?.samples > state.leg.summary.samples + 5);
  assert.deepEqual(later.leg.events.filter((event) => event.type === "connected").map((event) => event.at), connectedEvents);
});

test("configuration: standalone form replaces defaults and invalid-token retry reconnects without losing identity", async (t) => {
  const hub = await networkHub(t);
  const fixture = await scoreFixture(t);
  const page = await observer(t, fixture.performerUrl);
  await page.state((value) => !value.configured);
  const config = { url: hub.url, token: "wrong-token", room: "manual", nodeId: "manual-node" };
  page.socket.emit(EVENTS.hubConfig, config);
  const refused = await page.state((value) => value.leg?.reason === "invalidToken");
  assert.equal(refused.leg.everConnected, false);
  assert.equal(refused.overall.status, "red");
  const failedAt = refused.leg.events.filter((event) => event.type === "connect failed").at(-1).at;
  page.socket.emit(EVENTS.hubConfig, config);
  await page.state((value) => value.leg?.events.some((event) => event.type === "connect failed" && event.at > failedAt));
  page.socket.emit(EVENTS.hubConfig, { ...config, token: HUB_TOKEN });
  const connected = await page.state((value) => value.leg?.connected && value.activeConfig.token === HUB_TOKEN);
  assert.equal(connected.activeConfig.nodeId, "manual-node");
  assert.equal(connected.activeConfig.room, "manual");
  assert.deepEqual(await setLocation(page.socket, LOCATION), { ok: true });
  await page.state((value) => value.leg?.network?.location?.source === "manual");
  const correctionsBefore = hub.corrections;
  hub.dropTransport();
  await page.state((value) => value.leg && !value.leg.connected);
  const reconnected = await page.state((value) => value.leg?.connected && hub.corrections > correctionsBefore);
  assert.equal(reconnected.leg.network.location.label, LOCATION.label, "automatic reconnect resends the correction to HUB");
  hub.disconnectAll();
  await page.state((value) => value.leg && !value.leg.connected);
  page.socket.emit(EVENTS.hubConfig, { ...config, token: HUB_TOKEN });
  const retried = await page.state((value) => value.leg?.connected && value.leg.network?.location?.source === "manual");
  assert.equal(retried.leg.network.location.label, LOCATION.label, "same-node explicit retry keeps this session's correction");
  page.socket.emit(EVENTS.hubConfig, { ...config, token: HUB_TOKEN, nodeId: "renamed-node" });
  const renamed = await page.state((value) => value.activeConfig?.nodeId === "renamed-node" && value.leg?.connected && value.leg.network?.location?.source === "ip");
  assert.equal(renamed.leg.network.location.label, "测试城市", "a new node identity does not inherit a correction");
});

test("location: validate, share manual correction with peers, clear it, and keep HUB coordinates authoritative", async (t) => {
  assert.equal(EVENTS.setLocation, "set-location");
  const hub = await networkHub(t);
  const config = { url: hub.url, token: HUB_TOKEN, room: "geo", nodeId: "node-a" };
  const a = await scoreFixture(t, config);
  const b = await scoreFixture(t, { ...config, nodeId: "node-b" });
  const pageA = await observer(t, a.performerUrl);
  const pageB = await observer(t, b.performerUrl);
  await pageA.state((value) => value.leg?.network?.manualLocationSupported);
  for (const invalid of [{}, { ...LOCATION, latitude: 91 }, { ...LOCATION, longitude: "116" }, []]) {
    assert.deepEqual(await setLocation(pageA.socket, invalid), { ok: false, error: "invalidLocation" });
  }
  assert.deepEqual(await setLocation(pageA.socket, { latitude: 0, longitude: 0 }), { ok: true });
  const zero = await pageA.state((value) => value.leg?.network?.location?.source === "manual" && value.leg.network.location.latitude === 0);
  assert.equal(zero.leg.network.location.longitude, 0, "unlabeled zero coordinates are valid");
  assert.deepEqual(await setLocation(pageA.socket, LOCATION), { ok: true });
  const own = await pageA.state((value) => value.leg?.network?.location?.source === "manual");
  assert.equal(own.leg.network.location.latitude, LOCATION.latitude);
  assert.equal(own.leg.network.location.label, LOCATION.label);
  assert.equal(own.leg.network.hubLocation.label, HUB_LOCATION.label);
  const peer = await pageB.state((value) => value.leg?.peers["node-a"]?.network?.location?.source === "manual");
  assert.equal(peer.leg.peers["node-a"].network.location.longitude, LOCATION.longitude);
  assert.deepEqual(await setLocation(pageA.socket, null), { ok: true });
  const restored = await pageA.state((value) => value.leg?.network?.location?.source === "ip");
  assert.equal(restored.leg.network.location.label, "测试城市");
  assert.equal(restored.leg.network.hubLocation.latitude, HUB_LOCATION.latitude);
  await pageB.state((value) => value.leg?.peers["node-a"]?.network?.location?.source === "ip");
});

test("HUB outage: own transport fails while the retained remote state becomes unknown", async (t) => {
  const hub = await legacyHub(t);
  const config = { url: hub.url, token: HUB_TOKEN, room: "outage", nodeId: "node-a" };
  const a = await scoreFixture(t, config);
  const b = await scoreFixture(t, { ...config, nodeId: "node-b" });
  const pageA = await observer(t, a.performerUrl);
  await pageA.state((value) => value.leg?.peers["node-b"]?.connected && value.leg.summary.samples >= 5);
  await hub.close();
  const down = await pageA.state((value) => value.leg && !value.leg.connected && value.leg.peers["node-b"]?.status === "gray");
  assert.equal(down.leg.reason, "transport");
  assert.equal(down.overall.status, "red");
  assert.equal(down.overall.attributionNodeId, "node-a");
  assert.equal(down.leg.summary.rttP50, null, "historical RTT is not presented as a live reading");
  assert.equal(down.leg.peers["node-b"].summary, null);
});

test("shutdown: both HTTP listeners close promptly with WebSocket, polling and keep-alive observers", async (t) => {
  const fixture = await scoreFixture(t);
  await observer(t, fixture.performerUrl, { transports: ["websocket"] });
  await observer(t, fixture.performerUrl, { transports: ["polling"] });
  const raw = [];
  t.after(() => raw.forEach((socket) => socket.destroy()));
  for (const port of [fixture.performerPort, fixture.monitorPort]) {
    const socket = net.connect({ port, host: "127.0.0.1" });
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n");
    raw.push(socket);
  }
  const startedAt = Date.now();
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("score server exceeded 2 s shutdown budget")), 2000);
    fixture.child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
  fixture.child.kill("SIGTERM");
  assert.equal(await exited, 0);
  assert.ok(Date.now() - startedAt < 1500);
});
