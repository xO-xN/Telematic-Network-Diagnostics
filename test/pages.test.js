// Page runtime tests: public/monitor.js and public/performer.js
// executed for real (vm + a minimal id-addressed DOM stub) — catches
// wiring bugs a syntax check cannot, like a once-guard consuming the
// env prefill before the first state broadcast arrives.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const ROOT_DIR = path.join(__dirname, "..");

// A DOM node stub: id-addressed (pages build markup via innerHTML
// strings and then getElementById — the stub mirrors that contract,
// not a tree).
function makeNode(tag) {
  const node = {
    tagName: tag,
    children: [],
    attributes: {},
    classList: {
      set: new Set(),
      add(...names) {
        for (const name of names) {
          node.classList.set.add(name);
        }
      },
      remove(...names) {
        for (const name of names) {
          node.classList.set.delete(name);
        }
      },
      contains(name) {
        return node.classList.set.has(name);
      },
    },
    style: { setProperty() {} },
    setAttribute(name, value) {
      node.attributes[name] = String(value);
    },
    append(...kids) {
      node.children.push(...kids.filter(Boolean));
    },
    addEventListener() {},
  };

  Object.defineProperty(node, "textContent", {
    get() {
      return node.children
        .map((kid) => kid.text || "")
        .join("");
    },
    set(text) {
      const value = String(text);
      node.children = value === "" ? [] : [{ text: value }];
    },
  });

  // Assigning className replaces the class set (as in the real DOM).
  Object.defineProperty(node, "className", {
    get() {
      return [...node.classList.set].join(" ");
    },
    set(value) {
      node.classList.set = new Set(
        String(value).split(/\s+/).filter(Boolean),
      );
    },
  });

  return node;
}

