# KSX HIDMaestro driver installer

This installed-only helper is the explicit machine-mutation boundary for the
production DualSense backend. It contains no HIDMaestro or WDK binary. When the
user selects the setup task, it downloads the exact official HIDMaestro v1.6.1
archive, verifies its byte length and SHA-256 plus the length and SHA-256 of the
three managed assemblies it needs, extracts them beside the protected helper,
invokes the one allowlisted API, unloads them, and deletes the temporary files.

The KSX installer invokes exactly `install-v1` while already elevated and only
when the user selects the HIDMaestro task. The helper calls upstream
`HMContext.InstallDriver()` and exits. Network failure, a changed archive, a
changed assembly, an unexpected API shape, installation failure, and cleanup
failure are distinct nonzero outcomes. It is never launched by the daemon or
by the runtime host; the runtime host can only use a package already staged in
the Driver Store and retains no install, repair, certificate, download, or
update authority.
