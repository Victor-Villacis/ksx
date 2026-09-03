# VIIPER lane (M8.1 / E1.1) — measured facts, September 2026

Dated investigation for the VIIPER lane. Rows are tagged **MEASURED** (this
machine or a VM, with the command), **SOURCE** (read in upstream source or a
downloaded artifact), or **UNVERIFIED** (docs only, or not yet run). The
go/no-go table at the end names, for every measurement, the slice it gates.
Product decisions live in `docs/ENHANCEMENTS.md` E1.1 and the approved plan;
this file only records what is true.

Upstream: https://alia5.github.io/VIIPER/stable/ · https://github.com/Alia5/VIIPER
(GPL-3.0 server, MIT clients) · https://github.com/vadimgrn/usbip-win2
(BSD-2-Clause Windows USB/IP client driver).

## 0. Artifacts, pinned (SOURCE — downloaded 2026-09-02, hashed; executed only where a row below says so)

| Artifact | Bytes | SHA-256 | Authenticode |
|---|---|---|---|
| `viiper-windows-amd64.zip` (release v0.7.0, 2026-06-01) | 4,547,006 | `A02B06751D64E43E7700ABA8EE1F7E3E4F5F4E7F370A11722FF922AB075C1629` | n/a |
| `viiper.exe` (inside; Go 1.26.3) | 10,983,424 | `1868D682F4CC6D62349BBCCBF0727B05D3EB6E22027AC34F0F1D9B1DE56F2DDC` | **NotSigned** |
| `licenses.txt` (inside) | 56,215 | — | GPL-3.0 notice, Copyright 2025-2026 Peter Repukat, plus Go dependency notices (fyne.io/systray Apache-2.0, alecthomas/kong MIT, godbus/dbus, …) |
| `USBip-0.9.7.7-x64.exe` (release v.0.9.7.7, 2026-04-21) | 33,226,344 | `51620FA5F9F8BE5932BC9D786DEEE557CE06D5407A99CAB490DCFAC71F185FEA` | **Valid**; signer `CN=Cloudyne Systems (Scheibling Consulting AB)`, issuer GlobalSign GCC R45 EV CodeSigning CA 2020, NotAfter 2027-05-03; Microsoft Public RSA Time Stamping Authority |

GitHub publishes no checksum file for either project; ksx pins the values
above itself. Release 0.9.7.8 of usbip-win2 (2026-07-04) carries the
maintainer's own note "this release has a bug that can cause memory corruption
and BSOD. Probably you should use previous release" — 0.9.7.7 is the pin.
`viiper-client` 0.7.0 on crates.io is MIT, `default = []` (no tokio), MSRV 1.70.

## 1. Server CLI as shipped (MEASURED — `viiper.exe server --help`, 2026-09-02)

The docs site and the binary disagree on three flag spellings; the binary wins:

| Binary flag | Env | Default | Docs spelling |
|---|---|---|---|
| `--config=STRING` | `VIIPER_CONFIG` | — | (not on the cli/server page) |
| `--update-notify="stable"` | `VIIPER_UPDATE_NOTIFY` | `stable` (none, stable, prerelease) | undocumented — **the binary embeds `https://api.github.com/repos/Alia5/VIIPER/releases/latest` and "A new version of VIIPER is available:"; see §2.6** |
| `--log.level`, `--log.file`, `--log.raw-file` | `VIIPER_LOG_*` | info / none / none | same |
| `--usb.addr` | `VIIPER_USB_ADDR` | `:3241` | same |
| `--usb.bus-cleanup-timeout=DURATION` | — | (= handler timeout) | the source note said not settable — **it is** |
| `--usb.write-batch-flush-interval` | `VIIPER_USB_WRITE_BATCH_FLUSH_INTERVAL` | `1ms` | same |
| `--api.addr` | `VIIPER_API_ADDR` | `:3242` | same |
| `--api.device-handler-connect-timeout` | `VIIPER_API_DEVICE_HANDLER_TIMEOUT` | `5s` | docs: `--api.device-handler-timeout` |
| `--api.auto-attach-local-client` | `VIIPER_API_AUTO_ATTACH_LOCAL_CLIENT` | true | same |
| `--api.require-local-host-auth` | `VIIPER_API_REQUIRE_LOCALHOST_AUTH` | false | docs: `--api.require-localhost-auth` (**rejected: "unknown flag"**) |
| `--api.auto-attach-windows-native` | `VIIPER_API_AUTO_ATTACH_WINDOWS_NATIVE` | — | undocumented on the server page |
| `--connection-timeout` | `VIIPER_CONNECTION_TIMEOUT` | `30s` | same |

Defaults bind the **IPv6 wildcard** (`USBIP server listening addr=[::]:3241`,
`API listening addr=[::]:3242`), i.e. every interface, dual-stack, with no
authentication for localhost. Explicit `--api.addr 127.0.0.1:<p>` and
`--usb.addr 127.0.0.1:<q>` are mandatory for ksx.

