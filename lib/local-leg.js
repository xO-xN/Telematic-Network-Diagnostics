// Local-leg measurement (issue #5): every performer's link to THIS
// score server, measured continuously over the LAN.
//
// Ported from the sibling repo Local-Network-Diagnostics (the local
// leg's reference implementation — lib/diagnostics.js), with the TND
// deltas the telematic topology needs:
//
//   - Always on. LND's monitor starts and stops the test; here a
//     performer that joins is measured immediately and for as long as
//     it stays (the demo: a phone connects and is being probed before
//     its operator touches anything).
//   - siteSummary() instead of LND's Overall. The site's local-leg
//     verdict for the FLOWER view must include DISCONNECTED performers
//     (their cards are Red) — the other site's monitor has to read
//     "it's A's local leg", which an online-only worst would hide.
//     This is the one deliberate divergence from LND's banner rule.
//   - The summary also carries the site's representative local p50
//     (worst online performer — the conservative segment for the
//     derived performer-pair sum) and the online performer count.
//
// Everything else is LND verbatim, thresholds included: on a LAN the
// latency MAGNITUDE participates in the coloring (RTT p95 ≥ 100 ms is
// Yellow) — the exact opposite of the hub leg's rule (lib/hub-leg.js:
// intercontinental distance must never color), and the reason this
// module exists instead of reusing HubLeg.
//
// Layers:
//   percentile / decideStatus  — tiny pure functions
//   MetricsCollector           — per-performer sliding window of RTT
//                                samples, timeouts, jitter (p95 of
//                                |ΔRTT|) and the per-burst-window
//                                timeout rate
//   StatusMachine              — per-performer status with the spec's
//                                priority order, Gray warm-up and
//                                hysteresis
//   LocalSession               — one collector + machine + event log
//                                per performer, plus siteSummary()
//
// The server owns all timers and sockets; this module is deterministic
// and depends on nothing but Node built-ins (and the shared copy).

const PROBE_INTERVAL_MS = 1000;
const BASELINE_TIMEOUT_MS = 500;

// Burst cycle (LND's constants): 2 s at 30 msg/s with a 200 ms
// timeout, then 2 s of baseline (1 Hz / 500 ms) — repeating forever.
const BURST_INTERVAL_MS = 1000 / 30; // ~33.3 ms → 30 probes/s
const BURST_TIMEOUT_MS = 200;
const BURST_PHASE_MS = 2000;
const CALM_PHASE_MS = 2000;

// Per-performer event log cap (Connected / Disconnected / Reconnected).
const MAX_EVENTS = 20;

// Event vocabulary comes from public/shared.js — the single source of
// truth the monitor page renders from too.
const shared = require("../public/shared");
const { STATUS, STATUS_RANK } = require("./status");

// Reasons are language-neutral keys (the server has no UI language —
// LND's pattern since its v0.3.0): the monitor page maps them through
// the copy table of the current locale (public/shared.js `copy` +
// lib/locale-follow.js). The status-line copy lives in the same
// tables' localStatus section.
const REASON = {
  warmup: "warmup",
  disconnected: "disconnected",
  consecutiveTimeouts: "consecutiveTimeouts",
  burstTimeoutRate: "burstTimeoutRate",
  jitter: "jitter",
  rtt: "rtt",
  timeout: "timeout",
  green: "green",
  outsideSafe: "outsideSafe",
};

// Nearest-rank percentile of a sample set. Returns null when empty.
// p95 of 20 samples is the 19th value, p50 the 10th (0-based).
function percentile(values, p) {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  );

  return sorted[index];
}

