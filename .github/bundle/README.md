# Telematic Network Diagnostics

A runnable PNDS score project for cross-internet network diagnostics.

This folder is a **PNDS score project**, packaged and ready to run
offline. No audio, no SuperCollider — it runs in audio mode `none`.

## How to diagnose a telematic setup

1. Install PNDS App (macOS, Apple Silicon):
   https://github.com/xO-xN/PNDS-App/releases/latest
2. In PNDS App, press **⌘O** and select this folder. The project starts
   with audio disabled; the score server listens on ports 6868
   (performer) and 6869 (monitor).
3. The relay hub is **not** part of this bundle — it deploys from
   source onto a public VPS (see `docs/hub-deployment.md` in the
   [repository](https://github.com/xO-xN/Telematic-Network-Diagnostics)).
   Point the score server at it through the monitor's connection form
   (URL / token / room / node name) or the `PNDS_HUB_*` environment
   variables the App injects.
4. Performers open `http://<Host-LAN-IP>:6868/` on their phones (scan
   the QR on the monitor page `http://<Host-LAN-IP>:6869/`). They are
   measured automatically — zero controls.
5. Every site's monitor shows the same flower view: an overall
   "suitable for performance" banner with fault attribution, the star
   diagram (spokes = hub legs, outer rings = local legs), per-node
   cards with derived end-to-end numbers, and this site's performer
   panel.

You do not need to install Node.js. PNDS App bundles it.
