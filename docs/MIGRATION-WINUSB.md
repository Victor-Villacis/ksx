# Migrating a keyboard to KSX's built-in Windows USB mode

This is the supported product migration for KSX 0.5.0: use the **installed**
Studio first-run page. It needs no WDK, INF editing, self-signing command,
Zadig, terminal, device-path paste, or TOML edit.

The advanced portable ZIP deliberately cannot perform this flow. It omits the
elevated helper, prepare provider, corresponding source and protected recovery
journal. Portable KSX can use a healthy external Interception installation or
an interface an installed KSX already prepared, but use the installed app to
prepare or release it.

> **Acceptance rule:** the software transaction and packaging contracts are
> implemented. CI must record the clean-runner provider smoke, and physical
> Gates 2–4 remain mandatory against the exact candidate artifact before
> production approval; [`GATES.md`](GATES.md) is the evidence ledger.

## What changes

| | External Interception | Built-in Windows USB mode |
|---|---|---|
| Windows binding | keyboard remains on the HID keyboard stack behind a filter | one exact USB keyboard interface is rebound to in-box `winusb.sys` |
| Who sees its keys | Windows sees the keyboard unless KSX suppresses it | KSX owns the interface; Windows sees only KSX's deliberate re-injection |
| Identity | keyboard/HID identity can collide or drift through the filter's small slot space | the USB interface instance identifies the selected physical interface |
| Between games | ordinary keyboard behavior | the idle daemon re-injects keys so frontend menus work |
| If KSX is not running | keyboard returns to Windows | prepared interface is dark until KSX restarts or installed Release restores it |
| Secure desktop | physical keyboard input can reach it | re-injected input cannot reach UAC, lock screen or Ctrl+Alt+Del |
| Installation | external, not redistributed by KSX | installed KSX prepares a local signed package for in-box WinUSB |
| Undo | remove the external filter and reboot | installed **Release selected keyboard**, normally without reboot |

No third-party kernel driver is added. `winusb.sys` ships with Windows and is
Microsoft signed. The only generated driver material is a one-interface INF and
catalog for this machine.

## Before Prepare

1. Install KSX with `ksx-<version>-setup.exe`. A moved, portable, development,
   substituted or user-writable copy refuses the elevated transaction.
2. Connect a **different keyboard**, open an ordinary text field, and prove it
   types now. Leave it connected throughout Prepare and Release. A claimed,
   disabled, disconnected or battery-dead keyboard does not count as a spare.
3. Connect only one keyboard of the hardware model being prepared. Windows
   packages match a hardware ID, not one instance. KSX refuses identical
   present siblings; release the prepared device before connecting another
   identical keyboard.
4. Keep [`RECOVERY.md`](RECOVERY.md) §2 open on another screen or phone. The
   normal path is the installed Release button; the manual paths are emergency
   recovery, not the customer setup recipe.

Bluetooth has no USB interface to bind. Built-in preparation therefore supports
an exact USB keyboard only. Bluetooth keyboard capture is unavailable on a
clean install; an already healthy external Interception installation is the
only current path for it.

## Prepare in Studio

1. Open KSX. It lands on `/redesign`, the current product workbench.
2. Pick the keyboard by its human-readable row in the left pane's **Input
   hardware** list. Picking changes only the in-memory stage and never prepares
   a device.
3. On a clean machine, the capture card beside that keyboard reads **Prepare
   for play — Windows stops this keyboard's ordinary typing until it is
   released here.** If a shared Interception installation is already healthy,
   Play remains ready and the same card reads **Typing normally — the shared
   driver is ready; preparing the built-in path is optional.** instead.
4. Read and tick all three separate confirmations:
   - the different connected keyboard was tested typing;
   - this selected keyboard will stop ordinary typing until Release; and
   - KSX may install a machine-local certificate used only to sign this
     computer's generated device package.
