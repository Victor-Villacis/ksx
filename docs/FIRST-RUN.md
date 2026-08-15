# First run: download to gaming, with no CLI and no TOML

The product is for **someone who is not us**. They have a keyboard, a game, and
no interest in device instance paths. This file is the flow they walk, stated as
a spec, and it is the acceptance test for whether ksx is a product or a toolkit
with a web page attached.

Written 2026-08-08 from the owner's description. The original audit found an
installer that offered `ksx doctor`, five jargon-heavy Start-menu entries, and
a split-vs-freeze choice reachable only by editing TOML. Those findings are
historical: the product flow described below is now implemented. The physical
fresh-user acceptance in §7 remains the release gate.

> **The CLI is a development surface and is not the product.** Existing
> `ksx <verb>` contracts stay complete and documented, and new backend
> capabilities should get a CLI driver. The current matrix is honest about two
> debts: `ksx stage` and `ksx games new|update|delete` remain planned while their
> typed backend contracts and Studio faces exist (`docs/SURFACES.md` §3c and
> §10). The installer advertises neither, and no step below may require them. If
> a step in this file can only be done from a shell, that product step is
> unfinished.

## §1 The seven moments

Numbered because the rest of this file and the code refer to them.

1. **Get it.** A `.exe` from the releases page. One file.
2. **Install it.** Double-click, click through, done. It offers to start ksx —
   and a desktop icon exists whether or not they accept.
3. **Start it.** The console-free `ksx-launcher.exe` starts the installed
   `ksx.exe open`, the tray icon appears, and Studio opens directly at
   `/start` in its own app window. An idle control host is running, but no
   emulation session exists: nothing is captured and no pads exist. The tray's
   operate-only cabinet window and saved-setup Start action remain gray until
   first-run Save gives them a runnable setup.
4. **Choose and, when needed, prepare a keyboard.** They see their real devices,
   named, and pick one exact keyboard. On a clean machine, a supported USB
   keyboard gets a built-in preparation card before Play can become ready. The
   user confirms a tested spare keyboard, confirms the selected keyboard will
   stop ordinary typing, and consents to a machine-local package-signing
   certificate. Windows shows UAC; no command window appears. If a separately
   installed Interception backend is already healthy, capture remains ready and
   the same built-in mode is a secondary choice rather than a blocker.
5. **Choose a controller.** They pick what it should become. It appears
   **ready** — and they can change their mind freely, because nothing has been
   plugged, claimed, or written yet.
6. **Map it.** Press a key, pick the button. Macros if they want. Then the one
   question that matters: **split or freeze?**
7. **Play.** Start it live. The pad connects, the keyboard becomes a controller,
   and Guide can ask Windows to open Game Bar when **Allow your controller to
   open Game Bar** is enabled in Windows Settings > Gaming > Game Bar. From
   there they can use the gaming UI their Windows account already has set up.

## §2 What "ready" means, and why staging is a real type

**A staged setup is its own implemented value and never touches disk.** It
holds the chosen device, persona and complete authoring preset per controller,
plus the blocking choice. It lives in the daemon for the length of the visit.
`StagedSlotView::authoring` is optional for wire compatibility, but every live
slot served by the current daemon supplies it.

`/map?target=stage&slot=N` reuses the ordinary visual mapper for buttons,
multiple keys, turbo and macros. The backend prepares a pure staged bind or
macro edit, validates conflicts across all staged controllers, and sends one
`StageEdit::SetBindings` only when accepted. A refusal leaves the staged value
unchanged. It takes no disk backup and triggers no config reload because no
file is being edited.

No device is changed merely by looking, picking, mapping, or changing the
staged controller. Built-in WinUSB preparation is the one deliberately separate
machine action before moment 7: it is offered only for the exact selected USB
keyboard, requires three explicit confirmations and UAC, and does not save a
configuration or plug a pad. Only after the elevated transaction and a fresh
exact-device survey both prove `prepared` may the daemon guard-change that
staged device's backend to `winusb`. A refusal or unverifiable result leaves the
stage unchanged. Save and Play remain separate: Save commits the staged value;
Play starts that same value without first saving it.

