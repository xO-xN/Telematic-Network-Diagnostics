// OSC UDP transport layer.
//
// Reusable PNDS core: wraps node:dgram + osc-min so the score server can
// send OSC messages to scsynth (Internal mode) or to a custom engine
// (External mode) and wait for replies.
//
// This module is framework code. It is project-agnostic and should not
// contain work-specific logic.

const dgram = require("node:dgram");
const osc = require("osc-min");

const DEFAULT_REPLY_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 5000;

function oscFloat(value) {
  return {
    type: "float",
    value: Number(value),
  };
}

function oscInteger(value) {
  return {
    type: "integer",
    value: Number(value),
  };
}

function normalizeArgument(value) {
  if (
    value &&
    typeof value === "object" &&
    typeof value.type === "string" &&
    Object.prototype.hasOwnProperty.call(value, "value")
  ) {
    return value;
  }

  if (typeof value === "number") {
    return oscFloat(value);
  }

  return value;
}

function unwrapArgument(argument) {
  if (
    argument &&
    typeof argument === "object" &&
    Object.prototype.hasOwnProperty.call(argument, "value")
  ) {
    return argument.value;
  }

  return argument;
}

function parseOscTarget(target) {
  if (target && typeof target === "object") {
    const host = String(target.host || "").trim();
    const port = Number(target.port);

    if (!host) {
      throw new Error("OSC target host cannot be empty.");
    }

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("OSC target port must be an integer from 1 to 65535.");
    }

    return { host, port };
  }

  const value = String(target || "").trim();

  if (!value) {
    throw new Error("OSC target cannot be empty.");
  }

  let host;
  let portText;

  if (value.startsWith("[")) {
    const closingBracket = value.indexOf("]");

    if (
      closingBracket < 0 ||
      value[closingBracket + 1] !== ":"
    ) {
      throw new Error(
        `Invalid OSC target '${value}'. Expected [ipv6-host]:port.`,
      );
    }

    host = value.slice(1, closingBracket);
    portText = value.slice(closingBracket + 2);
  } else {
    const separatorIndex = value.lastIndexOf(":");

    if (separatorIndex <= 0) {
      throw new Error(
        `Invalid OSC target '${value}'. Expected host:port.`,
      );
    }

    host = value.slice(0, separatorIndex);
    portText = value.slice(separatorIndex + 1);
  }

  const port = Number(portText);

  if (!host) {
    throw new Error(`Invalid OSC target '${value}': host is empty.`);
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid OSC target '${value}': port must be an integer from 1 to 65535.`,
    );
  }

  return { host, port };
}

class OscTransport {
  constructor({
    target,
    replyHost = DEFAULT_REPLY_HOST,
    replyPort = 0,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }) {
    const parsedTarget = parseOscTarget(target);

    this.target = parsedTarget;
    this.replyHost = replyHost;
    this.replyPort = Number(replyPort);
    this.timeoutMs = timeoutMs;
    this.socket = dgram.createSocket("udp4");
    this.pending = new Set();
    this.nextSyncId = 1;
    this.started = false;

    this.socket.on("message", (packet) => {
      this.handlePacket(packet);
    });

    this.socket.on("error", (error) => {
      for (const pending of this.pending) {
        pending.reject(error);
      }

      this.pending.clear();
    });
  }

  async start() {
    if (this.started) {
      return;
    }

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.socket.off("listening", onListening);
        reject(error);
      };

      const onListening = () => {
        this.socket.off("error", onError);
        this.replyPort = this.socket.address().port;
        this.started = true;
        resolve();
      };

      this.socket.once("error", onError);
      this.socket.once("listening", onListening);
      this.socket.bind(this.replyPort, this.replyHost);
    });
  }

  handlePacket(packet) {
    let message;

    try {
      message = osc.fromBuffer(packet);
    } catch (error) {
      console.error("[osc-transport] Unable to decode OSC reply:", error);
      return;
    }

    if (!message || !message.address) {
      return;
    }

    for (const pending of [...this.pending]) {
      if (!pending.predicate(message)) {
        continue;
      }

      this.pending.delete(pending);
      clearTimeout(pending.timer);
      pending.resolve(message);
      break;
    }
  }

  waitFor(predicate, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      const pending = {
        predicate,
        resolve,
        reject,
        timer: null,
      };

      pending.timer = setTimeout(() => {
        this.pending.delete(pending);
        reject(new Error("Timed out waiting for OSC reply."));
      }, timeoutMs);

      this.pending.add(pending);
    });
  }

  async send(address, ...argumentsList) {
    if (!this.started) {
      throw new Error("OSC transport has not been started.");
    }

    if (typeof address !== "string" || !address.startsWith("/")) {
      throw new Error(`Invalid OSC address: ${address}`);
    }

    const packet = osc.toBuffer({
      address,
      args: argumentsList.map(normalizeArgument),
    });

    await new Promise((resolve, reject) => {
      this.socket.send(
        packet,
        0,
        packet.length,
        this.target.port,
        this.target.host,
        (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        },
      );
    });
  }

  async request(address, argumentsList, predicate, timeoutMs) {
    const reply = this.waitFor(
      (message) =>
        message.address === "/fail" || predicate(message),
      timeoutMs,
    );

    try {
      await this.send(address, ...argumentsList);
    } catch (error) {
      await reply.catch(() => undefined);
      throw error;
    }

    const response = await reply;

    if (response.address === "/fail") {
      const command = unwrapArgument(response.args?.[0]) || address;
      const reason = unwrapArgument(response.args?.[1]) || "Unknown error.";

      throw new Error(`OSC ${command} failed: ${reason}`);
    }

    return response;
  }

  async getSynthControl(nodeId, control) {
    const id = Number(nodeId);

    return this.request(
      "/s_get",
      [oscInteger(id), control],
      (message) =>
        message.address === "/n_set" &&
        Number(unwrapArgument(message.args?.[0])) === id &&
        unwrapArgument(message.args?.[1]) === control,
    );
  }

  async status() {
    return this.request(
      "/status",
      [],
      (message) => message.address === "/status.reply",
    );
  }

  async loadSynthDef(filePath) {
    return this.request(
      "/d_load",
      [filePath],
      (message) => {
        if (message.address !== "/done") {
          return false;
        }

        return unwrapArgument(message.args?.[0]) === "/d_load";
      },
    );
  }

  async sync() {
    const syncId = this.nextSyncId;
    this.nextSyncId += 1;

    return this.request(
      "/sync",
      [oscInteger(syncId)],
      (message) => {
        if (message.address !== "/synced") {
          return false;
        }

        return Number(unwrapArgument(message.args?.[0])) === syncId;
      },
    );
  }

  async close() {
    for (const pending of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("OSC transport closed."));
    }

    this.pending.clear();

    if (!this.started) {
      return;
    }

    await new Promise((resolve) => {
      this.socket.close(() => resolve());
    });

    this.started = false;
  }
}

module.exports = {
  OscTransport,
  oscFloat,
  oscInteger,
  parseOscTarget,
  unwrapArgument,
};
