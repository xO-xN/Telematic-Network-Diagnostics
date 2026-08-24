// Performer identity registry (issue #5, ported from the sibling repo
// Local-Network-Diagnostics — the local leg's proven core).
//
// Allocates a numeric client id for every joined performer, recovers
// the id after a reconnect via a claim token, and rejects new clients
// once the limit (16 by default) is reached.

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

  isFull() {
    return this.assignments.size >= this.maxClients;
  }

  // Returns { status: "accepted" | "recovered" | "rejected", id?, token? }.
  // "recovered" means the client reconnected with a known claim token and
  // reclaimed its previous id.
  allocate({ socketId, claimToken }) {
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

    if (this.isFull()) {
      return {
        status: "rejected",
        message: `Server is full (max ${this.maxClients} clients).`,
      };
    }

    const id = this.nextFreeId();
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

  nextFreeId() {
    for (let id = 1; id <= this.maxClients; id += 1) {
      if (!this.assignments.has(id)) {
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
