// Score-server smoke test (issue #2): the de-templatized server comes
// up as Telematic Network Diagnostics — health ready with audio
// disabled, both pages served, the theme bridge and QR on the monitor
// port only.

const assert = require("node:assert/strict");
const test = require("node:test");
const { spawn } = require("node:child_process");
const path = require("node:path");

const PROJECT_ROOT = path.join(__dirname, "..");
const PERFORMER_URL = "http://127.0.0.1:6868";
const MONITOR_URL = "http://127.0.0.1:6869";
const HEALTH_URL = `${PERFORMER_URL}/__pnds/health`;

function waitForHealthReady() {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    const tick = async () => {
      attempts += 1;

      try {
        const response = await fetch(HEALTH_URL);
        const payload = await response.json();

        if (payload.status === "ready") {
          resolve(payload);
          return;
        }
      } catch {
        // server not up yet
      }

      if (attempts >= 40) {
        reject(new Error("server never reported health ready"));
        return;
      }

      setTimeout(tick, 250);
    };

    tick();
  });
}

// Kills the spawned server and waits for the process to actually exit,
// so the next test can bind the same ports. Graceful SIGTERM first
// (exercises the shutdown path), SIGKILL as a backstop.
function stopServer(server) {
  return new Promise((resolve) => {
    if (server.exitCode !== null || server.signalCode !== null) {
      resolve();
      return;
    }

    const force = setTimeout(() => server.kill("SIGKILL"), 3000);
    server.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    server.kill("SIGTERM");
  });
}

test("score server: TND identity, health ready, pages + theme bridge served", async (t) => {
  const server = spawn(process.execPath, ["server.js", "--audio-mode", "none"], {
    cwd: PROJECT_ROOT,
    stdio: "ignore",
  });

  t.after(async () => stopServer(server));

  // --- health: ready, none-only audio, TND identity, 6868/6869 ---
  const health = await waitForHealthReady();

  assert.equal(health.projectId, "telematic-network-diagnostics");
  assert.equal(health.audioMode, "none");
  assert.equal(health.audio.status, "disabled", "no-audio project reports disabled");
  assert.equal(health.audio.target, null);
  assert.equal(health.scoreServer.performerPort, 6868);
  assert.equal(health.scoreServer.monitorPort, 6869);

  // --- pages served on both ports, carrying the TND identity ---
  const performerHtml = await (await fetch(`${PERFORMER_URL}/`)).text();
  const monitorHtml = await (await fetch(`${MONITOR_URL}/`)).text();

  assert.match(performerHtml, /Telematic Network Diagnostics/);
  assert.match(monitorHtml, /Telematic Network Diagnostics/);
  assert.match(performerHtml, /Performer/);
  // Both ports serve the same dual-role page; the theme bridge is wired
  // in its monitor branch, and the route itself is monitor-port only
  // (404 on the performer port — asserted below).

  // --- the theme bridge itself is served (monitor port only) ---
  const themeResponse = await fetch(`${MONITOR_URL}/__pnds/theme-follow.js`);
  const themeJs = await themeResponse.text();

  assert.equal(themeResponse.status, 200);
  assert.match(themeJs, /PNDS_THEME/);

  const performerThemeResponse = await fetch(
    `${PERFORMER_URL}/__pnds/theme-follow.js`,
  );
  assert.equal(performerThemeResponse.status, 404);

  // --- the QR endpoint answers on the monitor port (performer: 404) ---
  const qrResponse = await fetch(`${MONITOR_URL}/qr`);

  assert.equal(qrResponse.status, 200);
  assert.equal(qrResponse.headers.get("content-type"), "image/png");

  const performerQrResponse = await fetch(`${PERFORMER_URL}/qr`);
  assert.equal(performerQrResponse.status, 404);
});
