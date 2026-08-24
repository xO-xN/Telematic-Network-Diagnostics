// Score-server smoke test (issue #2): the de-templatized server comes
// up as Telematic Network Diagnostics — health ready with audio
// disabled, both pages served, the theme bridge and QR on the monitor
// port only.

const assert = require("node:assert/strict");
const test = require("node:test");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { io } = require("socket.io-client");
const { events: EVENTS } = require("../public/shared");
const {
  findFreePort,
  waitForPort,
  spawnHub,
  stopProcess,
  assertPortsFree,
} = require("./helpers");

const PROJECT_ROOT = path.join(__dirname, "..");
const PERFORMER_URL = "http://127.0.0.1:6868";
const MONITOR_URL = "http://127.0.0.1:6869";
const HEALTH_URL = `${PERFORMER_URL}/__pnds/health`;
const HUB_TOKEN = "integration-hub-token-0123456789";

function waitForHealthAt(healthUrl) {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    const tick = async () => {
      attempts += 1;

      try {
        const response = await fetch(healthUrl);
        const payload = await response.json();

        if (payload.status === "ready") {
          resolve(payload);
          return;
        }
      } catch {
        // server not up yet
      }

      if (attempts >= 40) {
        reject(new Error("server never reported health ready"));
        return;
      }

      setTimeout(tick, 250);
    };

    tick();
  });
}

function waitForHealthReady() {
  return waitForHealthAt(HEALTH_URL);
}



test("score server: TND identity, health ready, pages + theme bridge served", async (t) => {
  await assertPortsFree([6868, 6869]);

  const server = spawn(process.execPath, ["server.js", "--audio-mode", "none"], {
    cwd: PROJECT_ROOT,
    stdio: "ignore",
  });

  t.after(async () => stopProcess(server));

  // --- health: ready, none-only audio, TND identity, 6868/6869 ---
  const health = await waitForHealthReady();

  assert.equal(health.projectId, "telematic-network-diagnostics");
  assert.equal(health.audioMode, "none");
  assert.equal(health.audio.status, "disabled", "no-audio project reports disabled");
  assert.equal(health.audio.target, null);
  assert.equal(health.scoreServer.performerPort, 6868);
  assert.equal(health.scoreServer.monitorPort, 6869);

  // --- pages served on both ports, carrying the TND identity ---
  const performerHtml = await (await fetch(`${PERFORMER_URL}/`)).text();
  const monitorHtml = await (await fetch(`${MONITOR_URL}/`)).text();

  assert.match(performerHtml, /Telematic Network Diagnostics/);
  assert.match(monitorHtml, /Telematic Network Diagnostics/);
  // The dual-role page picks its branch at runtime by port; the source
  // wires both branches (performer.js and monitor.js document.writes).
  assert.match(performerHtml, /performer\.js/);
  assert.match(monitorHtml, /monitor\.js/);
  // Both ports serve the same dual-role page; the theme bridge is wired
  // in its monitor branch, and the route itself is monitor-port only
  // (404 on the performer port — asserted below).

  // --- the theme bridge itself is served (monitor port only) ---
  const themeResponse = await fetch(`${MONITOR_URL}/__pnds/theme-follow.js`);
  const themeJs = await themeResponse.text();

  assert.equal(themeResponse.status, 200);
  assert.match(themeJs, /PNDS_THEME/);

  const performerThemeResponse = await fetch(
    `${PERFORMER_URL}/__pnds/theme-follow.js`,
  );
  assert.equal(performerThemeResponse.status, 404);

  // --- the QR endpoint answers on the monitor port (performer: 404) ---
  const qrResponse = await fetch(`${MONITOR_URL}/qr`);

  assert.equal(qrResponse.status, 200);
  assert.equal(qrResponse.headers.get("content-type"), "image/png");

  const performerQrResponse = await fetch(`${PERFORMER_URL}/qr`);
  assert.equal(performerQrResponse.status, 404);
});

// ------------------------------------------------------------
// Hub leg end to end (issue #3): the two-terminal demo as a test —
// a real hub subprocess + the score server pointed at it through the
// env channel, driven from a fake monitor page over Socket.IO.
// ------------------------------------------------------------

// A fake monitor page: one socket to the score server, collecting the
// 1 Hz hub:state broadcasts until one satisfies the predicate.
function connectMonitor() {
  return new Promise((resolve, reject) => {
    const socket = io(PERFORMER_URL, { reconnection: false, timeout: 5000 });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("monitor connect timeout"));
    }, 5000);

    socket.on("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.on("connect_error", (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
  });
}

function waitForHubState(socket, predicate, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(EVENTS.hubState, onState);
      reject(new Error("hub:state timeout"));
    }, timeoutMs);

    const onState = (state) => {
      if (predicate(state)) {
        clearTimeout(timer);
        socket.off(EVENTS.hubState, onState);
        resolve(state);
      }
    };

    socket.on(EVENTS.hubState, onState);
  });
}

