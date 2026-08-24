// Flower-view pure functions (issue #4): the overall verdict (worst
// node wins, no weighting) with fault attribution, and the derived
// end-to-end numbers (star topology has no direct link — the numbers
// are sums of measured segments, never a third measurement).

const assert = require("node:assert/strict");
const test = require("node:test");

const { STATUS, overallFromNodes } = require("../lib/flower");
// The derived end-to-end sums live in the browser/server seam — the
// monitor page and these tests share the one implementation.
const { derivedSitePair, derivedPerformerPair } = require("../public/shared");

// ------------------------------------------------------------
// overallFromNodes — table-driven
// ------------------------------------------------------------

const OVERALL_TABLE = [
  {
    name: "empty roster → gray, no attribution",
    nodes: [],
    status: STATUS.GRAY,
    attributionNodeId: null,
  },
  {
    name: "single green node → green",
    nodes: [{ nodeId: "a", status: "green", isSelf: true }],
    status: STATUS.GREEN,
    attributionNodeId: "a",
    attributionSelf: true,
  },
  {
    name: "worst wins: green + yellow + green → yellow, attributed to the yellow one",
    nodes: [
      { nodeId: "a", status: "green", isSelf: true },
      { nodeId: "b", status: "yellow", isSelf: false },
      { nodeId: "c", status: "green", isSelf: false },
    ],
    status: STATUS.YELLOW,
    attributionNodeId: "b",
    attributionSelf: false,
  },
  {
    name: "any red → red, attributed to the red node (not self)",
    nodes: [
      { nodeId: "a", status: "green", isSelf: true },
      { nodeId: "b", status: "green", isSelf: false },
      { nodeId: "c", status: "red", isSelf: false },
    ],
    status: STATUS.RED,
    attributionNodeId: "c",
    attributionSelf: false,
  },
  {
    name: "own red leg → red, attributed to self",
    nodes: [
      { nodeId: "a", status: "red", isSelf: true },
      { nodeId: "b", status: "green", isSelf: false },
    ],
    status: STATUS.RED,
    attributionNodeId: "a",
    attributionSelf: true,
  },
  {
    name: "warming-up peers don't fail an otherwise green network",
    nodes: [
      { nodeId: "a", status: "green", isSelf: true },
      { nodeId: "b", status: "gray", isSelf: false },
    ],
    status: STATUS.GREEN,
  },
  {
    name: "a gray self with no peers → gray (no verdict yet)",
    nodes: [{ nodeId: "a", status: "gray", isSelf: true }],
    status: STATUS.GRAY,
  },
];

for (const row of OVERALL_TABLE) {
  test(`overallFromNodes: ${row.name}`, () => {
    const result = overallFromNodes(row.nodes);

    assert.equal(result.status, row.status);

    if ("attributionNodeId" in row) {
      assert.equal(result.attributionNodeId, row.attributionNodeId);
    }

    if ("attributionSelf" in row) {
      assert.equal(result.attributionSelf, row.attributionSelf);
    }
  });
}

test("overallFromNodes: the FIRST worst node wins ties (stable attribution)", () => {
  const result = overallFromNodes([
    { nodeId: "a", status: "red", isSelf: false },
    { nodeId: "b", status: "red", isSelf: false },
  ]);

  assert.equal(result.attributionNodeId, "a");
});

// ------------------------------------------------------------
// Derived end-to-end numbers
// ------------------------------------------------------------

test("derivedSitePair: two hub-leg p50s sum; unmeasured segments stay null", () => {
  assert.equal(derivedSitePair(41, 41), 82);
  assert.equal(derivedSitePair(12.34, 5.66), 18);
  assert.equal(derivedSitePair(null, 41), null);
  assert.equal(derivedSitePair(41, null), null);
  assert.equal(derivedSitePair(undefined, undefined), null);
});

test("derivedPerformerPair: four segments sum; any missing segment → null", () => {
  // 本地 + hub + hub + 本地 (parent #1: performer 对 = 四段之和)
  assert.equal(derivedPerformerPair(3, 41, 41, 5), 90);
  assert.equal(derivedPerformerPair(null, 41, 41, 5), null, "own local unmeasured (#5 pending)");
  assert.equal(derivedPerformerPair(3, 41, 41, null), null, "peer local unmeasured");
  assert.equal(derivedPerformerPair(3, null, 41, 5), null);
});
