# KSX HIDMaestro driver installer

This installed-only helper is the explicit machine-mutation boundary for the
production DualSense backend. It contains no HIDMaestro or WDK binary. When the
user selects the setup task, it downloads the exact official HIDMaestro v1.6.1
archive, verifies its byte length and SHA-256 plus the length and SHA-256 of the
three managed assemblies it needs, extracts them beside the protected helper,
then starts a short-lived copy of the same protected helper. That private worker
re-verifies the exact staging path, file set, lengths, and hashes before it loads
the SDK and invokes the one allowlisted API. The coordinator waits for the
worker to exit—so Windows has released every SDK image mapping—then deletes the
temporary files. Before a repair it also removes only strictly named, pinned,
non-reparse residue left by an interrupted older run; anything unexpected fails
closed without being deleted. The private worker holds a process-lifetime lease,
and recently written staging is quarantined, so a terminated coordinator cannot
let a second installer race a worker that is still using the first directory.

The KSX installer invokes exactly `install-v1` while already elevated and only
when the user selects the HIDMaestro task. The helper calls upstream
`HMContext.InstallDriver()` and exits. Network failure, a changed archive, a
changed assembly, an unexpected API shape, installation failure, and cleanup
failure are distinct nonzero outcomes. Cleanup failure does not replace a prior
download, pin, API-shape, or installation result. It is never launched by the
daemon or by the runtime host; the runtime host can only use a package already
staged in the Driver Store and retains no install, repair, certificate,
download, or update authority.

Exit 8 has one meaning: `InstallDriver()` returned successfully, but cleanup of
that run's still-pinned staging files did not finish. A staging directory that
cannot be safely verified or removed before a new install starts is exit 10
instead, so the wizard cannot call an unattempted install successful.
