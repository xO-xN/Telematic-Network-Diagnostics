// Flower view — the whole-network picture (issue #4): every site's
// monitor shows the same picture, assembled from what each node
// self-reports over the hub room relay.
//
// Pure, table-testable piece:
//   overallFromNodes — worst of all legs, hub AND local (issue #5
//                      added the local axis) → overall color with
//                      fault attribution naming the site AND the leg.
//                      No weighting — the worst leg decides (parent
//                      #1).
//
// (The derived end-to-end sums live in public/shared.js — the
// browser/server seam — so the monitor page and the tests share one
// implementation.)

const { STATUS, STATUS_RANK } = require("./status");

// Legs of one node, in check order — also the attribution vocabulary.
const LEGS = ["hub", "local"];

// The overall banner's verdict. No weighting — the worst leg decides
// (parent #1: "overall 判定逻辑取最差，不做加权").
//
// nodes: [{ nodeId, hubStatus, localStatus, isSelf }] — every known
// node's hub-leg quality plus its self-reported local-leg worst
// (localStatus null = that site reports no local data yet; it is
// skipped, not counted as gray). An empty roster has no verdict yet
// (gray). Attribution names the FIRST worst (node order, hub before
// local); the monitor composes the plain copy — "本站本地腿",
// "<node> 公网腿" — from { attributionNodeId, attributionLeg,
// attributionSelf }.
function overallFromNodes(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  let worst = null; // { status, node, leg }

  for (const node of list) {
    for (const leg of LEGS) {
      const status = leg === "hub" ? node.hubStatus : node.localStatus;

      if (typeof status !== "string") {
        continue;
      }

      if (
        !worst ||
        (STATUS_RANK[status] || 0) > (STATUS_RANK[worst.status] || 0)
      ) {
        worst = { status, node, leg };
      }
    }
  }

  if (!worst) {
    return {
      status: STATUS.GRAY,
      attributionNodeId: null,
      attributionLeg: null,
      attributionSelf: false,
    };
  }

  return {
    status: worst.status,
    attributionNodeId: worst.node.nodeId,
    attributionLeg: worst.leg,
    attributionSelf: Boolean(worst.node.isSelf),
  };
}

module.exports = {
  STATUS,
  overallFromNodes,
};
