// Flower view — the whole-network picture (issue #4): every site's
// monitor shows the same picture, assembled from what each node
// self-reports over the hub room relay.
//
// Pure, table-testable piece:
//   overallFromNodes — worst of all hub legs (+ local legs once #5
//                      reports them) → overall color with fault
//                      attribution. No weighting — the worst leg
//                      decides (parent #1).
//
// (The derived end-to-end sums live in public/shared.js — the
// browser/server seam — so the monitor page and the tests share one
// implementation.)

const STATUS = {
  GRAY: "gray",
  GREEN: "green",
  YELLOW: "yellow",
  RED: "red",
};

const STATUS_RANK = { gray: 0, green: 1, yellow: 2, red: 3 };

// The overall banner's verdict. No weighting — the worst leg decides
// (parent #1: "overall 判定逻辑取最差，不做加权").
//
// nodes: [{ nodeId, status, isSelf }] — every known node's hub-leg
// quality, self included. An empty roster has no verdict yet (gray).
// Attribution names the FIRST worst node; a red overall blames that
// node's public (hub) leg, in plain copy the monitor composes.
function overallFromNodes(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  let worst = null;

  for (const node of list) {
    if (!worst || (STATUS_RANK[node.status] || 0) > (STATUS_RANK[worst.status] || 0)) {
      worst = node;
    }
  }

  if (!worst) {
    return { status: STATUS.GRAY, attributionNodeId: null, attributionSelf: false };
  }

  return {
    status: worst.status,
    attributionNodeId: worst.nodeId,
    attributionSelf: Boolean(worst.isSelf),
  };
}

module.exports = {
  STATUS,
  overallFromNodes,
};
