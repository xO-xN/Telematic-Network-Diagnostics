// Telematic Network Diagnostics — score server entry point.
//
// A network-only PNDS project: no audio engine, no SuperCollider. The
// server:
// - serves the performer and monitor pages from public/ on both ports
// - exposes /__pnds/health on both ports (audio mode "none")
// - serves the theme bridge (/__pnds/theme-follow.js) on the monitor port
// - offers the performer-page QR code on the monitor port
// - measures the hub leg (score server ↔ public hub, lib/hub-leg.js):
//   outbound socket.io-client connection with the LND-style automatic
//   probe cycle (2 s burst @ 30 msg/s ↔ 2 s calm @ 1 Hz), live stats
//   broadcasts to the monitor page
// - measures the local legs (performers ↔ this server, lib/local-leg.js
//   + lib/players.js, issue #5): performers join with a claim token
//   and are probed automatically — same phase cycle, LND thresholds,
//   disconnect → Red at once; the site's worst local status flows into
//   the hub room announce and the flower view. A voluntary exit
//   (issue #10, the `leave` event) instead deletes the client outright:
//   the card, the id and the claim-token binding all go, the site
//   verdict stops counting the leg, and the same token rejoining is a
//   fresh client. The monitor's「x」(issue #13, the `remove` command)
//   runs the same deletion on any card — online ones are notified
//   (`removed`) before their socket is kicked.
// - shuts down cleanly on SIGINT / SIGTERM
//
// Hub connection, two channels (issue #3, the Phase 0 validation
// target — the env contract is frozen from this ticket on):
//   - environment (App v1.3.0 injection): PNDS_NODE_ID / PNDS_HUB_URL
//     (never carries the token) / PNDS_HUB_TOKEN / PNDS_HUB_ROOM
//     (optional, default "default"). Present at boot → auto-connect.
//   - monitor form: URL / token / room / node name, submitted from the
//     page, persisted in the browser's localStorage.
// A form submission replaces the env-provided (or previous form)
// config; both travel the exact same path afterwards.

const os = require("node:os");
const path = require("node:path");
const libraries = require("./lib/shared-libraries");
const express = libraries.requireLibrary("express");
const { io: ioClient } = libraries.requireLibrary("socket.io-client");

const {
  loadManifest,
  parseCliOptions,
  printUsage,
  resolveServerConfig,
} = require("./lib/config");
const { resolveHostLanIp } = require("./lib/network");
const { HealthTracker } = require("./lib/health");
const { HubLeg } = require("./lib/hub-leg");
const { overallFromNodes } = require("./lib/flower");
const { PlayerRegistry } = require("./lib/players");
const {
  LocalSession,
  PROBE_INTERVAL_MS,
  BASELINE_TIMEOUT_MS,
  BURST_INTERVAL_MS,
  BURST_TIMEOUT_MS,
  BURST_PHASE_MS,
  CALM_PHASE_MS,
} = require("./lib/local-leg");
const {
  attachShutdown,
  closeHttpServer,
} = require("./lib/lifecycle");
const shared = require("./public/shared");

const PROJECT_ROOT = __dirname;
const { events: EVENTS } = shared;

const MAX_URL_LENGTH = 256;
const MAX_TOKEN_LENGTH = 128;
const MAX_ROOM_LENGTH = 128;
const MAX_NODE_ID_LENGTH = 64;

// ------------------------------------------------------------
// Configuration
// ------------------------------------------------------------

const manifest = loadManifest(PROJECT_ROOT);
const cliOptions = parseCliOptions(process.argv.slice(2));

if (cliOptions.help) {
  printUsage();
  process.exit(0);
}

const serverConfig = resolveServerConfig(manifest);
const hostLanIp = resolveHostLanIp(process.env.PNDS_HOST_IP);

// ------------------------------------------------------------
// HTTP servers (performer port + monitor port share public/)
// ------------------------------------------------------------

const app = express();
const monitorApp = express();

libraries.attachBrowserRoutes(app);
libraries.attachBrowserRoutes(monitorApp);

app.use(express.static(path.join(PROJECT_ROOT, "public")));
monitorApp.use(express.static(path.join(PROJECT_ROOT, "public")));

// Injects the manifest ports into the browser so shared.js can read
// them. The single source of truth is manifest.json.
function configScript(request, response) {
  response.type("application/javascript").send(
    `window.__PNDS_PORTS__ = { performerPort: ${serverConfig.performerPort}, monitorPort: ${serverConfig.monitorPort} };`,
  );
}

app.get("/__config.js", configScript);
monitorApp.get("/__config.js", configScript);

