// SeatsStore contract tests: disk round-trip, reservation set, no-op
// guard, clear, and tolerance for missing/corrupt files.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SeatsStore } = require("../lib/seats-store");

function tmpFile() {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "pnds-seats-")),
    "seats.json",
  );
}

test("record persists to disk and a new store loads it back", () => {
  const file = tmpFile();
  const first = new SeatsStore({ file });

  first.record("token-aaaaaaaaaaaaaaaaaaaaaaaa", { id: 3, out: 5 });

  const second = new SeatsStore({ file });

  assert.deepEqual(second.get("token-aaaaaaaaaaaaaaaaaaaaaaaa"), {
    id: 3,
    out: 5,
  });
  assert.equal(second.get("unknown-token"), undefined);
});

test("get returns a copy — callers cannot mutate the store", () => {
  const store = new SeatsStore({ file: tmpFile() });

  store.record("token-aaaaaaaaaaaaaaaaaaaaaaaa", { id: 1, out: 2 });

  const seat = store.get("token-aaaaaaaaaaaaaaaaaaaaaaaa");
  seat.out = 9;

  assert.equal(
    store.get("token-aaaaaaaaaaaaaaaaaaaaaaaa").out,
    2,
  );
});

test("a no-op record does not rewrite the file", () => {
  const file = tmpFile();
  const store = new SeatsStore({ file });

  store.record("token-aaaaaaaaaaaaaaaaaaaaaaaa", { id: 1, out: 2 });

  const before = fs.readFileSync(file, "utf8");

  store.record("token-aaaaaaaaaaaaaaaaaaaaaaaa", { id: 1, out: 2 });

  assert.equal(fs.readFileSync(file, "utf8"), before);

  // A real change still saves.
  store.record("token-aaaaaaaaaaaaaaaaaaaaaaaa", { id: 1, out: 3 });

  assert.notEqual(fs.readFileSync(file, "utf8"), before);
});

test("reservedIds lists other devices' seats, excluding the caller's own", () => {
  const store = new SeatsStore({ file: tmpFile() });

  store.record("token-aaaaaaaaaaaaaaaaaaaaaaaa", { id: 1, out: 2 });
  store.record("token-bbbbbbbbbbbbbbbbbbbbbbbb", { id: 4, out: 2 });
  store.record("token-cccccccccccccccccccccccc", { id: 5, out: 1 });

  assert.deepEqual(
    [...store.reservedIds(1)].sort(),
    [4, 5],
  );
  assert.deepEqual(
    [...store.reservedIds(null)].sort(),
    [1, 4, 5],
  );
});

test("clear wipes the seats and the file", () => {
  const file = tmpFile();
  const store = new SeatsStore({ file });

  store.record("token-aaaaaaaaaaaaaaaaaaaaaaaa", { id: 1, out: 2 });
  store.clear();

  assert.equal(store.get("token-aaaaaaaaaaaaaaaaaaaaaaaa"), undefined);

  const reloaded = new SeatsStore({ file });

  assert.equal(reloaded.get("token-aaaaaaaaaaaaaaaaaaaaaaaa"), undefined);
});

test("one token per seat: recording a seat evicts the other token", () => {
  // An operator seat move lands on an id a stale record still claims;
  // the last command wins and the stale record is gone.
  const file = tmpFile();
  const store = new SeatsStore({ file });

  store.record("token-stale-aaaaaaaaaaaaaaaaaaaa", { id: 2, out: 1 });
  store.record("token-aaaaaaaaaaaaaaaaaaaaaaaa", { id: 5, out: 3 });
  store.record("token-aaaaaaaaaaaaaaaaaaaaaaaa", { id: 2, out: 3 }); // the move

  assert.equal(store.get("token-stale-aaaaaaaaaaaaaaaaaaaa"), undefined);
  assert.deepEqual(store.get("token-aaaaaaaaaaaaaaaaaaaaaaaa"), {
    id: 2,
    out: 3,
  });

  // The eviction survives a reload.
  assert.equal(
    new SeatsStore({ file }).get("token-stale-aaaaaaaaaaaaaaaaaaaa"),
    undefined,
  );
});

test("a missing file starts empty; a corrupt file is ignored, not fatal", () => {
  const missing = new SeatsStore({ file: tmpFile() });

  assert.equal(missing.reservedIds().size, 0);

  const corruptFile = tmpFile();
  fs.writeFileSync(corruptFile, "{not json");

  const corrupt = new SeatsStore({ file: corruptFile });

  assert.equal(corrupt.reservedIds().size, 0);
});

test("invalid seat entries are skipped on load", () => {
  const file = tmpFile();
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      seats: {
        good: { id: 2, out: 3 },
        negative: { id: -1, out: 3 },
        noChannel: { id: 4 },
        notAnObject: 7,
      },
    }),
  );

  const store = new SeatsStore({ file });

  assert.deepEqual(store.get("good"), { id: 2, out: 3 });
  assert.equal(store.get("negative"), undefined);
  assert.equal(store.get("noChannel"), undefined);
  assert.equal(store.get("notAnObject"), undefined);
});
