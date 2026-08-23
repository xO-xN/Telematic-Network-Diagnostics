// Client module contract tests against a fake socket.io factory and a
// fake storage — no browser, no server. The fakes mirror just the
// socket surface the module uses (on/emit), so the join / rejoin /
// deadband flows are exercised through the same code the pages run.

const { test } = require("node:test");
const assert = require("node:assert");

const {
  connectPerformer,
  connectMonitor,
  socketOrigin,
} = require("../public/client");

const EVENTS = {
  join: "join",
  joined: "joined",
  rejected: "rejected",
  control: "control",
  setOut: "set-out",
  setSeat: "set-seat",
  state: "state",
  resetIds: "reset-ids",
};

const TOKEN_KEY = "pnds-test-token";

class FakeSocket {
  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.connected = false;
    this.handlers = new Map();
    this.sent = [];
  }

  on(event, handler) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }

    this.handlers.get(event).push(handler);
  }

  emit(event, payload) {
    this.sent.push({ event, payload });
  }

  close() {
    this.closed = true;
  }

  // Test-side: the "server" delivers an event to this socket.
  receive(event, payload) {
    for (const handler of this.handlers.get(event) || []) {
      handler(payload);
    }
  }

  sentFor(event) {
    return this.sent.filter((message) => message.event === event);
  }
}

function createFakeIo() {
  const sockets = [];

  return {
    sockets,
    io(url, options) {
      const socket = new FakeSocket(url, options);
      sockets.push(socket);
      return socket;
    },
  };
}

function createStorage(entries = new Map()) {
  return {
    getItem(key) {
      return entries.has(key) ? entries.get(key) : null;
    },
    setItem(key, value) {
      entries.set(key, value);
    },
    entries,
  };
}

function connectPerformerHarness({ token = null } = {}) {
  const { io, sockets } = createFakeIo();
  const storage = createStorage();

  if (token !== null) {
    storage.setItem(TOKEN_KEY, token);
  }

  const performer = connectPerformer({
    io,
    port: 6868,
    events: EVENTS,
    tokenKey: TOKEN_KEY,
    storage,
    hostname: "192.168.1.9",
  });

  return { performer, socket: sockets[0], storage };
}

test("socketOrigin builds the performer-server origin", () => {
  assert.strictEqual(
    socketOrigin({ hostname: "192.168.1.9", port: 6868 }),
    "http://192.168.1.9:6868",
  );
});

test("connectPerformer connects to the performer port with reconnection", () => {
  const { performer, socket } = connectPerformerHarness();

  assert.strictEqual(socket.url, "http://192.168.1.9:6868");
  assert.strictEqual(socket.options.reconnection, true);
  assert.strictEqual(socket.options.reconnectionDelay, 1000);

  socket.connected = true;

  assert.strictEqual(performer.connected, true);

  performer.close();

  assert.strictEqual(socket.closed, true);
});

test("connectPerformer requires an injected storage", () => {
  const { io } = createFakeIo();

  assert.throws(
    () =>
      connectPerformer({
        io,
        port: 6868,
        events: EVENTS,
        tokenKey: TOKEN_KEY,
        hostname: "localhost",
      }),
    /storage/,
  );
});

test("first connect joins with a null token; joined stores the token", () => {
  const { performer, socket, storage } = connectPerformerHarness();

  socket.receive("connect");

  assert.deepStrictEqual(socket.sentFor(EVENTS.join), [
    { event: EVENTS.join, payload: { token: null } },
  ]);

  socket.receive(EVENTS.joined, { id: 3, token: "a".repeat(48), recovered: false });

  assert.strictEqual(performer.joined, true);
  assert.strictEqual(performer.myId, 3);
  assert.strictEqual(performer.myOut, null); // arrives with a state broadcast
  assert.strictEqual(performer.rejectedReason, null);
  assert.strictEqual(storage.entries.get(TOKEN_KEY), "a".repeat(48));
});

test("a reconnect rejoins with the persisted token", () => {
  const token = "b".repeat(48);
  const { performer, socket } = connectPerformerHarness({ token });

  socket.receive("connect");
  socket.receive(EVENTS.joined, { id: 1, token, recovered: false });
  socket.receive("disconnect");
  socket.receive("connect"); // phone unlocked, transport back

  const joins = socket.sentFor(EVENTS.join);

  assert.strictEqual(joins.length, 2);
  assert.deepStrictEqual(joins[1].payload, { token });
  assert.strictEqual(performer.joined, false); // until the server confirms
});

