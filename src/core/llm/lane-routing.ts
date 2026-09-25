/**
 * Lane routing — resolve model AND reasoning effort for a worker lane from a
 * single effective routing snapshot.
 *
 * Why this exists: before this module, a subagent's model came from its
 * router lane (e.g. `taskRouter.verify`) while its effort came from generic
 * role classification (explore → "low", everything else → global effort).
 * Model and effort were resolved in different places from different config
 * scopes, so an unrelated lane's setting could leak in. Every lane now
 * resolves both values here, together, with the source of each recorded.
 *
 * Precedence (model and effort independently, same snapshot):
 *   1. explicit per-dispatch override          (source "override")
 *   2. explicit lane setting                    (source "lane")
 *   3. the lane's documented fallback           ("legacy" | "router-default" | "parent" / "builtin" | "global")
 *   4. provider default (effort only)           ("unset")
 *
 * An unrelated lane never supplies effort: ember's effort cannot reach
 * verify, spark's cannot reach desloppify, and so on. The only shared
 * fallback is the global `performance.effort`, which is what the
 * main Forge conversation uses.
 *
 * Lanes are table-driven. Surfaces with additional lanes (e.g. the Empryo
 * desktop Graph Node / Graph Judge) call `registerRoutingLane()` and get the
 * same resolution, strict-policy checks and telemetry for free.
 *
 * Pure module: no stores, no provider registry, no UI.
 */

import type { AppConfig, EffortLevel, TaskRouter } from "../../types/index.js";
import { isCompatReasoningProvider } from "./compat-reasoning.js";

export type LaneEffort = EffortLevel | "off";

