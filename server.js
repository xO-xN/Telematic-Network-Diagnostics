// Telematic Network Diagnostics — internet-only score server.
// Both PNDS HTTP entry points display the same diagnostic. Socket.IO on
// the performer port carries observer state and configuration; opening a
// browser never registers a performer or starts a local-network probe.
// The only measured path is this score server's outbound link to HUB.

const os = require("node:os");
const http = require("node:http");
const runtimePorts = require("./lib/runtime-ports");
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
const { HubLeg, normalizeLocation } = require("./lib/hub-leg");
const { overallFromNodes } = require("./lib/flower");
const { attachShutdown, closeHttpServer } = require("./lib/lifecycle");
const shared = require("./public/shared");

const PROJECT_ROOT = __dirname;
const { events: EVENTS } = shared;
const MAX_URL_LENGTH = 256;
const MAX_TOKEN_LENGTH = 128;
const MAX_ROOM_LENGTH = 128;
const MAX_NODE_ID_LENGTH = 64;

const manifest = loadManifest(PROJECT_ROOT);
const cliOptions = parseCliOptions(process.argv.slice(2));

if (cliOptions.help) {
  printUsage();
  process.exit(0);
}

const serverConfig = resolveServerConfig(manifest);
const hostLanIp = resolveHostLanIp(process.env.PNDS_HOST_IP);
const app = express();
const monitorApp = express();

// Preserve the PNDS two-port runtime contract while serving one UI.
// Both entry points follow App theme/locale and use exact shared assets.
for (const httpApp of [app, monitorApp]) {
  libraries.attachBrowserRoutes(httpApp);
  httpApp.get("/__pnds/context.js", (_request, response) => response.type("application/javascript").send(""));
  httpApp.use(express.static(path.join(PROJECT_ROOT, "public")));
  httpApp.get("/__config.js", (_request, response) => {
    response.type("application/javascript").send(
      `window.__PNDS_PORTS__ = { performerPort: ${serverConfig.performerPort}, monitorPort: ${serverConfig.monitorPort} };`,
    );
  });
  httpApp.get("/__pnds/theme-follow.js", (_request, response) => {
    response.sendFile("theme-follow.js", { root: path.join(PROJECT_ROOT, "lib") });
  });
  httpApp.get("/__pnds/locale-follow.js", (_request, response) => {
    response.sendFile("locale-follow.js", { root: path.join(PROJECT_ROOT, "lib") });
  });
}

const health = new HealthTracker({
  projectId: manifest.id,
  audioMode: "none",
  performerPort: serverConfig.performerPort,
  monitorPort: serverConfig.monitorPort,
  runtimeRunId: serverConfig.runtimeAssignment?.runId,
});

app.get("/__pnds/health", health.handler());
monitorApp.get("/__pnds/health", health.handler());

const server = http.createServer(app);
const monitorServer = http.createServer(monitorApp);
Promise.all([
  runtimePorts.listen(server, "performer", serverConfig),
  runtimePorts.listen(monitorServer, "monitor", serverConfig),
]).then(() => {
  runtimePorts.report(serverConfig.runtimeAssignment, "bound");
  health.setAudioDisabled();
  console.log(`[server] ${manifest.name} v${manifest.version}`);
  console.log("[server] audio: disabled (internet-only diagnostic)");
  console.log(`[server] diagnostic: http://${hostLanIp}:${serverConfig.performerPort}/`);
  console.log(`[server] monitor: http://${hostLanIp}:${serverConfig.monitorPort}/`);
}).catch(error => {
  try { runtimePorts.report(serverConfig.runtimeAssignment, "error", error); }
  catch (reportError) { console.error("Runtime listener report failed:", reportError); }
  console.error("Diagnostic HTTP listener failed:", error);
  process.exit(1);
});

