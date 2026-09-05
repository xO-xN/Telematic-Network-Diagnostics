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

// ------------------------------------------------------------
// Voluntary exit (issue #10): release() is the deletion primitive —
// the id AND the claim-token mapping go, so the freed client's token
// rejoins as a brand-new client and the slot counts towards the cap
// only while it is live.
// ------------------------------------------------------------

test("release frees the token mapping: the same token rejoins as a NEW client, not a recovery", () => {
  const registry = new PlayerRegistry({ maxClients: 4 });

  const first = registry.allocate({ socketId: "a", claimToken: null });

  registry.release(1);

  const again = registry.allocate({ socketId: "b", claimToken: first.token });

  assert.equal(again.status, "accepted", "the token is unknown again — not a recovery");
  assert.equal(again.token, first.token, "the token rebinds to the new client");
  assert.notEqual(again.id, undefined);
});

test("release frees the token mapping: a numeric NEW id when the old slot is refilled", () => {
  const registry = new PlayerRegistry({ maxClients: 4 });

  const p1 = registry.allocate({ socketId: "a", claimToken: null });
  const p2 = registry.allocate({ socketId: "b", claimToken: null });

  registry.release(p2.id);
  // A third client takes the freed (smallest) slot…
  registry.allocate({ socketId: "c", claimToken: null });

  // …so the leaver's own token comes back on a DIFFERENT id.
  const rejoined = registry.allocate({ socketId: "d", claimToken: p2.token });

  assert.equal(rejoined.status, "accepted");
  assert.equal(rejoined.id, 3, "a different id than the one it left as (2)");
});

test("release frees the slot: the cap counts live clients only", () => {
  const registry = new PlayerRegistry({ maxClients: 1 });

  const first = registry.allocate({ socketId: "a", claimToken: null });

  assert.equal(registry.allocate({ socketId: "b", claimToken: null }).status, "rejected");

  registry.release(first.id);

  const next = registry.allocate({ socketId: "c", claimToken: null });

  assert.equal(next.status, "accepted");
  assert.equal(next.id, 1);
});
