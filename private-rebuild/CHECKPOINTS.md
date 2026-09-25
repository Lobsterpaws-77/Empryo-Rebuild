# Checkpoint log

Baseline (CP0 source state): `6329f0dd26934998d188b88fa52a3e2ac69b0fc6`.
Each entry lists what changed, how it was validated, and the remaining risk.
The 14 `structural_edit` failures exist at baseline and are excluded as pre-existing
(see `CP0_BASELINE_AUDIT.md`).

## CP0 — baseline + source audit — `eac76d1`

The audit is in `CP0_BASELINE_AUDIT.md`.

## CP1 — routing correctness: lane model + effort resolved together — `d32c15d` + `09e541c`

> History note: `d32c15d` ("test") is part of CP1. A worker process committed
> once from the main checkout by mistake and swept up CP1's staged deletion of
> `src/core/llm/task-router.ts`. CP1 is the two commits together. The history
> was deliberately left as is (no force-push).

**Classification:** SHARED CORE.

### Defects fixed

1. **Workers never received reasoning options.** `createAgent` built provider
   options from `LanguageModel.modelId`, which is provider-local (for example
   `claude-sonnet-4-6`). `buildProviderOptions` needs the full
   `provider/model` id for capability gating, so it returned `{}`. As a result,
   every worker effort, including the old explore → `low` override, was
   silently dropped. Workers now use the route's full id when it names the
   selected model.
2. **Model and effort came from different lanes** (the core analogue of the
   desktop Graph Node / Graph Judge bug). The verifier's model came from the
   `verify` lane, but its effort came from the explore role (`low`).
   De-sloppify's model came from its lane, but its effort was the generic
   global value. Both now resolve model and effort from their own lane.
3. **Scope mismatch.** Worker effort was read with `loadConfig()` (the global
   file only). Workers now use the effective global+project snapshot of the
   Forge turn, which is the same config the UI reports.
4. **No per-lane effort.** Added `taskRouter.effort[lane]`.

### Design

- `src/core/llm/lane-routing.ts` is a pure, table-driven resolver. For each
  lane it returns `{ modelId, modelSource, effort, effortSource }`.
  Precedence: per-dispatch override → lane setting → documented lane fallback
  → provider default. An unrelated lane never supplies effort.
- Lane fallbacks:

| Lane | Model fallback | Effort fallback |
|---|---|---|
| spark (Explore) | `spark` → legacy `exploration`, `trivial` → Forge model | built-in `low` when a global effort is set (historical behaviour), else provider default |
| ember (Code) | `ember` → legacy `coding` → Forge model | global `performance.effort` |
| verify (Review) | `verify` → Forge model | global |
| desloppify (Cleanup) | `desloppify` → disabled | global |
| webSearch | `webSearch` → disabled | global |
| compact | `compact` → `taskRouter.default` → Forge model | global |
| semantic, default | as before | not configurable per lane (no reasoning options are sent) |

- `registerRoutingLane()` lets another surface (for example desktop Graph
  Node or Graph Judge) add lanes that get the same resolution. The
  `AgentTask.lane`, `AgentTask.effort` and `AgentTask.model` (with
  `SubagentModels.modelFactory`) fields are the per-dispatch / per-node
  override hooks.
- `applyLaneEffort()` shapes only the `performance` knobs that
  `buildProviderOptions` already reads. Provider and auth code is untouched.
- `src/core/llm/subagent-routing.ts` is one builder shared by the TUI
  (`useChat`) and headless (`run.ts`). It replaces two hand-rolled copies.
  `resolveTaskModel` (`task-router.ts`), now unused, was removed.
- The cache tier (spark/ember) is now purely a prompt-cache concept, computed
  from the lane model actually used.
- Visibility: `agent-start` / `agent-done` events and `model-events` records
  now carry `lane`, `effort`, `modelSource` and `effortSource`. Each turn logs
  the full lane table (`router:lanes`) to the background error/log store.

### Restart / resume semantics (deliberate)

Routing is snapshotted once per Forge turn. All workers in that turn use the
snapshot. A resumed session re-resolves from the current config on its next
turn. Nothing persists resolved routes across restarts, so there is no
accidental mix of old and new routing.

### Behaviour changes to verify locally

