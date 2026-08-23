// Protocol contract tests: join / claim / restore / control / set-out /
// seat persistence against a fake ProjectAudio, a real PlayerRegistry, a
// real SeatsStore (tmp file) and a fake Socket.IO — no process spawn, no
// UDP.
//
// The fake mirrors the real ProjectAudio contract: addVoice accepts the
// persisted state and births the voice with it (raw fader values, mapped
// amp = raw²), so any double-mapping or restore-after-birth in the
// protocol is detectable.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { PlayerRegistry } = require("../lib/players");
const { SeatsStore } = require("../lib/seats-store");
const { attachProtocol } = require("../lib/protocol");
const shared = require("../public/shared");

const { events: EVENTS } = shared;

function clamp01(value) {
  const number = Number(value);

  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

class FakeProjectAudio {
  constructor() {
    this.voices = new Map();
    this.addVoiceCalls = [];
    this.setControlsCalls = [];
    this.setOutChannelCalls = [];
    this.removeVoiceCalls = [];
    this.failAddVoice = false;
    this.failAddVoiceIds = new Set();
  }

  hasVoice(id) {
    return this.voices.has(id);
  }

  // Mirrors the real contract: a state present at birth is applied with
  // the voice, not restored onto it afterwards.
  async addVoice(id, state = null) {
    if (this.failAddVoice || this.failAddVoiceIds.has(id)) {
      throw new Error("synth creation failed");
    }

    const voice = {
      amp: 0,
      rawAmp: 0,
      rawFreq: 0,
      register: shared.defaultRegister,
      out: id % 2 === 1 ? 1 : 2,
    };

    if (state) {
      voice.rawAmp = clamp01(state.amp);
      voice.rawFreq = clamp01(state.freq);
      voice.register = [1, 2, 3].includes(Number(state.range))
        ? Number(state.range)
        : shared.defaultRegister;
      voice.amp = voice.rawAmp ** 2;
      voice.out = state.out;
    }

    this.voices.set(id, voice);
    this.addVoiceCalls.push({ id, state: state ?? null });
  }

  // Mirrors the real contract: the payload is applied field-by-field —
  // non-finite values are ignored, so a malformed message cannot zero a
  // fader — and the raw payload is recorded verbatim (the protocol
  // forwards it opaquely, so the recording is the opacity assertion).
  async setControls(id, payload) {
    const voice = this.voices.get(id);
    const fields = payload || {};

    if (Number.isFinite(Number(fields.amp))) {
      voice.rawAmp = clamp01(fields.amp);
    }

    if (Number.isFinite(Number(fields.freq))) {
      voice.rawFreq = clamp01(fields.freq);
    }

    if ([1, 2, 3].includes(Number(fields.range))) {
      voice.register = Number(fields.range);
    }

    voice.amp = voice.rawAmp ** 2;
    this.setControlsCalls.push({ id, payload: payload ?? null });
  }

  async setOutChannel(id, out) {
    this.voices.get(id).out = out;
    this.setOutChannelCalls.push({ id, out });
  }

  async restoreVoice(id, state) {
    // Mirrors the real contract: restore re-feeds the control fields,
    // then the channel.
    await this.setControls(id, {
      amp: state.amp,
      freq: state.freq,
      range: state.range,
    });
    await this.setOutChannel(id, state.out);
  }

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

  async removeVoice(id) {
    this.voices.delete(id);
    this.removeVoiceCalls.push(id);
  }

  snapshot() {
    return [...this.voices.entries()].map(([id, voice]) => ({
      id,
      amp: voice.amp,
      register: voice.register,
      out: voice.out,
    }));
  }
}

function createHarness({ maxClients = 3, seatsFile } = {}) {
  const registry = new PlayerRegistry({ maxClients });
  const audio = new FakeProjectAudio();
  const seats = new SeatsStore({
    file:
      seatsFile ||
      path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "pnds-protocol-")),
        "seats.json",
      ),
  });
  const broadcasts = [];
  const io = {
    sockets: { sockets: new Map() },
    on(event, handler) {
      assert.strictEqual(event, "connection");
      io.connection = handler;
    },
    emit(event, payload) {
      broadcasts.push({ event, payload });
    },
  };

  attachProtocol(io, { events: EVENTS, registry, projectAudio: audio, seats });

  let nextSocketId = 0;

  function connect() {
    nextSocketId += 1;

    const handlers = new Map();
    const sent = [];
    const socket = {
      id: `socket-${nextSocketId}`,
      disconnected: false,
      on(event, handler) {
        handlers.set(event, handler);
      },
      emit(event, payload) {
        sent.push({ event, payload });
      },
      disconnect() {
        socket.disconnected = true;
      },
    };

    io.connection(socket);
    io.sockets.sockets.set(socket.id, socket);

    return {
      socket,
      sent,
      emit(event, payload) {
        const handler = handlers.get(event);

        assert.ok(handler, `no handler registered for '${event}'`);

        return Promise.resolve(handler(payload));
      },
    };
  }

  return { registry, audio, seats, broadcasts, connect };
}

