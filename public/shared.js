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

    // localStorage keys for the monitor's connection form (issue #3:
    // the form persists, reopening the monitor must not re-fill it).
    storageKeys: {
      hubConfig: "tnd-hub-config",
    },

    events: {
      // Browser → score server:
      //   config: submit the connection form { url, token, room, nodeId }
      // Score server → browser:
      //   state:  the full hub-leg snapshot (token never echoed back)
      hubConfig: "hub:config",
      hubState: "hub:state",
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