// No audio: the runtime contract's "none" mode (audio.status "disabled").
const health = new HealthTracker({
  projectId: manifest.id,
  audioMode: "none",
  performerPort: serverConfig.performerPort,
  monitorPort: serverConfig.monitorPort,
});

app.get("/__pnds/health", health.handler());
monitorApp.get("/__pnds/health", health.handler());

// The lib/ files the monitor page loads in the browser: the theme and
// locale bridge modules (App contract — theme spec §5.3, network
// reference "Locale Following"), served under the App-contract
// namespace like /__pnds/health. Monitor port only — the performer
// branch of the page never loads them and keeps the project's own
// colors and copy.
monitorApp.get("/__pnds/theme-follow.js", (request, response) => {
  response.sendFile(path.join(PROJECT_ROOT, "lib", "theme-follow.js"));
});

monitorApp.get("/__pnds/locale-follow.js", (request, response) => {
  response.sendFile(path.join(PROJECT_ROOT, "lib", "locale-follow.js"));
});

// ------------------------------------------------------------
// Startup
// ------------------------------------------------------------

const server = app.listen(serverConfig.performerPort, "0.0.0.0", (error) => {
  if (error) {
    console.error(`Performer HTTP server failed on port ${serverConfig.performerPort}:`, error);
    process.exit(1);
  }
  printRuntimeInfo();
});

const monitorServer = monitorApp.listen(
  serverConfig.monitorPort,
  "0.0.0.0",
  (error) => {
    if (error) {
      console.error(`Monitor HTTP server failed on port ${serverConfig.monitorPort}:`, error);
      process.exit(1);
    }
    console.log(
      `Monitor page: http://${hostLanIp}:${serverConfig.monitorPort}/`,
    );
  },
);

// Network-only readiness does not wait on an audio engine.
health.setAudioDisabled();