test("join creates a voice, answers joined and broadcasts state", async () => {
  const { audio, broadcasts, connect } = createHarness();
  const connection = connect();

  await connection.emit(EVENTS.join, { token: null });

  const joined = connection.sent.find((m) => m.event === EVENTS.joined);

  assert.ok(joined);
  assert.strictEqual(joined.payload.id, 1);
  assert.strictEqual(joined.payload.recovered, false);
  assert.match(joined.payload.token, /^[0-9a-f]{48}$/);
  assert.ok(audio.hasVoice(1));

  const state = broadcasts.find((m) => m.event === EVENTS.state);

  assert.ok(state);
  assert.strictEqual(state.payload.clients.length, 1);
});

test("join is rejected when the registry is full", async () => {
  const { audio, connect } = createHarness({ maxClients: 1 });
  const first = connect();

  await first.emit(EVENTS.join, { token: null });

  const second = connect();

  await second.emit(EVENTS.join, { token: null });

  const rejected = second.sent.find((m) => m.event === EVENTS.rejected);

  assert.ok(rejected);
  assert.match(rejected.payload.reason, /full/i);
  assert.strictEqual(second.socket.disconnected, true);
  assert.strictEqual(audio.voices.size, 1);
});

test("a failed voice creation releases the id and rejects the client", async () => {
  const { audio, registry, connect } = createHarness({ maxClients: 2 });

  audio.failAddVoice = true;

  const connection = connect();

  await connection.emit(EVENTS.join, { token: null });

  const rejected = connection.sent.find((m) => m.event === EVENTS.rejected);

  assert.ok(rejected);
  assert.strictEqual(connection.socket.disconnected, true);
  assert.strictEqual(registry.size, 0);

  audio.failAddVoice = false;

  const retry = connect();

  await retry.emit(EVENTS.join, { token: null });

  const joined = retry.sent.find((m) => m.event === EVENTS.joined);

  assert.strictEqual(joined.payload.id, 1);
});

test("control forwards the raw payload to setControls", async () => {
  const { audio, broadcasts, connect } = createHarness();
  const connection = connect();

  await connection.emit(EVENTS.join, { token: null });

  const broadcastsBefore = broadcasts.length;
  const control = { amp: 0.5, freq: 0.25, range: 1 };

  await connection.emit(EVENTS.control, control);

  // Verbatim, same object: the protocol holds no shape knowledge of the
  // payload (no synthesized keys, no re-wrapping).
  assert.strictEqual(audio.setControlsCalls.at(-1).payload, control);
  assert.strictEqual(broadcasts.length, broadcastsBefore + 1);
});

test("malformed control payloads pass through without touching the protocol", async () => {
  const { audio, connect } = createHarness();
  const connection = connect();

  await connection.emit(EVENTS.join, { token: null });

  const partial = { amp: 0.9 };

  await connection.emit(EVENTS.control, partial);
  await connection.emit(EVENTS.control, null);

  assert.strictEqual(audio.setControlsCalls[0].payload, partial);
  assert.strictEqual(audio.setControlsCalls[1].payload, null);
});

test("control from an unregistered socket is ignored", async () => {
  const { audio, connect } = createHarness();
  const connection = connect();

  await connection.emit(EVENTS.control, { amp: 0.5, freq: 0.5 });

  assert.deepStrictEqual(audio.setControlsCalls, []);
  assert.strictEqual(audio.voices.size, 0);
});

