# Telematic Network Diagnostics

[中文](README.zh-CN.md) | **English**

A PNDS utility for diagnosing cross-internet (telematic) setups: every site runs this project and phones join locally, and each site's monitor shows the same star view — an overall verdict with fault attribution, hub legs as spokes, local legs as outer rings — plus per-node cards with derived end-to-end numbers. Network-only: no audio, no SuperCollider; the project always runs with audio disabled (`none` mode).

## How to use

1. In the PNDS App, press **⌘O** (Open) and select this `.pnds` bundle or its
   unzipped folder, then **Load** it — audio stays disabled; the score server
   listens on ports 6868 (performer) and 6869 (monitor). Don't have the App
   yet? Download it from https://github.com/xO-xN/PNDS-App/releases/latest
   (macOS) — no Node.js installation is required, the App bundles it.
2. The relay hub is **not** part of this bundle — it deploys from source onto
   a public VPS (see `docs/hub-deployment.md` in the
   [repository](https://github.com/xO-xN/Telematic-Network-Diagnostics)).
   Point the score server at it through the monitor's connection form
   (URL / token / room / node name).
3. At each site, expand **Join devices** at the bottom of the monitor and scan
   the QR code on each phone. Phones join and answer probes automatically;
   keep their pages open during the test.
4. Every site's monitor shows the same flower view: an overall
   "suitable for performance" banner with fault attribution, the star diagram
   (spokes = hub legs, outer rings = local legs), per-node cards with derived
   end-to-end numbers, and this site's performer panel.

The monitor follows the App language and theme; the performer page keeps its
bilingual copy.