const io = libraries.requireLibrary("socket.io")(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// ------------------------------------------------------------
// Local legs (issue #5): performers ↔ this server
// ------------------------------------------------------------

// The client registry: numeric ids, claim-token recovery, cap.
const registry = new PlayerRegistry({
  maxClients: shared.maxClients,
});

// The local-leg session (lib/local-leg.js): per-performer metrics and
// status, LND rules verbatim. Always on — the probe loop below starts
// at boot; a performer that joins is measured from its first second.
const local = new LocalSession();

// In-flight probes per performer id: id -> seq -> { sentAt, phase,
// timedOut, timer }. A probe is pending from the moment it is sent until
// its ack, its timeout PLUS the late-ack grace, or its hard delete. The
// burst phase sends ~30 probes per second per performer, so several can
// be in flight at once — hence the per-seq map.
const pendings = new Map();
const probeSeqs = new Map(); // per-performer probe sequence counters

// How long a timed-out probe stays matchable: an ack landing inside the
// grace window proves the probe was delivered (slowly, not lost) and
// withdraws the timeout. Past it the entry is dropped — the ack would be
// information about a link two seconds gone.
const LATE_ACK_GRACE_MS = 2000;

// The shared phase cycle (same shape as the hub leg's): 2 s burst
// @ 30 msg/s ↔ 2 s calm @ 1 Hz, forever.
let burstActive = false;
let phaseTimer = null;
let freezeTimer = null; // defers the burst-window freeze past the tail

function sendLocalProbe(id, socket, timeoutMs) {
  const seq = (probeSeqs.get(id) || 0) + 1;
  const sentAt = Date.now();

  // The pending entry carries the phase the probe was SENT in: a burst
  // probe answered just after the calm phase began must land as a burst
  // sample, whatever phase the cycle is in by the time the ack arrives.
  const pending = {
    sentAt,
    phase: local.phase,
    timedOut: false,
    timer: null,
  };

  // Deadline first: the timeout counts immediately (the Red rules need a
  // timely signal), but the entry survives for the late-ack grace — an
  // answer inside it is delivered-but-slow, not lost.
  pending.timer = setTimeout(() => {
    pending.timedOut = true;
    local.recordTimeout(id);

    pending.timer = setTimeout(() => {
      const bySeq = pendings.get(id);

      if (bySeq && bySeq.get(seq) === pending) {
        bySeq.delete(seq);

        if (bySeq.size === 0) {
          pendings.delete(id);
        }
      }
    }, LATE_ACK_GRACE_MS);
  }, timeoutMs);

  probeSeqs.set(id, seq);

  let bySeq = pendings.get(id);

  if (!bySeq) {
    bySeq = new Map();
    pendings.set(id, bySeq);
  }

  bySeq.set(seq, pending);
  socket.emit(EVENTS.probe, { seq });
}

// Removes one in-flight probe (whichever timer is live) and prunes the
// per-performer map when it empties. Returns the removed entry — the ack
// handler needs to know whether the probe had already timed out.
function removePending(id, seq) {
  const bySeq = pendings.get(id);

  if (!bySeq || !bySeq.has(seq)) {
    return null;
  }

  const pending = bySeq.get(seq);

  clearTimeout(pending.timer);
  bySeq.delete(seq);

  if (bySeq.size === 0) {
    pendings.delete(id);
  }

  return pending;
}

function clearPending(id) {
  const bySeq = pendings.get(id);

  if (bySeq) {
    for (const pending of bySeq.values()) {
      clearTimeout(pending.timer);
    }

    pendings.delete(id);
  }
}

function clearAllPending() {
  for (const id of [...pendings.keys()]) {
    clearPending(id);
  }
}

// One probe cycle per second: baseline probes only in the calm phase
// (the burst timer covers the burst phase), then a status cycle. The
// state broadcast runs on its own 1 Hz timer; join/disconnect
// transitions broadcast immediately.
function localTick() {
  if (!burstActive) {
    for (const assignment of registry.list()) {
      const socket = io.sockets.sockets.get(assignment.socketId);

      if (socket) {
        sendLocalProbe(assignment.id, socket, BASELINE_TIMEOUT_MS);
      }
    }
  }

  local.cycleAll();
}

const localTimer = setInterval(localTick, PROBE_INTERVAL_MS);

function burstTick() {
  if (!burstActive) {
    return;
  }

  for (const assignment of registry.list()) {
    const socket = io.sockets.sockets.get(assignment.socketId);

    if (socket) {
      sendLocalProbe(assignment.id, socket, BURST_TIMEOUT_MS);
    }
  }
}

const localBurstTimer = setInterval(burstTick, BURST_INTERVAL_MS);

// The always-on cycle starts in the burst phase (LND parity — same as
// a hub-leg connection entering burst on connect).
function enterBurstPhase() {
  burstActive = true;
  local.setPhase("burst");
  local.beginBurstWindow();
  phaseTimer = setTimeout(enterCalmPhase, BURST_PHASE_MS);
}

function enterCalmPhase() {
  burstActive = false;
  local.setPhase("calm");
  // Freeze the window's timeout rate a burst-timeout after the last
  // probe: probes sent in the window's tail time out up to 200 ms
  // later and must still count towards this window, not the next one.
  freezeTimer = setTimeout(() => {
    local.endBurstWindow();
    freezeTimer = null;
  }, BURST_TIMEOUT_MS);
  phaseTimer = setTimeout(enterBurstPhase, CALM_PHASE_MS);
}

enterBurstPhase();

// ------------------------------------------------------------
// Hub leg (issue #3)
// ------------------------------------------------------------

// The env channel: App v1.3.0's frozen injection contract, readable by
// the monitor page as prefill defaults. The token never rides the URL.
const envHub = {
  hubUrl: process.env.PNDS_HUB_URL || "",
  hubToken: process.env.PNDS_HUB_TOKEN || "",
  hubRoom: process.env.PNDS_HUB_ROOM || "",
  nodeId: process.env.PNDS_NODE_ID || "",
};

// The event log outlives HubLeg instances: a form submission
// re-creates the leg, the timeline stays continuous.
const hubEvents = [];
let hubLeg = null;
let activeConfig = null;

function normalizeText(value, maxLength) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, maxLength);
}

// Applies a hub config (env or form): validates, tears down any
// previous leg and starts the new one. An IDENTICAL resubmission (a
// monitor refresh or socket reconnect re-emitting the auto-start
// config) is a no-op — the live measurement and its window survive.
function configureHubLeg({ url, token, room, nodeId }) {
  const normalized = {
    url: normalizeText(url, MAX_URL_LENGTH),
    token: normalizeText(token, MAX_TOKEN_LENGTH),
    room: normalizeText(room, MAX_ROOM_LENGTH) || shared.defaultRoom,
    nodeId:
      normalizeText(nodeId, MAX_NODE_ID_LENGTH) || os.hostname(),
  };

  if (
    hubLeg &&
    activeConfig &&
    normalized.url === activeConfig.url &&
    normalized.token === activeConfig.token &&
    normalized.room === activeConfig.room &&
    normalized.nodeId === activeConfig.nodeId
  ) {
    return;
  }

  if (hubLeg) {
    hubLeg.stop();
    hubLeg = null;
  }

  activeConfig = normalized;

  if (normalized.url && normalized.token) {
    hubLeg = new HubLeg({
      ...normalized,
      ioFactory: (hubUrl, opts) => ioClient(hubUrl, opts),
      events: hubEvents,
      // The site's local-leg summary rides every announce (issue #5):
      // live read, so the relayed values track the local session.
      localSummary: () => local.siteSummary(),
      // State transitions (connect/disconnect/reconnect/burst) surface
      // immediately; the numbers refresh on the 1 Hz tick below.
      onChange: broadcastState,
    });
    hubLeg.start();
    console.log(
      `[hub-leg] connecting to ${normalized.url} (room "${normalized.room}", node "${normalized.nodeId}")`,
    );
  } else {
    hubEvents.push({
      type: "stopped",
      detail: "noHubConfigured",
      at: Date.now(),
    });
  }

  broadcastState();
}

