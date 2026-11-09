const assert = require("node:assert/strict");
const test = require("node:test");
const { overallFromNodes } = require("../lib/flower");

test("internet verdict: empty or invalid readings remain pending", () => {
  assert.deepEqual(overallFromNodes([]), {
    status: "gray", attributionNodeId: null, attributionLeg: null, attributionSelf: false,
  });
  assert.equal(overallFromNodes([{hubStatus:"not-a-status"}]).status, "gray");
});

test("internet verdict ignores obsolete local failures from old nodes", () => {
  const result = overallFromNodes([
    {nodeId:"self", hubStatus:"green", localStatus:"red", isSelf:true},
    {nodeId:"remote", hubStatus:"green", localStatus:"red"},
  ]);
  assert.equal(result.status,"green");
  assert.equal(result.attributionLeg,"hub");
  assert.equal(result.attributionSelf,true);
});

test("internet verdict attributes the worst public link and keeps first ties stable", () => {
  const nodes = [
    {nodeId:"self",hubStatus:"green",isSelf:true},
    {nodeId:"warn",hubStatus:"yellow"},
    {nodeId:"bad",hubStatus:"red"},
    {nodeId:"also-bad",hubStatus:"red"},
  ];
  assert.deepEqual(overallFromNodes(nodes),{
    status:"red",attributionNodeId:"bad",attributionLeg:"hub",attributionSelf:false,
  });
  assert.equal(overallFromNodes(nodes.slice(0,2)).status,"yellow");
});

test("own outage is attributed to self while remote readings are unconfirmed", () => {
  const result = overallFromNodes([
    {nodeId:"self",hubStatus:"red",isSelf:true},
    {nodeId:"remote",hubStatus:"gray"},
  ]);
  assert.equal(result.attributionNodeId,"self");
  assert.equal(result.attributionSelf,true);
});

test("unfinished remote sampling keeps a stable room pending, while negative evidence still wins", () => {
  const nodes = [
    {nodeId:"self",hubStatus:"green",isSelf:true},
    {nodeId:"sampling",hubStatus:"gray"},
  ];
  assert.equal(overallFromNodes(nodes).status,"gray");
  assert.equal(overallFromNodes(nodes).attributionNodeId,"sampling");
  assert.equal(overallFromNodes([...nodes,{nodeId:"warning",hubStatus:"yellow"}]).status,"yellow");
  assert.equal(overallFromNodes([...nodes,{nodeId:"failed",hubStatus:"red"}]).status,"red");
});
