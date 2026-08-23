// Client identity registry.
//
// Reusable PNDS core: allocates a numeric client id for every joined
// performer, lets a client recover its id after a reconnect via a claim
// token, and rejects new clients once the limit (16 by default) is reached.

const crypto = require("node:crypto");

const TOKEN_MIN_LENGTH = 24;
const TOKEN_MAX_LENGTH = 128;

function isClaimToken(value) {
  return (
    typeof value === "string" &&
    value.length >= TOKEN_MIN_LENGTH &&
    value.length <= TOKEN_MAX_LENGTH
  );
}

function generateClaimToken() {
  return crypto.randomBytes(24).toString("hex");
}

class PlayerRegistry {
  constructor({ maxClients = 16 } = {}) {
    this.maxClients = maxClients;
    this.assignments = new Map(); // id -> { socketId, claimToken }
    this.byToken = new Map(); // claimToken -> id
  }

  get size() {
    return this.assignments.size;
  }

  // Returns { status: "accepted" | "recovered" | "rejected", id?, token? }.
  // "recovered" means the client reconnected with a known claim token and
  // reclaimed its previous id. preferredId reclaims a persisted seat
  // ( SeatsStore) when that id is free; reservedIds (seats recorded for
  // OTHER tokens) are skipped when handing out a fresh id — a device's
  // seat is never given away while its record exists.
  allocate({
    socketId,
    claimToken,
    preferredId = null,
    reservedIds = null,
  }) {
    if (isClaimToken(claimToken)) {
      const existingId = this.byToken.get(claimToken);

      if (existingId !== undefined) {
        const current = this.assignments.get(existingId);

        if (current && current.socketId !== socketId) {
          // Same identity on a new socket (reconnect): take over.
          this.assignments.set(existingId, { socketId, claimToken });
          return { status: "recovered", id: existingId, token: claimToken };
        }

        return { status: "accepted", id: existingId, token: claimToken };
      }
    }

    const reserved = reservedIds instanceof Set ? reservedIds : null;
    const preferred =
      Number.isInteger(preferredId) &&
      preferredId >= 1 &&
      preferredId <= this.maxClients &&
      !this.assignments.has(preferredId)
        ? preferredId
        : null;
    const id = preferred !== null ? preferred : this.nextFreeId(reserved);

    if (id === null) {
      return {
        status: "rejected",
        message: `Server is full (max ${this.maxClients} clients).`,
      };
    }

    const token = isClaimToken(claimToken)
      ? claimToken
      : generateClaimToken();

    this.assignments.set(id, { socketId, claimToken: token });
    this.byToken.set(token, id);

    return { status: "accepted", id, token };
  }

  release(id) {
    const assignment = this.assignments.get(id);

    if (!assignment) {
      return null;
    }

    this.assignments.delete(id);
    this.byToken.delete(assignment.claimToken);

    return assignment;
  }

  // Moves a live assignment to another id (the monitor's seat
  // reassignment). False — caller no-ops — when the id is unknown, toId
  // is out of range, or toId is already live (including toId === id).
  reassign(id, toId) {
    if (
      !this.assignments.has(id) ||
      !Number.isInteger(toId) ||
      toId < 1 ||
      toId > this.maxClients ||
      this.assignments.has(toId)
    ) {
      return false;
    }

    const assignment = this.assignments.get(id);

    this.assignments.delete(id);
    this.assignments.set(toId, assignment);

    return true;
  }

  // Returns the id bound to a socket, or null.
  findIdBySocket(socketId) {
    for (const [id, assignment] of this.assignments) {
      if (assignment.socketId === socketId) {
        return id;
      }
    }

    return null;
  }

  // Returns { id, claimToken } bound to a socket, or null, and frees it.
  releaseBySocket(socketId) {
    for (const [id, assignment] of this.assignments) {
      if (assignment.socketId === socketId) {
        this.assignments.delete(id);
        this.byToken.delete(assignment.claimToken);
        return { id, claimToken: assignment.claimToken };
      }
    }

    return null;
  }

  // Returns the claim token that owns a client id, or null.
  getTokenById(id) {
    const assignment = this.assignments.get(id);

    return assignment ? assignment.claimToken : null;
  }

  // Smallest free id, skipping reserved seats (recorded for other
  // tokens). Null when every id is taken or reserved.
  nextFreeId(reserved = null) {
    for (let id = 1; id <= this.maxClients; id += 1) {
      if (!this.assignments.has(id) && !(reserved && reserved.has(id))) {
        return id;
      }
    }

    return null;
  }

  list() {
    return [...this.assignments.entries()].map(([id, assignment]) => ({
      id,
      socketId: assignment.socketId,
    }));
  }
}

module.exports = {
  PlayerRegistry,
  isClaimToken,
  generateClaimToken,
};
