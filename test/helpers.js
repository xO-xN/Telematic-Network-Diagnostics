// Shared helpers for the subprocess-driving tests (hub + integration):
// free ports, spawning the hub, waiting for its port, graceful stops.

const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

const PROJECT_ROOT = path.join(__dirname, "..");

// Resolves with the first port the OS hands out.
function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();

    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();

      probe.close(() => resolve(port));
    });
  });
}

// Resolves when the port accepts a TCP connection (the hub listens
// before any client can handshake).
function waitForPort(port, attempts = 50) {
  return new Promise((resolve, reject) => {
    const tick = (left) => {
      const socket = net.connect({ port, host: "127.0.0.1" });

      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();

        if (left <= 1) {
          reject(new Error("port never opened"));
          return;
        }

        setTimeout(() => tick(left - 1), 100);
      });
    };

    tick(attempts);
  });
}

// Spawns a hub subprocess with the given env on top of a clean copy of
// process.env (PATH etc. must survive for node itself). `stdio` pipes
// when the test needs the hub's stderr (the fail-fast test).
function spawnHub(port, { token, stdio = "ignore", extraEnv = {} } = {}) {
  const env = { ...process.env, HUB_PORT: String(port) };

  if (token !== undefined) {
    env.HUB_TOKEN = token;
  }

  // extraEnv wins over the token (the fail-fast test blanks HUB_TOKEN).
  Object.assign(env, extraEnv);

  return spawn(process.execPath, ["hub/hub.js"], {
    cwd: PROJECT_ROOT,
    stdio,
    env,
  });
}

// Kills a subprocess and waits for the exit so the next test can reuse
// the pattern. Graceful SIGTERM first, SIGKILL as a backstop.
function stopProcess(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    const force = setTimeout(() => child.kill("SIGKILL"), 3000);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

module.exports = {
  findFreePort,
  waitForPort,
  spawnHub,
  stopProcess,
};
