// Hub-leg measurement (issue #3): the score server's outbound link to
// the public hub, measured continuously.
//
// Layers:
//   percentile / hubQuality / summarizeWindow  — pure, table-testable
//   HubLeg                                     — owns the socket.io-client
//                                                connection, the 1 Hz
//                                                baseline probes, the
//                                                on-demand 30 msg/s
//                                                burst and the event log
//
// Core principle (parent issue #1): latency MAGNITUDE is reported as a
// number only — it never participates in the quality coloring. A high
// but stable RTT link can be tempered for; jitter, loss and reconnects
// are the hard problems. hubQuality's input therefore carries no
// RTT-level field at all — the exclusion is structural, not
// conventional.
//
// The server owns nothing here but wiring; the module depends only on
// Node built-ins plus an injectable socket factory for tests.

// ------------------------------------------------------------
// Constants (all timing values are INITIAL — calibration against a
// real two-node cross-internet deployment is an expected post-release
// step, not a hack; issue #1: "阈值常量标注初版、待两节点实测校准")
// ------------------------------------------------------------

const BASELINE_INTERVAL_MS = 1000; // continuous 1 Hz echo baseline
const BURST_INTERVAL_MS = 1000 / 30; // ~33.3 ms → 30 probes/s
const BURST_DURATION_MS = 5000; // one on-demand burst window
const PROBE_TIMEOUT_MS = 2000; // generous for intercontinental RTT
const WINDOW_MS = 15000; // rolling stats window
const WARMUP_SAMPLES = 5; // Gray until this many window samples
const WARMUP_LOSSES = 3; // …unless this many losses already stacked up

// Quality thresholds — 初版，待两节点实测校准.
// Green requires ALL good; any red-level metric (or unreachability) is
// Red; everything in between (including exactly one reconnect in the
// window) is Yellow.
const QUALITY_THRESHOLDS = {
  greenIqrMs: 10, // jitter (IQR) below → contributes to green
  yellowIqrMs: 30, // jitter at/above → red
  greenLossRate: 0.005, // loss below → contributes to green (0.5%)
  yellowLossRate: 0.03, // loss at/above → red (3%)
  redReconnects: 2, // reconnects at/above in window → red
};

const STATUS = {
  IDLE: "idle",
  GRAY: "gray",
  GREEN: "green",
  YELLOW: "yellow",
  RED: "red",
};

// ------------------------------------------------------------
// Pure functions
// ------------------------------------------------------------

// Nearest-rank percentile of a sample set; null when empty. (Same
// convention as LND's lib/diagnostics.js: p95 of 20 samples is the
// 19th value 0-based.)
function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  );

  return sorted[index];
}

// The quality decision, in strict priority order:
//   1. not connected                          → Red "unreachable"
//   2. warming up: too few samples AND no
//      negative evidence (losses / loss rate /
//      any reconnect)                      → Gray
//   3. IQR ≥ 30 ms / loss ≥ 3% / ≥2 reconnects → Red, reason = driver
//   4. IQR < 10 && loss < 0.5% && 0 reconnects → Green
//   5. anything else                          → Yellow, reason = driver
// Input note: no RTT magnitude arrives here, by design.
function hubQuality({ connected, samples, lost, iqrMs, lossRate, reconnects }) {
  if (!connected) {
    return { status: STATUS.RED, reason: "Hub unreachable" };
  }

  const sampleCount = samples || 0;
  const lossCount = lost || 0;
  const iqr = typeof iqrMs === "number" ? iqrMs : null;
  const loss = typeof lossRate === "number" ? lossRate : 0;

  if (
    sampleCount < WARMUP_SAMPLES &&
    lossCount < WARMUP_LOSSES &&
    loss < QUALITY_THRESHOLDS.yellowLossRate &&
    (reconnects || 0) < 1
  ) {
    return { status: STATUS.GRAY, reason: "Warming up" };
  }

  if ((reconnects || 0) >= QUALITY_THRESHOLDS.redReconnects) {
    return {
      status: STATUS.RED,
      reason: `${reconnects} reconnects in the last ${WINDOW_MS / 1000}s`,
    };
  }

  if (iqr !== null && iqr >= QUALITY_THRESHOLDS.yellowIqrMs) {
    return {
      status: STATUS.RED,
      reason: `Jitter (IQR) ${iqr.toFixed(1)} ms ≥ ${QUALITY_THRESHOLDS.yellowIqrMs} ms`,
    };
  }

  if (loss >= QUALITY_THRESHOLDS.yellowLossRate) {
    return {
      status: STATUS.RED,
      reason: `Loss ${(loss * 100).toFixed(1)}% ≥ ${(QUALITY_THRESHOLDS.yellowLossRate * 100).toFixed(1)}%`,
    };
  }

  const warmupShort = sampleCount < WARMUP_SAMPLES; // reached here with
  // negative evidence: ≥1 reconnect, or losses pushed past warm-up.

  if (
    !warmupShort &&
    iqr !== null &&
    iqr < QUALITY_THRESHOLDS.greenIqrMs &&
    loss < QUALITY_THRESHOLDS.greenLossRate &&
    (reconnects || 0) === 0
  ) {
    return { status: STATUS.GREEN, reason: "Link quality good" };
  }

  // Yellow: name the metric that kept it out of green.
  if ((reconnects || 0) >= 1) {
    return {
      status: STATUS.YELLOW,
      reason: `1 reconnect in the last ${WINDOW_MS / 1000}s`,
    };
  }

  if (iqr === null || iqr >= QUALITY_THRESHOLDS.greenIqrMs) {
    return {
      status: STATUS.YELLOW,
      reason: `Jitter (IQR) ${iqr === null ? "—" : iqr.toFixed(1)} ms ≥ ${QUALITY_THRESHOLDS.greenIqrMs} ms`,
    };
  }

  return {
    status: STATUS.YELLOW,
    reason: `Loss ${(loss * 100).toFixed(1)}% ≥ ${(QUALITY_THRESHOLDS.greenLossRate * 100).toFixed(1)}%`,
  };
}

