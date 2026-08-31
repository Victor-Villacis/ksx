# Driver Story & Third-Party Terms

Deep dives: [`research/virtual-gamepad-2026.md`](research/virtual-gamepad-2026.md),
[`research/keyboard-capture-2026.md`](research/keyboard-capture-2026.md).

## Output: ViGEmBus 1.22.0 (committed)

- Attestation/HLK-signed by Nefarius Software Solutions e.U. → **unaffected** by
  Microsoft's 2026 cross-signed-trust removal.
- Project archived Nov 2023 (trademark dispute), driver frozen and stable; still the
  ecosystem default (Sunshine bundles it, DS4Windows/XOutput/JSM ship it).
- Client: vendored [`crates/vigem-client`](../crates/vigem-client) (CasualX, MIT,
  pure-Rust `DeviceIoControl`, includes `get_user_index()` + X360 notification API).
- Installer: bundled at `drivers/ViGEmBus_1.22.0_x64_x86_arm64.exe` (fetched from the
  official GitHub release v1.22.0; signer
  `CN=Nefarius Software Solutions e.U., L=Wels, C=AT`; SHA-256
  `89220A7865076B342892F98865F3499FB7C4CFD673159E89D352C360FD014C6A`). Never download
  at runtime (the old endpoints are rotting).
- **Installed by the ksx installer, from a checkbox** — see "Who runs it, and
  when" below. `ksx install-drivers` is still the verb; the setup wizard is now
  one of the two places it is run from.
- **ViGEmBus remains the compatibility foundation/fallback**, not the only future
  backend. Its shipped X360 and DS4 paths stay supported while they work.
- **HIDMaestro is the chosen rich-profile Windows backend; the 0.5.0 runtime is
  deliberately bounded.** Development sessions on 2026-08-20 created real
  HIDMaestro-backed controllers through the now-retired official-SDK runtime
  lane, including DualSense; the measured record is in
  [`HIDMAESTRO-STATE.md`](HIDMAESTRO-STATE.md). That historical evidence does
  not close the current artifact's exact-candidate physical gate. The release
  packages a fixed source-built NativeAOT privileged host and an explicit
  v1.6.1 installer-only bootstrap. The checked setup task discloses its network
  use, downloads the exact official archive, verifies pinned lengths and
  SHA-256 identities, invokes only `HMContext.InstallDriver()` in an isolated
  worker, proves its process tree stopped, and deletes the temporary SDK.
  Neither KSX nor its installer redistributes the upstream embedded WDK tools.
  Runtime supports exactly one plain-USB DualSense per session. Switch Pro,
  Xbox Series X|S, SNES and Genesis remain recognized but gated.
- **VIIPER is the complementary virtual-USB/network/Linux lane.** It is for
  software-defined controllers, keyboards and mice, including remote endpoints—not a
  replacement profile catalog. Its GPL core stays across a deliberate process boundary
  unless a future licensing review approves a different distribution design.
- **Watchlist, not roadmap dependencies:** libvirtualhid has a useful cross-platform
  API but its Windows driver/broker is commercially licensed; Nefarius VirtualPad is
  commercial partner-only; WinUHid would make KSX responsible for building, signing
  and maintaining a Windows driver; vJoy is a generic DirectInput path.

No future backend in this list is bundled or enabled merely because it appears here.
The current release ships ViGEmBus plus the bounded HIDMaestro DualSense lane.
VirtualHere is a proprietary external
raw-USB forwarding product and could be an optional user-installed/OEM integration;
it is not an output dependency and cannot be vendored under its standard license.

### Expired signing certificate — accepted, because a verified timestamp covers it

The bundle's signing certificate **expired 2025-02-16**. The chain verifies and
the signer is right; the certificate simply aged out, as code-signing certificates
do — they are issued for a year or two and the binaries they sign outlive them.

M5 originally refused on that alone ("currently-valid certificate" as the bar for
anything running elevated), which made **the committed bundle un-installable by
ksx at all**. That rule is now gone. Since 2026-08-04 the policy is Windows':

> An expired certificate is accepted **if, and only if, a timestamp
> countersignature proves the file was signed while the certificate was still
> valid.** No timestamp, no acceptance.

Recorded by `ksx install-drivers --dry-run` against the pinned bundle:

