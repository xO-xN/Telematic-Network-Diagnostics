// Hub-leg unit tests (issue #3): the quality decision is a pure
// function over window metrics — table-driven, every branch covered —
// and the core principle is pinned here: latency MAGNITUDE never
// participates in the coloring (a 250 ms but stable link is green).
// The HubLeg class runs against a fake socket with millisecond
// timings: probe/echo/loss bookkeeping, reconnect counting, the
// automatic burst↔calm phase cycle.

const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");

const {
  STATUS,
  percentile,
  hubQuality,
  summarizeWindow,
  HubLeg,
  WARMUP_SAMPLES,
} = require("../lib/hub-leg");

// ------------------------------------------------------------
// percentile
// ------------------------------------------------------------

test("percentile: nearest-rank, null when empty", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile(undefined, 0.5), null);

  // 10 samples 20..29: p50 = index 4 (24), p25 = index 2 (22),
  // p75 = index 7 (27), p95 = index 9 (29).
  const values = [20, 21, 22, 23, 24, 25, 26, 27, 28, 29];

  assert.equal(percentile(values, 0.5), 24);
  assert.equal(percentile(values, 0.25), 22);
  assert.equal(percentile(values, 0.75), 27);
  assert.equal(percentile(values, 0.95), 29);

  // Unsorted input is ranked, not trusted.
  assert.equal(percentile([29, 20, 25], 0.5), 25);
});

// ------------------------------------------------------------
// summarizeWindow
// ------------------------------------------------------------

test("summarizeWindow: p50/p95/IQR/loss/one-way from a window", () => {
  const rtts = [20, 21, 22, 23, 24, 25, 26, 27, 28, 29];
  const summary = summarizeWindow({ rtts, lost: 1, reconnects: 2 });

  assert.equal(summary.samples, 10);
  assert.equal(summary.lost, 1);
  assert.equal(summary.reconnects, 2);
  assert.equal(summary.rttP50, 24);
  assert.equal(summary.rttP95, 29);
  assert.equal(summary.iqrMs, 5); // p75 − p25 = 27 − 22
  assert.equal(summary.lossRate, 1 / 11);
  assert.equal(summary.oneWayEstimateMs, 12); // p50 / 2
});

test("summarizeWindow: empty window is all nulls with zero loss", () => {
  const summary = summarizeWindow({ rtts: [], lost: 0, reconnects: 0 });

  assert.equal(summary.rttP50, null);
  assert.equal(summary.rttP95, null);
  assert.equal(summary.iqrMs, null);
  assert.equal(summary.lossRate, 0);
  assert.equal(summary.oneWayEstimateMs, null);
});

// ------------------------------------------------------------
// hubQuality — table-driven, every branch (issue #3 AC)
// ------------------------------------------------------------

// Shared inputs: enough samples to be past warm-up.
const ENOUGH = WARMUP_SAMPLES + 5;

