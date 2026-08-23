# PNDS Template

A runnable PNDS score project skeleton with minimal working features.

This folder is a **PNDS score project**, packaged and ready to run offline.

## How to perform

1. Install PNDS App (macOS, Apple Silicon):
   https://github.com/xO-xN/PNDS-App/releases/latest
2. Put the Mac and the performer devices on the same local network.
3. In PNDS App, click **Open** and select **this folder**.
4. Choose **Internal Synth**, pick an output device, then **Load**.
5. Performers open `http://<Host-LAN-IP>:6868/` on a phone/tablet in
   landscape: the left half of the screen is the AMP fader, the right half
   is the FREQ fader. The operator watches `http://<Host-LAN-IP>:6869/`.

You do not need to install Node.js or SuperCollider. PNDS App bundles both.