```
sha256        [OK]   89220A7865076B342892F98865F3499FB7C4CFD673159E89D352C360FD014C6A
authenticode  [OK]   expired-timestamp-verified, signer Nefarius Software Solutions e.U.
certificate          valid 2023-03-13T00:00:00Z .. 2025-02-16T23:59:59Z  (EXPIRED)
timestamp     [OK]   signed 2023-11-02T16:32:03Z, countersigned by DigiCert Timestamp 2023
```

#### Why this, and not one of the other options

The three candidates were: re-pin a newer ViGEmBus release, relax the rule, or
tell people to install by hand.

- **A newer release** would be cleanest and does not exist. ViGEmBus was archived
  in Nov 2023; nobody is going to re-sign 1.22.0.
- **Refusing outright** sounds like the safe default and is not. `ksx doctor` says
  "run `ksx install-drivers`", `install-drivers` refuses its own bundle, and the
  only way forward left is double-clicking the same `.exe` from an admin prompt —
  with **no** hash check, **no** signer check, and no sealed handle. The refusal
  did not prevent that install; it just removed every check from it. A policy that
  routes users around itself is worse than the thing it was guarding against.
- **Verifying the timestamp** keeps both pins live on the path people actually
  take, and matches what the operating system concludes about the same file. The
  cost is one honest relaxation instead of a rule nobody can comply with.

Expiry is also *not* the same problem as the cross-signed kernel driver below:
that one is `keyboard.sys`'s 2012 cross-cert versus the 2026 CI policy, a
kernel-mode trust anchor being withdrawn. This is a user-mode WiX bootstrapper's
leaf cert reaching its ordinary end of life. `ksx doctor` still warns about the
former, loudly.

#### What "verified" means here — four checks, not a shrug

A countersignature is a *claim* ("this file was signed at T"). Trusting it
unexamined would be theatre, so `ksx install-drivers` accepts an expired
certificate only when all four of these hold
(`crates/ksx-platform/src/report.rs`, `TimestampInfo::problem`):

1. the countersigner is a **timestamp** countersigner (`SGNR_TYPE_TIMESTAMP`) and
   not some other unauthenticated attribute;
2. its **own certificate chain verified** — the timestamping authority is one
   Windows trusts (`dwError == 0`);
3. the authority's certificate was **itself valid at the instant it claims to have
   stamped** — a TSA vouching for a moment outside its own life vouches for
   nothing;
4. the stamped instant falls **inside the signing certificate's `NotBefore` ..
   `NotAfter` window** — the actual question being asked.

Any one of them failing is a refusal, and the message names which one. A
certificate whose validity window could not be read at all fails closed: unknown
is not the same as valid.

All of it is read from a **single `WinVerifyTrust` call against the sealed
handle** (`WINTRUST_FILE_INFO.hFile`), through
`CRYPT_PROVIDER_SGNR::pasCounterSigners`. `CryptQueryObject` is deliberately not
used: it accepts only a path or a blob, so reaching for it would mean a second
`open()` and would re-open the time-of-check/time-of-use gap the sealed handle
exists to close. One open, one check, no gap.

#### The states, and their codes

`--json` reports `installer.signature_code`; the same string appears on the
`authenticode` line. The first three are the certificate states, and they stay
three distinct states rather than collapsing into one boolean:

| code | meaning | installable |
|---|---|---|
| `valid` | chain verifies, certificate still inside its window | yes |
| `expired-timestamp-verified` | certificate expired; a timestamp passing all four checks dates the signature inside the window | yes — **this is the committed bundle** |
| `expired-no-valid-timestamp` | certificate expired and no countersignature survives checking (or there is none) | **no** |
| `wrong-signer` | chain verifies, but it is not Nefarius | no |
| `chain-not-trusted` | the chain itself does not verify | no |
| `unsigned` | no Authenticode signature at all | no |

`installer.signature` carries the raw evidence — chain status, both ends of the
certificate window, the timestamp instant, the authority, and each of the four
checks individually — so a script can re-derive the verdict instead of trusting
it. An accepted-but-expired bundle is announced in the human output as a `note:`,
never waved through silently.

Nothing else was relaxed. A bad hash, the wrong signer, an untrusted chain or an
unsigned file are refused exactly as before, and `WinVerifyTrust` returning
`CERT_E_EXPIRED` — Windows' own "no acceptable timestamp" answer — is refused too,
so ksx can never be *more* permissive than the platform whose behaviour it
matches.