test("set-out from an operator socket (explicit id) reassigns that client", async () => {
  // The monitor page never joins — it names the target client instead.
  const { audio, connect } = createHarness();
  const performer = connect();

  await performer.emit(EVENTS.join, { token: null });

  const operator = connect();

  await operator.emit(EVENTS.setOut, { id: 1, out: 4 });

  assert.deepStrictEqual(audio.setOutChannelCalls, [{ id: 1, out: 4 }]);
});

test("set-out followed by a reconnect restores raw values with register", async () => {
  // Regression: the set-out path once persisted already-mapped values and
  // dropped the register — restoring that state double-mapped amp and
  // reset the register to the default.
  const { audio, connect } = createHarness();
  const first = connect();

  await first.emit(EVENTS.join, { token: null });

  const { token } = first.sent.find((m) => m.event === EVENTS.joined).payload;

  await first.emit(EVENTS.control, { amp: 0.5, freq: 0.5, range: 2 });
  await first.emit(EVENTS.setOut, { out: 3 });
  await first.emit("disconnect");

  const second = connect();

  await second.emit(EVENTS.join, { token });

  const joined = second.sent.find((m) => m.event === EVENTS.joined);

  assert.strictEqual(joined.payload.recovered, true);
  assert.strictEqual(joined.payload.id, 1);

  // The reconnect must birth the voice with the persisted raw state —
  // not create a default voice and mutate it afterwards (audible
  // intermediate state on the default channel).
  assert.deepStrictEqual(audio.addVoiceCalls.at(-1), {
    id: 1,
    state: { amp: 0.5, freq: 0.5, range: 2, out: 3 },
  });
  assert.deepStrictEqual(audio.setControlsCalls.length, 1); // only the live control
  assert.deepStrictEqual(audio.setOutChannelCalls.length, 1); // only the live set-out

  // And the restored voice reports the same raw state back.
  assert.deepStrictEqual(audio.voiceState(1), {
    amp: 0.5,
    freq: 0.5,
    range: 2,
    out: 3,
  });
});

test("an operator set-out persists under the target client's token", async () => {
  // Regression: persist once resolved the token from the *sender's*
  // socket — the operator never joins, so the lookup returned null and
  // the operator's channel change was never persisted.
  const { audio, connect } = createHarness();
  const performer = connect();

  await performer.emit(EVENTS.join, { token: null });

  const { token } = performer.sent.find((m) => m.event === EVENTS.joined)
    .payload;

  const operator = connect();

  await operator.emit(EVENTS.setOut, { id: 1, out: 4 });
  await performer.emit("disconnect");
  await new Promise((resolve) => setImmediate(resolve));

  const reconnected = connect();

  await reconnected.emit(EVENTS.join, { token });

  assert.deepStrictEqual(audio.addVoiceCalls.at(-1).state, {
    amp: 0,
    freq: 0,
    range: shared.defaultRegister,
    out: 4,
  });
});

test("an operator set-out survives a takeover reconnect (no rollback)", async () => {
  // The exact failure the sender-keyed persist caused: a takeover that
  // races the old socket's disconnect restores the still-alive voice
  // from state that carried the pre-operator channel — audibly rolling
  // the operator's change back.
  const { audio, connect } = createHarness();
  const first = connect();

  await first.emit(EVENTS.join, { token: null });

  const { token } = first.sent.find((m) => m.event === EVENTS.joined)
    .payload;

  await first.emit(EVENTS.control, { amp: 0.5, freq: 0.5, range: 2 });

  const operator = connect();

  await operator.emit(EVENTS.setOut, { id: 1, out: 4 });

  // Takeover: the same token joins from a new socket while the voice is
  // still alive.
  const second = connect();

  await second.emit(EVENTS.join, { token });

  assert.strictEqual(audio.addVoiceCalls.length, 1); // restored in place
  assert.deepStrictEqual(audio.setOutChannelCalls.at(-1), {
    id: 1,
    out: 4,
  });
});

