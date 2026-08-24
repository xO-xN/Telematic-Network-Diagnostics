// Hub integration tests (issue #2 acceptance criteria): a real hub
// subprocess spawned from source, exercised over the wire with
// socket.io-client playing two fake site nodes. Only external behavior
// is asserted — auth, rooms, relay, timestamps — never the hub's
// internals.

const assert = require("node:assert/strict");
const test = require("node:test");

const { io } = require("socket.io-client");
const {
  sanitizeName,
  tokenMatches,
  DEFAULT_ROOM,
} = require("../hub/hub");
const { findFreePort, waitForPort, spawnHub, stopProcess } = require("./helpers");

const HUB_TOKEN = "test-hub-token-0123456789abcdef";

// Connects one fake site node; resolves { socket, welcome }. No token
// default on purpose — an omitted token must reach the hub as omitted
// (a default would silently test the valid token instead).
function connectNode(url, { token, room, node } = {}) {
  return new Promise((resolve, reject) => {
    const socket = io(url, {
      reconnection: false,
      timeout: 5000,
      auth: { token, room, node },
    });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("connect timeout"));
    }, 5000);

    socket.on("welcome", (welcome) => {
      clearTimeout(timer);
      resolve({ socket, welcome });
    });

    socket.on("connect_error", (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
  });
}

// Resolves with the next "relay" the socket receives — or null after
// the timeout, for the isolation assertions.
function nextRelay(socket, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off("relay", onRelay);
      resolve(null);
    }, timeoutMs);

    const onRelay = (payload) => {
      clearTimeout(timer);
      socket.off("relay", onRelay);
      resolve(payload);
    };

    socket.on("relay", onRelay);
  });
}

// Resolves with the next `event` payload the socket receives — or null
// after the timeout (isolation / silence assertions).
function nextEvent(socket, event, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      resolve(null);
    }, timeoutMs);

    const onEvent = (payload) => {
      clearTimeout(timer);
      socket.off(event, onEvent);
      resolve(payload);
    };

    socket.on(event, onEvent);
  });
}

// ------------------------------------------------------------
// Unit: handshake helpers
// ------------------------------------------------------------

test("sanitizeName: trim, cap, blank and non-string fall back", () => {
  assert.equal(sanitizeName("  alpha  ", 128), "alpha");
  assert.equal(sanitizeName("x".repeat(200), 128).length, 128);
  assert.equal(sanitizeName("", 128), null);
  assert.equal(sanitizeName("   ", 128), null);
  assert.equal(sanitizeName(undefined, 128), null);
  assert.equal(sanitizeName(42, 128), null);
});

test("tokenMatches: equal secrets match, everything else does not", () => {
  assert.equal(tokenMatches("secret", "secret"), true);
  assert.equal(tokenMatches("secret", "other"), false);
  assert.equal(tokenMatches(undefined, "secret"), false);
  assert.equal(tokenMatches("secret", ""), false);
});

// ------------------------------------------------------------
// Integration: the issue #2 acceptance criteria
// ------------------------------------------------------------

test("hub: wrong token is refused, right token is welcomed", async (t) => {
  const port = await findFreePort();
  const hub = spawnHub(port, { token: HUB_TOKEN });
  t.after(() => stopProcess(hub));

  await waitForPort(port);

  const url = `http://127.0.0.1:${port}`;

  await assert.rejects(
    connectNode(url, { token: `${HUB_TOKEN}-wrong` }),
    (error) => {
      assert.match(error.message, /invalid hub token/);
      return true;
    },
    "a wrong token must be refused with the contract message",
  );

  // A missing token is just another wrong token.
  await assert.rejects(
    connectNode(url, { token: undefined }),
    (error) => {
      assert.match(error.message, /invalid hub token/);
      return true;
    },
  );

  const { socket, welcome } = await connectNode(url, { token: HUB_TOKEN, node: "site-a" });
  t.after(() => socket.close());

  assert.equal(welcome.room, DEFAULT_ROOM);
  assert.equal(welcome.node, "site-a");
  assert.equal(
    typeof welcome.hubTime,
    "number",
    "welcome carries the hub clock",
  );
});

test("hub: relay reaches the same room (stamped), not the sender", async (t) => {
  const port = await findFreePort();
  const hub = spawnHub(port, { token: HUB_TOKEN });
  t.after(() => stopProcess(hub));

  await waitForPort(port);

  const url = `http://127.0.0.1:${port}`;
  const a = await connectNode(url, { token: HUB_TOKEN, room: "alpha", node: "site-a" });
  const b = await connectNode(url, { token: HUB_TOKEN, room: "alpha", node: "site-b" });
  t.after(() => a.socket.close());
  t.after(() => b.socket.close());

  const bReceives = nextRelay(b.socket, 5000);
  const aEcho = nextRelay(a.socket, 500);

  const sentAt = Date.now();
  a.socket.emit("relay", { type: "stats", rttP50: 41 });

  const received = await bReceives;

  assert.ok(received, "the same-room node must receive the relay");

  assert.equal(received.type, "stats");
  assert.equal(received.rttP50, 41);
  assert.equal(received.from, "site-a");

  // The hub receive timestamp: an epoch-ms integer stamped between the
  // local clocks around the emit.
  assert.equal(
    typeof received.hubReceivedAt,
    "number",
    "relay carries the hub receive timestamp",
  );
  assert.ok(
    Number.isInteger(received.hubReceivedAt),
    "hubReceivedAt is an epoch-ms integer",
  );
  assert.ok(
    received.hubReceivedAt >= sentAt - 5 &&
      received.hubReceivedAt <= Date.now() + 5,
    "hubReceivedAt sits between the send and receive clocks",
  );

  // The sender never hears its own message back.
  const echo = await aEcho;
  assert.equal(echo, null, "relay must not loop back to the sender");
});