// The status decision, in strict priority order (highest first) —
// LND's rules verbatim:
//   1. Disconnected                    → Red
//   2. 3 consecutive probe timeouts    → Red
//   3. Burst timeout rate > 5%         → Red
//   4. Jitter p95 > 25 ms              → Yellow
//   5. RTT p95 > 100 ms                → Yellow
//   6. 1–2 consecutive timeouts        → Yellow
//   7. Green (jitter < 10, RTT < 50)   → Green
// Rule 6 fills a spec gap: ≥3 timeouts is Red, but a client that is
// currently timing out must not be Green (that would also let recovery
// credit accrue while the link is failing). Between the yellow and the
// green thresholds (e.g. RTT 50–100 ms) the client is not safe either, so
// it falls back to Yellow.
function decideStatus({
  disconnected,
  consecutiveTimeouts,
  burstTimeoutRate,
  jitterP95,
  rttP95,
}) {
  if (disconnected) {
    return { status: STATUS.RED, reason: REASON.disconnected };
  }

  if ((consecutiveTimeouts || 0) >= 3) {
    return { status: STATUS.RED, reason: REASON.consecutiveTimeouts };
  }

  if ((burstTimeoutRate || 0) > 0.05) {
    return { status: STATUS.RED, reason: REASON.burstTimeoutRate };
  }

  const jitter = jitterP95 ?? 0;
  const rtt = rttP95 ?? 0;

  if (jitter > 25) {
    return { status: STATUS.YELLOW, reason: REASON.jitter };
  }

  if (rtt > 100) {
    return { status: STATUS.YELLOW, reason: REASON.rtt };
  }

  if ((consecutiveTimeouts || 0) >= 1) {
    return { status: STATUS.YELLOW, reason: REASON.timeout };
  }

  if (jitter < 10 && rtt < 50) {
    return { status: STATUS.GREEN, reason: REASON.green };
  }

  return { status: STATUS.YELLOW, reason: REASON.outsideSafe };
}

// Per-performer metrics: a sliding window of RTT samples (RTT p50/p95,
// jitter = p95 of |RTTₙ − RTTₙ₋₁| within the window), timeout totals and
// the consecutive-timeout streak that drives the Red rule. Also the
// lifetime probe counters (acks/timeouts → loss rate) and the per-burst-
// window timeout rate (frozen when a burst window completes).
class MetricsCollector {
  constructor({ windowSize = 10 } = {}) {
    this.windowSize = windowSize;
    this.reset();
  }

  reset() {
    this.samples = [];
    this.timeouts = 0;
    this.consecutiveTimeouts = 0;
    this.lastRtt = null;
    this.lastProcessingMs = null;
    this.acks = 0;
    this.burstWindowTotal = 0;
    this.burstWindowTimeouts = 0;
    this.burstTimeoutRate = 0;
  }

  record(rttMs, processingMs = null) {
    this.samples.push(rttMs);

    if (this.samples.length > this.windowSize) {
      this.samples.shift();
    }

    this.consecutiveTimeouts = 0;
    this.lastRtt = rttMs;
    this.acks += 1;
    this.burstWindowTotal += 1;

    if (typeof processingMs === "number") {
      this.lastProcessingMs = processingMs;
    }
  }

  recordTimeout() {
    this.timeouts += 1;
    this.consecutiveTimeouts += 1;
    this.burstWindowTotal += 1;
    this.burstWindowTimeouts += 1;
  }

  // A new burst window starts counting probes from scratch.
  beginBurstWindow() {
    this.burstWindowTotal = 0;
    this.burstWindowTimeouts = 0;
  }

  // Freezes the completed window's timeout rate (0 for an empty window);
  // the rate stays visible until the next window completes.
  endBurstWindow() {
    this.burstTimeoutRate =
      this.burstWindowTotal === 0
        ? 0
        : this.burstWindowTimeouts / this.burstWindowTotal;
    this.burstWindowTotal = 0;
    this.burstWindowTimeouts = 0;
  }

  // Lifetime loss rate: timeouts / (acks + timeouts). Detail-panel only —
  // never feeds the status decision.
  get lossRate() {
    const total = this.acks + this.timeouts;

    return total === 0 ? 0 : this.timeouts / total;
  }

  get rttP50() {
    return percentile(this.samples, 0.5);
  }

  get rttP95() {
    return percentile(this.samples, 0.95);
  }

  get jitterP95() {
    if (this.samples.length < 2) {
      return 0;
    }

    const diffs = [];

    for (let i = 1; i < this.samples.length; i += 1) {
      diffs.push(Math.abs(this.samples[i] - this.samples[i - 1]));
    }

    return percentile(diffs, 0.95);
  }
}

