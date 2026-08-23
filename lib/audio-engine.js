// Audio engine framework: scsynth session lifecycle and OSC primitives.
//
// Reusable PNDS core: honours the PNDS Internal audio contract
// (PNDS_AUDIO_OUTPUT_BUS / PNDS_AUDIO_OUTPUT_CHANNELS, compiled .scsyndef
// only, group + synth ownership). Work-specific semantics live in
// audio/controller.js, not here.

const fs = require("node:fs");
const path = require("node:path");
const {
  OscTransport,
  oscFloat,
  oscInteger,
} = require("./osc-transport");

const VALID_MODES = new Set(["internal", "external", "none"]);
const ROOT_GROUP_ID = 0;
const STANDALONE_OUTPUT_BUS = 0;

// PNDS Internal audio contract: the App allocates a private bus and injects
// PNDS_AUDIO_OUTPUT_BUS. Standalone runs have no App master stage and fall
// back to hardware bus 0.
function resolveOutputBus(environment) {
  const rawBus = environment.PNDS_AUDIO_OUTPUT_BUS;

  if (rawBus === undefined || String(rawBus).trim() === "") {
    return STANDALONE_OUTPUT_BUS;
  }

  const bus = Number(rawBus);

  if (!Number.isInteger(bus) || bus < 0) {
    throw new Error(
      `Invalid PNDS_AUDIO_OUTPUT_BUS '${rawBus}': expected a non-negative integer.`,
    );
  }

  return bus;
}

function resolveOutputChannels(environment, manifest) {
  const rawChannels = environment.PNDS_AUDIO_OUTPUT_CHANNELS;

  if (rawChannels === undefined || String(rawChannels).trim() === "") {
    const manifestChannels = manifest.audio?.outputChannels;

    if (manifestChannels === undefined) {
      return 2;
    }

    return manifestChannels;
  }

  const channels = Number(rawChannels);

  if (!Number.isInteger(channels) || channels < 1 || channels > 64) {
    throw new Error(
      `Invalid PNDS_AUDIO_OUTPUT_CHANNELS '${rawChannels}': expected an integer from 1 to 64.`,
    );
  }

  return channels;
}

function resolveSynthDefPaths(projectRoot, manifest) {
  const entries = manifest.audio?.synthdefs;

  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(
      "Internal Synth mode requires audio.synthdefs in manifest.json.",
    );
  }

  return entries.map((entry) => {
    const filePath = path.resolve(projectRoot, entry);

    if (!fs.existsSync(filePath)) {
      throw new Error(`SynthDef file does not exist: ${filePath}`);
    }

    return filePath;
  });
}

class AudioEngine {
  constructor({
    mode,
    target,
    projectRoot,
    manifest,
    environment = process.env,
    transportFactory = null,
  }) {
    if (!VALID_MODES.has(mode)) {
      throw new Error(`Unsupported audio mode: ${mode}`);
    }

    this.mode = mode;
    this.target = target;
    this.projectRoot = projectRoot;
    this.manifest = manifest;
    // Transport seam: OscTransport over UDP in production; tests inject a
    // recording adapter and exercise boot sequence and command encoding
    // without a live scsynth.
    this.transportFactory =
      transportFactory ||
      (({ target: transportTarget }) =>
        new OscTransport({ target: transportTarget }));
    this.osc = null;
    this.started = false;
    // Set as soon as stop() begins: commands arriving after that (late
    // voice releases during shutdown) are meaningless — the session is
    // being torn down — and must not touch the closing transport.
    this.stopped = false;
    this.startPromise = null;
    this.outputBus = resolveOutputBus(environment);
    this.outputChannels = resolveOutputChannels(environment, manifest);
  }

  start() {
    if (!this.startPromise) {
      this.startPromise = this.startInternal();
    }

    return this.startPromise;
  }

  async startInternal() {
    if (this.mode === "none") {
      this.started = true;
      return;
    }

    this.osc = this.transportFactory({ target: this.target });

    try {
      await this.osc.start();

      if (this.mode === "external") {
        this.started = true;
        return;
      }

      const synthDefPaths = resolveSynthDefPaths(
        this.projectRoot,
        this.manifest,
      );

      await this.osc.status();

      for (const synthDefPath of synthDefPaths) {
        await this.osc.loadSynthDef(synthDefPath);
      }

      await this.osc.sync();

      this.started = true;
    } catch (error) {
      await this.osc.close().catch(() => undefined);
      this.osc = null;
      throw error;
    }
  }

  // Internal mode: create a project-owned group under root group 0.
  // Bare scsynth exposes only root group 0; group 1 is created by sclang.
  async createGroup(groupId) {
    if (this.stopped) {
      return;
    }

    await this.start();

    await this.osc.send(
      "/g_new",
      oscInteger(groupId),
      oscInteger(1),
      oscInteger(ROOT_GROUP_ID),
    );
  }

  // Internal mode: create a synth inside a project group.
  async createSynth({ name, nodeId, groupId, out, controls = {} }) {
    if (this.stopped) {
      return;
    }

    await this.start();

    const args = [
      "/s_new",
      name,
      oscInteger(nodeId),
      oscInteger(1),
      oscInteger(groupId),
      "out",
      oscInteger(out),
    ];

    for (const [key, value] of Object.entries(controls)) {
      args.push(key, oscFloat(value));
    }

    await this.osc.send(...args);
  }

  async setControls(nodeId, controls) {
    if (this.stopped) {
      return;
    }

    await this.start();

    const args = ["/n_set", oscInteger(nodeId)];

    for (const [key, value] of Object.entries(controls)) {
      args.push(key, oscFloat(value));
    }

    await this.osc.send(...args);
  }

  async freeNode(nodeId) {
    if (this.stopped) {
      return;
    }

    await this.start();

    await this.osc.send("/n_free", oscInteger(nodeId));
  }

  // External mode: send a work-specific OSC message to the target engine.
  async send(address, args = []) {
    if (this.stopped) {
      return;
    }

    await this.start();

    await this.osc.send(address, ...args);
  }

  // Read a control back from a synth node (/s_get). Lets the work layer
  // verify that a /s_new it sent fire-and-forget actually created the
  // node — a failed /s_new is otherwise silent.
  async verifySynthControl(nodeId, control) {
    if (this.stopped) {
      return null;
    }

    await this.start();
    return this.osc.getSynthControl(nodeId, control);
  }

  async stop() {
    this.stopped = true;

    if (this.mode === "none") {
      this.started = false;
      return;
    }

    if (!this.osc) {
      this.started = false;
      return;
    }

    await this.osc.close();
    this.osc = null;
    this.started = false;
  }
}

module.exports = {
  AudioEngine,
  resolveOutputBus,
  resolveOutputChannels,
  resolveSynthDefPaths,
};
