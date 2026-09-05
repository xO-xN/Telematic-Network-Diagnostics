// Hub-leg measurement (issue #3): the score server's outbound link to
// the public hub, measured continuously.
//
// Layers:
//   percentile / hubQuality / summarizeWindow  — pure, table-testable
//   HubLeg                                     — owns the socket.io-client
//                                                connection and the
//                                                automatic probe cycle
//
// The hub room's other traffic rides the same connection (issue #4):
// every ANNOUNCE_INTERVAL_MS the leg relays its own rolling stats
// into the room ("tnd-stats"), and stats relayed by the other sites
// land in the peers roster — the flower view's data chain. Roster
// decay: a peer silent for PEER_OFFLINE_MS is shown offline (dashed
// spoke, red), and dropped after PEER_PRUNE_MS.
//
// Probe cadence matches the local leg (LND): while connected, a 2 s
// burst at 30 msg/s alternates with a 2 s calm phase at the 1 Hz
// baseline — automatic, no manual trigger anywhere.
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

// Timing constants (all INITIAL — calibration against a real two-node
// cross-internet deployment is an expected post-release step, not a
// hack; issue #1: "阈值常量标注初版、待两节点实测校准").
const BASELINE_INTERVAL_MS = 1000; // calm-phase 1 Hz echo baseline
const BURST_INTERVAL_MS = 1000 / 30; // ~33.3 ms → 30 probes/s
// The phase cycle — same shape and constants as the local leg (LND's
// lib/diagnostics.js): 2 s of burst alternates with 2 s of calm, for
// as long as the connection lives. No manual trigger.
const BURST_PHASE_MS = 2000;
const CALM_PHASE_MS = 2000;
const PROBE_TIMEOUT_MS = 2000; // generous for intercontinental RTT
const WINDOW_MS = 15000; // rolling stats window
const WARMUP_SAMPLES = 5; // Gray until this many window samples
const WARMUP_LOSSES = 3; // …unless this many losses already stacked up

// Flower-view data chain (issue #4). All INITIAL — calibration against
// a real two-node deployment is an expected step.
const ANNOUNCE_INTERVAL_MS = 1000; // own stats relayed into the room
const PEER_OFFLINE_MS = 5000; // silent this long → shown offline
const PEER_PRUNE_MS = 30000; // silent this long → gone from the roster

// The relayed stats body's type tag — the room's shared vocabulary
// filter; other message kinds may share the seam later.
const STATS_TYPE = "tnd-stats";

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

// The shared leg vocabulary plus the hub leg's own "not configured"
// state (the local leg is always on — it has no idle).
const { STATUS: LEG_STATUS } = require("./status");

