// Unit tests for lib/local-leg.js (issue #5) — the LND port: metrics,
// status rules, hysteresis, and the site summary the flower view
// consumes.
//
// The state machine and metric math are pure (no timers, no sockets),
// so every LND rule is testable without a server. The TND deltas
// (always-on session, siteSummary including disconnected performers)
// are pinned here too.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  STATUS,
  percentile,
  decideStatus,
  MetricsCollector,
  StatusMachine,
  LocalSession,
} = require("../lib/local-leg");

// ------------------------------------------------------------
// percentile
// ------------------------------------------------------------

test("percentile: nearest-rank p50/p95 over unsorted values", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([10], 0.5), 10);
  assert.equal(percentile([4, 1, 3, 2], 0.5), 2); // ceil(0.5*4) - 1 = index 1
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);

  const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(percentile(twenty, 0.95), 19); // index 18
  assert.equal(percentile(twenty, 0.5), 10); // index 9
});

// ------------------------------------------------------------
// MetricsCollector
// ------------------------------------------------------------

test("MetricsCollector: sliding window, jitter from adjacent RTT diffs", () => {
  const collector = new MetricsCollector({ windowSize: 3 });

  assert.equal(collector.rttP50, null);
  assert.equal(collector.jitterP95, 0);

  collector.record(10);
  collector.record(20);
  assert.equal(collector.jitterP95, 10); // single diff [10] → p95 10

  collector.record(30);
  collector.record(40); // window is now [20, 30, 40]

  assert.equal(collector.samples.length, 3);
  assert.equal(collector.rttP50, 30);
  assert.equal(collector.rttP95, 40);
  assert.equal(collector.jitterP95, 10); // diffs [10, 10]
  assert.equal(collector.lastRtt, 40);

  collector.record(7, 1.5);
  assert.equal(collector.lastProcessingMs, 1.5);
});

test("MetricsCollector: timeouts count up, a successful ack resets the streak", () => {
  const collector = new MetricsCollector();

  collector.recordTimeout();
  collector.recordTimeout();
  assert.equal(collector.timeouts, 2);
  assert.equal(collector.consecutiveTimeouts, 2);

  collector.record(5);
  assert.equal(collector.consecutiveTimeouts, 0);
  assert.equal(collector.timeouts, 2); // total is not reset
});

test("MetricsCollector: reset clears everything", () => {
  const collector = new MetricsCollector();

  collector.record(5, 1);
  collector.recordTimeout();
  collector.reset();

  assert.equal(collector.rttP50, null);
  assert.equal(collector.rttP95, null);
  assert.equal(collector.jitterP95, 0);
  assert.equal(collector.timeouts, 0);
  assert.equal(collector.consecutiveTimeouts, 0);
  assert.equal(collector.samples.length, 0);
  assert.equal(collector.lastRtt, null);
  assert.equal(collector.acks, 0);
  assert.equal(collector.lossRate, 0);
  assert.equal(collector.burstTimeoutRate, 0);
});

test("MetricsCollector: loss rate = timeouts / (acks + timeouts)", () => {
  const collector = new MetricsCollector();

  assert.equal(collector.lossRate, 0, "no probes yet → 0");

  collector.record(5);
  collector.record(5);
  collector.record(5);
  assert.equal(collector.acks, 3);
  assert.equal(collector.lossRate, 0);

  collector.recordTimeout();
  assert.equal(collector.timeouts, 1);
  assert.equal(collector.lossRate, 0.25, "1 timeout out of 4 probes");
});

test("MetricsCollector: burst timeout rate is computed per completed burst window", () => {
  const collector = new MetricsCollector();

  assert.equal(collector.burstTimeoutRate, 0, "no window completed yet");

  collector.beginBurstWindow();
  collector.record(5);
  collector.record(5);
  collector.recordTimeout();
  collector.recordTimeout();
  // During the window the rate is still the last completed window's (0).
  assert.equal(collector.burstTimeoutRate, 0);

  collector.endBurstWindow();
  assert.equal(collector.burstTimeoutRate, 0.5, "2 timeouts out of 4 probes");

  // A new window starts from scratch; the frozen rate survives until the
  // next window completes.
  collector.beginBurstWindow();
  collector.record(5);
  assert.equal(collector.burstTimeoutRate, 0.5);
  collector.endBurstWindow();
  assert.equal(collector.burstTimeoutRate, 0, "1 ack, 0 timeouts");

  // An empty window keeps the previous rate rather than dividing by zero.
  collector.beginBurstWindow();
  collector.endBurstWindow();
  assert.equal(collector.burstTimeoutRate, 0);
});

