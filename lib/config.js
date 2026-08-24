// Manifest, CLI and port resolution.
//
// Reusable PNDS core: every score server needs to load manifest.json, parse
// a few CLI flags and resolve the server ports.
//
// This project runs without audio (mode is always "none"), so the audio-mode
// / OSC machinery of the template has been removed. `--audio-mode` is still
// accepted for App compatibility (the App launches the entry with the
// manifest's defaultMode) but its value is ignored.

const fs = require("node:fs");
const path = require("node:path");

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
      // Accepted for App compatibility (the App launches the entry with
      // the manifest's defaultMode); this project always runs with
      // audio disabled, so the value is consumed and ignored. The
      // --audio-mode=<mode> form needs no handling — unmatched
      // arguments are ignored anyway.
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
      "  --audio-mode <mode>  Accepted for App compatibility (ignored: this",
      "                      project always runs with audio disabled)",
      "  -h, --help           Show this help",
      "",
      "Environment:",
      "  PNDS_HOST_IP         LAN IP advertised to performers",
    ].join("\n"),
  );
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
      "scoreServer.performerPort and scoreServer.monitorPort must be different.",
    );
  }

  return {
    entry: scoreServer.entry,
    workingDirectory: scoreServer.workingDirectory || ".",
    performerPort,
    monitorPort,
  };
}

module.exports = {
  loadManifest,
  parseCliOptions,
  printUsage,
  resolveServerConfig,
};
