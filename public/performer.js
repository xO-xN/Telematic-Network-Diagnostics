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
//
// One escape hatch (issue #10): the 退出检测 button — small, low
// contrast, tucked into the bottom corner, single tap, no confirmation.
// Tapping it deletes the client on the server (a voluntary exit is not
// a network fault — the site verdict must stop counting this leg) and
// flips the page to its "left" cover: the socket is closed (no auto
// reconnect — lock/unlock keeps the exited state) and the WHOLE page
// becomes a 重新加入 tap target. The exited state lives in memory only:
// it never touches localStorage, so a page the system killed rejoins
// normally on reopen. Rejoining sends the SAME claim token, which the
// server no longer knows — a deliberate fresh client (new id, new
// measurement, gray warm-up).
//
// The same exit state has a second door in (issue #13): the server's
// `removed` event, sent when the monitor taps this performer card's「x」.
// The only difference is the wording — 已被移出检测 instead of 已退出检测.

const P = window.PNDS;

const app = document.getElementById("app");

app.innerHTML =
  "<header>" +
  "<h1>Telematic Network Diagnostics</h1>" +
  '<span class="sub">Performer</span>' +
  "</header>" +
  '<div class="perf" id="perf">' +
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
  "</div>" +
  '<button class="leave-btn" id="b-leave">退出检测 Leave testing</button>' +
  '<div class="left-cover hidden" id="left-cover">' +
  '<p class="left-title" id="left-title">已退出检测 · Left testing</p>' +
  '<p class="left-hint">重新加入 · Rejoin</p>' +
  "</div>";

const selfRow = document.getElementById("row-self");
const selfWord = document.getElementById("w-self");
const localRow = document.getElementById("row-local");
const localWord = document.getElementById("w-local");
const hubRow = document.getElementById("row-hub");
const hubWord = document.getElementById("w-hub");
const statusEl = document.getElementById("p-status");
const metaEl = document.getElementById("p-meta");
const perfEl = document.getElementById("perf");
const leaveButton = document.getElementById("b-leave");
const coverEl = document.getElementById("left-cover");
const coverTitleEl = document.getElementById("left-title");

let clientId = null;
// In-memory only (issue #10): the exited state must die with the page —
// a reopen after the system killed it is a rejoin, not a resumed exit.
let left = false;

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

function setHidden(element, hidden) {
  if (hidden) {
    element.classList.add("hidden");
  } else {
    element.classList.remove("hidden");
  }
}

// The whole page flips to one big tap target: dots gone, socket closed.
// `removed` words the cover for the monitor-initiated exit (#13); the
// voluntary 退出检测 keeps its own wording (#10).
function setLeft(exited, removed = false) {
  left = exited;
  setHidden(perfEl, exited);
  setHidden(leaveButton, exited);
  setHidden(coverEl, !exited);

  if (exited) {
    coverTitleEl.textContent = removed
      ? "已被移出检测 · Removed from testing"
      : "已退出检测 · Left testing";
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
  // persisted token so the server hands back the same client id. Never
  // while exited — the socket stays closed there, and rejoining is the
  // cover tap's job alone.
  if (left) {
    return;
  }

  socket.emit(P.events.join, {
    token: localStorage.getItem(P.storageKeys.performerToken) || null,
  });
});

socket.on("disconnect", () => {
  if (left) {
    // The server kicked the socket once it had processed the leave
    // (the authoritative teardown — the page cannot close race-free
    // right after emitting). Any disconnect while exited ends the same
    // way: stop reconnecting. This also lands for a REMOVAL: the
    // server sends `removed` first, then kicks (below), so `left` is
    // already set when the disconnect arrives.
    socket.close();
    return;
  }

  setJoined(false);
});

// Removed by the monitor (issue #13): this performer card's「x」was
// tapped on the monitor. The server has already deleted the client and
// disconnects this socket next — same exited state as a voluntary
// leave, worded as a removal.
socket.on(P.events.removed, () => {
  setLeft(true, true);
});

// The three dots: this device's own local-leg card, this site's local-leg
// worst and this site's hub-leg quality, straight from the state
// broadcast. Nothing cross-site. Nothing at all once exited.
socket.on(P.events.state, (state) => {
  if (left) {
    return;
  }

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

// 退出检测: single tap, straight out. The page never closes the
// socket itself in the same tick — a close racing the leave packet's
// flush could drop the delete. The server kicks the connection once
// it has processed the leave (the disconnect handler closes for
// good); the fallback below only covers a leave that never reached
// the server (emitted during a transport drop), so the exited page
// can not sit on a reconnecting socket forever.
const LEAVE_CLOSE_FALLBACK_MS = 3000;

leaveButton.addEventListener("click", () => {
  if (left) {
    return;
  }

  socket.emit(P.events.leave);
  setLeft(true);
  setTimeout(() => {
    if (left) {
      socket.close();
    }
  }, LEAVE_CLOSE_FALLBACK_MS);
});

// 重新加入: the whole cover is the button. Reopening the socket fires
// "connect", which joins with the SAME persisted token — unknown to
// the server now, so it arrives as a fresh client.
coverEl.addEventListener("click", () => {
  if (!left) {
    return;
  }

  setLeft(false);
  socket.open();
});

setLeft(false);
setJoined(false);
