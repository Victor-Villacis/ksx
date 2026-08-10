# Releasing

A release is a pushed tag. There is nothing to click.

```sh
git switch main && git pull
# bump BOTH versions in the same commit (see below), then:
git tag v0.2.0
git push origin v0.2.0
```

That is it. `gh run watch` if you want to see it happen; a release appears on
the [releases page](https://github.com/Victor-Villacis/ksx/releases)
with `ksx-0.2.0-setup.exe` attached, and `docs/FIRST-RUN.md` §1 moment 1 — "a
`.exe` from the releases page. One file." — is satisfied.

There is **no GitHub Release to create by hand first.** Creating one in the web
UI works only *because* it creates a tag; the tag is the trigger, so the UI step
is optional polish and never a requirement.

## The tag pattern

`v*`, declared in `.github/workflows/release.yml`. The same pattern the owner's
other repos release from, which is the reason it is `v*` and not something
cleverer.

The version part is not free text. `v<major>.<minor>.<patch>`, digits only: a
`v0.2.0-rc1` is refused in the first seconds of the run, because Inno Setup's
`VersionInfoVersion` is a numeric Windows version resource and cannot hold a
suffix. ksx has no prerelease channel.

## Two files must already say what the tag says

| file | field | what it becomes |
|---|---|---|
| `packaging/ksx.iss` | `#define AppVersion` | the installer's filename, its `VersionInfoVersion`, and the "ksx 0.2.0" row in Apps & Features |
| `Cargo.toml` | `[workspace.package] version` | what `ksx --version` prints |

`crates/ksx-app/tests/installer.rs` fails if those two disagree, so an ordinary
`cargo test` catches the common mistake (bumping one of them) long before a tag
exists. The release **also** checks the tag against both, before it builds
anything, and **fails rather than deriving** — see the long comment in
`.github/workflows/build-installer.yml` for why a version patched in by CI is
worse than a refused release.

If the tag was wrong, nothing has been built and nothing published:

```sh
git tag -d v0.2.0 && git push origin :refs/tags/v0.2.0
```

Fix the tree, commit, tag again. Do not reuse a version number that already has
a release: the tag is public the moment it is pushed.

## What the run does

`release.yml` calls `ci.yml` whole — fmt, clippy, all four feature
combinations, the test suite — and only then builds. A release cannot ship a
binary that skipped a check an ordinary branch push would have run. The build
itself is `build-installer.yml`, the same reusable workflow every branch push
uses, so branch candidates and tagged releases share one recipe rather than two
hand-copied command lines. The gate must still record the exact artifact hash;
workflow equivalence is not a substitute. Gates 1–4 are **NOT RUN** for 0.2.0
until their ledgers name that evidence.

The build also treats WinUSB preparation as an installed security boundary:

1. build `ksx-winusb-helper.exe` as an x64 Windows GUI-subsystem executable and
   verify its embedded `requireAdministrator` manifest;
2. build the prepare-only `libwdi.dll` twice in separate directories with the
   pinned Windows runner/toolset and reject differing SHA-256 hashes;
3. run the provider's disposable elevated smoke: generate a synthetic signed
   package, use `pnputil /add-driver` **without `/install`**, prove Windows
   accepts it, then delete that exact published package and prove package,
   certificate, key-container and work-directory absence in `finally`; and
4. package helper, provider and corresponding source only in the installer.

Those steps being present in YAML are not evidence that they passed. For the
current 0.2.0 candidate, the clean-runner provider/helper/ISCC job is **NOT
RUN** until Actions records it against the candidate commit. Local DLL hashes
and developer-machine diagnostics are not release evidence.

Then it publishes: `gh release create` with the repository's own
`GITHUB_TOKEN` (no PAT, no secret to rotate, no third-party action), attaching

1. `ksx-<version>-setup.exe` — the file, and
2. `ksx-<version>-windows-x86_64-portable.zip` — `ksx.exe`, the console-free
   launcher, product licences, `NOTICE`, and full third-party licence material,
   for advanced use without an installer. It deliberately omits
   `ksx-winusb-helper.exe`, `libwdi.dll`, their corresponding source and the
   protected ProgramData journal contract, so it cannot perform supported
   built-in preparation/release.

The release body comes from `packaging/release-notes.md` with the version, the
installer's name and SHA-256, the portable ZIP name, and the commit substituted
in. **Edit the prose there**, not in the workflow. Before publishing, the job
re-hashes both downloaded assets and refuses to publish if either does not match
what the build computed, so the installer SHA-256 on the page is provably the
SHA-256 of the attached installer.

## Two gotchas, both cheap to hit

1. **`on: push: tags` runs the workflow file as it exists at the tagged
   commit.** A `release.yml` that only exists on a branch will not run. Tag
   `main`, after merging. The visible symptom of not having merged yet is that
   `gh workflow view release.yml` answers *"not found on the default branch"*
   and the Actions tab lists only CI — GitHub registers workflows from the
   default branch, so an unmerged release workflow is invisible AND inert.
2. **A tag pushed by `GITHUB_TOKEN` from inside Actions does not trigger
   workflows.** A tag you push from your machine does, which is the path above.

## SmartScreen, and why the release body talks about it

The installer is not code-signed, so Windows shows "Windows protected your PC"
with only a *Don't run* button visible. That is a statement about a certificate
this project has not bought, not a finding about the file — but a first-time
user meeting an unexplained warning stops there, and no later screen gets a
turn. So the release body names the dialog, gives the two clicks through it
(*More info* → *Run anyway*), says why plainly, and then gives the SHA-256 and
the commit so the file can be checked instead of trusted.

Signing it would remove the dialog and is the only thing that would. Until then
the honest paragraph is the product, and `crates/ksx-app/tests/installer.rs`
fails if it goes missing.

The installer's SmartScreen signature and the machine-local certificate used
for a generated WinUSB package are unrelated. The latter is created only after
three explicit in-app confirmations and UAC, has its private key deleted before
its public half is trusted, and is removed by verified Release/uninstall. It
does not sign the KSX installer and does not make the release “code-signed.”
