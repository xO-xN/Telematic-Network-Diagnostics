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
// 1 Hz state broadcasts until one satisfies the predicate.
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

function waitForState(socket, predicate, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(EVENTS.state, onState);
      reject(new Error("state timeout"));
    }, timeoutMs);

    const onState = (state) => {
      if (predicate(state)) {
        clearTimeout(timer);
        socket.off(EVENTS.state, onState);
        resolve(state);
      }
    };

    socket.on(EVENTS.state, onState);
  });
}

// A fake performer page: joins with the (optional) claim token and
// answers every probe immediately — the phone in the demo, as a test.
// Resolves { socket, joined } once the server hands back the id.
function connectPerformerAt(url, token = null) {
  return new Promise((resolve, reject) => {
    const socket = io(url, { reconnection: false, timeout: 5000 });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("performer connect timeout"));
    }, 5000);

    socket.on("connect", () => {
      socket.emit(EVENTS.join, { token });
    });

    socket.on(EVENTS.rejected, (data) => {
      clearTimeout(timer);
      socket.close();
      reject(new Error("join rejected: " + (data && data.reason)));
    });

    socket.on(EVENTS.joined, (data) => {
      clearTimeout(timer);
      socket.on(EVENTS.probe, (payload) => {
        // t0/t1 are processing timestamps only; the RTT is measured
        // server-side, so constants are fine here.
        socket.emit(EVENTS.ack, {
          seq: payload && payload.seq,
          t0: 1,
          t1: 2,
        });
      });
      resolve({ socket, joined: data });
    });

    socket.on("connect_error", (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
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
  const connected = await waitForState(
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
  const measured = await waitForState(
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
  await waitForState(
    monitor,
    (state) => state.leg && state.leg.probing === "burst",
  );

  const samplesBefore = measured.leg.summary.samples;

  await waitForState(
    monitor,
    (state) => state.leg && state.leg.probing === "calm",
  );
  await waitForState(
    monitor,
    (state) => state.leg && state.leg.probing === "burst",
  );

  const afterCycles = await waitForState(
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

  const down = await waitForState(
    monitor,
    (state) => state.leg && !state.leg.connected && state.leg.status === "red",
    8000,
  );

  assert.equal(down.leg.reason, "unreachable");
  assert.ok(
    down.leg.events.some((event) => event.type === "disconnected"),
    "the disconnect is in the event log",
  );

  // --- the hub comes back: auto-reconnect and the stats resume ---
  const hubAgain = spawnHub(hubPort, { token: HUB_TOKEN });
  t.after(() => stopProcess(hubAgain));

  const up = await waitForState(
    monitor,
    (state) =>
      state.leg &&
      state.leg.connected &&
      state.leg.summary.reconnects >= 1 &&
      state.leg.events.some((event) => event.type === "reconnected"),
    15000,
  );

  assert.equal(up.leg.status, "yellow", "one reconnect keeps the window yellow");
  assert.equal(up.leg.reason, "reconnectYellow");

  // --- the form channel replaces the env channel ---
  monitor.emit(EVENTS.hubConfig, {
    url: `http://127.0.0.1:${hubPort}`,
    token: HUB_TOKEN,
    room: "rehearsal",
    nodeId: "site-renamed",
  });

  const renamed = await waitForState(
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
// Local leg end to end (issue #5): the phone demo as a test — no
// hub configured at all. A fake performer page joins, is probed
// automatically (baseline + the alternating burst), goes green, drops
// to Red the moment its socket dies, and recovers through the claim
// token.
// ------------------------------------------------------------

test("local leg: join → auto-probed → green → disconnect red → token reconnect", async (t) => {
  await assertPortsFree([6868, 6869]);

  const server = spawn(process.execPath, ["server.js"], {
    cwd: PROJECT_ROOT,
    stdio: "ignore",
  });
  t.after(async () => stopProcess(server));

  await waitForHealthReady();

  const monitor = await connectMonitor();
  t.after(() => monitor.close());

  // --- no hub: the hub leg is absent, the local panel is live ---
  const idle = await waitForState(
    monitor,
    (state) => state.configured === false && state.leg === null && state.local,
  );

  assert.equal(idle.overall, null, "no flower verdict without a hub");
  assert.equal(idle.local.status, null, "no performer yet → no local data");
  assert.equal(idle.local.performers, 0);
  assert.deepEqual(idle.local.clients, {});

  // --- the phone joins: zero actions, measurement starts on its own ---
  const performer = await connectPerformerAt(PERFORMER_URL);
  t.after(() => performer.socket.close());

  assert.equal(performer.joined.id, 1);
  assert.equal(performer.joined.recovered, false);
  assert.equal(typeof performer.joined.token, "string");

  const joined = await waitForState(
    monitor,
    (state) => state.local.clients["1"] && state.local.clients["1"].connected,
  );

  assert.equal(joined.local.performers, 1);
  assert.equal(joined.local.status, "gray", "warming up first");
  assert.ok(
    joined.local.clients["1"].events.some((event) => event.type === "connected"),
    "the join is in the event log",
  );

  // --- live numbers appear (auto-probed, baseline + burst) ---
  const measured = await waitForState(
    monitor,
    (state) =>
      state.local.clients["1"] &&
      state.local.clients["1"].status === "green" &&
      typeof state.local.clients["1"].metrics.rttP50 === "number" &&
      state.local.status === "green" &&
      typeof state.local.p50 === "number",
    20000,
  );

  const metrics = measured.local.clients["1"].metrics;

  assert.ok(metrics.rttP95 >= metrics.rttP50);
  // Green is load-scoped: it legitimately arrives within the first burst
  // window (~30 probes/s), so "measurement is underway" means a partial
  // burst of acks, not a full lifetime count.
  assert.ok(metrics.acks >= 10, `many probes answered: ${metrics.acks}`);

  // --- the automatic phase cycle keeps alternating (LND parity) ---
  await waitForState(monitor, (state) => state.local.probing === "burst");
  await waitForState(monitor, (state) => state.local.probing === "calm");

  // --- the phone drops (Wi-Fi off): Red at once, with an event ---
  performer.socket.close();

  const down = await waitForState(
    monitor,
    (state) =>
      state.local.clients["1"] &&
      !state.local.clients["1"].connected &&
      state.local.clients["1"].status === "red",
    8000,
  );

  assert.equal(down.local.status, "red", "the SITE summary includes the disconnected performer");
  assert.equal(down.local.performers, 0);
  assert.equal(down.local.clients["1"].reason, "disconnected");
  assert.equal(down.local.clients["1"].lastEvent.type, "disconnected");

  // --- the phone comes back with its claim token: same id, recovery ---
  // The registry freed the binding on the clean disconnect, so the
  // rejoin is a fresh "accepted" — but the SMALLEST free id and the
  // SAME token come back, and the session (which kept the card) logs
  // it as a reconnect (LND's exact semantics).
  const rejoined = await connectPerformerAt(PERFORMER_URL, performer.joined.token);
  t.after(() => rejoined.socket.close());

  assert.equal(rejoined.joined.id, 1, "the id is back (smallest free)");
  assert.equal(rejoined.joined.token, performer.joined.token, "the claim token persists");

  const recovered = await waitForState(
    monitor,
    (state) =>
      state.local.clients["1"] &&
      state.local.clients["1"].connected &&
      state.local.clients["1"].events.some((event) => event.type === "reconnected"),
    8000,
  );

  assert.equal(recovered.local.clients["1"].status, "gray", "back through warm-up");

  await waitForState(
    monitor,
    (state) => state.local.status === "green",
    20000,
  );

  // --- the two pages: the performer page carries the two-dot wiring,
  // the monitor renders the local panel (source-level wiring) ---
  const performerJs = await (await fetch(`${PERFORMER_URL}/performer.js`)).text();
  assert.match(performerJs, /P\.events\.join/, "joins automatically");
  assert.match(performerJs, /P\.events\.probe/, "answers probes");
  assert.match(performerJs, /P\.events\.ack/, "acks with t0/t1");
  assert.match(performerJs, /row-local/, "the local-leg dot");
  assert.match(performerJs, /row-hub/, "the hub-leg dot");
  assert.doesNotMatch(performerJs, /peers/, "no cross-site details on the performer page");

  const monitorJs = await (await fetch(`${MONITOR_URL}/monitor.js`)).text();
  assert.match(monitorJs, /renderLocal/, "the local panel renders");
  assert.match(monitorJs, /localStatus/, "local-leg copy comes from shared.js's copy tables");
  assert.match(monitorJs, /P\.events\.state/, "renders the state broadcast");
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
  const green = waitForState(
    monitorA,
    (state) =>
      state.leg &&
      state.leg.peers["site-b"] &&
      state.leg.peers["site-b"].connected &&
      state.overall &&
      state.overall.status === "green",
    25000,
  );
  const greenB = waitForState(
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
  assert.equal(stateA.leg.peers["site-b"].local.performers, 0, "no performers yet");
  assert.equal(stateA.leg.peers["site-b"].local.status, null, "no local data until a performer joins");
  assert.equal(stateA.local.status, null, "own site: no performer either");
  assert.equal(stateA.overall.attributionNodeId, stateA.config.nodeId);
  assert.equal(stateA.overall.attributionLeg, "hub");

  // --- #5 in the flower: a performer joins site B — A sees B's local
  // leg arrive (ring, card, and the derived performer-pair inputs) ---
  const performerB = await connectPerformerAt(`http://127.0.0.1:${SITE_B_PERFORMER}`);
  t.after(() => performerB.socket.close());

  const withLocal = await waitForState(
    monitorA,
    (state) =>
      state.leg &&
      state.leg.peers["site-b"] &&
      state.leg.peers["site-b"].local &&
      state.leg.peers["site-b"].local.status === "green" &&
      typeof state.leg.peers["site-b"].local.p50 === "number" &&
      state.leg.peers["site-b"].local.performers === 1 &&
      state.overall &&
      state.overall.status === "green",
    25000,
  );

  assert.equal(withLocal.overall.attributionLeg, "hub", "a green local leg changes nothing");
  assert.equal(withLocal.local.status, null, "A itself still has no performer");

  // --- the performer's Wi-Fi drops: B's local leg goes Red, and A's
  // overall banner attributes B's LOCAL leg (the demo line: “对站
  // monitor 看到是 B 站本地腿的问题”) ---
  performerB.socket.close();

  const localDown = await waitForState(
    monitorA,
    (state) =>
      state.leg &&
      state.leg.peers["site-b"] &&
      state.leg.peers["site-b"].connected &&
      state.leg.peers["site-b"].local &&
      state.leg.peers["site-b"].local.status === "red" &&
      state.overall &&
      state.overall.status === "red" &&
      state.overall.attributionNodeId === "site-b" &&
      state.overall.attributionLeg === "local",
    25000,
  );

  assert.equal(localDown.overall.attributionSelf, false);

  // --- the performer rejoins with its token: B's local leg recovers
  // and the network returns to green ---
  const performerBack = await connectPerformerAt(
    `http://127.0.0.1:${SITE_B_PERFORMER}`,
    performerB.joined.token,
  );
  t.after(() => performerBack.socket.close());

  assert.equal(performerBack.joined.id, performerB.joined.id, "the id is back");

  await waitForState(
    monitorA,
    (state) =>
      state.leg &&
      state.leg.peers["site-b"] &&
      state.leg.peers["site-b"].local &&
      state.leg.peers["site-b"].local.status === "green" &&
      state.overall &&
      state.overall.status === "green",
    25000,
  );

  // --- one side drops: the other side's overall turns red, attributed ---
  await stopProcess(serverB);

  const down = await waitForState(
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

  await waitForState(
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
