// PNDS Template — performer page (p5).
//
// Landscape touch UI: two curved faders that follow the natural arc of the
// thumbs (the pivot is the wrist, outside the lower corners of the phone).
// Each fader is a TRUE circular arc (circle through the top end, the bottom
// end and a mid point bulging toward the center of the screen), sampled by
// angle; a touch projects radially onto the circle, so the whole thumb arc
// maps to the full fader range. Roles follow string instruments: the LEFT
// hand controls pitch (FREQ, like pressing the string), the RIGHT hand
// controls tone (AMP, like bowing). Portrait orientation shows a rotate
// hint and ignores input. The page joins the score server automatically
// and recovers its client id after a reconnect via the persisted claim
// token.
//
// The left (FREQ) fader carries a pitch scale: a small radial tick per
// semitone inside the active register's range, with the center note and
// its fifth above / below (bright ticks) getting letter names. A
// 3-position switch below the status text picks the register (1 = low,
// 2 = mid, 3 = high); the fader value stays put while the Hz band (and
// the server-side mapping) changes. The range endpoints are not notes and
// get no tick and no label.

const P = window.PNDS;

// Score-server client: connection, claim-token join/rejoin, my-voice
// state tracking and the send-if-changed deadband live in client.js
// (tested there); this page is drawing and input only.
const client = window.PNDSClient.connectPerformer({
  io: io,
  port: P.performerPort,
  events: P.events,
  tokenKey: P.tokenKey,
  storage: localStorage,
  hostname: location.hostname,
});

let ampValue = 0;
let freqValue = 0;

// Active fader register (1 = low, 2 = mid, 3 = high); switched with the
// 3-position switch below the status text. The fader VALUE stays put; the
// Hz band it maps to changes (registers in shared.js).
let register = P.defaultRegister;

const TWO_PI = Math.PI * 2;

// Fader geometry (fractions of the window). Each arc runs from the top end
// (value 1) near its own edge down to the bottom end (value 0) closer to
// the center. The circle passes through both ends and a mid point that
// bulges toward the center — the thumb pivots at the wrist (outside the
// lower corners), so its tip traces an arc on the far side of the chord.
const FADER_TOP_X = 0.12; // top end distance from the outer edge
const FADER_TOP_Y = 0.08;
const FADER_BOTTOM_X = 0.4; // bottom end distance from the center
const FADER_BOTTOM_Y = 0.85;
const FADER_BULGE = 0.1; // arc height = 10% of the chord length (~38 px)
const TRACK_WEIGHT = 36;
// A touch grabs a fader only within this distance of the arc. The radial
// projection itself accepts the whole screen (any point has an angle), so
// without this gate a stray thumb — e.g. while reaching for the register
// switch — yanked the nearest fader from far outside the visible track.
const GRAB_RADIUS = 60;
const KNOB_RADIUS = 36; // knob diameter (p5 circle() takes a diameter)
const CURVE_STEPS = 60; // arc sampling resolution for rendering
const VALUE_OFFSET = 30; // value chip inset from the knob, away from the thumb
const LABEL_INSET = 80; // role labels inset from the screen edges

// FREQ fader pitch scale (left side only): one small radial tick per
// semitone inside the range; the labeled notes (E / B / F#) get the same
// small tick in a brighter color plus a letter name. Tick data comes from
// shared.js freqTicks; the fader maps Hz linearly, so each tick sits at
// freqFraction(freq) of the arc sweep.
const TICK_HALF = 14; // tick half-length across the track
const TICK_LABEL_INSET = 30; // label distance from the track center line
const TICK_SMALL_COLOR = [85, 94, 116];
const TICK_LABEL_COLOR = [208, 216, 238];

// Three-position register switch (1 = low, 2 = mid, 3 = high), centered
// below the status text. Tapping a segment switches the FREQ fader band.
const SWITCH_Y = 52;
const SWITCH_SEGMENT_WIDTH = 54;
const SWITCH_HEIGHT = 30;
const SWITCH_GAP = 4;
const SWITCH_ACTIVE_COLOR = [94, 168, 255];
const SWITCH_INACTIVE_FILL = [30, 34, 44];
const SWITCH_BORDER = [58, 64, 82];
const SWITCH_TEXT_ACTIVE = [255, 255, 255];
const SWITCH_TEXT_INACTIVE = [150, 160, 180];

