const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

const {
  AudioEngine,
  resolveOutputBus,
  resolveOutputChannels,
} = require("../lib/audio-engine");
const { oscFloat } = require("../lib/osc-transport");
const {
  mapFreq,
  mapAmp,
  resolveRegister,
  defaultOutChannel,
  validateOutChannel,
} = require("../audio/controller");

test("resolveOutputBus honours the PNDS contract", () => {
  assert.equal(resolveOutputBus({}), 0);
  assert.equal(resolveOutputBus({ PNDS_AUDIO_OUTPUT_BUS: "" }), 0);
  assert.equal(resolveOutputBus({ PNDS_AUDIO_OUTPUT_BUS: "2" }), 2);

  assert.throws(() => resolveOutputBus({ PNDS_AUDIO_OUTPUT_BUS: "-1" }));
  assert.throws(() => resolveOutputBus({ PNDS_AUDIO_OUTPUT_BUS: "left" }));
});

test("resolveOutputChannels falls back to manifest, then to 2", () => {
  assert.equal(
    resolveOutputChannels({}, { audio: { outputChannels: 16 } }),
    16,
  );
  assert.equal(resolveOutputChannels({}, {}), 2);
  assert.equal(
    resolveOutputChannels({ PNDS_AUDIO_OUTPUT_CHANNELS: "8" }, {}),
    8,
  );

  assert.throws(() =>
    resolveOutputChannels({ PNDS_AUDIO_OUTPUT_CHANNELS: "0" }, {}),
  );
  assert.throws(() =>
    resolveOutputChannels({ PNDS_AUDIO_OUTPUT_CHANNELS: "65" }, {}),
  );
});

test("engine commands after stop() are no-ops (shutdown race)", async () => {
  const engine = new AudioEngine({
    mode: "none",
    target: "127.0.0.1:57110",
    projectRoot: ".",
    manifest: {},
    environment: {},
  });

  await engine.start();
  await engine.stop();

  // Late voice releases from the protocol's disconnect handler arrive
  // while the transport is already closed — they must not throw.
  await engine.freeNode(1001);
  await engine.setControls(1001, { amp: 0 });
  await engine.send("/c1/amp", [0]);
  await engine.verifySynthControl(1001, "amp");
});

const { freqRange } = require("../public/shared");

function midFreq(value01) {
  return Math.round(
    freqRange.min + value01 * (freqRange.max - freqRange.min),
  );
}

test("mapFreq maps the fader 0..1 to the freqRange from shared.js", () => {
  assert.equal(mapFreq(0), Math.round(freqRange.min));
  assert.equal(mapFreq(1), Math.round(freqRange.max));
  assert.equal(mapFreq(0.5), midFreq(0.5));
  assert.equal(mapFreq(-1), Math.round(freqRange.min));   // clamped
  assert.equal(mapFreq(2), Math.round(freqRange.max));    // clamped
});

const { registers } = require("../public/shared");

test("mapFreq maps over the selected register's band", () => {
  assert.equal(mapFreq(0, 1), Math.round(registers[1].freqRange.min));
  assert.equal(mapFreq(1, 1), Math.round(registers[1].freqRange.max));
  assert.equal(mapFreq(0, 2), Math.round(registers[2].freqRange.min));
  assert.equal(mapFreq(1, 2), Math.round(registers[2].freqRange.max));
  assert.equal(
    mapFreq(0.5, 2),
    Math.round(
      registers[2].freqRange.min +
        0.5 * (registers[2].freqRange.max - registers[2].freqRange.min),
    ),
  );
  assert.equal(mapFreq(0.5, 99), mapFreq(0.5)); // invalid register -> default
});

test("resolveRegister coerces 1|2|3 and defaults to 3", () => {
  assert.equal(resolveRegister(1), 1);
  assert.equal(resolveRegister("2"), 2);
  assert.equal(resolveRegister(3), 3);
  assert.equal(resolveRegister(undefined), 3);
  assert.equal(resolveRegister(null), 3);
  assert.equal(resolveRegister(0), 3);
  assert.equal(resolveRegister("x"), 3);
});

test("mapAmp applies an audio-taper (squared) curve", () => {
  assert.equal(mapAmp(0), 0);
  assert.equal(mapAmp(1), 1);
  assert.equal(mapAmp(0.5), 0.25);
  assert.ok(Math.abs(mapAmp(0.1) - 0.01) < 1e-12); // 0.1^2 is not exact in binary
  assert.equal(mapAmp(-1), 0);
  assert.equal(mapAmp(2), 1);
});

