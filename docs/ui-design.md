# Utility instrument panels — v0.6.1

Telematic Diagnostics extends the Multichannel Gen and Local Diagnostics UI
language: fog/teal standalone colors, system text with SF Mono data, quiet
surface separation, and a single enclosure for the overall network assessment.
The original server owns measurements, thresholds, flower aggregation and fault
attribution. Hub RTT values stay neutral; quality colors reflect jitter/loss.

The monitor hierarchy is network verdict → topology and connection settings →
site readings → local performers. Connection fields remain mounted and preserve
in-progress edits across locale changes and snapshots. The App-derived room
remains read-only. Online-site count excludes disconnected peers while keeping
those records visible. Site/performer-pair estimates retain the segment formulas
and unavailable-segment rules. Hub history and the join QR use native disclosures.

Local performer cards are keyed by id. Updates replace measurement content but
keep the card header and removal button fixed, preserving keyboard focus. When a
focused card is deleted, focus goes to the local-panel heading. The server's
single-tap removal and voluntary-exit behavior are unchanged. Phone pages keep
the three device/local/hub verdicts and bilingual copy, add the device number,
and use a native full-page Rejoin button after exit or removal.

The existing theme bridge's per-page `onTheme` hook writes `data-utility-theme`;
Brutal switches corners, shadows and transitions without modifying the reusable
bridge. Reduced motion removes transitions. Narrow monitors stack connection
settings below the diagram and reduce the card grids to two/one columns. All
runtime assets remain local; no external fonts or services are added.

`test/pages.test.js` verifies stable removal focus, online counts, native rejoin
semantics, and theme geometry alongside the original connection/locale tests.