- Workers now actually send reasoning options (effort and, where
  configured, Anthropic thinking), as the original code intended. This can
  change worker cost and latency. **LOCAL ACCEPTANCE REQUIRED.**
- The verifier now inherits the global effort (or `effort.verify`) instead
  of an accidental `low`.
- In read-only dispatches, code-role tasks route through the explore lane.

### Known limits

- OpenAI-compatible providers that inject reasoning when the model is built
  (`compat-reasoning.ts`: groq, fireworks, ollama, lmstudio, deepseek-chat,
  llmgateway, and non-Claude models over the proxy) read the **global**
  config, so a lane effort cannot differ from the global value there.
  `laneEffortDelivery()` reports this as `construction`.
- The Codex CLI provider exposes no effort (`unsupported`).
- Changing either would touch provider code, which is left as is.

### Validation

- `tests/lane-routing.test.ts`: 29 tests covering the acceptance matrix,
  isolation, fallbacks, snapshot scope, and provider-options effort through
  `createAgent`.
- typecheck, lint: pass.
- full suite: 3109 pass / 14 fail (baseline only).

## CP2 — orchestration shell correctness — `2ab3b33` + follow-up

**Classification:** bare-`sh` spawn defect is SHARED CORE. The desktop graph
shell node is BLOCKED BY MISSING SOURCE.

### Defect

`shellInvocation()`, `spawnShell()` and `bunShellArgs()`
(`src/core/platform/index.ts`) spawned the bare name `sh`, which is resolved
through PATH. When an app is launched from the macOS Dock or Finder, PATH can
be minimal, and callers may also pass a stripped `env.PATH`. Either way the
spawn fails with `posix_spawn 'sh' ENOENT`, even though `/bin/sh` exists. That
is the same signature as the desktop graph-shell failure.

### Fix

- `resolvePosixShell()` resolves the shell in this order and caches the result:
  1. `SOULFORGE_SHELL` (used only if it is an absolute path to an executable)
  2. `/bin/sh`
  3. `/usr/bin/sh`
  4. PATH lookup
  5. the literal `sh`

  All three spawn helpers use it on POSIX. Windows is unchanged.
- `describeShellSpawnError()` gives an attributed message for shell ENOENT,
  used by the `shell` and `project` tools. Follow-up: when the shell exists,
  ENOENT is attributed to a missing working directory (Node reports a missing
  cwd as `spawn <shell> ENOENT`).
- The hook runner (`hooks/runner.ts`), auto-format and the setup guide pick
  up the fix through the shared helpers.

### Validation

- `tests/shell-resolution.test.ts` (13 tests): stripped-PATH spawns through
  `spawnShell` and `Bun.spawn(bunShellArgs())`, override handling, and error
  attribution.
- `tests/platform-windows.test.ts`: the one assertion that hard-coded `"sh"`
  was updated.
- typecheck and lint pass.

**LOCAL ACCEPTANCE REQUIRED:** macOS GUI-launch proof, and any desktop graph
shell node, whose executor is not in this source.

Implementation note: the first commit was produced by a bounded Sonnet worker
in an isolated worktree. I reviewed and integrated it; the follow-up is mine.

## CP3 — routing controls, per-lane effort UX, strict routing

**Classification:** SHARED CORE (resolver, strict policy, dispatch/TUI/headless
enforcement) plus SOULFORGE/TUI ONLY (`/router` rendering).

### Routing audit: lanes in the supplied source

| Handoff lane | Core lane | Model control | Effort control | Status |
|---|---|---|---|---|
| Prime / Orchestrate | `forge` (new; the main conversation) | active model | global `performance.effort` | strict-checkable. Fallback chain filtered by strict |
| Explorer | `spark` | yes | **new** `effort.spark` (built-in `low` fallback kept) | done |
| Coder / Ember | `ember` | yes | **new** `effort.ember` | done |
| Reviewer / Judge | `verify` | yes | **new** `effort.verify` (was an accidental `low`) | done |
| Repair / cleanup | `desloppify` | yes | **new** `effort.desloppify` (was global) | done |
| Web research | `webSearch` | yes | **new** `effort.webSearch` (default: none sent, as before) | done |
| Compaction | `compact` | yes | **new** `effort.compact` | done |
| Soul Map summaries | `semantic` | yes | n/a (no reasoning options are sent) | unchanged |
| Graph Node, Graph Judge, Build, Test, Goal Review, Advisor, Council, Routine, Marionette | none | none | none | **BLOCKED BY MISSING EMPRYO DESKTOP SOURCE**. They can plug in with `registerRoutingLane()` |

