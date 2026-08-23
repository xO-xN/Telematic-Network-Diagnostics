// ProjectAudio contract tests against a fake engine — no AudioEngine
// class, no UDP. The fake records every engine write, so tests can assert
// the exact message sequence (the reconnect path must birth a voice with
// its persisted state, never mutate a default voice afterwards).

const { test } = require("node:test");
const assert = require("node:assert");

const { ProjectAudio, FREQ_MIN } = require("../audio/controller");
const shared = require("../public/shared");

class FakeEngine {
  constructor({ mode = "internal", outputChannels = 16, outputBus = 0 } = {}) {
    this.mode = mode;
    this.outputChannels = outputChannels;
    this.outputBus = outputBus;
    this.createSynthCalls = [];
    this.setControlsCalls = [];
    this.freedNodes = [];
    this.sent = [];
    this.verified = [];
    this.failVerify = false;
  }

  async start() {}

  async createGroup() {}

  async createSynth(args) {
    this.createSynthCalls.push(args);
  }

  async setControls(nodeId, controls) {
    this.setControlsCalls.push({ nodeId, controls });
  }

  async freeNode(nodeId) {
    this.freedNodes.push(nodeId);
  }

  async send(address, args) {
    this.sent.push({ address, args });
  }

  async verifySynthControl(nodeId, control) {
    if (this.failVerify) {
      throw new Error("node not found");
    }

    this.verified.push({ nodeId, control });
    return 0;
  }

  async stop() {}
}

test("ProjectAudio accepts any engine satisfying the engine interface", () => {
  // Regression: the constructor once required engine instanceof AudioEngine,
  // which blocked substitute engines (and forced tests through real UDP).
  assert.doesNotThrow(() => new ProjectAudio(new FakeEngine()));
});

test("addVoice births an internal voice silent on its default channel", async () => {
  const engine = new FakeEngine();
  const audio = new ProjectAudio(engine);

  await audio.addVoice(1);

  assert.strictEqual(engine.createSynthCalls.length, 1);
  assert.strictEqual(engine.setControlsCalls.length, 0);

  const [synth] = engine.createSynthCalls;

  assert.strictEqual(synth.out, 0); // engine.outputBus + channel 1 - 1
  assert.strictEqual(synth.controls.amp, 0);
  // The untouched voice reports the mapped raw-0 freq (rounded), not the
  // unrounded band minimum — mapFreq is the single raw→Hz owner.
  assert.strictEqual(synth.controls.freq, Math.round(FREQ_MIN));

  // The /s_new is proven by a read-back, not trusted fire-and-forget.
  assert.deepStrictEqual(engine.verified, [{ nodeId: 1001, control: "amp" }]);
});

test("a voice whose /s_new silently failed is not registered", async () => {
  // Without the read-back a failed /s_new leaves a phantom voice the
  // server believes in; with it, the join is rejected instead.
  const engine = new FakeEngine();
  const audio = new ProjectAudio(engine);

  engine.failVerify = true;

  await assert.rejects(() => audio.addVoice(1));

  assert.strictEqual(audio.hasVoice(1), false);
  assert.strictEqual(engine.verified.length, 0); // the throw pre-empts recording
  assert.strictEqual(engine.createSynthCalls.length, 1); // the /s_new went out
});

test("addVoice with persisted state births the voice restored — no intermediate writes", async () => {
  // The reconnect path: a voice born with defaults and mutated afterwards
  // passes through audible intermediate states (restored amp still on the
  // default channel). The persisted state must arrive with the /s_new.
  const engine = new FakeEngine({ outputBus: 2 });
  const audio = new ProjectAudio(engine);

  await audio.addVoice(1);
  await audio.setControls(1, { amp: 0.5, freq: 0.5, range: 2 });
  await audio.setOutChannel(1, 5);

  const state = audio.voiceState(1);
  const writesBeforeRebirth = engine.setControlsCalls.length;

  await audio.removeVoice(1);

  assert.strictEqual(engine.createSynthCalls.length, 1); // the original voice

  await audio.addVoice(1, state);

  assert.strictEqual(engine.createSynthCalls.length, 2);
  // No engine write beyond the two the live path already made: the state
  // travels with the /s_new, not as /n_set mutations afterwards.
  assert.strictEqual(engine.setControlsCalls.length, writesBeforeRebirth);

  const reborn = engine.createSynthCalls[1];

  // Born with the restored raw values, mapped once: amp 0.5 -> 0.25,
  // freq over register 2's band, out on physical bus for channel 5.
  assert.strictEqual(reborn.out, 2 + 5 - 1);
  assert.strictEqual(reborn.controls.amp, 0.25);
  assert.strictEqual(
    reborn.controls.freq,
    Math.round(
      shared.registers[2].freqRange.min +
        0.5 * (shared.registers[2].freqRange.max - shared.registers[2].freqRange.min),
    ),
  );

  // The restored voice reports the same state back: no double-mapping.
  assert.deepEqual(audio.voiceState(1), state);
});

test("external mode addVoice sends the state as its first messages", async () => {
  const engine = new FakeEngine({ mode: "external" });
  const audio = new ProjectAudio(engine);

  await audio.addVoice(1, { amp: 0.5, freq: 0.5, range: 2, out: 3 });

  assert.deepEqual(
    engine.sent.map((m) => m.address),
    ["/c1/amp", "/c1/freq", "/c1/out"],
  );

  const ampValue = engine.sent[0].args[0].value;

  // Mapped once (0.5 -> 0.25), not the raw value and not the default 0.
  assert.strictEqual(ampValue, 0.25);
  assert.strictEqual(engine.sent[2].args[0].value, 3);
});

test("setOutChannel validates against the engine's outputChannels", async () => {
  const audio = new ProjectAudio(new FakeEngine({ outputChannels: 4 }));

  await audio.addVoice(1);

  await assert.rejects(() => audio.setOutChannel(1, 5));
});

test("setControls applies only the fields it receives — partials keep the rest", async () => {
  const audio = new ProjectAudio(new FakeEngine());

  await audio.addVoice(1);
  await audio.setControls(1, { amp: 0.5, freq: 0.5, range: 2 });
  await audio.setControls(1, { amp: 0.8 });

  const state = audio.voiceState(1);

  assert.strictEqual(state.amp, 0.8);
  assert.strictEqual(state.freq, 0.5); // untouched by the partial payload
  assert.strictEqual(state.range, 2);
});

test("setControls ignores non-numeric, unknown and null payloads", async () => {
  // The payload arrives unvalidated from the wire (the protocol forwards
  // it opaquely): a malformed message must not zero a fader mid-show.
  const audio = new ProjectAudio(new FakeEngine());

  await audio.addVoice(1);
  await audio.setControls(1, { amp: 0.5, freq: 0.5, range: 2 });
  await audio.setControls(1, { amp: "loud", volume: 1 });
  await audio.setControls(1, null);

  assert.deepEqual(audio.voiceState(1), {
    amp: 0.5,
    freq: 0.5,
    range: 2,
    out: 1,
  });
});

test("removeVoice frees the synth node", async () => {
  const engine = new FakeEngine();
  const audio = new ProjectAudio(engine);

  await audio.addVoice(3);
  await audio.removeVoice(3);

  assert.deepEqual(engine.freedNodes, [1003]);
  assert.strictEqual(audio.hasVoice(3), false);
});
