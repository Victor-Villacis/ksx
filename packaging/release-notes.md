<!-- The body of every ksx release. `.github/workflows/release.yml` substitutes
     VERSION, TAG, SETUP_NAME, SETUP_SHA256, PORTABLE_NAME, PORTABLE_SHA256,
     MANIFEST_NAME, MANIFEST_SHA256 and COMMIT (each written in double braces
     below) and publishes the result; a placeholder that workflow does
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

- **Studio is one workspace instead of six pages.** Hardware, controllers,
  mapping and play now share a single canvas you pan and zoom. The keyboard is
  an object on that canvas, every controller is another, and selecting one
  shows its bindings beside it. There is no longer a set of pages to walk in
  order, and no half-finished state stranded on a page you have to remember to
  go back to. The driver check, the pad list and the device picker stay as
  their own small tool pages.

- **Mapping happens on that canvas.** Physical keys and controller inputs
  illuminate as they move. Click-to-bind, multi-key binding, conflict
  resolution, undo, turbo, and macros are all in the one surface, with clear
  Save and Play actions and no hidden capture state.

- **Three controller identities are ready today.** A slot can present itself as
  an Xbox 360 pad or PlayStation/DS4 pad on the bundled ViGEmBus driver. An
  installed KSX can also create one plain-USB DualSense through its fixed,
  source-built HIDMaestro runtime. Switch Pro, Xbox Series X|S, SNES and Genesis
  remain visible compatibility vocabulary, but this release refuses them until
  each has a source-built runtime and its own hardware evidence. It never
  substitutes a different pad silently. Slots 1-4 stay on Xbox 360 by default,
  because that is still the one pad every XInput title since 2006 understands.

- **The Studio's appearance is a setting.** Dark, light, and a Matrix theme,
  picked in the Studio's own configuration menu under "How the Studio looks".

## Fixed in this release

- **HIDMaestro setup no longer tries to delete a library while it is still
  loaded.** Version 0.4.0 could complete the driver call and then show exit code
  8 because its own process still held the verified temporary SDK open. The
  driver call now runs in a protected, isolated worker with a bounded timeout;
  only after that process tree is proven stopped does the coordinator remove
  the pinned temporary files. A repair also removes an exact hash-verified
  staging directory left by version 0.4.0 and refuses to delete anything
  unexpected.

- **An exact HIDMaestro reinstall is now an offline fast path.** If the pinned
  main and XUSB packages and installed manifest already match, setup returns
  before downloading the official SDK or constructing its context. That avoids
  the old global device sweep and completes without staging residue. The release
  gate requires the exact candidate to prove this path offline in under 30
  seconds.

- **A cleanup result now says what actually happened.** Exit code 8 was not a
  download failure and was not proof that DualSense was unavailable. Setup now
  distinguishes installation from cleanup instead of blaming the internet or
  asking the user to repeat a driver install that may already have succeeded.

- **Overlapping key-learning requests cannot bind an old key to a new
  control.** Each capture and cancellation is tied to its exact generation, so
  a late result is retired instead of being applied to the current target.

## Get it

Download **{{SETUP_NAME}}** from Assets below and double-click it. Click through
the wizard; at the end it offers to open ksx, and it leaves an icon on your
desktop either way. Version {{VERSION}} installs to its fixed protected Program Files
directory because its driver helpers cross an administrator boundary. If an
older version was installed in a custom location, uninstall that version first,
then run this setup again; the installer will not execute an elevated helper
from the old path.

The wizard offers two controller-driver tasks. **Install the bundled ViGEmBus
controller driver** enables Xbox 360 and DS4 outputs. Its installer is bundled,
nothing is downloaded, and ksx checks its SHA-256 and signature before running
  it. **Download and install the pinned HIDMaestro v1.6.1 controller driver**
  enables the installed-only DualSense output and requires internet access on a
  clean machine. Its official archive and required assemblies are hash-checked
  before the installer API is called inside a protected ephemeral worker. The
  process tree must stop before the verified temporary SDK is removed. The
  official SDK is never included in the installed runtime. You can clear either
  task and re-run this installer later.

On a clean machine without HIDMaestro staged, clearing that box leaves
DualSense unavailable. On a reinstall or upgrade, clearing it performs no
install or repair and leaves existing availability unchanged. The ViGEmBus Xbox
360 and PlayStation personas are not affected either way. A persona this build
cannot create is refused by name rather than quietly substituted with a
different pad, so a refusal here always tells you which one and why. ksx never
connects a real controller over Bluetooth: every pad it creates is a virtual
device on this machine.

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

Portable ZIP SHA-256: `{{PORTABLE_SHA256}}`

Candidate manifest SHA-256: `{{MANIFEST_SHA256}}`

## What is in Assets

- **{{SETUP_NAME}}** - the installer. This is the supported first-run file. It
  includes the console-free elevated WinUSB helper, its prepare-only provider,
  recovery cleanup, the fixed source-built one-DualSense HIDMaestro runtime host
  and verified setup-only bootstrap, and the provider's corresponding source.
- **{{PORTABLE_NAME}}** - `ksx.exe`, the console-free launcher, product
  licenses, `NOTICE`, and all third-party license texts, for people who want no
  installer. It has no Start menu entry, desktop icon, bundled ViGEmBus driver,
  WinUSB helper, prepare provider, HIDMaestro host/bootstrap, or supported
  prepare/release path. It cannot use the installed-only DualSense lane. It is
  for advanced Interception or already-prepared setups; use the installer for
  first run.
- **{{MANIFEST_NAME}}** - machine-readable provenance for this exact build:
  source commit/ref, Release run and attempt, Rust toolchain, filenames, sizes,
  and SHA-256 values for both distributables.

Nothing installs a driver behind your back. The installer shows separate
ViGEmBus and HIDMaestro tasks, and the later WinUSB action has its own three
confirmations plus UAC. The portable distribution has none of those driver
paths.
