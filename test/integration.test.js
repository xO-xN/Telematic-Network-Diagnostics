// Score-server smoke test (issue #2): the de-templatized server comes
// up as Telematic Network Diagnostics — health ready with audio
// disabled, both pages served, the theme bridge and QR on the monitor
// port only.

const assert = require("node:assert/strict");
const test = require("node:test");
const { spawn } = require("node:child_process");
const net = require("node:net");
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

  assert.equal(connected.config, undefined, "the old token-less config field is gone (#12)");
  assert.deepEqual(connected.activeConfig, {
    url: `http://127.0.0.1:${hubPort}`,
    token: HUB_TOKEN,
    room: "rehearsal",
    nodeId: "site-test",
  }, "the live config rides the snapshot verbatim — the connect button's dirty-check baseline");
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
      state.activeConfig &&
      state.activeConfig.nodeId === "site-renamed" &&
      state.leg.connected,
  );

  assert.equal(renamed.activeConfig.nodeId, "site-renamed");

  // --- an IDENTICAL resubmission is a server no-op (#12 keeps this
  // verbatim): the live measurement and its window survive untouched —
  // no teardown, no reconnect, no event ---
  const samplesBeforeNoop = renamed.leg.summary.samples;
  const reconnectsBefore = renamed.leg.summary.reconnects;

  for (let i = 0; i < 2; i += 1) {
    monitor.emit(EVENTS.hubConfig, {
      url: `http://127.0.0.1:${hubPort}`,
      token: HUB_TOKEN,
      room: "rehearsal",
      nodeId: "site-renamed",
    });
  }

  const unaffected = await waitForState(
    monitor,
    (state) =>
      state.leg.connected &&
      state.leg.summary.samples >= samplesBeforeNoop + 10,
    15000,
  );

  assert.equal(
    unaffected.leg.summary.reconnects,
    reconnectsBefore,
    "identical config → the leg was never rebuilt",
  );
  assert.equal(unaffected.activeConfig.nodeId, "site-renamed");

  // --- the monitor page itself: persistence + env prefill wiring ---
  const monitorHtml = await (await fetch(`${MONITOR_URL}/`)).text();
  assert.match(monitorHtml, /monitor\.js/);

  const monitorJs = await (await fetch(`${MONITOR_URL}/monitor.js`)).text();
  assert.match(monitorJs, /localStorage/, "the form persists to localStorage");
  assert.match(monitorJs, /storageKeys/, "storage key comes from shared.js");
  assert.match(monitorJs, /autoConfig/, "auto-start uses the loaded config");
  assert.match(monitorJs, /state\.env/, "env prefill is wired");
  assert.match(monitorJs, /activeConfig/, "the connect button dirty-checks against the server's live config (#12)");
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
  assert.equal(idle.activeConfig, null, "no live config to dirty-check against (#12)");
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
// Performer voluntary exit end to end (issue #10): the phone taps
// 退出检测 and the server DELETES the client — no red card, no drag
// on the site verdict (a site whose only performer left reads exactly
// like one no performer ever joined), the slot and the claim-token
// mapping are freed, and a rejoin with the OLD token is a brand-new
// client: fresh id (numerically different once its old slot is
// refilled), fresh measurement through gray warm-up, no inherited
// history. The disconnect → Red default is untouched — that is the
// test above.
// ------------------------------------------------------------