const STATUS = {
  IDLE: "idle",
  ...LEG_STATUS,
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
//
// Reasons are language-neutral keys (the server has no UI language):
// the monitor page maps them through the copy table of the current
// locale (public/shared.js `copy` + lib/locale-follow.js), filling the
// {0}/{1} placeholders from `reasonParams` (preformatted values).
function hubQuality({ connected, samples, lost, iqrMs, lossRate, reconnects }) {
  if (!connected) {
    return { status: STATUS.RED, reason: "unreachable", reasonParams: [] };
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
    return { status: STATUS.GRAY, reason: "warmup", reasonParams: [] };
  }

  if ((reconnects || 0) >= QUALITY_THRESHOLDS.redReconnects) {
    return {
      status: STATUS.RED,
      reason: "reconnectsRed",
      reasonParams: [String(reconnects), String(WINDOW_MS / 1000)],
    };
  }

  if (iqr !== null && iqr >= QUALITY_THRESHOLDS.yellowIqrMs) {
    return {
      status: STATUS.RED,
      reason: "jitterRed",
      reasonParams: [iqr.toFixed(1), String(QUALITY_THRESHOLDS.yellowIqrMs)],
    };
  }

  if (loss >= QUALITY_THRESHOLDS.yellowLossRate) {
    return {
      status: STATUS.RED,
      reason: "lossRed",
      reasonParams: [
        (loss * 100).toFixed(1),
        (QUALITY_THRESHOLDS.yellowLossRate * 100).toFixed(1),
      ],
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
    return { status: STATUS.GREEN, reason: "linkGood", reasonParams: [] };
  }

  // Yellow: name the metric that kept it out of green.
  if ((reconnects || 0) >= 1) {
    return {
      status: STATUS.YELLOW,
      reason: "reconnectYellow",
      reasonParams: [String(WINDOW_MS / 1000)],
    };
  }

  if (iqr === null || iqr >= QUALITY_THRESHOLDS.greenIqrMs) {
    return {
      status: STATUS.YELLOW,
      reason: "jitterYellow",
      reasonParams: [
        iqr === null ? "—" : iqr.toFixed(1),
        String(QUALITY_THRESHOLDS.greenIqrMs),
      ],
    };
  }

  return {
    status: STATUS.YELLOW,
    reason: "lossYellow",
    reasonParams: [
      (loss * 100).toFixed(1),
      (QUALITY_THRESHOLDS.greenLossRate * 100).toFixed(1),
    ],
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
  // every event-log push (connect / disconnect / reconnect …) so the
  // server can broadcast state transitions immediately instead of
  // waiting for its 1 Hz tick. The timing options default to the
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
    burstPhaseMs = BURST_PHASE_MS,
    calmPhaseMs = CALM_PHASE_MS,
    probeTimeoutMs = PROBE_TIMEOUT_MS,
    announceIntervalMs = ANNOUNCE_INTERVAL_MS,
    peerOfflineMs = PEER_OFFLINE_MS,
    peerPruneMs = PEER_PRUNE_MS,
    // The site's local-leg summary (issue #5), read live whenever the
    // own snapshot or an announce is built: () => { status, p50,
    // performers } with status/p50 null while nothing is measured.
    localSummary = () => null,
  }) {
    this.config = { url, token, room, nodeId };
    this.ioFactory = ioFactory;
    this.events = events;
    this.onChange = onChange;
    this.now = now;
    this.baselineIntervalMs = baselineIntervalMs;
    this.burstIntervalMs = burstIntervalMs;
    this.burstPhaseMs = burstPhaseMs;
    this.calmPhaseMs = calmPhaseMs;
    this.probeTimeoutMs = probeTimeoutMs;
    this.announceIntervalMs = announceIntervalMs;
    this.peerOfflineMs = peerOfflineMs;
    this.peerPruneMs = peerPruneMs;
    this.localSummary = localSummary;

    this.socket = null;
    this.connected = false;
    this.everConnected = false;
    this.probing = "calm";
    this.burstActive = false;

    this.samples = []; // { rtt, at }
    this.losses = []; // { at }
    this.reconnects = []; // { at }
    this.pending = new Map(); // seq -> { sentAt, timer }
    this.seq = 0;

    this.peers = new Map(); // nodeId -> stats body + lastSeenAt
    this.announceTimer = null;

    this.baselineTimer = null;
    this.burstTimer = null;
    this.phaseTimer = null;
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

      // Each connection starts the phase cycle fresh, in the burst
      // phase — same shape as the local leg (LND): the test starts in
      // burst, then alternates.
      this.enterBurstPhase();
    });

    this.socket.on("disconnect", (reason) => {
      this.connected = false;
      this.stopPhaseCycle();
      this.pushEvent("disconnected", reason);
    });

    // Every failed (re)connection attempt lands in the log, capped like
    // any other event — a wrong URL/token shows up here immediately.
    this.socket.on("connect_error", (error) => {
      this.pushEvent("connect failed", error.message);
    });

    // One echo listener for all probes (a burst has ~60 in flight):
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

    // The flower view's data chain (issue #4): stats relayed by the
    // other sites land here (the hub stamps `from` — the authoritative
    // sender identity). Foreign message kinds sharing the relay seam
    // are ignored until they exist.
    this.socket.on("relay", (body) => {
      if (!body || body.type !== STATS_TYPE || typeof body.from !== "string") {
        return;
      }

      this.peers.set(body.from, {
        connected: body.connected === true,
        probing: typeof body.probing === "string" ? body.probing : "calm",
        status: typeof body.status === "string" ? body.status : "gray",
        reason: typeof body.reason === "string" ? body.reason : "",
        // Reason params ride the relay as preformatted strings (sites
        // may run different locales — formatting is sender-side).
        reasonParams: Array.isArray(body.reasonParams)
          ? body.reasonParams.map(String)
          : [],
        summary: body.summary && typeof body.summary === "object" ? body.summary : null,
        local: normalizeLocal(body.local),
        lastSeenAt: this.now(),
      });
    });

    this.baselineTimer = setInterval(() => {
      if (this.connected && !this.burstActive) {
        this.sendProbe();
      }
    }, this.baselineIntervalMs);

    // Own stats into the room, at the announce cadence, only while the
    // connection lives (a dead leg has nothing worth relaying — the
    // other sites learn of the outage through the silence itself).
    this.announceTimer = setInterval(() => {
      if (this.connected) {
        this.announceStats();
      }
    }, this.announceIntervalMs);
  }

  // The relayed stats body — the frozen shape every site broadcasts
  // (issue #4): own hub-leg quality + numbers, plus the site's
  // local-leg summary (issue #5: { status, p50, performers }, status
  // null while nothing is measured).
  announceStats() {
    const own = this.ownSnapshot();

    this.socket.emit("relay", {
      type: STATS_TYPE,
      node: this.config.nodeId,
      connected: own.connected,
      probing: own.probing,
      status: own.status,
      reason: own.reason,
      reasonParams: own.reasonParams,
      summary: own.summary,
      local: own.local,
    });
  }

  stop() {
    clearInterval(this.baselineTimer);
    clearInterval(this.announceTimer);
    this.stopPhaseCycle();
    this.clearPending();

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    this.connected = false;
  }

  // The automatic phase cycle (the local leg's shape, LND): while
  // connected, BURST_PHASE_MS at 30 msg/s alternates with CALM_PHASE_MS
  // at the 1 Hz baseline — no manual trigger anywhere. Phase switches
  // are deliberately NOT event-logged: they fire every 2 s and would
  // drown the connect/disconnect timeline.
  enterBurstPhase() {
    if (!this.connected) {
      return;
    }

    this.burstActive = true;
    this.probing = "burst";

    this.burstTimer = setInterval(() => {
      this.sendProbe();
    }, this.burstIntervalMs);

    this.phaseTimer = setTimeout(() => {
      this.enterCalmPhase();
    }, this.burstPhaseMs);
  }

  enterCalmPhase() {
    this.burstActive = false;
    this.probing = "calm";

    clearInterval(this.burstTimer);
    this.burstTimer = null;

    this.phaseTimer = setTimeout(() => {
      this.enterBurstPhase();
    }, this.calmPhaseMs);
  }

  stopPhaseCycle() {
    clearInterval(this.burstTimer);
    clearTimeout(this.phaseTimer);
    this.burstTimer = null;
    this.phaseTimer = null;
    this.burstActive = false;
    this.probing = "calm";
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

  // The own-leg view: what the monitor's own card shows and what gets
  // relayed to the room.
  ownSnapshot() {
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
      reasonParams: quality.reasonParams,
      // The site-level local-leg summary relayed to the room; the own
      // card reads the same values it announces.
      local: this.localSummary(),
      summary: {
        ...summary,
        rttP50: round1(summary.rttP50),
        rttP95: round1(summary.rttP95),
        iqrMs: round1(summary.iqrMs),
        oneWayEstimateMs: round1(summary.oneWayEstimateMs),
      },
    };
  }

  // The full flower-view state: the own leg plus every peer's last
  // relayed stats (offline when stale, pruned when long gone). The
  // prune is deliberately lazy — snapshot is the roster's only reader.
  snapshot() {
    const at = this.now();
    const peers = {};

    for (const [nodeId, entry] of this.peers) {
      const silentFor = at - entry.lastSeenAt;

      if (silentFor > this.peerPruneMs) {
        this.peers.delete(nodeId);
        continue;
      }

      peers[nodeId] = {
        ...entry,
        connected: entry.connected && silentFor <= this.peerOfflineMs,
        // The EFFECTIVE status: an offline peer is unreachable, so red
        // regardless of what it last announced — consumers never
        // re-derive this.
        status:
          entry.connected && silentFor <= this.peerOfflineMs
            ? entry.status
            : "red",
        agoMs: Math.max(0, silentFor),
      };
    }

    return {
      ...this.ownSnapshot(),
      // Whether THIS leg (this config) has ever connected (issue #12):
      // the monitor's connecting state — submitted → first connect —
      // is server truth, so a page refresh or another device reads
      // the same button state. Resets only with a new config (a new
      // HubLeg instance); an identical resubmission keeps it.
      everConnected: this.everConnected,
      peers,
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

// A relayed local-leg summary is foreign input: keep only the typed
// fields, defaulting the way "no data" renders.
function normalizeLocal(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  return {
    status: typeof value.status === "string" ? value.status : null,
    p50: typeof value.p50 === "number" ? value.p50 : null,
    performers: typeof value.performers === "number" ? value.performers : 0,
  };
}

module.exports = {
  STATUS,
  WARMUP_SAMPLES,
  percentile,
  hubQuality,
  summarizeWindow,
  HubLeg,
};