function setup() {
  const canvas = createCanvas(windowWidth, windowHeight);
  canvas.parent("stage");
  updateRotateOverlay();
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  updateRotateOverlay();
}

function updateRotateOverlay() {
  const overlay = document.getElementById("rotate-overlay");
  overlay.classList.toggle("hidden", !isPortrait());
}

function isPortrait() {
  return window.innerHeight > window.innerWidth;
}

// ------------------------------------------------------------
// Fader geometry: true circular arcs
// ------------------------------------------------------------

// Center + radius of the circle through (ax, ay), (bx, by), (px, py).
function circumcircle(ax, ay, bx, by, px, py) {
  const d =
    2 *
    (ax * (by - py) + bx * (py - ay) + px * (ay - by));

  if (Math.abs(d) < 1e-9) {
    return null; // collinear — cannot happen with the bulge applied
  }

  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const p2 = px * px + py * py;
  const x =
    (a2 * (by - py) + b2 * (py - ay) + p2 * (ay - by)) / d;
  const y =
    (a2 * (px - bx) + b2 * (ax - px) + p2 * (bx - ax)) / d;

  return { x, y, r: Math.hypot(ax - x, ay - y) };
}

// Clockwise sweep (angle increase, p5 coordinates) from start to end.
function sweepFrom(start, end) {
  return ((end - start) % TWO_PI + TWO_PI) % TWO_PI;
}

// { x, y, r, aBottom, sweep }: circle center/radius, the angle of the
// bottom end (value 0) and the SIGNED sweep from bottom to top along the
// arc that passes through the bulge mid point (positive = clockwise). The
// two faders are mirror images, so their sweep signs are opposite.
function faderArc(side) {
  const top = {
    x: width * (side === "left" ? FADER_TOP_X : 1 - FADER_TOP_X),
    y: height * FADER_TOP_Y,
  };
  const bottom = {
    x: width * (side === "left" ? FADER_BOTTOM_X : 1 - FADER_BOTTOM_X),
    y: height * FADER_BOTTOM_Y,
  };
  const dx = bottom.x - top.x;
  const dy = bottom.y - top.y;
  const chord = Math.hypot(dx, dy) || 1;
  const sign = side === "left" ? 1 : -1;
  // Chord normal pointing toward the center of the screen.
  const nx = (dy / chord) * sign;
  const ny = (-dx / chord) * sign;
  const mid = {
    x: (top.x + bottom.x) / 2 + nx * chord * FADER_BULGE,
    y: (top.y + bottom.y) / 2 + ny * chord * FADER_BULGE,
  };

  const circle = circumcircle(
    top.x,
    top.y,
    bottom.x,
    bottom.y,
    mid.x,
    mid.y,
  );
  const aTop = Math.atan2(top.y - circle.y, top.x - circle.x);
  const aBottom = Math.atan2(bottom.y - circle.y, bottom.x - circle.x);
  const aMid = Math.atan2(mid.y - circle.y, mid.x - circle.x);

  // Signed sweep from bottom to top along the arc through mid.
  let sweep = sweepFrom(aBottom, aTop); // clockwise candidate
  if (sweepFrom(aBottom, aMid) > sweep) {
    sweep = -sweepFrom(aTop, aBottom); // mid lies counterclockwise
  }

  return { x: circle.x, y: circle.y, r: circle.r, aBottom, sweep };
}

// Point on the arc at fader value 0..1 (0 = bottom, 1 = top).
function arcPoint(arc, value) {
  const theta = arc.aBottom + value * arc.sweep;

  return {
    x: arc.x + arc.r * Math.cos(theta),
    y: arc.y + arc.r * Math.sin(theta),
  };
}

function sampleArc(arc) {
  const points = [];

  for (let index = 0; index <= CURVE_STEPS; index += 1) {
    points.push(arcPoint(arc, index / CURVE_STEPS));
  }

  return points;
}

