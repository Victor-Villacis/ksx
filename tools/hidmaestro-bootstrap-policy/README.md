# HIDMaestro native-bootstrap policy harness

This directory freezes the **pure policy** for the future production
HIDMaestro bootstrap. It is deliberately a standalone library with no binary
target, no Windows bindings, no SDK reference, and no process, pipe, CLR, or
elevation operation. Nothing here is production-reachable or packaged by the
KSX installer. Cargo automatic binary, example, integration-test, benchmark
and build-script discovery are explicitly disabled; the sole declared target
is this pure library.

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
handle instead of opening a second pipe.

Before creation, the bootstrap will configure one unnamed job with
kill-on-last-handle-close. The child is assigned to that job atomically through
the process-creation job list and its primary thread is created suspended. The
bootstrap then proves the returned process handle names the fixed sealed image,
same nonzero session and elevated token. Only after every identity check passes
does it resume the primary thread, exactly once. A bootstrap crash closes the
job and the OS reaps the managed child; a failed creation cannot leave an
uncontained suspended process.

The bootstrap retains its own client-pipe handle, job handle, child process
handle and managed-image seal until the managed child exits. Retaining the pipe
copy is intentional: the endpoint authenticated by the daemon is the native
bootstrap, so that process remains a real owner of the client endpoint for the
whole conversation. Closing it immediately after inheritance would leave only
an indirectly trusted child holding a handle whose kernel PID attribution may
still name the bootstrap. The retained copy delays EOF only until the bootstrap
observes child exit and closes its resources; the job prevents the reverse
problem, a child outliving a crashed bootstrap. The bootstrap never relays or
interprets protocol frames and never directly terminates a running child.

The managed apphost is self-contained but not single-file, so there is no
bundle-extraction path. This is smaller than hosting CoreCLR in-process: it
does not add a custom
`hostfxr` ABI layer or framework-resolution policy, while the self-contained
managed sibling still starts only after the native bootstrap has replaced the
inherited environment.

The child working directory is not inherited and is not an argument. It is the
same protected directory derived from the bootstrap module and proven to be the
fixed managed sibling's parent. At managed entry, immediately after parsing the
exact inherited-handle argv, the host clears and verifies removal of
`HANDLE_FLAG_INHERIT` on the pipe before KSX starts a thread, constructs an SDK
object, or performs optional logging. Failure is terminal; the flag is never
re-enabled and the host never creates descendants.

## Frozen boundaries

- Outer argv: `serve-v1 <64 lowercase hex> <canonical nonzero u32>`.
- Inner argv: `serve-inherited-v1 <canonical nonzero native handle>`.
- Fixed sibling names only; no path, command, working-directory, runtime, DLL,
  profile, or environment input crosses either API.
- The child working directory is exactly the protected bootstrap/managed-image
  sibling directory derived from the bootstrap module, never ambient CWD.
- The managed environment is created from scratch. No inherited entry is
  copied. The only path value is the result of a future trusted
  `GetWindowsDirectoryW` query.
- Diagnostics, debugger/profiler attach, startup profiling, and multilevel
  runtime lookup are explicitly disabled. Startup hooks, additional deps,
  shared stores, profiler paths/CLSIDs, host tracing paths, and user `PATH` are
  absent rather than filtered after copying.
- Child handle inheritance is enabled only together with an explicit list
  containing the single connected pipe handle.
- The managed child clears and verifies the pipe handle's inheritance flag as
  its first KSX action after exact argv parsing and before threads, SDK or logs.
- The managed child starts suspended and already assigned to the bootstrap's
  unnamed kill-on-close job. Image, PID, session, elevation and seal checks all
  precede its one permitted resume.
- The daemon retains the authenticated bootstrap process handle. After every
  synchronous or overlapped read/write completion—and once more after a whole
  frame—it rechecks that handle. A simultaneous exit wins: read bytes are
  discarded, completed writes are reported failed, and the connection is
  poisoned.

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
   Parse the pinned runtime config and dependency graph too: they must contain
   no startup hook, additional probing root, external runtime path, roll-forward
   escape, or asset outside that protected manifest. Open and seal every file in
   the complete managed/native graph before child creation; hash and signature
   inspection must use those sealed objects, and every seal remains live through
   child exit. This includes the apphost, host DLL, `HIDMaestro.Core.dll`, deps
   and runtime config, CoreCLR/host policy/fxr, and every private native runtime
   dependency.