// Per-performer status decision, evaluated once per probe cycle. Newly
// joined performers stay Gray (warming up) for the first `warmupCycles`
// cycles and until the first sample exists; recovery from Red/Yellow to
// Green needs `hysteresisCycles` consecutive good cycles (any bad cycle
// resets the counter); worsening is instant.
class StatusMachine {
  constructor({ warmupCycles = 2, hysteresisCycles = 10 } = {}) {
    this.warmupCycles = warmupCycles;
    this.hysteresisCycles = hysteresisCycles;
    this.reset();
  }

  reset() {
    this.cycles = 0;
    this.goodCycles = 0;
    this.status = STATUS.GRAY;
    this.reason = REASON.warmup;
  }

  // One probe cycle. Input: { disconnected, consecutiveTimeouts,
  // burstTimeoutRate, jitterP95, rttP95, samples }.
  cycle(input) {
    this.cycles += 1;

    // Disconnected is the priority-1 rule and bypasses the warm-up
    // gray guard: a performer that drops off is Red immediately.
    if (input.disconnected) {
      this.goodCycles = 0;
      this.status = STATUS.RED;
      this.reason = REASON.disconnected;
      return this.status;
    }

    const samples = input.samples || 0;
    const consecutive = input.consecutiveTimeouts || 0;

    // Gray while warming up, and while there is no evidence either way
    // (no ack yet, but not enough timeouts to be Red either).
    if (this.cycles < this.warmupCycles || (samples < 1 && consecutive < 3)) {
      this.status = STATUS.GRAY;
      this.reason = REASON.warmup;
      return this.status;
    }

    const instant = decideStatus(input);

    if (instant.status === STATUS.GREEN) {
      if (this.status === STATUS.RED || this.status === STATUS.YELLOW) {
        this.goodCycles += 1;

        if (this.goodCycles >= this.hysteresisCycles) {
          this.goodCycles = 0;
          this.status = STATUS.GREEN;
          this.reason = instant.reason;
        }

        return this.status;
      }

      this.status = STATUS.GREEN;
      this.reason = instant.reason;
      return this.status;
    }

    this.goodCycles = 0;
    this.status = instant.status;
    this.reason = instant.reason;
    return this.status;
  }
}

// One collector + machine + event log per performer that has joined.
// The measurement is ALWAYS on (TND's delta from LND): there is no
// start/stop — joining a site means being probed. Disconnected
// performers stay in the session as Red cards; only removeClient drops
// one, and the server never calls it (a rejoin reuses the id via the
// claim token, arriving as a reconnect).
class LocalSession {
  constructor({
    windowSize = 10,
    warmupCycles = 2,
    hysteresisCycles = 10,
  } = {}) {
    this.windowSize = windowSize;
    this.warmupCycles = warmupCycles;
    this.hysteresisCycles = hysteresisCycles;
    this.phase = "calm"; // set by the server's phase timer
    this.clients = new Map(); // id -> { collector, machine, connected, events }
  }

  setPhase(phase) {
    this.phase = phase;
  }

  // Join (or rejoin — the server restores the id from the claim token).
  // A brand-new id gets a "connected" event; an id that already exists
  // is a reconnect: the metrics and machine start over (Gray warm-up)
  // and a "reconnected" event is appended. The event log itself is
  // never cleared.
  addClient(id, now = 0) {
    const existing = this.clients.get(id);

    if (existing) {
      existing.connected = true;
      existing.collector.reset();
      existing.machine.reset();
      this.pushEvent(existing, shared.localEvents.reconnected, now);
      return;
    }

    const entry = {
      collector: new MetricsCollector({ windowSize: this.windowSize }),
      machine: new StatusMachine({
        warmupCycles: this.warmupCycles,
        hysteresisCycles: this.hysteresisCycles,
      }),
      connected: true,
      events: [],
    };

    this.clients.set(id, entry);
    this.pushEvent(entry, shared.localEvents.connected, now);
  }

  // The performer's socket dropped: the card stays, flips Red
  // immediately and the disconnect is recorded. No-op when already
  // disconnected.
  disconnectClient(id, now = 0) {
    const entry = this.clients.get(id);

    if (!entry || !entry.connected) {
      return;
    }

    entry.connected = false;
    this.pushEvent(entry, shared.localEvents.disconnected, now);
    entry.machine.cycle({ disconnected: true });
  }

  removeClient(id) {
    this.clients.delete(id);
  }