This is not a UI convenience. It is the difference between an app you can
explore and one that punishes you for clicking.

Consequences that fall out, and are requirements:

- Deleting a staged controller is free and complete. No file, no backup, no
  trace.
- A staged setup can be discarded wholesale. "Start over" must always work.
- The user may leave without saving and lose only what they typed.
- What is staged is what plays. There is no second translation step where a
  saved file means something different from what the screen showed.

## §3 Split or freeze — the question, in the user's words

Asked once, after mapping, before playing. Both answers already exist as
`ksx_core::Blocking`; what is new is *asking*.

- **Freeze this keyboard** (`Blocking::Whole`) — every key on it drives the pad
  and nothing else. No typos into the game, no accidental Windows shortcuts.
  This is what most people want for a dedicated arcade panel.
- **Split this keyboard** (`Blocking::BoundKeys`) — mapped keys drive the pad;
  everything else still types. This is what lets one keyboard serve player 1 and
  player 2, and what lets someone keep using their only keyboard.

Two things must be said on that screen, not buried:

1. **The escape hatch is always live**: LeftCtrl five times toggles keyboard
   capture off or on, in both modes, and is handled in the capture thread where
   no UI can break it. Turning capture off gives every keyboard back without
   ending Play; Stop or Ctrl+Alt+Del ends Play.
2. Freeze is not permanent and not global. It applies to that keyboard, for that
   session, and stopping the session ends it.

## §4 What the installer must do (moment 2)

- **Install the controller drivers, having asked.** Without ViGEmBus, an Xbox
  360 or PlayStation stage has no bus for its virtual pad to appear on, so
  every one of the moments below can be performed perfectly and moment 7 still
  plugs nothing for those personas. Setup
  already owns an administrator token and the user has consented to that driver
  (`ksx install-drivers` itself never self-elevates), so it is the right place
  this particular controller driver can be installed without a terminal — and
  §7 makes "without a terminal" the test. WinUSB preparation later has its own
  three confirmations and fixed-purpose UAC helper. The ViGEm task is a `[Tasks]`
  checkbox, ticked by default, whose label names the driver and says what it is
  for; `docs/DRIVERS.md` is right that installing a kernel driver silently
  throws away the consent, and a checkbox nobody can read is silence with extra
  steps. What it runs is `ksx install-drivers --yes`, not the bundled `.exe`,
  because that verb owns the hash pin, the signature pin and the sealed handle.
  A failure here **never** fails the install: a machine with no ViGEmBus still
  wants the ksx that configures and maps, so the wizard says what happened,
  names the way back, and carries on.
  HIDMaestro is a second checked task for the one live DualSense persona. It
  runs an installer-only, version- and hash-pinned bootstrap from the protected
  installed directory. Its label discloses that internet is required; it
  downloads the exact official release only during setup, verifies every
  assembly it executes, and deletes the temporary SDK. The ordinary daemon and
  its elevated runtime host have no network or package install/update authority;
  clearing this task leaves only DualSense unavailable and the wizard explains
  how to retry.
- **Desktop icon by default.** Not `Flags: unchecked`. The audit's finding: a
  user who declines the launch prompt has to go hunting through a Start menu.
- **Offer to launch ksx**, not to run a diagnostic. `ksx doctor` is a developer
  verb; it prints driver tables into a console. A first-run user who accepts a
  "run this now" prompt must get the app.
- **One Start menu entry: `ksx`.** The four others (`daemon (tray only)`,
  `Studio (serve only)`, `cabinet`, `setup wizard`) are surfaces and dev tools,
  not products. They stay reachable — the verbs are not deleted — but a menu of
  five names a new user cannot rank is a menu that teaches nothing.
