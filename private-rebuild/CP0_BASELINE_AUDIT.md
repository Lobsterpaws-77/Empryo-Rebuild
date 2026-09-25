# CP0 — Baseline and Source-Coverage Audit

Private, non-commercial rebuild (see handoff dated 2026-09-25). This file is the
immutable CP0 record. Later checkpoints are listed in `CHECKPOINTS.md`.

## Baseline

| Item | Value |
|---|---|
| Repository | `Lobsterpaws-77/Empryo-Rebuild` (origin `https://github.com/Lobsterpaws-77/Empryo-Rebuild`) |
| Working branch | `claude/gracious-hypatia-pgj1kg` |
| Baseline HEAD (CP0) | `6329f0dd26934998d188b88fa52a3e2ac69b0fc6` ("docs: update readme", 2026-09-24) — identical to `origin/main` |
| Working tree | clean |
| Package | `@proxysoul/soulforge` **2.20.25** (`package.json`), license `BUSL-1.1` |
| Upstream metadata | `package.json#repository` → `https://github.com/proxysoul/soulforge.git`; no `upstream` remote configured |

### Baseline validation (cloud, Bun 1.3.11 — repo asks for >= 1.3.13)

| Check | Result |
|---|---|
| `bun run typecheck` | pass |
| `bun run lint` | pass (466 files) |
| `bun test` | 3080 pass / 1 skip / **14 fail** |

