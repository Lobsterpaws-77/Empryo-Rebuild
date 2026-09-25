# Checkpoint log

Baseline (CP0 source state): `6329f0dd26934998d188b88fa52a3e2ac69b0fc6`.
Each entry lists what changed, how it was validated, and the remaining risk.
The 14 `structural_edit` failures exist at baseline and are excluded as pre-existing
(see `CP0_BASELINE_AUDIT.md`).

## CP0 — baseline + source audit — `eac76d1`

The audit is in `CP0_BASELINE_AUDIT.md`.

## CP1 — routing correctness: lane model + effort resolved together

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
