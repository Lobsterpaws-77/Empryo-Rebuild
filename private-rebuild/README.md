# Empryo private rebuild — final report

Private, non-commercial modification of the SoulForge/Empryo open core
(BUSL-1.1 Additional Use Grant: personal use). Licence files are unchanged.
Provider authentication is untouched: `git diff 6329f0d..HEAD --
src/core/llm/providers src/core/secrets.ts src/core/commands/codex.ts
src/core/commands/proxy.ts src/core/proxy src/core/llm/provider-options.ts
src/core/llm/provider.ts` is empty.

| | |
|---|---|
| **Baseline (CP0 source)** | `6329f0dd26934998d188b88fa52a3e2ac69b0fc6` (= `origin/main`, `@proxysoul/soulforge` 2.20.25) |
| **Final source state** | `4501490` (CP7). CP8 adds documentation only (see `git log`) |
| **Branch** | `claude/gracious-hypatia-pgj1kg` |
| Details per checkpoint | `CHECKPOINTS.md` |
| Source audit | `CP0_BASELINE_AUDIT.md` |
| Mac acceptance steps | `LOCAL_ACCEPTANCE.md` |

## Checkpoint map

| CP | Commits | Purpose |
|---|---|---|
| CP0 | `eac76d1` | Baseline and source-coverage audit |
| CP1 | `d32c15d` + `09e541c` | Lane model **and** effort resolved together; three core routing defects fixed. `d32c15d` ("test") is a stray worker commit holding CP1's deletion of `task-router.ts`, deliberately kept in history |
| CP2 | `2ab3b33` + `ccbe8c8` | POSIX shell spawned by absolute path; attributed ENOENT |
| CP3 | `af2f137` + `482edfb` | Per-lane effort UX (`/router`), opt-in strict routing, `forge` lane, web-search effort |
| CP4 | `a721d79` | Review scope documented; opt-in review → repair worker → recheck |
| CP5 | `2522d1f` | Harness-generated activity, provider-wait/stall states, retry/failure attribution |
| CP6 | `18b1981` | Optional quiet / normal / verbose Forge narration |
| CP7 | `4501490` | Source identity, evidence, preflight, dirty-build labels, worker RESULT metadata, run diagnostics |
| CP8 | docs commit after `4501490` | Whole-project validation, this report, local acceptance guide |

## Classification

### IMPLEMENTED IN SHARED CORE
- **Lane routing** (`core/llm/lane-routing.ts`):
  - per-lane model and effort from one effective snapshot;
  - precedence: override → lane → documented fallback → provider default;
  - source attribution for every value;
  - `registerRoutingLane()` for extension lanes.
- **Routing defect fixes:**
  - worker provider options were built from the provider-local model id, so
    **all worker effort was silently dropped**;
  - the verifier's model came from its own lane but its effort came from
    the explore role;
  - de-sloppify's effort came from the global value;
  - worker effort was read from the global config file instead of the
    effective project + global config.
- **Strict routing** (`core/llm/strict-routing.ts`): enforced at worker
  launch, at Forge turn start, on the Forge fallback chain, for compaction
  and for web search.
- **Shell spawn** by absolute path, with `SOULFORGE_SHELL` override and
  attributed errors (`core/platform`).
- **Review → repair loop** (`core/agents/agent-verification.ts`) and the
  `repair` lane.
- **Activity tracker, failure classifier, worker bridge** (`core/activity/*`);
  headless `activity` events.
- **Narration modes** (`core/prompts/narration.ts`), headless `--narration`.
- **Provenance:** source identity, evidence ledger, candidate manifest,
  preflight, headless `--preflight`, build provenance stamp and
  `--version` label.
- **Worker RESULT metadata; run diagnostics** (`core/diagnostics/*`),
  headless `--diagnostics`.

### SOULFORGE/TUI ONLY
- `/router`: effort column, explicit vs `↳` inherited display, `e` to
  cycle effort, strict markers, and source explanation line. New Repair
  row.
- Activity line under the stream (both display modes), worker-card live
  status, and `[model · effort]` tags.
- `/narration`, `/preflight`, `/diagnostics`, and the `/agent-features`
  toggle "Repair on Review Fail".

### LOCAL ACCEPTANCE REQUIRED
See `LOCAL_ACCEPTANCE.md`:
- live model and effort delivery per lane;
- strict failure and fallback with real providers;
- macOS GUI-launch shell;
- long provider silence and live multi-worker activity;
- live review → repair;
- narration adherence;
- preflight on your projects;
- MCP regression spot check;
- cost and latency impact of workers now actually sending effort.

### BLOCKED BY MISSING EMPRYO DESKTOP SOURCE
- Graph Node / Graph Judge effort routing. **Keep the temporary local
  hook.** The desktop build can adopt `registerRoutingLane()` +
  `resolveLaneRoute()` to fix it natively.
- The desktop graph-shell node executor.
- Council, Marionette, Goal Review, Advisor, Routine and Orchestrate lanes.
- The desktop Review panel / Apply button, and desktop-specific activity
  cards.

## Changelog (user-visible)

1. Each worker lane (Explore, Code, Review, Cleanup, Repair, Web Search,
   Compaction) has its own model **and** reasoning effort. `/router` shows
   what is explicit and what is inherited.