### Config reference (`~/.soulforge/config.json` or `<project>/.soulforge/config.json`)

```jsonc
"taskRouter": {
  "ember": "openai/gpt-5-mini",
  "verify": "anthropic/claude-opus-4-6",
  "effort": { "ember": "medium", "verify": "high", "spark": "low" },
  "strict": {
    "enabled": true,
    "lanes": {
      "ember":  { "models": ["openai/gpt-5-mini"] },
      "verify": { "models": ["anthropic/claude-opus-4-6"],
                  "fallbackModels": ["anthropic/claude-sonnet-4-6"],
                  "efforts": ["high", "xhigh", "max"], "effortViolation": "reject" },
      "forge":  { "models": ["anthropic/claude-opus-4-6"] }
    }
  }
}
```

- `effort` values: `off | low | medium | high | xhigh | max`. A missing or
  `null` value means the lane's documented fallback applies (see CP1 table).
- `taskRouter` follows the existing project → global scope rule: a project
  `taskRouter` replaces the global one wholesale. Models, efforts and the
  strict policy therefore always come from one scope together.

### Strict routing behaviour (opt-in; off by default)

| Situation | Result |
|---|---|
| Permitted model | Dispatch proceeds |
| Model not permitted, or a constrained lane with no model | `StrictRoutingError`. The worker reports `agent-error` with the reason. No substitute is used, and the error is not retried |
| Model listed in `fallbackModels` | Proceeds; a note is shown |
| Effort outside `efforts` | Rejected by default. With `effortViolation: "clamp"`, the nearest permitted effort is used (ties clamp down; source `policy`) and a note is shown |
| `efforts` set but the provider can't take per-request effort (compat or Codex) | Rejected ("not enforceable") |
| `forge` lane violated | TUI turn is refused with a visible error; headless refuses to start (exit 1) |
| Other lane violated | Listed in a "Strict routing:" system message at launch (TUI) or on stderr (headless); refused at dispatch |
| Forge transient-error fallback chain | Models the `forge` policy doesn't permit are removed from the chain, and the removal is logged |
| Web-search lane violated | The web-search agent is disabled (the plain scraper still works) and the violation is reported |
| Compaction lane violated | Compaction fails with a visible message |
| Strict off, or lane not listed | Existing flexible behaviour, unchanged |

### `/router` (TUI)

- Each lane row shows its **model and effort**. Explicit values are shown in
  the accent colour. Inherited or fallback values are dim and prefixed `↳`
  (for example `↳ claude-opus-4-6`, `↳high`, `↳low` for the built-in explore
  default, `↳auto` for provider default).
- `e` / `Shift+e` cycles the selected lane's effort: inherit → off → low → …
  → max → inherit. It writes to the current scope.
- The line under the table explains the selected lane's sources. The blurb
  shows `strict` when strict routing is on, and constrained lanes are
  marked `· strict`.

### Web-search effort gap closed

The web-search agent is built per tool call and receives no provider options.
When `effort.webSearch` is set, the lane options are injected with a model
middleware (the same pattern as `resolveModel`). With no lane effort, the
model is not wrapped at all, so behaviour is identical to before.

### Validation

- `tests/strict-routing.test.ts` (19): strict matrix, clamping, launch
  validation, fallback filtering, dispatch refusal, strict resolve failure,
  web-search injection and disable, effort cycling.
- `tests/router-settings-effort.test.tsx` (2): headless render of `/router`
  (explicit vs inherited display, `e` key).
- Found and fixed during testing: a clamped effort was not being applied,
  because it kept the `global` source. It now uses the `policy` source.
- Full suite 3142 pass / 14 fail (baseline only). typecheck and lint pass.

**LOCAL ACCEPTANCE REQUIRED:** a live strict failure and fallback with real
provider accounts.

## CP4 — Review scope + worker-aware repair