// ------------------------------------------------------------
// decideStatus — LND's priority order, latency INCLUDED (the local
// leg's defining difference from the hub leg)
// ------------------------------------------------------------

const good = {
  disconnected: false,
  consecutiveTimeouts: 0,
  burstTimeoutRate: 0,
  jitterP95: 5,
  rttP95: 40,
  samples: 1,
};

test("decideStatus: Green when every metric is inside the safe thresholds", () => {
  assert.deepEqual(decideStatus(good), {
    status: STATUS.GREEN,
    reason: "green",
  });
});

test("decideStatus: LAN latency participates — RTT p95 above 100 ms is Yellow", () => {
  // The structural opposite of the hub leg (lib/hub-leg.js: no RTT
  // input at all). A slow LAN reply IS a local problem.
  assert.equal(decideStatus({ ...good, rttP95: 101 }).status, STATUS.YELLOW);
  assert.equal(decideStatus({ ...good, rttP95: 120 }).reason, "rtt");
  // …but a merely middling RTT is fine when stable.
  assert.equal(decideStatus({ ...good, rttP95: 49 }).status, STATUS.GREEN);
});

test("decideStatus: priority order, highest first", () => {
  assert.equal(decideStatus({ ...good, disconnected: true }).status, STATUS.RED);
  assert.equal(
    decideStatus({ ...good, disconnected: true, rttP95: 0 }).status,
    STATUS.RED,
    "disconnected wins over every other rule",
  );

  assert.equal(
    decideStatus({ ...good, consecutiveTimeouts: 3 }).status,
    STATUS.RED,
  );
  assert.equal(
    decideStatus({ ...good, consecutiveTimeouts: 2 }).status,
    STATUS.YELLOW,
    "1–2 consecutive timeouts is not Red yet, but not Green either",
  );

  assert.equal(
    decideStatus({ ...good, burstTimeoutRate: 0.06 }).status,
    STATUS.RED,
  );
  assert.equal(
    decideStatus({ ...good, burstTimeoutRate: 0.05 }).status,
    STATUS.GREEN,
    "exactly 5% is not > 5%",
  );

  assert.equal(decideStatus({ ...good, jitterP95: 26 }).status, STATUS.YELLOW);
});

test("decideStatus: between yellow and green thresholds is Yellow", () => {
  // Green requires jitter < 10 AND rtt p95 < 50; anything above that but
  // below the yellow thresholds still fails the green check.
  assert.equal(decideStatus({ ...good, jitterP95: 12 }).status, STATUS.YELLOW);
  assert.equal(decideStatus({ ...good, jitterP95: 10 }).status, STATUS.YELLOW); // not < 10
  assert.equal(decideStatus({ ...good, rttP95: 60 }).status, STATUS.YELLOW);
  assert.equal(decideStatus({ ...good, rttP95: 100 }).status, STATUS.YELLOW); // not < 50
});

test("decideStatus: missing metrics count as zero, not as violations", () => {
  assert.equal(decideStatus({ ...good, jitterP95: null, rttP95: null }).status, STATUS.GREEN);
});

test("decideStatus: 1–2 consecutive timeouts are Yellow, never Green", () => {
  assert.equal(decideStatus({ ...good, consecutiveTimeouts: 1 }).status, STATUS.YELLOW);
  assert.equal(decideStatus({ ...good, consecutiveTimeouts: 2 }).status, STATUS.YELLOW);
  assert.equal(decideStatus({ ...good, consecutiveTimeouts: 1 }).reason, "timeout");
});

test("decideStatus: reasons describe the winning rule", () => {
  assert.equal(decideStatus({ ...good, disconnected: true }).reason, "disconnected");
  assert.equal(
    decideStatus({ ...good, consecutiveTimeouts: 3 }).reason,
    "consecutiveTimeouts",
  );
  assert.equal(
    decideStatus({ ...good, burstTimeoutRate: 0.06 }).reason,
    "burstTimeoutRate",
  );
  assert.equal(decideStatus({ ...good, jitterP95: 26 }).reason, "jitter");
  assert.equal(decideStatus({ ...good, rttP95: 60 }).reason, "outsideSafe");
});

// ------------------------------------------------------------
// StatusMachine — warm-up, rules, hysteresis
// ------------------------------------------------------------