// The rolling-window summary the monitor renders: p50/p95 RTT (numbers
// only — never colored), IQR (p75 − p25, the jitter measure that DOES
// color), loss rate and the one-way estimate ≈ RTT/2 (for the tool's
// future tempering compensation).
function summarizeWindow({ rtts, lost, reconnects }) {
  const samples = rtts.length;
  const settled = samples + lost;

  const p50 = percentile(rtts, 0.5);
  const p25 = percentile(rtts, 0.25);
  const p75 = percentile(rtts, 0.75);

  return {
    samples,
    lost,
    reconnects,
    rttP50: p50,
    rttP95: percentile(rtts, 0.95),
    iqrMs: p25 !== null && p75 !== null ? p75 - p25 : null,
    lossRate: settled === 0 ? 0 : lost / settled,
    oneWayEstimateMs: p50 !== null ? p50 / 2 : null,
  };
}

// ------------------------------------------------------------
// HubLeg — the live measurement
// ------------------------------------------------------------

const MAX_EVENTS = 20;

class HubLeg {
  // `ioFactory(url, opts)` is injectable so unit tests can fake the
  // socket; production passes socket.io-client's io. `events` is an
  // array owned by the CALLER so the log survives config changes (the
  // server re-creates HubLeg when the monitor form submits a new
  // config — the event timeline stays continuous). `onChange` fires on
  // every event-log push (connect / disconnect / reconnect / burst …)
  // so the server can broadcast state transitions immediately instead
  // of waiting for its 1 Hz tick. The timing options default to the
  // constants above and exist so unit tests can run the loops in
  // milliseconds.
  constructor({
    url,
    token,
    room,
    nodeId,
    ioFactory,
    events = [],
    onChange = null,
    now = Date.now,
    baselineIntervalMs = BASELINE_INTERVAL_MS,
    burstIntervalMs = BURST_INTERVAL_MS,
    burstDurationMs = BURST_DURATION_MS,
    probeTimeoutMs = PROBE_TIMEOUT_MS,
  }) {
    this.config = { url, token, room, nodeId };
    this.ioFactory = ioFactory;
    this.events = events;
    this.onChange = onChange;
    this.now = now;
    this.baselineIntervalMs = baselineIntervalMs;
    this.burstIntervalMs = burstIntervalMs;
    this.burstDurationMs = burstDurationMs;
    this.probeTimeoutMs = probeTimeoutMs;

    this.socket = null;
    this.connected = false;
    this.everConnected = false;
    this.probing = "baseline";
    this.burstActive = false;

    this.samples = []; // { rtt, at }
    this.losses = []; // { at }
    this.reconnects = []; // { at }
    this.pending = new Map(); // seq -> { sentAt, timer }
    this.seq = 0;

    this.baselineTimer = null;
    this.burstTimer = null;
    this.burstEndTimer = null;
  }

