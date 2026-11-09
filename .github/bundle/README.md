# Telematic Network Diagnostics

[中文](README.zh-CN.md) | **English**

An internet-only PNDS utility. Each node measures its connection to a public
HUB and shares readings within the room. Geographic and topology views show
those connections, with a compact node table and linked details. Audio is
always disabled (`none` mode).

## Use

1. Open the tool in PNDS App, or use **⌘O** to install this `.pnds` bundle and
   load the installed project. A compatible Host supplies Node.js and the exact
   shared libraries declared in `manifest.json`.
2. Set the HUB address, token, node name and group in the App's node settings.
   The tool uses that configuration automatically; its derived room remains
   read-only. Standalone source operation also supports a connection form.
3. Open the tool at each participating node using the same HUB and room, with
   a distinct node name. Connections go outbound from each node to HUB.
4. Read the status and table. Hover or focus a map node to highlight its row and
   details; click to keep it selected. Switch between geography and topology
   as needed. Both project HTTP entry points show the same diagnostic.

The tool follows the App's theme and English/简体中文 language. Browser pages
observe the node's internet measurement; there is no phone enrollment or local
Wi-Fi testing.

## Readings and locations

RTT p50/p95, jitter (IQR), loss and reconnects use a 15-second rolling window.
RTT magnitude is informational; jitter, loss, reconnects and connectivity
control the quality status. The result describes network stability, not whether
an audio performance will be suitable. A stale node retains its last location
but loses live readings. If this node disconnects from HUB, remote states are
unconfirmed until connectivity returns.

The map fits known nodes and HUB with modest margin and shows continental land
outlines only. Colors identify nodes consistently across map marks, lines and
table swatches. Nearby nodes retain their projected positions; only the local
node stays labeled on the map.

A compatible HUB can supply observed public-exit IP and approximate city
location. IP estimates do not establish a district or venue location. Unknown
positions remain in the node list; topology and measurements stay available
with older HUB versions too. This node's location can be corrected for the
current diagnostic session and cleared back to automatic estimation. A
correction survives reconnects/retries but is not stored as an App preference.
The HUB marker uses deployment-provided coordinates and remains unknown when
those coordinates are unavailable.

## HUB and runtime

The HUB is deployed separately on a public VPS and is not included in this
bundle. The [source repository](https://github.com/xO-xN/Telematic-Network-Diagnostics)
contains the HUB deployment guide. Its optional IP location service receives
public IP queries from HUB; location-service keys stay on HUB. Source changes
do not automatically upgrade an existing deployed HUB.

Runtime requirement: PNDS App v1.6.2 or a compatible Host providing the exact
shared library versions in `manifest.json`. The bundle carries project assets
and library references, without duplicate runtime packages. The manifest's
standard HTTP entries are ports 6868 and 6869, both showing this diagnostic.