test("StatusMachine: gray while warming up, then green", () => {
  const machine = new StatusMachine({ warmupCycles: 2 });

  assert.equal(machine.status, STATUS.GRAY);

  // Even a red-level input does not skip the warm-up.
  machine.cycle({ ...good, consecutiveTimeouts: 9 });
  assert.equal(machine.status, STATUS.GRAY);

  machine.cycle(good);
  assert.equal(machine.status, STATUS.GREEN);
  assert.equal(machine.reason, "green");
});

test("StatusMachine: gray until there is evidence, red still reachable without any ack", () => {
  const machine = new StatusMachine({ warmupCycles: 1 });

  // No ack yet and no timeouts → gray (warming up).
  machine.cycle({ ...good, samples: 0 });
  assert.equal(machine.status, STATUS.GRAY);

  // One or two timeouts with zero acks: still no evidence → gray.
  machine.cycle({ ...good, samples: 0, consecutiveTimeouts: 1 });
  assert.equal(machine.status, STATUS.GRAY);

  // Three consecutive timeouts with zero acks → Red (must not be stuck gray).
  machine.cycle({ ...good, samples: 0, consecutiveTimeouts: 3 });
  assert.equal(machine.status, STATUS.RED);
});

test("StatusMachine: red after 3 consecutive timeouts, yellow on jitter/rtt", () => {
  const machine = new StatusMachine({ warmupCycles: 1 });

  machine.cycle({ ...good, samples: 1 });
  assert.equal(machine.status, STATUS.GREEN);

  machine.cycle({ ...good, consecutiveTimeouts: 3, samples: 1 });
  assert.equal(machine.status, STATUS.RED);
  assert.equal(machine.reason, "consecutiveTimeouts");

  const yellow = new StatusMachine({ warmupCycles: 1 });
  yellow.cycle({ ...good, jitterP95: 30, samples: 1 });
  assert.equal(yellow.status, STATUS.YELLOW);
  assert.equal(yellow.reason, "jitter");
});

test("StatusMachine: worsening is instant, recovery needs 10 good cycles", () => {
  const machine = new StatusMachine({ warmupCycles: 1, hysteresisCycles: 10 });

  machine.cycle({ ...good, samples: 1 });
  assert.equal(machine.status, STATUS.GREEN);

  // Instant worsening.
  machine.cycle({ ...good, rttP95: 120, samples: 1 });
  assert.equal(machine.status, STATUS.YELLOW);
  assert.equal(machine.goodCycles, 0);

  // 9 good cycles: still Yellow, counter climbing.
  for (let i = 0; i < 9; i += 1) {
    machine.cycle({ ...good, samples: 1 });
  }
  assert.equal(machine.status, STATUS.YELLOW);
  assert.equal(machine.goodCycles, 9);

  // The 10th consecutive good cycle recovers to Green.
  machine.cycle({ ...good, samples: 1 });
  assert.equal(machine.status, STATUS.GREEN);
  assert.equal(machine.goodCycles, 0);
});

test("StatusMachine: any bad cycle resets the recovery counter", () => {
  const machine = new StatusMachine({ warmupCycles: 1, hysteresisCycles: 10 });

  machine.cycle({ ...good, consecutiveTimeouts: 3, samples: 1 });
  assert.equal(machine.status, STATUS.RED);

  for (let i = 0; i < 5; i += 1) {
    machine.cycle({ ...good, samples: 1 });
  }
  assert.equal(machine.goodCycles, 5);

  machine.cycle({ ...good, jitterP95: 40, samples: 1 });
  assert.equal(machine.status, STATUS.YELLOW);
  assert.equal(machine.goodCycles, 0);

  for (let i = 0; i < 9; i += 1) {
    machine.cycle({ ...good, samples: 1 });
  }
  assert.equal(machine.status, STATUS.YELLOW, "counter restarted from 0");

  machine.cycle({ ...good, samples: 1 });
  assert.equal(machine.status, STATUS.GREEN);
});

test("StatusMachine: a timing-out client is not Green and earns no recovery credit", () => {
  const machine = new StatusMachine({ warmupCycles: 1, hysteresisCycles: 10 });

  machine.cycle({ ...good, consecutiveTimeouts: 3, samples: 1 });
  assert.equal(machine.status, STATUS.RED);

  for (let i = 0; i < 4; i += 1) {
    machine.cycle({ ...good, samples: 1 });
  }
  assert.equal(machine.goodCycles, 4);

  // One timeout cycle: instant status is Yellow, so it neither shows Green
  // nor counts towards the 10 good cycles.
  machine.cycle({ ...good, consecutiveTimeouts: 1, samples: 1 });
  assert.equal(machine.status, STATUS.YELLOW);
  assert.equal(machine.goodCycles, 0, "timeout cycle must not count as good");
});