test("hub leg: env auto-connect, live stats, burst, disconnect/reconnect, form channel", async (t) => {
  await assertPortsFree([6868, 6869]);

  const hubPort = await findFreePort();
  const hub = spawnHub(hubPort, { token: HUB_TOKEN });
  t.after(() => stopProcess(hub));
  await waitForPort(hubPort);

  const server = spawn(process.execPath, ["server.js"], {
    cwd: PROJECT_ROOT,
    stdio: "ignore",
    env: {
      ...process.env,
      PNDS_HUB_URL: `http://127.0.0.1:${hubPort}`,
      PNDS_HUB_TOKEN: HUB_TOKEN,
      PNDS_HUB_ROOM: "rehearsal",
      PNDS_NODE_ID: "site-test",
    },
  });
  t.after(async () => stopProcess(server));

  await waitForHealthReady();

  const monitor = await connectMonitor();
  t.after(() => monitor.close());

  // --- env channel: the server connected to the hub at boot ---
  const connected = await waitForHubState(
    monitor,
    (state) => state.configured && state.leg && state.leg.connected,
  );

  assert.equal(connected.config.room, "rehearsal");
  assert.equal(connected.config.nodeId, "site-test");
  assert.equal(connected.config.tokenSet, true);
  assert.ok(connected.env.hubUrl.includes(`:${hubPort}`), "env is delivered for the form prefill");
  assert.ok(
    connected.leg.events.some((event) => event.type === "connected"),
    "the connect is in the event log",
  );

  // --- live numbers appear on their own (auto-started, no button) ---
  const measured = await waitForHubState(
    monitor,
    (state) =>
      state.leg &&
      state.leg.summary.samples >= 5 &&
      typeof state.leg.summary.rttP50 === "number" &&
      state.leg.summary.rttP50 >= 0,
  );

  assert.ok(measured.leg.summary.rttP95 >= measured.leg.summary.rttP50);
  assert.ok(
    Math.abs(
      measured.leg.summary.oneWayEstimateMs - measured.leg.summary.rttP50 / 2,
    ) < 0.6,
    "one-way estimate is RTT p50 / 2",
  );
  assert.equal(measured.leg.status, "green", "loopback-stable link is green");

  // --- automatic phase cycle: burst ↔ calm, the window keeps rolling ---
  // No manual trigger — the cycle runs with the connection (LND's
  // shape: it starts in burst, then alternates). Wait for a burst
  // phase, then a calm phase, then another burst, and check the
  // samples kept flowing throughout.
  await waitForHubState(
    monitor,
    (state) => state.leg && state.leg.probing === "burst",
  );

  const samplesBefore = measured.leg.summary.samples;

  await waitForHubState(
    monitor,
    (state) => state.leg && state.leg.probing === "calm",
  );
  await waitForHubState(
    monitor,
    (state) => state.leg && state.leg.probing === "burst",
  );

  const afterCycles = await waitForHubState(
    monitor,
    (state) => state.leg && state.leg.summary.samples >= samplesBefore + 40,
    15000,
  );

  assert.ok(
    afterCycles.leg.summary.samples >= samplesBefore + 40,
    `the cycles kept the window rolling: ${samplesBefore} → ${afterCycles.leg.summary.samples}`,
  );

  // --- the hub drops: red at once, with an event ---
  await stopProcess(hub);

  const down = await waitForHubState(
    monitor,
    (state) => state.leg && !state.leg.connected && state.leg.status === "red",
    8000,
  );

  assert.match(down.leg.reason, /unreachable/i);
  assert.ok(
    down.leg.events.some((event) => event.type === "disconnected"),
    "the disconnect is in the event log",
  );

  // --- the hub comes back: auto-reconnect and the stats resume ---
  const hubAgain = spawnHub(hubPort, { token: HUB_TOKEN });
  t.after(() => stopProcess(hubAgain));

  const up = await waitForHubState(
    monitor,
    (state) =>
      state.leg &&
      state.leg.connected &&
      state.leg.summary.reconnects >= 1 &&
      state.leg.events.some((event) => event.type === "reconnected"),
    15000,
  );

  assert.equal(up.leg.status, "yellow", "one reconnect keeps the window yellow");
  assert.match(up.leg.reason, /1 reconnect/i);

  // --- the form channel replaces the env channel ---
  monitor.emit(EVENTS.hubConfig, {
    url: `http://127.0.0.1:${hubPort}`,
    token: HUB_TOKEN,
    room: "rehearsal",
    nodeId: "site-renamed",
  });

  const renamed = await waitForHubState(
    monitor,
    (state) =>
      state.config && state.config.nodeId === "site-renamed" && state.leg.connected,
  );

  assert.equal(renamed.config.nodeId, "site-renamed");

  // --- the monitor page itself: persistence + env prefill wiring ---
  const monitorHtml = await (await fetch(`${MONITOR_URL}/`)).text();
  assert.match(monitorHtml, /monitor\.js/);

  const monitorJs = await (await fetch(`${MONITOR_URL}/monitor.js`)).text();
  assert.match(monitorJs, /localStorage/, "the form persists to localStorage");
  assert.match(monitorJs, /storageKeys/, "storage key comes from shared.js");
  assert.match(monitorJs, /autoConfig/, "auto-start uses the loaded config");
  assert.match(monitorJs, /state\.env/, "env prefill is wired");
});

