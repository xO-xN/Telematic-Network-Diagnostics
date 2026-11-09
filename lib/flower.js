// Internet-only verdict. Local devices and historic local summaries never
// participate, including when an older node still relays those fields.
const { STATUS } = require("./status");
// Negative evidence wins; otherwise an unfinished node keeps the room
// pending rather than claiming that every public connection is stable.
const VERDICT_RANK = { green: 0, gray: 1, yellow: 2, red: 3 };

function overallFromNodes(nodes) {
  let worst = null;
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!Object.hasOwn(VERDICT_RANK, node.hubStatus)) continue;
    if (!worst || VERDICT_RANK[node.hubStatus] > VERDICT_RANK[worst.hubStatus]) worst = node;
  }
  return {
    status: worst ? worst.hubStatus : STATUS.GRAY,
    attributionNodeId: worst ? worst.nodeId : null,
    attributionLeg: worst ? "hub" : null,
    attributionSelf: Boolean(worst && worst.isSelf),
  };
}

module.exports = { STATUS, overallFromNodes };
