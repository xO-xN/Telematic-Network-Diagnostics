const assert = require("node:assert/strict");
const test = require("node:test");
const { spawn } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { io } = require("socket.io-client");

const {
  freqRange,
  registers,
  events: EVENTS,
  tokenKey,
} = require("../public/shared");
const { connectPerformer, connectMonitor } = require("../public/client");
const { loadManifest, resolveServerConfig } = require("../lib/config");

const PROJECT_ROOT = path.join(__dirname, "..");
const SERVER_CONFIG = resolveServerConfig(loadManifest(PROJECT_ROOT));
const PERFORMER_URL = `http://127.0.0.1:${SERVER_CONFIG.performerPort}`;
const MONITOR_URL = `http://127.0.0.1:${SERVER_CONFIG.monitorPort}`;
const HEALTH_URL = `${PERFORMER_URL}/__pnds/health`;

function waitForHealthReady() {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    const tick = async () => {
      attempts += 1;

      try {
        const response = await fetch(HEALTH_URL);
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

function joinWithToken(token) {
  return new Promise((resolve, reject) => {
    const socket = io(PERFORMER_URL, { reconnection: false });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("join timeout"));
    }, 5000);

    socket.on("connect", () => {
      socket.emit(EVENTS.join, { token: token || null });
    });

    socket.on(EVENTS.joined, (data) => {
      clearTimeout(timer);
      resolve({ socket, data });
    });

    socket.on(EVENTS.rejected, (data) => {
      clearTimeout(timer);
      socket.close();
      reject(new Error(`rejected: ${data.reason}`));
    });
  });
}

// Waits for the next "state" broadcast that satisfies the predicate.
// (The server also broadcasts on join, so a plain once() can catch a stale
// snapshot.)
function waitForState(socket, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(EVENTS.state, onState);
      reject(new Error("state timeout"));
    }, timeoutMs);

    const onState = (data) => {
      if (predicate(data)) {
        clearTimeout(timer);
        resolve(data);
      }
    };

    socket.on(EVENTS.state, onState);
  });
}

// Polls a predicate until it holds (the client module surfaces state
// through getters, not promises).
async function waitForCondition(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return false;
}

// localStorage stand-in for the client module (the browser pages inject
// the real one).
function createClientStorage() {
  const entries = new Map();

  return {
    getItem(key) {
      return entries.has(key) ? entries.get(key) : null;
    },
    setItem(key, value) {
      entries.set(key, value);
    },
    entries,
  };
}

// Fails fast with an actionable message when a dev server already holds
// the ports — otherwise health polling would silently test THAT server
// and fail with confusing assertion mismatches (wrong audio mode, etc.).
async function assertPortsFree() {
  for (const port of [SERVER_CONFIG.performerPort, SERVER_CONFIG.monitorPort]) {
    const inUse = await new Promise((resolve) => {
      const probe = net.connect({ port, host: "127.0.0.1" });

      probe.once("connect", () => {
        probe.destroy();
        resolve(true);
      });
      probe.once("error", () => resolve(false));
    });

    if (inUse) {
      throw new Error(
        `Port ${port} is already in use — stop running dev servers (npm run dev / dev:none) before the integration test.`,
      );
    }
  }
}

