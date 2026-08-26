# Releasing

A pushed numeric tag starts a release **candidate**. It does not immediately
publish one.

```sh
git switch main && git pull
# bump BOTH versions in the same commit, merge it, and let main CI pass
git tag v0.5.0
git push origin v0.5.0
```

**Check whether the bump is already there before you make one.** The version
in the tree is not a record of what shipped; it is a claim about what the next
tag will be, and it is routinely raised in the commit that starts a cycle
rather than the one that ends it. So compare `git tag --list 'v*'` against
`#define AppVersion` before touching either version field: when the tree
already carries a version that has never been tagged, the whole first half of
that snippet is a no-op and the release is just the two `git tag` lines. A
reflex bump there does not merely waste a number — it abandons a version that
the .iss, `Cargo.lock`, and the release notes have already been written
against, and every one of them has to be moved again.

The Release workflow first proves the tag is exactly the current
`origin/main` HEAD, executes the complete clean-runner CI, and builds the
installer and portable ZIP once. Publication then waits at the protected
GitHub Environment named `production`. A reviewer installs and tests that
run's exact candidate before approving it.

There is no GitHub Release to create by hand first. The tag is the build
trigger; approval is the promotion action.

## Required repository controls

Before pushing any release tag:

1. GitHub Environment `production` has a required reviewer, allows only `v*`
   deployment refs, and has administrator bypass disabled.
2. Repository variable `KSX_PRODUCTION_APPROVAL_CONFIGURED` is exactly `true`.
3. Active ruleset `KSX main promotion gate` requires pull requests, an
   up-to-date branch, all six CI jobs, and blocks force-push/deletion.
4. Active ruleset `KSX release tag immutability` blocks deletion or movement
   of `v*` tags.
5. Repository **immutable releases** are enabled, locking a published release's
   tag and assets and producing GitHub's release attestation.
6. Repository Actions require full-length commit-SHA pins for third-party
   actions.
7. Run the maintainer audit from an authenticated `gh` session:

   ```powershell
   tools/release/assert-promotion-controls.ps1 `
     -Repository Victor-Villacis/ksx `
     -ApprovalConfigured true `
     -RequireNoRulesetBypassActors `
     -RequireStudioPipelineChecks
   ```

The publish job fails closed when the repository variable is absent. This
prevents GitHub's auto-creation of an unprotected environment from silently
turning a tag into a public release, but the variable is not a substitute for
the required-reviewer setting. The workflow trusts the `${{ vars }}` value it
received and repeats the API-visible environment/ruleset structural audit
before candidate construction and after approval. Its built-in token cannot
API-read the repository variable, immutable-release setting, Actions policy,
or complete ruleset bypass lists. Only the maintainer command above certifies
those administrative controls, and it fails if its token lacks the necessary
visibility.

When these two Studio jobs and full-SHA action pins are introduced for the
first time, merge their workflow before making the check names required or
enabling repository-wide SHA enforcement. Immediately after that merge, run
`tools/release/activate-studio-promotion-checks.ps1 -Repository
Victor-Villacis/ksx -Confirm:$false`; it refuses to activate until GitHub's
default branch contains both jobs and every workflow action is pinned to a
40-character SHA. No release tag may be cut between that merge and the
successful six-check administrative audit.

## The tag and version contract

The trigger pattern is `v*`, but the accepted version is digits-only
`v<major>.<minor>.<patch>`. A suffix such as `-rc1` is refused because Inno
Setup's Windows `VersionInfoVersion` cannot carry it.

Two files must already agree with the tag:

| file | field | what it becomes |
|---|---|---|
| `packaging/ksx.iss` | `#define AppVersion` | installer filename, Windows version metadata, and Apps & Features row |
| `Cargo.toml` | `[workspace.package] version` | `ksx --version` |

Tests pin those files to each other. The workflow also checks the tag and
fails rather than patching a version into the source.

Release tags are immutable once pushed, including when candidate QA fails.
Fix and commit, increment the version, and cut a new candidate tag. Never
delete, move, or reuse a `v*` tag: the repository ruleset rejects those
operations so an old evidence ledger can never name new bytes.

