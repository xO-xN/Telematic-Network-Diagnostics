// Small, dependency-free geographic layout. Land uses the same 960×480
// equirectangular source space; local longitude scaling corrects latitude.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PNDS_GEOGRAPHY = api;
})(typeof self !== "undefined" ? self : this, function () {
  function validLocation(value) {
    return Boolean(value && Number.isFinite(value.latitude) && Number.isFinite(value.longitude) && Math.abs(value.latitude) <= 90 && Math.abs(value.longitude) <= 180);
  }
  function project(location) {
    return { x: (location.longitude + 180) * 960 / 360, y: (90 - location.latitude) * 480 / 180 };
  }
  function fitCamera(locations, width, height) {
    const known = locations.filter(validLocation);
    if (!known.length || width <= 0 || height <= 0) return null;
    // Cut the longitude circle at its largest empty gap. Nearby nodes on
    // opposite sides of 180° remain nearby instead of forcing a world view.
    const sorted = known.map(p => p.longitude).sort((a, b) => a - b);
    let gap = -1, start = sorted[0];
    for (let i = 0; i < sorted.length; i++) {
      const next = i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + 360;
      if (next - sorted[i] > gap) { gap = next - sorted[i]; start = next > 180 ? next - 360 : next; }
    }
    const longitude = value => value < start ? value + 360 : value;
    const points = known.map(p => project({ ...p, longitude: longitude(p.longitude) }));
    const minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x));
    const minY = Math.min(...points.map(p => p.y)), maxY = Math.max(...points.map(p => p.y));
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const cos = Math.max(.15, Math.cos((90 - cy * 180 / 480) * Math.PI / 180));
    const dx = Math.max(maxX - minX, .65 * 960 / 360 / cos);
    const dy = Math.max(maxY - minY, .5 * 480 / 180);
    const padX = width < 480 ? 36 : 68, padY = 46;
    const sy = Math.min(Math.max(60, width - padX * 2) / (dx * cos * 1.22), Math.max(60, height - padY * 2) / (dy * 1.22));
    const sx = sy * cos, ox = width / 2 - cx * sx, oy = height / 2 - cy * sy;
    return { sx, sy, ox, oy, start, pixelsPerKm: sy * 480 / 180 / 111.32 };
  }
  function position(location, camera) {
    const longitude = location.longitude < camera.start ? location.longitude + 360 : location.longitude;
    const point = project({ ...location, longitude });
    return { x: camera.ox + point.x * camera.sx, y: camera.oy + point.y * camera.sy };
  }
  function nearest(points, x, y, radius = 16) {
    let result = null, distance = radius * radius;
    for (const point of points) {
      const next = (point.x - x) ** 2 + (point.y - y) ** 2;
      if (next < distance) { result = point; distance = next; }
    }
    return result;
  }
  function hash(value) {
    let result = 2166136261;
    for (const character of String(value)) result = Math.imul(result ^ character.codePointAt(0), 16777619);
    return result >>> 0;
  }
  return { validLocation, project, fitCamera, position, nearest, hash };
});