## 2. Loopback protocol behaviour, no driver installed (MEASURED 2026-09-02, dev box; viiper.exe run from the session scratchpad with explicit loopback args; nothing installed)

Method: `Start-Process viiper.exe 'server --api.addr 127.0.0.1:3342 --usb.addr
127.0.0.1:3341 --api.auto-attach-local-client=false --log.level debug'`, then a
Node script opening one TCP connection per management call (`path [payload]\0`,
read to close) and raw device streams. Logs kept in the session scratchpad.

### 2.1 Management API (M-PROTO)

| Request | Reply | Round trip |
|---|---|---|
| `ping` | `{"server":"VIIPER","version":"0.7.0"}` | 3 ms (first), ≤1 ms after |
| `bus/create` | `{"busId":1}` | 1 ms |
| `bus/1/add {"type":"keyboard"}` | `{"busId":1,"devId":"1","vid":"0x2e8a","pid":"0x0010","type":"keyboard","deviceSpecific":{}}` | 1 ms |
| `bus/1/add {"type":"xbox360"}` | `{"busId":1,"devId":"1","vid":"0x045e","pid":"0x028e","type":"xbox360","deviceSpecific":{"subType":1}}` | ≤1 ms |
| `bus/remove 1` | `{"busId":1}` | ≤1 ms |

Default identities: keyboard **VID 0x2E8A / PID 0x0010** (Raspberry Pi
Foundation VID), xbox360 **VID 0x045E / PID 0x028E**, subType 1.

**Device ids are reused.** After the keyboard (devId "1") was reaped, the next
`add` on the same bus received devId "1" again; `bus/create` after `bus/remove`
returns busId 1 again. A stale `(bus, dev)` therefore can alias a newer device.
ksx must treat a `(bus, dev)` as dead the moment it observes a removal or a
failed reconnect, and must be the only client of its server.

A TCP connect that closes without sending anything (a naive port probe) makes
the server log `ERROR api handshake check error=EOF` and `ERROR api incomplete
request (no null terminator)`. Health probes must send `ping\0`.

### 2.2 Device stream (M-STREAM)

`bus/1/1\0` then raw bytes: accepted silently; the server logs `api stream
begin path=bus/1/1`. A 3-byte keyboard packet `00 01 04` (no modifiers, one
key, HID usage 0x04 = `a`) produced no feedback within 1.5 s (no host attached —
expected). Opening a stream to a **non-existent** device (`bus/1/2`) returned,
on the stream itself, one RFC 7807 line then a reset:
`{"status":404,"title":"Not Found","detail":"device 2 not found on bus 1"}` —
so a stream handshake error IS visible inline (the Rust client crate ignores it
because it never reads before sending).

### 2.3 Reaper timing (M-REAPER)

Stream closed at T; `bus/1/list` still showed the device at T+0.9 s; the server
logged `timeout: removed device (no connection) busID=1 deviceID=1` at
**T+5.00 s** (log timestamps 23:40:31.83 → 23:40:36.83), and `bus/1/list` was
empty at T+7.4 s. The bus itself survived the device's removal (`bus/list` →
`[1]`); a "bus cleanup goroutine" starts on device removal.

### 2.4 Auto-attach without the driver (M-ORPHAN) — auto-attach ON, no usbip-win2

`bus/1/add {"type":"keyboard"}` → **409** `{"status":409,"title":"Conflict",
"detail":"Failed to auto-attach device: exec: \"usbip\": executable file not
found in %PATH%"}` after 9 ms — and `bus/1/list` immediately afterwards still
listed the device; it disappeared 5.0 s later by the reaper. Log order:
`Auto-attaching localhost client via native IOCTL` → `ERROR Native IOCTL
auto-attach failed, falling back to command execution error=discovery:
usbip-win2 driver not found: No more data is available.` → `Trying fallback via
usbip executable` → `exec: "usbip": executable file not found in %PATH%`.
Startup with auto-attach on and no driver prints the two install URLs
(`github.com/vadimgrn/usbip-win2` and `github.com/OSSign/vadimgrn--usbip-win2`).
Conclusion: a 409 from `add` leaves an orphan that a client must either wait out
(5 s) or find by `bus/{b}/list` and remove.

### 2.5 Ports, config and key location (M-PORT, M-KEYDIR)

- `--api.addr 127.0.0.1:0 --usb.addr 127.0.0.1:0` works; the bound ports are
  printed once at INFO: `USBIP server listening addr=127.0.0.1:53407`, `API
  listening addr=127.0.0.1:53408`. A supervisor can parse them from stdout or
  `--log.file`.
