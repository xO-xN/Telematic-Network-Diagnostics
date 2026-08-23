// PNDS Template — score server entry point.
//
// Composition root: wires the reusable core (lib/) to the work layer
// (audio/controller.js):
// - serves performer + monitor pages from public/ on both ports
// - exposes /__pnds/health on both ports
// - attaches the performer protocol (join / claim / restore / control —
//   lib/protocol.js owns the semantics)
// - shuts down cleanly on SIGINT / SIGTERM

const path = require("node:path");
const express = require("express");

const {
  loadManifest,
  parseCliOptions,
  printUsage,
  resolveAudioMode,
  resolveOscTarget,
  resolveServerConfig,
  formatAudioMode,
} = require("./lib/config");
const { resolveHostLanIp } = require("./lib/network");
const { HealthTracker } = require("./lib/health");
const { AudioEngine } = require("./lib/audio-engine");
const { PlayerRegistry } = require("./lib/players");
const { SeatsStore } = require("./lib/seats-store");
const { qrHandler } = require("./lib/qr");
const { attachProtocol } = require("./lib/protocol");
const { ProjectAudio } = require("./audio/controller");
const {
  attachShutdown,
  closeHttpServer,
} = require("./lib/lifecycle");
const shared = require("./public/shared");

const PROJECT_ROOT = __dirname;

// ------------------------------------------------------------
// Configuration
// ------------------------------------------------------------

const manifest = loadManifest(PROJECT_ROOT);
const cliOptions = parseCliOptions(process.argv.slice(2));

if (cliOptions.help) {
  printUsage();
  process.exit(0);
}

const audioMode = resolveAudioMode(cliOptions.audioMode, manifest);
const oscTarget = resolveOscTarget(
  cliOptions.oscTarget,
  manifest,
  process.env,
);
const serverConfig = resolveServerConfig(manifest);
const hostLanIp = resolveHostLanIp(process.env.PNDS_HOST_IP);

// ------------------------------------------------------------
// HTTP servers (performer port + monitor port share public/)
// ------------------------------------------------------------

const app = express();
const monitorApp = express();

app.use(express.static(path.join(PROJECT_ROOT, "public")));
monitorApp.use(express.static(path.join(PROJECT_ROOT, "public")));

// Injects runtime config into the browser so shared.js can read it.
// Ports come from the manifest; outputChannels is the RESOLVED channel
// count (App-injected PNDS_AUDIO_OUTPUT_CHANNELS or the manifest value),
// so the monitor page offers exactly the channels the server validates.
function configScript(request, response) {
  response.type("application/javascript").send(
    `window.__PNDS_CONFIG__ = { performerPort: ${serverConfig.performerPort}, monitorPort: ${serverConfig.monitorPort}, outputChannels: ${audioEngine.outputChannels} };`,
  );
}

app.get("/__config.js", configScript);
monitorApp.get("/__config.js", configScript);

const health = new HealthTracker({
  projectId: manifest.id,
  audioMode,
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
// branch of the page never loads it and keeps the project's own
// colors.
monitorApp.get("/__pnds/theme-follow.js", (request, response) => {
  response.sendFile(path.join(PROJECT_ROOT, "lib", "theme-follow.js"));
});

// ------------------------------------------------------------
// Audio layer
// ------------------------------------------------------------

const audioEngine = new AudioEngine({
  mode: audioMode,
  target: oscTarget,
  projectRoot: PROJECT_ROOT,
  manifest,
  environment: process.env,
});
const projectAudio = new ProjectAudio(audioEngine);

const registry = new PlayerRegistry({
  maxClients: audioEngine.outputChannels,
});

// Seat assignments (token -> {id, out}) survive restarts, so a reopened
// work hands every known device back its seat and channel. Relocate the
// file with PNDS_SEATS_FILE (tests and the App point it elsewhere).
const seats = new SeatsStore({
  file:
    process.env.PNDS_SEATS_FILE ||
    path.join(PROJECT_ROOT, ".pnds-seats.json"),
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

const io = require("socket.io")(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

async function startAudio() {
  health.setAudioStarting();

  try {
    await projectAudio.start();
    health.setAudioReady(oscTarget);
  } catch (error) {
    console.error("[audio] start failed:", error);
    health.setError(error);
    process.exitCode = 1;
  }
}

startAudio();

// ------------------------------------------------------------
// Socket.IO protocol (lib/protocol.js owns the semantics)
// ------------------------------------------------------------

attachProtocol(io, {
  events: shared.events,
  registry,
  projectAudio,
  seats,
});

// ------------------------------------------------------------
// Shutdown
// ------------------------------------------------------------

attachShutdown({
  onShutdown: async () => {
    health.setStopping();
    io.close();
    await projectAudio.stop();
    await closeHttpServer(server);
    await closeHttpServer(monitorServer);
  },
});

// ------------------------------------------------------------
// Console output
// ------------------------------------------------------------

function printRuntimeInfo() {
  console.log(`[server] ${manifest.name} v${manifest.version}`);
  console.log(
    `[server] audio mode: ${formatAudioMode(audioMode)} (target ${oscTarget})`,
  );
  console.log(
    `[server] output: ${audioEngine.outputChannels} channels from bus ${audioEngine.outputBus}`,
  );
  console.log(
    `[server] performer page: http://${hostLanIp}:${serverConfig.performerPort}/`,
  );
}
