const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

const {
  loadManifest,
  resolveAudioMode,
  resolveOscTarget,
  resolveServerConfig,
} = require("../lib/config");

const PROJECT_ROOT = path.join(__dirname, "..");

test("loadManifest reads the project manifest", () => {
  const manifest = loadManifest(PROJECT_ROOT);

  assert.equal(manifest.schemaVersion, 1);
  assert.ok(
    Number.isInteger(manifest.audio.outputChannels) &&
      manifest.audio.outputChannels >= 1,
  );
  assert.notEqual(
    manifest.scoreServer.performerPort,
    manifest.scoreServer.monitorPort,
  );
});

test("resolveAudioMode falls back to the manifest default", () => {
  const manifest = loadManifest(PROJECT_ROOT);

  assert.equal(resolveAudioMode(undefined, manifest), "internal");
  assert.equal(resolveAudioMode("none", manifest), "none");
  assert.throws(() => resolveAudioMode("bogus", manifest));
});

test("resolveOscTarget priority: env > cli > manifest", () => {
  const manifest = loadManifest(PROJECT_ROOT);

  assert.equal(
    resolveOscTarget(undefined, manifest, {
      PNDS_OSC_TARGET: "10.0.0.5:9999",
    }),
    "10.0.0.5:9999",
  );
  assert.equal(
    resolveOscTarget("127.0.0.1:57120", manifest, {}),
    "127.0.0.1:57120",
  );
  assert.equal(
    resolveOscTarget(undefined, manifest, {}),
    "127.0.0.1:57110",
  );
});

test("resolveServerConfig returns the manifest ports", () => {
  const manifest = loadManifest(PROJECT_ROOT);
  const config = resolveServerConfig(manifest);

  assert.equal(config.performerPort, manifest.scoreServer.performerPort);
  assert.equal(config.monitorPort, manifest.scoreServer.monitorPort);
});
