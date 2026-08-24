// Flower-view pure functions (issue #4, local axis added in #5): the
// overall verdict (worst LEG wins across hub and local, no weighting)
// with fault attribution naming the site AND the leg, and the derived
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
    attributionLeg: null,
  },
  {
    name: "single green node, no local data → green, hub attribution",
    nodes: [{ nodeId: "a", hubStatus: "green", localStatus: null, isSelf: true }],
    status: STATUS.GREEN,
    attributionNodeId: "a",
    attributionLeg: "hub",
    attributionSelf: true,
  },
  {
    name: "worst hub wins: green + yellow + green → yellow, attributed to the yellow one",
    nodes: [
      { nodeId: "a", hubStatus: "green", localStatus: "green", isSelf: true },
      { nodeId: "b", hubStatus: "yellow", localStatus: "green", isSelf: false },
      { nodeId: "c", hubStatus: "green", localStatus: "green", isSelf: false },
    ],
    status: STATUS.YELLOW,
    attributionNodeId: "b",
    attributionLeg: "hub",
    attributionSelf: false,
  },
  {
    name: "any red hub → red, attributed to that node's hub leg (not self)",
    nodes: [
      { nodeId: "a", hubStatus: "green", localStatus: "green", isSelf: true },
      { nodeId: "b", hubStatus: "green", localStatus: "green", isSelf: false },
      { nodeId: "c", hubStatus: "red", localStatus: "green", isSelf: false },
    ],
    status: STATUS.RED,
    attributionNodeId: "c",
    attributionLeg: "hub",
    attributionSelf: false,
  },
  {
    name: "own red hub leg → red, attributed to self's public leg",
    nodes: [
      { nodeId: "a", hubStatus: "red", localStatus: "green", isSelf: true },
      { nodeId: "b", hubStatus: "green", localStatus: "green", isSelf: false },
    ],
    status: STATUS.RED,
    attributionNodeId: "a",
    attributionLeg: "hub",
    attributionSelf: true,
  },
  {
    name: "a peer's red LOCAL leg drives the verdict (the #5 demo: “问题在 B 站本地腿”)",
    nodes: [
      { nodeId: "a", hubStatus: "green", localStatus: "green", isSelf: true },
      { nodeId: "b", hubStatus: "green", localStatus: "red", isSelf: false },
    ],
    status: STATUS.RED,
    attributionNodeId: "b",
    attributionLeg: "local",
    attributionSelf: false,
  },
  {
    name: "own red local leg → red, attributed to self's local leg",
    nodes: [
      { nodeId: "a", hubStatus: "green", localStatus: "red", isSelf: true },
      { nodeId: "b", hubStatus: "green", localStatus: "green", isSelf: false },
    ],
    status: STATUS.RED,
    attributionNodeId: "a",
    attributionLeg: "local",
    attributionSelf: true,
  },
  {
    name: "yellow local leg beats green hubs → yellow, local attribution",
    nodes: [
      { nodeId: "a", hubStatus: "green", localStatus: "green", isSelf: true },
      { nodeId: "b", hubStatus: "green", localStatus: "yellow", isSelf: false },
    ],
    status: STATUS.YELLOW,
    attributionNodeId: "b",
    attributionLeg: "local",
    attributionSelf: false,
  },
  {
    name: "warming-up (gray) peers don't fail an otherwise green network",
    nodes: [
      { nodeId: "a", hubStatus: "green", localStatus: "green", isSelf: true },
      { nodeId: "b", hubStatus: "gray", localStatus: "gray", isSelf: false },
    ],
    status: STATUS.GREEN,
  },
  {
    name: "a gray self with no peers → gray (no verdict yet)",
    nodes: [{ nodeId: "a", hubStatus: "gray", localStatus: null, isSelf: true }],
    status: STATUS.GRAY,
  },
  {
    name: "green hubs with a gray local (performers warming up) stay green",
    nodes: [
      { nodeId: "a", hubStatus: "green", localStatus: "gray", isSelf: true },
      { nodeId: "b", hubStatus: "green", localStatus: null, isSelf: false },
    ],
    status: STATUS.GREEN,
  },
];

for (const row of OVERALL_TABLE) {
  test(`overallFromNodes: ${row.name}`, () => {
    const result = overallFromNodes(row.nodes);

    assert.equal(result.status, row.status);

    if ("attributionNodeId" in row) {
      assert.equal(result.attributionNodeId, row.attributionNodeId);
    }

    if ("attributionLeg" in row) {
      assert.equal(result.attributionLeg, row.attributionLeg);
    }

    if ("attributionSelf" in row) {
      assert.equal(result.attributionSelf, row.attributionSelf);
    }
  });
}

test("overallFromNodes: the FIRST worst node wins ties (stable attribution)", () => {
  const result = overallFromNodes([
    { nodeId: "a", hubStatus: "red", localStatus: "green", isSelf: false },
    { nodeId: "b", hubStatus: "green", localStatus: "red", isSelf: false },
  ]);

  assert.equal(result.attributionNodeId, "a");
  assert.equal(result.attributionLeg, "hub");
});

test("overallFromNodes: same node, both legs worst → hub named (checked first)", () => {
  const result = overallFromNodes([
    { nodeId: "a", hubStatus: "red", localStatus: "red", isSelf: false },
  ]);

  assert.equal(result.attributionNodeId, "a");
  assert.equal(result.attributionLeg, "hub");
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
  assert.equal(derivedPerformerPair(null, 41, 41, 5), null, "own local unmeasured");
  assert.equal(derivedPerformerPair(3, 41, 41, null), null, "peer local unmeasured");
  assert.equal(derivedPerformerPair(3, null, 41, 5), null);
});