3. Open the pre-created pipe with `SECURITY_SQOS_PRESENT` plus Anonymous QoS;
   retain and bracket a handle to the kernel-reported server PID; require the
   exact daemon PID, same nonzero session, fixed protected KSX image, and
   liveness before and after inspection.
4. Obtain `SystemRoot` from `GetWindowsDirectoryW`, not from the inherited
   environment. Encode the policy model's sorted, double-NUL-terminated Unicode
   environment block.
5. Before child creation, create one unnamed job and set
   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Put both the one-entry pipe handle list
   and one-entry job list into the same extended startup attribute list. The job
   handle is not inherited. Use the creation-time job-list assignment so a
   failed call cannot strand an uncontained suspended process.
6. Start only the fixed self-contained managed apphost with
   `CREATE_SUSPENDED`, a Unicode environment, extended startup information and
   an explicit application path. Set the child working directory to the exact
   protected bootstrap/managed sibling directory; never pass null or inherit
   ambient CWD. Do not use shell or `PATH` discovery, a single-file
   bundle/extraction path, inherited standard handles, or the ambient handle
   table. Apply image-load policy that prefers System32 for system images and
   blocks remote and low-integrity native images.
7. Before the first resume, query the returned process handle—not its PID—to
   prove the handle-derived image equals the retained sealed image, its PID is
   the returned process PID, its session equals the bootstrap's nonzero
   interactive session, and its token is elevated. Retain the complete graph of
   seals, process handle and job handle through child exit. Any mismatch closes
   the job while the primary thread is still suspended. A successful resume
   must report the one expected creation-time suspend count; it is never called
   again.
8. In managed entry, parse only `serve-inherited-v1 <canonical handle>`, then
   immediately clear `HANDLE_FLAG_INHERIT` on that pipe and verify it is clear.
   On failure, close/refuse before constructing an SDK object, starting a KSX
   thread, or optional logging. Never re-enable inheritance or spawn a child.
9. Keep the bootstrap's connected pipe copy for the managed child's lifetime,
   wait on the exact child process handle, then close pipe and job and return the
   child's code. On clean daemon/pipe loss, the managed host still performs the
   ownership-scoped neutralize/dispose path. Kill-on-job-close is the crash and
   pre-resume containment backstop, not a normal teardown shortcut, and there is
   no generic or caller-directed termination API.
10. Change daemon pipe I/O before production construction exists. The retained
   bootstrap process handle participates in pending waits and is queried again
   after every synchronous and overlapped completion. Read data stays in owned
   quarantine until that check passes. If exit and completion race, exit wins,
   read bytes are discarded, writes become terminal errors, and both pipe halves
   close. Recheck once more after assembling a complete frame before decode or
   delivery.
11. Add an Actions-only Windows integration test that injects hostile mixed-case
   startup-hook, additional-deps, shared-store, profiler, diagnostics, tracing,
   roll-forward, `COMPlus_`, and legacy `COR_` variables. A harmless managed
   sentinel must prove none executed or survived. Seed extra inheritable canary
   handles and prove the child receives none of them while the pipe is usable.
   The server must measure that its reported client PID remains the retained
   bootstrap and that both process sessions remain stable before and after
   inheritance; Microsoft documents the PID query but does not specify
   inheritance semantics strongly enough for KSX to substitute an assumption
   for that gate.
12. The Actions matrix must also crash the bootstrap while the managed sentinel
   queues a frame. Prove the kill-on-close job reaps the child, the server never
   delivers the racing frame, and the pipe becomes unusable. A second sentinel
   must prove managed entry cannot run before resume and cannot run at all when
   the suspended child's image/session/elevation evidence is deliberately made
   invalid. It must additionally prove the exact protected working directory,
   observe the inherited pipe flag cleared before SDK initialization, and
   inventory loaded native modules: every non-System32 module must be one of the
   sealed protected graph objects, with no remote or low-integrity origin.
13. Preserve the existing daemon-side order: listener, fixed launch, kernel PID
   correlation to the retained elevated bootstrap, then `Hello`.

The current fake host remains separate. Its inherited test-runner environment
is acceptable only because it is SDK-free, non-elevated-by-KSX, and gated by
`hidmaestro-fake-host-tests`; it must not be repurposed as this production host.

The existing S1.5a ten-file distribution manifest is not sufficient for this
topology. S1.5b must add the native bootstrap as a distinct signed role and pin
the managed apphost, `HIDMaestro.Core.dll`, and the complete self-contained
non-single-file runtime/dependency graph. No SDK or runtime path is supplied at
launch time.
