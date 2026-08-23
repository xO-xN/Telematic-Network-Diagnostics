const assert = require("node:assert/strict");
const test = require("node:test");

const { PlayerRegistry } = require("../lib/players");

test("allocates sequential ids starting at 1", () => {
  const registry = new PlayerRegistry({ maxClients: 3 });

  const first = registry.allocate({ socketId: "a", claimToken: null });

  assert.equal(first.status, "accepted");
  assert.equal(first.id, 1);
  assert.equal(first.token.length, 48);

  const second = registry.allocate({ socketId: "b", claimToken: null });

  assert.equal(second.id, 2);
});

test("reuses the smallest free id after a release", () => {
  const registry = new PlayerRegistry({ maxClients: 3 });

  registry.allocate({ socketId: "a", claimToken: null });
  registry.allocate({ socketId: "b", claimToken: null });
  registry.allocate({ socketId: "c", claimToken: null });
  registry.release(2);

  const next = registry.allocate({ socketId: "d", claimToken: null });

  assert.equal(next.id, 2);
});

test("recovers the same id with a claim token (reconnect)", () => {
  const registry = new PlayerRegistry({ maxClients: 3 });

  const first = registry.allocate({ socketId: "a", claimToken: null });
  const recovered = registry.allocate({
    socketId: "b",
    claimToken: first.token,
  });

  assert.deepEqual(recovered, {
    status: "recovered",
    id: 1,
    token: first.token,
  });
});

test("rejects new clients when full", () => {
  const registry = new PlayerRegistry({ maxClients: 2 });

  registry.allocate({ socketId: "a", claimToken: null });
  registry.allocate({ socketId: "b", claimToken: null });

  const rejected = registry.allocate({ socketId: "c", claimToken: null });

  assert.equal(rejected.status, "rejected");
  assert.match(rejected.message, /max 2/);
});

test("releaseBySocket returns the assignment and frees it", () => {
  const registry = new PlayerRegistry({ maxClients: 2 });

  const first = registry.allocate({ socketId: "a", claimToken: null });

  assert.deepEqual(registry.releaseBySocket("a"), {
    id: 1,
    claimToken: first.token,
  });
  assert.equal(registry.releaseBySocket("a"), null);
});

test("getTokenById returns the owning token, null for free ids", () => {
  // The lookup the protocol needs to persist a voice's state under its
  // owner — regardless of which socket (e.g. the operator's) triggered the
  // mutation.
  const registry = new PlayerRegistry({ maxClients: 2 });
  const first = registry.allocate({ socketId: "a", claimToken: null });

  assert.equal(registry.getTokenById(1), first.token);
  assert.equal(registry.getTokenById(2), null);

  registry.releaseBySocket("a");

  assert.equal(registry.getTokenById(1), null);
});

test("preferredId reclaims a recorded seat when it is free", () => {
  // The restart-restore path: nothing live, the token's seat record says
  // id 3, so the rejoining device gets id 3 back regardless of what
  // nextFreeId would pick.
  const registry = new PlayerRegistry({ maxClients: 4 });

  const result = registry.allocate({
    socketId: "a",
    claimToken: "token-aaaaaaaaaaaaaaaaaaaaaaaa",
    preferredId: 3,
  });

  assert.equal(result.status, "accepted");
  assert.equal(result.id, 3);
  assert.equal(result.token, "token-aaaaaaaaaaaaaaaaaaaaaaaa");
});

test("a live preferredId falls back to the next free id", () => {
  // Can only happen with a hand-edited seat file, but must not hand the
  // same id to two devices.
  const registry = new PlayerRegistry({ maxClients: 4 });

  registry.allocate({ socketId: "a", claimToken: null }); // id 1

  const result = registry.allocate({
    socketId: "b",
    claimToken: "token-aaaaaaaaaaaaaaaaaaaaaaaa",
    preferredId: 1, // live under another device
  });

  assert.equal(result.status, "accepted");
  assert.equal(result.id, 2);
});

test("nextFreeId skips reserved seats", () => {
  // A seat recorded for an absent device is not given to a newcomer.
  const registry = new PlayerRegistry({ maxClients: 3 });

  const newcomer = registry.allocate({
    socketId: "a",
    claimToken: null,
    reservedIds: new Set([1]),
  });

  assert.equal(newcomer.id, 2);
});

test("rejects when every id is live or reserved", () => {
  const registry = new PlayerRegistry({ maxClients: 2 });

  registry.allocate({ socketId: "a", claimToken: null }); // id 1

  const rejected = registry.allocate({
    socketId: "b",
    claimToken: null,
    reservedIds: new Set([2]), // the only other id is a recorded seat
  });

  assert.equal(rejected.status, "rejected");
  assert.match(rejected.message, /max 2/);
});

test("reassign moves a live assignment to a free id", () => {
  const registry = new PlayerRegistry({ maxClients: 3 });
  const first = registry.allocate({ socketId: "a", claimToken: null });

  assert.equal(registry.reassign(1, 3), true);
  assert.equal(registry.getTokenById(1), null);
  assert.equal(registry.getTokenById(3), first.token); // token followed
});

test("reassign refuses unknown ids, live targets and out-of-range", () => {
  const registry = new PlayerRegistry({ maxClients: 3 });

  registry.allocate({ socketId: "a", claimToken: null }); // id 1
  registry.allocate({ socketId: "b", claimToken: null }); // id 2

  assert.equal(registry.reassign(9, 3), false); // unknown id
  assert.equal(registry.reassign(1, 2), false); // target live
  assert.equal(registry.reassign(1, 1), false); // target is self
  assert.equal(registry.reassign(1, 4), false); // out of range
  assert.equal(registry.getTokenById(1) !== null, true); // nothing moved
});
