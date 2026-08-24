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
const express = require("express");
const { io: ioClient } = require("socket.io-client");

const {
  loadManifest,
  parseCliOptions,
  printUsage,
  resolveServerConfig,
} = require("./lib/config");
const { resolveHostLanIp } = require("./lib/network");
const { HealthTracker } = require("./lib/health");
const { qrHandler } = require("./lib/qr");
const { HubLeg } = require("./lib/hub-leg");
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

// QR code for the performer page, shown on the monitor page.
monitorApp.get(
  "/qr",
  qrHandler(`http://${hostLanIp}:${serverConfig.performerPort}/`),
);

// The one lib/ file the monitor page loads in the browser: the
// theme-bridge module (spec §5.3), served under the App-contract
// namespace like /__pnds/health. Monitor port only — the performer
// branch of the page never loads it and keeps the project's own colors.
monitorApp.get("/__pnds/theme-follow.js", (request, response) => {
  response.sendFile(path.join(PROJECT_ROOT, "lib", "theme-follow.js"));
});

// ------------------------------------------------------------
// Startup
// ------------------------------------------------------------

const server = app.listen(serverConfig.performerPort, "0.0.0.0", () => {
  printRuntimeInfo();
});

const monitorServer = monitorApp.listen(
  serverConfig.monitorPort,
  "0.0.0.0",
  () => {
    console.log(
      `Monitor page: http://${hostLanIp}:${serverConfig.monitorPort}/`,
    );
  },
);

server.on("error", (error) => {
  console.error(
    `Performer HTTP server failed on port ${serverConfig.performerPort}:`,
    error,
  );
  process.exitCode = 1;
});

monitorServer.on("error", (error) => {
  console.error(
    `Monitor HTTP server failed on port ${serverConfig.monitorPort}:`,
    error,
  );
  process.exitCode = 1;
});

// Nothing to wait for: no audio engine, so the project is ready as soon
// as the HTTP servers are up.
health.setAudioDisabled();

const io = require("socket.io")(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

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
      // State transitions (connect/disconnect/reconnect/burst) surface
      // immediately; the numbers refresh on the 1 Hz tick below.
      onChange: broadcastHubState,
    });
    hubLeg.start();
    console.log(
      `[hub-leg] connecting to ${normalized.url} (room "${normalized.room}", node "${normalized.nodeId}")`,
    );
  } else {
    hubEvents.push({
      type: "stopped",
      detail: "no hub configured",
      at: Date.now(),
    });
  }

  broadcastHubState();
}

function hubStateSnapshot() {
  const leg = hubLeg ? hubLeg.snapshot() : null;

  return {
    configured: Boolean(hubLeg),
    config: activeConfig
      ? {
          url: activeConfig.url,
          room: activeConfig.room,
          nodeId: activeConfig.nodeId,
          tokenSet: Boolean(activeConfig.token),
        }
      : null,
    // The token is never echoed back; the env channel carries it once
    // for the form prefill (LAN trust model, same as the form itself).
    env: envHub,
    leg,
  };
}

function broadcastHubState() {
  io.emit(EVENTS.hubState, hubStateSnapshot());
}

// The monitor's numbers refresh at the baseline cadence; HubLeg's
// onChange fires extra broadcasts on state transitions so a disconnect
// or reconnect is reflected immediately, not on the next tick.
const hubStateTimer = setInterval(broadcastHubState, 1000);

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
// Socket.IO protocol (monitor page)
// ------------------------------------------------------------

io.on("connection", (socket) => {
  socket.emit(EVENTS.hubState, hubStateSnapshot());

  socket.on(EVENTS.hubConfig, (config) => {
    configureHubLeg(config || {});
  });
});

// ------------------------------------------------------------
// Shutdown
// ------------------------------------------------------------

attachShutdown({
  onShutdown: async () => {
    health.setStopping();
    clearInterval(hubStateTimer);

    if (hubLeg) {
      hubLeg.stop();
    }

    io.close();
    await closeHttpServer(server);
    await closeHttpServer(monitorServer);
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
