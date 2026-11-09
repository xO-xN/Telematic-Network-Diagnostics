# Internet diagnostic UI — v0.8.0

The implementation follows the approved geographic/topology prototype. The
product is internet-only: each node measures score server ↔ public HUB. Browser
pages observe those measurements; they do not register performers or measure
local Wi-Fi. Both PNDS HTTP entries show the same diagnostic and retain the
runtime's health, shared-library, theme and locale contracts.

## Layout and identity

The hierarchy is overall internet connection status → connection map → node
readings → selected-node details. Connection settings and event history use
native disclosures. An App-derived room remains read-only; standalone operation
retains a connection form. Snapshots and locale changes preserve pending edits.
A connected identical configuration submission does not restart measurement;
an explicit retry of a disconnected configuration starts another attempt.

Geographic view fits all known node positions and the known HUB position with
modest margin, rather than centering a permanent world map. The local, simplified
land silhouette contains continental/coast outlines only. No administrative
boundaries, tile provider, map runtime, place-search service or remote font is
needed. A topology toggle remains available when location is missing or nodes
share coordinates. A node without coordinates is listed as unknown and is never
placed at a fabricated point. Missing HUB coordinates stay unknown as well.

Node color is stable identity, shared by its circle, connection and table swatch.
Quality remains a separate status indicator and reason. Geographic points and
connection endpoints use the exact projection: close nodes are never repelled,
clustered or displaced. Only the self node has a persistent “本站 / This node”
map label. HUB uses a square. Hover/focus highlights the corresponding table row
and shows its details; leaving restores the pinned selection and prior fold
state. Click or keyboard activation pins a selection. The table offers access to
every node even if map marks coincide; narrow layouts remain usable.

## Measured and estimated data

The measurement window is 15 seconds. RTT magnitude is informational; quality
uses jitter, loss, reconnects and connectivity. Public-network stability is not
an audio playability promise. A stale peer retains its last position but no live
readings. Losing the local HUB connection marks remote states unconfirmed rather
than claiming each remote link has failed.

The extended HUB supplies observed public-exit IP, optional estimated location,
optional configured HUB location and manual-location capability. IP estimation
is approximate city data, never verified district or venue coordinates. Legacy
HUB compatibility remains: absent metadata means unknown location, while
measurement/topology still work. A correction applies to this diagnostic/node
session, survives transport retry, and can be cleared. It does not persist App
preferences or mutate another node. A new node/HUB/room clears it.

The Nanjing HUB used in the prototype is sample data only. The production HUB
position comes from deployment metadata and is not hard-coded. API keys and
proxy trust belong to HUB deployment; node pages never perform IP-provider
queries. HUB deployment remains separate from a tool release.

## Theme and validation

Pond, Sand, Stage and Brutal follow the existing App theme bridge. System text,
SF Mono data, quiet dividers and compact controls use the utility design tokens.
Brutal keeps square corners/hard shadows and removes transitions; reduced-motion
preferences are respected. English and 简体中文 copy share one key shape and
follow `pnds:locale` and the initial locale query.

`test/pages.test.js` covers DOM interactions and themes. The server integration
tests use controlled loopback connections for health, both entry points, shared
assets, absence of local probe/join protocol, old-HUB compatibility, two-node
readings, configuration/retry, location correction and graceful shutdown. They
do not replace native App or two-node public-network acceptance.

Version 0.8.0 is distributed as a `.pnds` project with exact App shared-library
references. PNDS App packages the verified artifact fixed by its registry;
the HUB is deployed independently.