## Exact candidate QA

An ordinary main run and a tag run can produce different installer/ZIP bytes
at the same commit. Similar recipes are not identical artifacts. Therefore the
only valid installed QA target is the artifact produced by the Release run
that is waiting for approval.

When its `ci` job finishes, download these three artifacts from that same run:

- `ksx-windows-installer`
- `ksx-windows-portable`
- `ksx-windows-candidate-manifest`

The manifest records its schema, repository, commit, ref, Release run id and
attempt, tag/version, pinned and active Rust toolchain, and both distributable
filenames, sizes, and SHA-256 values. Independently hash the manifest and
installer. Record in `docs/GATES.md`:

- tag/version;
- commit;
- Release run id and attempt;
- candidate-manifest SHA-256;
- installer filename and SHA-256;
- machine/operator/timestamps and each gate result.

Install that setup file and complete the supervised hardware/product gates.
Reject the environment deployment on any failure. Approve `production` only
when the exact candidate's ledgers pass.

GitHub artifact retention is 30 days. The 14-day soak fits inside that window;
do not approve after artifacts or evidence have expired.

The manifest binds `run_attempt`. If a candidate workflow is rerun, rerun the
whole workflow and repeat QA against the new attempt's manifest and bytes.
Rerunning only a failed publish job against an earlier-attempt manifest is
intentionally refused. A whole-run retry is possible only while the immutable
tag is still the current `origin/main` tip; if main advanced during the soak,
fix/increment as needed and cut a new candidate version instead.

## What approval publishes

After approval, the publish job downloads the three artifacts from the same
workflow run. It verifies:

- manifest hash and JSON schema;
- repository, commit, ref, run id/attempt, tag, and toolchain;
- both artifact filenames, sizes, and SHA-256 values;
- the reusable build job's independently reported hashes.

Only then does publication create a **private draft** and upload the
already-built installer, portable ZIP, and candidate manifest. GitHub's own
reported name, size, and SHA-256 digest for all three must match before the
draft becomes public. The workflow then confirms `isImmutable=true`; a partial
upload therefore never becomes a customer release. It never recompiles or
repackages. Release notes come from `packaging/release-notes.md`; edit the prose
there. The installer hash shown in the notes is consequently the hash of the
exact file QA installed and the exact file customers download.

Release workflows use GitHub's `queue: max` concurrency mode so immutable tag
events wait FIFO instead of replacing one another. If a newer release already
exists, an older candidate is published without moving GitHub's “Latest” marker
backward.

The portable ZIP remains an advanced, non-installing distribution. It omits
the protected WinUSB/HIDMaestro helpers and their Program Files/ProgramData
security boundary; the installer is the supported first-run path.

## Clean-runner boundaries

The reusable CI covers the same checks as every branch plus the release build:
format/lint/test feature matrices, browser suites, deterministic Studio assets,
PowerShell environment lifecycle, compile-only cabinet hardware tests,
HIDMaestro evidence, installed provider smoke, installer upgrade behavior, and
artifact packaging. A local hash or build is diagnostic only and can never be
substituted for the run's candidate.

The WinUSB/provider steps deliberately build and test the installed-only
helper boundary on the Windows runner. They do not make a fixture or loose
portable copy equivalent to an installed candidate, and they do not replace
the supervised physical gates.

## Trigger gotchas

1. `on: push: tags` uses the workflow file at the tagged commit. Merge the
   workflow to `main` before tagging. The preflight additionally refuses any
   tag that is not the exact current `origin/main` HEAD.
2. A tag pushed by `GITHUB_TOKEN` inside Actions does not trigger workflows.
   Push the tag from an authenticated human/developer session.
3. Do not approve a run merely because all automated jobs are green. The
   protected environment exists specifically for installed, real-hardware QA
   of that run's bytes.

## SmartScreen

The installer is not code-signed, so Windows may show “Windows protected your
PC.” The release notes explain *More info* → *Run anyway* and provide the exact
SHA-256 and commit. Signing the public installer would remove that warning;
the machine-local certificate used for generated WinUSB packages is unrelated
and does not sign the KSX installer.