**Classification:** SHARED CORE. The desktop Review panel and Apply button are
**BLOCKED BY MISSING EMPRYO DESKTOP SOURCE**.

### Current Review scope (reproduced from source; unchanged)

The core "Review" is the post-dispatch verifier (`verify` lane,
`agentFeatures.verifyEdits`).

| Case | Behaviour |
|---|---|
| Worker-authored edits | Reviewed. Scope is every file edited on the dispatch's AgentBus, including de-sloppify and repair |
| Mixed edits from several workers | All of them are reviewed together, with the requesting task context |
| Prime (Forge)-authored edits | Not reviewed. They happen outside a dispatch, and the core has no separate Review feature |
| Clean / no edits, or no code tasks | No review (`null`) |

This scope is coherent for a post-dispatch check, and no provenance defect
was found, so it is left unchanged. The gap was what happens on a FAIL
verdict: the findings went back to the Forge, which then usually edited
the code itself.

### Change: review → repair worker → recheck (opt-in)

- `agentFeatures.repairOnReviewFail` (toggle in `/agent-features`; default
  off) and `maxRepairRounds` (1–3; default 1).
- On `VERDICT: FAIL`, the findings go to a **repair worker** on the new
  `repair` lane, scoped to the worker-edited files. The verifier then
  re-runs; its deterministic typecheck and tests are the targeted
  validation. The loop is bounded by `maxRepairRounds`.
- The `repair` lane has a `taskRouter.repair` model and `effort.repair`. When
  unset, it runs as the configured coder (`ember`), with model **and** effort
  inherited together.
- The Forge keeps coordination: it receives the verdict and any repair and
  recheck sections. If the result is still FAIL, the tool output tells it to
  dispatch a code agent rather than edit directly, unless the user asked it
  to implement the fix itself.
- Multi-agent dispatch releases the workspace lock before review. Repair
  re-acquires it for its own edits (reference-counted `agentStarted` /
  `agentFinished`).
- No repair on PASS, PARTIAL or UNKNOWN verdicts, in read-only mode, or after
  an abort. A failed repair worker stops the loop and is reported.
- `/router` has a new Repair row.

### Validation

- `tests/review-repair.test.ts` (14): scope cases, repair task scoping,
  the loop with lock hooks, bounded rounds, the no-repair cases,
  repair-failure handling, and repair-lane inheritance.
- Full suite 3156 pass / 14 fail (baseline only). typecheck and lint pass.

**LOCAL ACCEPTANCE REQUIRED:** a live review FAIL → repair → recheck with
real models.

## CP5 — harness activity, provider-wait/stall visibility, retry attribution

**Classification:** SHARED CORE (`src/core/activity/*`, headless events)
plus SOULFORGE/TUI ONLY (rendering).

### What existed

- The stall watchdog (`useChat`) tracked last-chunk time, tools in flight,
  first content and pending prompts, but only used them to decide when to
  abort and retry.
- The Forge status line showed **rotating flavour text** ("Exploring…"),
  not real state.
- Worker cards showed the running tool, or a generic "thinking...".
- Worker transient retries were silent until the final failure.
- `model-events` recorded an error message but no category.

### Added

- `core/activity/activity.ts`: `ActivityTracker` keeps per-actor state for
  the Forge and each worker. Phases: queued, requesting, streaming,
  reasoning, tool, waiting-worker, blocked-user, retrying, done, failed,
  cancelled.
  - `toolActivityLabel()` produces human labels ("Reading src/a.ts",
    "Running tests", "Editing …") from event data, with **zero model
    tokens**.
  - `describeActivity()` gives the one-line status, including "Waiting on
    provider — no activity for 8m 14s", "Waiting on 2 workers — 1m 5s",
    "Waiting for your approval — 3s", "Retrying (#2) — provider stalled
    (watchdog)" and "Failed — context limit: …".
  - A finished tool moves the actor to `requesting`, so an old tool label is
    never shown while the harness is actually waiting.
  - There is a bounded feed of meaningful transitions (reads and chunks are
    excluded to avoid noise).
- `core/activity/failure.ts`: `classifyFailure()` attributes errors to
  cancelled, stall-watchdog, strict-routing, context-limit,
  provider-rate-limit, provider-overloaded, provider-auth, provider-http,
  provider-stream-closed, network, timeout, tool-failure,
  dependency-failed, harness or unknown. It follows the cause chain and
  never changes retry decisions.
