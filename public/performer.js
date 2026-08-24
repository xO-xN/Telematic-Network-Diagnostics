// Telematic Network Diagnostics — performer page (placeholder).
//
// Issue #5 replaces this with the local-leg view ("connected, testing"
// plus the two status dots: local-leg color and hub-leg quality).
// Until then the page confirms the connection target and stays out of
// the way — performers never need to operate anything.

const app = document.getElementById("app");

app.innerHTML =
  '<div class="perf">' +
  "<h2>Telematic Network Diagnostics</h2>" +
  '<div class="status">Performer · 演奏者</div>' +
  '<div class="meta">v0.1.0 — 本页零操作；两状态点显示随后续版本上线</div>' +
  '<div class="meta">This page stays zero-touch; the two status dots' +
  " arrive with the next release</div>" +
  "</div>";