test("local leg: voluntary leave — deleted card, freed slot, old token rejoins as a new client", async (t) => {
  await assertPortsFree([6868, 6869]);

  const server = spawn(process.execPath, ["server.js"], {
    cwd: PROJECT_ROOT,
    stdio: "ignore",
  });
  t.after(async () => stopProcess(server));

  await waitForHealthReady();

  const monitor = await connectMonitor();
  t.after(() => monitor.close());

  // --- the sole performer leaves: the site reads "never had one" ---
  const solo = await connectPerformerAt(PERFORMER_URL);
  t.after(() => solo.socket.close());

  await waitForState(monitor, (state) => state.local.clients["1"]);

  // No manual close: the SERVER kicks the socket once it has processed
  // the leave (the page-side contract too — see performer.js).
  solo.socket.emit(EVENTS.leave);

  const emptied = await waitForState(
    monitor,
    (state) =>
      Object.keys(state.local.clients).length === 0 &&
      state.local.status === null &&
      state.local.performers === 0,
    8000,
  );

  const leftEvents = emptied.local.events.filter(
    (event) => event.type === "left",
  );

  assert.equal(leftEvents.length, 1, "one site-level exit event");
  assert.equal(leftEvents[0].client, 1);
  assert.equal(
    emptied.local.events.filter((event) => event.type === "disconnected").length,
    0,
    "a voluntary exit is not a disconnect — no red trail",
  );

  // --- the freed slot and token: three performers, the middle one
  // leaves, a fresh client takes its slot, and the leaver's OLD token
  // comes back on a DIFFERENT id as a brand-new client ---
  const p1 = await connectPerformerAt(PERFORMER_URL);
  t.after(() => p1.socket.close());
  const p2 = await connectPerformerAt(PERFORMER_URL);
  t.after(() => p2.socket.close());
  const p3 = await connectPerformerAt(PERFORMER_URL);
  t.after(() => p3.socket.close());

  assert.equal(p1.joined.id, 1);
  assert.equal(p2.joined.id, 2);
  assert.equal(p3.joined.id, 3);

  p2.socket.emit(EVENTS.leave);

  await waitForState(
    monitor,
    (state) =>
      state.local.clients["1"] &&
      state.local.clients["3"] &&
      !state.local.clients["2"],
    8000,
  );

  const p4 = await connectPerformerAt(PERFORMER_URL);
  t.after(() => p4.socket.close());

  assert.equal(p4.joined.id, 2, "the freed slot is reused (cap semantics intact)");

  const p2back = await connectPerformerAt(PERFORMER_URL, p2.joined.token);
  t.after(() => p2back.socket.close());

  assert.equal(p2back.joined.id, 4, "the old token gets a DIFFERENT id");
  assert.equal(p2back.joined.recovered, false, "not a recovery — a new client");
  assert.equal(p2back.joined.token, p2.joined.token, "the token itself persists");

  const fresh = await waitForState(
    monitor,
    (state) =>
      state.local.clients["4"] &&
      state.local.clients["4"].connected &&
      state.local.clients["4"].events.length === 1 &&
      state.local.clients["4"].events[0].type === "connected",
    8000,
  );

  assert.equal(
    fresh.local.clients["4"].status,
    "gray",
    "fresh measurement — gray warm-up, no inherited history",
  );
  assert.equal(fresh.local.performers, 4);

  // --- the performer page wiring (source-level): leave button + the
  // full-page rejoin cover ---
  const performerJs = await (await fetch(`${PERFORMER_URL}/performer.js`)).text();
  assert.match(performerJs, /P\.events\.leave/, "emits the leave event");
  assert.match(performerJs, /left-cover/, "the exited cover");
  assert.match(performerJs, /socket\.open\(\)/, "the cover tap rejoins");
});

// ------------------------------------------------------------
// Monitor removal end to end (issue #13): the monitor taps a performer
// card's「x」— online or disconnected, no confirmation. The server runs
// #10's deletion primitives (freed slot and token, no red trail, site
// verdict un-dragged, every monitor converges) and, for an ONLINE
// client, first sends `removed` and then kicks the socket: the phone
// lands in its 已被移出检测 cover, and its later 重新加入 with the OLD
// token is a brand-new client.
// ------------------------------------------------------------

