---
name: ksx-milestone
description: Execute a KSX milestone using the current playbook, contract reviews, software gates, and explicitly recorded hardware acceptance. Use when starting or resuming a KSX milestone.
---

# Executing a ksx milestone

You are working on standalone KSX. Resolve the repository root from the current
workspace instead of assuming a developer-specific checkout path. The user's
milestone request comes from the skill argument or conversation.

## Before writing any code

1. Read `docs/PLAYBOOK.md` (process rules), `docs/ARCHITECTURE.md` (pipeline and
   exit criteria), and only the current research documents relevant to the work.
2. Inspect the working tree and current task state before assigning ownership.
3. Verify machine state matches expectations with `cargo run -q -p ksx-app -- doctor`
   before touching anything driver-related. Facts from `doctor` beat docs.

## Execution shape (from PLAYBOOK.md)

Run implementation as a workflow: contracts (if new shared types are needed) →
parallel implementers with strict crate ownership → **2 adversarial reviewers**
with distinct lenses (current-contract correctness; crash/hang/recovery safety).
This ratio is mandatory for driver-touching milestones. Reviewers fix mechanical
issues and report semantic ones.

Every agent prompt must include: repository root, required reading list, the
crate(s) it owns, the gate commands, "no git commits", and the CLI rules (stable
exit codes, `--json`).

## Definition of done

1. The full gate is green (exact commands in PLAYBOOK.md §4).
2. Any required physical acceptance gate is run on the target hardware and its
   evidence is recorded; never infer a physical pass from software tests.
3. Safety-critical capture work has kill-recovery verified
   (`taskkill /f` → keyboards return <1 s) before calling it done.
4. Commit or push only when the user explicitly requests it, targeting `main`.
5. The task and `docs/HANDOFF.md` accurately state the result and any remaining
   machine-state constraints.

## Safety rails (never skip)

- Treat `docs/DRIVERS.md` and `docs/RECOVERY.md` as the authority for host
  policy; do not mutate Windows update policy as part of a coding task.
- Before any capture-layer experiment, re-read `docs/RECOVERY.md` and confirm a
  spare non-captured keyboard exists.
