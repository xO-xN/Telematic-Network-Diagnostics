// Shared constants for both browser pages and the score server.
//
// Works as a plain browser global (window.PNDS) and as a Node module.
//
// Single source of truth:
//   Ports    → manifest.json (browser gets them via __config.js injected by the server)
//   Events   → here (events)
//   Copy     → here (statusCopy)
//   Storage  → here (storageKeys)

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory({ readPorts: readManifestPorts });
  } else {
    root.PNDS = factory({
      readPorts: function () {
        var cfg = root.__PNDS_PORTS__;
        if (!cfg) throw new Error("__PNDS_PORTS__ not set — ensure __config.js loads before shared.js");
        return cfg;
      },
    });
  }
})(typeof self !== "undefined" ? self : this, function (deps) {
  var ports = deps.readPorts();

  return {
    // Read from manifest.json (or __config.js in the browser).
    // Change ports ONLY in manifest.json.
    performerPort: ports.performerPort,
    monitorPort: ports.monitorPort,

    // The room a hub connection lands in when none is given (matches
    // the hub's own default).
    defaultRoom: "default",

    // Hub-leg status copy, shared by the server (reasons in
    // lib/hub-leg.js) and the monitor page. The RTT numbers are never
    // colored — only quality is (parent issue #1).
    statusCopy: {
      idle: "Not connected — configure the hub",
      gray: "Warming up",
      green: "Hub link quality good",
      yellow: "Caution — borderline hub link",
      red: "Hub link poor or unreachable",
    },

    // Local-leg status copy (performer ↔ this score server, LND
    // vocabulary). The local thresholds DO color on latency — a LAN
    // RTT that high is a real problem, unlike the hub leg.
    localCopy: {
      gray: "Warming up… · 预热中",
      green: "Local network good · 本地网络良好",
      yellow: "Caution — borderline local network · 本地网络临界",
      red: "Local network poor or performer offline · 本地网络差或演奏者掉线",
    },

    // Performer roster cap (id space, PlayerRegistry) and the
    // per-performer event vocabulary (lib/local-leg.js producer,
    // monitor page consumer).
    maxClients: 16,
    localEvents: {
      connected: "connected",
      disconnected: "disconnected",
      reconnected: "reconnected",
    },

    // Derived end-to-end numbers (parent #1): the star topology has no
    // direct site-to-site link, so these are SUMS of measured segments —
    // never a third measurement layer. Null while any segment is
    // unmeasured (the formula must never sum a guess).
    derivedSitePair: function (ownP50, peerP50) {
      if (typeof ownP50 !== "number" || typeof peerP50 !== "number") {
        return null;
      }
      return Math.round((ownP50 + peerP50) * 10) / 10;
    },

    // Performer pair = local + hub + hub + local (four segments, #5
    // reports the local ones).
    derivedPerformerPair: function (ownLocalP50, ownHubP50, peerHubP50, peerLocalP50) {
      var segments = [ownLocalP50, ownHubP50, peerHubP50, peerLocalP50];
      for (var i = 0; i < segments.length; i++) {
        if (typeof segments[i] !== "number") {
          return null;
        }
      }
      var total = 0;
      for (var j = 0; j < segments.length; j++) {
        total += segments[j];
      }
      return Math.round(total * 10) / 10;
    },

    // The overall banner's network-wide verdict (LND's copy — the
    // go/no-go question the conductor reads first). Attribution names
    // the offending leg: "本站公网腿" or "<node> 公网腿".
    overallCopy: {
      idle: "Not connected — configure the hub · 未连接——请配置 hub",
      gray: "Measuring… · 测量中",
      green: "Suitable for performance · 适宜演奏",
      yellow: "Caution — borderline network · 临界网络，谨慎",
      red: "Not suitable for performance · 不适宜演出",
    },

    // Status → CSS class helpers, shared by both pages (the st-*
    // classes set the --st color variable in style.css). Written
    // this-free so a destructured `const setStatus = P.setStatus` keeps
    // working. In Node these exist unused — shared.js is the
    // browser/server seam, not a browser-only file.
    STATUS_CLASSES: ["st-idle", "st-gray", "st-green", "st-yellow", "st-red"],

    statusClass: function (status) {
      return "st-" + (status || "idle");
    },

    setStatus: function (element, status) {
      var classes = ["st-idle", "st-gray", "st-green", "st-yellow", "st-red"];
      for (var i = 0; i < classes.length; i++) {
        element.classList.remove(classes[i]);
      }
      element.classList.add("st-" + (status || "idle"));
    },

    // localStorage keys: the monitor's connection form (issue #3: the
    // form persists, reopening the monitor must not re-fill it) and the
    // performer page's claim token (a reconnect recovers the client
    // id).
    storageKeys: {
      hubConfig: "tnd-hub-config",
      performerToken: "tnd-performer-token",
    },

    events: {
      // Performer page ↔ score server (issue #5, the local leg):
      //   join:     page → server { token } — allocate or recover an id
      //   joined:   server → page { id, token, recovered }
      //   rejected: server → page { reason }
      //   probe:    server → page { seq } — answer immediately
      //   ack:      page → server { seq, t0, t1 } (RTT measured server-side)
      join: "join",
      joined: "joined",
      rejected: "rejected",
      probe: "local:probe",
      ack: "local:ack",
      // Monitor page ↔ score server:
      //   config: submit the connection form { url, token, room, nodeId }
      //   state:  the full site snapshot — hub leg + peers + local
      //           legs + overall (token never echoed back)
      hubConfig: "hub:config",
      state: "state",
    },
  };
});

// Node: read ports from manifest.json (the single source of truth).
function readManifestPorts() {
  var fs = require("node:fs");
  var path = require("node:path");
  // shared.js lives in public/; the manifest is one directory up.
  var manifestPath = path.join(__dirname, "..", "manifest.json");
  var manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return {
    performerPort: manifest.scoreServer.performerPort,
    monitorPort: manifest.scoreServer.monitorPort,
  };
}
