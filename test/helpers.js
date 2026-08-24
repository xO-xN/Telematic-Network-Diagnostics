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

// Fails immediately with a clear message when a port is already being
// served — typically this same project opened in PNDS App while the
// tests run. Without the guard, the spawned server cannot bind and the
// test times out polling a FOREIGN server, which is far more confusing.
async function assertPortsFree(ports) {
  for (const port of ports) {
    const busy = await new Promise((resolve) => {
      const probe = net.connect({ port, host: "127.0.0.1" });

      probe.once("connect", () => {
        probe.destroy();
        resolve(true);
      });
      probe.once("error", () => {
        probe.destroy();
        resolve(false);
      });
    });

    if (busy) {
      throw new Error(
        `port ${port} is already in use — another instance of this project ` +
          `is being served (PNDS App, or a stray server). Stop it before ` +
          `running the integration tests.`,
      );
    }
  }
}

module.exports = {
  findFreePort,
  waitForPort,
  spawnHub,
  stopProcess,
  assertPortsFree,
};
