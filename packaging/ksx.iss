; ksx — Inno Setup script.
;
; Build (Inno Setup 6.3 or newer; nothing else is required):
;
;     cargo build --release -p ksx-app --features studio,cabinet
;     cargo build --release -p ksx-launcher
;     cargo build --release -p ksx-winusb-helper
;     third_party\libwdi\build.ps1 -OutputDirectory target\release
;     iscc packaging\ksx.iss
;
; The output lands in packaging\out\ksx-<version>-setup.exe.
;
; The feature flags are not optional for a SHIPPED build: the customer launcher
; runs `ksx open`, which exists only with `studio`; the cabinet surface remains
; available inside ksx.exe for installations that operate it programmatically.
; The launcher is a separate GUI-subsystem executable so opening the product
; never flashes ksx.exe's development console.
;
; ---------------------------------------------------------------------------
; What this installer does and does not do
; ---------------------------------------------------------------------------
;
; DOES: lay ksx.exe down beside its `drivers\` folder — `ksx install-drivers`
; looks for the bundled ViGEmBus setup at `<exe dir>\drivers\`
; (`ksx_platform::installer::locate`), so the layout here is a contract with
; the program, not a convention.
;
; DOES: offer to install the bundled ViGEmBus driver, as a [Tasks] checkbox,
; by running `ksx install-drivers --yes` — see the [Code] section at the
; bottom for why it is that verb and not the .exe, and why a failure there
; cannot fail this install.
;
; DOES: offer HIDMaestro as its own checked task for the DualSense persona.
; That task runs the pinned installer-only bootstrap packaged beside the fixed
; runtime host. The bootstrap downloads the exact official v1.6.1 archive at
; install time and rejects any byte or API-shape mismatch, so this task requires
; internet access. Neither the ordinary daemon nor the runtime host can install,
; download, or update a driver package.
;
; This is a reversal, and the reasoning it replaces is worth keeping: "an
; installer that silently installed a kernel driver would throw away both pins
; and the consent". Both objections are answered rather than ignored. The pins
; are kept because the thing that runs is the verb that owns them, not the
; bundled .exe. The consent is kept because it is asked for, in the wizard, in
; plain words, on a box the user can clear. What was NOT survivable was the
; third fact nobody had weighed: `ksx install-drivers` needs an administrator
; token and ksx never self-elevates, so on a machine without ViGEmBus the only
; route to a working pad was a shell command — and docs/FIRST-RUN.md §7 makes
; "without opening a terminal" the acceptance test for the whole product.
; Setup is already elevated. It is the one moment where installing this costs
; the user nothing they have not already agreed to.
;
; DOES NOT: install Interception. Its licence is non-commercial and its
; installer is not ours to redistribute (docs/DRIVERS.md).
;
; ---------------------------------------------------------------------------
; The icons
; ---------------------------------------------------------------------------
;
; Every icon below resolves to the same generated file,
; assets\brand\dist\ksx.ico (tools\icongen — see assets\brand\README.md):
;
;   SetupIconFile         the setup.exe's own icon, in Explorer and in the
;                         UAC prompt the user is about to trust;
;   UninstallDisplayIcon  the Apps & Features row and the uninstaller. It
;                         points at the INSTALLED ksx.exe rather than at a
;                         copy of the .ico, because build.rs stamps the same
;                         icon group into the exe as resource 1 — one file to
;                         keep current instead of two;
;   [Icons]               the customer shortcuts, which target a separately
;                         stamped launcher carrying the same icon group.
;
; The .ico carries eight SIZE-SPECIFIC entries (16/20/24/32 simplified,
; 48/64/128/256 detailed), so the 16 px wizard title bar and the 256 px
; Explorer view each get art drawn for that size rather than a resample of
; one drawing. Every entry is PNG-compressed (see tools/icongen), which
; Inno Setup 6 reads; 6.3 is the floor here for `ArchitecturesAllowed=
; x64compatible`.
;
; NOT COMPILE-VERIFIED on the machine this was written on — Inno Setup is not
; installed there. The first `iscc` run is the check.

#define AppName        "ksx"
#define AppVersion     "0.4.1"
#define AppPublisher   "Victor Villacis"
#define AppURL         "https://github.com/Victor-Villacis/ksx"
#define AppExe         "ksx.exe"
#define LauncherExe    "ksx-launcher.exe"
#define WinUsbHelper   "ksx-winusb-helper.exe"
#define HidMaestroHost "ksx-hidmaestro-host.exe"
#define HidMaestroInstaller "ksx-hidmaestro-driver-installer.exe"
#define LibwdiDll      "libwdi.dll"
#define RepoRoot       ".."

[Setup]
; Never change AppId: it is what makes an install an UPGRADE rather than a
; second copy sitting beside the first.
AppId={{7B2F5A46-3C1D-4E9A-9F30-2A6C0E8D4B11}
AppName={#AppName}
AppVersion={#AppVersion}
VersionInfoVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}/issues
AppUpdatesURL={#AppURL}/releases
AppCopyright=MIT OR Apache-2.0

DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
LicenseFile={#RepoRoot}\LICENSE-MIT
; The old InfoAfterFile pointed at docs\QUICKSTART.md, a terminal-first
; engineering runbook. Finish now hands the customer directly to the guided
; app; support documentation remains installed under {app}\docs.

; ksx installs for the machine (it registers autostart and talks to a
; kernel driver), so it needs an elevated install into Program Files.
PrivilegesRequired=admin

; CLOSE the running ksx without asking, and do NOT bring it back before Setup
; has finished.
;
; `force` rather than `yes` because the question Inno asks with `yes` has no
; good answer and should never have been put to a customer: "The following
; applications are using files that need to be updated. It is recommended that
; you allow Setup to automatically close these applications." Answering "Do not
; close" guarantees a broken install; the list reads "ksx — keyboard splitter
; for arcade cabinets", twice, which tells them nothing; and nothing of value is
; lost by closing, because ksx holds no unsaved document — its state is
; config.toml and a driver binding, both already on disk. `force` closes it and
; moves on.
;
; RestartApplications=no is hygiene, NOT the fix for the exit-3 dialog. It was
; first added believing it was: the progress label read "Restarting
; applications..." when "initializer exit code 3" appeared, so the
; RestartManager looked like it was racing `initialize-store` for the protected
; store. It was not. Setting it changed nothing, and the real cause was in the
; helper: `ProgramDataStore::open` canonicalizes its paths and
; `ProgramDataStore::initialize` did not, so `initialize-store` judged every
; receipt ksx had ever written to have "escaped its transaction directory" and
; refused. Any machine that had once prepared a keyboard failed here; CI never
; did, because a runner's store is empty. Fixed in
; crates/ksx-platform/src/winusb_transaction.rs, pinned by a test.
;
; It stays because it is still right on its own terms: nothing of ksx should be
; running while Setup mutates the store it owns, and a background process
; silently resurrected mid-install is a worse answer than one the user starts.
; The daemon returns at the next logon through its autostart task, and the
; [Run] hand-off below puts ksx on screen the moment the wizard finishes.
CloseApplications=force
RestartApplications=no

; ALWAYS write a log. This installer has now cost several rounds of guessing at
; a single dialog ("initializer exit code 3") on a machine that kept no record
; of why, because Inno only logs when asked. The log is the difference between
; "it failed" and "it failed HERE", it costs nothing, and the one place it
; matters is a customer's machine, which is the one place nobody thinks to pass
; /LOG in advance.
SetupLogging=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

OutputDir=out
OutputBaseFilename={#AppName}-{#AppVersion}-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern

SetupIconFile={#RepoRoot}\assets\brand\dist\ksx.ico
UninstallDisplayIcon={app}\{#AppExe},0
UninstallDisplayName={#AppName} {#AppVersion}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
; CHECKED, and it is the only checkbox here whose default decides whether ksx
; can do its job at all. Without ViGEmBus there is no bus for a virtual pad to
; appear on, so a first-run user reaches Play, presses it, and nothing plugs.
;
; A checkbox rather than an unconditional step, because docs/DRIVERS.md is
; explicit that installing a kernel driver silently throws away the consent —
; and it is right. What it must NOT be is a checkbox whose label makes the
; consequence unguessable: "install drivers" tells a first-time user nothing,
; so the label names the driver, says what it is for, and says whether setup
; downloads anything.
;
; A user who clears it gets a ksx that installs, runs, configures and maps and
; cannot plug a pad. That is a legitimate choice (an existing ViGEmBus from
; DS4Windows or Sunshine is already there, or a machine is being staged), and
; it is a choice they have to be able to reverse: see the [Code] section, which
; says so on the last page of the wizard.
;
; ASCII ONLY: this file has no UTF-8 BOM, so user-visible text is interpreted
; in the system code page. Comments may keep their punctuation.
Name: "vigembus"; Description: "Install the bundled ViGEmBus controller driver (required to create virtual controllers; no download)"; GroupDescription: "Controller drivers:"
Name: "hidmaestro"; Description: "Download and install the pinned HIDMaestro v1.6.1 controller driver (required for DualSense; internet required)"; GroupDescription: "Controller drivers:"
; CHECKED, deliberately — docs/FIRST-RUN.md §4 bullet 1. It used to carry
; `Flags: unchecked`, and the audit's finding was concrete: this installer's
; only other hand-off is the "run it now" checkbox at the end, so a user who
; declined that one was left with nothing on screen and a Start menu to hunt
; through. An icon on the desktop is what "installed" looks like to the person
; FIRST-RUN.md is written about.
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
; A second copy of the helper, extracted into {tmp} for the pre-install AUDIT
; only — `check-store`, which reads and never writes.
;
; It may not run `initialize-store` there, and once did. That verb proves its
; own executable sits in a directory only SYSTEM/Administrators/TrustedInstaller
; can write, and Inno creates {tmp} inside the invoking user's own TEMP: owned
; by that user, writable by that user, always. So setup refused itself on every
; machine, exit code 3, before copying a file. The mutating verb keeps that rule
; and now runs from {app}; the read-only verb does not need it, because the
; worst a swapped caller achieves is being told about a directory it can already
; read. `noencryption` is required for a pre-install extraction even if a future
; release enables installer encryption.
Source: "{#RepoRoot}\target\release\{#WinUsbHelper}"; Flags: dontcopy noencryption
Source: "{#RepoRoot}\target\release\{#AppExe}"; DestDir: "{app}"; Flags: ignoreversion
; GUI-subsystem hand-off used by every customer entry point. ksx.exe stays
; installed beside it for internal/dev verbs and for this launcher's `open`.
Source: "{#RepoRoot}\target\release\{#LauncherExe}"; DestDir: "{app}"; Flags: ignoreversion
; Elevated, console-free exact-device prepare/release/owned-cleanup boundary,
; and its dynamically replaceable LGPL prepare provider.
Source: "{#RepoRoot}\target\release\{#WinUsbHelper}"; DestDir: "{app}"; Flags: ignoreversion
; Fixed elevated one-controller HIDMaestro host. The daemon will seal and
; launch this sibling only from a protected Program Files installation.
Source: "{#RepoRoot}\target\release\{#HidMaestroHost}"; DestDir: "{app}"; Flags: ignoreversion
; Installer-only, pinned upstream bootstrap. It downloads the exact official
; v1.6.1 archive only when the user selects the task, verifies every byte it
; executes, and removes the temporary SDK afterward. The ordinary daemon and
; runtime host never call this executable and have no package/certificate or
; download authority.
Source: "{#RepoRoot}\target\release\{#HidMaestroInstaller}"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#RepoRoot}\target\release\{#LibwdiDll}";    DestDir: "{app}"; Flags: ignoreversion
; The bundled ViGEmBus setup. It must land in `<exe dir>\drivers\` for
; `ksx install-drivers` to find it — and `<exe dir>` must be under Program
; Files (or another directory a standard user cannot write) or that search
; refuses the file on purpose: an elevated process running an installer out of
; a user-writable folder is a privilege escalation with extra steps. That is
; `ksx_platform::installer::locate`, documented in docs/DRIVERS.md, and it is
; why DefaultDirName is `{autopf}`. Someone who redirects this install to
; `C:\ksx` gets a refusal with the reason printed, not a silent skip.
Source: "{#RepoRoot}\drivers\*"; DestDir: "{app}\drivers"; Flags: ignoreversion recursesubdirs
Source: "{#RepoRoot}\README.md";        DestDir: "{app}"; Flags: ignoreversion
Source: "{#RepoRoot}\NOTICE";           DestDir: "{app}"; Flags: ignoreversion
Source: "{#RepoRoot}\LICENSE-MIT";      DestDir: "{app}"; Flags: ignoreversion
Source: "{#RepoRoot}\LICENSE-APACHE";   DestDir: "{app}"; Flags: ignoreversion
; Full texts and per-package attributions must travel with both distributions:
; this installed tree and the portable ZIP assembled by build-installer.yml.
Source: "{#RepoRoot}\THIRD-PARTY-LICENSES\*"; DestDir: "{app}\THIRD-PARTY-LICENSES"; Flags: ignoreversion recursesubdirs createallsubdirs
; LGPL complete corresponding source and build/test instructions for the
; replaceable libwdi.dll shipped above.
Source: "{#RepoRoot}\third_party\libwdi\*"; DestDir: "{app}\THIRD-PARTY-SOURCE\libwdi"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#RepoRoot}\docs\*.md";        DestDir: "{app}\docs"; Flags: ignoreversion

[Icons]
; ---------------------------------------------------------------------------
; ONE customer product entry. The optional desktop icon is the same act.
; ---------------------------------------------------------------------------
;
; The target is a Windows GUI-subsystem executable. It resolves its sibling
; ksx.exe, runs exactly `ksx.exe open` with CREATE_NO_WINDOW, waits for the
; window hand-off, then exits (or shows a normal error dialog if it failed).
; There are no customer shortcuts for CLI verbs and no command-line Parameters
; here for Windows to expose or Inno to quote differently.
Name: "{group}\{#AppName}";       Filename: "{app}\{#LauncherExe}"; WorkingDir: "{app}"; Comment: "Open ksx"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#LauncherExe}"; WorkingDir: "{app}"; Comment: "Open ksx"; Tasks: desktopicon

[Run]
; The hand-off is THE PRODUCT (docs/FIRST-RUN.md §4 bullet 2). This line used
; to run `ksx doctor`: a person who ticked "run this now" — the one moment the
; installer has their consent to show them what they just bought — got a
; console full of driver tables. That is a developer's answer to a question
; they did not ask, and it is the last screen of the install, so it is also
; their first impression of ksx.
;
; The launcher is the same executable both icons run. It starts `ksx.exe open`
; without allocating a console; that verb starts the daemon if needed, waits
; for Studio, then puts a window on screen — moment 3 of FIRST-RUN.md §1.
; `nowait` because that wait is seconds long and the wizard must not hold its
; Finish button hostage for it; `open` exits by design once the window is up.
;
; `runasoriginaluser` matters more than it looks. Setup is elevated
; (PrivilegesRequired=admin, for Program Files and the driver bundle), and
; without this flag the whole chain — `ksx open`, the daemon it starts, and the
; browser window that daemon's Studio ends up in — inherits that token. ksx is
; built to run WITHOUT one: `ksx autostart` registers its logon task as
; InteractiveToken/LeastPrivilege, "never elevated"
; (crates\ksx-backend\src\autostart.rs), so an elevated first daemon would make
; moment 3 behave differently from every boot after it. It would also put the
; Chromium profile ksx owns under the ELEVATING account's %LOCALAPPDATA%, which
; on a machine where a standard user typed an admin's credentials is not the
; profile the user gets tomorrow.
Filename: "{app}\{#LauncherExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: postinstall nowait skipifsilent runasoriginaluser

[UninstallDelete]
; `ksx install-drivers`'s own report, written by the [Code] section below. It
; is evidence about a step that already happened, so it outlives the wizard on
; purpose — and goes when ksx does.
Type: files; Name: "{app}\install-drivers.log"
; The usUninstall gate in [Code] has already stopped the session and waited for
; `cleanup-owned`, and aborts the entire uninstall on every nonzero or launch
; result. Only after that proof succeeds may Inno remove released/rolled-back
; receipts and other now-safe KSX WinUSB recovery state. The KSX parent is
; removed only if empty.
Type: filesandordirs; Name: "{commonappdata}\KSX\WinUSB"
Type: dirifempty; Name: "{commonappdata}\KSX"

; THERE IS DELIBERATELY NO [UninstallRun]. The scheduled task still has to go —
; a boot task pointing at a deleted exe is a visible error every morning — but
; it is now removed AND PROVEN ABSENT by `ksx uninstall-quiesce` in the usUninstall
; gate below. It has to happen before the driver rollback, and [UninstallRun]
; cannot promise that: its entries are replayed from the uninstall log while
; files are already being removed, which is far too late to stop anything.

[Code]
// What the last page says about the driver, set by the driver step at the
// bottom of this section. Empty means there is nothing worth saying.
//
// Declared here, at the top, rather than beside the code that uses it: a `var`
// block between two routines is accepted by Pascal Script, and this file gets
// exactly one compile attempt per push on a machine none of us can run ISCC
// on, so it is not the place to bet on "accepted".
var
  DriverNote: string;
  HidMaestroNote: string;

// ---------------------------------------------------------------------------
// The fixed ProgramData WinUSB recovery store
// ---------------------------------------------------------------------------
//
// The helper opens each real directory level as a non-reparse handle, holds the
// parent against replacement while descending, installs and verifies the exact
// protected DACL, and refuses every unexpected object before mutation. That is
// why no [Dirs], ForceDirectories or icacls line may touch ProgramData: a
// path-based check can be raced, a handle-based one cannot.
//
// WHY IT RUNS FROM {app} AND NOT FROM {tmp}. It used to run in
// PrepareToInstall, from a copy extracted into Inno's temporary directory,
// which meant it could never run at all. Before doing anything else the helper
// proves it is executing from a directory owned by SYSTEM, Administrators or
// TrustedInstaller and writable by nobody else. Inno creates {tmp} inside the
// invoking user's own TEMP — owned by that user, writable by that user, always.
// The proof was therefore false by construction, and every install on every
// machine died with exit code 3 before a single file was copied. Program Files
// satisfies it honestly, so the check finally does the job it was written for.
//
// WHAT THAT COSTS. A failure here is no longer "no KSX files were installed";
// it is a rolled-back install, because raising out of CurStepChanged is what
// makes Inno undo the copy. The user-visible promise is the same — nothing of
// KSX is left behind — but it is delivered by rollback rather than by never
// starting.
// The pre-install audit, and the ONLY refusal that can still stop an install.
//
// PrepareToInstall returning a non-empty string aborts before a single file is
// copied. Nothing later can: an exception from CurStepChanged(ssPostInstall) is
// reported and then ignored, because Inno has already written "Installation
// process succeeded" to its log by that point. That was measured, not assumed —
// a helper refusal there produced a complaint, a green exit code, and a fully
// installed product.
//
// So the hostile-ProgramData question is asked here, of a `check-store` that
// reads and never writes, from the extracted copy in {tmp}. The mutation that
// follows it lives in CurStepChanged, from {app}, under the strict rule.
function PrepareToInstall(var NeedsRestart: Boolean): string;
var
  HelperPath: string;
  ResultCode: Integer;
begin
  Result := '';
  try
    ExtractTemporaryFile('{#WinUsbHelper}');
    HelperPath := ExpandConstant('{tmp}\{#WinUsbHelper}');
    if not FileExists(HelperPath) then
    begin
      Result := 'Setup could not extract its WinUSB recovery auditor.';
      exit;
    end;

    if not Exec(HelperPath, 'check-store', ExpandConstant('{tmp}'),
                SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    begin
      Result :=
        'Setup could not start its WinUSB recovery auditor.' + #13#10 +
        'No KSX files were installed.';
      exit;
    end;
    if ResultCode <> 0 then
      Result :=
        'Setup refused an unsafe KSX WinUSB recovery directory (auditor exit code ' +
        IntToStr(ResultCode) + ').' + #13#10 +
        'No KSX files were installed. Remove unexpected ProgramData links or objects and retry.';
  except
    Result :=
      'Setup could not audit the KSX WinUSB recovery directory: ' +
      GetExceptionMessage + #13#10 + 'No KSX files were installed.';
  end;
end;

function RecoveryStoreProblem: string;
var
  HelperPath: string;
  ResultCode: Integer;
begin
  Result := '';
  try
    HelperPath := ExpandConstant('{app}\{#WinUsbHelper}');
    if not FileExists(HelperPath) then
    begin
      Result := 'The KSX WinUSB recovery initializer is missing from the installation.';
      exit;
    end;

    if not Exec(HelperPath, 'initialize-store', ExpandConstant('{app}'),
                SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    begin
      Result := 'Setup could not start its protected WinUSB recovery initializer.';
      exit;
    end;
    if ResultCode <> 0 then
      Result :=
        'Setup refused an unsafe or unavailable KSX WinUSB recovery directory (initializer exit code ' +
        IntToStr(ResultCode) + ').' + #13#10 +
        'Remove unexpected ProgramData links or objects and retry.';
  except
    Result :=
      'Setup could not verify the protected KSX WinUSB recovery directory: ' +
      GetExceptionMessage;
  end;
end;

// The one place in the install path that is ALLOWED to roll the install back,
// and the only one. A machine with no ViGEmBus still wants ksx; a machine whose
// fixed recovery store could not be proved safe must not be left carrying an
// elevated helper that will later mutate a driver store on its word.
//
// `RaiseException` is deliberately outside every `try`. Pascal Script's
// `except` catches it like any other exception, so raising inside
// RecoveryStoreProblem's handler would be swallowed by that handler and the
// install would continue over an unverified store — the same shape of mistake
// as the uninstall gate below.
procedure InitializeRecoveryStore;
var
  Problem: string;
begin
  Problem := RecoveryStoreProblem;
  if Problem <> '' then
    RaiseException(Problem);
end;

// ---------------------------------------------------------------------------
// Stop the session, then release exactly what KSX owns — before any removal
// ---------------------------------------------------------------------------
//
// The helper/provider/source are recovery components, so uninstall may not
// delete any of them until a running session has stopped and the helper has
// proved every KSX-owned binding, certificate, key container, package receipt
// and transaction residue is released.
//
// WHY NONE OF THAT WORK IS IN InitializeUninstall. It runs BEFORE Inno asks
// "are you sure you want to completely remove ksx?", so releasing a prepared
// keyboard there meant a user who then answered No had already had their
// keyboard released and their driver package removed. Cancelling must cost
// nothing. What stays here is the one check that mutates nothing, using the
// one abort Inno documents: `Result := False`, before the question is asked.
function InitializeUninstall(): Boolean;
var
  Missing: string;
begin
  Result := False;
  Missing := '';
  if not FileExists(ExpandConstant('{app}\{#AppExe}')) then
    Missing := '{#AppExe}'
  else if not FileExists(ExpandConstant('{app}\{#WinUsbHelper}')) then
    Missing := '{#WinUsbHelper}';

  if Missing <> '' then
  begin
    MsgBox(
      'KSX cannot prove it is safe to remove, because ' + Missing + ' is missing.' + #13#10#13#10 +
      'Reinstall KSX to restore the recovery components, reopen KSX/recovery, then retry uninstall.',
      mbError, MB_OK);
    exit;
  end;

  Result := True;
end;

// One elevated `ksx uninstall-quiesce`. It proves the running ksx.exe IS the
// protected Program Files install, removes the one fixed autostart task and
// proves it absent, then asks the daemon to quit and waits for its pipe name
// to disappear. False means something is still live, so nothing may be
// released and nothing may be deleted.
function SessionQuiesced(): Boolean;
var
  ResultCode: Integer;
begin
  Result := False;
  try
    if not Exec(ExpandConstant('{app}\{#AppExe}'), 'uninstall-quiesce',
                ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    begin
      MsgBox(
        'KSX could not start to stop its own session. Nothing was uninstalled.' + #13#10#13#10 +
        'Close ksx, then retry uninstall.', mbError, MB_OK);
      exit;
    end;

    if ResultCode <> 0 then
    begin
      MsgBox(
        'KSX could not confirm that its session and autostart task had stopped (quiesce exit code ' +
        IntToStr(ResultCode) + '). Nothing was uninstalled.' + #13#10#13#10 +
        'Close ksx, then retry uninstall.', mbError, MB_OK);
      exit;
    end;

    Result := True;
  except
    MsgBox(
      'KSX could not be stopped: ' + GetExceptionMessage + #13#10#13#10 +
      'Nothing was uninstalled. Close ksx, then retry uninstall.', mbError, MB_OK);
  end;
end;

// The installed helper's `cleanup-owned`, which is the only thing allowed to
// judge whether the machine is back to the way KSX found it.
function OwnedRecoveryReleased(): Boolean;
var
  ResultCode: Integer;
begin
  Result := False;
  try
    if not Exec(ExpandConstant('{app}\{#WinUsbHelper}'), 'cleanup-owned',
                ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    begin
      MsgBox(
        'KSX could not start its WinUSB recovery helper. Nothing was uninstalled.' + #13#10#13#10 +
        'Reopen KSX/recovery, then retry uninstall.', mbError, MB_OK);
      exit;
    end;

    if ResultCode = 0 then
    begin
      Result := True;
      exit;
    end;

    if ResultCode = 4 then
      MsgBox(
        'Windows needs recovery or a restart before KSX can be removed. Nothing was uninstalled.' + #13#10#13#10 +
        'Restart if requested, reopen KSX/recovery, then retry uninstall.', mbError, MB_OK)
    else
      MsgBox(
        'KSX could not verify that its WinUSB changes were fully released (recovery exit code ' +
        IntToStr(ResultCode) + '). Nothing was uninstalled.' + #13#10#13#10 +
        'Reopen KSX/recovery, then retry uninstall.', mbError, MB_OK);
  except
    MsgBox(
      'KSX recovery could not be verified: ' + GetExceptionMessage + #13#10#13#10 +
      'Nothing was uninstalled. Reopen KSX/recovery, then retry uninstall.', mbError, MB_OK);
  end;
end;

// `TUninstallStep` is (usAppMutexCheck, usUninstall, usPostUninstall, usDone),
// and Inno sends all of them AFTER the "are you sure you want to completely
// remove ksx?" confirmation. usUninstall is the documented one sent just before
// the uninstaller starts uninstalling, so it is the last moment at which
// nothing has been removed yet and a refusal still costs the user nothing.
// usAppMutexCheck would also be after the question, but it is for checking
// application mutexes, not for mutating a driver store.
//
// There is no `ussInit`. That name was written here once, from the `ss` prefix
// of TSetupStep, and ISCC is the only thing in this repository that would ever
// have said so.
//
// ORDER IS THE CONTRACT: quiesce first, because releasing a keyboard out from
// under a live Play session races the driver rollback.
//
// `Abort` is deliberately outside every `try` in this section. Pascal Script's
// `except` catches EAbort like any other exception, so an Abort raised inside
// one of the two functions above would be swallowed by that function's own
// handler and the uninstall would carry on deleting — which is the exact
// failure this gate exists to prevent.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep <> usUninstall then
    exit;

  if not SessionQuiesced() then
    Abort;

  if not OwnedRecoveryReleased() then
    Abort;
end;

// ---------------------------------------------------------------------------
// The bundled ViGEmBus install
// ---------------------------------------------------------------------------
//
// WHY HERE. `ksx install-drivers` needs an administrator token and ksx never
// self-elevates, so before this existed the only route to a working pad on a
// fresh machine was a shell command typed from an elevated prompt. Setup is
// already elevated and the user has already agreed to that, so this is the
// one moment in the product where the driver can go in for free. It is also
// the last moment before docs/FIRST-RUN.md's seven moments begin, and §7 makes
// "no terminal" the acceptance test for all of them.
//
// WHY THE VERB AND NOT THE .EXE. `drivers\ViGEmBus_1.22.0_x64_x86_arm64.exe`
// is sitting right there and Exec could run it in one line. It must not.
// `ksx install-drivers` is where docs/DRIVERS.md's guarantees live: the bundle
// is located only under a directory a standard user cannot write, opened ONCE
// with writers and deleters denied, SHA-256'd and Authenticode-checked THROUGH
// that handle, and executed at the path that handle itself resolves to. Every
// one of those exists because this is a kernel driver going in with an
// administrator token, and none of them becomes less necessary because it is
// Inno doing the running. One code path owns the checks.
//
// WHY IT IS ALSO THE UPGRADE AND REPAIR PATH. The verb is idempotent by
// construction: with ViGEmBus healthy its plan is `already-installed`, which
// runs nothing and exits 0, so a re-install and an upgrade both cost one
// process start. The one machine it does act on is the broken one - a
// registered service whose ViGEmBus.sys has gone missing - which is exactly
// what `ksx doctor` tells people to fix this way.
//
// WHY IT CANNOT FAIL THE INSTALL. A driver that will not go in leaves a ksx
// that still installs, still runs, still configures and still maps. It just
// cannot plug a pad. Turning that into a failed install would take away the
// nine tenths that work to punish the one tenth that did not, so every path
// below records what happened (in `DriverNote`, declared at the top of this
// section) and returns.

// ksx's own report from the run, kept where a person can find it. Setup is
// elevated and this is inside the install directory, so a standard user can
// read it and not rewrite it.
function DriverLogPath: string;
begin
  Result := ExpandConstant('{app}\install-drivers.log');
end;

// The sentence every failure ends with. Named once because a retry route the
// user cannot perform is not a retry route: the installer comes FIRST because
// it needs no terminal (FIRST-RUN.md §6 - "the only way out of a mistake is a
// shell command" is on the list of things that must never happen), and the
// command is named second for the people who do have one.
function DriverRetryAdvice: string;
begin
  Result :=
    'ksx itself is installed and works - it just cannot create a controller until the driver is in.' + #13#10#13#10 +
    'To try again: run this installer again with "Install the ViGEmBus controller driver" ticked,' + #13#10 +
    'or, from a terminal opened as administrator:  ksx install-drivers --yes';
end;

procedure InstallControllerDriver;
var
  ResultCode: Integer;
  Params: string;
begin
  // Through the command processor so ksx's report is captured rather than
  // thrown at a hidden console. `/S` makes the quoting rule deterministic:
  // cmd strips exactly the first and last quote of what follows /C and takes
  // the remainder literally, which is the only form that survives an install
  // directory with spaces in it - and the default one has two.
  Params := '/S /C ""' + ExpandConstant('{app}\{#AppExe}') +
            '" install-drivers --yes > "' + DriverLogPath + '" 2>&1"';

  if not Exec(ExpandConstant('{cmd}'), Params, ExpandConstant('{app}'),
              SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    DriverNote :=
      'The ViGEmBus controller driver was NOT installed: ksx.exe could not be started.' + #13#10#13#10 +
      DriverRetryAdvice;
  end
  else if ResultCode = 0 then
  begin
    // Installed, or already present and left alone. Both are the outcome the
    // checkbox asked for, so neither is worth a word on the last page.
    DriverNote := '';
    exit;
  end
  // The exit codes are `ksx install-drivers`'s documented contract
  // (crates\ksx-backend\src\install.rs): 2 = refused before anything ran,
  // 3 = the ViGEmBus setup itself ran and failed, 1 = unexpected.
  else if ResultCode = 2 then
  begin
    DriverNote :=
      'The ViGEmBus controller driver was NOT installed: ksx refused to run the bundled setup.' + #13#10 +
      'That means the bundled file failed one of the two checks ksx makes on it - its SHA-256 or' + #13#10 +
      'its signature - or it was not found where this installer put it.' + #13#10#13#10 +
      'Details: ' + DriverLogPath + #13#10#13#10 + DriverRetryAdvice;
  end
  else if ResultCode = 3 then
  begin
    DriverNote :=
      'The ViGEmBus driver setup ran and reported a failure.' + #13#10 +
      'It keeps its own log in the TEMP folder, named ViGEmBus*.log.' + #13#10#13#10 +
      'Details: ' + DriverLogPath + #13#10#13#10 + DriverRetryAdvice;
  end
  else
  begin
    DriverNote :=
      'The ViGEmBus controller driver install did not complete (ksx install-drivers exited with code ' +
      IntToStr(ResultCode) + ').' + #13#10#13#10 +
      'Details: ' + DriverLogPath + #13#10#13#10 + DriverRetryAdvice;
  end;

  // Said out loud, once, at the moment it happened. A failed driver install is
  // the one outcome here that produces a ksx which looks completely fine and
  // silently cannot do the thing it is for; leaving it to a line on the last
  // page would be reporting success while nothing works, which is this
  // project's signature bug (docs/FIRST-RUN.md §6). It is a message, not an
  // abort - the install carries on either way. Skipped in a silent install,
  // where by definition nobody is watching and the log is the report.
  if not WizardSilent then
    MsgBox(DriverNote, mbError, MB_OK);
end;

// ---------------------------------------------------------------------------
// The explicit HIDMaestro install/repair boundary
// ---------------------------------------------------------------------------
//
// The runtime host is intentionally unable to install, update or repair a
// package. Setup is already elevated and this checked task is the one bounded
// place that can download, verify, and invoke the exact pinned upstream v1.6.1
// installer API. Exit 4 means network/download failure; exit 5 means a pin
// mismatch; 6/7 are API/install failures; 8 means InstallDriver returned
// successfully but verified temporary cleanup is still pending; 9 means setup
// was redirected outside the protected Program Files boundary; 10 means exact
// residue from an earlier run could not be verified and removed before install.
function HidMaestroFailureReason(ResultCode: Integer): String;
begin
  case ResultCode of
    2: Result := 'the fixed install command was rejected';
    3: Result := 'another HIDMaestro install is already running';
    4: Result := 'the official v1.6.1 archive could not be downloaded';
    5: Result := 'the downloaded archive or a required assembly did not match its pinned hash';
    6: Result := 'the pinned installer API was not exact';
    7: Result := 'the upstream driver installation failed';
    8: Result := 'the driver installed, but verified temporary SDK cleanup is pending';
    9: Result := 'the helper was not running from protected Program Files';
    10: Result := 'an earlier KSX staging directory could not be safely verified or removed';
  else
    Result := 'an unexpected installer error occurred';
  end;
end;

function HidMaestroFailureAdvice(ResultCode: Integer): String;
begin
  case ResultCode of
    3: Result := 'Let the other HIDMaestro setup finish, then run this installer again.';
    4: Result := 'Check the internet connection, then run this installer again with the HIDMaestro task selected.';
    5: Result := 'The upstream download no longer matches this release. Install a newer KSX release instead of bypassing the verification.';
    6: Result := 'This KSX release could not prove the pinned installer API. Install a newer KSX release instead of bypassing the verification.';
    7: Result := 'Restart Windows, then run this installer again with the HIDMaestro task selected.';
    9: Result := 'Install KSX under protected Program Files, then run the HIDMaestro task again.';
    10: Result := 'Close KSX and Setup, restart Windows, then run this installer again. Nothing unexpected was deleted.';
  else
    Result := 'Restart Windows, then run this installer again with the HIDMaestro task selected.';
  end;
end;

procedure InstallHidMaestroDriver;
var
  ResultCode: Integer;
begin
  if not Exec(ExpandConstant('{app}\{#HidMaestroInstaller}'), 'install-v1',
              ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    HidMaestroNote :=
      'The HIDMaestro controller driver was NOT installed because its installer could not start.' + #13#10 +
      'Existing DualSense availability did not change. Restart Windows, then run this installer again with the HIDMaestro task selected.';
    exit;
  end;
  if ResultCode = 0 then
  begin
    HidMaestroNote := '';
    exit;
  end;
  if ResultCode = 8 then
  begin
    HidMaestroNote :=
      'The HIDMaestro controller driver installed, but Setup could not remove its verified temporary SDK files ' +
      '(installer exit code 8).' + #13#10 +
      'DualSense may already be available. Close KSX and Setup, wait at least two minutes (or restart Windows), then run this installer again; ' +
      'it removes only exact hash-verified KSX staging residue.';
    if not WizardSilent then
      MsgBox(HidMaestroNote, mbInformation, MB_OK);
    exit;
  end;
  HidMaestroNote :=
    'The HIDMaestro controller driver install did not complete (installer exit code ' +
    IntToStr(ResultCode) + ': ' + HidMaestroFailureReason(ResultCode) + ').' + #13#10 +
    'KSX could not confirm current DualSense readiness. ' + HidMaestroFailureAdvice(ResultCode);
  if not WizardSilent then
    MsgBox(HidMaestroNote, mbError, MB_OK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep <> ssPostInstall then
    exit;

  // FIRST, and before the driver: the helper is installed now, so it can prove
  // its own location and normalize the fixed store. This is the step that may
  // roll the install back; everything after it may not.
  InitializeRecoveryStore;

  if WizardIsTaskSelected('vigembus') then
  begin
    // The verb can take half a minute on a cold machine. A wizard that sits on
    // "Finishing installation..." for that long looks hung, and the one thing
    // a user must not do here is kill setup mid driver install.
    if not WizardSilent then
      WizardForm.StatusLabel.Caption := 'Installing the ViGEmBus controller driver...';
    // Belt and braces on "nothing here may fail the install". An exception
    // raised anywhere below - a constant that did not expand, a log path that
    // cannot be written - propagates out of CurStepChanged and ROLLS THE
    // INSTALL BACK, which is the single outcome this whole section exists to
    // prevent. It would also be invisible until somebody ran the shipped
    // setup.exe: ISCC compiles a broken ExpandConstant perfectly happily, so
    // the CI job that proves this file COMPILES proves nothing about this.
    try
      InstallControllerDriver;
    except
      DriverNote :=
        'The ViGEmBus controller driver step could not be run: ' + GetExceptionMessage + #13#10#13#10 +
        DriverRetryAdvice;
    end;
  end
  else
    // Their choice, and it is a real one - but a choice they can only reverse
    // if somebody tells them how. Not an error, not a dialog: one paragraph on
    // the page they are already reading.
    DriverNote :=
      'You chose not to install the ViGEmBus controller driver. Everything else in ksx works;' + #13#10 +
      'it cannot create a controller until that driver is in. Run this installer again with the' + #13#10 +
      'driver box ticked whenever you want it.';

  if WizardIsTaskSelected('hidmaestro') then
  begin
    if not WizardSilent then
      WizardForm.StatusLabel.Caption := 'Installing the HIDMaestro controller driver...';
    try
      InstallHidMaestroDriver;
    except
      HidMaestroNote :=
        'The HIDMaestro controller driver step could not be run: ' + GetExceptionMessage + #13#10 +
        'KSX could not confirm current DualSense readiness. Restart Windows, then run this installer again with the HIDMaestro task selected.';
    end;
  end
  else
    HidMaestroNote :=
      'You chose not to install or repair the HIDMaestro controller driver. Existing DualSense availability did not change.' + #13#10 +
      'Run this installer again with the HIDMaestro box ticked whenever you want to install or repair it.';
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  // The last page the user sees, and the only place a note about something
  // that already happened can still reach them.
  if CurPageID = wpFinished then
  begin
    if DriverNote <> '' then
      WizardForm.FinishedLabel.Caption :=
        WizardForm.FinishedLabel.Caption + #13#10#13#10 + DriverNote;
    if HidMaestroNote <> '' then
      WizardForm.FinishedLabel.Caption :=
        WizardForm.FinishedLabel.Caption + #13#10#13#10 + HidMaestroNote;
  end;
end;
