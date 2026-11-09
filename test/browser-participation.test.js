const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { JSDOM, VirtualConsole } = require("jsdom");
const { stopProcess } = require("./helpers");
const ROOT = path.join(__dirname, "..");

async function runtime(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tnd-assigned-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const listeners = [];
  for (let index = 0; index < 2; index++) {
    const listener = net.createServer();
    await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
    listeners.push(listener);
  }
  const services = listeners.map((listener, index) => ({ role: index ? "monitor" : "performer", fd: 3 + index, port: listener.address().port }));
  const reportPath = path.join(directory, "bound.json");
  const env = { ...process.env, PNDS_HUB_URL: "", PNDS_HUB_TOKEN: "", PNDS_RUNTIME_PORTS: JSON.stringify({ version: 1, runId: "tool-310-assigned", reportPath, services }) };
  delete env.PNDS_SHARED_LIBRARIES;
  const child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe", ...listeners.map(listener => listener._handle.fd)] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  t.after(() => stopProcess(child));
  await Promise.all(listeners.map(listener => new Promise(resolve => listener.close(resolve))));
  const performer = `http://127.0.0.1:${services[0].port}`;
  const monitor = `http://127.0.0.1:${services[1].port}`;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error(output);
    if (fs.existsSync(reportPath)) return { performer, monitor, services, report: JSON.parse(fs.readFileSync(reportPath)), child };
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`runtime failed to publish listener ownership: ${output}`);
}

test("adopts App-held listener descriptors, reports real ports and keeps internet-only observer state", async t => {
  const server = await runtime(t);
  assert.deepEqual(server.report, { version: 1, runId: "tool-310-assigned", status: "bound", services: server.services.map(({ role, port }) => ({ role, port })) });
  for (const origin of [server.performer, server.monitor]) {
    const health = await (await fetch(`${origin}/__pnds/health`)).json();
    assert.equal(health.status, "ready");
    assert.equal(health.audio.status, "disabled");
    assert.deepEqual(health.scoreServer, { performerPort: server.services[0].port, monitorPort: server.services[1].port, runtimeRunId: "tool-310-assigned" });
    assert.equal((await fetch(`${origin}/__pnds/context.js`)).status, 200, "direct standalone addresses retain an empty context shim");
  }
});

test("confirmed page loads real local assets and polling under its prefix, scopes saved config, and reports page preparation", async t => {
  const server = await runtime(t);
  const prefix = "/__pnds/run/confirmed-310/";
  const requests = [];
  const proxy = http.createServer((request, response) => {
    requests.push(request.url);
    if (!request.url.startsWith(prefix)) { response.writeHead(410).end(); return; }
    const target = request.url.slice(prefix.length);
    if (target.split("?")[0] === "__pnds/context.js") {
      response.setHeader("Content-Type", "application/javascript");
      response.end(`globalThis.PNDS_PARTICIPATION={socketOptions:{path:${JSON.stringify(prefix + "socket.io/")}},storageKey:key=>'pnds:host-310:telematic-network-diagnostics:'+key,reportPrepared(){globalThis.prepared310=true}};`);
      return;
    }
    const upstream = http.request(server.performer + "/" + target, { method: request.method, headers: { ...request.headers, host: new URL(server.performer).host } }, incoming => { response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response); });
    upstream.on("error", () => response.writeHead(502).end());
    request.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => { proxy.closeAllConnections(); return new Promise(resolve => proxy.close(resolve)); });
  const errors = [], console = new VirtualConsole();
  console.on("jsdomError", error => errors.push(error.message));
  const browser = await JSDOM.fromURL(`http://127.0.0.1:${proxy.address().port}${prefix}?locale=en&theme=sand`, {
    runScripts: "dangerously", resources: "usable", pretendToBeVisual: true, virtualConsole: console,
    beforeParse(window) {
      window.ResizeObserver = class { observe() {} };
      window.localStorage.setItem("tnd-hub-config", JSON.stringify({ url: "https://foreign.invalid", token: "foreign", nodeId: "foreign" }));
      window.localStorage.setItem("pnds:host-310:telematic-network-diagnostics:tnd-hub-config", JSON.stringify({ nodeId: "saved-correct-node" }));
    },
  });
  t.after(() => browser.window.close());
  for (let attempt = 0; attempt < 150 && !browser.window.prepared310; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(errors, []);
  assert.equal(browser.window.prepared310, true, "real diagnostic snapshot prepares the page without a WAN connection");
  assert.equal(browser.window.document.getElementById("f-node").value, "saved-correct-node");
  assert.equal(browser.window.document.getElementById("f-url").value, "");
  assert.ok(requests.some(url => url.includes("socket.io/?EIO=4&transport=polling")));
  assert.ok(requests.some(url => url.startsWith(prefix + "__pnds/shared/socket.io.js")));
  assert.ok(requests.some(url => url.startsWith(prefix + "land.js")));
  assert.ok(requests.every(url => url.startsWith(prefix)), JSON.stringify(requests));
});
