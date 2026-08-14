# HIDMaestro native-bootstrap policy harness

This directory freezes the **pure policy** for the future production
HIDMaestro bootstrap. It is deliberately a standalone library with no binary
target, no Windows bindings, no SDK reference, and no process, pipe, CLR, or
elevation operation. Nothing here is production-reachable or packaged by the
KSX installer.

## Chosen topology

The ordinary KSX process will continue to create the existing first-instance,
one-use pipe and retain the exact elevated process object. The only image it
may elevate will be the fixed protected sibling
`ksx-hidmaestro-bootstrap.exe`.

The native bootstrap will validate exactly `serve-v1`, one 256-bit lowercase
hexadecimal rendezvous token, and one canonical nonzero daemon PID. It will
open that existing pipe itself with Anonymous security QoS and validate the
server process. This preserves the kernel fact used by
`GetNamedPipeClientProcessId`: the connected client is the exact retained
native bootstrap.

After connecting, the bootstrap will start exactly one protected sibling,
`ksx-hidmaestro-host.exe`, with an environment block constructed from scratch.
It will pass exactly one inheritable handle through an explicit handle-list
attribute: the already-connected duplex pipe. The managed host will wrap that
handle instead of opening a second pipe. The bootstrap will close its local
pipe copy only after the managed child exits, retain and wait on the exact
managed-child handle, and remain an owner of the client endpoint for the whole
conversation. It will never relay or interpret protocol frames and will never
terminate the managed child.

The managed apphost is self-contained but not single-file, so there is no
bundle-extraction path. This is smaller than hosting CoreCLR in-process: it
does not add a custom
`hostfxr` ABI layer or framework-resolution policy, while the self-contained
managed sibling still starts only after the native bootstrap has replaced the
inherited environment.

## Frozen boundaries

- Outer argv: `serve-v1 <64 lowercase hex> <canonical nonzero u32>`.
- Inner argv: `serve-inherited-v1 <canonical nonzero native handle>`.
- Fixed sibling names only; no path, command, working-directory, runtime, DLL,
  profile, or environment input crosses either API.
- The managed environment is created from scratch. No inherited entry is
  copied. The only path value is the result of a future trusted
  `GetWindowsDirectoryW` query.
- Diagnostics, debugger/profiler attach, startup profiling, and multilevel
  runtime lookup are explicitly disabled. Startup hooks, additional deps,
  shared stores, profiler paths/CLSIDs, host tracing paths, and user `PATH` are
  absent rather than filtered after copying.
- Child handle inheritance is enabled only together with an explicit list
  containing the single connected pipe handle.

## Required implementation gates

This policy must not be promoted directly into a binary. A future native Rust
implementation needs all of the following before production wiring:

1. Resolve and seal only the fixed bootstrap sibling under the existing
   Program Files/ACL policy. Keep its token factory private and expose only a
   typed HIDMaestro launch composition; never return a generic
   `ProtectedExecutable` or accept caller-selected argv.
2. In the bootstrap, derive its protected directory from its own module handle,
   reject reparse points, and verify the fixed managed apphost plus its entire
   self-contained runtime/dependency manifest against the S1.5b signed pins.
3. Open the pre-created pipe with `SECURITY_SQOS_PRESENT` plus Anonymous QoS;
   retain and bracket a handle to the kernel-reported server PID; require the
   exact daemon PID, same nonzero session, fixed protected KSX image, and
   liveness before and after inspection.
4. Obtain `SystemRoot` from `GetWindowsDirectoryW`, not from the inherited
   environment. Encode the policy model's sorted, double-NUL-terminated Unicode
   environment block.
5. Start only the fixed self-contained managed apphost with extended startup
   information and a one-entry inherited-handle list. Do not use shell or
   `PATH` discovery, a single-file bundle/extraction path, inherited standard
   handles, or the ambient handle table.
6. Keep the bootstrap alive while waiting on the exact managed-child handle.
   On child exit, close the bootstrap's remaining resources and return the
   child's code. On daemon/pipe loss, let the managed host perform the existing
   ownership-scoped neutralize/dispose path; do not add a kill primitive.
7. Add an Actions-only Windows integration test that injects hostile mixed-case
   startup-hook, additional-deps, shared-store, profiler, diagnostics, tracing,
   roll-forward, `COMPlus_`, and legacy `COR_` variables. A harmless managed
   sentinel must prove none executed or survived, and handle enumeration must
   prove that only the pipe crossed the child boundary. The server must also
   measure that its reported client PID remains the retained bootstrap before
   and after the managed child inherits the handle; Microsoft documents the
   PID query but does not specify inheritance semantics strongly enough for KSX
   to substitute an assumption for that gate.
8. Preserve the existing daemon-side order: listener, fixed launch, kernel PID
   correlation to the retained elevated bootstrap, then `Hello`.

The current fake host remains separate. Its inherited test-runner environment
is acceptable only because it is SDK-free, non-elevated-by-KSX, and gated by
`hidmaestro-fake-host-tests`; it must not be repurposed as this production host.

The existing S1.5a ten-file distribution manifest is not sufficient for this
topology. S1.5b must add the native bootstrap as a distinct signed role and pin
the managed apphost, `HIDMaestro.Core.dll`, and the complete self-contained
non-single-file runtime/dependency graph. No SDK or runtime path is supplied at
launch time.