// Loads shared.js (+ optionally the locale bridge, the way the monitor
// page does) and the page script into a fresh sandbox. Returns the
// sandbox plus the captured socket (listeners + emitted events).
function loadPage(file, { localeSearch } = {}) {
  const ids = new Map();
  const document = {
    createElement: (tag) => makeNode(tag),
    createElementNS: (ns, tag) => makeNode(tag),
    createTextNode: (text) => ({ text: String(text) }),
    getElementById: (id) => {
      if (!ids.has(id)) {
        ids.set(id, makeNode("div"));
      }
      return ids.get(id);
    },
    documentElement: { lang: "zh-CN" },
  };

  const socket = {
    listeners: {},
    emitted: [],
    on(event, handler) {
      (this.listeners[event] = this.listeners[event] || []).push(handler);
    },
    emit(event, payload) {
      this.emitted.push([event, payload]);
    },
    close() {},
  };

  const sandbox = {
    console,
    document,
    location: { hostname: "127.0.0.1", port: "6869", search: "" },
    performance: { now: () => 0 },
    io: () => socket,
    setTimeout,
    clearTimeout,
  };
  const messageListeners = [];

  sandbox.addEventListener = (type, handler) => {
    if (type === "message") {
      messageListeners.push(handler);
    }
  };

  sandbox.storage = new Map();
  sandbox.localStorage = {
    getItem: (key) => (sandbox.storage.has(key) ? sandbox.storage.get(key) : null),
    setItem: (key, value) => sandbox.storage.set(key, String(value)),
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.__PNDS_PORTS__ = { performerPort: 6868, monitorPort: 6869 };

  const context = vm.createContext(sandbox);

  vm.runInContext(
    fs.readFileSync(path.join(PUBLIC_DIR, "shared.js"), "utf8"),
    context,
  );
  // The monitor page always loads the locale bridge before its script
  // (see public/index.html); the performer page never does.
  if (file === "monitor.js") {
    sandbox.location.search = localeSearch;
    vm.runInContext(
      fs.readFileSync(path.join(ROOT_DIR, "lib", "locale-follow.js"), "utf8"),
      context,
    );
  }
  vm.runInContext(
    fs.readFileSync(path.join(PUBLIC_DIR, file), "utf8"),
    context,
  );

  return { sandbox, socket, document, messageListeners };
}

function deliver(socket, sandbox, event, payload) {
  for (const handler of socket.listeners[event] || []) {
    handler(payload === undefined ? undefined : JSON.parse(JSON.stringify(payload)));
  }
}

// A representative connected state: own green leg, one yellow peer
// with a RED local leg, one local performer (the full flower picture).
function sampleState() {
  return {
    configured: true,
    config: { url: "http://hub", room: "default", nodeId: "site-a", tokenSet: true },
    env: { hubUrl: "", hubToken: "", hubRoom: "", nodeId: "" },
    leg: {
      connected: true,
      probing: "calm",
      status: "green",
      reason: "linkGood",
      reasonParams: [],
      local: { status: "green", p50: 1, performers: 1 },
      summary: {
        samples: 20, lost: 0, reconnects: 0, rttP50: 12.5, rttP95: 20,
        iqrMs: 1, lossRate: 0, oneWayEstimateMs: 6.3,
      },
      peers: {
        "site-b": {
          connected: true,
          probing: "burst",
          status: "yellow",
          reason: "jitterYellow",
          reasonParams: ["12.0", "10"],
          summary: {
            samples: 18, lost: 0, reconnects: 0, rttP50: 40, rttP95: 60,
            iqrMs: 12, lossRate: 0, oneWayEstimateMs: 20,
          },
          local: { status: "red", p50: 8, performers: 2 },
          agoMs: 300,
        },
      },
      events: [{ type: "connected", detail: null, at: 1, agoMs: 5000 }],
    },
    local: {
      probing: "burst",
      status: "green",
      p50: 1,
      performers: 1,
      clients: {
        "1": {
          status: "green",
          reason: "green",
          connected: true,
          lastEvent: { type: "connected", at: 1, agoMs: 4000 },
          events: [
            { type: "connected", at: 1, agoMs: 4000 },
            { type: "disconnected", at: 2, agoMs: 3000 },
            { type: "reconnected", at: 3, agoMs: 2000 },
          ],
          metrics: {
            rttP50: 1, rttP95: 2, jitterP95: 0, lastRtt: 1,
            lastProcessingMs: 1, timeouts: 0, consecutiveTimeouts: 0,
            samples: 10, acks: 10, lossRate: 0, burstTimeoutRate: 0,
          },
        },
      },
    },
    overall: {
      status: "red",
      attributionNodeId: "site-b",
      attributionLeg: "local",
      attributionSelf: false,
    },
  };
}

// ------------------------------------------------------------
// Monitor page
// ------------------------------------------------------------

test("monitor page: renders the full flower picture without throwing", () => {
  const page = loadPage("monitor.js");

  // The script's own initial render (state null) must not throw —
  // banner idle, star hint, empty local panel.
  deliver(page.socket, page.sandbox, page.sandbox.PNDS.events.state, sampleState());

  assert.equal(page.document.getElementById("f-url").value, "");
  assert.ok(
    page.document.getElementById("banner").classList.contains("st-red"),
    "banner reflects the overall verdict",
  );

  const attribution = page.document.getElementById("banner-attribution");

  assert.equal(attribution.textContent, "问题在 site-b 本地腿");

  // The local panel rendered the performer card.
  const localCards = page.document.getElementById("local-cards");

  assert.equal(localCards.children.length, 1);
  assert.ok(localCards.children[0].classList.contains("st-green"));

  // Peer cards: the performer-pair formula lit up (all four segments
  // measured: 1 + 12.5 + 40 + 8).
  const cards = page.document.getElementById("cards");

  assert.equal(cards.children.length, 2, "own card + one peer card");
});

test("monitor page: env prefill lands on the FIRST state, not the null-state load render", () => {
  const page = loadPage("monitor.js");

  // Load-time render already ran inside loadPage (state null): the
  // once-guard must NOT have been spent — the env arrives only with
  // the state broadcast.
  const state = sampleState();

  state.env = {
    hubUrl: "http://env-hub",
    hubToken: "env-token",
    hubRoom: "rehearsal",
    nodeId: "env-node",
  };

  deliver(page.socket, page.sandbox, page.sandbox.PNDS.events.state, state);

  assert.equal(page.document.getElementById("f-url").value, "http://env-hub");
  assert.equal(page.document.getElementById("f-room").value, "rehearsal");
  assert.equal(page.document.getElementById("f-node").value, "env-node");

  const auto = page.socket.emitted.filter(([event]) => event === "hub:config");

  assert.equal(auto.length, 1, "the startup config auto-submits once");
  assert.deepEqual(JSON.parse(JSON.stringify(auto[0][1])), {
    url: "http://env-hub",
    token: "env-token",
    room: "rehearsal",
    nodeId: "env-node",
  });

  // Later states (1 Hz) neither re-submit nor clobber the form.
  deliver(page.socket, page.sandbox, page.sandbox.PNDS.events.state, state);

  assert.equal(
    page.socket.emitted.filter(([event]) => event === "hub:config").length,
    1,
    "identical resubmission is suppressed",
  );
});

test("monitor page: a saved form wins over the env prefill", () => {
  const page = loadPage("monitor.js");

  page.sandbox.localStorage.setItem(
    "tnd-hub-config",
    JSON.stringify({ url: "http://saved", token: "saved-token" }),
  );

  const state = sampleState();

  state.env = { hubUrl: "http://env-hub", hubToken: "env-token", hubRoom: "", nodeId: "" };
  deliver(page.socket, page.sandbox, page.sandbox.PNDS.events.state, state);

  assert.equal(page.document.getElementById("f-url").value, "http://saved");
  assert.equal(page.document.getElementById("f-token").value, "saved-token");

  const auto = page.socket.emitted.filter(([event]) => event === "hub:config");

  assert.equal(auto.length, 1);
  assert.equal(auto[0][1].url, "http://saved");
});

// ------------------------------------------------------------
// Monitor page — locale following (the App language bridge)
// ------------------------------------------------------------

const LOCALE_MESSAGE = (locale) => ({
  data: { type: "pnds:locale", version: 1, locale },
});

test("monitor page: renders Chinese by default, before any bridge traffic", () => {
  const page = loadPage("monitor.js", { localeSearch: "" });

  deliver(page.socket, page.sandbox, page.sandbox.PNDS.events.state, sampleState());

  assert.equal(page.document.getElementById("sub-label").textContent, "监视端 — 全网视图");
  assert.equal(page.document.getElementById("form-title").textContent, "Hub 连接");
  assert.equal(page.document.getElementById("b-connect").textContent, "连接");
  assert.equal(page.document.getElementById("banner-copy").textContent, "不适宜演出");
  assert.equal(
    page.document.getElementById("banner-attribution").textContent,
    "问题在 site-b 本地腿",
  );

  // The performer card's reason line maps the wire key through the
  // Chinese table.
  const card = page.document.getElementById("local-cards").children[0];
  const reason = card.children.find((node) => node.classList.contains("reason"));

  assert.equal(reason.textContent, "本地网络良好");
});

test("monitor page: a locale message re-renders the whole console live", () => {
  const page = loadPage("monitor.js", { localeSearch: "" });

  deliver(page.socket, page.sandbox, page.sandbox.PNDS.events.state, sampleState());

  // The App switches its language to English.
  for (const handler of page.messageListeners) {
    handler(LOCALE_MESSAGE("en"));
  }

  assert.equal(page.document.getElementById("sub-label").textContent, "Monitor — flower view");
  assert.equal(page.document.getElementById("form-title").textContent, "Hub connection");
  assert.equal(page.document.getElementById("b-connect").textContent, "Connect");
  assert.equal(
    page.document.getElementById("banner-copy").textContent,
    "Not suitable for performance",
  );
  assert.equal(
    page.document.getElementById("banner-attribution").textContent,
    "Problem: site-b local leg",
  );

  const card = page.document.getElementById("local-cards").children[0];
  const head = card.children[0];

  assert.equal(head.children[1].textContent, "Performer 1 · burst");

  // A malformed message changes nothing.
  for (const handler of page.messageListeners) {
    handler({ data: { type: "other", version: 1, locale: "zh-CN" } });
    handler({ data: null });
  }

  assert.equal(page.document.getElementById("b-connect").textContent, "Connect");
  assert.equal(page.sandbox.PNDS_LOCALE.current(), "en");

  // Back to Chinese (a language switch in the other direction).
  for (const handler of page.messageListeners) {
    handler(LOCALE_MESSAGE("zh-CN"));
  }

  assert.equal(page.document.getElementById("b-connect").textContent, "连接");
});

test("monitor page: ?lang= seeds the first frame before any message", () => {
  const page = loadPage("monitor.js", { localeSearch: "?lang=en&theme=stage" });

  deliver(page.socket, page.sandbox, page.sandbox.PNDS.events.state, sampleState());

  assert.equal(page.document.getElementById("b-connect").textContent, "Connect");
  assert.equal(page.document.documentElement.lang, "en");
});

test("monitor page: a language switch never clobbers the form inputs", () => {
  const page = loadPage("monitor.js", { localeSearch: "" });
  const state = sampleState();

  state.env = {
    hubUrl: "http://env-hub",
    hubToken: "env-token",
    hubRoom: "",
    nodeId: "",
  };

  deliver(page.socket, page.sandbox, page.sandbox.PNDS.events.state, state);
  assert.equal(page.document.getElementById("f-url").value, "http://env-hub");

  // The operator edits the node name mid-session…
  page.document.getElementById("f-node").value = "my editing";

  // …a locale switch re-words the chrome but leaves the inputs alone.
  for (const handler of page.messageListeners) {
    handler(LOCALE_MESSAGE("en"));
  }

  assert.equal(page.document.getElementById("l-node").textContent, "Node name");
  assert.equal(page.document.getElementById("f-url").value, "http://env-hub");
  assert.equal(page.document.getElementById("f-node").value, "my editing");
  assert.equal(page.document.getElementById("l-url").textContent, "Hub URL");
});

// ------------------------------------------------------------
// Performer page
// ------------------------------------------------------------

test("performer page: joins with the persisted token, answers probes, paints the two dots", () => {
  const page = loadPage("performer.js");
  const events = page.sandbox.PNDS.events;

  // Connect → join with the persisted token (none yet → null).
  deliver(page.socket, page.sandbox, "connect");

  assert.equal(
    JSON.stringify(
      page.socket.emitted.find(([event]) => event === events.join)[1],
    ),
    JSON.stringify({ token: null }),
  );

  // The server hands back an id + token; the page persists it.
  deliver(page.socket, page.sandbox, events.joined, { id: 3, token: "t".repeat(48), recovered: false });

  assert.equal(
    page.sandbox.localStorage.getItem("tnd-performer-token"),
    "t".repeat(48),
  );

  // A probe is answered immediately with its seq.
  deliver(page.socket, page.sandbox, events.probe, { seq: 7 });

  const ack = page.socket.emitted.find(([event]) => event === events.ack);

  assert.equal(ack[1].seq, 7);
  assert.equal(typeof ack[1].t0, "number");

  // The two dots read the state: local green, hub yellow.
  deliver(page.socket, page.sandbox, events.state, sampleState());

  assert.ok(page.document.getElementById("row-local").classList.contains("st-green"));
  assert.ok(page.document.getElementById("row-hub").classList.contains("st-green"));

  assert.equal(page.document.getElementById("w-local").textContent, "GREEN");

  // No hub configured → the hub dot falls back to idle-gray, the
  // local dot keeps its color.
  const noHub = sampleState();

  noHub.leg = null;
  deliver(page.socket, page.sandbox, events.state, noHub);

  assert.ok(page.document.getElementById("row-hub").classList.contains("st-idle"));
  assert.ok(page.document.getElementById("row-local").classList.contains("st-green"));

  // A reconnect re-joins with the persisted token.
  deliver(page.socket, page.sandbox, "connect");

  assert.equal(
    JSON.stringify(
      page.socket.emitted.filter(([event]) => event === events.join).pop()[1],
    ),
    JSON.stringify({ token: "t".repeat(48) }),
  );
});