- `core/activity/worker-bridge.ts` translates the existing dispatch and step
  events into worker activity, so routine activity needed no agent-code
  changes. It also marks dispatched workers as queued until they start.
- Forge reporting in `useChat` (TUI) and `headless/run.ts`: turn start,
  per-attempt requests, throttled chunks, tool start/end, the worker count
  during `dispatch`, blocked/unblocked from the pending question or plan
  review, attributed transient and stall retries, and the final outcome.
- Worker transient retries are now visible (`agent-runner`), and
  `model-events` error records carry `errorCategory`.

### Surfaces

- TUI: a Forge `ActivityLine` under the stream in **both** the raw (verbose)
  and folded display modes, independent of the verbose and reasoning
  switches. Worker cards replace "thinking..." with the worker's live
  status and show `[model · effort]`.
- Headless `--events`: a new `activity` JSONL event on every phase or label
  change, plus a `heartbeat: true` event every 10s for actors silent for
  15s or more. Hearth's text renderer ignores it, so chat surfaces aren't
  spammed.
- The existing stall watchdog, timeouts and recovery are **unchanged**.
  Nothing is killed to satisfy the UI.

### Validation

- `tests/activity.test.ts` (27) and `tests/activity-line.test.tsx` (2):
  phases, the stale-label guarantee, provider vs worker waits, blocked,
  retry attribution, terminal states, the feed bound, labels, failure
  classification, the worker bridge, and TUI rendering of a waiting
  state.
- Full suite 3185 pass / 14 fail (baseline only). typecheck and lint pass.

**Not covered:** remote-surface (Telegram) approvals pause the watchdog but
are not reported as `blocked-user`. The Forge `tool-input-start` label is
tool-name-only in the TUI, because argument-level labels would need the
streamed arguments; headless has full arguments.
**LOCAL ACCEPTANCE REQUIRED:** a real long provider silence, and live
multi-worker runs.

## CP6 — optional model-authored narration

**Classification:** SHARED CORE (prompt, context manager, headless flag)
plus SOULFORGE/TUI ONLY (`/narration` picker).

- `narration: "quiet" | "normal" | "verbose"` is set in config (project or
  global scope) with the `/narration` picker or `/narration <mode>`. In
  headless it's set with `--narration <mode>`. The default is `quiet`.
- **Quiet** is the existing silent tool loop. The system prompt is
  **byte-identical** to the baseline, so there is no cache churn and no
  extra tokens.
- **Normal** gives brief updates at phase changes, findings and surprises
  (typically 1–4 per turn). **Verbose** gives one line before each
  significant action and after notable results.
- Normal and Verbose append one section at the **end** of the Forge system
  prompt. It explicitly overrides the shared "zero text between tool calls"
  rule and the OpenAI "suppress preambles" instruction. It also forbids
  reproducing or paraphrasing hidden reasoning: narration is progress
  reporting, not chain-of-thought.
- The long-session persona nudge ("the curse holds…") is replaced by a
  narration-aware voice check when narration is on, so the two never
  contradict each other.
- The mode is part of the instructions cache key. Switching modes rebuilds
  the prompt once.
- Narration text is rendered where the TUI already shows interstitial text
  (folded into the tool rail, or inline in raw mode). It is independent of
  harness activity (always on, token-free), of `/reasoning` and of
  `/verbose`, which only affect rendering.
- Workers are unaffected: narration applies to the Forge only.
- Context: narration stays in history like any assistant text. No context
  manipulation was added, per the handoff; this is why quiet stays the
  default.

### Validation

- `tests/narration.test.ts` (9): quiet is byte-identical; section placement
  and override text; no-CoT wording; cadence differences; nudge
  replacement; normalisation; the ContextManager prompt and cache key; the
  headless flag.
- Full suite 3194 pass / 14 fail (baseline only). typecheck and lint pass.

**LOCAL ACCEPTANCE REQUIRED:** how well live models follow each mode's
cadence.

## CP7 — provenance, evidence, preflight, dirty builds, worker results, diagnostics