// The full site snapshot every page renders from: the hub leg (own +
// relayed peers), the local legs (this site's performers), and the
// flower view's overall — worst leg across every known node, hub AND
// local, with fault attribution naming the offending site and leg.
function stateSnapshot() {
  const leg = hubLeg ? hubLeg.snapshot() : null;
  const localSnapshot = local.snapshot(Date.now());

  let overall = null;

  if (leg) {
    const nodes = [
      {
        nodeId: activeConfig ? activeConfig.nodeId : null,
        hubStatus: leg.connected ? leg.status : "red",
        localStatus: localSnapshot.status,
        isSelf: true,
      },
    ];

    for (const [nodeId, peer] of Object.entries(leg.peers || {})) {
      nodes.push({
        nodeId,
        hubStatus: peer.status,
        localStatus: peer.local ? peer.local.status : null,
        isSelf: false,
      });
    }

    overall = overallFromNodes(nodes);
  }

  return {
    configured: Boolean(hubLeg),
    // The live config verbatim (issue #12), token included: the
    // monitor's dirty-check baseline for the connect button, so a
    // page refresh or another device reads the server's truth, not a
    // page-local memory. The token rides exactly like the env token
    // below — LAN trust model, no new exposure class.
    activeConfig: activeConfig ? { ...activeConfig } : null,
    env: envHub,
    leg,
    local: localSnapshot,
    overall,
  };
}

function broadcastState() {
  io.emit(EVENTS.state, stateSnapshot());
}

// The pages' numbers refresh at the baseline cadence; HubLeg's
// onChange and the local join/disconnect handlers fire extra
// broadcasts on state transitions so a disconnect or reconnect is
// reflected immediately, not on the next tick.
const stateTimer = setInterval(broadcastState, 1000);

// Env channel present at boot → auto-connect without opening the
// monitor (the Phase 0 dual-channel: both channels feed one path).
if (envHub.hubUrl && envHub.hubToken) {
  configureHubLeg({
    url: envHub.hubUrl,
    token: envHub.hubToken,
    room: envHub.hubRoom,
    nodeId: envHub.nodeId,
  });
}

// ------------------------------------------------------------
// Socket.IO protocol (performer pages + monitor pages)
// ------------------------------------------------------------

