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
    listeners: {},
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
    addEventListener(type, handler) {
      (node.listeners[type] = node.listeners[type] || []).push(handler);
    },
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

// Fires every listener a stubbed node registered for an event type —
// the page code's own click handlers, invoked directly.
function click(node) {
  for (const handler of node.listeners.click || []) {
    handler();
  }
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
    opens: 0,
    closes: 0,
    on(event, handler) {
      (this.listeners[event] = this.listeners[event] || []).push(handler);
    },
    emit(event, payload) {
      this.emitted.push([event, payload]);
    },
    open() {
      this.opens += 1;
    },
    close() {
      this.closes += 1;
    },
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
    activeConfig: {
      url: "http://hub",
      token: "hub-token",
      room: "default",
      nodeId: "site-a",
    },
    env: { hubUrl: "", hubToken: "", hubRoom: "", nodeId: "" },
    leg: {
      connected: true,
      everConnected: true,
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

test("monitor page: no burst marker anywhere — the phase is an internal detail (issue #11)", () => {
  const page = loadPage("monitor.js");
  const state = sampleState();

  // Mid-burst on the hub leg: the last place a marker used to render
  // (the own hub card's head) must stay name-only.
  state.leg.probing = "burst";
  deliver(page.socket, page.sandbox, page.sandbox.PNDS.events.state, state);

  const card = page.document.getElementById("cards").children[0];
  const head = card.children[0];

  assert.equal(head.children[1].textContent, "site-a");

  // The copy keys are gone from both tables — nothing left to render
  // a marker with (the shape test in locale-follow.test.js pins the
  // two tables to the same key set).
  assert.equal(page.sandbox.PNDS.copy["zh-CN"].monitor.burst, undefined);
  assert.equal(page.sandbox.PNDS.copy.en.monitor.burst, undefined);
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
// Monitor page — connect button state machine (issue #12)
// ------------------------------------------------------------

test("monitor page: connect button walks the four states from server truth", () => {
  const page = loadPage("monitor.js");
  const events = page.sandbox.PNDS.events;
  const button = page.document.getElementById("b-connect");
  const setForm = (url, token, room, node) => {
    page.document.getElementById("f-url").value = url;
    page.document.getElementById("f-token").value = token;
    page.document.getElementById("f-room").value = room;
    page.document.getElementById("f-node").value = node;
  };

  // Before any state: nothing configured → 连接, clickable.
  assert.equal(button.textContent, "连接");
  assert.equal(button.disabled, false);

  // Submitted → first connect still pending → 连接中…, disabled. The
  // flag is leg.everConnected on the wire — not page memory.
  const pending = sampleState();

  pending.leg.connected = false;
  pending.leg.everConnected = false;
  deliver(page.socket, page.sandbox, events.state, pending);

  assert.equal(button.textContent, "连接中…");
  assert.equal(button.disabled, true);

  // Connected but the form (still empty) ≠ activeConfig → 重新连接.
  deliver(page.socket, page.sandbox, events.state, sampleState());

  assert.equal(button.textContent, "重新连接");
  assert.equal(button.disabled, false);

  // The form is edited to MATCH the live config → 已连接, disabled.
  // The empty room counts clean against the server's "default".
  setForm("http://hub", "hub-token", "", "site-a");
  deliver(page.socket, page.sandbox, events.state, sampleState());

  assert.equal(button.textContent, "已连接");
  assert.equal(button.disabled, true);

  // One field drifts → 重新连接 again (exact compare: one character
  // of node name is a different config).
  setForm("http://hub", "hub-token", "", "site-B");
  deliver(page.socket, page.sandbox, events.state, sampleState());

  assert.equal(button.textContent, "重新连接");
  assert.equal(button.disabled, false);

  // The transport DROPS after having been connected → 连接, clickable.
  const dropped = sampleState();

  dropped.leg.connected = false;
  deliver(page.socket, page.sandbox, events.state, dropped);

  assert.equal(button.textContent, "连接");
  assert.equal(button.disabled, false);
});

test("monitor page: a red metric never un-words 已连接 — transport ≠ health", () => {
  const page = loadPage("monitor.js");
  const events = page.sandbox.PNDS.events;
  const button = page.document.getElementById("b-connect");

  // The env scenario: the env values prefill the form AND are what the
  // server reports live (room left empty — the server's "default"
  // counts clean). Same shape as a page refresh or another device:
  // state alone decides, nothing was ever clicked.
  const state = sampleState();

  state.env = {
    hubUrl: "http://hub",
    hubToken: "hub-token",
    hubRoom: "",
    nodeId: "site-a",
  };
  state.leg.status = "red";
  state.leg.reason = "jitterRed";
  deliver(page.socket, page.sandbox, events.state, state);

  assert.equal(button.textContent, "已连接");
  assert.equal(button.disabled, true);
  assert.equal(
    page.socket.emitted.filter(([event]) => event === "hub:config").length,
    1,
    "the env config auto-submitted once",
  );

  // The English table words the same states.
  for (const handler of page.messageListeners) {
    handler(LOCALE_MESSAGE("en"));
  }

  assert.equal(button.textContent, "Connected");
  assert.equal(button.disabled, true);
});

test("monitor page: no hub configured — the button stays 连接 with no active config", () => {
  const page = loadPage("monitor.js");
  const events = page.sandbox.PNDS.events;
  const button = page.document.getElementById("b-connect");

  const idle = sampleState();

  idle.configured = false;
  idle.activeConfig = null;
  idle.leg = null;
  idle.overall = null;
  deliver(page.socket, page.sandbox, events.state, idle);

  assert.equal(button.textContent, "连接");
  assert.equal(button.disabled, false);
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
  assert.equal(page.document.getElementById("b-connect").textContent, "重新连接");
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
  assert.equal(page.document.getElementById("b-connect").textContent, "Reconnect");
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

  // The performer card's title carries no burst/calm marker: the numbers
  // are load-scoped (steady), so the phase marker would only flicker.
  assert.equal(head.children[1].textContent, "Performer 1");

  // A malformed message changes nothing.
  for (const handler of page.messageListeners) {
    handler({ data: { type: "other", version: 1, locale: "zh-CN" } });
    handler({ data: null });
  }

  assert.equal(page.document.getElementById("b-connect").textContent, "Reconnect");
  assert.equal(page.sandbox.PNDS_LOCALE.current(), "en");

  // Back to Chinese (a language switch in the other direction).
  for (const handler of page.messageListeners) {
    handler(LOCALE_MESSAGE("zh-CN"));
  }

  assert.equal(page.document.getElementById("b-connect").textContent, "重新连接");
});

test("monitor page: ?lang= seeds the first frame before any message", () => {
  const page = loadPage("monitor.js", { localeSearch: "?lang=en&theme=stage" });

  deliver(page.socket, page.sandbox, page.sandbox.PNDS.events.state, sampleState());

  assert.equal(page.document.getElementById("b-connect").textContent, "Reconnect");
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
  assert.equal(
    page.document.getElementById("f-node").attributes.placeholder,
    "site name",
    "the node placeholder follows the locale too",
  );
  assert.equal(page.document.getElementById("f-url").value, "http://env-hub");
  assert.equal(page.document.getElementById("f-node").value, "my editing");
  assert.equal(page.document.getElementById("l-url").textContent, "Hub URL");
});

// ------------------------------------------------------------
// Performer page
// ------------------------------------------------------------

test("performer page: joins with the persisted token, answers probes, paints the dots", () => {
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

  // The site dots read the state: local green, hub green. This device's
  // own dot stays gray — client 3 has no card in the sample state.
  deliver(page.socket, page.sandbox, events.state, sampleState());

  assert.ok(page.document.getElementById("row-local").classList.contains("st-green"));
  assert.ok(page.document.getElementById("row-hub").classList.contains("st-green"));
  assert.ok(page.document.getElementById("row-self").classList.contains("st-gray"));
  assert.equal(page.document.getElementById("w-self").textContent, "GRAY");

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

test("performer page: the own dot mirrors THIS device's local-leg card, live", () => {
  const page = loadPage("performer.js");
  const events = page.sandbox.PNDS.events;

  deliver(page.socket, page.sandbox, events.joined, { id: 3, token: "t".repeat(48), recovered: false });

  const withSelf = (status) => {
    const state = sampleState();

    state.local.clients["3"] = {
      ...state.local.clients["1"],
      status,
    };
    deliver(page.socket, page.sandbox, events.state, state);
  };

  // Every server verdict lands on the own dot as it is measured.
  for (const status of ["gray", "green", "yellow", "red", "green"]) {
    withSelf(status);

    assert.ok(
      page.document.getElementById("row-self").classList.contains("st-" + status),
      status + " paints the own dot",
    );
    assert.equal(page.document.getElementById("w-self").textContent, status.toUpperCase());
  }

  // Another performer's verdict is not ours: client 1 red (the site
  // summary follows the worst), ours green.
  const foreign = sampleState();

  foreign.local.clients["1"].status = "red";
  foreign.local.status = "red";
  foreign.local.clients["3"] = { ...foreign.local.clients["1"], status: "green" };
  deliver(page.socket, page.sandbox, events.state, foreign);

  assert.ok(page.document.getElementById("row-self").classList.contains("st-green"));
  assert.ok(page.document.getElementById("row-local").classList.contains("st-red"), "the site row still reads the site worst");

  // A disconnect clears the identity: the own dot goes gray and a late
  // state broadcast must not repaint it.
  deliver(page.socket, page.sandbox, "disconnect");

  withSelf("red");
  assert.ok(page.document.getElementById("row-self").classList.contains("st-gray"));
  assert.equal(page.document.getElementById("w-self").textContent, "GRAY");
});

// ------------------------------------------------------------
// Performer page — voluntary exit (issue #10)
// ------------------------------------------------------------

test("performer page: leave button exits — leave emitted, socket closed, cover shown, dots gone", () => {
  const page = loadPage("performer.js");
  const events = page.sandbox.PNDS.events;

  deliver(page.socket, page.sandbox, "connect");
  deliver(page.socket, page.sandbox, events.joined, {
    id: 1,
    token: "t".repeat(48),
    recovered: false,
  });

  // Paint the dots once (client 1 is green in the sample state).
  deliver(page.socket, page.sandbox, events.state, sampleState());
  assert.ok(page.document.getElementById("row-self").classList.contains("st-green"));

  const cover = page.document.getElementById("left-cover");
  const perf = page.document.getElementById("perf");
  const leaveButton = page.document.getElementById("b-leave");

  assert.ok(cover.classList.contains("hidden"), "the cover starts hidden");

  click(leaveButton);

  assert.ok(
    page.socket.emitted.some(([event]) => event === events.leave),
    "the leave packet is emitted",
  );
  assert.equal(page.socket.closes, 0, "the page does not close in the same tick (flush race)");
  assert.ok(!cover.classList.contains("hidden"), "the left cover shows");
  assert.equal(
    page.document.getElementById("left-title").textContent,
    "已退出检测 · Left testing",
    "the VOLUNTARY exit wording (the monitor-removed variant differs)",
  );
  assert.ok(perf.classList.contains("hidden"), "the dots are gone");
  assert.ok(leaveButton.classList.contains("hidden"), "the leave button is gone too");

  // The server processed the leave and kicked the socket — the page
  // closes for good (no auto-reconnect).
  deliver(page.socket, page.sandbox, "disconnect");

  assert.equal(page.socket.closes, 1);

  // A state broadcast arriving while exited repaints nothing: the late
  // broadcast says red, the (hidden) dots keep their last paint.
  const turnedRed = sampleState();

  turnedRed.local.clients["1"].status = "red";
  deliver(page.socket, page.sandbox, events.state, turnedRed);
  assert.ok(
    page.document.getElementById("row-self").classList.contains("st-green"),
    "no repaint while exited",
  );

  // The exit stays in memory only: localStorage carries the token and
  // nothing else — a killed page reopening rejoins normally.
  assert.deepEqual([...page.sandbox.storage.keys()], ["tnd-performer-token"]);
});

test("performer page: exited state does not auto-rejoin; the cover tap rejoins with the same token", () => {
  const page = loadPage("performer.js");
  const events = page.sandbox.PNDS.events;

  deliver(page.socket, page.sandbox, "connect");
  deliver(page.socket, page.sandbox, events.joined, {
    id: 1,
    token: "t".repeat(48),
    recovered: false,
  });

  click(page.document.getElementById("b-leave"));

  // The server's kick arrives (its processing of the leave): the page
  // closes for good.
  deliver(page.socket, page.sandbox, "disconnect");
  assert.equal(page.socket.closes, 1);

  // A stray connect while exited (lock/unlock, a socket.io leftover)
  // must NOT re-join.
  deliver(page.socket, page.sandbox, "connect");

  assert.equal(
    page.socket.emitted.filter(([event]) => event === events.join).length,
    1,
    "no join while exited",
  );

  // The whole cover is the rejoin button.
  click(page.document.getElementById("left-cover"));

  assert.equal(page.socket.opens, 1, "the socket is reopened");
  assert.ok(page.document.getElementById("left-cover").classList.contains("hidden"));
  assert.ok(!page.document.getElementById("perf").classList.contains("hidden"));

  deliver(page.socket, page.sandbox, "connect");

  const joins = page.socket.emitted.filter(([event]) => event === events.join);

  assert.equal(joins.length, 2);
  assert.equal(
    joins[1][1].token,
    "t".repeat(48),
    "rejoins with the SAME persisted token (the server hands out a new id)",
  );

  // The fresh identity renders as a new client.
  deliver(page.socket, page.sandbox, events.joined, {
    id: 2,
    token: "t".repeat(48),
    recovered: false,
  });
  assert.match(page.document.getElementById("p-meta").textContent, /Client 2/);
});

test("performer page: the leave button ignores a second tap once exited", () => {
  const page = loadPage("performer.js");
  const events = page.sandbox.PNDS.events;

  deliver(page.socket, page.sandbox, events.joined, {
    id: 1,
    token: "t".repeat(48),
    recovered: false,
  });

  click(page.document.getElementById("b-leave"));
  click(page.document.getElementById("b-leave"));

  assert.equal(
    page.socket.emitted.filter(([event]) => event === events.leave).length,
    1,
  );
  assert.equal(page.socket.closes, 0, "nothing closed — no disconnect has arrived");
});

// ------------------------------------------------------------
// Monitor page — the site-level local event line (issue #10)
// ------------------------------------------------------------

test("monitor page: the local panel logs both deletions (exit, removal) under the cards", () => {
  const page = loadPage("monitor.js");

  const state = sampleState();

  state.local.events = [
    { type: "left", client: 2, at: 1, agoMs: 3000 },
    { type: "removed", client: 3, at: 2, agoMs: 2000 },
  ];
  deliver(page.socket, page.sandbox, page.sandbox.PNDS.events.state, state);

  const localCards = page.document.getElementById("local-cards");
  const line = localCards.children[localCards.children.length - 1];

  assert.ok(line.classList.contains("site-events"));
  assert.equal(
    line.textContent,
    "client 3 移除（monitor） 2 秒前 · client 2 退出（performer） 3 秒前",
  );

  // English table: same wire events, reworded live. The re-render
  // rebuilds the line — grab it fresh.
  for (const handler of page.messageListeners) {
    handler(LOCALE_MESSAGE("en"));
  }

  const lineEn = localCards.children[localCards.children.length - 1];

  assert.equal(
    lineEn.textContent,
    "client 3 removed 2s ago · client 2 left 3s ago",
  );
});

// ------------------------------------------------------------
// Monitor page — performer removal「x」(issue #13)
// ------------------------------------------------------------

test("monitor page: every performer card carries an「x」— click emits remove with the id", () => {
  const page = loadPage("monitor.js");
  const events = page.sandbox.PNDS.events;

  // One ONLINE card (client 1) and one DISCONNECTED card (client 2):
  // the「x」belongs on both — a dead card is removable too.
  const state = sampleState();

  state.local.clients["2"] = {
    ...state.local.clients["1"],
    connected: false,
    status: "red",
  };
  deliver(page.socket, page.sandbox, events.state, state);

  const localCards = page.document.getElementById("local-cards");

  assert.equal(localCards.children.length, 2);

  for (const card of localCards.children) {
    const head = card.children[0];
    const x = head.children[head.children.length - 1];

    assert.equal(x.tagName, "button", "the corner control is a button");
    assert.equal(x.textContent, "✕", "icon-only — the word lives in the aria-label");
    assert.equal(x.attributes["aria-label"], "移除");
  }

  // Single tap, no confirmation: both cards' x send the remove command
  // straight to the server, keyed by the numeric id. (JSON compare —
  // the payload object is created inside the vm realm.)
  click(localCards.children[0].children[0].children[3]);
  click(localCards.children[1].children[0].children[3]);

  assert.equal(
    JSON.stringify(
      page.socket.emitted.filter(([event]) => event === events.remove),
    ),
    JSON.stringify([
      ["remove", { id: 1 }],
      ["remove", { id: 2 }],
    ]),
  );

  // English table re-words the aria-label live (a re-render rebuilds
  // the cards — grab fresh).
  for (const handler of page.messageListeners) {
    handler(LOCALE_MESSAGE("en"));
  }

  const fresh = page.document.getElementById("local-cards").children[0];

  assert.equal(fresh.children[0].children[3].attributes["aria-label"], "Remove");
});

// ------------------------------------------------------------
// Performer page — removed by the monitor (issue #13)
// ------------------------------------------------------------

test("performer page: removed by the monitor — removed cover, no auto-rejoin, cover tap rejoins", () => {
  const page = loadPage("performer.js");
  const events = page.sandbox.PNDS.events;

  deliver(page.socket, page.sandbox, "connect");
  deliver(page.socket, page.sandbox, events.joined, {
    id: 1,
    token: "t".repeat(48),
    recovered: false,
  });

  // The monitor tapped this card's「x」: the server deleted the client
  // and the notice arrives ahead of the kick.
  deliver(page.socket, page.sandbox, events.removed);

  const cover = page.document.getElementById("left-cover");

  assert.ok(!cover.classList.contains("hidden"), "the cover shows");
  assert.equal(
    page.document.getElementById("left-title").textContent,
    "已被移出检测 · Removed from testing",
    "worded as a removal, not a voluntary exit",
  );
  assert.ok(page.document.getElementById("perf").classList.contains("hidden"), "the dots are gone");

  // The kick (the server disconnects right after the notice): any
  // disconnect while exited closes for good — no auto-reconnect.
  deliver(page.socket, page.sandbox, "disconnect");

  assert.equal(page.socket.closes, 1);

  deliver(page.socket, page.sandbox, "connect");

  assert.equal(
    page.socket.emitted.filter(([event]) => event === events.join).length,
    1,
    "no join while removed",
  );

  // The whole cover is the rejoin button — same token, which the
  // server no longer knows: a deliberate fresh client.
  click(cover);

  assert.equal(page.socket.opens, 1);

  deliver(page.socket, page.sandbox, "connect");

  const joins = page.socket.emitted.filter(([event]) => event === events.join);

  assert.equal(joins.length, 2);
  assert.equal(joins[1][1].token, "t".repeat(48));
});