5. Choose **Prepare selected keyboard** and approve Windows UAC. The app stays
   open and no command window appears.

The browser does not send a backend, helper path, provider path, INF, command,
certificate name, or success state. It sends only the exact selector/instance
it was served plus the named confirmations. The server first re-reads the stage
and machine inventory; any stale, missing, unsupported, ambiguous,
shared-hardware-ID or last-keyboard target refuses before elevation.

After UAC, Studio accepts only the typed API state exactly `prepared` with the
same exact interface. It then guard-changes the staged backend to `winusb`. A
helper exit code, stdout sentence, stale stage or different instance is not
success and cannot retarget the stage.

## What the installed transaction does

The unelevated process derives the fixed sibling `ksx-winusb-helper.exe` from
its canonical installed Program Files location. The Windows GUI-subsystem
helper requests administrator rights and derives only its fixed sibling
`libwdi.dll`. Both sides use Windows Known Folders rather than environment
strings and recheck live owner, DACL and reparse safety for the directory and
files. No caller-supplied path crosses UAC.

The elevated helper then:

1. resolves the selected live USB interface again and repeats every exact-device
   and spare-keyboard refusal;
2. writes a protected receipt under `%ProgramData%\KSX\WinUSB` before package
   generation;
3. writes KSX's exact one-interface INF template into that transaction and asks
   the narrow provider to prepare its signed catalog;
4. verifies the exact INF, catalog member digest, signer identity, and a
   public-only certificate in Local Machine Root and TrustedPublisher;
5. journals again before installing the package with Windows `pnputil`; and
6. re-enumerates the device and accepts success only when that exact interface
   is WinUSB and its ownership receipt is Active.

The standard-user app can consume only a read-only receipt view. Every receipt
mutation remains inside the elevated protected transaction.

Each transaction uses a unique `CN=KSX WinUSB <32hex>` certificate and a fresh
4096-bit non-exportable key. The provider signs while the certificate is still
untrusted, deletes the private-key container and proves it absent, and only then
may the public certificate enter the two machine stores. KSX independently
verifies exact DER/thumbprint/subject and no-private-key postconditions.

Any failure after journaling is compensated when safe. If rollback cannot be
proved complete, the durable result is `recovery-required`; the stage does not
change and the receipt remains so Release/uninstall can finish. A required
reboot is recovery-required, never a successful Prepare.

## After Prepare

The selected keyboard is no longer an ordinary Windows keyboard. While the
daemon is idle, KSX re-injects its keys so desktop/frontend menus still work.
During Play, those keys drive the configured virtual controllers and the chosen
split/freeze policy. Left Ctrl five times toggles passthrough while KSX is
running.

If KSX exits, the prepared interface remains off the keyboard stack and does
nothing until the daemon restarts or Release restores it. The tested spare is
therefore a real safety requirement, especially because re-injected keys cannot
operate UAC or the secure desktop.

Preparation changes only the selected staged backend after fresh proof. It does
not Save the setup, create a controller, or begin Play. Continue mapping,
split/freeze, Save and Play through the same first-run flow.

Test in this order on hardware:

1. confirm the spare keyboard still types;
2. confirm the prepared keyboard no longer types with KSX closed;
3. restart KSX and confirm idle typethrough;
4. Play and confirm every key release, virtual controller and blocked/unblocked
   behavior; and
5. Stop and confirm typethrough returns with no held key.

These are Gates 2 and 4. They remain unpassed until their run logs identify the
exact installer hash and physical results.

## Release

On `/redesign`, a freshly verified prepared keyboard shows **Release selected
keyboard** on its capture card. The same page also renders the complete,
stage-independent **Keyboards ksx is holding** recovery list: every exact held
interface gets its own release row even when the draft is empty or a different
input is selected. Tick that row's release confirmation and approve UAC.
Release uses the ownership receipt; it does not accept a package name from the
browser. `docs/RECOVERY.md` §2b remains the fallback when ksx itself cannot
start, not the normal way around a missing Studio control.