**Classification:** SHARED CORE (`core/provenance/*`, `core/diagnostics/*`,
project tool, verifier, headless) plus SOULFORGE/TUI ONLY (`/preflight`,
`/diagnostics`).

### Source identity + evidence (`core/provenance/source.ts`, `evidence.ts`)

- `candidateId` works as follows:
  - clean tree → the HEAD commit;
  - dirty tree → `HEAD+sha256(diff vs HEAD, untracked names and contents)`.
  It is read-only (never writes to the repository or object store).
  Harness state under `.soulforge/` is excluded, so writing evidence never
  changes the id.
- The evidence ledger is `.soulforge/evidence.jsonl` (bounded to 500
  records). The status of a kind for a candidate is `pass | fail | stale |
  missing`: evidence is reusable while the candidate is unchanged and
  stale as soon as it changes.
- Automatic recording:
  - `project` test / typecheck / lint / build, and each step of `check`,
    record evidence against the candidate captured **before** the run
    starts. (A test found and fixed a race where an edit made during the
    run leaked into the "before" identity.)
  - `lint --fix` is not recorded, because it mutates what it would vouch
    for.
  - The verifier records `review` evidence for PASS or FAIL.
- The verifier prompt now includes a compact **candidate manifest**: the
  exact source state, the files changed in the dispatch, and per-kind
  evidence status for this candidate.

### Release preflight + dirty-build labelling

- `core/provenance/preflight.ts` checks:
  - source identity;
  - a clean tree (default on);
  - optionally, a tagged HEAD and an expected commit;
  - that required evidence (default typecheck and test) **passed on this
    exact candidate**.
  A dirty or unidentified state is always labelled `DEVELOPMENT BUILD — not
  a release`. The policy lives in project config under `release`.
- Entry points are `/preflight` (TUI) and `soulforge --preflight [--cwd
  dir]` (exits 0 or 1). The result is recorded as `preflight` evidence.
- `scripts/build.ts` stamps `{commit, dirty, tag, builtAt}` into both build
  paths and warns when building from a dirty tree. `--version` prints
  `2.20.25 (abc1234)`, `2.20.25+dev.abc1234.dirty — DEVELOPMENT BUILD, not
  a release`, or `(running from source)`.

### Standardized worker results

Code workers (except de-sloppify) are asked to end with a `RESULT` block
(reproduced / changed / tests / validation / uncertainty / invariants).
`parseWorkerResult()` is tolerant, and `agent-done` events carry
`workerResult`. This extends the existing free-text contract rather than
replacing it.

### Operational recipes (existing extension point)

`private-rebuild/recipes/staged-candidate-acceptance/SKILL.md` is a skill
you drop into `.soulforge/skills/`. It covers: identify the candidate
first, per-candidate evidence, dirty = development, stop at manual gates
while preserving the candidate, and no scope escalation ("enable staged"
never becomes "install to production"). No core machinery was needed.

### Run diagnostics (`core/diagnostics/*`)

- `buildRunDiagnostics()` is pure. It covers:
  - the run window and source identity;
  - per-actor dispatches (lane, model, effort, queued and run time, final
    phase, retries, failure);
  - usage totals, split into fresh input vs cache-read, and grouped by
    model, lane and phase;
  - errors by category, and retries;
  - timeline: peak and average concurrency, overlap, idle gaps, and
    **queued-while-capacity-available** time;
  - user gates, the activity feed, evidence, and the final state.
  The first version was written by a bounded Sonnet worker. I reviewed and
  integrated it: its mirrored types were replaced with the real imports,
  and a still-queued worker case was fixed and tested.
- `exportRunDiagnostics()` writes `.soulforge/diagnostics/run-<ts>.{md,json}`.
  Entry points are `/diagnostics` (TUI) and `--headless --diagnostics`,
  which enables per-call model events for that run. Headless now also
  records Forge step calls as model events (only when events are enabled).

### Validation

- `tests/provenance.test.ts` (15) uses real temporary git repositories.
  `tests/run-diagnostics.test.ts` has 20 tests and
  `tests/diagnostics-export.test.ts` has 2.
- A regression found and fixed: the headless parser now omits `diagnostics`
  unless set, so the exact option shape stays unchanged.
- Full suite 3231 pass / 14 fail (baseline only). typecheck and lint pass.
