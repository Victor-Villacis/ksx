# Quickstart — install, choose a keyboard, and play

This is the customer path on Windows 11. It needs no terminal, no configuration
file, and no knowledge of the developer CLI.

## 1. Install ksx

Download `ksx-<version>-setup.exe` from the release page and run it.

- Leave **Install the ViGEmBus controller driver** selected unless it is
  already installed.
- Leave **Install the HIDMaestro controller driver** selected when you want the
  DualSense persona. This optional setup task needs an internet connection: it
  downloads the exact official v1.6.1 archive, verifies pinned hashes, installs
  the driver, and removes the downloaded SDK. Ordinary Play never downloads,
  installs, or updates the package.
- Leave **Launch ksx** selected to open the app when setup finishes, or use the
  **ksx** shortcut afterward.
- The optional desktop icon and the Start-menu entry open the same app. Neither
  opens a command window.

The installer is not code-signed yet, so Windows may show a SmartScreen warning.
The release notes publish the installer SHA-256 so the download can be checked.

## 2. Choose the keyboard or arcade panel

ksx opens directly to **Set up & play** — one page that holds everything below —
and scans the machine as it loads. Open **Devices** to work with attached input
hardware without hiding the canvas.

1. Find the keyboard or arcade encoder by its ordinary device name. Encoders
   appear in their own group.
2. Choose **Show** to add its inspection card to the workbench, then choose
   **Use as input source** on that card. Showing a card does not select it.
3. Not sure which board is which? Choose **Identify by key** and press a key on
   it. **Rescan** re-reads the machine if you just plugged something in.
4. If the device does not identify itself as a keyboard, open **Not keyboards —
   experimental**. Boards with no keyboard interface at all are listed under
   **Unavailable devices**, so "why is my device not here" has an answer.

This choice is only a draft. Selecting a device does not disconnect it, create
a controller, or write anything to disk.

## 3. Prepare keyboard capture when ksx asks

On a clean Windows installation, ksx asks before it prepares the selected USB
keyboard for its built-in Windows USB mode. The card sits with the keyboard you
chose and reads **Prepare for play — Windows stops this keyboard's ordinary
typing until it is released here.** This is an installed-app feature; the
advanced portable ZIP cannot prepare or release a keyboard.

1. Connect and test a different keyboard that can still type.
2. Confirm that the selected keyboard will stop ordinary typing until it is
   released from this same screen.
3. Consent to a machine-local certificate used only to sign this computer's
   generated device package.
4. Select **Prepare selected keyboard** and approve the Windows permission
   prompt. No command window opens.

Nothing changes unless all three confirmations, the exact live USB interface,
and the final Windows driver state agree. Preparation refuses the last usable
keyboard, an ambiguous selection, and an already-connected identical keyboard.
Windows associates the generated package with the keyboard model, so use
**Release** before connecting another identical keyboard. If one was connected
later, unplug it first, then Release; removing the shared package returns that
twin to ordinary typing when it is reconnected.

If a compatible shared capture driver is already available, ksx remains ready
and the same card offers the built-in USB mode as an optional extra — it reads
**Typing normally — the shared driver is ready; preparing the built-in path is
optional.**

Bluetooth capture is not available on a genuinely clean installation; choose a
supported USB keyboard. A refusal leaves the draft and saved files unchanged.

## 4. Choose a controller

Pick the virtual controller the keyboard should become, then add it. You can
change its type or remove it while the setup is still a draft.

The current rich-controller lane supports one DualSense per session. Additional
players can use Xbox 360 or PlayStation personas; ksx refuses a second
DualSense before saving or plugging anything.

ksx supports as many as 16 players. Xbox-style controllers occupy the four
places Windows games normally expose through XInput; supported additional
players use PlayStation-style controllers. The page shows the exact capacity of
the installed build instead of assuming four players.

Choose a ready-made controller layout that resembles the physical controls.
The default two-player keyboard layout includes:

- Player 1 Guide/Home: **Left Windows**
- Player 2 Guide/Home: **Numpad \***

## 5. Map the controls

The middle of the page IS the mapper, and the panel on the right is the
**Mapping inspector**. Pick a player in the left-hand **Virtual controllers**
list to point them at it.

- Click a controller control, then press the physical key for it.
- Add more than one key to a control when useful.
- Configure chords, auto-fire, and macros in the same editor.
- Switch players from the left-hand list; **Find mappings** (Ctrl K) searches
  keys, controls and macros.

While editing this unsaved setup, changes remain in the background service's
draft. They do not write controller-layout files. A refused edit leaves the
draft unchanged.

## 6. Decide whether to split or freeze the keyboard

Answer the required question on the same page:

- **Split it:** only mapped keys become controller input; unused keys can still
  type or be assigned to another player.
- **Freeze it:** while Play is active, every other key on that keyboard is
  ignored. This prevents accidental typing during a game.

**LeftCtrl five times is always the escape hatch.** It toggles keyboard capture
off or on even if the app window is closed or unresponsive. Use **Stop** or
Ctrl+Alt+Del to end Play.

## 7. Save, Play, or both

These are separate actions, and they live in the bar across the top of the page
with a line beside them saying whether what is on screen has been saved:

- **Save** keeps the keyboard, controllers, mappings, and split/freeze choice for
  later. It does not start Play.
- **▷ Play** uses exactly what is on the screen without saving it first.
- **⏹ Stop** ends Play. **⟳ Apply** appears only while Play is running and you
  have changed something, and applies the change without restarting.

When Play begins, the virtual controllers appear and the chosen keyboard starts
driving them. Open **Tools ▸ Test inputs** to see short and long presses light
up.

Guide/Home opens Xbox Game Bar only when Game Bar is available and Windows'
**Allow your controller to open Game Bar** setting is enabled. ksx never
changes that Windows setting silently. Use **Open Game Bar settings** in the
session card to open the relevant Windows page, then make the choice there.

## Saved games and libraries

Saved games, reusable layout libraries, import/export, and autostart are not in
the current `/redesign` workbench yet. They are being rebuilt as a separate
Settings/Library surface. Advanced panel building and arrangement tools are
deferred separately. There is no legacy Configuration page after the hard
cutover; old `/nocturne` GET bookmarks redirect to `/redesign`, and its former
forms and APIs do not exist. See [DEFERRED-SURFACES.md](DEFERRED-SURFACES.md)
for the exact scope and the CLI/backend contracts that remain available.

## If ksx says the background service is unavailable

Close the ksx window and reopen **ksx** from the desktop or Start menu. If ksx
is already in the notification area, choose **Open ksx** there. No terminal
command is part of the customer recovery path.

Raw device paths and read errors stay inside support disclosures rather than in
the ordinary sentences. Include those details when reporting a problem.

## What still requires physical release acceptance

Automated tests prove the installer contracts, no-console launcher, empty-setup
bootstrap, staged mapper, and Guide bindings. They do not
prove a clean-machine install, a real controller in a real game, Windows Game
Bar activation, or the cabinet's long hardware soak. The exact supervised
release checklist and its unrun status are in [`GATES.md`](GATES.md), Gate 4.

Developers and maintainers should start with [`HANDOFF.md`](HANDOFF.md), then
use [`ARCHITECTURE.md`](ARCHITECTURE.md), [`SURFACES.md`](SURFACES.md), and the
developer CLI reference in the repository README.