test("local leg: monitor removal — notified phone, corrected monitors, fresh rejoin", async (t) => {
  await assertPortsFree([6868, 6869]);

  const server = spawn(process.execPath, ["server.js"], {
    cwd: PROJECT_ROOT,
    stdio: "ignore",
  });
  t.after(async () => stopProcess(server));

  await waitForHealthReady();

  // Two devices run the monitor: the removal one operator taps the「x」,
  // the other must converge on the same corrected snapshot.
  const monitorA = await connectMonitor();
  const monitorB = await connectMonitor();
  t.after(() => monitorA.close());
  t.after(() => monitorB.close());

  const p1 = await connectPerformerAt(PERFORMER_URL);
  const p2 = await connectPerformerAt(PERFORMER_URL);
  t.after(() => p1.socket.close());
  t.after(() => p2.socket.close());

  assert.equal(p1.joined.id, 1);
  assert.equal(p2.joined.id, 2);

  await waitForState(
    monitorA,
    (state) => state.local.clients["1"] && state.local.clients["2"],
  );

  // The wire order on the removed phone: the notice, then the kick.
  const order = [];

  p1.socket.once(EVENTS.removed, () => order.push("removed"));
  p1.socket.once("disconnect", () => order.push("disconnect"));

  monitorA.emit(EVENTS.remove, { id: 1 });

  await new Promise((resolve) => p1.socket.once("disconnect", resolve));

  assert.deepEqual(
    order,
    ["removed", "disconnect"],
    "the phone hears `removed` BEFORE the server drops its socket",
  );

  // Both monitors converge: card gone, no red trail, one "removed"
  // site event — and the removal is not logged as a disconnect.
  const corrected = {
    A: waitForState(
      monitorA,
      (state) =>
        !state.local.clients["1"] &&
        state.local.clients["2"] &&
        state.local.events.some(
          (event) => event.type === "removed" && event.client === 1,
        ),
    ),
    B: waitForState(
      monitorB,
      (state) =>
        !state.local.clients["1"] &&
        state.local.clients["2"] &&
        state.local.events.some(
          (event) => event.type === "removed" && event.client === 1,
        ),
    ),
  };

  const [stateA, stateB] = await Promise.all([corrected.A, corrected.B]);

  for (const state of [stateA, stateB]) {
    assert.equal(state.local.performers, 1, "p2 is still online");
    assert.equal(
      state.local.events.filter((event) => event.type === "disconnected").length,
      0,
      "a removal is not a network fault — no red trail",
    );
  }

  // --- the freed slot and token: a fresh client takes the slot, and
  // the removed phone's 重新加入 with its OLD token is a brand-new
  // client (different id, no inherited history) ---
  const p3 = await connectPerformerAt(PERFORMER_URL);
  t.after(() => p3.socket.close());

  assert.equal(p3.joined.id, 1, "the freed slot is reused");

  const p1back = await connectPerformerAt(PERFORMER_URL, p1.joined.token);
  t.after(() => p1back.socket.close());

  assert.equal(p1back.joined.id, 3, "the old token gets a DIFFERENT id");
  assert.equal(p1back.joined.recovered, false, "not a recovery — a new client");

  const fresh = await waitForState(
    monitorA,
    (state) =>
      state.local.clients["3"] &&
      state.local.clients["3"].connected &&
      state.local.clients["3"].events.length === 1 &&
      state.local.clients["3"].events[0].type === "connected",
    8000,
  );

  assert.equal(
    fresh.local.clients["3"].status,
    "gray",
    "fresh measurement — gray warm-up, no inherited history",
  );

  // --- a DISCONNECTED card is removable too (no notification path):
  // p2 dropped, its card sits Red; the other monitor's「x」deletes it ---
  p2.socket.close();

  await waitForState(
    monitorA,
    (state) =>
      state.local.clients["2"] &&
      !state.local.clients["2"].connected &&
      state.local.clients["2"].status === "red",
    8000,
  );

  monitorB.emit(EVENTS.remove, { id: 2 });

  await waitForState(
    monitorB,
    (state) =>
      !state.local.clients["2"] &&
      state.local.clients["3"] &&
      state.local.events.some(
        (event) => event.type === "removed" && event.client === 2,
      ),
    8000,
  );

  // --- a bogus removal is a no-op: no event, nothing disturbed ---
  monitorA.emit(EVENTS.remove, { id: 99 });

  const afterBogus = await waitForState(
    monitorA,
    (state) => state.local.clients["3"],
  );

  assert.equal(
    afterBogus.local.events.filter(
      (event) => event.type === "removed" && event.client === 99,
    ).length,
    0,
    "an unknown id pushes no site event",
  );
  assert.ok(afterBogus.local.clients["3"], "the live clients are untouched");

  // --- the page wiring (source-level): the「x」and its command, the
  // phone's removed cover ---
  const monitorJs = await (await fetch(`${MONITOR_URL}/monitor.js`)).text();
  assert.match(monitorJs, /remove-btn/, "the performer cards carry the「x」");
  assert.match(monitorJs, /P\.events\.remove/, "the tap emits the remove command");

  const performerJs = await (await fetch(`${PERFORMER_URL}/performer.js`)).text();
  assert.match(performerJs, /P\.events\.removed/, "the phone handles the removed notice");
  assert.match(performerJs, /已被移出检测/, "the removal words its own cover");
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
  assert.equal(stateA.overall.attributionNodeId, stateA.activeConfig.nodeId);
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

  // --- #10: the performer VOLUNTARILY leaves — the deletion reaches
  // every monitor through the hub: B's local leg reads "no data"
  // again (null, not a lingering red) and the overall verdict drops
  // the local attribution ---
  performerBack.socket.emit(EVENTS.leave);

  const exited = await waitForState(
    monitorA,
    (state) =>
      state.leg &&
      state.leg.peers["site-b"] &&
      state.leg.peers["site-b"].connected &&
      state.leg.peers["site-b"].local &&
      state.leg.peers["site-b"].local.status === null &&
      state.leg.peers["site-b"].local.performers === 0 &&
      state.overall &&
      state.overall.status === "green",
    25000,
  );

  assert.equal(
    exited.overall.attributionLeg,
    "hub",
    "no local leg counts anymore — the exit un-dragged the verdict",
  );

  // --- #13: the MONITOR removes a performer — the same deletion
  // reaches the other site through the hub. A performer rejoins B,
  // B's own monitor taps the card's「x」, and A's verdict corrects the
  // same second ---
  const performerAgain = await connectPerformerAt(
    `http://127.0.0.1:${SITE_B_PERFORMER}`,
  );
  t.after(() => performerAgain.socket.close());

  await waitForState(
    monitorA,
    (state) =>
      state.leg &&
      state.leg.peers["site-b"] &&
      state.leg.peers["site-b"].local &&
      state.leg.peers["site-b"].local.status !== null,
    25000,
  );

  monitorB.emit(EVENTS.remove, { id: performerAgain.joined.id });

  await waitForState(
    monitorA,
    (state) =>
      state.leg &&
      state.leg.peers["site-b"] &&
      state.leg.peers["site-b"].connected &&
      state.leg.peers["site-b"].local &&
      state.leg.peers["site-b"].local.status === null &&
      state.leg.peers["site-b"].local.performers === 0 &&
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

// ------------------------------------------------------------
// Shutdown hardening (issue #8, ported from PNDS-Template#2): the
// phone performer pages keep a persistent auto-reconnecting socket
// open, so server.close() alone would wait on the client while the
// host's kill window runs out. This replays the worst case the App
// leaves behind on stop and asserts the server still dies in time.
// ------------------------------------------------------------

test("shutdown: SIGTERM completes promptly with live clients still connected", async (t) => {
  await assertPortsFree([6868, 6869]);

  const server = spawn(process.execPath, ["server.js", "--audio-mode", "none"], {
    cwd: PROJECT_ROOT,
    stdio: "ignore",
  });
  t.after(async () => stopProcess(server));

  await waitForHealthReady();

  // The worst case the App leaves behind on stop: a joined performer
  // (websocket), a polling-only client (a phone on a weak network), and
  // raw keep-alive HTTP connections on both ports (the monitor webview's
  // page stays mounted through the stop fade).
  const performer = await connectPerformerAt(PERFORMER_URL);
  t.after(() => performer.socket.close());

  const polling = io(PERFORMER_URL, {
    transports: ["polling"],
    reconnection: false,
  });

  await new Promise((resolve) => polling.once("connect", resolve));
  t.after(() => polling.close());

  const raw = [];

  for (const port of [6868, 6869]) {
    const socket = net.connect({ port, host: "127.0.0.1" });

    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write(
      "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n",
    );
    raw.push(socket);
  }
  t.after(() => raw.forEach((s) => s.destroy()));

  const startedAt = Date.now();

  server.kill("SIGTERM");

  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("server did not exit within 2 s of SIGTERM")),
      2000,
    );

    server.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  const elapsed = Date.now() - startedAt;

  // The host's kill window is 5 s (then SIGKILL, and the operator stares
  // at a blank stop cover meanwhile): the server must be long gone
  // before that window closes.
  assert.equal(exitCode, 0, "graceful shutdown completes");
  assert.ok(
    elapsed < 1000,
    `shutdown took ${elapsed} ms with live clients still connected`,
  );
});