// ------------------------------------------------------------
// Flower view end to end (issue #4): two project instances + hub.
// The second instance is a real copy of the project with its own
// manifest ports — literally "two deployments on one machine", the
// same shape as two sites in production.
// ------------------------------------------------------------

const SITE_B_PERFORMER = 16868;
const SITE_B_MONITOR = 16869;

async function makeSecondInstance() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tnd-site-"));

  await fs.promises.cp(PROJECT_ROOT, dir, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(PROJECT_ROOT, source);

      return (
        relative === "" ||
        !(relative === "node_modules" || relative.startsWith("node_modules/") ||
          relative === ".git" || relative.startsWith(".git/"))
      );
    },
  });

  const manifestPath = path.join(dir, "manifest.json");
  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));

  manifest.scoreServer.performerPort = SITE_B_PERFORMER;
  manifest.scoreServer.monitorPort = SITE_B_MONITOR;
  await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  // Dependencies resolve through the real install (a copy would be
  // 50+ MB for nothing).
  await fs.promises.symlink(
    path.join(PROJECT_ROOT, "node_modules"),
    path.join(dir, "node_modules"),
    "dir",
  );

  return dir;
}

function spawnServer(cwd, { nodeId, hubPort }) {
  return spawn(process.execPath, ["server.js"], {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      PNDS_HUB_URL: `http://127.0.0.1:${hubPort}`,
      PNDS_HUB_TOKEN: HUB_TOKEN,
      PNDS_HUB_ROOM: "rehearsal",
      PNDS_NODE_ID: nodeId,
    },
  });
}

function connectMonitorAt(url) {
  return new Promise((resolve, reject) => {
    const socket = io(url, { reconnection: false, timeout: 5000 });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("monitor connect timeout"));
    }, 5000);

    socket.on("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.on("connect_error", (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
  });
}

test("flower view: two instances see each other, overall follows the worst node", async (t) => {
  await assertPortsFree([6868, 6869, SITE_B_PERFORMER, SITE_B_MONITOR]);

  const hubPort = await findFreePort();
  const hub = spawnHub(hubPort, { token: HUB_TOKEN });
  t.after(() => stopProcess(hub));
  await waitForPort(hubPort);

  const siteBDir = await makeSecondInstance();
  t.after(async () => fs.promises.rm(siteBDir, { recursive: true, force: true }));

  const serverA = spawnServer(PROJECT_ROOT, { nodeId: "site-a", hubPort });
  t.after(async () => stopProcess(serverA));

  let serverB = spawnServer(siteBDir, { nodeId: "site-b", hubPort });
  t.after(async () => stopProcess(serverB));

  await waitForHealthAt(HEALTH_URL);
  await waitForHealthAt(`http://127.0.0.1:${SITE_B_PERFORMER}/__pnds/health`);

  const monitorA = await connectMonitorAt(PERFORMER_URL);
  const monitorB = await connectMonitorAt(`http://127.0.0.1:${SITE_B_PERFORMER}`);
  t.after(() => monitorA.close());
  t.after(() => monitorB.close());

  // --- both monitors see BOTH nodes, overall green ---
  const green = waitForHubState(
    monitorA,
    (state) =>
      state.leg &&
      state.leg.peers["site-b"] &&
      state.leg.peers["site-b"].connected &&
      state.overall &&
      state.overall.status === "green",
    25000,
  );
  const greenB = waitForHubState(
    monitorB,
    (state) =>
      state.leg &&
      state.leg.peers["site-a"] &&
      state.leg.peers["site-a"].connected &&
      state.overall &&
      state.overall.status === "green",
    25000,
  );

  const [stateA, stateB] = await Promise.all([green, greenB]);

  // The relayed stats carry the peer's live numbers (the derived
  // site-pair sums them in the page).
  assert.equal(typeof stateA.leg.peers["site-b"].summary.rttP50, "number");
  assert.equal(typeof stateB.leg.peers["site-a"].summary.rttP50, "number");
  assert.equal(stateA.leg.peers["site-b"].performerCount, 0, "no performer data until #5");
  assert.equal(stateA.leg.peers["site-b"].localWorst, null, "no local data until #5");
  assert.equal(stateA.overall.attributionNodeId, stateA.config.nodeId);

  // --- one side drops: the other side's overall turns red, attributed ---
  await stopProcess(serverB);

  const down = await waitForHubState(
    monitorA,
    (state) =>
      state.leg &&
      state.leg.peers["site-b"] &&
      !state.leg.peers["site-b"].connected &&
      state.overall &&
      state.overall.status === "red",
    20000,
  );

  assert.equal(down.overall.attributionNodeId, "site-b");
  assert.equal(down.overall.attributionSelf, false);

  // --- it comes back: the network returns to green ---
  serverB = spawnServer(siteBDir, { nodeId: "site-b", hubPort });

  await waitForHubState(
    monitorA,
    (state) =>
      state.leg &&
      state.leg.peers["site-b"] &&
      state.leg.peers["site-b"].connected &&
      state.overall &&
      state.overall.status === "green",
    25000,
  );
});