- **Every customer entry targets `ksx-launcher.exe`.** It is a Windows GUI
  subsystem binary that starts the sibling `ksx.exe open` with
  `CREATE_NO_WINDOW`; the Start shortcut, desktop shortcut and post-install
  launch are the same action. The elevated installer uses `runasoriginaluser`
  so the daemon and Chromium profile belong to the person who installed ksx,
  not to the administrator account that approved Setup.
- **No PATH task or registry mutation.** CLI/dev verbs remain installed for
  support and development, but the customer is offered no terminal integration
  or shortcut to them.
- **Install the recovery boundary with the app.** The installed tree contains
  the GUI-subsystem `ksx-winusb-helper.exe`, its fixed sibling `libwdi.dll`, the
  provider's complete corresponding source, and a
  SYSTEM/Administrators-only-mutation `%ProgramData%\KSX\WinUSB` journal whose
  receipt state is read-only to the standard user. They are not run during install and do not
  silently prepare a keyboard. Studio invokes the fixed helper later through
  Windows UAC only after the three confirmations above. The advanced portable
  ZIP deliberately omits the helper, provider and source together, so it has no
  supported prepare/release path.

## §5 What the first screen must do (moments 3–4)

Clean, because it genuinely is: no config, no emulation session, no capture and
no pads. A plain idle daemon/control host must stay alive even when the default
configuration has no slots; otherwise `/start` could not stage the first one.
An explicitly requested empty game profile or a broken configuration still
refuses. `ksx open` waits for this host and Studio, then opens `/start` (with the
existing bounded browser fallback if the preferred Chromium app window cannot
be opened).

- **Devices are listed without being asked for**, with a visible rescan. A user
  who just plugged something in must not have to know a scan exists.
- **Named the way a human names them** — "Logitech keyboard", not
  `USB\VID_F00D&PID_BEEF&MI_00\7&...`. The vendor table already does this; the
  path belongs in small print for support, never as the identifier on screen.
- **Say what each device can do**, because it is not guessable: a Bluetooth
  keyboard can be split but never WinUSB-claimed, and a device with no keyboard
  interface cannot be picked at all. `docs/DEVICE-IDENTITY.md` and the transport
  column carry this already.
- **Looking and picking never prepare anything.** The top-level preparation
  card is a separate POST with exact hidden stale-action guards and three
  visible required confirmations. The server re-enumerates the selected
  interface, refuses an unsupported, ambiguous, shared-HWID, stale, or
  last-keyboard target, and never accepts a backend name or helper command from
  the browser. Preparation may open UAC and change that exact device; every
  other exploratory action remains in memory. Because Windows packages match a
  hardware ID, the consent also says to release this device before connecting
  another identical keyboard. If one is connected later, Studio requires it to
  be unplugged before Release so the staged selection remains exact; removing
  the shared package returns that twin to HidUsb when it is reconnected.
- **Clean-install and shared-driver states differ honestly.** Without
  Interception, a claimable exact USB keyboard must be prepared before Save or
  Play. When Interception is already installed and usable, the setup remains
  ready and offers **Use KSX's built-in Windows USB mode** as a secondary path.
  A verified WinUSB device offers Release. Built-in preparation supports one
  exact USB keyboard; reconnect or choose a supported USB keyboard, then
  Rescan. Bluetooth keyboard capture is not available on a clean install.
- **Say which keyboards ksx is already holding, and offer each one back —
  whatever is selected.** A board bound to `winusb.sys` does not type, and that
  survives closing ksx, restarting the machine and starting Setup over: it is a
  Windows driver binding plus a machine-wide receipt, and neither of those is
  this configuration. So the list is read from the DEVICE TREE and shown on its
  own, above the steps — it appears with no config, with nothing staged, and
  while a different keyboard is selected. The exit from "my keyboard stopped
  working" must not require choosing that keyboard, or having chosen anything,
  or having a configuration at all. Release stays an explicit, separately
  confirmed act, and choosing a keyboard still releases nothing (§6). Added
  2026-08-11: before it, the only Release control hung off the selected
  keyboard's card, so in each of those states the way out was this repo's
  recovery runbook and an elevated shell — §6's last line, live in the shipped
  build.
