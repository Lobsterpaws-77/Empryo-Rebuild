---
name: staged-candidate-acceptance
description: Acceptance and release recipe for staged candidates. Keeps the candidate intact, surfaces manual gates exactly, and never lets "enable the staged candidate" escalate into "install to production". Use when validating a build or app candidate, or before any release-like step.
---

# Staged candidate acceptance

A project recipe built on the harness's provenance support. Copy this folder
to `<project>/.soulforge/skills/` (or `~/.soulforge/skills/` for all projects).

## Principles

1. **Identify the candidate before judging it.** Run `/preflight`, or
   `soulforge --preflight`. The report names the exact source state
   (commit, clean or dirty, candidate id). Every claim you make about the
   candidate refers to that id.
2. **Evidence belongs to one candidate.** Test, typecheck, lint and build
   results from the `project` tool are recorded against the candidate id
   automatically. After any edit the id changes and old evidence is
   **stale**. Re-run it; never reuse it.
3. **Dirty means development.** A candidate with uncommitted or untracked
   changes is a development build. Say so, and never call it a release
   candidate.
4. **Stop at manual gates.** When a step needs the user (enable a
   permission, click through an installer, restore credentials, approve
   signing):
   - preserve the candidate as it is: do not rebuild, clean, or "fix
     forward";
   - state the exact action required, where, and how to confirm it
     worked;
   - wait. Do not substitute a broader action.
5. **No scope escalation.** "Enable the staged candidate" never becomes
   "install into production". "Build a candidate" never becomes "publish".
   If the only available path is broader than what was asked, stop and ask.

## Sequence

1. `/preflight` → record the candidate id and which evidence is missing
   or stale.
2. Run what's missing with `project`: typecheck, lint, test, build. Fix
   failures with focused code workers, not broad refactors.
3. Re-run `/preflight`. It must show `pass` for the required evidence on
   the same candidate id.
4. Black-box acceptance steps (the project's own list). Record each
   outcome in the final report together with the candidate id.
5. Manual gates → Principle 4.
6. Final report: the candidate id; evidence status per kind; acceptance
   results; open manual actions; and, for code workers, their `RESULT`
   blocks (reproduced / changed / tests / validation / uncertainty /
   invariants).

## Release policy (optional, per project)

Put this in `<project>/.soulforge/config.json`:

```json
{ "release": { "requireClean": true, "requireTag": true,
               "requiredEvidence": ["typecheck", "lint", "test", "build"] } }
```