const QUALITY_TABLE = [
  {
    name: "disconnected → red unreachable (priority 1)",
    input: { connected: false, samples: 100, lost: 0, iqrMs: 1, lossRate: 0, reconnects: 0 },
    status: STATUS.RED,
    reason: /unreachable/i,
  },
  {
    name: "warm-up: connected, too few samples, no negative evidence → gray",
    input: { connected: true, samples: WARMUP_SAMPLES - 1, lost: 0, iqrMs: null, lossRate: 0, reconnects: 0 },
    status: STATUS.GRAY,
    reason: /warming/i,
  },
  {
    name: "warm-up escape: all probes lost while connected → red via loss",
    input: { connected: true, samples: 0, lost: 3, iqrMs: null, lossRate: 1, reconnects: 0 },
    status: STATUS.RED,
    reason: /loss/i,
  },
  {
    name: "all good → green",
    input: { connected: true, samples: ENOUGH, lost: 0, iqrMs: 4, lossRate: 0.001, reconnects: 0 },
    status: STATUS.GREEN,
  },
  {
    name: "green boundary: IQR just under 10, loss just under 0.5%",
    input: { connected: true, samples: ENOUGH, lost: 0, iqrMs: 9.9, lossRate: 0.0049, reconnects: 0 },
    status: STATUS.GREEN,
  },
  {
    name: "yellow via jitter: IQR in [10, 30)",
    input: { connected: true, samples: ENOUGH, lost: 0, iqrMs: 15, lossRate: 0, reconnects: 0 },
    status: STATUS.YELLOW,
    reason: /iqr/i,
  },
  {
    name: "yellow via loss: rate in [0.5%, 3%)",
    input: { connected: true, samples: ENOUGH, lost: 0, iqrMs: 2, lossRate: 0.01, reconnects: 0 },
    status: STATUS.YELLOW,
    reason: /loss/i,
  },
  {
    name: "warm-up escape: 1 reconnect during warm-up → yellow, not gray",
    input: { connected: true, samples: 2, lost: 0, iqrMs: 3, lossRate: 0, reconnects: 1 },
    status: STATUS.YELLOW,
    reason: /1 reconnect/i,
  },
  {
    name: "warm-up escape: 2 reconnects during warm-up → red",
    input: { connected: true, samples: 2, lost: 0, iqrMs: 3, lossRate: 0, reconnects: 2 },
    status: STATUS.RED,
    reason: /2 reconnects/i,
  },
  {
    name: "yellow via exactly one reconnect in the window",
    input: { connected: true, samples: ENOUGH, lost: 0, iqrMs: 2, lossRate: 0, reconnects: 1 },
    status: STATUS.YELLOW,
    reason: /1 reconnect/i,
  },
  {
    name: "red via jitter: IQR ≥ 30",
    input: { connected: true, samples: ENOUGH, lost: 0, iqrMs: 30, lossRate: 0, reconnects: 0 },
    status: STATUS.RED,
    reason: /iqr/i,
  },
  {
    name: "red via loss: rate ≥ 3%",
    input: { connected: true, samples: ENOUGH, lost: 0, iqrMs: 2, lossRate: 0.03, reconnects: 0 },
    status: STATUS.RED,
    reason: /loss/i,
  },
  {
    name: "red via repeated reconnects (priority over other reds)",
    input: { connected: true, samples: ENOUGH, lost: 0, iqrMs: 40, lossRate: 0.2, reconnects: 2 },
    status: STATUS.RED,
    reason: /2 reconnects/i,
  },
];

for (const row of QUALITY_TABLE) {
  test(`hubQuality: ${row.name}`, () => {
    const result = hubQuality(row.input);

    assert.equal(result.status, row.status, `reason was: ${result.reason}`);

    if (row.reason) {
      assert.match(result.reason, row.reason);
    }
  });
}

test("hubQuality: latency magnitude never participates (structural)", () => {
  // A high-but-stable intercontinental link: every RTT ~250 ms, so the
  // IQR is 0. It must be GREEN — delay is a number for tempering, not
  // a quality failure. hubQuality receives no RTT-level input at all;
  // this test runs the real summarizeWindow → hubQuality pipeline to
  // pin the end-to-end behavior.
  const rtts = Array.from({ length: 20 }, (_, i) => 250 + (i % 2));

  const summary = summarizeWindow({ rtts, lost: 0, reconnects: 0 });
  const result = hubQuality({
    connected: true,
    ...summary,
  });

  assert.equal(summary.rttP50, 250);
  assert.equal(result.status, STATUS.GREEN);
});

// ------------------------------------------------------------
// HubLeg against a fake socket (millisecond timings)
// ------------------------------------------------------------

// A socket.io lookalike: client→hub emissions are captured (and the
// echo seam is simulated with a configurable latency / drop pattern);
// hub→client events are delivered via .deliver().
class FakeSocket extends EventEmitter {
  constructor({ echoLatencyMs = 0, dropEvery = 0 } = {}) {
    super();
    this.echoLatencyMs = echoLatencyMs;
    this.dropEvery = dropEvery;
    this.sent = []; // [event, payload]
    this.closed = false;
  }

  emit(event, payload) {
    this.sent.push([event, payload]);

    if (event === "echo") {
      if (this.dropEvery && payload.seq % this.dropEvery === 0) {
        return true; // the reply never comes back
      }

      setTimeout(() => {
        super.emit("echo", { ...payload, hubReceivedAt: 1 });
      }, this.echoLatencyMs);
    }

    return true;
  }

  deliver(event, payload) {
    super.emit(event, payload);
  }

  close() {
    this.closed = true;
    super.emit("disconnect", "client namespace disconnect");
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls the predicate every 5 ms until it holds (or fails with the
// message after the timeout).
function waitFor(predicate, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(message));
        return;
      }

      setTimeout(tick, 5);
    };

    tick();
  });
}

function makeLeg(socket, overrides = {}) {
  return new HubLeg({
    url: "ws://hub.test",
    token: "t",
    room: "default",
    nodeId: "site-a",
    ioFactory: () => socket,
    events: [],
    now: Date.now,
    baselineIntervalMs: 10,
    burstIntervalMs: 3,
    burstPhaseMs: 30,
    calmPhaseMs: 30,
    probeTimeoutMs: 40,
    ...overrides,
  });
}

