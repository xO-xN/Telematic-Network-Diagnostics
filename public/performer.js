// Telematic Network Diagnostics — performer page (issue #5).
//
// LND-minimal mobile client, ported from the sibling repo: joins the
// score server automatically (recovering the client id via the persisted
// claim token) and answers every local-leg probe immediately so the
// server can measure the real round trip. Zero controls.
//
// The page shows three dots and nothing else (issue #5: no cross-site
// details ever render here): THIS device's own local-leg verdict, this
// site's local-leg worst, and this site's hub leg. All three read the
// same state broadcast the monitor renders.

const P = window.PNDS;

const app = document.getElementById("app");

app.innerHTML =
  "<header>" +
  "<h1>Telematic Network Diagnostics</h1>" +
  '<span class="sub">Performer</span>' +
  "</header>" +
  '<div class="perf">' +
  '<div class="dot-row st-gray" id="row-self">' +
  '<span class="dot"></span>' +
  '<span class="dot-k">本机 This device</span>' +
  '<span class="dot-word" id="w-self">…</span>' +
  "</div>" +
  '<div class="dot-row st-gray" id="row-local">' +
  '<span class="dot"></span>' +
  '<span class="dot-k">本地腿 Local leg</span>' +
  '<span class="dot-word" id="w-local">…</span>' +
  "</div>" +
  '<div class="dot-row st-gray" id="row-hub">' +
  '<span class="dot"></span>' +
  '<span class="dot-k">Hub 腿 Hub link</span>' +
  '<span class="dot-word" id="w-hub">…</span>' +
  "</div>" +
  '<p class="status" id="p-status">Connecting…</p>' +
  '<p class="meta" id="p-meta"></p>' +
  "</div>";

const selfRow = document.getElementById("row-self");
const selfWord = document.getElementById("w-self");
const localRow = document.getElementById("row-local");
const localWord = document.getElementById("w-local");
const hubRow = document.getElementById("row-hub");
const hubWord = document.getElementById("w-hub");
const statusEl = document.getElementById("p-status");
const metaEl = document.getElementById("p-meta");

let clientId = null;

function setStatus(row, word, status) {
  P.setStatus(row, status);
  word.textContent = status ? status.toUpperCase() : "…";
}

function setJoined(joined, id) {
  if (joined) {
    statusEl.textContent = "已连接，测试中… · Connected, testing…";
    metaEl.textContent = "Client " + id + " · 零操作，无需设置";
  } else {
    clientId = null;
    statusEl.textContent = "Connecting…";
    metaEl.textContent = "";
  }
}

const socket = io(
  "http://" + location.hostname + ":" + P.performerPort,
  { reconnection: true, reconnectionDelay: 1000 },
);

socket.on(P.events.joined, (data) => {
  localStorage.setItem(P.storageKeys.performerToken, data.token);
  clientId = data.id;
  setJoined(true, data.id);
});

socket.on(P.events.rejected, (data) => {
  setJoined(false);
  statusEl.textContent = "Rejected: " + (data && data.reason ? data.reason : "");
});

socket.on("connect", () => {
  // Fires on first connect and after every reconnect: (re)join with the
  // persisted token so the server hands back the same client id.
  socket.emit(P.events.join, {
    token: localStorage.getItem(P.storageKeys.performerToken) || null,
  });
});

socket.on("disconnect", () => {
  setJoined(false);
});

// The three dots: this device's own local-leg card, this site's local-leg
// worst and this site's hub-leg quality, straight from the state
// broadcast. Nothing cross-site.
socket.on(P.events.state, (state) => {
  const local = state && state.local ? state.local : null;
  const hub = state && state.leg ? state.leg.status : null;
  const me =
    clientId !== null && local && local.clients
      ? local.clients[clientId]
      : null;

  setStatus(selfRow, selfWord, me ? me.status : "gray");
  setStatus(localRow, localWord, (local && local.status) || "gray");
  setStatus(hubRow, hubWord, hub || "idle");
});

// Answer every probe immediately so the server can measure the real
// round trip. t0/t1 are performance.now() timestamps around the reply
// — the server uses them only for the client processing time (the RTT
// itself is measured server-side).
socket.on(P.events.probe, (payload) => {
  const t0 = performance.now();

  socket.emit(P.events.ack, {
    seq: payload && payload.seq,
    t0,
    t1: performance.now(),
  });
});

setJoined(false);
