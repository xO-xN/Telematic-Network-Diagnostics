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
  // lib/players.js is NOT on this list: the template's performer
  // registry was cut in #2, and #5 reintroduced the name with the
  // Local-Network-Diagnostics port (claim tokens for the local-leg
  // probes — network-only, no audio coupling).
  const forbidden = [
    "audio",
    "supercollider",
    "lib/audio-engine.js",
    "lib/osc-transport.js",
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

// ------------------------------------------------------------
// Release pipeline guard (issue #6): the workflow that builds the
// .pnds carries the TND identity, the registry artifact format, and
// keeps hub/ docs/ test/ out of the performance bundle.
// ------------------------------------------------------------

test("release workflow is de-templatized: TND identity, registry artifact name", () => {
  const workflow = fs.readFileSync(
    path.join(PROJECT_ROOT, ".github", "workflows", "package.yml"),
    "utf8",
  );

  assert.doesNotMatch(workflow, /PNDS[- ]Template/i, "template identity is gone");
  assert.match(workflow, /dist\/Telematic Network Diagnostics/);
  assert.match(workflow, /telematic-network-diagnostics-\$\{VERSION\}\.pnds/);

  // hub/, docs/, test/ stay out: named in the verification's forbidden
  // list, and never copied by the allowlist step that precedes it.
  assert.match(workflow, /for f in docs test hub/);

  const assemble = workflow.slice(
    workflow.indexOf("Assemble runnable"),
    workflow.indexOf("Verify bundle"),
  );

  assert.doesNotMatch(assemble, /\bhub\b/, "the allowlist never copies hub/");
  assert.match(assemble, /cp -R lib public node_modules/);

  // The smoke keeps the audio-none launch shape and asserts it.
  const smoke = workflow.slice(
    workflow.indexOf("Smoke-test"),
    workflow.indexOf("Create .pnds"),
  );

  assert.match(smoke, /--audio-mode none/);
  assert.match(smoke, /audioMode":"none/);
});
