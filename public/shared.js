// Shared constants for both browser pages and the score server.
//
// Works as a plain browser global (window.PNDS) and as a Node module.
//
// Single source of truth:
//   Ports    → manifest.json (browser gets them via __config.js injected by the server)
//   Events   → here (events)
//   Copy     → here (copy — bilingual, one table per locale)
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

    // UI copy, per locale (bilingual since v0.2.0). Keys are
    // language-neutral; the monitor page renders through the table of
    // the current locale (lib/locale-follow.js follows the App
    // language, default "zh-CN" — this project's historical UI). The
    // server's state carries only the reason KEYS (lib/hub-leg.js,
    // lib/local-leg.js); reasonParams are preformatted values for the
    // {0}/{1} placeholders. "zh-CN" doubles as the fallback table; a
    // session with no locale traffic renders exactly as before.
    // test/locale-follow.test.js asserts both tables share one shape.
    copy: {
      "zh-CN": {
        // Hub-leg status lines (own card, peer cards).
        hubStatus: {
          idle: "未连接 — 请先配置 hub",
          gray: "预热中",
          green: "hub 链路质量良好",
          yellow: "注意 — hub 链路临界",
          red: "hub 链路差或不可达",
        },
        // Local-leg status lines (performer cards).
        localStatus: {
          gray: "预热中…",
          green: "本地网络良好",
          yellow: "注意 — 本地网络临界",
          red: "本地网络差或演奏者掉线",
        },
        // The overall banner's network-wide verdict.
        overall: {
          idle: "未连接 — 请先配置 hub",
          gray: "测量中",
          green: "适宜演奏",
          yellow: "临界网络，谨慎",
          red: "不适宜演出",
        },
        // Hub-leg reasons (lib/hub-leg.js keys + params).
        hubReasons: {
          unreachable: "hub 不可达",
          warmup: "预热中",
          reconnectsRed: "最近 {1} 秒内重连 {0} 次",
          jitterRed: "抖动（IQR）{0} ms ≥ {1} ms",
          lossRed: "丢包率 {0}% ≥ {1}%",
          linkGood: "链路质量良好",
          reconnectYellow: "最近 {0} 秒内 1 次重连",
          jitterYellow: "抖动（IQR）{0} ms ≥ {1} ms",
          lossYellow: "丢包率 {0}% ≥ {1}%",
        },
        // Local-leg reasons (lib/local-leg.js keys, LND's vocabulary).
        localReasons: {
          warmup: "预热中",
          disconnected: "已断开",
          consecutiveTimeouts: "连续 3 次探针超时",
          burstTimeoutRate: "突发期超时率超过 5%",
          jitter: "时间抖动过大",
          rtt: "响应过慢",
          timeout: "近期探针超时",
          green: "本地网络良好",
          outsideSafe: "超出安全阈值",
        },
        // Event-log labels (hub-leg + local-leg event types). `left` is a
        // SITE-level local event (the performer's card is already gone
        // when it fires) — {0} fills with the client id.
        events: {
          connected: "已连接",
          disconnected: "已断开",
          reconnected: "已重连",
          stopped: "已停止",
          "connect failed": "连接失败",
          left: "client {0} 退出（performer）",
        },
        // Event details the server itself words (external diagnostics
        // — socket.io reasons, error messages — stay raw).
        eventDetails: {
          noHubConfigured: "未配置 hub",
        },
        monitor: {
          sub: "监视端 — 全网视图",
          overallLabel: "总体",
          formTitle: "Hub 连接",
          formUrl: "Hub URL",
          formToken: "Token",
          formRoom: "Room",
          formNode: "节点名",
          formNodePlaceholder: "站点名",
          connect: "连接",
          formHint:
            "表单保存在浏览器 localStorage，重开无需重填；App 注入的 env（PNDS_HUB_URL 等）会作为预填默认值。",
          starHint:
            "辐条 = hub 腿（标注 RTT p50，颜色 = 质量）；外环 = 本地腿（灰 = 无数据）",
          starNotConnected: "未连接 hub — 连接后显示全网星型图",
          selfBadge: "本站",
          localTitle: "本地腿 — 本站演奏者",
          countOnline: "· {0} 在线",
          emptyLocal: "暂无演奏者 — 扫下方二维码，手机连上即自动开始测量",
          logTitle: "公网腿事件",
          noEvents: "暂无事件",
          scan: "扫码打开演奏者页面",
          qrAlt: "演奏者页面二维码",
          selfTag: "本站",
          performer: "演奏者 {0}",
          ownFallback: "本站",
          rttP50: "RTT p50 典型往返",
          rttP95: "RTT p95 尾部往返",
          oneWay: "单程估计 ≈ RTT/2",
          jitterIqr: "抖动（IQR）",
          jitterP95: "抖动 p95",
          loss: "丢包",
          performers: "演奏者",
          localLeg: "本地腿",
          noData: "无数据",
          sitePair: "站点对",
          perfPair: "演奏者对",
          segLocal: "本地",
          segHub: "hub",
          waitSite: "等待两段测量",
          waitPerf: "等待本地腿测量",
          peerUnreachable: "对端不可达",
          // Banner attribution templates ({node} = the peer's id).
          attribHubRed: "问题在 {node} 公网腿",
          attribHubYellow: "临界：{node} 公网腿",
          attribLocalRed: "问题在 {node} 本地腿",
          attribLocalYellow: "临界：{node} 本地腿",
          attribSelfHubRed: "问题在本站公网腿",
          attribSelfHubYellow: "临界：本站公网腿",
          attribSelfLocalRed: "问题在本站本地腿",
          attribSelfLocalYellow: "临界：本站本地腿",
        },
        ago: { just: "刚刚", seconds: " 秒前", minutes: " 分钟前" },
      },
      en: {
        hubStatus: {
          idle: "Not connected — configure the hub",
          gray: "Warming up",
          green: "Hub link quality good",
          yellow: "Caution — borderline hub link",
          red: "Hub link poor or unreachable",
        },
        localStatus: {
          gray: "Warming up…",
          green: "Local network good",
          yellow: "Caution — borderline local network",
          red: "Local network poor or performer offline",
        },
        overall: {
          idle: "Not connected — configure the hub",
          gray: "Measuring…",
          green: "Suitable for performance",
          yellow: "Caution — borderline network",
          red: "Not suitable for performance",
        },
        hubReasons: {
          unreachable: "Hub unreachable",
          warmup: "Warming up",
          reconnectsRed: "{0} reconnects in the last {1}s",
          jitterRed: "Jitter (IQR) {0} ms ≥ {1} ms",
          lossRed: "Loss {0}% ≥ {1}%",
          linkGood: "Link quality good",
          reconnectYellow: "1 reconnect in the last {0}s",
          jitterYellow: "Jitter (IQR) {0} ms ≥ {1} ms",
          lossYellow: "Loss {0}% ≥ {1}%",
        },
        localReasons: {
          warmup: "Warming up",
          disconnected: "Disconnected",
          consecutiveTimeouts: "3 consecutive probe timeouts",
          burstTimeoutRate: "Burst timeout rate above 5%",
          jitter: "High timing variation",
          rtt: "Slow responses",
          timeout: "Recent probe timeouts",
          green: "Local network good",
          outsideSafe: "Outside safe thresholds",
        },
        events: {
          connected: "Connected",
          disconnected: "Disconnected",
          reconnected: "Reconnected",
          stopped: "Stopped",
          "connect failed": "Connect failed",
          left: "client {0} left",
        },
        eventDetails: {
          noHubConfigured: "no hub configured",
        },
        monitor: {
          sub: "Monitor — flower view",
          overallLabel: "Overall",
          formTitle: "Hub connection",
          formUrl: "Hub URL",
          formToken: "Token",
          formRoom: "Room",
          formNode: "Node name",
          formNodePlaceholder: "site name",
          connect: "Connect",
          formHint:
            "The form persists in the browser's localStorage — no re-typing on reopen; env injected by the App (PNDS_HUB_URL, …) prefills the defaults.",
          starHint:
            "Spokes = hub legs (RTT p50 labeled, color = quality); outer rings = local legs (gray = no data)",
          starNotConnected:
            "Not connected to the hub — the network star view appears once connected",
          selfBadge: "This site",
          localTitle: "Local leg — this site's performers",
          countOnline: "· {0} online",
          emptyLocal:
            "No performers yet — scan the QR below; phones start measuring automatically",
          logTitle: "Hub-leg events",
          noEvents: "No events yet",
          scan: "Scan to open the performer page",
          qrAlt: "QR code for the performer page",
          selfTag: "This site",
          performer: "Performer {0}",
          ownFallback: "This node",
          rttP50: "RTT p50 typical",
          rttP95: "RTT p95 tail",
          oneWay: "One-way ≈ RTT/2",
          jitterIqr: "Jitter (IQR)",
          jitterP95: "Jitter p95",
          loss: "Loss",
          performers: "Performers",
          localLeg: "Local leg",
          noData: "n/a",
          sitePair: "Site pair",
          perfPair: "Performer pair",
          segLocal: "local",
          segHub: "hub",
          waitSite: "waiting for both legs",
          waitPerf: "waiting for local legs",
          peerUnreachable: "peer unreachable",
          attribHubRed: "Problem: {node} hub leg",
          attribHubYellow: "Borderline: {node} hub leg",
          attribLocalRed: "Problem: {node} local leg",
          attribLocalYellow: "Borderline: {node} local leg",
          attribSelfHubRed: "Problem: this site's hub leg",
          attribSelfHubYellow: "Borderline: this site's hub leg",
          attribSelfLocalRed: "Problem: this site's local leg",
          attribSelfLocalYellow: "Borderline: this site's local leg",
        },
        ago: { just: "just now", seconds: "s ago", minutes: "m ago" },
      },
    },

    // Performer roster cap (id space, PlayerRegistry) and the
    // per-performer event vocabulary (lib/local-leg.js producer,
    // monitor page consumer). `left` is site-level: a voluntary exit
    // deletes the card, so the event lives on in the session's
    // site-wide log instead (issue #10).
    maxClients: 16,
    localEvents: {
      connected: "connected",
      disconnected: "disconnected",
      reconnected: "reconnected",
      left: "left",
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
      //   leave:    page → server — voluntary exit (issue #10): the
      //             server deletes the client outright; the page closes
      //             the socket and shows its "left" cover
      join: "join",
      joined: "joined",
      rejected: "rejected",
      probe: "local:probe",
      ack: "local:ack",
      leave: "leave",
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
