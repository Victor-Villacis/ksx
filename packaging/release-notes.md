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

- **One plain-USB DualSense is now a real installed output option.** A game
  profile can request a DualSense instead of an Xbox 360 or DS4 controller.
  ksx sends the complete controller state through a fixed HIDMaestro host and
  receives bounded rumble feedback, while the ordinary ksx process remains
  non-administrative.

- **DualSense setup is part of the installer.** The wizard offers a separate,
  clearly labelled HIDMaestro task. If selected, setup downloads the exact
  official v1.6.1 archive, verifies its pinned bytes before using it, installs
  the driver, and removes the temporary SDK. Normal Play never downloads or
  installs a package.

- **The new controller has a fail-safe lifetime.** ksx authenticates the one
  elevated helper it launches, permits one owned virtual device, renews a
  short lease while Play is healthy, and neutralizes and removes that device
  on normal stop, a broken connection, or an expired lease.

## Fixed in this release

- **A DualSense request no longer depends on ViGEmBus.** Controller backends
  are opened only when a profile needs them. A missing HIDMaestro driver is
  reported before ksx blocks a keyboard, while Xbox 360 and DS4 profiles keep
  their existing ViGEmBus path.

- **Unsupported rich-controller requests now refuse plainly.** The live lane
  is exactly one USB DualSense. A second HIDMaestro controller, Switch Pro, and
  Xbox Series requests fail instead of silently changing controller identity
  or pretending a gated path works.

## Get it

Download **{{SETUP_NAME}}** from Assets below and double-click it. Click through
the wizard; at the end it offers to open ksx, and it leaves an icon on your
desktop either way.

The wizard offers two controller-driver tasks. **Install the bundled ViGEmBus
controller driver** enables Xbox 360 and DS4 outputs. Its installer is bundled,
nothing is downloaded, and ksx checks its SHA-256 and signature before running
it. **Download and install the pinned HIDMaestro v1.6.1 controller driver**
enables the new USB DualSense output and requires internet access. Its official
archive and required assemblies are hash-checked before the installer API is
called. You can clear either task and re-run this installer later.

The HIDMaestro lane deliberately supports one plain-USB DualSense. It does not
claim Switch Pro, Xbox Series, Bluetooth, or a second HIDMaestro controller.
Those requests are refused rather than substituted.

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
  recovery cleanup, the fixed HIDMaestro runtime host and verified setup
  bootstrap, and the provider's corresponding source.
- **{{PORTABLE_NAME}}** - `ksx.exe`, the console-free launcher, product
  licenses, `NOTICE`, and all third-party license texts, for people who want no
  installer. It has no Start menu entry, desktop icon, bundled ViGEmBus driver,
  WinUSB helper, prepare provider, HIDMaestro host/bootstrap, or supported
  prepare/release path. It cannot use the installed-only DualSense lane. It is
  for advanced Interception or already-prepared setups; use the installer for
  first run.

Nothing installs a driver behind your back. The installer shows separate
ViGEmBus and HIDMaestro tasks, and the later WinUSB action has its own three
confirmations plus UAC. The portable distribution has none of those driver
paths.
