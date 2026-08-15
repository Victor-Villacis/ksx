# KSX HIDMaestro SDK-free fake host

This Windows-only test executable exercises KSX's `KSXH` V1 local transport.
It does not reference, copy, locate, load, inspect, or call the HIDMaestro SDK,
and it creates no controller or device. The three returned personas and pinned
hashes are compile-time expectations used to test routing and handshake
refusal. They are not runtime evidence and cannot enable a KSX persona.

The host accepts exactly three arguments after its executable:

```text
serve-v1 <64-lowercase-hex-rendezvous-token> <canonical-nonzero-daemon-pid>
```

It derives the local pipe component from the token, connects with explicit
anonymous security quality of service, verifies the server PID, session,
liveness and inherited privilege state before sending a frame, and then runs
one bounded state machine. It owns at most sixteen lifetime controller IDs,
publishes cached fake state every 16 ms, expires each controller five seconds
after its last valid `Submit`, and always records neutral before destruction.
The client is expected to refresh unchanged full state every second.

Every accepted `Submit` produces one complete synthetic feedback snapshot.
The snapshot is sent before its correlated `Applied` response so the daemon's
reader can demultiplex it deterministically. Feedback uses one global
64-entry, drop-oldest queue; the 16 ms fake-sink pump never emits wire traffic.

At exit the process writes one bounded JSON summary line to stdout. It contains
only counts, controller IDs and a fixed exit category—never the rendezvous
token, Hello nonce, pad state, pipe name, or filesystem paths. This summary is
CI evidence only and is not an authentication or production runtime input.

CI should build the apphost and pure-test project, remove every downloaded or
extracted SDK artifact and related environment path, run `test-safety.ps1`,
then launch the `.exe` directly against the daemon-created one-use pipe. The
pure tests need no pipe, driver, elevation prompt, registry, service, SDK, or
device. Do not confuse this direct inherited-token test process with the later
protected elevated native bootstrap required for a production host.

The fake path requires an exact inherited SessionId but deliberately accepts
Session 0 on a hosted runner. Production Play still requires the separately
reviewed nonzero interactive-session policy; this CI helper does not weaken it.