- The password file was generated at `%APPDATA%\VIIPER\viiper.key.txt`
  (16 bytes) on first start **regardless of the working directory** (the cwd
  was an empty scratch folder; nothing was written there). `--config=STRING`
  exists, so the config file location is explicit; the key file location is not
  a flag.
- **The startup log prints the password in clear text** ("Your VIIPER API
  server password is:" followed by the 16-character password). A `--log.file`
  therefore contains the API password; ksx must treat that log as
  secret-bearing or not enable file logging on first start.
- With explicit args and a console-owning parent, the binary logs `Console
  launch detection hasConsole=true parentPID=… parentAttached=false` and runs
  as a CLI. Started with **no arguments and no console** it logs `Detected GUI
  startup, injecting 'server' argument` + `Run from a CLI for more options!`,
  binds the defaults on every interface, and enters its **system-tray mode**
  (the binary embeds fyne.io/systray and `Shell_NotifyIcon`). A ksx-spawned
  child must therefore pass explicit args and be created with a hidden console
  (`CREATE_NO_WINDOW`), not `DETACHED_PROCESS`; S2 must assert the CLI-mode log
  line.

### 2.6 Update notifications (M-UPDATE) — UNVERIFIED

`--update-notify` defaults to `stable`, and the binary embeds
`https://api.github.com/repos/Alia5/VIIPER/releases/latest` plus the message
"A new version of VIIPER is available:". Whether the server contacts GitHub at
startup is not yet measured (no such line appeared in the debug logs of the
four short runs above). ksx will pass `--update-notify=none`; S2 measures with
`--log.level trace` and a network capture.

### 2.7 The ksx client against the real server (M-CLIENT) — MEASURED 2026-09-03

`crates/ksx-viiper` (the std-only client written in S1) driven by its
`examples/probe.rs` against `viiper server --api.addr 127.0.0.1:3342
--usb.addr 127.0.0.1:3341 --api.auto-attach-local-client=false
--update-notify=none --log.level debug`, no driver installed:

| Step | keyboard | xbox360 |
|---|---|---|
| `ping` (pinned 0.7.0) | 2.5 ms | 1.6 ms |
| `bus/create` | 0.7 ms | 0.8 ms |
| `bus/1/add` | 0.7 ms | 0.6 ms |
| stream open (handshake + 100 ms refusal wait) | 115 ms | 107 ms |
| remove device + bus | 1.3 ms | 1.6 ms |

The opt-in conformance test (`cargo test -p ksx-viiper --features
viiper-live-tests` with `KSX_VIIPER_LIVE_ADDR`) passed: ping, bus and device
lifecycle, a neutral report on the stream, and the inline 404 for a stream to
device 99. With `--update-notify=none` the debug log showed no update check.
The server still logs `ERROR api handshake check error=EOF` for the TCP
connect-and-close a port probe performs (§2.1) — the supervisor must probe
with `ping `, not with a bare connect.

## 3. Facts read in upstream source (SOURCE — tag v0.7.0 and usbip-win2 master / v.0.9.7.7)

- **Server shutdown removes nothing.** `apiSrv.Close()`/`usbSrv.Close()` only
  close listeners; `VirtualBus.Close()` exists but is never called on exit. On
  the driver side, a dropped USB/IP socket triggers `async_reattach` →
  `PLUGOUT_HARDWARE_AND_REATTACH`: Windows sees a real USB removal and the vhci
  then retries the server for up to `ReattachMaxAttempts=20` with
  `ReattachFirstDelay=30` → `ReattachMaxDelay=480` seconds. A client must
  `bus/{b}/remove` every device (or `bus/remove`) before the server exits, and
  must never let the server die with devices attached.
- The device-handler timer is armed on `add` and re-armed on stream end; `0`
  fires immediately (there is no disable); the same value seeds the bus cleanup
  timeout.
- Reconnecting a stream to `bus/{b}/{d}` re-binds the **same** device object —
  no re-enumeration.
- The API server tracks **no ownership**: any client may remove any device or
  bus; there is no connection limit; there are no VIIPER-side device limits —
  the ceiling is the driver's 30 USB2 + 30 USB3 vhci ports.
- `viiper install` writes one HKCU `…\CurrentVersion\Run` value named `VIIPER`
  (`"<exe>" server --log.file "<cfgDir>\viiper.log"`); no service, no admin.
- Auto-attach uses `DeviceIoControl` (0x22E000) on the usbip-win2 vhci interface
  first, `usbip.exe attach` from PATH as fallback; the vhci device object's
  SDDL is `SDDL_DEVOBJ_SYS_ALL_ADM_RWX_WORLD_RW_RES_R`, and `usbip.exe` carries
  no `requireAdministrator` manifest → **attach needs no elevation** (to be
  confirmed on a machine with the driver, M-ADMIN).
- usbip-win2 0.9.7.7 drivers are attestation-signed (no test-signing mode); the
  README's test-signing instructions are conditional. VIIPER's installation
  page states the release installer "install[s] the publicly available test
  signing CA as a trusted root CA" and that it may be removed with certmgr
  afterwards, or that the OSSign build's `.cat/.inf/.sys` may be installed by
  hand (its installer does not work). Unmeasured for 0.9.7.7 → M-CERT.
- Wire formats (also confirmed against `viiper-client` source): xbox360 input
  20 B = u32 buttons, u8 LT, u8 RT, i16 LX/LY/RX/RY, 6 reserved (XInput wire
  shape); feedback 2 B motors, no LED byte. keyboard input = u8 modifiers, u8
  count, `count` HID usages (variable length; the 32-byte bitmap is libVIIPER's
  in-process struct only); feedback 1 B LEDs. mouse 9 B. dualshock4 31 B / 7 B.
  dualsense 33 B / 6 B. ns2pro 27 B / 34 B.
- `viiper-client` 0.7.0 (MIT): sync client is `std::net` with **no timeouts**,
  `DeviceStream::connect` never reads the handshake reply, `Drop` does
  `shutdown(Both)` + joins the reader thread, `on_disconnect` must be
  registered before `on_output`. Its `bus_create(Option<u32>)` argument is a
  requested bus id.

## 4. Measurements still to run (UNVERIFIED — need usbip-win2 on a disposable Windows 11 image)

| Id | Question | Gates |
|---|---|---|
| M-CERT | Trusted Root / TrustedPublisher diff before and after `USBip-0.9.7.7-x64.exe /S`; name + thumbprint of anything added; removable by exact thumbprint; does the driver keep working afterwards | S3 path A vs B, hard stop if test-signing is required |
| M-PNPUTIL | Do the OSSign-signed `.cat/.inf/.sys` install via `pnputil /add-driver … /install` and load under VBS | S3 path B |
| M-ADMIN | `viiper server` + auto-attach from a standard user token | S2 vs S2b |
| M-HUB / M-REBOOT | USB-hub restart during install vs a WinUSB-claimed I-PAC; reboot required | S3 wording, install-while-claimed refusal |
| M-XUSB | `xbox360` binds `xusb22.sys`; XInput index via the LT-pulse correlation; joy.cpl, Steam, SDL; `dualshock4` seen like ViGEm's DS4 | S4 remote lane design (LT pulse reuse) |
| M-LAT | submit → `XInputGetState` vs ViGEm | research only |
| M-MAME / M-UIPI / M-KEYLED | keyboard device types into Notepad and MAME (`-keyboardprovider rawinput`); reaches a UIPI-protected window; Caps-lock LED feedback arrives | S4 keyboard, GATE 5 |
| M-DIE-CLIENT | `taskkill /F` the client with a key held: device gone ≤5 s; Windows releases the key? | S4 release-all design, RECOVERY.md |
| M-DIE-SERVER | kill the server with a device attached: observe the reattach storm; does `usbip.exe detach` / the IOCTL cancel it | S2 server-death handling |
| M-RECONNECT | reconnect inside / outside 5 s keeps the same node and XInput slot | S2 reconnect supervisor |
| M-IDLE | does `--connection-timeout 30s` cut an idle device stream | S2 keepalive |
| M-COEXIST | physical pad plus a VIIPER pad: slot order | GATE 5 notes |
| M-VM | is a Hyper-V VM acceptable as GATE 5's clean host (driver loads, USB/IP works without physical USB) | GATE 5 runbook |
| M-UPDATE | network activity of `--update-notify` default vs `none` | S2 argv |

## 5. Go / no-go table

| Row | Verdict today | Slice it gates |
|---|---|---|
| M-PROTO, M-STREAM, M-REAPER, M-ORPHAN, M-PORT, M-CLIENT | MEASURED — as designed in the plan; the S1 client passes live conformance | S1 client (done), S2 supervisor |
| M-KEYDIR | MEASURED — key in `%APPDATA%\VIIPER`, password logged in clear | S2 (log handling), S4 auth |
| M-CERT, M-PNPUTIL, M-HUB, M-REBOOT | NOT RUN — need the VM | S3 (usbip path A/B) |
| M-ADMIN | SOURCE says no admin; NOT RUN | S2 / S2b |
| M-XUSB, M-LAT, M-MAME, M-UIPI, M-KEYLED, M-DIE-*, M-RECONNECT, M-IDLE, M-COEXIST | NOT RUN — need the driver | S2, S4, GATE 5 |

Machine facts for the record: Windows 11 Pro 25H2 (26200), VBS running, HVCI
not enforced; Hyper-V enabled (`vmms` running, `Get-VM` needs elevation) and
VirtualBox present; MAME available at `C:\RetroBat\emulators\mame-modern\mame.exe`;
rustc 1.97.1; no Go toolchain.