### Where `install-drivers` will look for the bundle

When the process is **elevated**, the search is restricted to directories a
standard user cannot write: `%ProgramFiles%`, `%ProgramFiles(x86)%`,
`%ProgramW6432%`, `%SystemRoot%` and anything beneath them. A candidate outside
those roots is listed as `[SKIP]` with the reason, never silently ignored.

This is a **prefix policy, not a live ACL evaluation** — an administrator who
has loosened the ACL on `C:\Program Files\ksx` gets no warning from us. It fails
closed on the case that matters: a build tree under `C:\Users\…`, a downloads
folder, a USB stick, or a `C:\drivers\` next to a dev build, any of which a
standard user could populate and then have an admin execute. `%ProgramData%` is
deliberately **not** treated as protected: its default ACL lets `Users` create
files.

When the process is **not** elevated the restriction is off, so a development
build still finds the repo's `drivers/` directory — and cannot reach an
executable verdict anyway (`NeedsElevation` comes first), so nothing can be run
from an unprotected path in either case.

The verified file is opened once with `FILE_SHARE_READ` (writers and deleters
denied), hashed and signature-checked through that handle, and the handle is held
across `CreateProcess`, which targets the path `GetFinalPathNameByHandleW`
reports for it. The bytes that were checked are the bytes that run.

### Who runs it, and when

Two places, one verb.

| where | how | consent |
|---|---|---|
| The setup wizard (`packaging/ksx.iss`) | a `[Tasks]` checkbox, **ticked by default**, running `ksx install-drivers --yes` at `ssPostInstall` | the checkbox, plus the UAC prompt setup already raised |
| A terminal | `ksx install-drivers --yes`, elevated | `--yes`, plus the elevated prompt the user opened |

The wizard was added because the alternative was a lie by omission. The
installer shipped this file to `{app}\drivers` and never ran it, so a machine
that had never had ViGEmBus produced a ksx that installed cleanly, staged a
setup, saved it, and plugged nothing — and the only fix was a shell command, on
a product whose acceptance test (`docs/FIRST-RUN.md` §7) is *no terminal*.
`ksx install-drivers` needs an administrator token and that verb never
self-elevates, so setup — already elevated, already consented to — is the right
moment for ViGEmBus. The later WinUSB flow is a distinct fixed-purpose UAC
boundary with its own three confirmations; it does not reuse this installer
verb or consent.

**Nothing about the checks was relaxed to do it.** The wizard runs the *verb*,
not the bundled `.exe`: the protected-directory search, the sealed handle, the
SHA-256 and the Authenticode policy above all still decide, and a bundle that
fails any of them is refused from the wizard exactly as from a shell. Running
the `.exe` directly would have been one line of Pascal and would have deleted
every guarantee on this page; `crates/ksx-app/tests/installer.rs` asserts the
file name appears only on a `Source:` line.

**And it is not silent.** `docs/DRIVERS.md`'s original objection — "an installer
that silently installed a kernel driver would throw away both pins and the
consent" — was right about the consent and is answered rather than overruled:
the box says which driver and what it is for, clearing it is honoured, and a
user who clears it is told on the last page how to get the driver later. A
failure never fails the install, because a machine with no ViGEmBus still wants
the ksx that configures and maps; the wizard says what happened, names the
retry, and continues.

Because the plan is idempotent, both a re-install and an upgrade cost one
process start and change nothing: a healthy ViGEmBus yields `already-installed`,
which runs nothing. The one machine the wizard does act on beyond a first
install is a **broken** one — a registered service whose `ViGEmBus.sys` is gone,
which is what `ksx doctor` already tells people to fix this way.

## Capture: installed built-in WinUSB, optional Interception

### Built-in Windows USB mode (backend: `winusb`)

The supported product path is the installed Studio product page `/redesign`
(the capture card beside the keyboard you selected), not a WDK,
Zadig, Device Manager, or a command the customer types. A user selects one exact
supported USB keyboard and confirms all three facts before anything elevated
runs:

1. a different keyboard is connected and was tested typing;
2. the selected keyboard will stop ordinary typing until it is released; and
3. KSX may add a machine-local public certificate used only to sign this
   computer's generated device package.

Windows then shows UAC. No console is allocated: the unelevated process locates
only its canonical fixed sibling `ksx-winusb-helper.exe`; the elevated helper
locates only its canonical fixed sibling `libwdi.dll`. Both sides require the
Windows Program Files Known Folder and recheck live owner/DACL/reparse safety on
the directory and files. No caller-controlled path or browser backend field
crosses the elevation boundary. A portable, development, moved, substituted, or
user-writable copy refuses.

The exact keyboard interface is rebound from the keyboard stack to Microsoft's
in-box, WHQL-signed `winusb.sys`; KSX then reads its HID interrupt reports with
`nusb`. Blocking and identity become structural: Windows no longer sees that
interface as a keyboard, and the interface instance identifies one physical
device. Composite siblings such as an I-PAC trackball remain on their original
drivers.

**Exact-device safety is part of the transaction, not page copy.** Immediately
before mutation, the elevated side resolves the full live USB interface again
and refuses a stale selector, an unsupported/non-keyboard interface, an
ambiguous interface, a hardware ID shared by another connected device, or the
last separately connected keyboard that can type now. Because Windows driver
packages match hardware IDs, connect and prepare one model at a time: release
the prepared device before connecting another identical keyboard. The browser
never guesses a device and never supplies a backend.

The transaction journals into the SYSTEM/Administrators-only **mutation**
boundary at `%ProgramData%\KSX\WinUSB` before it creates a package and again before
`pnputil`. After installation it re-enumerates the exact interface and accepts
success only when the fresh binding is WinUSB and the matching ownership receipt
is Active. The API boundary calls that state exactly `prepared`; helper stdout
and exit success alone are not evidence. Any error after journaling is
compensated when possible or preserved as `recovery-required` with the receipt
needed to finish safely. A reboot request is recovery-required, never success.
The standard-user application receives read-only receipt state through the
typed boundary; it cannot write the protected transaction journal.

Release is the inverse receipt-owned transaction. It deletes only the receipt's
recorded OEM package, but Windows packages match a hardware ID rather than one
instance. If an identical keyboard was connected after preparation, unplug it
before using Studio Release; Studio refuses an ambiguous live selector. Package
removal also prevents that twin from using the KSX package when it is
reconnected. Release proves the package absent, rescans and proves the selected
interface is back on HidUsb, then removes the exact certificate and artifacts.
The API returns `released` only after that fresh survey. The Studio
stage changes to `winusb` or back to `interception` only after those canonical
results and an expected-selector guard; a failure leaves the stage unchanged.

Uninstall treats the helper and provider as recovery components. Before Inno
removes any program file, the elevated helper audits every receipt state,
including interrupted, recovery-required, terminal and disconnected-device
records, plus orphaned KSX certificate/key namespaces. It releases only
provably KSX-owned material and proves absence. Ambiguity or incomplete cleanup
aborts uninstall and preserves the recovery components and journal.

#### The generated catalog and machine-local certificate

`winusb.sys` itself needs no redistribution or new kernel signature. The
generated one-interface INF still requires a signed catalog on x64 Windows, so
the installed prepare-only libwdi provider creates it locally without a WDK or
network download. It accepts only KSX's exact opened template and produces a
catalog whose only member is that INF with a SHA-256 digest.

Each transaction uses a unique subject `CN=KSX WinUSB <32hex>` and a fresh
4096-bit non-exportable key. The provider signs while the certificate is still
untrusted, deletes the private-key container and proves it absent, and only then
may the public certificate enter Local Machine Root and TrustedPublisher. The
Rust caller independently checks exact DER, thumbprint, subject, store placement
and absence of private-key properties/containers before package installation.
Release and uninstall delete that exact identity from both stores and prove it
absent; they never delete broadly by a friendly subject prefix.

#### Cleaning certificate residue without releasing a working panel

An interrupted or older completed transaction can leave its public certificate
after no installed package needs it. The residue is visible on Studio's Devices
page and from the read-only default command:

```powershell
ksx winusb sweep-certificates
ksx winusb sweep-certificates --yes
```

Only the second form elevates. It removes no package and changes no device
binding, so it is deliberately distinct from `release-all`. It also removes
stranded key containers in KSX's fixed one-time signing namespace; installed
driver packages need only their retained public signer certificate. Classification
joins each installed KSX package to the signer reported by the Driver Store,
not to an INF filename. A matching signer is kept. An installed package with no
readable signer blocks every deletion, as does a subject that resolves to
different certificate bytes. Safe candidates
are deleted only by their exact subject, thumbprint and DER hash through the
fixed installed helper, and the unelevated caller re-reads the stores before it
reports success.

`bcdedit /set testsigning on` remains rejected. It would weaken Secure Boot
policy machine-wide to solve a one-device package problem the installed
transaction already handles narrowly.

### Interception (backend: `interception`, optional and not redistributed)

- `keyboard.sys`/`mouse.sys` are cross-signed with a certificate that expired
  2012-10-21; Windows 11's 2026 servicing rolls out audit-then-enforcement
  removal of cross-signed trust. `ksx doctor` reports that state.
- The external driver has a 10-keyboard device-ID space and a dual/non-commercial
  binary licence. KSX therefore does not redistribute or install it.
- `ksx.exe` dynamically loads `interception.dll` only when a configured device
  needs that backend. A clean install starts without it. If another application
  has already installed a healthy compatible copy, Studio may use it and offers
  built-in USB mode as a secondary choice rather than blocking Play.
- For a USB keyboard, Interception readiness must correlate the selected
  interface's exact selector and instance. Model-wide availability cannot make
  a different connected board ready.
- Bluetooth has no USB interface for built-in preparation. Bluetooth keyboard
  capture is therefore unavailable on a clean install; an already healthy
  external Interception installation is the only current capture path for it.

### Hardware escape hatch (documented, not built)

I-PAC Multi-Mode firmware 1.5x can present as **2 XInput pads per board** with zero
software. Costs per-key remapping and caps at 2 pads/board — escape hatch, not plan.

## License matrix

| Component | Where | License |
|---|---|---|
| Original KSX material | Rust/TypeScript source, docs, scripts, packaging, tests, tools, and original brand work | MIT OR Apache-2.0 |
| vigem-client (vendored) | `crates/vigem-client` | MIT (full text preserved) |
| ViGEmBus driver + installer | bundled in releases | BSD-3-Clause (redistribution OK) |
| Interception `interception.dll` + drivers | installed separately by the user; KSX does not redistribute them | upstream dual/non-commercial terms, API-boundary only |
| kanata-interception 0.3.0 | crates.io dependency compiled into `ksx.exe` | MIT OR Apache-2.0 |
| interception-sys 0.1.3 | crates.io dependency compiled into `ksx.exe`; the external DLL remains dynamically loaded | LGPL-3.0 |
| FormaJS core 2.0.0 | runtime embedded in Studio JavaScript | MIT |
| forma-ir / forma-server 0.2.0 | crates.io dependencies compiled into `ksx.exe` | MIT |
| `winusb.sys` (M6 capture) | in-box, `%SystemRoot%\System32\drivers` | Microsoft, ships with Windows — nothing to redistribute, nothing to license |
| `ksx-winusb-helper.exe` | installed beside `ksx.exe`; omitted from portable builds | MIT OR Apache-2.0; GUI subsystem, fixed elevated transaction boundary |
| KSX prepare-only `libwdi.dll` + corresponding source | installed beside the helper + `THIRD-PARTY-SOURCE\libwdi`; omitted from portable builds | LGPL-3.0-or-later; dynamically replaceable narrow provider |
| ksx-generated WinUSB package, receipt and public certificate | protected `%ProgramData%\KSX\WinUSB`; generated only after explicit Studio consent/UAC | machine-local transaction material; removed by verified Release/uninstall cleanup |
| HIDMaestro v1.6.1 integration | HIDMaestro-authored material is MIT; the exact official release is downloaded only by the checked setup task, verified before execution, and deleted afterward | KSX does not redistribute the release or its Microsoft SDK/WDK dependencies; the task requires internet and existing setup elevation |

This table calls out the driver-facing and Forma components. The complete
locked Rust runtime graph — including every transitive crate, version,
repository, selected SPDX license, and full license text — is generated at
`THIRD-PARTY-LICENSES/Rust-dependencies.html`. Copied art, vendored source, and
binary payloads are mapped in `NOTICE`; their full texts are beside that report.
`Cargo.lock` pins package versions and checksums, not license text.