test("StatusMachine: reset returns to gray", () => {
  const machine = new StatusMachine({ warmupCycles: 1 });

  machine.cycle({ ...good, consecutiveTimeouts: 3, samples: 1 });
  assert.equal(machine.status, STATUS.RED);

  machine.reset();
  assert.equal(machine.status, STATUS.GRAY);
  assert.equal(machine.cycles, 0);
});

test("StatusMachine: disconnected is Red immediately, even during warm-up", () => {
  const machine = new StatusMachine({ warmupCycles: 2 });

  // A disconnect skips the warm-up gray guard — priority 1 of the spec.
  machine.cycle({ ...good, disconnected: true, samples: 0 });
  assert.equal(machine.status, STATUS.RED);
  assert.equal(machine.reason, "disconnected");

  // From Green, a disconnect flips Red instantly and resets recovery credit.
  const healthy = new StatusMachine({ warmupCycles: 1 });
  healthy.cycle({ ...good, samples: 1 });
  assert.equal(healthy.status, STATUS.GREEN);

  healthy.cycle({ ...good, disconnected: true, samples: 1 });
  assert.equal(healthy.status, STATUS.RED);
  assert.equal(healthy.goodCycles, 0);
});

// ------------------------------------------------------------
// LocalSession — the always-on session + the site summary
// ------------------------------------------------------------

test("LocalSession: per-performer statuses; gray does not drag the site summary", () => {
  const session = new LocalSession();
  session.setPhase("burst"); // the server's cycle starts in burst

  session.addClient(1);
  session.addClient(2);

  session.recordAck(1, 2);
  session.recordAck(1, 3);
  session.cycleAll(); // cycle 1
  session.cycleAll(); // cycle 2

  const snap = session.snapshot();

  assert.equal(snap.clients["1"].status, STATUS.GREEN);
  assert.equal(typeof snap.clients["1"].metrics.rttP50, "number");
  assert.equal(snap.clients["2"].status, STATUS.GRAY, "no samples yet → gray");
  assert.equal(snap.status, STATUS.GREEN, "gray performer does not drag the site");
});

test("LocalSession: site summary status = worst across performers", () => {
  const session = new LocalSession();
  session.setPhase("burst");

  session.addClient(1);
  session.addClient(2);
  session.addClient(3);

  session.recordAck(1, 2);
  session.recordAck(2, 2);
  session.recordAck(3, 2);
  session.cycleAll();
  session.cycleAll();
  assert.equal(session.siteSummary().status, STATUS.GREEN);

  // Performer 2 degrades to Yellow (jitter from swinging RTTs).
  session.recordAck(2, 2);
  session.recordAck(2, 40);
  session.recordAck(2, 2);
  session.cycleAll();
  assert.equal(session.siteSummary().status, STATUS.YELLOW);

  // Performer 3 hits Red via 3 consecutive timeouts.
  session.recordTimeout(3);
  session.recordTimeout(3);
  session.recordTimeout(3);
  session.cycleAll();
  assert.equal(session.siteSummary().status, STATUS.RED);
});

test("LocalSession: a DISCONNECTED performer's Red counts in the site summary (the #5 demo)", () => {
  // The deliberate TND divergence from LND's banner: the flower view
  // must read "it's A's local leg" when A's phone drops off Wi-Fi —
  // an online-only worst would hide exactly that.
  const session = new LocalSession();
  session.setPhase("burst");

  session.addClient(1);
  session.addClient(2);

  session.recordAck(1, 2);
  session.recordAck(1, 3);
  session.cycleAll();
  session.cycleAll();
  assert.equal(session.siteSummary().status, STATUS.GREEN);

  session.disconnectClient(2, 1000);
  assert.equal(session.snapshot().clients["2"].status, STATUS.RED);

  assert.equal(
    session.siteSummary().status,
    STATUS.RED,
    "the Red disconnected performer must surface to the flower view",
  );
  assert.equal(session.siteSummary().performers, 1, "only the online one performs");
});