test("defaultOutChannel: odd ids to channel 1, even ids to channel 2", () => {
  assert.equal(defaultOutChannel(1), 1);
  assert.equal(defaultOutChannel(2), 2);
  assert.equal(defaultOutChannel(3), 1);
  assert.equal(defaultOutChannel(16), 2);
});

test("validateOutChannel rejects out-of-range channels", () => {
  assert.equal(validateOutChannel(1, 16), 1);
  assert.equal(validateOutChannel(16, 16), 16);

  assert.throws(() => validateOutChannel(0, 16));
  assert.throws(() => validateOutChannel(17, 16));
  assert.throws(() => validateOutChannel("x", 16));
});

// ------------------------------------------------------------
// Engine commands through an injected (recording) transport — no
// scsynth, no UDP; asserts the boot sequence and scsynth encoding.
// ------------------------------------------------------------

class FakeTransport {
  constructor() {
    this.sent = [];
    this.closed = false;
    this.nextSyncId = 1;
  }

  async start() {}

  async send(address, ...args) {
    this.sent.push({ address, args });
  }

  // The request-style helpers go through send(), like the real transport.
  async status() {
    await this.send("/status");
    return { address: "/status.reply" };
  }

  async loadSynthDef(filePath) {
    await this.send("/d_load", filePath);
    return { address: "/done" };
  }

  async sync() {
    const syncId = this.nextSyncId;
    this.nextSyncId += 1;
    await this.send("/sync", { type: "integer", value: syncId });
    return { address: "/synced" };
  }

  async getSynthControl(nodeId, control) {
    await this.send("/s_get", nodeId, control);
    return { address: "/n_set" };
  }

  async close() {
    this.closed = true;
  }
}

function plain(argument) {
  return argument && argument.value !== undefined ? argument.value : argument;
}

function createEngine({ mode = "internal" } = {}) {
  const transport = new FakeTransport();
  const engine = new AudioEngine({
    mode,
    target: "127.0.0.1:57110",
    projectRoot: path.join(__dirname, ".."),
    manifest: {
      audio: { synthdefs: ["supercollider/synthdefs/template-sine.scsyndef"] },
    },
    environment: {},
    transportFactory: () => transport,
  });

  return { engine, transport };
}

test("internal boot pings status, loads each synthdef, then syncs", async () => {
  const { engine, transport } = createEngine();

  await engine.start();

  assert.deepEqual(
    transport.sent.map((m) => m.address),
    ["/status", "/d_load", "/sync"],
  );
  assert.equal(
    transport.sent[1].args[0],
    path.join(__dirname, "..", "supercollider/synthdefs/template-sine.scsyndef"),
  );
});

test("engine commands encode the scsynth argument order", async () => {
  const { engine, transport } = createEngine();

  await engine.createGroup(1000);
  await engine.createSynth({
    name: "template-sine",
    nodeId: 1001,
    groupId: 1000,
    out: 3,
    controls: { amp: 0.25, freq: 440 },
  });
  await engine.setControls(1001, { amp: 0.5 });
  await engine.freeNode(1001);

  assert.deepEqual(
    transport.sent.map((m) => [m.address, ...m.args.map(plain)]),
    [
      ["/status"],
      ["/d_load", path.join(__dirname, "..", "supercollider/synthdefs/template-sine.scsyndef")],
      ["/sync", 1],
      ["/g_new", 1000, 1, 0],
      ["/s_new", "template-sine", 1001, 1, 1000, "out", 3, "amp", 0.25, "freq", 440],
      ["/n_set", 1001, "amp", 0.5],
      ["/n_free", 1001],
    ],
  );
});

test("stop() closes the injected transport", async () => {
  const { engine, transport } = createEngine();

  await engine.start();
  await engine.stop();

  assert.equal(transport.closed, true);
});

test("verifySynthControl reads a control back (/s_get)", async () => {
  const { engine, transport } = createEngine();

  await engine.start();
  await engine.verifySynthControl(1001, "amp");

  assert.deepEqual(transport.sent.at(-1), {
    address: "/s_get",
    args: [1001, "amp"],
  });
});

test("external send passes the work OSC message through", async () => {
  const { engine, transport } = createEngine({ mode: "external" });

  await engine.start();
  await engine.send("/c1/amp", [oscFloat(0.25)]);
  await engine.stop(); // leave no transport (socket) behind

  assert.deepEqual(transport.sent, [
    { address: "/c1/amp", args: [{ type: "float", value: 0.25 }] },
  ]);
});
