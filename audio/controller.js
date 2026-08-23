// PNDS Template work layer: per-client sine voice control.
//
// This is the file creators edit to change the *semantics* of the work
// (what the faders do, how voices are routed) — including the shape of
// control payloads, which lib/protocol.js forwards opaquely. The
// transport and engine primitives live in lib/.
//
// Conventions:
// - Every joined client gets one voice (one sine synth in Internal mode).
// - Odd ids default to output channel 1, even ids to channel 2.
// - The monitor page can reassign any client to another output channel.
// - Each voice is capped at -6 dB in the SynthDef (amp * 0.5).

const { oscFloat } = require("../lib/osc-transport");
const {
  freqRange,
  registers,
  defaultRegister,
} = require("../public/shared");

const SYNTH_NAME = "template-sine";
const GROUP_ID = 1000;
const NODE_BASE = 1000;
// Single source of truth: the same freqRange the performer page displays
// (public/shared.js registers). Change the ranges there, not here.
const FREQ_MIN = freqRange.min;
const FREQ_MAX = freqRange.max;

function clamp01(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 0;
  }

  return Math.max(0, Math.min(1, number));
}

// Register (fader band) from a control payload: 1 | 2 | 3, default 3.
function resolveRegister(value) {
  const number = Number(value);

  return number === 1 || number === 2 || number === 3
    ? number
    : defaultRegister;
}

// Fader value (0..1) to frequency in Hz: linear over the register's range
// (registers from shared.js). Invalid registers fall back to the default.
function mapFreq(value01, register = defaultRegister) {
  const range = registers[resolveRegister(register)].freqRange;

  return Math.round(
    range.min + clamp01(value01) * (range.max - range.min),
  );
}

// Fader response curve for amp (audio taper): the lower half of the fader
// gets finer control, matching how mixing-desk faders behave.
function mapAmp(value01) {
  const value = clamp01(value01);

  return value * value;
}

// Default output channel: odd ids -> channel 1, even ids -> channel 2.
function defaultOutChannel(id) {
  return id % 2 === 1 ? 1 : 2;
}

// Apply a control payload to a voice record. The payload arrives
// unvalidated from the wire (protocol forwards it opaquely): fields
// that are not finite numbers are ignored — a malformed message must
// not zero a fader mid-show — and unknown fields are not read. Single
// owner of the raw→mapped mapping: addVoice(…, state) and setControls
// feed through here, so birth-with-state and live control cannot drift
// apart.
function applyControls(voice, payload) {
  const fields = payload || {};
  const range = Number(fields.range);

  if (range === 1 || range === 2 || range === 3) {
    voice.register = range;
  }

  if (Number.isFinite(Number(fields.amp))) {
    voice.rawAmp = clamp01(fields.amp);
  }

  if (Number.isFinite(Number(fields.freq))) {
    voice.rawFreq = clamp01(fields.freq);
  }

  voice.amp = mapAmp(voice.rawAmp);
  voice.freq = mapFreq(voice.rawFreq, voice.register);
}

function validateOutChannel(channel, outputChannels) {
  const value = Number(channel);

  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > outputChannels
  ) {
    throw new Error(
      `Invalid output channel '${channel}': expected an integer from 1 to ${outputChannels}.`,
    );
  }

  return value;
}

class ProjectAudio {
  // The engine only needs to satisfy the engine interface (mode,
  // outputChannels, outputBus and the command methods) — no class check,
  // so tests and alternate engines slot in at this seam.
  constructor(engine) {
    this.engine = engine;
    this.voices = new Map(); // id -> { nodeId, amp, freq, out }
  }

  get mode() {
    return this.engine.mode;
  }

  async start() {
    await this.engine.start();

    if (this.engine.mode === "internal") {
      // Project-owned group created before health reports ready.
      await this.engine.createGroup(GROUP_ID);
    }
  }