test("a recovered join with the voice still alive re-feeds it via restoreVoice", async () => {
  // A takeover reconnect can arrive before the old socket's disconnect
  // handler freed the voice — then the voice is restored in place.
  const { audio, connect } = createHarness();
  const connection = connect();

  await connection.emit(EVENTS.join, { token: null });

  const { token } = connection.sent.find((m) => m.event === EVENTS.joined)
    .payload;

  await connection.emit(EVENTS.control, { amp: 0.7, freq: 0.2, range: 1 });

  const setControlsBefore = audio.setControlsCalls.length;

  await connection.emit(EVENTS.join, { token }); // duplicate join, voice alive

  assert.strictEqual(audio.addVoiceCalls.length, 1);
  assert.strictEqual(audio.setControlsCalls.length, setControlsBefore + 1);
  assert.deepStrictEqual(audio.setControlsCalls.at(-1), {
    id: 1,
    payload: { amp: 0.7, freq: 0.2, range: 1 },
  });
});

test("disconnect persists state and frees the voice", async () => {
  const { audio, connect } = createHarness();
  const connection = connect();

  await connection.emit(EVENTS.join, { token: null });
  await connection.emit(EVENTS.control, { amp: 0.8, freq: 0.6 });
  await connection.emit("disconnect");

  // The disconnect handler frees the voice on a promise chain.
  await new Promise((resolve) => setImmediate(resolve));

  assert.strictEqual(audio.voices.size, 0);
});

test("a join with an unknown token starts from defaults", async () => {
  const { audio, connect } = createHarness();
  const connection = connect();

  await connection.emit(EVENTS.join, {
    token: `unknown-${"a".repeat(24)}`,
  });

  const joined = connection.sent.find((m) => m.event === EVENTS.joined);

  assert.strictEqual(joined.payload.recovered, false);
  assert.deepStrictEqual(audio.setControlsCalls, []);
  assert.deepStrictEqual(audio.addVoiceCalls.at(-1).state, null);
});

test("a restarted server hands a device back its seat and channel", async () => {
  // Restart simulation: run A records the seat to a real file; run B is
  // a fresh registry + protocol + in-memory state over the SAME file.
  const seatsFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "pnds-restart-")),
    "seats.json",
  );
  const runA = createHarness({ seatsFile });
  const a = runA.connect();

  await a.emit(EVENTS.join, { token: null });

  const { token } = a.sent.find((m) => m.event === EVENTS.joined).payload;

  await a.emit(EVENTS.setOut, { out: 4 });

  const runB = createHarness({ seatsFile });
  const b = runB.connect();

  await b.emit(EVENTS.join, { token });

  const joined = b.sent.find((m) => m.event === EVENTS.joined).payload;

  assert.strictEqual(joined.id, 1);
  assert.strictEqual(joined.recovered, false); // fader state is in-memory

  // Birthed with the recorded channel alone — freq/amp start from zero
  // after a restart, by design.
  assert.deepStrictEqual(runB.audio.addVoiceCalls.at(-1).state, { out: 4 });
  assert.strictEqual(runB.audio.voiceState(1).out, 4);
});

test("a recorded seat is not handed to a different device", async () => {
  const { connect } = createHarness({ maxClients: 3 });
  const device = connect();

  await device.emit(EVENTS.join, { token: null });

  const { token } = device.sent.find((m) => m.event === EVENTS.joined)
    .payload;

  // The device leaves: the id frees, the seat record stays.
  await device.emit("disconnect");
  await new Promise((resolve) => setImmediate(resolve));

  const newcomer = connect();

  await newcomer.emit(EVENTS.join, { token: null });

  assert.strictEqual(
    newcomer.sent.find((m) => m.event === EVENTS.joined).payload.id,
    2,
  );

  // The original device returns later and still gets its seat.
  const back = connect();

  await back.emit(EVENTS.join, { token });

  assert.strictEqual(
    back.sent.find((m) => m.event === EVENTS.joined).payload.id,
    1,
  );
});

