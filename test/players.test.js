// Unit tests for lib/players.js (issue #5) — the performer identity
// registry, ported from the sibling repo Local-Network-Diagnostics.

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