const io = libraries.requireLibrary("socket.io")(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// App-supplied values remain separate from the URL, and are available
// as connection defaults. Standalone use can configure the same seam.
const envHub = {
  hubUrl: process.env.PNDS_HUB_URL || "",
  hubToken: process.env.PNDS_HUB_TOKEN || "",
  hubRoom: process.env.PNDS_HUB_ROOM || "",
  nodeId: process.env.PNDS_NODE_ID || "",
};

const hubEvents = [];
let hubLeg = null;
let activeConfig = null;
// A correction belongs to this running diagnostic and node identity.
// It survives transport retries, but never writes App preferences.
let sessionLocation = null;

function normalizeText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function configureHubLeg(config) {
  const value = config && typeof config === "object" ? config : {};
  const normalized = {
    url: normalizeText(value.url, MAX_URL_LENGTH),
    token: normalizeText(value.token, MAX_TOKEN_LENGTH),
    room: normalizeText(value.room, MAX_ROOM_LENGTH) || shared.defaultRoom,
    nodeId: normalizeText(value.nodeId, MAX_NODE_ID_LENGTH) || os.hostname(),
  };
  const sameIdentity = activeConfig &&
    normalized.url === activeConfig.url &&
    normalized.room === activeConfig.room &&
    normalized.nodeId === activeConfig.nodeId;
  const sameConfig = sameIdentity && normalized.token === activeConfig.token;

  // A connected page refresh must not reset the rolling measurement.
  // Re-submitting a disconnected config is an explicit retry, including
  // after token refusal (Socket.IO does not retry middleware refusals).
  if (hubLeg && sameConfig && hubLeg.connected) return;
  if (!sameIdentity) sessionLocation = null;
  if (hubLeg) {
    hubLeg.stop();
    hubLeg = null;
  }
  activeConfig = normalized;

  if (normalized.url && normalized.token) {
    hubLeg = new HubLeg({
      ...normalized,
      ioFactory: (hubUrl, options) => ioClient(hubUrl, options),
      events: hubEvents,
      onChange: broadcastState,
    });
    if (sessionLocation) hubLeg.setLocation(sessionLocation);
    hubLeg.start();
    console.log(`[hub-leg] connecting to ${normalized.url} (room "${normalized.room}", node "${normalized.nodeId}")`);
  } else {
    hubEvents.push({ type: "stopped", detail: "noHubConfigured", at: Date.now() });
  }
  broadcastState();
}

function stateSnapshot() {
  const leg = hubLeg ? hubLeg.snapshot() : null;
  const nodes = leg ? [{
    nodeId: activeConfig.nodeId,
    hubStatus: leg.status,
    isSelf: true,
  }, ...Object.entries(leg.peers || {}).map(([nodeId, peer]) => ({
    nodeId,
    hubStatus: peer.status,
    isSelf: false,
  }))] : [];

  return {
    configured: Boolean(hubLeg),
    // Browser and server use one effective connection baseline, as in
    // the existing LAN-trusted monitor configuration contract.
    activeConfig: activeConfig ? { ...activeConfig } : null,
    env: envHub,
    leg,
    overall: leg ? overallFromNodes(nodes) : null,
  };
}

function broadcastState() {
  io.emit(EVENTS.state, stateSnapshot());
}

// State transitions broadcast immediately; metrics refresh at 1 Hz.
const stateTimer = setInterval(broadcastState, 1000);

if (envHub.hubUrl && envHub.hubToken) {
  configureHubLeg({
    url: envHub.hubUrl,
    token: envHub.hubToken,
    room: envHub.hubRoom,
    nodeId: envHub.nodeId,
  });
}

io.on("connection", (socket) => {
  socket.emit(EVENTS.state, stateSnapshot());
  socket.on(EVENTS.hubConfig, configureHubLeg);
  socket.on(EVENTS.setLocation, (payload, acknowledge) => {
    let result;
    if (!hubLeg) {
      result = { ok: false, error: "notConfigured" };
    } else if (!hubLeg.setLocation(payload)) {
      result = { ok: false, error: "invalidLocation" };
    } else {
      sessionLocation = payload === null ? null : normalizeLocation(payload, "manual");
      result = { ok: true };
      broadcastState();
    }
    if (typeof acknowledge === "function") acknowledge(result);
  });
});

attachShutdown({
  onShutdown: async () => {
    health.setStopping();
    const startedAt = Date.now();
    io.disconnectSockets(true);
    io.close();
    clearInterval(stateTimer);
    if (hubLeg) hubLeg.stop();
    await closeHttpServer(server);
    await closeHttpServer(monitorServer);
    console.log(`[shutdown] cleanup ${Date.now() - startedAt}ms`);
  },
});