test("LocalSession: siteSummary — empty session, p50 = worst online median", () => {
  const session = new LocalSession();

  assert.deepEqual(session.siteSummary(), {
    status: null,
    p50: null,
    performers: 0,
  });

  session.addClient(1);
  session.addClient(2);
  assert.deepEqual(
    session.siteSummary(),
    { status: "gray", p50: null, performers: 2 },
    "warming-up performers: gray site, no number yet",
  );

  session.recordAck(1, 4);
  session.recordAck(1, 6);
  session.recordAck(2, 20);
  session.recordAck(2, 20);

  const summary = session.siteSummary();

  assert.equal(summary.p50, 20, "the WORST online performer's p50 (conservative segment)");
  assert.equal(summary.performers, 2);

  // A disconnected performer's stale samples leave the summary.
  session.disconnectClient(2, 2000);
  assert.equal(session.siteSummary().p50, 4, "nearest-rank p50 of [4, 6]");
  assert.equal(session.siteSummary().performers, 1);
});

test("LocalSession: addClient records Connected; re-adding the same id is a Reconnect that resets to gray", () => {
  const session = new LocalSession();
  session.setPhase("burst");

  session.addClient(1, 1000);

  let snap = session.snapshot();
  assert.equal(snap.clients["1"].lastEvent.type, "connected");
  assert.equal(snap.clients["1"].lastEvent.at, 1000);
  assert.equal(snap.clients["1"].events.length, 1);

  session.recordAck(1, 2);
  session.recordAck(1, 3);
  session.cycleAll();
  session.cycleAll();
  assert.equal(session.snapshot().clients["1"].status, STATUS.GREEN);

  // Same id joins again (claim token restored the identity): the machine
  // and metrics start over, a "reconnected" event is appended.
  session.addClient(1, 5000);

  snap = session.snapshot();
  assert.equal(snap.clients["1"].status, STATUS.GRAY);
  assert.equal(snap.clients["1"].metrics.samples, 0);
  assert.equal(snap.clients["1"].lastEvent.type, "reconnected");
  assert.deepEqual(
    snap.clients["1"].events.map((event) => event.type),
    ["connected", "reconnected"],
  );
});

test("LocalSession: disconnectClient flips Red immediately and records the event", () => {
  const session = new LocalSession();
  session.setPhase("burst");

  session.addClient(1, 1000);
  session.recordAck(1, 2);
  session.recordAck(1, 3);
  session.cycleAll();
  session.cycleAll();
  assert.equal(session.snapshot().clients["1"].status, STATUS.GREEN);

  session.disconnectClient(1, 4000);

  const snap = session.snapshot();
  assert.equal(snap.clients["1"].status, STATUS.RED);
  assert.equal(snap.clients["1"].reason, "disconnected");
  assert.equal(snap.clients["1"].connected, false);
  assert.equal(snap.clients["1"].lastEvent.type, "disconnected");
  assert.equal(snap.clients["1"].lastEvent.at, 4000);

  // A second disconnect call is a no-op (no duplicate events).
  session.disconnectClient(1, 4500);
  assert.equal(session.snapshot().clients["1"].events.length, 2);

  // Reconnect restores the identity and returns through warm-up.
  session.addClient(1, 5000);
  session.cycleAll();
  assert.equal(session.snapshot().clients["1"].status, STATUS.GRAY);
});

test("LocalSession: burst window stats feed the status decision", () => {
  const session = new LocalSession({ warmupCycles: 1 });

  session.addClient(1);
  session.setPhase("burst");
  session.beginBurstWindow();

  // Interleaved acks/timeouts: 5 acks + 5 timeouts → 50% burst loss with a
  // consecutive-timeout streak of only 1, so the burst rule is the winner.
  for (let i = 0; i < 5; i += 1) {
    session.recordAck(1, 5);
    session.recordTimeout(1);
  }

  session.endBurstWindow();
  session.cycleAll();

  const snap = session.snapshot();
  assert.equal(snap.probing, "burst");
  assert.equal(snap.clients["1"].metrics.burstTimeoutRate, 0.5);
  assert.equal(snap.clients["1"].status, STATUS.RED);
  assert.equal(snap.clients["1"].reason, "burstTimeoutRate");
});