test("score server: health, join, control, set-out, reconnect, restart seats, reset-ids, pages", async (t) => {
  await assertPortsFree();

  // Seat records survive a restart via this file — both server spawns
  // below share it, which is exactly what reopening a work does.
  const seatsFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "pnds-seats-e2e-")),
    "seats.json",
  );

  const spawnServer = () =>
    spawn(process.execPath, ["server.js", "--audio-mode", "none"], {
      cwd: PROJECT_ROOT,
      stdio: "ignore",
      env: { ...process.env, PNDS_SEATS_FILE: seatsFile },
    });

  const servers = [spawnServer()];

  t.after(() => {
    for (const server of servers) {
      server.kill("SIGTERM");
    }
  });

  const server = servers[0];

  const health = await waitForHealthReady();

  assert.equal(health.projectId, "pnds-template");
  assert.equal(health.audioMode, "none");
  assert.equal(health.scoreServer.performerPort, SERVER_CONFIG.performerPort);
  assert.equal(health.scoreServer.monitorPort, SERVER_CONFIG.monitorPort);

  // --- join: first client gets id 1 + a claim token ---
  const first = await joinWithToken(null);
  t.after(() => first.socket.close());

  assert.equal(first.data.id, 1);
  assert.equal(typeof first.data.token, "string");
  assert.equal(first.data.token.length, 48);

  // --- control: monitor receives amp (audio-taper curve) and freq ---
  first.socket.emit(EVENTS.control, { amp: 0.5, freq: 0.5 });

  const expectedMidFreq = Math.round(
    freqRange.min + 0.5 * (freqRange.max - freqRange.min),
  );

  const controlState = await waitForState(
    first.socket,
    (state) =>
      state.clients.length === 1 &&
      state.clients[0].id === 1 &&
      state.clients[0].amp === 0.25 && // mapAmp(0.5) = 0.5^2
      state.clients[0].freq === expectedMidFreq, // freqRange.min + 0.5 * (max - min)
  );

  assert.equal(controlState.clients[0].amp, 0.25);
  assert.equal(controlState.clients[0].freq, expectedMidFreq);

  // --- register: a control with range 2 maps over register 2's band ---
  first.socket.emit(EVENTS.control, { amp: 0.5, freq: 0.5, range: 2 });

  const expectedR2MidFreq = Math.round(
    registers[2].freqRange.min +
      0.5 * (registers[2].freqRange.max - registers[2].freqRange.min),
  );

  const registerState = await waitForState(
    first.socket,
    (state) =>
      state.clients.length === 1 && state.clients[0].register === 2,
  );

  assert.equal(registerState.clients[0].freq, expectedR2MidFreq);

  // --- set-out: channel reassignment is reflected ---
  first.socket.emit(EVENTS.setOut, { out: 5 });

  const outState = await waitForState(
    first.socket,
    (state) => state.clients.length === 1 && state.clients[0].out === 5,
  );

  assert.equal(outState.clients[0].out, 5);

  // --- operator set-out: a socket that never joined (the monitor page)
  // reassigns a client by naming the id ---
  const operator = io(PERFORMER_URL, { reconnection: false });
  t.after(() => operator.close());

  await new Promise((resolve) => operator.on("connect", resolve));

  operator.emit(EVENTS.setOut, { id: 1, out: 6 });

  const operatorState = await waitForState(
    first.socket,
    (state) => state.clients.length === 1 && state.clients[0].out === 6,
  );

  assert.equal(operatorState.clients[0].out, 6);

  // --- second client: id 2, default channel 2 (even id) ---
  const second = await joinWithToken(null);
  t.after(() => second.socket.close());

  assert.equal(second.data.id, 2);

  second.socket.emit(EVENTS.control, { amp: 0.25, freq: 0 });

  const secondState = await waitForState(
    first.socket,
    (state) => state.clients.length === 2 && state.clients[1].id === 2,
  );

  // The join broadcast carries the birth default and the control
  // broadcast the mapped raw-0 — both are mapFreq(0), so the assertion
  // holds whichever lands first (they can coalesce into one TCP frame).
  assert.equal(
    secondState.clients[1].freq,
    Math.round(freqRange.min),
  ); // freqValue 0 → register 3 min, rounded by mapFreq
  assert.equal(secondState.clients[1].out, 2); // even id -> channel 2

  // --- register 1 for the second client ---
  second.socket.emit(EVENTS.control, { amp: 0.25, freq: 0, range: 1 });

  const secondRegisterState = await waitForState(
    first.socket,
    (state) =>
      state.clients.length === 2 && state.clients[1].register === 1,
  );

  assert.equal(
    secondRegisterState.clients[1].freq,
    Math.round(registers[1].freqRange.min), // freqValue 0 → register 1 min
  );

  // --- reconnect with token recovers id 1 AND its register ---
  first.socket.close();

  const rejoined = await joinWithToken(first.data.token);
  t.after(() => rejoined.socket.close());

  assert.equal(rejoined.data.id, 1);
  assert.equal(rejoined.data.recovered, true);

  const rejoinedState = await waitForState(
    rejoined.socket,
    (state) => {
      // Voice insertion order flips after a reconnect (voices is a Map
      // keyed by id), so find the restored client by id.
      const client = (state.clients || []).find((entry) => entry.id === 1);
      return Boolean(client && client.register === 2);
    },
  );

  const restored = rejoinedState.clients.find((entry) => entry.id === 1);

  // The voice is restored by re-mapping the RAW fader values: register 2,
  // freq 0.5 → register 2 mid, amp 0.5 → 0.25 (no double mapping).
  assert.equal(restored.register, 2);
  assert.equal(restored.freq, expectedR2MidFreq);
  assert.equal(restored.amp, 0.25);

  // --- client module: the pages' connection code against the real server ---
  // join (token persisted), deadband over the wire, monitor view,
  // operator set-out reaching the performer status, reload recovery.
  const clientStorage = createClientStorage();
  const performerClient = connectPerformer({
    io,
    port: SERVER_CONFIG.performerPort,
    events: EVENTS,
    tokenKey,
    storage: clientStorage,
    hostname: "127.0.0.1",
  });
  t.after(() => performerClient.close());

  assert.ok(await waitForCondition(() => performerClient.joined));
  assert.equal(performerClient.myId, 3); // ids 1 and 2 are taken
  assert.equal(typeof clientStorage.entries.get(tokenKey), "string");

  // State is broadcast only on mutations, so the monitor must be fully
  // connected before the control it is meant to observe.
  const monitorClient = connectMonitor({
    io,
    port: SERVER_CONFIG.performerPort,
    events: EVENTS,
    hostname: "127.0.0.1",
  });
  t.after(() => monitorClient.close());

  assert.ok(await waitForCondition(() => monitorClient.connected));

  // The deadband: the first payload goes out, sub-threshold jitter does not.
  assert.equal(
    performerClient.sendControls({ amp: 0.5, freq: 0.5, range: 3 }),
    true,
  );
  assert.equal(
    performerClient.sendControls({ amp: 0.5001, freq: 0.5, range: 3 }),
    false,
  );

  // The control crossed the wire: the monitor sees amp 0.25 (0.5 mapped
  // once by the server's audio taper).
  assert.ok(
    await waitForCondition(() => {
      const mine = monitorClient.clients.find((entry) => entry.id === 3);
      return Boolean(mine && mine.amp === 0.25);
    }),
  );

  // Operator channel reassignment reaches the performer's myOut tracking.
  monitorClient.setOut(3, 6);

  assert.ok(await waitForCondition(() => performerClient.myOut === 6));

  // A fresh client with the same storage (page reload / phone lock)
  // recovers the same id.
  performerClient.close();

  const reloaded = connectPerformer({
    io,
    port: SERVER_CONFIG.performerPort,
    events: EVENTS,
    tokenKey,
    storage: clientStorage,
    hostname: "127.0.0.1",
  });
  t.after(() => reloaded.close());

  assert.ok(await waitForCondition(() => reloaded.joined));
  assert.equal(reloaded.myId, 3);

  // --- restart: a reopened work hands the device back its seat and CH ---
  // The seat file is the only state that crosses the restart: the token
  // reclaims id 3 with channel 6 (set by the operator above), while the
  // fader state (amp/freq) starts from zero — in-memory by design.
  reloaded.close();
  monitorClient.close();

  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000);
    server.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    server.kill("SIGTERM");
  });

  const server2 = spawnServer();
  servers.push(server2);

  await waitForHealthReady();

  const performerToken = clientStorage.entries.get(tokenKey);
  const seatRejoined = await joinWithToken(performerToken);
  t.after(() => seatRejoined.socket.close());

  assert.equal(seatRejoined.data.id, 3); // the recorded seat
  assert.equal(seatRejoined.data.recovered, false); // no in-memory state

  const seatState = await waitForState(
    seatRejoined.socket,
    (state) =>
      state.clients.length === 1 &&
      state.clients[0].id === 3 &&
      state.clients[0].out === 6,
  );

  assert.equal(seatState.clients[0].amp, 0); // fader state did not survive

  const resetOperator = io(PERFORMER_URL, { reconnection: false });
  t.after(() => resetOperator.close());

  await new Promise((resolve) => resetOperator.on("connect", resolve));

  // --- seat move: the operator moves the device to another seat ---
  const movedJoined = new Promise((resolve) =>
    seatRejoined.socket.once(EVENTS.joined, resolve),
  );

  resetOperator.emit(EVENTS.setSeat, { id: 3, to: 2 });

  const movedPayload = await movedJoined;

  assert.equal(movedPayload.id, 2); // the page's id tracking follows joined
  assert.equal(movedPayload.token, performerToken);

  await waitForState(
    seatRejoined.socket,
    (state) =>
      state.clients.length === 1 &&
      state.clients[0].id === 2 &&
      state.clients[0].out === 6, // the channel moved with the seat
  );

  // --- reset-ids: the operator wipes the seats; rejoin gets a fresh id ---
  resetOperator.emit(EVENTS.resetIds);

  // The reset's closing broadcast lists no clients — the deterministic
  // signal that seats are cleared and performers are bounced.
  await waitForState(
    resetOperator,
    (state) => state.clients.length === 0,
  );

  const freshJoin = await joinWithToken(performerToken);
  t.after(() => freshJoin.socket.close());

  assert.equal(freshJoin.data.id, 1); // no seat: smallest free id
  assert.equal(freshJoin.data.recovered, false);

  const freshState = await waitForState(
    freshJoin.socket,
    (state) => state.clients.length === 1 && state.clients[0].id === 1,
  );

  assert.equal(freshState.clients[0].out, 1); // odd id default channel

  // --- pages served on both ports ---
  const performerResponse = await fetch(`${PERFORMER_URL}/`);
  const monitorResponse = await fetch(`${MONITOR_URL}/`);

  assert.equal(performerResponse.status, 200);
  assert.equal(monitorResponse.status, 200);

  const monitorHtml = await monitorResponse.text();
  assert.match(monitorHtml, /monitor\.js/);

  // --- theme following (spec §5.3): the monitor branch loads the
  // module from the App-contract namespace; the performer port, which
  // also serves static files, does not expose it ---
  assert.match(monitorHtml, /\/__pnds\/theme-follow\.js/);
  const themeModule = await fetch(`${MONITOR_URL}/__pnds/theme-follow.js`);
  assert.equal(themeModule.status, 200);
  assert.match(themeModule.headers.get("content-type"), /javascript/);
  assert.match(await themeModule.text(), /pnds:theme/);
  const performerThemeModule = await fetch(
    `${PERFORMER_URL}/__pnds/theme-follow.js`,
  );
  assert.equal(performerThemeModule.status, 404);
});