test("hub: rooms are isolated from each other", async (t) => {
  const port = await findFreePort();
  const hub = spawnHub(port, { token: HUB_TOKEN });
  t.after(() => stopProcess(hub));

  await waitForPort(port);

  const url = `http://127.0.0.1:${port}`;
  const a = await connectNode(url, { token: HUB_TOKEN, room: "alpha", node: "site-a" });
  const b = await connectNode(url, { token: HUB_TOKEN, room: "alpha", node: "site-b" });
  const c = await connectNode(url, { token: HUB_TOKEN, room: "beta", node: "site-c" });
  t.after(() => a.socket.close());
  t.after(() => b.socket.close());
  t.after(() => c.socket.close());

  assert.equal(a.welcome.room, "alpha");
  assert.equal(b.welcome.room, "alpha");
  assert.equal(c.welcome.room, "beta");

  const bReceives = nextRelay(b.socket, 5000);
  const cReceives = nextRelay(c.socket, 500);

  a.socket.emit("relay", { type: "stats" });

  assert.ok(await bReceives, "the same-room node receives the relay");

  const leaked = await cReceives;
  assert.equal(
    leaked,
    null,
    "a relay in room alpha must not reach room beta",
  );
});

test("hub: no room option lands everyone in the default room", async (t) => {
  const port = await findFreePort();
  const hub = spawnHub(port, { token: HUB_TOKEN });
  t.after(() => stopProcess(hub));

  await waitForPort(port);

  const url = `http://127.0.0.1:${port}`;
  const a = await connectNode(url, { token: HUB_TOKEN, node: "site-a" });
  const b = await connectNode(url, { token: HUB_TOKEN, node: "site-b" });
  t.after(() => a.socket.close());
  t.after(() => b.socket.close());

  assert.equal(a.welcome.room, "default");
  assert.equal(b.welcome.room, "default");

  const bReceives = nextRelay(b.socket, 5000);

  a.socket.emit("relay", { hello: "world" });

  const received = await bReceives;

  assert.ok(received, "default-room nodes relay to each other");
  assert.equal(received.hello, "world");
  assert.equal(received.from, "site-a");
});

test("hub: echo returns the body to the sender, stamped, and to nobody else", async (t) => {
  const port = await findFreePort();
  const hub = spawnHub(port, { token: HUB_TOKEN });
  t.after(() => stopProcess(hub));

  await waitForPort(port);

  const url = `http://127.0.0.1:${port}`;
  const a = await connectNode(url, { token: HUB_TOKEN, room: "alpha", node: "site-a" });
  const b = await connectNode(url, { token: HUB_TOKEN, room: "alpha", node: "site-b" });
  t.after(() => a.socket.close());
  t.after(() => b.socket.close());

  // The sender's own echo comes back stamped (the hub-leg RTT seam).
  const echoed = nextEvent(a.socket, "echo", 5000);
  const sentAt = Date.now();

  a.socket.emit("echo", { seq: 7, sentAt });

  const body = await echoed;

  assert.ok(body, "the sender must receive its own echo");
  assert.equal(body.seq, 7);
  assert.equal(body.sentAt, sentAt);
  assert.equal(body.from, "site-a");
  assert.ok(
    Number.isInteger(body.hubReceivedAt) &&
      body.hubReceivedAt >= sentAt - 5 &&
      body.hubReceivedAt <= Date.now() + 5,
    "the echo carries the hub receive timestamp",
  );

  // An echo is a private round trip: the same-room node hears nothing
  // — not the echo, not a relay.
  assert.equal(await nextEvent(b.socket, "echo", 400), null);
  assert.equal(await nextRelay(b.socket, 400), null);
});

test("hub: no HUB_TOKEN set — refuse to start", async () => {
  const port = await findFreePort();
  const hub = spawnHub(port, {
    token: HUB_TOKEN,
    stdio: ["ignore", "pipe", "pipe"],
    extraEnv: { HUB_TOKEN: "" },
  });

  const { code, stderr } = await new Promise((resolve) => {
    let output = "";

    hub.stderr.on("data", (chunk) => {
      output += chunk;
    });
    hub.once("exit", (exitCode) => resolve({ code: exitCode, stderr: output }));
  });

  assert.equal(code, 1, "the hub must exit nonzero without HUB_TOKEN");
  assert.match(stderr, /HUB_TOKEN/);
});
