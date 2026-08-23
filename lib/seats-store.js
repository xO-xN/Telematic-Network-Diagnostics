// Persistent seat assignments: claim token -> { id, out }.
//
// The claim token a performer page keeps in localStorage is the device's
// persistent identity; this file is what the SERVER remembers about it
// across restarts, so a work reopened for the next show hands every known
// device back its seat number and output channel without operator action.
// Live fader state deliberately does NOT live here — protocol.js keeps it
// in memory, because it must survive phone locks, not server restarts.
//
// A seat stays reserved for its token until the monitor's reset-ids
// wipes the file: an id recorded for one device is never handed to
// another while the record exists. Stale seats (a phone that never
// returns) therefore consume ids until the operator resets — that is
// what the button is for.

const fs = require("node:fs");
const path = require("node:path");

function validSeat(seat) {
  return (
    seat !== null &&
    typeof seat === "object" &&
    Number.isInteger(seat.id) &&
    seat.id >= 1 &&
    Number.isInteger(seat.out) &&
    seat.out >= 1
  );
}

class SeatsStore {
  constructor({ file }) {
    this.file = file;
    this.seats = new Map(); // claimToken -> { id, out }
    this.load();
  }

  load() {
    let raw;

    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      return; // no file yet — first run of the work
    }

    let parsed;

    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      console.error(
        `[seats] ignoring corrupt state file (${this.file}):`,
        error.message,
      );
      return;
    }

    const seats = parsed && parsed.seats;

    if (seats === null || typeof seats !== "object") {
      return;
    }

    for (const [token, seat] of Object.entries(seats)) {
      if (validSeat(seat)) {
        this.seats.set(token, { id: seat.id, out: seat.out });
      }
    }
  }

  // Returns a copy of the token's seat, or undefined.
  get(token) {
    const seat = this.seats.get(token);

    return seat ? { ...seat } : undefined;
  }

  // Ids recorded for OTHER tokens — the set the registry must not hand to
  // a different device. excludeId lets a device's own recorded id through
  // (it is about to be reclaimed by its owner, not handed out).
  reservedIds(excludeId = null) {
    const reserved = new Set();

    for (const seat of this.seats.values()) {
      if (seat.id !== excludeId) {
        reserved.add(seat.id);
      }
    }

    return reserved;
  }

  // Records the seat and saves. A no-op when nothing changed: the
  // protocol persists on every control (the seat shares that call site),
  // and fader traffic must not rewrite the file.
  //
  // One token per seat: recording a seat evicts any OTHER token still
  // recorded at that id (an operator seat move overrides the stale
  // record of a device that is not here to claim it).
  record(token, seat) {
    if (!validSeat(seat)) {
      return;
    }

    let evicted = false;

    for (const [other, otherSeat] of this.seats) {
      if (other !== token && otherSeat.id === seat.id) {
        this.seats.delete(other);
        evicted = true;
      }
    }

    const current = this.seats.get(token);

    if (
      !evicted &&
      current &&
      current.id === seat.id &&
      current.out === seat.out
    ) {
      return;
    }

    this.seats.set(token, { id: seat.id, out: seat.out });
    this.save();
  }

  clear() {
    if (this.seats.size === 0) {
      return;
    }

    this.seats.clear();
    this.save();
  }

  // Atomic: a crash mid-write leaves either the previous file or the
  // untouched tmp file (which the next load ignores) — never torn state.
  save() {
    const entries = {};

    for (const [token, seat] of this.seats) {
      entries[token] = seat;
    }

    const tmp = `${this.file}.tmp`;

    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(
      tmp,
      JSON.stringify({ version: 1, seats: entries }, null, 2),
    );
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { SeatsStore };