2. Worker effort is now actually sent to providers. Previously it was
   dropped. **Expect changes in cost and latency.**
3. The verifier runs at its own lane effort (or the global effort), not an
   accidental `low`.
4. Opt-in strict routing: a disallowed model or effort fails visibly and
   never substitutes silently.
5. Shell and project commands work when the app is launched with a minimal
   PATH.
6. Opt-in automatic repair of review failures by a worker, followed by a
   recheck.
7. A live, token-free activity line for the Forge and each worker,
   including explicit "Waiting on provider — no activity for Xm Ys".
   Retry reasons are attributed.
8. Optional progress narration modes. The default (quiet) is unchanged.
9. `/preflight`, the evidence ledger, and dirty builds labelled as
   development builds.
10. `/diagnostics` exports a Markdown + JSON run report.

## Validation evidence (cloud, final state)

| Check | Result |
|---|---|
| `bun run typecheck` | pass |
| `bun run lint` (Biome, 478 files) | pass |
| `bun test` | **3231 pass / 1 skip / 14 fail**. The 14 are the baseline `structural_edit` failures (external `ast-grep` behaviour), identical at CP0 |
| New test files | lane-routing (29), strict-routing (19), router-settings-effort (2), shell-resolution (13), review-repair (14), activity (27), activity-line (2), narration (9), provenance (15), run-diagnostics (20), diagnostics-export (2) |
| `bun run build` | pass (3 artifacts). See the note below |
| `bun dist/index.js --version` | `soulforge 2.20.25 (4501490)` |
| `bun dist/index.js --preflight` | runs; clean tree detected; evidence missing, as expected in the cloud |

**Build note (pre-existing, environment-specific):** `scripts/build.ts`'s
path scrubber replaces every occurrence of `$HOME` in source with `~`. In
the cloud container `HOME=/root`, which corrupts the import
`'./root.js'` in `hast-util-to-html`. The build was validated with a
neutral `HOME`. On macOS (`/Users/<you>`) this is not expected to trigger.
It was left unfixed because it is outside the scope of this rebuild.

**Candidate artifact:** builds are gitignored and the container is
temporary, so no binary is kept. Build locally with `bun run build`
(`dist/`) or `bun run build:binary` (`bin/soulforge`); see
`LOCAL_ACCEPTANCE.md` §1. The stamped `--version` identifies the exact
commit.

## Known limitations
- OpenAI-compatible providers bake reasoning into the model when it's
  built, from the **global** config. So a lane effort can't differ from the
  global effort there. The Codex CLI provider exposes no effort. Strict
  effort policies reject these providers as "not enforceable". Fixing this
  would require provider changes, which were left frozen.
- Workers now send Anthropic thinking and effort options, as the original
  code intended. Verify cost and latency.
- Review scope is limited to the dispatch's worker edits. Forge-authored
  edits aren't reviewed; there is no core Review feature for them.
- Remote (Telegram) approvals pause the watchdog but aren't reported as
  `blocked-user`. TUI Forge tool labels are name-level; headless has full
  arguments.
- Narration stays in context like any assistant text. No context pruning
  was added.
- Per-call usage in diagnostics requires `/model-events`, which is off by
  default for performance. Headless `--diagnostics` turns it on for the run.
- Evidence covers the `project` tool and the verifier. Raw `shell` test runs
  are not recorded.

## Build / install
See `LOCAL_ACCEPTANCE.md` §0–§2. In short: `bun install && bun run build &&
bun dist/index.js`, or `bun run dev` from source.

## Upstream-porting notes
The work is almost entirely **additive new modules**, which port cleanly:
- `core/llm/{lane-routing,strict-routing,subagent-routing}.ts`
- `core/activity/*`, `core/provenance/*`, `core/diagnostics/*`
- `core/prompts/narration.ts`
- `components/chat/ActivityLine.tsx`

Likely conflict hotspots when rebasing onto newer upstream (edited in
place):

| File | What changed |
|---|---|
| `src/hooks/useChat.ts` | lane builder call, strict checks, Forge activity reporting, compaction lane, fallback filter |
| `src/headless/run.ts` | lane builder, strict, activity events, per-step model events, `--diagnostics` |
| `src/core/agents/subagent-tools.ts` | `createAgent` routing/strict/full-id provider options, repair hooks, activity bridge |
| `src/core/agents/agent-runner.ts` | lane-based `selectModel`/`classifyTask`, route fields on events, retry activity, RESULT footer |
| `src/core/agents/agent-verification.ts` | lanes for verifier/desloppify, manifest, review evidence, repair loop |
| `src/core/tools/project.ts` | evidence wrapper; `execute` body moved to `executeProject` |
| `src/core/platform/index.ts` | `resolvePosixShell`, `describeShellSpawnError` |
| `src/components/settings/RouterSettings.tsx`, `App.tsx` | effort column/cycling, routing table |
| `src/types/index.ts` | `TaskRouter.effort/strict/repair`, `narration`, `release`, `AgentFeatures.repairOnReviewFail` |
| `scripts/build.ts` | build provenance define |

Removed: `src/core/llm/task-router.ts` (superseded by lane routing).