  start() {
    this.socket = this.ioFactory(this.config.url, {
      reconnection: true,
      timeout: 10000,
      auth: {
        token: this.config.token,
        room: this.config.room,
        node: this.config.nodeId,
      },
    });

    this.socket.on("connect", () => {
      const reconnect = this.everConnected && !this.connected;

      this.connected = true;
      this.everConnected = true;

      this.pushEvent(reconnect ? "reconnected" : "connected");

      if (reconnect) {
        this.reconnects.push({ at: this.now() });
      }
    });

    this.socket.on("disconnect", (reason) => {
      this.connected = false;
      this.pushEvent("disconnected", reason);
    });

    // Every failed (re)connection attempt lands in the log, capped like
    // any other event — a wrong URL/token shows up here immediately.
    this.socket.on("connect_error", (error) => {
      this.pushEvent("connect failed", error.message);
    });

    // One echo listener for all probes (a burst has ~150 in flight):
    // look the reply up by seq. A reply for an already-timed-out seq is
    // a stale latecomer — ignored (the timeout already counted the
    // loss).
    this.socket.on("echo", (body) => {
      const seq = body && typeof body.seq === "number" ? body.seq : null;
      const probe = seq !== null ? this.pending.get(seq) : null;

      if (!probe) {
        return;
      }

      clearTimeout(probe.timer);
      this.pending.delete(seq);

      const at = this.now();
      this.samples.push({ rtt: at - probe.sentAt, at });
    });

    this.baselineTimer = setInterval(() => {
      if (this.connected) {
        this.sendProbe();
      }
    }, this.baselineIntervalMs);
  }

  stop() {
    clearInterval(this.baselineTimer);
    clearInterval(this.burstTimer);
    clearTimeout(this.burstEndTimer);
    this.clearPending();

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    this.connected = false;
    this.burstActive = false;
    this.probing = "baseline";
  }

  // One on-demand burst: BURST_DURATION_MS at 30 msg/s on top of the
  // baseline. Returns false when not connected or a burst is running.
  burst() {
    if (!this.connected || this.burstActive) {
      return false;
    }

    this.burstActive = true;
    this.probing = "burst";
    this.pushEvent("burst started");

    this.burstTimer = setInterval(() => {
      this.sendProbe();
    }, this.burstIntervalMs);

    this.burstEndTimer = setTimeout(() => {
      this.endBurst();
    }, this.burstDurationMs);

    return true;
  }

  endBurst() {
    if (!this.burstActive) {
      return;
    }

    clearInterval(this.burstTimer);
    this.burstTimer = null;
    this.burstEndTimer = null;
    this.burstActive = false;
    this.probing = "baseline";
    this.pushEvent("burst ended");
  }

  // The echo probe: send { seq, sentAt }, hub stamps it straight back.
  // The reply is matched in start()'s single echo listener.
  sendProbe() {
    if (!this.socket) {
      return;
    }

    const seq = this.seq + 1;
    const sentAt = this.now();
    const timer = setTimeout(() => {
      if (this.pending.delete(seq)) {
        this.losses.push({ at: this.now() });
      }
    }, this.probeTimeoutMs);

    this.seq = seq;
    this.pending.set(seq, { sentAt, timer });
    this.socket.emit("echo", { seq, sentAt });
  }

  clearPending() {
    for (const probe of this.pending.values()) {
      clearTimeout(probe.timer);
    }

    this.pending.clear();
  }

  pushEvent(type, detail = null) {
    this.events.push({ type, detail, at: this.now() });

    if (this.events.length > MAX_EVENTS) {
      this.events.shift();
    }

    if (typeof this.onChange === "function") {
      this.onChange();
    }
  }

  snapshot() {
    const at = this.now();
    const since = at - WINDOW_MS;

    const rtts = [];
    let lost = 0;
    let reconnects = 0;

    for (const sample of this.samples) {
      if (sample.at >= since) {
        rtts.push(sample.rtt);
      }
    }

    for (const entry of this.losses) {
      if (entry.at >= since) {
        lost += 1;
      }
    }

    for (const entry of this.reconnects) {
      if (entry.at >= since) {
        reconnects += 1;
      }
    }

    const summary = summarizeWindow({ rtts, lost, reconnects });
    const quality = hubQuality({
      connected: this.connected,
      samples: summary.samples,
      lost: summary.lost,
      iqrMs: summary.iqrMs,
      lossRate: summary.lossRate,
      reconnects: summary.reconnects,
    });

    return {
      connected: this.connected,
      probing: this.probing,
      status: quality.status,
      reason: quality.reason,
      summary: {
        ...summary,
        rttP50: round1(summary.rttP50),
        rttP95: round1(summary.rttP95),
        iqrMs: round1(summary.iqrMs),
        oneWayEstimateMs: round1(summary.oneWayEstimateMs),
      },
      events: this.events.map((event) => ({
        type: event.type,
        detail: event.detail,
        at: event.at,
        agoMs: Math.max(0, at - event.at),
      })),
    };
  }
}

function round1(value) {
  return typeof value === "number" ? Math.round(value * 10) / 10 : value;
}

module.exports = {
  STATUS,
  WARMUP_SAMPLES,
  percentile,
  hubQuality,
  summarizeWindow,
  HubLeg,
};