All 14 baseline failures are in `tests/structural_edit*` (C++, Go, Python, Rust,
C, C#, Java, Kotlin, Lua, PHP, Ruby, Scala matrix + preview/python rename) and
depend on the external `ast-grep` binary behaviour in this container. They are
**pre-existing and unrelated** to this rebuild and are tracked separately from
regressions in every later checkpoint.

## Key finding: supplied source is the open core, not the desktop app

`README.md` ("Open core"): *"This repository is the core and engine Empryo runs
on, open source as SoulForge … The desktop app, the new surfaces and the newest
features are Empryo's."*

The installed Empryo **3.8.7 desktop** orchestration executor (graphs, Graph
Node / Graph Judge, Council, Marionette, Goal Review, desktop Review/Apply) is
**not present** in this repository. No symbol, type, config key or string for
those concepts exists under `src/`.

Direction agreed with Nick after this finding: build the shared routing
foundation here so desktop lanes can plug in later; do not invent desktop types.

## Routing architecture as found

| Concern | Location | Behaviour at CP0 |
|---|---|---|
| Lane models | `TaskRouter` (`src/types/index.ts`) | flat per-lane **model** slots: `spark`, `ember`, `webSearch`, `desloppify`, `verify`, `compact`, `semantic`, `default` (+ legacy `coding`/`exploration`/`trivial`, + `maxConcurrentAgents`) |
| Lane effort | none | one global `performance.effort` (+ provider-specific knobs) |
| Model resolution | duplicated in `src/hooks/useChat.ts` (TUI) and `src/headless/run.ts` | `spark ?? exploration ?? trivial`, `ember ?? coding`, … ; `resolveTaskModel()` for compaction |
| Per-agent model pick | `selectModel`/`classifyTask` (`src/core/agents/agent-runner.ts`) | cache tier (spark/ember) + role |
| Per-agent effort | `createAgent` (`src/core/agents/subagent-tools.ts`) | `loadConfig()` (**global file only**) → explore role forced `low`, everything else global effort |
| Verifier ("Review" lane) | `runVerifier` (`agent-verification.ts`) | model via `verify` slot (stuffed into `sparkModel`), runs as `role: "explore"` → **effort forced `low`** |
| De-sloppify ("Cleanup" lane) | `runDesloppify` | model via `desloppify` slot, runs as code → **global effort** |
| Scope | `mergeConfigs` (`src/config/index.ts`) | `taskRouter` replaced wholesale by project scope; `performance` shallow-merged |
| UI | `RouterSettings.tsx` + `App.tsx` | model per slot, scope toggle (project/global) |
| Provider effort delivery | `buildProviderOptions` (`src/core/llm/provider-options.ts`) | per request for Anthropic/OpenAI/Google/xAI/DeepSeek/OpenRouter/Bedrock; **baked at model construction from global config** for OpenAI-compatible body-injection providers (`compat-reasoning.ts`); Codex CLI provider exposes no effort |

### Defects in the shared core that match the handoff's bug class

1. **Model and effort come from different routing contexts.** The verifier's
   model comes from the `verify` lane, but its effort comes from generic
   explore-role classification (`low`). De-sloppify's model comes from its lane,
   but its effort is the generic global value (for example `max`). This is the
   same pattern as the desktop Graph Judge / Graph Node symptom.
2. **Scope mismatch.** Subagent effort is read with `loadConfig()` (global file),
   not the effective global+project config the UI reports and the Forge uses.
3. **No per-lane effort at all**, so no lane can be controlled independently.
4. **No visibility** of resolved effort or routing source in `model-events`.

## Source-coverage classification

Legend: **SHARED CORE** = engine code usable by any surface; **TUI ONLY** =
OpenTUI rendering; **ABSENT** = not in supplied source.

| Handoff item | Classification | Where |
|---|---|---|
| §8 Graph Node / Graph Judge effort | **ABSENT** (bug class present in core as verifier/desloppify) | `src/core/agents/*` |
| §9 graph shell `posix_spawn 'sh' ENOENT` | graph node **ABSENT**; bare-`sh` spawn defect **SHARED CORE** | `src/core/platform/index.ts` (`shellInvocation`, `spawnShell`, `bunShellArgs`) |
| §10 per-lane model + effort | **SHARED CORE** (`TaskRouter`, dispatch) + TUI (`RouterSettings`) | |
| §10 Explorer/Coder/Build/Test/Reviewer/Repair lanes | Explorer=`spark`, Coder=`ember`, Reviewer=`verify`, cleanup=`desloppify`, web=`webSearch`, compaction=`compact`, summaries=`semantic` present; Judge/Council/Orchestrate/Routine/Marionette/Goal Review/Advisor **ABSENT** | |
| §11 strict routing | **SHARED CORE** (new) | |
| §12 Review/Apply/repair | desktop Review/Apply **ABSENT**; core verifier reviews worker (bus) edits only | `agent-verification.ts` |
| §13/14 activity, provider wait, stall | **SHARED CORE** events (`subagent-events.ts`, stall watchdog in `useChat.ts`) + TUI rendering | |
| §15 display switches | **TUI ONLY** | |
| §16 narration modes | **SHARED CORE** (prompt/config) | `src/core/prompts`, `forge.ts` |
| §17 provenance | **SHARED CORE** (git) — no existing source-identity mechanism | `src/core/git/status.ts` |
| §18 recipes | existing extension points: hooks, skills, presets, morphs | `src/core/hooks`, `skills`, `presets`, `morphs/` |
| §19 release/dirty build | build scripts (`scripts/build.ts`) | |
| §20 error/retry attribution | **SHARED CORE** — `stores/errors.ts`, `model-events.ts`, `agent-runner.ts` retry | |
| §21 diagnostics export | **SHARED CORE** — derive from `model-events` + agent events | |
| §22 worker result metadata | **SHARED CORE** — `DoneToolResult` in `agent-results.ts` | |
| Provider auth (§4) | **FROZEN**, not touched | `src/core/llm/providers/*`, `secrets.ts`, `commands/codex.ts`, proxy |

## Validation plan (adjusted)

- Unit tests for the pure lane resolver: the acceptance matrix mapped onto real lanes (verify is the Judge analogue, desloppify is the Node/Ember isolation analogue) plus a registered test lane that stands in for future desktop Graph Node / Graph Judge.
- Integration tests through `createAgent` using mock `LanguageModel`s: check the resolved model id and the provider-options effort.
- Shell resolution tests with a stripped `PATH`.
- Typecheck, lint and the full test suite at every checkpoint. The 14 baseline failures above are excluded as pre-existing.