test("LocalSession: snapshot exposes the site summary, loss rate, processing time and events", () => {
  const session = new LocalSession();

  session.addClient(1, 500);
  session.recordAck(1, 7, 1.25);
  session.recordAck(1, 9, 2.5);
  session.recordTimeout(1);

  const snap = session.snapshot(900);
  const metrics = snap.clients["1"].metrics;

  assert.equal(metrics.acks, 2);
  assert.equal(metrics.lossRate, 1 / 3);
  assert.equal(metrics.lastProcessingMs, 2.5);
  assert.equal(snap.clients["1"].lastEvent.type, "connected");
  assert.equal(snap.clients["1"].lastEvent.agoMs, 400, "900 - 500");
  assert.equal(snap.clients["1"].events.length, 1);

  // The site summary rides the snapshot top-level (what the server
  // relays and the monitor renders from).
  assert.equal(snap.status, "gray");
  assert.equal(snap.performers, 1);
  assert.equal(snap.probing, "calm");
});

test("MetricsCollector: jitter ignores the phase step and the wake-up sample", () => {
  const collector = new MetricsCollector({ windowSize: 10 });

  // A hot burst block; the calm block sits at the woken (idle) level — the
  // Wi-Fi power-save wake-up every idle second adds to a 1 Hz probe.
  [3, 3, 3, 3, 3, 3, 3, 3].forEach((rtt) => {
    collector.record(rtt, null, "burst");
  });
  [80, 80].forEach((rtt) => collector.record(rtt, null, "calm"));

  // Legacy whole-window math diffed 3 → 80 and reported the phase step
  // itself as ~77 ms of jitter for the whole calm phase. Scoped: only
  // same-phase, adjacent, non-wake-up pairs count.
  assert.equal(collector.jitterP95, 0);
  assert.equal(collector.rttP95, 3, "calm samples stay out of the RTT metrics");
  assert.equal(collector.burstSampleCount, 8);
  assert.equal(collector.lastRtt, 80, "the raw latest probe is untouched");
});

test("MetricsCollector: a burst that opens with a wake-up sample stays clean", () => {
  const collector = new MetricsCollector({ windowSize: 10 });

  [80, 80].forEach((rtt) => collector.record(rtt, null, "calm"));
  // The first burst probe pays the wake-up; the radio is hot from the next.
  collector.record(80, null, "burst");
  [3, 3, 3].forEach((rtt) => collector.record(rtt, null, "burst"));

  assert.equal(collector.jitterP95, 0, "the wake-up sample forms no pair");
  assert.equal(collector.rttP95, 3, "nor enters the RTT percentiles");
  assert.equal(collector.burstSampleCount, 3);
});

test("LocalSession: the calm wake-up step never flags a healthy performer", () => {
  const session = new LocalSession();
  session.setPhase("burst");
  session.addClient(1);

  for (let i = 0; i < 8; i += 1) {
    session.recordAck(1, 3);
  }
  session.cycleAll();
  session.cycleAll();
  assert.equal(session.siteSummary().status, STATUS.GREEN);

  // Calm: every idle second lets Wi-Fi power save add its wake-up delay,
  // so each 1 Hz probe reads ~80 ms on an otherwise perfect link. The
  // legacy window kept the burst samples beside them, read the phase step
  // (~77 ms) off them as jitter and flagged Yellow for the whole calm
  // phase — and the 10-cycle hysteresis could never recover to Green.
  session.setPhase("calm");
  session.recordAck(1, 80);
  session.recordAck(1, 80);
  session.cycleAll();
  session.cycleAll();

  let snap = session.snapshot();
  assert.equal(snap.status, STATUS.GREEN);
  assert.equal(snap.clients["1"].metrics.jitterP95, 0);
  assert.equal(snap.clients["1"].metrics.rttP95, 3);

  // The next burst opens with a wake-up sample before the radio is hot
  // again; it must not swing the metrics either.
  session.setPhase("burst");
  session.recordAck(1, 80);
  session.recordAck(1, 3);
  session.recordAck(1, 3);
  session.cycleAll();

  snap = session.snapshot();
  assert.equal(snap.status, STATUS.GREEN);
  assert.equal(snap.clients["1"].metrics.jitterP95, 0);
  assert.equal(snap.clients["1"].metrics.rttP95, 3);
});

test("LocalSession: a performer joining mid-calm stays Gray until load evidence", () => {
  const session = new LocalSession();
  session.setPhase("calm");
  session.addClient(1);

  session.recordAck(1, 80);
  session.recordAck(1, 80);
  session.cycleAll();
  session.cycleAll();
  session.cycleAll();
  assert.equal(
    session.snapshot().clients["1"].status,
    STATUS.GRAY,
    "calm acks alone are not show-condition evidence",
  );
});