test("rejected surfaces the reason and clears identity", () => {
  const { performer, socket } = connectPerformerHarness();

  socket.receive("connect");
  socket.receive(EVENTS.joined, { id: 2, token: "c".repeat(48), recovered: false });
  socket.receive(EVENTS.rejected, { reason: "Server is full (max 3 clients)." });

  assert.strictEqual(performer.joined, false);
  assert.strictEqual(performer.myId, null);
  assert.strictEqual(
    performer.rejectedReason,
    "Server is full (max 3 clients).",
  );
});

test("state broadcasts track my output channel", () => {
  const { performer, socket } = connectPerformerHarness();

  socket.receive("connect");
  socket.receive(EVENTS.joined, { id: 2, token: "d".repeat(48), recovered: false });

  // State before joining would be ignored (no myId yet) — now it has one.
  socket.receive(EVENTS.state, {
    clients: [
      { id: 1, out: 4 },
      { id: 2, out: 6 },
    ],
  });

  assert.strictEqual(performer.myOut, 6);

  // The voice dropping out of the broadcast clears the channel.
  socket.receive(EVENTS.state, { clients: [{ id: 1, out: 4 }] });

  assert.strictEqual(performer.myOut, null);
});

test("sendControls deadband: below threshold is not sent, above is", () => {
  const { performer, socket } = connectPerformerHarness();

  socket.receive("connect");
  socket.receive(EVENTS.joined, { id: 1, token: "e".repeat(48), recovered: false });

  const first = performer.sendControls({ amp: 0.5, freq: 0.5, range: 3 });

  assert.strictEqual(first, true);

  // 0.0001 < 0.002 threshold: swallowed by the deadband.
  const jitter = performer.sendControls({ amp: 0.5001, freq: 0.5, range: 3 });

  assert.strictEqual(jitter, false);

  // A non-numeric field (the register) compares strictly: change sends.
  const registerSwitch = performer.sendControls({
    amp: 0.5001,
    freq: 0.5,
    range: 1,
  });

  assert.strictEqual(registerSwitch, true);

  const controls = socket.sentFor(EVENTS.control);

  assert.strictEqual(controls.length, 2);
  assert.deepStrictEqual(controls[0].payload, { amp: 0.5, freq: 0.5, range: 3 });
  assert.deepStrictEqual(controls[1].payload, {
    amp: 0.5001,
    freq: 0.5,
    range: 1,
  });
});

test("sendControls is a no-op while not joined", () => {
  const { performer, socket } = connectPerformerHarness();

  assert.strictEqual(performer.sendControls({ amp: 0.5 }), false);
  assert.deepStrictEqual(socket.sentFor(EVENTS.control), []);
});

test("connectMonitor sees the client list and reassigns channels", () => {
  const { io, sockets } = createFakeIo();
  const seen = [];

  const monitor = connectMonitor({
    io,
    port: 6868,
    events: EVENTS,
    hostname: "192.168.1.9",
  });

  monitor.onClients((clients) => seen.push(clients));

  const socket = sockets[0];

  socket.receive(EVENTS.state, { clients: [{ id: 1, out: 2 }] });

  assert.deepStrictEqual(monitor.clients, [{ id: 1, out: 2 }]);
  assert.strictEqual(seen.length, 1);

  monitor.setOut(1, 5);

  assert.deepStrictEqual(socket.sentFor(EVENTS.setOut), [
    { event: EVENTS.setOut, payload: { id: 1, out: 5 } },
  ]);

  // A malformed broadcast yields an empty list, not a crash.
  socket.receive(EVENTS.state, null);

  assert.deepStrictEqual(monitor.clients, []);
  assert.strictEqual(seen.length, 2);
});

test("connectMonitor resetIds emits the reset event", () => {
  const { io, sockets } = createFakeIo();

  const monitor = connectMonitor({
    io,
    port: 6868,
    events: EVENTS,
    hostname: "192.168.1.9",
  });

  monitor.resetIds();

  assert.deepStrictEqual(sockets[0].sentFor(EVENTS.resetIds), [
    { event: EVENTS.resetIds, payload: undefined },
  ]);
});

test("connectMonitor setSeat emits the seat move", () => {
  const { io, sockets } = createFakeIo();

  const monitor = connectMonitor({
    io,
    port: 6868,
    events: EVENTS,
    hostname: "192.168.1.9",
  });

  monitor.setSeat(3, 5);

  assert.deepStrictEqual(sockets[0].sentFor(EVENTS.setSeat), [
    { event: EVENTS.setSeat, payload: { id: 3, to: 5 } },
  ]);
});
