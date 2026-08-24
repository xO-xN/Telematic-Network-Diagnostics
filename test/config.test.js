// Project identity and configuration resolution (issue #2): the repo
// must BE Telematic Network Diagnostics — manifest identity, none-only
// audio, the template's audio stack gone.

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const {
  loadManifest,
  parseCliOptions,
  resolveServerConfig,
} = require("../lib/config");

const PROJECT_ROOT = path.join(__dirname, "..");

// ------------------------------------------------------------
// Manifest identity
// ------------------------------------------------------------

test("manifest carries the Telematic Network Diagnostics identity", () => {
  const manifest = loadManifest(PROJECT_ROOT);

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, "telematic-network-diagnostics");
  assert.equal(manifest.name, "Telematic Network Diagnostics");
  assert.equal(manifest.version, "0.1.0");
});

test("manifest is audio none-only (network-only project)", () => {
  const manifest = loadManifest(PROJECT_ROOT);

  assert.equal(manifest.audio.defaultMode, "none");
  assert.deepEqual(manifest.audio.supportedModes, ["none"]);
});

test("manifest serves the score server on ports 6868 / 6869", () => {
  const manifest = loadManifest(PROJECT_ROOT);

  assert.equal(manifest.scoreServer.entry, "server.js");
  assert.equal(manifest.scoreServer.performerPort, 6868);
  assert.equal(manifest.scoreServer.monitorPort, 6869);
});

// ------------------------------------------------------------
// Config resolution
// ------------------------------------------------------------

test("resolveServerConfig returns the manifest ports", () => {
  const config = resolveServerConfig(loadManifest(PROJECT_ROOT));

  assert.equal(config.performerPort, 6868);
  assert.equal(config.monitorPort, 6869);
});

test("parseCliOptions: --help asked, --audio-mode accepted and ignored", () => {
  assert.deepEqual(parseCliOptions(["--help"]), { help: true });
  assert.deepEqual(parseCliOptions(["-h"]), { help: true });
  assert.deepEqual(parseCliOptions(["--audio-mode", "none"]), {});
  assert.deepEqual(parseCliOptions(["--audio-mode=internal"]), {});
  assert.deepEqual(parseCliOptions([]), {});
});

// ------------------------------------------------------------
// De-templatization guard (issue #2: "audio stack leaves no remnants")
// ------------------------------------------------------------

test("the template's audio stack is gone from the repo", () => {
  const forbidden = [
    "audio",
    "supercollider",
    "lib/audio-engine.js",
    "lib/osc-transport.js",
    "lib/players.js",
    "lib/protocol.js",
    "lib/seats-store.js",
    "public/libraries",
  ];

  for (const relative of forbidden) {
    assert.equal(
      fs.existsSync(path.join(PROJECT_ROOT, relative)),
      false,
      `${relative} must not exist`,
    );
  }
});

test("package.json is de-templatized: identity, no audio dependencies", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"),
  );

  assert.equal(packageJson.name, "telematic-network-diagnostics");
  assert.equal(packageJson.version, "0.1.0");
  assert.equal("osc-min" in packageJson.dependencies, false);
  assert.equal("osc-min" in (packageJson.devDependencies || {}), false);
});