test("HubLeg: baseline probes measure RTT, warm-up leaves gray→green", async () => {
  const socket = new FakeSocket({ echoLatencyMs: 5 });
  const leg = makeLeg(socket);

  leg.start();
  socket.deliver("connect");

  await delay(150); // ~15 probes at 10 ms cadence
  const snapshot = leg.snapshot();

  leg.stop();

  const echoProbes = socket.sent.filter(([event]) => event === "echo");

  assert.ok(echoProbes.length >= 8, `expected many probes, got ${echoProbes.length}`);
  assert.ok(snapshot.summary.samples >= 5);
  assert.equal(snapshot.summary.lost, 0);
  assert.ok(snapshot.summary.rttP50 >= 0);
  // Loopback-stable link: quality is green, never red from "latency".
  assert.equal(snapshot.status, STATUS.GREEN);
  assert.ok(
    snapshot.probing === "burst" || snapshot.probing === "calm",
    `unexpected phase: ${snapshot.probing}`,
  );
});

test("HubLeg: dropped echoes become losses and drive the status red", async () => {
  const socket = new FakeSocket({ dropEvery: 1 }); // every reply dropped
  const leg = makeLeg(socket);

  leg.start();
  socket.deliver("connect");

  await delay(150); // probes time out at 40 ms
  const snapshot = leg.snapshot();

  leg.stop();

  assert.equal(socket.sent.filter(([e]) => e === "echo").length >= 8, true);
  assert.equal(snapshot.summary.samples, 0);
  assert.ok(snapshot.summary.lost >= 3, `expected stacked losses, got ${snapshot.summary.lost}`);
  assert.equal(snapshot.summary.lossRate, 1);
  assert.equal(snapshot.status, STATUS.RED);
});

test("HubLeg: disconnect flips red immediately; reconnect counts and recovers", async () => {
  const socket = new FakeSocket({ echoLatencyMs: 2 });
  const leg = makeLeg(socket);

  leg.start();
  socket.deliver("connect");
  await delay(80);

  socket.deliver("disconnect", "transport close");
  const down = leg.snapshot();

  assert.equal(down.connected, false);
  assert.equal(down.status, STATUS.RED, "disconnect is red at once");

  socket.deliver("connect"); // auto-reconnect path
  await delay(80);
  const up = leg.snapshot();

  leg.stop();

  const types = up.events.map((event) => event.type);

  assert.equal(up.connected, true);
  assert.ok(types.includes("reconnected"), "the reconnect is in the log");
  assert.equal(up.summary.reconnects, 1);
  // 1 reconnect keeps the link yellow even with good numbers.
  assert.equal(up.status, STATUS.YELLOW);
  assert.match(up.reason, /1 reconnect/i);
});

test("HubLeg: the phase cycle runs automatically — burst density, calm baseline, repeating", async () => {
  const socket = new FakeSocket({ echoLatencyMs: 0 });
  const leg = makeLeg(socket);

  leg.start();
  socket.deliver("connect");

  // The cycle starts in the burst phase the moment the link is up
  // (same shape as LND) — no manual trigger anywhere.
  await delay(2);
  assert.equal(leg.snapshot().probing, "burst");

  const burstStart = socket.sent.length;
  await delay(30); // the burst phase itself (30 ms at 3 ms cadence)
  const burstSends = socket.sent.length - burstStart;

  assert.ok(burstSends >= 8, `expected dense burst sends, got ${burstSends}`);

  // Then the calm phase: back to the 1 Hz baseline cadence.
  await waitFor(
    () => leg.snapshot().probing === "calm",
    200,
    "phase never returned to calm",
  );

  const calmStart = socket.sent.length;
  await delay(30);
  const calmSends = socket.sent.length - calmStart;

  assert.ok(calmSends <= 3, `expected thin calm sends, got ${calmSends}`);

  // …and the cycle repeats.
  await waitFor(
    () => leg.snapshot().probing === "burst",
    200,
    "the cycle never returned to burst",
  );

  // Phase switches stay out of the event log (they fire every cycle;
  // the log is for connect/disconnect).
  const types = leg.snapshot().events.map((event) => event.type);
  assert.equal(types.includes("burst started"), false);
  assert.equal(types.includes("burst ended"), false);

  leg.stop();
});

test("HubLeg: no probes and no phase cycle while disconnected", async () => {
  const socket = new FakeSocket();
  const leg = makeLeg(socket);

  leg.start(); // never connected
  await delay(30);

  assert.equal(socket.sent.filter(([event]) => event === "echo").length, 0);
  assert.equal(leg.snapshot().probing, "calm");
  leg.stop();
});