io.on("connection", (socket) => {
  socket.emit(EVENTS.state, stateSnapshot());

  // The monitor's connection form.
  socket.on(EVENTS.hubConfig, (config) => {
    configureHubLeg(config || {});
  });

  // The performer page joins with its persisted claim token: a known
  // token recovers the client id (reconnect), a fresh one allocates.
  socket.on(EVENTS.join, (payload) => {
    const result = registry.allocate({
      socketId: socket.id,
      claimToken: payload && payload.token,
    });

    if (result.status === "rejected") {
      socket.emit(EVENTS.rejected, {
        reason: result.message,
      });
      socket.disconnect(true);
      return;
    }

    local.addClient(result.id, Date.now());
    socket.emit(EVENTS.joined, {
      id: result.id,
      token: result.token,
      recovered: result.status === "recovered",
    });
    broadcastState();
  });

  // The local-leg probe answer: matched by (performer, seq). An ack for
  // an unknown seq (never sent, or past the late-ack grace) is stale
  // information about a probe already settled; an ack inside the grace
  // window after a timeout is delivered-but-slow — the collector
  // withdraws the loss and keeps the RTT. t0/t1 are the page's
  // receive/reply timestamps (client processing time only — the RTT
  // itself is measured server-side).
  socket.on(EVENTS.ack, (payload) => {
    const id = registry.findIdBySocket(socket.id);

    if (id === null || !payload || typeof payload.seq !== "number") {
      return;
    }

    const bySeq = pendings.get(id);
    const pending = bySeq && bySeq.get(payload.seq);

    if (!pending) {
      return;
    }

    removePending(id, payload.seq);

    const rttMs = Date.now() - pending.sentAt;
    const processingMs =
      typeof payload.t1 === "number" && typeof payload.t0 === "number"
        ? payload.t1 - payload.t0
        : null;

    if (pending.timedOut) {
      local.recordLateAck(id, rttMs, processingMs, pending.phase);
    } else {
      local.recordAck(id, rttMs, processingMs, pending.phase);
    }
  });

  // The ONE deletion path both exits share (#10 the performer's own
  // 退出检测, #13 the monitor's「x」): registry binding, in-flight
  // probes, the session card and the broadcast all go — the site
  // verdict stops counting the leg, the slot and the claim-token
  // mapping are freed. Returns the released assignment (an online
  // client's socket binding) or null — a dropped card's binding is
  // already gone (the socket's disconnect released it), which is
  // exactly the no-notify case.
  function deletePerformer(id, type) {
    const assignment = registry.release(id);

    clearPending(id);
    local.removeClient(id, Date.now(), type);
    broadcastState();
    return assignment;
  }

  // The performer page's voluntary exit (issue #10): the phone tapped
  // 退出检测. A voluntary exit is not a network fault — no red card, no
  // drag on the site verdict — and the exit lands in the site-level
  // event log. The server then kicks the socket itself: the page
  // cannot close it race-free (a close racing the leave packet's flush
  // would drop the delete), and this way the teardown provably happens
  // AFTER the deletion. The socket disconnect that follows finds
  // nothing bound and changes nothing (disconnect → Red keeps its
  // exact default behavior for every OTHER kind of drop).
  socket.on(EVENTS.leave, () => {
    const id = registry.findIdBySocket(socket.id);

    if (id === null) {
      return;
    }

    deletePerformer(id, shared.localEvents.left);
    socket.disconnect(true);
  });

  // The monitor's removal of a performer (issue #13): the「x」on any
  // performer card — online or disconnected, no confirmation — runs
  // the same deletion as the leave above; the site event says "removed"
  // (who deleted it). An ONLINE client is notified before the kick so
  // the phone can word its exit cover 已被移出检测: the notice is
  // queued on the phone's socket ahead of the disconnect, and the
  // kick's own disconnect handler finds nothing bound — same as the
  // leave. A disconnected card has no socket to notify; its deletion
  // takes the identical path minus the notice.
  socket.on(EVENTS.remove, (payload) => {
    const id =
      payload && typeof payload.id === "number" ? payload.id : null;

    if (id === null) {
      return;
    }

    const assignment = deletePerformer(id, shared.localEvents.removed);

    if (assignment) {
      const clientSocket = io.sockets.sockets.get(assignment.socketId);

      if (clientSocket) {
        clientSocket.emit(EVENTS.removed);
        clientSocket.disconnect(true);
      }
    }
  });

  socket.on("disconnect", () => {
    const released = registry.releaseBySocket(socket.id);

    if (!released) {
      return;
    }

    clearPending(released.id);

    // The card stays, flips Red immediately and the disconnect is
    // logged; a reconnect restores the identity via the claim token.
    local.disconnectClient(released.id, Date.now());
    broadcastState();
  });
});

// ------------------------------------------------------------
// Shutdown
// ------------------------------------------------------------

attachShutdown({
  onShutdown: async () => {
    health.setStopping();

    // Drop every connected client first — the phone performers AND the
    // monitor page's observer socket. io.close() waits for clients to
    // take their disconnect; a phone on a weak network must not outlive
    // the host's kill window. Per-step elapsed below: a slow step found
    // in the wild is diagnosable from the output tail alone.
    const t0 = Date.now();
    io.disconnectSockets(true);
    io.close();
    const tSockets = Date.now() - t0;

    const t1 = Date.now();
    clearInterval(stateTimer);
    clearInterval(localTimer);
    clearInterval(localBurstTimer);
    clearTimeout(phaseTimer);
    clearTimeout(freezeTimer);
    clearAllPending();

    if (hubLeg) {
      hubLeg.stop();
    }

    const tCleanup = Date.now() - t1;

    const t2 = Date.now();
    await closeHttpServer(server);
    await closeHttpServer(monitorServer);
    const tHttp = Date.now() - t2;

    console.log(
      `[shutdown] steps: sockets ${tSockets}ms, cleanup ${tCleanup}ms, http ${tHttp}ms`,
    );
  },
});

// ------------------------------------------------------------
// Console output
// ------------------------------------------------------------

function printRuntimeInfo() {
  console.log(`[server] ${manifest.name} v${manifest.version}`);
  console.log(`[server] audio: disabled (network-only project)`);
  console.log(
    `[server] performer page: http://${hostLanIp}:${serverConfig.performerPort}/`,
  );
}
