const assert = require("node:assert/strict");
const test = require("node:test");
const G = require("../public/geography");
const point = (latitude, longitude) => ({ latitude, longitude });
test("valid locations accept zero and reject missing, nonfinite and outside-earth coordinates", () => {
  assert.equal(G.validLocation(point(0, 0)), true);
  for (const value of [null, {}, point(null, 2), point(NaN, 0), point(91, 0), point(0, 181)]) assert.equal(G.validLocation(value), false);
  assert.equal(G.fitCamera([], 680, 340), null);
});
test("regional fit includes stations and Nanjing hub with margin, preserving exact projection geometry", () => {
  const points = [point(39.91, 116.37), point(39.73, 116.34), point(30.6, 114.3), point(40.84, 111.75), point(32.04, 118.77)];
  const camera = G.fitCamera(points, 680, 340), rendered = points.map(p => G.position(p, camera));
  for (const p of rendered) assert.ok(p.x > 30 && p.x < 650 && p.y > 30 && p.y < 310);
  assert.ok(Math.abs(rendered[0].y - rendered[1].y) < 5, "nearby nodes are not artificially spread");
  assert.ok(Math.abs((rendered[1].x - rendered[0].x) - (-.03 * 960 / 360 * camera.sx)) < 1e-9);
  assert.ok(340 / camera.sy * 180 / 480 < 20, "a regional roster does not show the world");
});
test("dateline neighbors fit the short arc and a single location keeps a useful city-sized extent", () => {
  const points = [point(35, 179), point(35, -179)], camera = G.fitCamera(points, 680, 340);
  assert.ok(680 / camera.sx * 360 / 960 < 10);
  for (const p of points.map(p => G.position(p, camera))) assert.ok(p.x > 30 && p.x < 650);
  const city = G.fitCamera([point(40, 116)], 680, 340); assert.ok(680 / city.sx * 360 / 960 >= .65);
});
test("nearest-circle picking distinguishes close overlapping hit targets without moving points", () => {
  const points = [{ id: "西城", x: 100, y: 100 }, { id: "大兴", x: 100, y: 103 }], snapshot = structuredClone(points);
  assert.equal(G.nearest(points, 100, 100).id, "西城"); assert.equal(G.nearest(points, 100, 103).id, "大兴"); assert.equal(G.nearest(points, 160, 160), null); assert.deepEqual(points, snapshot);
});
