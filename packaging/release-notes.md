<!-- The body of every ksx release. `.github/workflows/release.yml` substitutes
     VERSION, TAG, SETUP_NAME, SETUP_SHA256, PORTABLE_NAME and COMMIT (each written in double
     braces below) and publishes the result; a placeholder that workflow does
     not know fails the release rather than reaching the page as literal braces
     (crates/ksx-app/tests/installer.rs).

     ASCII only. This text is read, substituted and written back by PowerShell
     on a runner, and it is the first paragraph a stranger reads about ksx; a
     mojibake dash in that paragraph is a worse bug than it looks.

     It is prose in a reviewable file, and not a YAML string, because the
     paragraph about SmartScreen below is the one that decides whether a
     first-time user continues or stops. That paragraph deserves diffs. -->

**ksx {{VERSION}}** - Windows 11, 64-bit.

## New in this release

- **Your keyboard settings can be changed after you set them up.** Two answers
  used to be permanent once first run was over. Whether a keyboard is frozen
  for play or split between the game and typing can now be changed on the
  Setup screen. And what a stick does when it is pushed left and right at the
  same time - which decides whether a fighting-game motion comes out as a jump
  or a crouch - can be set per player, where before it could only be reached by
  editing a file by hand.

- **ksx shows what it has left behind.** Preparing a keyboard writes a note to
  itself so it can undo the change later. Those notes were never shown
  anywhere, so a computer could be carrying nine finished jobs it had never
  tidied up while every screen reported everything was fine. The Devices screen
  now says so, and says plainly whether it matters - stale notes about
  keyboards that are working are housekeeping, and a keyboard that was never
  given back is not.

## Fixed in this release

- **A keyboard ksx is holding no longer says "Ready to use".** The banner at
  the top of the first-run screen would say a keyboard was being held and could
  not type, and the list ten lines below would call the same keyboard ready.
  One keyboard, one screen, two answers.

## Get it

Download **{{SETUP_NAME}}** from Assets below and double-click it. Click through
the wizard; at the end it offers to open ksx, and it leaves an icon on your
desktop either way.

One box in that wizard is worth reading: **Install the ViGEmBus controller
driver**. It is ticked, and it is what makes a virtual controller possible at
all - leave it ticked unless you already have ViGEmBus from something else. The
driver is bundled here, nothing is downloaded, and ksx checks its SHA-256 and
its signature before running it. If you clear it, ksx still installs and still
maps; it just cannot create a controller until you run the installer again with
the box ticked.

On a clean machine, the first-run screen can also prepare one exact supported
USB keyboard for KSX's built-in Windows USB mode. It is not automatic. Before
Windows shows UAC, KSX requires you to confirm a different tested keyboard,
confirm that the selected keyboard will stop ordinary typing until Release,
and consent to a machine-local certificate used only to sign this computer's
generated device package. No command window opens. Preparation refuses the
last keyboard, an ambiguous target, and identical keyboards that are already
connected. Release before connecting another identical keyboard. If one is
connected later, unplug it first, then Release; removing the shared package
returns that twin to ordinary typing when it is reconnected.

## Windows will say "Windows protected your PC"

A blue box, with only a "Don't run" button showing. Click **More info**, then
**Run anyway**.

The honest reason: this installer is not code-signed. SmartScreen shows that box
for any installer whose publisher it does not recognise - it is a statement about
a certificate this project has not bought, not a finding about the file. If you
would rather check the file than take that sentence on faith, the SHA-256 below
is the one this release was built with, and it names the commit it was built
from.

## Verify it (optional)

Open PowerShell in your Downloads folder and run:

    Get-FileHash .\{{SETUP_NAME}} -Algorithm SHA256

It should print:

    {{SETUP_SHA256}}

Built from commit {{COMMIT}} by the `Release` workflow on a GitHub runner - no
developer machine touched these bytes.

## What is in Assets

- **{{SETUP_NAME}}** - the installer. This is the supported first-run file. It
  includes the console-free elevated WinUSB helper, its prepare-only provider,
  recovery cleanup, and the provider's corresponding source.
- **{{PORTABLE_NAME}}** - `ksx.exe`, the console-free launcher, product
  licenses, `NOTICE`, and all third-party license texts, for people who want no
  installer. It has no Start menu entry, desktop icon, bundled ViGEmBus driver,
  WinUSB helper, prepare provider, or supported prepare/release path. It is for
  advanced Interception or already-prepared setups; use the installer for first
  run.

Nothing installs a driver behind your back. The installer asks about ViGEmBus
in the ticked box described above, and the later WinUSB action has its own three
confirmations plus UAC. The portable distribution has neither driver path.
