// Manifest, CLI, environment and port resolution.
//
// Reusable PNDS core: every score server needs to load manifest.json, parse
// a few CLI flags and resolve the audio mode / OSC target / server ports.

const fs = require("node:fs");
const path = require("node:path");

const VALID_AUDIO_MODES = new Set(["internal", "external", "none"]);
const DEFAULT_STANDALONE_TARGET = "127.0.0.1:57110";

function loadManifest(projectRoot) {
  const manifestPath = path.join(projectRoot, "manifest.json");
  const raw = fs.readFileSync(manifestPath, "utf8");
  return JSON.parse(raw);
}

function parseCliOptions(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--audio-mode") {
      options.audioMode = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--audio-mode=")) {
      options.audioMode = argument.slice("--audio-mode=".length);
    } else if (argument === "--osc-target") {
      options.oscTarget = argv[index + 1];
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    }
  }

  return options;
}

function printUsage() {
  console.log(
    [
      "Usage: node server.js [options]",
      "",
      "Options:",
      "  --audio-mode <internal|external|none>  Audio mode (default: manifest)",
      "  --osc-target <host:port>               OSC target (overrides manifest)",
      "  -h, --help                             Show this help",
      "",
      "Environment:",
      "  PNDS_OSC_TARGET          OSC target (highest priority)",
      "  PNDS_HOST_IP             LAN IP advertised to performers",
      "  PNDS_AUDIO_OUTPUT_BUS    First output bus (injected by PNDS App)",
      "  PNDS_AUDIO_OUTPUT_CHANNELS  Discrete output channel count (injected by PNDS App)",
    ].join("\n"),
  );
}

function resolveAudioMode(requestedMode, manifest) {
  const supportedModes = manifest.audio?.supportedModes;

  if (!Array.isArray(supportedModes) || supportedModes.length === 0) {
    throw new Error(
      "manifest.json must declare a non-empty audio.supportedModes array.",
    );
  }

  for (const mode of supportedModes) {
    if (!VALID_AUDIO_MODES.has(mode)) {
      throw new Error(`Unsupported audio mode in manifest: '${mode}'.`);
    }
  }

  const mode = requestedMode || manifest.audio?.defaultMode;

  if (!VALID_AUDIO_MODES.has(mode)) {
    throw new Error(`Unsupported audio mode: '${mode}'.`);
  }

  if (!supportedModes.includes(mode)) {
    throw new Error(
      `Audio mode '${mode}' is not in manifest audio.supportedModes.`,
    );
  }

  return mode;
}

function resolveOscTarget(cliTarget, manifest, environment) {
  const environmentTarget = environment.PNDS_OSC_TARGET;
  const standaloneTarget =
    manifest.audio?.standaloneTarget || DEFAULT_STANDALONE_TARGET;

  let rawTarget = environmentTarget || cliTarget || standaloneTarget;

  if (!rawTarget || String(rawTarget).trim() === "") {
    rawTarget = DEFAULT_STANDALONE_TARGET;
  }

  return String(rawTarget).trim();
}

function parseHttpPort(value, label) {
  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer from 1 to 65535.`);
  }

  return port;
}

function resolveServerConfig(manifest) {
  const scoreServer = manifest.scoreServer;

  if (!scoreServer) {
    throw new Error("manifest.json must declare a scoreServer object.");
  }

  const performerPort = parseHttpPort(
    scoreServer.performerPort,
    "scoreServer.performerPort",
  );
  const monitorPort = parseHttpPort(
    scoreServer.monitorPort,
    "scoreServer.monitorPort",
  );

  if (performerPort === monitorPort) {
    throw new Error(
      "scoreServer.performerPort and monitorPort must be different.",
    );
  }

  return {
    entry: scoreServer.entry,
    workingDirectory: scoreServer.workingDirectory || ".",
    performerPort,
    monitorPort,
  };
}

function formatAudioMode(mode) {
  if (mode === "internal") {
    return "Internal Synth";
  }

  if (mode === "external") {
    return "External OSC";
  }

  return "None";
}

module.exports = {
  loadManifest,
  parseCliOptions,
  printUsage,
  resolveAudioMode,
  resolveOscTarget,
  resolveServerConfig,
  formatAudioMode,
};