The helper removes affected WinUSB devnodes, deletes only the receipt's exact
OEM package, proves that package absent, rescans, proves the selected interface
is back on HidUsb, then removes the exact certificate and transaction
artifacts. Only a fresh typed API state `released` for the same interface lets
Studio guard-change the staged backend back to `interception`.

Package scope matters: if an identical keyboard was connected **after**
Prepare and Windows bound it through the same OEM package, unplug that twin
before using Studio Release. Studio will not guess between a weak staged
selector and two live instances. Release removes the shared package and returns
the selected keyboard; the twin returns to HidUsb when reconnected. That is why
Prepare refuses identical siblings already present and tells you to Release
before connecting one.

If Release reports recovery-required, keep the spare connected and follow
[`RECOVERY.md`](RECOVERY.md) §2. Do not delete the ProgramData receipt or helper;
they are the evidence and machinery needed for exact cleanup.

## Uninstall cleanup

The helper, provider and journal are recovery components, so Inno Setup invokes
`cleanup-owned` before deleting any of them. The audit covers active and
interrupted receipts, terminal records, recovery-required state, disconnected
claims, and orphan KSX certificate/key namespaces. It removes only material it
can prove KSX owns and proves absence afterward.

If ownership is ambiguous, a package cannot be removed, HidUsb restoration is
not observed, or certificate/key absence cannot be proved, uninstall aborts and
leaves the recovery components in place. A partially cleaned machine with no
way out is never reported as an uninstall success.

## Mixed installations

Backend choice remains per device. A cabinet may run one prepared WinUSB board
and other Interception-backed keyboards through the same composite capture
contract. When every configured keyboard uses WinUSB, KSX does not create an
Interception context and the external filter can be removed only after the
supervised Gate 3 sequence and soak.

Do not treat an available shared Interception installation as proof that the
clean-install path works. Studio intentionally keeps built-in USB mode visible
as a secondary option on such a machine so that exact installed preparation can
be exercised before release.

## The three trade-offs, stated plainly

Built-in USB mode is what lets KSX ship without a kernel driver, and there is no
version of it that does not cost these three things. They are recorded here
because a user meets all three in their first hour and none of them is a bug:

**A Bluetooth keyboard cannot be prepared.** There is no USB interface to bind,
so there is nothing for `winusb.sys` to take. A Bluetooth board can still be a
*player's* keyboard on a machine where another board is prepared, but KSX cannot
block it, which means its keystrokes reach Windows as well as the pad. If
blocking matters, the board has to be USB.

**A prepared keyboard is dark whenever KSX is not running.** This is the
inversion the whole design rests on: the interface has left the keyboard stack,
so it is not "KSX is suppressing it", it is "Windows has no keyboard there".
Killing KSX frees an Interception-captured board; it does not un-bind a WinUSB
one. Three mitigations, in the order you should reach for them:

1. `ksx autostart --enable`, so the daemon is running before anything else is —
   this is what makes the panel a working keyboard for the other 99% of the
   time;
2. `ksx winusb release <device> --yes` from any keyboard that still types;
3. the `pnputil` lines in `RECOVERY.md` §2, for when KSX itself will not start.

The refusal that keeps this survivable is the one in `winusb claim`: it will not
take the machine's **last** keyboard. Keep one spare board on a different port
and none of the above is worse than a minute's inconvenience.

**Preparation is per keyboard, and it needs an administrator.** Every board is
its own transaction — its own certificate, its own package, its own receipt —
and each one costs a UAC prompt. There is no "prepare everything" button and
there deliberately is not going to be one: the whole safety argument is that a
rebind is an exact, named, individually consented act against one interface.

Circling back on any of these means either a driver KSX would have to sign and
maintain, or a Windows facility that does not exist today. They are the price of
the 2026 cross-signing cliff, and they are cheaper than the cliff.