test("an operator seat move reassigns the voice, the record and the page", async () => {
  const { audio, seats, broadcasts, connect } = createHarness({
    maxClients: 3,
  });
  const performer = connect();

  await performer.emit(EVENTS.join, { token: null });

  const { token } = performer.sent.find((m) => m.event === EVENTS.joined)
    .payload;

  await performer.emit(EVENTS.control, { amp: 0.5, freq: 0.5, range: 2 });
  await performer.emit(EVENTS.setOut, { out: 3 });

  const operator = connect();

  await operator.emit(EVENTS.setSeat, { id: 1, to: 3 });

  // The voice moved with its state, born restored (single addVoice, no
  // restore mutations afterwards).
  assert.deepStrictEqual(audio.addVoiceCalls.at(-1), {
    id: 3,
    state: { amp: 0.5, freq: 0.5, range: 2, out: 3 },
  });
  assert.deepStrictEqual(audio.removeVoiceCalls.at(-1), 1);
  assert.strictEqual(audio.hasVoice(1), false);
  assert.strictEqual(audio.voiceState(3).out, 3);

  // The seat record followed the device.
  assert.deepEqual(seats.get(token), { id: 3, out: 3 });

  // The page learns the new id through the same joined event a join
  // produces — zero page changes.
  const rejoined = performer.sent
    .filter((m) => m.event === EVENTS.joined)
    .at(-1);

  assert.strictEqual(rejoined.payload.id, 3);
  assert.strictEqual(rejoined.payload.token, token);

  // And the broadcast lists the device under the new seat.
  const state = broadcasts
    .filter((m) => m.event === EVENTS.state)
    .at(-1);

  assert.strictEqual(state.payload.clients[0].id, 3);
});

test("a seat move to a live target is a no-op", async () => {
  const { audio, registry, connect } = createHarness({ maxClients: 3 });
  const first = connect();
  const second = connect();

  await first.emit(EVENTS.join, { token: null });
  await second.emit(EVENTS.join, { token: null });

  const operator = connect();

  await operator.emit(EVENTS.setSeat, { id: 1, to: 2 });

  assert.strictEqual(audio.hasVoice(1), true); // nothing moved
  assert.strictEqual(audio.hasVoice(2), true);
  assert.deepStrictEqual(audio.removeVoiceCalls, []);
  assert.strictEqual(registry.getTokenById(1) !== null, true);
});

test("a failed seat move rolls back to the old seat", async () => {
  // The engine can fail the re-birth (a dead scsynth): the assignment
  // returns to the old id and the voice is re-birthed there, so the
  // device is not left silent under an id nobody maps to.
  const { audio, registry, connect } = createHarness({ maxClients: 3 });
  const performer = connect();

  await performer.emit(EVENTS.join, { token: null });
  await performer.emit(EVENTS.control, { amp: 0.5, freq: 0.5, range: 2 });

  const { token } = performer.sent.find((m) => m.event === EVENTS.joined)
    .payload;

  const operator = connect();

  audio.failAddVoiceIds.add(3); // the re-birth at the target fails

  await operator.emit(EVENTS.setSeat, { id: 1, to: 3 });

  assert.strictEqual(registry.getTokenById(1), token); // assignment back
  assert.strictEqual(audio.hasVoice(1), true); // voice re-birthed in place
  assert.strictEqual(audio.hasVoice(3), false);

  const reborn = audio.addVoiceCalls.at(-1);

  assert.strictEqual(reborn.id, 1);
  assert.strictEqual(reborn.state.amp, 0.5); // state carried through
});

test("reset-ids clears seats, frees voices and bounces performers", async () => {  const { audio, registry, seats, broadcasts, connect } = createHarness({
    maxClients: 3,
  });
  const first = connect();

  await first.emit(EVENTS.join, { token: null });

  const { token } = first.sent.find((m) => m.event === EVENTS.joined)
    .payload;

  const second = connect();

  await second.emit(EVENTS.join, { token: null });

  const operator = connect();

  await operator.emit(EVENTS.resetIds);

  assert.strictEqual(registry.size, 0);
  assert.strictEqual(audio.voices.size, 0);
  assert.strictEqual(first.socket.disconnected, true);
  assert.strictEqual(second.socket.disconnected, true);
  assert.strictEqual(seats.get(token), undefined);

  // A device reconnecting after the bounce has no seat anymore — it gets
  // a fresh id in rejoin order.
  const rejoined = connect();

  await rejoined.emit(EVENTS.join, { token });

  assert.strictEqual(
    rejoined.sent.find((m) => m.event === EVENTS.joined).payload.id,
    1,
  );

  assert.ok(
    broadcasts.some(
      (m) => m.event === EVENTS.state && m.payload.clients.length === 0,
    ),
  );
});
