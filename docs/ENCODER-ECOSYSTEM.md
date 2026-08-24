# Encoder ecosystem, licensing and provider admission

**Verified snapshot: 2026-08-23 EDT.**

This document records what KSX can safely recognize, what it can currently
program, and what must be measured before another hardware writer is admitted.
The detailed live I-PAC 4 record remains in
[`PANEL-PROGRAMMING-STATE.md`](PANEL-PROGRAMMING-STATE.md).

## Decision

An arcade encoder is not necessarily a keyboard internally. It may present one
or more keyboard, DInput, XInput, mouse or vendor HID collections. Generic HID
inventory and live input learning can therefore expose most boards without a
vendor driver, but a board's physical-terminal chart is vendor- and
firmware-specific.

Ultimarc likewise states that I-PAC input uses the operating system's built-in
HID support and that there are no Ultimarc input drivers; WinIPAC is a board
configuration utility, not a required input driver. See the manufacturer's
[I-PAC 4 product and configuration page](https://www.ultimarc.com/control-interfaces/i-pacs/i-pac4-board/).

KSX consequently has no “universal encoder writer.” Unknown hardware remains
useful for passive identity and live input. Persistent configuration is enabled
only by an exact, measured protocol profile.

## Verified repository matrix

“Read” and “write” below mean the board's stored configuration, not ordinary
HID input events.

| Primary source | Last activity | License | Evidenced devices / USB identity | Configuration evidence | KSX use |
|---|---:|---|---|---|---|
| [`padelj/ipacutil`](https://github.com/padelj/ipacutil) | [2013-07-02](https://github.com/padelj/ipacutil/commit/d4781191e15648a411372fe18fca002da921952d) | GPL-2.0-or-later in [source headers](https://github.com/padelj/ipacutil/blob/d4781191e15648a411372fe18fca002da921952d/ipac_prog.h#L7-L18) | Exact `D209:0301` and `D208:0310`; CLI models I-PAC2, I-PAC4, I-PAC VE and Mini-PAC VE ([IDs and board table](https://github.com/padelj/ipacutil/blob/d4781191e15648a411372fe18fca002da921952d/ipac_prog.h#L36-L105)) | **Read: no. Write: yes.** Persistent/RAM/reset through vendor requests `E9`, `EB`, `EA`; model detection itself sends an invalid-checksum RAM programming probe ([transfer](https://github.com/padelj/ipacutil/blob/d4781191e15648a411372fe18fca002da921952d/ipac_prog.c#L48-L270), [detection](https://github.com/padelj/ipacutil/blob/d4781191e15648a411372fe18fca002da921952d/ipac_prog.c#L285-L340)) | Legacy protocol facts only. Never use its mutating detection during discovery. |
| [`katie-snow/Ultimarc-linux`](https://github.com/katie-snow/Ultimarc-linux) | [2022-06-13](https://github.com/katie-snow/Ultimarc-linux/commit/20b8c56a3e6f94034b8529eddd777306f5b6152b) | [GPL-2.0-or-later](https://github.com/katie-snow/Ultimarc-linux/blob/20b8c56a3e6f94034b8529eddd777306f5b6152b/debian/copyright#L4-L25) | Pre-2015 `D208:0310`; 2015-era UIO/I-PAC2/I-PAC4/Mini-PAC/J-PAC `D209:0410/0420/0430/0440/0450`, plus UltraStik, output devices and U-HID ([I-PAC IDs](https://github.com/katie-snow/Ultimarc-linux/blob/20b8c56a3e6f94034b8529eddd777306f5b6152b/src/libs/ipac.h#L20-L28), [udev IDs](https://github.com/katie-snow/Ultimarc-linux/blob/20b8c56a3e6f94034b8529eddd777306f5b6152b/21-ultimarc.rules)) | **PAC read: no. Write: yes.** Its 2015 writer sends 260 bytes as report `03` plus four payload bytes using HID class request `0x21/9`, value `0x0203`, interface 2 or 3 ([constants](https://github.com/katie-snow/Ultimarc-linux/blob/20b8c56a3e6f94034b8529eddd777306f5b6152b/src/libs/ipacseries.h#L20-L25), [writer](https://github.com/katie-snow/Ultimarc-linux/blob/20b8c56a3e6f94034b8529eddd777306f5b6152b/src/libs/ipacseries.c#L1243-L1320)) | Identity and protocol facts only; old generic writes do not prove a current board/profile. |
| [`katie-snow/QtPyUltimarc`](https://github.com/katie-snow/QtPyUltimarc) | [2026-01-25](https://github.com/katie-snow/QtPyUltimarc/commit/6f1f5a285201143e6260f0a1451ca469a54ee768) | [GPL-3.0](https://github.com/katie-snow/QtPyUltimarc/blob/6f1f5a285201143e6260f0a1451ca469a54ee768/LICENSE) | `D209` PID prefixes `041x/042x/043x/044x/045x`, UltraStik, USB Button and AimTrak; it does not discover legacy `D208` boards ([mapping](https://github.com/katie-snow/QtPyUltimarc/blob/6f1f5a285201143e6260f0a1451ca469a54ee768/ultimarc/devices/_base.py#L29-L61), [vendor filter](https://github.com/katie-snow/QtPyUltimarc/blob/6f1f5a285201143e6260f0a1451ca469a54ee768/ultimarc/tools/__init__.py#L16-L20)) | **Read and write code:** I-PAC2/4, Mini-PAC, J-PAC and UIO. Read sends `03 59 DD 0F 00` on interface 2 and collects a 256-byte structure from endpoint `84` ([I-PAC4](https://github.com/katie-snow/QtPyUltimarc/blob/6f1f5a285201143e6260f0a1451ca469a54ee768/ultimarc/devices/ipac4.py#L83-L124), [read loop](https://github.com/katie-snow/QtPyUltimarc/blob/6f1f5a285201143e6260f0a1451ca469a54ee768/ultimarc/devices/_device.py#L370-L400)). A Mini-PAC user reported successful read/write on hardware in [issue 44](https://github.com/katie-snow/QtPyUltimarc/issues/44#issuecomment-1883457094). | Best current behavioral reference, still alpha and not a KSX dependency. Every model/release requires KSX measurement. |
| [`greeeny101/ipac-config`](https://github.com/greeeny101/ipac-config) | [2026-08-22](https://github.com/greeeny101/ipac-config/commit/bf4f2a6a6f1a2753f31fb5cdfc5e107fa861b480) | **No license in the [pinned tree](https://github.com/greeeny101/ipac-config/tree/bf4f2a6a6f1a2753f31fb5cdfc5e107fa861b480); not reusable OSS** | I-PAC2 `D209:0420` keyboard and measured `D209:0421` DInput; other I-PAC families are recognized only to refuse them ([identity table](https://github.com/greeeny101/ipac-config/blob/bf4f2a6a6f1a2753f31fb5cdfc5e107fa861b480/ipacconf.py#L47-L69)) | **Read and write measured on one real I-PAC2.** It reports that a 256-byte write is silently discarded and pads the 256-byte image to 260 bytes / 65 reports ([protocol](https://github.com/greeeny101/ipac-config/blob/bf4f2a6a6f1a2753f31fb5cdfc5e107fa861b480/README.md#L227-L235), [hardware status](https://github.com/greeeny101/ipac-config/blob/bf4f2a6a6f1a2753f31fb5cdfc5e107fa861b480/README.md#L327-L355)) | Measurement lead only. Copy no code, tables, schemas or tests without a license grant. |
| [`benbaker76/PacDriveSDK`](https://github.com/benbaker76/PacDriveSDK) | [2023-08-22](https://github.com/benbaker76/PacDriveSDK/commit/e39089a9ed83b976b8fd8be59d7d38b70e8fa2be) | [MIT](https://github.com/benbaker76/PacDriveSDK/blob/e39089a9ed83b976b8fd8be59d7d38b70e8fa2be/license.txt) | `D209`: PacDrive `1500`, U-HID `1501–1508`, NanoLED `1481–1484`, PacLED64 `1401–1408`, UIO `0410–0413`, ServoStik `1700`, USB Button `1200` ([IDs](https://github.com/benbaker76/PacDriveSDK/blob/e39089a9ed83b976b8fd8be59d7d38b70e8fa2be/dll/PacDrive.h#L36-L61)) | No I-PAC2/Mini/J-PAC map read. It controls outputs, writes U-HID `.raw` data with post-write comparison, and writes USB Button configuration ([U-HID implementation](https://github.com/benbaker76/PacDriveSDK/blob/e39089a9ed83b976b8fd8be59d7d38b70e8fa2be/dll/PacDrive.cpp#L690-L779), [API](https://github.com/benbaker76/PacDriveSDK/blob/e39089a9ed83b976b8fd8be59d7d38b70e8fa2be/README.md#L234-L273)) | Permissive reference for future output/U-HID providers with the MIT notice retained. It is not an I-PAC chart driver. |
| [`benbaker76/UltraStikSDK`](https://github.com/benbaker76/UltraStikSDK) | [2023-08-13](https://github.com/benbaker76/UltraStikSDK/commit/5f13f01684478ced7c2246e7ee52278530f84be2) | [MIT](https://github.com/benbaker76/UltraStikSDK/blob/5f13f01684478ced7c2246e7ee52278530f84be2/license.txt) | `D209:0501–0504` old and `D209:0511–0514` new | **Current-map read: no. Write: yes.** Maps, restrictor, RAM/flash and device ID; old devices use the `E9/EB/EA` transaction family ([protocol and IDs](https://github.com/benbaker76/UltraStikSDK/blob/5f13f01684478ced7c2246e7ee52278530f84be2/dll/UltraStik.cpp#L15-L62), [API](https://github.com/benbaker76/UltraStikSDK/blob/5f13f01684478ced7c2246e7ee52278530f84be2/README.md#L31-L103)) | Permissive reference for a separate joystick-map provider, after hardware safety gates. |

The newer [macOS `jonasjohansson/ultimarc` port](https://github.com/jonasjohansson/ultimarc/tree/ba05cfc2c90f35d9db4027ee0f4c37553c58d862)
is a [GPL-2.0](https://github.com/jonasjohansson/ultimarc/blob/ba05cfc2c90f35d9db4027ee0f4c37553c58d862/LICENSE)
derivative of Ultimarc-linux. It demonstrates cross-platform libusb feasibility
but adds no independent current-chart read evidence.

The 256/260-byte disagreement is not a documentation typo to normalize away.
KSX measured that its exact I-PAC 4 profile accepts a 256-byte / 64-report
write, while the separately measured I-PAC2 source above requires 260 bytes /
65 reports. Image length and commit boundary are model- and release-scoped
profile facts.

## Corrections to the initial research

- No primary repository or manufacturer link substantiates an Ultimarc arcade
  project named **`pacutil`**. Do not make it a dependency or product claim.
- No primary repository substantiates a separate **`lipac` / “Linux IPAC”**
  encoder utility. The name appears to conflate `ipacutil` with
  Ultimarc-linux.
- The verified legacy project is **`ipacutil`**. Its own
  [manual](https://github.com/padelj/ipacutil/blob/d4781191e15648a411372fe18fca002da921952d/doc/ipacutil.8#L6-L54)
  says Linux, USB only and no PS/2 support. It writes boards; `--write_cfg`
  creates a default file and does not read the current EEPROM chart.
- A comment mentioning J-PAC in old `ipacutil` source is not a distinct tested
  J-PAC implementation. Do not convert comments into compatibility claims.

## KSX clean-room boundary

KSX remains permissively licensed under [`LICENSE-MIT`](../LICENSE-MIT) and
[`LICENSE-APACHE`](../LICENSE-APACHE). The engineering boundary is:

- copy no GPL or unlicensed implementation code, lookup-table expression,
  schema, tests, artwork or UI assets;
- do not link, import, vendor, bundle or ship `ipacutil`, Ultimarc-linux,
  QtPyUltimarc, the macOS derivative, or unlicensed `ipac-config`;
- record functional facts—VID/PID values, HID request fields, report sizes,
  endpoints and observed behavior—then independently author Rust code and KSX
  tests against Windows APIs and KSX-owned hardware captures;
- retain license and copyright notices if MIT SDK material is ever copied or
  adapted, and inventory any third-party files separately; and
- treat an optional external GPL CLI integration as a separate future legal
  and product decision, not as a shortcut around this boundary.

This is an engineering distribution policy, not legal advice.

## Capability-provider architecture

The implemented seam in
[`panel_catalog.rs`](../crates/ksx-backend/src/panel_catalog.rs) deliberately
separates recognition from authority:

```text
passive USB/HID inventory
  → exact family recognition (VID/PID; no report traffic)
  → exact protocol-profile admission (family + bcdDevice + HID topology)
  → family driver/provider with declared capabilities
  → shared plan / backup / journal / write / reread / restore transaction
```

Every provider declares only measured capabilities: `can_identify`,
`can_report_mode`, `can_read_chart`, `can_write_chart` and
`write_is_persistent`. Future non-chart providers should add equally narrow
facts such as LED output, RAM map, flash map or device-ID control rather than
pretending those operations are panel-chart programming.

A recognized family without an admitted profile is identify-only. An unknown
board stays visible through generic HID metadata and live input learning. No
probe may write. Studio should render an encoder panel and the causal chain
`terminal → onboard action → Windows HID event → KSX route → virtual control`,
not invent a QWERTY keyboard as the hardware.

## Implemented now

The current catalog recognizes only these exact pairs; source projects' wider
PID ranges or prefix matchers are not silently inherited.

| Family | Exact VID:PID | Identify | Read chart | Write chart | Report mode |
|---|---|---:|---:|---:|---:|
| Legacy I-PAC series | `D208:0310` | Yes | No | No | No |
| I-PAC Ultimate I/O | `D209:0410` | Yes | No | No | No |
| I-PAC 2 | `D209:0420` | Yes | No | No | No |
| I-PAC 4X | `D209:0430` | Yes | Profile-dependent | Profile-dependent | No |
| Mini-PAC | `D209:0440` | Yes | No | No | No |
| J-PAC | `D209:0450` | Yes | No | No | No |
| U-HID | `D209:1501` | Yes | No | No | No |

The sole admitted writer is `ipac4-pac256-v1`:

- family `D209:0430`, raw `bcdDevice 0x0056`;
- one unique `MI_02` collection with usage `0001:0000` and exact five-byte
  input/output reports;
- report ID `03`, query `03 59 DD 0F 00`;
- exactly 64 response frames / 256 bytes and refusal of a 65th frame;
- readback header `50 DD 56`, write header `50 DD 0F`;
- 56 modeled terminals, lossless preservation of unedited/opaque bytes; and
- persistent write capability with immutable backup, hash-bound consent,
  durable journal, complete reread equality and verified restore.

Those facts are enforced in
[`panel_programming.rs`](../crates/ksx-backend/src/panel_programming.rs) and
were measured on the named hardware recorded in
[`PANEL-PROGRAMMING-STATE.md`](PANEL-PROGRAMMING-STATE.md). The friendly
firmware label `1.56` is profile-scoped from the raw release; KSX has not
queried the vendor mode. Physical switch emission and unplug/power-cycle
persistence remain separate acceptance checks.

### Studio flow implemented 2026-08-23 EDT

- Encoder rows open a capability inspection first. A family match alone never
  opens a chart or sends a report.
- The measured I-PAC 4 profile opens Hardware Setup only when
  keyboard-compatible input and one exact available configuration collection
  are both present. A missing mode, missing/ambiguous collection, or stale
  topology stays visibly blocked until refresh.
- Hardware Setup keeps the causal journey visible:
  `terminal → Windows key → KSX transform/macro → virtual controller → game`.
- **Build physical panel** generates joysticks and buttons from the chart read
  from the board. Each physical component shows its terminal and configured
  Windows key, but remains unverified until Teach observes that real signal.
  A four-channel stick stays partially taught until all expected directions
  have been observed.
- Recognition-only families still receive the independent panel Builder,
  live Teach, and Route workflows. They do not receive chart actions.
- Studio's generated panel and capability boundaries are pinned in
  [`canvas-controls.test.mjs`](../studio-ui/pwtest/canvas-controls.test.mjs);
  the backend catalog and operation-specific read/write admission are pinned
  in Rust tests.

## Gates for every additional writer

No source-code implementation, shared VID, similar product name or successful
read on another operating system satisfies these gates. Before adding a
persistent `can_write_*` capability, KSX must retain reproducible artifacts
for:

1. exact VID, PID, `bcdDevice`, mode-dependent PID and physical USB path;
2. exact Windows HID interface/collection, usage, report lengths and exclusive
   open behavior;
3. two matching, non-mutating complete reads, including the exact header and
   image/frame boundary—64 versus 65 reports for current PAC-family leads;
4. a lossless decode/encode round trip and model-correct semantic schema or
   terminal table that preserves every unknown byte;
5. an immutable full pre-write backup that reopens and validates before packet
   zero;
6. the smallest reversible, noncritical semantic change, complete readback
   equality and physical input/Teach verification where the device emits input;
7. exact restore of the safety backup with another complete readback;
8. unplug/replug and power-cycle persistence measurement;
9. timeout, cancellation, disconnect, competing-client and interrupted-write
   recovery tests; and
10. a new exact profile entry. A family-level recognizer never acquires another
    profile's writer.

Candidate-specific blockers are:

| Candidate writer | Additional measured gate before admission |
|---|---|
| I-PAC 4, another release or mode PID | Re-measure collection topology, header, image/report count and mode availability. Do not inherit release `0056`; XInput may not expose configuration. |
| I-PAC 2 `0420` / DInput `0421` | Independently reproduce the Windows read/write path and the reported 260-byte / 65-report commit requirement for each exact release and mode; build and verify the I-PAC2 terminal table. |
| Mini-PAC / J-PAC | Measure each distinct terminal layout, interface, release/mode PID and 256-versus-260 boundary. QtPy code or one Mini-PAC report is evidence to test, not profile admission. |
| Ultimate I/O | Measure its 48-input chart independently and split chart programming from its 96 LED outputs; neither capability authorizes the other. |
| Legacy `D208:0310` or `D209:0301` | Establish passive model identity plus a complete non-mutating read and exact restore. The `ipacutil` bad-checksum probe is forbidden; without lossless backup/restore, no persistent writer is admitted. |
| U-HID `1501–1508` | Establish exact PID/release schema and a full pre-write read/backup, not only post-write comparison of a U-Config `.raw` file. |
| UltraStik `050x/051x` | Qualify old and new transports separately; prove a RAM-only map first, then current-map recovery, flash readback and power-cycle persistence before enabling flash writes. |
| PacDrive, PacLED64, NanoLED, ServoStik or USB Button | Implement a separate output/config provider with exact device capabilities, bounds and safe cleanup. Persistent script, ID or button-config commands require their own readback/restore evidence and must never appear as an I-PAC chart writer. |

Until a row clears its gates, KSX may recognize it, explain its observed HID
behavior and teach live controls, but must refuse the unsupported hardware
verb rather than guess.