- **Say it if Play cannot work — for the controllers actually staged.**
  `MachineSource::controller_outputs` derives requirements from each supported
  staged persona: Xbox 360/PlayStation require ViGEmBus, DualSense requires
  HIDMaestro, a mixed setup requires both, and an empty stage requires neither.
  The page must not warn a DualSense-only setup about ViGEmBus or paint a
  healthy ViGEmBus result over missing HIDMaestro. Known blocked, could-not-tell,
  fully preflighted, and **verified when Play starts** are separate states.
  HIDMaestro's exact package/hash probe proves its installed prerequisite, not
  a controller endpoint that does not exist until the protected Play
  transaction. A blocked or unread required output disables Play but never
  Save: saving writes files and plugs nothing. Remedies name the installer,
  never an install button, because §3 of `docs/SURFACES.md` still marks driver
  installation `never` for this surface.

## §6 What must never happen

Each of these has already happened once in this project's history.

- A screen reports success while nothing works (a session read healthy while
  the panel was dead). If a step cannot be verified, it says so.
- A failed read renders as an empty result — "you have no devices" when the
  truth is "I could not enumerate" (`SURFACES.md` §1b).
- A user is asked to type or paste a device path. Ever.
- A customer shortcut flashes a console window.
- An empty default configuration kills the control host before `/start` can
  stage the first controller.
- A fresh empty configuration offers an active cabinet window or saved-setup
  Start action in the tray; both stay gray until Save, while Open ksx remains
  available.
- A staged mapper GET or accepted edit writes a file before Save, or a refused
  edit changes the staged setup.
- An action that looked like a menu choice turns out to have prepared a board.
  Preparation is always a distinct top-level card, never a side effect of
  choosing a row; it names the typing consequence, spare keyboard, UAC and
  certificate before requiring all three confirmations.
- The browser selects a backend, supplies a helper/provider path, or turns an
  elevated exit code into success. Those decisions remain server/provider
  owned; only a fresh exact `prepared` or `released` result may move the stage.
- The only way out of a mistake is a shell command.

## §7 How we will know it works

Not "the pages render". The test is a person who has never seen ksx, on a
machine that has never run it, getting from a downloaded `.exe` to a controller
moving in a game **without opening a terminal, without editing a file, and
without being told what to do next by us**.

The acceptance run uses the exact CI-built installer and a fresh standard
Windows user. It records the installer SHA/version and verifies: the default
ViGEmBus checkbox and outcome; the installed WinUSB helper/provider/recovery
tree; one customer shortcut; the unelevated original user and correct browser
profile; no console flash; empty-config idle bootstrap to `/start`; exact USB
selection; all three preparation confirmations; UAC under the separate admin;
machine-local public-certificate and no-private-key postconditions; the selected
keyboard stopping while the tested spare keeps typing; staged
multi-key/turbo/macro editing; Play before Save; Save and restart parity;
profile create/update/delete/switch without TOML or CLI; Release restoring the
exact keyboard; uninstall removing every KSX-owned package/certificate/key/
receipt only after absence proof; and a real virtual controller moving in a
game. Until that is true, every green test suite in this repo is measuring
something narrower than the product.

The Guide clause has an OS prerequisite and a physical acceptance gate. The
first-run screen must name the Windows setting above and offer
`ms-settings:gaming-gamebar` as the direct remedy; ksx must not silently change
that per-user preference. Unit tests can prove that the default layout maps
Player 1's Left Windows key and Player 2's Numpad `*` key to Guide, but they
cannot prove that Windows displayed Game Bar. Moment 7 remains unverified until
a fresh Windows user with Game Bar enabled turns on that controller setting,
presses each default Guide key after Play, and observes Game Bar open from the
virtual pad without using a terminal or another keyboard.