export const LANE_EFFORT_VALUES: readonly LaneEffort[] = [
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export type BuiltinLane =
  | "default"
  | "spark"
  | "ember"
  | "webSearch"
  | "desloppify"
  | "verify"
  | "compact"
  | "semantic";

/** Built-in lane id, or an extension lane registered via `registerRoutingLane`. */
export type RoutingLane = BuiltinLane | (string & {});

export type LaneModelFallback =
  /** Use the caller's model (the Forge model that dispatched the worker). */
  | "parent"
  /** Use `taskRouter.default`, then the caller's model. */
  | "router-default"
  /** No model → lane is disabled (e.g. web-search agent, de-sloppify). */
  | "none";

export type LaneEffortFallback =
  /** Inherit the global `performance.effort` block unchanged. */
  | { kind: "global" }
  /**
   * Use a fixed built-in effort, but only when a global effort is configured
   * (otherwise nothing is sent, matching historical behaviour).
   */
  | { kind: "builtin"; effort: LaneEffort };

export interface LanePolicy {
  id: string;
  label: string;
  /** `taskRouter` keys consulted for the model, in order. First is the lane's own key. */
  modelKeys: readonly string[];
  modelFallback: LaneModelFallback;
  effortFallback: LaneEffortFallback;
  /** False when the lane's LLM call carries no reasoning options (e.g. embeddings). */
  effortConfigurable: boolean;
}

const BUILTIN_POLICIES: Record<BuiltinLane, LanePolicy> = {
  default: {
    id: "default",
    label: "Default",
    modelKeys: ["default"],
    modelFallback: "parent",
    effortFallback: { kind: "global" },
    effortConfigurable: false,
  },
  spark: {
    id: "spark",
    label: "Explore",
    modelKeys: ["spark", "exploration", "trivial"],
    modelFallback: "parent",
    // Historical behaviour: read-only agents run at low effort whenever an
    // effort is configured. Now explicit, documented and overridable.
    effortFallback: { kind: "builtin", effort: "low" },
    effortConfigurable: true,
  },
  ember: {
    id: "ember",
    label: "Code",
    modelKeys: ["ember", "coding"],
    modelFallback: "parent",
    effortFallback: { kind: "global" },
    effortConfigurable: true,
  },
  webSearch: {
    id: "webSearch",
    label: "Web Search",
    modelKeys: ["webSearch"],
    modelFallback: "none",
    effortFallback: { kind: "global" },
    effortConfigurable: true,
  },
  desloppify: {
    id: "desloppify",
    label: "Cleanup",
    modelKeys: ["desloppify"],
    modelFallback: "none",
    effortFallback: { kind: "global" },
    effortConfigurable: true,
  },
  verify: {
    id: "verify",
    label: "Review",
    modelKeys: ["verify"],
    modelFallback: "parent",
    effortFallback: { kind: "global" },
    effortConfigurable: true,
  },
  compact: {
    id: "compact",
    label: "Compaction",
    modelKeys: ["compact"],
    modelFallback: "router-default",
    effortFallback: { kind: "global" },
    effortConfigurable: true,
  },
  semantic: {
    id: "semantic",
    label: "Soul Map",
    modelKeys: ["semantic"],
    modelFallback: "none",
    effortFallback: { kind: "global" },
    effortConfigurable: false,
  },
};

const extensionPolicies = new Map<string, LanePolicy>();

/**
 * Register an additional routing lane (e.g. a desktop Graph Node lane).
 * Built-in lanes cannot be replaced. Returns an unregister function.
 */
export function registerRoutingLane(policy: LanePolicy): () => void {
  if (policy.id in BUILTIN_POLICIES) {
    throw new Error(`Routing lane "${policy.id}" is built-in and cannot be re-registered`);
  }
  extensionPolicies.set(policy.id, policy);
  return () => {
    if (extensionPolicies.get(policy.id) === policy) extensionPolicies.delete(policy.id);
  };
}

export function getLanePolicy(lane: RoutingLane): LanePolicy | undefined {
  return (BUILTIN_POLICIES as Record<string, LanePolicy>)[lane] ?? extensionPolicies.get(lane);
}

export function listLanePolicies(): LanePolicy[] {
  return [...Object.values(BUILTIN_POLICIES), ...extensionPolicies.values()];
}

// ── Resolution ──────────────────────────────────────────────────────────

export type LaneModelSource =
  | "override"
  | "lane"
  | "legacy"
  | "router-default"
  | "parent"
  | "disabled";

export type LaneEffortSource = "override" | "lane" | "builtin" | "global" | "unset";

/**
 * How a resolved effort reaches the provider for this model:
 *  - request:       per-request providerOptions — lane effort is honoured
 *  - construction:  body-injected when the model object is built from the
 *                   global config (OpenAI-compatible providers) — lane effort
 *                   cannot differ from global
 *  - unsupported:   provider exposes no effort control (Codex CLI)
 */
export type EffortDelivery = "request" | "construction" | "unsupported";

export interface LaneRouteOverride {
  model?: string;
  effort?: LaneEffort;
}

export interface LaneRoute {
  lane: string;
  /** Resolved full model id ("provider/model"), or null when the lane is disabled. */
  modelId: string | null;
  modelSource: LaneModelSource;
  /** Config path the model came from, e.g. "taskRouter.coding". */
  modelKey?: string;
  /** Resolved effort. undefined = nothing configured → provider default. */
  effort: LaneEffort | undefined;
  effortSource: LaneEffortSource;
  effortKey?: string;
}

/** The subset of config lane routing reads. Pass the EFFECTIVE (merged) config. */
export type RoutingConfig = Pick<AppConfig, "taskRouter" | "performance">;

export interface ResolveLaneContext {
  /** The model of the caller (Forge) — used by lanes whose fallback is "parent". */
  parentModelId: string;
  override?: LaneRouteOverride;
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

export function isLaneEffort(v: unknown): v is LaneEffort {
  return typeof v === "string" && (LANE_EFFORT_VALUES as readonly string[]).includes(v);
}

/** Explicit lane effort from `taskRouter.effort[lane]`, if set and valid. */
export function getLaneEffortSetting(
  router: TaskRouter | undefined,
  lane: RoutingLane,
): LaneEffort | undefined {
  const v = router?.effort?.[lane];
  return isLaneEffort(v) ? v : undefined;
}

export function resolveLaneRoute(
  lane: RoutingLane,
  config: RoutingConfig,
  ctx: ResolveLaneContext,
): LaneRoute {
  const policy = getLanePolicy(lane);
  if (!policy) throw new Error(`Unknown routing lane "${lane}"`);
  const router = config.taskRouter;
  const routerRec = (router ?? {}) as Record<string, unknown>;

  // ── Model ──
  let modelId: string | null = null;
  let modelSource: LaneModelSource = "disabled";
  let modelKey: string | undefined;
  const overrideModel = nonEmpty(ctx.override?.model);
  if (overrideModel) {
    modelId = overrideModel;
    modelSource = "override";
  } else {
    for (let i = 0; i < policy.modelKeys.length; i++) {
      const key = policy.modelKeys[i] as string;
      const v = nonEmpty(routerRec[key]);
      if (v) {
        modelId = v;
        modelSource = i === 0 ? "lane" : "legacy";
        modelKey = `taskRouter.${key}`;
        break;
      }
    }
    if (!modelId) {
      if (policy.modelFallback === "router-default" && nonEmpty(router?.default)) {
        modelId = router?.default as string;
        modelSource = "router-default";
        modelKey = "taskRouter.default";
      } else if (policy.modelFallback === "parent" || policy.modelFallback === "router-default") {
        modelId = nonEmpty(ctx.parentModelId) ?? null;
        modelSource = modelId ? "parent" : "disabled";
      }
    }
  }

  // ── Effort ──
  const globalEffort = config.performance?.effort;
  let effort: LaneEffort | undefined;
  let effortSource: LaneEffortSource;
  let effortKey: string | undefined;
  const laneEffort = policy.effortConfigurable ? getLaneEffortSetting(router, lane) : undefined;
  if (ctx.override?.effort && policy.effortConfigurable) {
    effort = ctx.override.effort;
    effortSource = "override";
  } else if (laneEffort) {
    effort = laneEffort;
    effortSource = "lane";
    effortKey = `taskRouter.effort.${lane}`;
  } else if (
    policy.effortFallback.kind === "builtin" &&
    globalEffort !== undefined &&
    globalEffort !== "off"
  ) {
    effort = policy.effortFallback.effort;
    effortSource = "builtin";
  } else if (globalEffort !== undefined) {
    effort = globalEffort;
    effortSource = "global";
    effortKey = "performance.effort";
  } else {
    effort = undefined;
    effortSource = "unset";
  }

  return { lane: policy.id, modelId, modelSource, modelKey, effort, effortSource, effortKey };
}

/** Resolve every registered lane — the snapshot surfaces render in `/router` and logs. */
export function resolveRoutingTable(config: RoutingConfig, parentModelId: string): LaneRoute[] {
  return listLanePolicies().map((p) => resolveLaneRoute(p.id, config, { parentModelId }));
}

// ── Applying a route to provider options ─────────────────────────────────

const OPENAI_EFFORT: Record<EffortLevel, "low" | "medium" | "high" | "xhigh"> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
};

/**
 * Return a config whose `performance` block expresses the route's effort, for
 * feeding to `buildProviderOptions`. Does not touch provider/auth code — it
 * only shapes the reasoning knobs that function already reads.
 *
 *  - "global"/"unset": config returned unchanged (exact historical behaviour).
 *  - "builtin": only the unified `effort` knob is replaced (exact historical
 *    behaviour of the explore → low override).
 *  - "lane"/"override": authoritative — the unified knob is set, OpenAI's
 *    reasoning effort is mapped, and provider-specific reasoning overrides are
 *    cleared so the lane value is what every family derives from.
 */
export function applyLaneEffort<C extends RoutingConfig>(config: C, route: LaneRoute): C {
  if (route.effortSource === "global" || route.effortSource === "unset") return config;
  const effort = route.effort;
  if (effort === undefined) return config;
  const perf = { ...(config.performance ?? {}) };
  perf.effort = effort;
  if (route.effortSource === "builtin") {
    return { ...config, performance: perf };
  }
  perf.openaiReasoningEffort = effort === "off" ? "off" : OPENAI_EFFORT[effort];
  perf.xaiReasoningEffort = undefined;
  perf.googleThinkingLevel = undefined;
  perf.googleThinkingBudget = effort === "off" ? "off" : undefined;
  perf.deepseekThinking = undefined;
  perf.deepseekReasoningEffort = undefined;
  perf.openrouterReasoningEffort = undefined;
  perf.openrouterReasoningMaxTokens = undefined;
  perf.groqReasoningEffort = undefined;
  perf.compatReasoningEffort = undefined;
  perf.llmgatewayReasoningEffort = undefined;
  return { ...config, performance: perf };
}

/** How a lane effort reaches the provider for `modelId` (see EffortDelivery). */
export function laneEffortDelivery(modelId: string): EffortDelivery {
  const slash = modelId.indexOf("/");
  const provider = slash > 0 ? modelId.slice(0, slash) : "";
  const model = slash > 0 ? modelId.slice(slash + 1) : modelId;
  if (provider === "codex") return "unsupported";
  // Claude over the proxy is built with native Anthropic options (per request).
  if (provider === "proxy" && model.toLowerCase().startsWith("claude")) return "request";
  if (isCompatReasoningProvider(modelId)) return "construction";
  return "request";
}

// ── Presentation ─────────────────────────────────────────────────────────

const MODEL_SOURCE_LABEL: Record<LaneModelSource, string> = {
  override: "dispatch override",
  lane: "lane",
  legacy: "legacy key",
  "router-default": "router default",
  parent: "inherits Forge model",
  disabled: "disabled",
};

const EFFORT_SOURCE_LABEL: Record<LaneEffortSource, string> = {
  override: "dispatch override",
  lane: "lane",
  builtin: "built-in lane default",
  global: "inherits global effort",
  unset: "provider default",
};

export function describeModelSource(route: LaneRoute): string {
  const base = MODEL_SOURCE_LABEL[route.modelSource];
  return route.modelKey && route.modelSource === "legacy" ? `${base} ${route.modelKey}` : base;
}

export function describeEffortSource(route: LaneRoute): string {
  return EFFORT_SOURCE_LABEL[route.effortSource];
}

/** One-line human summary, e.g. `verify → openai/gpt-5 (lane) · effort high (lane)`. */
export function formatLaneRoute(route: LaneRoute): string {
  const model = route.modelId ?? "—";
  const effort = route.effort ?? "default";
  return `${route.lane} → ${model} (${describeModelSource(route)}) · effort ${effort} (${describeEffortSource(route)})`;
}