// Projects (x, y) radially onto the arc's circle. Returns
// { value (0..1), dist (px to the arc itself — beyond an end it measures
// to the end point), x, y (projected point) }.
function projectOnArc(x, y, side) {
  const arc = faderArc(side);
  const d = Math.hypot(x - arc.x, y - arc.y) || 1;
  const theta = Math.atan2(y - arc.y, x - arc.x);
  let rel = theta - arc.aBottom;

  // Normalize the offset to [-π, π].
  while (rel > Math.PI) {
    rel -= TWO_PI;
  }
  while (rel < -Math.PI) {
    rel += TWO_PI;
  }

  let value;

  if (arc.sweep > 0) {
    // Arc lies clockwise from the bottom end.
    if (rel < 0) {
      value = 0;
    } else if (rel > arc.sweep) {
      value = 1;
    } else {
      value = rel / arc.sweep;
    }
  } else {
    // Arc lies counterclockwise from the bottom end.
    if (rel > 0) {
      value = 0;
    } else if (rel < arc.sweep) {
      value = 1;
    } else {
      value = rel / arc.sweep;
    }
  }

  const clamped = constrain(value, 0, 1);
  const thetaC = arc.aBottom + clamped * arc.sweep;
  const point = {
    x: arc.x + arc.r * Math.cos(thetaC),
    y: arc.y + arc.r * Math.sin(thetaC),
  };

  return {
    value: clamped,
    dist: Math.hypot(x - point.x, y - point.y),
    x: point.x,
    y: point.y,
  };
}

// The arc a touch grabs, or null when the touch is beyond GRAB_RADIUS of
// both arcs — the rest of the screen is not a fader.
function sideForPoint(x, y) {
  const left = projectOnArc(x, y, "left");
  const right = projectOnArc(x, y, "right");

  if (left.dist > GRAB_RADIUS && right.dist > GRAB_RADIUS) {
    return null;
  }

  return left.dist <= right.dist ? "left" : "right";
}

// String-instrument roles: the left hand picks pitch, the right hand tone.
function setFader(side, x, y) {
  const { value } = projectOnArc(x, y, side);

  if (side === "left") {
    freqValue = value;
  } else {
    ampValue = value;
  }
}

// ------------------------------------------------------------
// Register switch (three-position, centered below the status text)
// ------------------------------------------------------------

function switchBounds() {
  const totalWidth =
    3 * SWITCH_SEGMENT_WIDTH + 2 * SWITCH_GAP;

  return {
    x: width / 2 - totalWidth / 2,
    y: SWITCH_Y,
    width: totalWidth,
    height: SWITCH_HEIGHT,
  };
}

// Register (1..3) under (x, y), or null when outside the switch.
function registerAtPoint(x, y) {
  const bounds = switchBounds();

  if (
    x < bounds.x ||
    x > bounds.x + bounds.width ||
    y < bounds.y ||
    y > bounds.y + bounds.height
  ) {
    return null;
  }

  const local = x - bounds.x;
  const cell = SWITCH_SEGMENT_WIDTH + SWITCH_GAP;

  // The gaps between segments are not buttons — a sloppy tap there must
  // not switch the register.
  if (local % cell >= SWITCH_SEGMENT_WIDTH) {
    return null;
  }

  const index = Math.floor(local / cell);

  return index >= 0 && index <= 2 ? index + 1 : null;
}

// Tap targets that started on the switch stay on it for the whole gesture,
// so a drag on the switch cannot yank a fader.
const switchTouchIds = new Set();

// Likewise, a touch that has grabbed a fader stays on that fader for the
// whole gesture: the grab radius only gates NEW touches, so a drag that
// overshoots the arc's end keeps controlling the fader instead of letting
// go mid-gesture.
const faderTouchIds = new Map();

// ------------------------------------------------------------
// Input
// ------------------------------------------------------------

function touchStarted() {
  if (isPortrait()) {
    return false;
  }

  for (const touch of touches) {
    const segment = registerAtPoint(touch.x, touch.y);

    if (segment !== null) {
      switchTouchIds.add(touch.id);
      register = segment;
    } else {
      const side = sideForPoint(touch.x, touch.y);

      if (side !== null) {
        faderTouchIds.set(touch.id, side);
        setFader(side, touch.x, touch.y);
      }
    }
  }

  sendIfChanged();
  return false;
}