  pushEvent(entry, type, now) {
    entry.events.push({ type, at: now });

    if (entry.events.length > MAX_EVENTS) {
      entry.events.shift();
    }
  }

  // A new burst window starts counting probes for every performer.
  beginBurstWindow() {
    for (const entry of this.clients.values()) {
      entry.collector.beginBurstWindow();
    }
  }

  // Freezes each performer's burst-window timeout rate (the server
  // calls this when the burst phase ends).
  endBurstWindow() {
    for (const entry of this.clients.values()) {
      entry.collector.endBurstWindow();
    }
  }

  recordAck(id, rttMs, processingMs = null) {
    const entry = this.clients.get(id);

    if (entry) {
      entry.collector.record(rttMs, processingMs);
    }
  }

  recordTimeout(id) {
    const entry = this.clients.get(id);

    if (entry) {
      entry.collector.recordTimeout();
    }
  }

  // One probe cycle for every tracked performer.
  cycleAll() {
    for (const entry of this.clients.values()) {
      const metrics = entry.collector;

      entry.machine.cycle({
        disconnected: !entry.connected,
        consecutiveTimeouts: metrics.consecutiveTimeouts,
        burstTimeoutRate: metrics.burstTimeoutRate,
        jitterP95: metrics.jitterP95,
        rttP95: metrics.rttP95,
        samples: metrics.samples.length,
      });
    }
  }

  // The site's local-leg summary — what the flower view consumes:
  //   status     worst status among ALL performers (a disconnected
  //              performer's Red card counts: the other site's monitor
  //              must read "it's A's local leg"). Null when no
  //              performer has ever joined (no data — the star's outer
  //              ring stays gray).
  //   p50        the WORST online performer's RTT p50 (the
  //              conservative local segment for the derived
  //              performer-pair sum). Null while no online performer
  //              has a sample.
  //   performers the online count (a disconnected performer is not
  //              performing).
  siteSummary() {
    if (this.clients.size === 0) {
      return { status: null, p50: null, performers: 0 };
    }

    let worstRank = -1;
    let status = null;
    let p50 = null;
    let performers = 0;

    for (const entry of this.clients.values()) {
      const rank = STATUS_RANK[entry.machine.status] ?? 0;

      if (rank > worstRank) {
        worstRank = rank;
        status = entry.machine.status;
      }

      if (entry.connected) {
        performers += 1;

        if (typeof entry.collector.rttP50 === "number") {
          p50 = Math.max(p50 ?? 0, entry.collector.rttP50);
        }
      }
    }

    return {
      status,
      p50,
      performers,
    };
  }

  snapshot(now = 0) {
    const clients = {};

    for (const [id, entry] of this.clients) {
      const metrics = entry.collector;
      const last = entry.events[entry.events.length - 1] || null;

      clients[id] = {
        status: entry.machine.status,
        reason: entry.machine.reason,
        connected: entry.connected,
        lastEvent: last
          ? {
              type: last.type,
              at: last.at,
              agoMs: now ? Math.max(0, now - last.at) : 0,
            }
          : null,
        events: entry.events.map((event) => ({
          type: event.type,
          at: event.at,
          agoMs: now ? Math.max(0, now - event.at) : 0,
        })),
        metrics: {
          rttP50: metrics.rttP50,
          rttP95: metrics.rttP95,
          jitterP95: metrics.jitterP95,
          lastRtt: metrics.lastRtt,
          lastProcessingMs: metrics.lastProcessingMs,
          timeouts: metrics.timeouts,
          consecutiveTimeouts: metrics.consecutiveTimeouts,
          samples: metrics.samples.length,
          acks: metrics.acks,
          lossRate: metrics.lossRate,
          burstTimeoutRate: metrics.burstTimeoutRate,
        },
      };
    }

    return {
      probing: this.phase,
      ...this.siteSummary(),
      clients,
    };
  }
}

module.exports = {
  STATUS,
  percentile,
  decideStatus,
  MetricsCollector,
  StatusMachine,
  LocalSession,
  PROBE_INTERVAL_MS,
  BASELINE_TIMEOUT_MS,
  BURST_INTERVAL_MS,
  BURST_TIMEOUT_MS,
  BURST_PHASE_MS,
  CALM_PHASE_MS,
};