  // A state (the shape voiceState() returns) births the voice already
  // restored — one /s_new or one message burst carries the correct
  // values. A default birth followed by restore would pass through
  // audible intermediate states (restored amp on the default channel).
  async addVoice(id, state = null) {
    const voice = {
      nodeId: NODE_BASE + id,
      amp: 0,
      // The default birth freq goes through mapFreq like every other
      // freq: an untouched voice must report exactly what a raw-0 fader
      // maps to (rounded), not the unrounded band minimum.
      freq: mapFreq(0),
      rawAmp: 0,
      rawFreq: 0,
      register: defaultRegister,
      out: defaultOutChannel(id),
    };

    if (state) {
      applyControls(voice, state);

      // A persisted out the current engine can't route (the channel
      // count changed between runs) falls back to the default instead of
      // rejecting the device — the seat record heals on the next persist.
      try {
        voice.out = validateOutChannel(state.out, this.engine.outputChannels);
      } catch {
        voice.out = defaultOutChannel(id);
      }
    }

    if (this.engine.mode === "internal") {
      await this.engine.createSynth({
        name: SYNTH_NAME,
        nodeId: voice.nodeId,
        groupId: GROUP_ID,
        out: this.busFor(voice.out),
        controls: {
          amp: voice.amp,
          freq: voice.freq,
        },
      });

      // A fire-and-forget /s_new that failed (bad def name, dead engine)
      // is otherwise silent — read a control back to prove the node
      // exists. The throw rejects the join instead of leaving a phantom
      // voice the server believes in.
      await this.engine.verifySynthControl(voice.nodeId, "amp");
    } else if (this.engine.mode === "external") {
      await this.sendVoiceState(id, voice);
    }

    this.voices.set(id, voice);

    return voice;
  }

  async setControls(id, payload) {
    const voice = this.voices.get(id);

    if (!voice) {
      throw new Error(`No voice for client ${id}.`);
    }

    // Keep the raw fader values (0..1) so a reconnect can restore the
    // voice by re-mapping them (setControls must not be fed already-mapped
    // values — that would map them twice). The payload is applied
    // field-by-field; applyControls is the wire-side gatekeeper.
    applyControls(voice, payload);

    if (this.engine.mode === "internal") {
      await this.engine.setControls(voice.nodeId, {
        amp: voice.amp,
        freq: voice.freq,
      });
    } else if (this.engine.mode === "external") {
      await this.sendVoiceState(id, voice);
    }
  }

  async setOutChannel(id, channel) {
    const voice = this.voices.get(id);

    if (!voice) {
      throw new Error(`No voice for client ${id}.`);
    }

    voice.out = validateOutChannel(channel, this.engine.outputChannels);

    if (this.engine.mode === "internal") {
      await this.engine.setControls(voice.nodeId, {
        out: this.busFor(voice.out),
      });
    } else if (this.engine.mode === "external") {
      await this.engine.send(
        `/c${id}/out`,
        [oscFloat(voice.out)],
      );
    }
  }

  hasVoice(id) {
    return this.voices.has(id);
  }

  // Persistable voice state keyed by claim token: the raw fader values
  // plus register and output channel. voiceState()/restoreVoice() are the
  // single owner of the reconnect-restore shape.
  voiceState(id) {
    const voice = this.voices.get(id);

    if (!voice) {
      return null;
    }

    return {
      amp: voice.rawAmp,
      freq: voice.rawFreq,
      range: voice.register,
      out: voice.out,
    };
  }

  // Restore a persisted voiceState(): re-map the raw values. Feeding
  // already-mapped values here would map them twice (see setControls).
  async restoreVoice(id, state) {
    await this.setControls(id, {
      amp: state.amp,
      freq: state.freq,
      range: state.range,
    });

    await this.setOutChannel(id, state.out);
  }

  async removeVoice(id) {
    const voice = this.voices.get(id);

    if (!voice) {
      return;
    }

    if (this.engine.mode === "internal") {
      await this.engine.freeNode(voice.nodeId);
    }

    this.voices.delete(id);
  }

  async stop() {
    await this.engine.stop();
  }

  // Physical scsynth bus for a 1-based work channel.
  busFor(channel) {
    return this.engine.outputBus + channel - 1;
  }

  snapshot() {
    return [...this.voices.entries()].map(([id, voice]) => ({
      id,
      amp: voice.amp,
      freq: voice.freq,
      register: voice.register,
      out: voice.out,
    }));
  }

  async sendVoiceState(id, voice) {
    await this.engine.send(`/c${id}/amp`, [oscFloat(voice.amp)]);
    await this.engine.send(`/c${id}/freq`, [oscFloat(voice.freq)]);
    await this.engine.send(`/c${id}/out`, [oscFloat(voice.out)]);
  }
}

module.exports = {
  ProjectAudio,
  clamp01,
  mapFreq,
  mapAmp,
  resolveRegister,
  defaultOutChannel,
  validateOutChannel,
  SYNTH_NAME,
  GROUP_ID,
  NODE_BASE,
  FREQ_MIN,
  FREQ_MAX,
};