function touchMoved() {
  if (isPortrait()) {
    return false;
  }

  for (const touch of touches) {
    if (switchTouchIds.has(touch.id)) {
      continue;
    }

    const side = faderTouchIds.get(touch.id) ?? sideForPoint(touch.x, touch.y);

    if (side !== null) {
      faderTouchIds.set(touch.id, side);
      setFader(side, touch.x, touch.y);
    }
  }

  sendIfChanged();
  return false;
}

function touchEnded() {
  for (const touch of touches) {
    switchTouchIds.delete(touch.id);
    faderTouchIds.delete(touch.id);
  }

  return false;
}

function mousePressed() {
  if (isPortrait()) {
    return false;
  }

  const segment = registerAtPoint(mouseX, mouseY);

  if (segment !== null) {
    register = segment;
    sendIfChanged();
    return false;
  }

  return false;
}

function mouseDragged() {
  if (isPortrait()) {
    return false;
  }

  const side = sideForPoint(mouseX, mouseY);

  if (side !== null) {
    setFader(side, mouseX, mouseY);
  }

  sendIfChanged();
  return false;
}

// The deadband (send only when a value actually moved) lives in the
// client module; this is just "the inputs changed, offer them".
function sendIfChanged() {
  client.sendControls({
    amp: ampValue,
    freq: freqValue,
    range: register,
  });
}

// ------------------------------------------------------------
// Drawing
// ------------------------------------------------------------

// freqRange of the active register (single source: shared.js registers).
function activeRange() {
  return P.registers[register].freqRange;
}

function formatFreq() {
  const hz = Math.round(P.freqFromValue(freqValue, activeRange()));
  return hz + " Hz";
}

function draw() {
  background(20, 22, 28);

  // Portrait shows the DOM overlay (#rotate-overlay) with bilingual text;
  // the canvas itself stays quiet.
  if (isPortrait()) {
    return;
  }

  drawFader("left", freqValue, formatFreq());
  drawFader("right", ampValue, ampValue.toFixed(2));
  drawLabels();
  drawSwitch();
  drawStatus();
}

function drawFader(side, value, valueText) {
  const arc = faderArc(side);
  const knob = arcPoint(arc, value);

  // track: the true circular arc, sampled (p5 arc() angle conventions
  // don't cover counterclockwise sweeps, so render as a polyline)
  noFill();
  stroke(42, 46, 58);
  strokeWeight(TRACK_WEIGHT);
  strokeCap(ROUND);
  strokeJoin(ROUND);
  beginShape();
  for (const point of sampleArc(arc)) {
    vertex(point.x, point.y);
  }
  endShape(OPEN);

  // pitch scale on the FREQ fader (left side only)
  if (side === "left") {
    drawFreqScale(arc);
  }

  // knob: white dot
  noStroke();
  fill(255);
  circle(knob.x, knob.y, KNOB_RADIUS);

  // value: inset toward the center of the screen so the thumb never
  // covers it
  const chipX = side === "left" ? knob.x + VALUE_OFFSET : knob.x - VALUE_OFFSET;
  drawValueChip(valueText, chipX, knob.y, side);
}

// Radial tick across the track at the arc position for `freq`, using the
// active register's linear mapping.
function drawFreqTick(arc, freq, halfLength) {
  const theta =
    arc.aBottom + P.freqFraction(freq, activeRange()) * arc.sweep;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  line(
    arc.x + (arc.r - halfLength) * cos,
    arc.y + (arc.r - halfLength) * sin,
    arc.x + (arc.r + halfLength) * cos,
    arc.y + (arc.r + halfLength) * sin,
  );
}

// Letter-name label on the concave side of the arc (toward the screen
// edge), away from the value chip and the thumb.
function drawFreqTickLabel(arc, freq, name) {
  const theta =
    arc.aBottom + P.freqFraction(freq, activeRange()) * arc.sweep;
  const x = arc.x + (arc.r - TICK_LABEL_INSET) * Math.cos(theta);
  const y = arc.y + (arc.r - TICK_LABEL_INSET) * Math.sin(theta);

  noStroke();
  fill(TICK_LABEL_COLOR[0], TICK_LABEL_COLOR[1], TICK_LABEL_COLOR[2]);
  textSize(13);
  textAlign(RIGHT, CENTER);
  text(name, x - 4, y + 1);
}

