// Telematic Network Diagnostics — hub (v0.1).
//
// The center of the star: a Socket.IO relay on a public VPS that the
// score servers of every site connect to (hub/star topology). Node +
// socket.io only, no browser interface, no persistence.
//
// Wire contract (frozen here; the tool-side client lands with issue #3):
//   - connect with Socket.IO handshake auth { token, room?, node? }
//   - token must equal the hub's HUB_TOKEN env; a wrong token refuses
//     the connection (client sees connect_error "invalid hub token")
//   - room is optional and defaults to "default"; messages relay only
//     within one room
//   - node is an optional display name relayed back as `from`
//   - on a successful join the client receives "welcome"
//     { room, node, hubTime } — the room it actually landed in
//   - a client emitting "relay" with any JSON body gets that body
//     relayed to every OTHER client in the same room, stamped with
//     { from, hubReceivedAt } — the hub's receive timestamp
//   - a client emitting "echo" with any JSON body gets the same body
//     straight back, stamped the same way — the hub-leg RTT
//     measurement (issue #3): the sender clocks the round trip, the
//     hub adds nothing but the stamp
//
// Environment:
//   HUB_TOKEN  required — shared secret (generate: openssl rand -hex 24)
//   HUB_PORT   optional — listen port (default 4000)
//   HUB_HOST   optional — bind address (default 0.0.0.0; bind
//              127.0.0.1 when a TLS reverse proxy fronts the hub)
//
// Deployment: docs/hub-deployment.md (systemd unit: hub/tnd-hub.service).

const crypto = require("node:crypto");
const http = require("node:http");
const { Server } = require("socket.io");

const HUB_VERSION = "0.1.0";
const DEFAULT_PORT = 4000;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_ROOM = "default";
const MAX_ROOM_LENGTH = 128;
const MAX_NODE_LENGTH = 64;

// Handshake name sanitizing: anything that is not a non-blank string is
// rejected (null) so the caller can apply its fallback.
function sanitizeName(value, maxLength) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  if (trimmed === "") {
    return null;
  }

  return trimmed.slice(0, maxLength);
}

// Constant-time token comparison: hash both sides so unequal lengths
// can't leak through timingSafeEqual's equal-length precondition, and
// the comparison time never depends on where the strings differ.
function tokenMatches(received, expected) {
  const a = crypto
    .createHash("sha256")
    .update(String(received), "utf8")
    .digest();
  const b = crypto
    .createHash("sha256")
    .update(String(expected), "utf8")
    .digest();

  return crypto.timingSafeEqual(a, b);
}

// The stamped body every outbound seam (relay, echo) sends: the
// client's JSON body (objects pass through opaquely, anything else is
// wrapped) plus the hub's own { from, hubReceivedAt }. Sender-supplied
// values of the two stamp keys are always overwritten — the hub is the
// authority on both.
function stampedBody(payload, node) {
  const body =
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload)
      ? { ...payload }
      : { value: payload };

  body.from = node;
  body.hubReceivedAt = Date.now();

  return body;
}

// Wires the hub behavior onto a Socket.IO server. Token comes from the
// environment at call time so tests (and operators) can set it before
// the handshake arrives.
function attachHub(io) {
  io.use((socket, next) => {
    const auth = socket.handshake.auth || {};

    if (!tokenMatches(auth.token, process.env.HUB_TOKEN)) {
      next(new Error("invalid hub token"));
      return;
    }

    socket.data.room =
      sanitizeName(auth.room, MAX_ROOM_LENGTH) || DEFAULT_ROOM;
    socket.data.node =
      sanitizeName(auth.node, MAX_NODE_LENGTH) || socket.id;
    next();
  });

  io.on("connection", (socket) => {
    const { room, node } = socket.data;

    socket.join(room);
    console.log(`[hub] node "${node}" joined room "${room}"`);

    socket.emit("welcome", { room, node, hubTime: Date.now() });

    // The one relay seam: any JSON body in, the same body out to every
    // OTHER client in the room, stamped with the hub receive time. The
    // body stays opaque here — its vocabulary belongs to the tool's
    // clients (rolling stats, probes, …), not to the hub.
    socket.on("relay", (payload) => {
      socket.to(room).emit("relay", stampedBody(payload, node));
    });

    // The echo seam: any JSON body in, the same body straight back to
    // the SENDER, stamped with the hub receive time. RTT belongs to the
    // sender's clock; the hub never interprets the body (issue #3's
    // baseline/burst probes send { seq, sentAt }).
    socket.on("echo", (payload) => {
      socket.emit(
        "echo",
        stampedBody(payload, node),
      );
    });

    socket.on("disconnect", (reason) => {
      console.log(`[hub] node "${node}" left room "${room}" (${reason})`);
    });
  });
}

function main() {
  const token = process.env.HUB_TOKEN;

  if (!token || String(token).trim() === "") {
    console.error("[hub] HUB_TOKEN is not set — refusing to start.");
    console.error("[hub] generate one with: openssl rand -hex 24");
    process.exit(1);
  }

  const port = Number(process.env.HUB_PORT) || DEFAULT_PORT;
  const host = process.env.HUB_HOST || DEFAULT_HOST;

  const httpServer = http.createServer((request, response) => {
    // No browser interface — but a plain GET deserves a plain answer
    // instead of a hang, for anyone probing the port.
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("Telematic Network Diagnostics hub\n");
  });
  const io = new Server(httpServer);

  attachHub(io);

  httpServer.on("error", (error) => {
    console.error(`[hub] failed to listen on ${host}:${port}:`, error);
    process.exit(1);
  });

  httpServer.listen(port, host, () => {
    console.log(
      `[hub] Telematic Network Diagnostics hub v${HUB_VERSION} listening on ${host}:${port}`,
    );
  });

  // systemd stops the service with SIGTERM; close the relay gracefully
  // so connected sites see a clean disconnect, with a backstop so a
  // stuck client can never wedge the stop.
  const shutdown = (signal) => {
    console.log(`[hub] ${signal} received, closing...`);
    io.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (require.main === module) {
  main();
}

module.exports = {
  attachHub,
  sanitizeName,
  tokenMatches,
  DEFAULT_ROOM,
};
