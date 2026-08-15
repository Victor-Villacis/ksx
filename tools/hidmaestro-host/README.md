# KSX HIDMaestro runtime host

`ksx-hidmaestro-host.exe` is the fixed elevated sibling used by an installed
KSX build for the first production HIDMaestro persona: one plain USB DualSense.

The ordinary `ksx.exe` daemon owns the session policy and an authenticated
one-use pipe. The host owns the preinstalled HIDMaestro device, creator-owned
shared-memory sections/events, a five-second client lease, and exact teardown.
It cannot install/update/remove a driver package, accept a caller-selected
profile or path, sweep unrelated devices, or create more than one controller.
After a forced host termination, a later protected host may reclaim only the
stale root whose registry record carries KSX's fixed ownership marker and exact
captured instance identity; foreign HIDMaestro state remains a refusal.

The host is intentionally omitted from portable ZIPs. Elevation is permitted
only when `ksx.exe` and this fixed sibling have both passed the Program Files
location and live DACL proof in `ksx-platform`.

`publish.ps1` fetches the exact upstream v1.6.1 commit, runs the existing
source/profile verifiers, and publishes a self-contained win-x64 NativeAOT
executable. It is run by the release workflow, never by an installed product.