test("HubLeg: stop closes the socket and clears pending probes", async () => {
  const socket = new FakeSocket({ echoLatencyMs: 1000 }); // replies late
  const leg = makeLeg(socket);

  leg.start();
  socket.deliver("connect");
  await delay(15); // 1–2 probes in flight
  leg.stop();

  assert.equal(socket.closed, true);
  const snapshot = leg.snapshot();

  assert.equal(snapshot.connected, false);
  assert.equal(snapshot.status, STATUS.RED);
});

// ------------------------------------------------------------
// Flower-view data chain (issue #4): announce + peers roster
// ------------------------------------------------------------

function statsBodyFrom(from, overrides = {}) {
  return {
    type: "tnd-stats",
    from,
    connected: true,
    probing: "calm",
    status: "green",
    reason: "Link quality good",
    summary: { rttP50: 41, rttP95: 55, samples: 20 },
    performerCount: 3,
    localWorst: null,
    ...overrides,
  };
}

test("HubLeg: announces own stats into the room while connected", async () => {
  const socket = new FakeSocket({ echoLatencyMs: 0 });
  const leg = makeLeg(socket, { announceIntervalMs: 5 });

  leg.start();
  socket.deliver("connect");
  await delay(15);

  const announces = socket.sent.filter(([event]) => event === "relay");

  assert.ok(announces.length >= 2, `expected periodic announces, got ${announces.length}`);

  const body = announces[0][1];

  assert.equal(body.type, "tnd-stats");
  assert.equal(body.node, "site-a");
  assert.equal(body.connected, true);
  assert.equal(typeof body.status, "string");
  assert.equal(body.summary && typeof body.summary.rttP50, "number");
  assert.equal(body.performerCount, 0, "no performer data until #5");
  assert.equal(body.localWorst, null, "no local data until #5");

  leg.stop();
});

test("HubLeg: site-level fields come from the injected getters (#5's plug points)", async () => {
  const socket = new FakeSocket({ echoLatencyMs: 0 });
  const leg = makeLeg(socket, {
    announceIntervalMs: 5,
    performerCount: () => 4,
    localWorst: () => "yellow",
  });

  leg.start();
  socket.deliver("connect");
  await delay(10);

  const announce = socket.sent.find(([event]) => event === "relay");

  assert.equal(announce[1].performerCount, 4);
  assert.equal(announce[1].localWorst, "yellow");

  leg.stop();
});

test("HubLeg: relayed peer stats land in the roster; foreign types ignored", () => {
  const socket = new FakeSocket();
  const leg = makeLeg(socket);

  leg.start();
  socket.deliver("connect");

  socket.deliver("relay", statsBodyFrom("site-b", { status: "yellow", reason: "Jitter (IQR) 15.0 ms ≥ 10 ms" }));
  socket.deliver("relay", { type: "something-else", from: "site-x" });
  socket.deliver("relay", { type: "tnd-stats" }); // no from — dropped

  const snapshot = leg.snapshot();

  assert.ok(snapshot.peers["site-b"], "the peer lands in the roster");
  assert.equal(snapshot.peers["site-b"].status, "yellow");
  assert.equal(snapshot.peers["site-b"].reason, "Jitter (IQR) 15.0 ms ≥ 10 ms");
  assert.equal(snapshot.peers["site-b"].summary.rttP50, 41);
  assert.equal(snapshot.peers["site-b"].performerCount, 3);
  assert.equal(snapshot.peers["site-b"].connected, true);
  assert.equal(snapshot.peers["site-x"], undefined, "foreign relay types are ignored");

  leg.stop();
});

test("HubLeg: a silent peer goes offline, then is pruned from the roster", () => {
  let clock = 100000;
  const socket = new FakeSocket();
  const leg = makeLeg(socket, {
    now: () => clock,
    peerOfflineMs: 5000,
    peerPruneMs: 30000,
  });

  leg.start();
  socket.deliver("connect");
  socket.deliver("relay", statsBodyFrom("site-b"));

  assert.equal(leg.snapshot().peers["site-b"].connected, true);

  clock += 5001; // past the offline threshold
  const offline = leg.snapshot().peers["site-b"];

  assert.equal(offline.connected, false, "5 s of silence → shown offline");
  assert.ok(offline.agoMs >= 5000);

  clock += 25001; // past the prune threshold
  assert.equal(
    leg.snapshot().peers["site-b"],
    undefined,
    "30 s of silence → pruned from the roster",
  );

  leg.stop();
});