// Pitch scale for the FREQ fader: every semitone inside the active
// register's range gets the same small tick; the center note and its
// fifth above/below get a brighter tick (same size) and a letter name.
// The range endpoints are not notes, so the scale starts at the note just
// inside the bottom end and ends at the one just inside the top end.
function drawFreqScale(arc) {
  const ticks = P.registers[register].freqTicks;

  // push/pop isolates the scale's stroke/fill state: drawFreqTickLabel
  // disables the stroke for its text, which must not leak into the next
  // tick or into the knob/chip drawing in drawFader.
  push();
  stroke(TICK_SMALL_COLOR[0], TICK_SMALL_COLOR[1], TICK_SMALL_COLOR[2]);
  strokeWeight(2);
  for (const freq of ticks.semitones) {
    drawFreqTick(arc, freq, TICK_HALF);
  }

  // Brighter ticks for the labeled notes, drawn over the dim ones, then
  // their letter names.
  stroke(TICK_LABEL_COLOR[0], TICK_LABEL_COLOR[1], TICK_LABEL_COLOR[2]);
  strokeWeight(2);
  for (const entry of ticks.labeled) {
    drawFreqTick(arc, entry.freq, TICK_HALF);
  }

  for (const entry of ticks.labeled) {
    drawFreqTickLabel(arc, entry.freq, entry.name);
  }
  pop();
}

// Three-position register switch below the status text; the active segment
// is highlighted.
function drawSwitch() {
  const bounds = switchBounds();

  for (let index = 0; index < 3; index += 1) {
    const x = bounds.x + index * (SWITCH_SEGMENT_WIDTH + SWITCH_GAP);
    const active = register === index + 1;

    if (active) {
      noStroke();
      fill(
        SWITCH_ACTIVE_COLOR[0],
        SWITCH_ACTIVE_COLOR[1],
        SWITCH_ACTIVE_COLOR[2],
      );
    } else {
      stroke(SWITCH_BORDER[0], SWITCH_BORDER[1], SWITCH_BORDER[2]);
      strokeWeight(1);
      fill(
        SWITCH_INACTIVE_FILL[0],
        SWITCH_INACTIVE_FILL[1],
        SWITCH_INACTIVE_FILL[2],
      );
    }

    rect(x, bounds.y, SWITCH_SEGMENT_WIDTH, SWITCH_HEIGHT, 8);

    const textColor = active
      ? SWITCH_TEXT_ACTIVE
      : SWITCH_TEXT_INACTIVE;
    noStroke();
    fill(textColor[0], textColor[1], textColor[2]);
    textAlign(CENTER, CENTER);
    textSize(15);
    text(
      String(index + 1),
      x + SWITCH_SEGMENT_WIDTH / 2,
      bounds.y + SWITCH_HEIGHT / 2 + 1,
    );
  }
}

// NOTE: the parameter is named valueText, not text — a parameter named
// `text` would shadow p5's global text() function.
function drawValueChip(valueText, x, y, side) {
  textSize(16);
  const chipWidth = textWidth(valueText) + 14;
  const chipHeight = 24;
  const chipX = side === "left" ? x : x - chipWidth;

  fill(14, 15, 20, 200);
  rect(chipX, y - chipHeight / 2, chipWidth, chipHeight, 6);

  fill(255);
  textAlign(side === "left" ? LEFT : RIGHT, CENTER);
  text(valueText, side === "left" ? x + 7 : x - 7, y + 1);
}

// Role labels pinned to the lower corners (left = pitch, right = tone),
// inset from the edges so they do not hug the screen border.
function drawLabels() {
  textSize(14);
  fill(180, 190, 210);

  textAlign(LEFT, BOTTOM);
  text("FREQ", LABEL_INSET, height - 16);

  textAlign(RIGHT, BOTTOM);
  text("AMP", width - LABEL_INSET, height - 16);
}

function drawStatus() {
  textAlign(CENTER, TOP);
  textSize(24);

  if (client.rejectedReason) {
    fill(255, 120, 120);
    text("rejected: " + client.rejectedReason, width / 2, 14);
  } else if (client.joined) {
    fill(120, 220, 150);
    text(
      "ID: " + client.myId + "  CH: " + (client.myOut === null ? "–" : client.myOut),
      width / 2,
      14,
    );
  } else {
    fill(200, 200, 210);
    text("connecting…", width / 2, 14);
  }
}
