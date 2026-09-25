/**
 * Build the per-turn set of worker-lane models from ONE effective config
 * snapshot. Shared by the TUI (useChat) and headless runner so both surfaces
 * resolve lanes identically (they previously each hand-rolled the
 * `spark ?? exploration ?? trivial` chains).
 */

import type { JSONObject } from "@ai-sdk/provider";
import { type LanguageModel, wrapLanguageModel } from "ai";
import type { AppConfig } from "../../types/index.js";
import {
  applyLaneEffort,
  type LaneRoute,
  resolveLaneRoute,
  resolveRoutingTable,
} from "./lane-routing.js";
import { buildProviderOptions } from "./provider-options.js";
import {
  enforceStrictRoute,
  getStrictLanePolicy,
  type StrictViolation,
  validateStrictRoutes,
} from "./strict-routing.js";

export interface SubagentLaneModels {
  spark?: LanguageModel;
  ember?: LanguageModel;
  desloppify?: LanguageModel;
  verify?: LanguageModel;
}

export interface SubagentRouting {
  /** Undefined when no worker lane has its own model (all inherit the Forge model). */
  subagentModels: SubagentLaneModels | undefined;
  webSearchModel: LanguageModel | undefined;
  webSearchModelId: string | undefined;
  webSearchRoute: LaneRoute;
  /** Resolved route for every registered lane — for logs and the /router view. */
  routes: LaneRoute[];
  /** Strict-policy check of every constrained lane (empty when strict is off). */
  strict: { violations: StrictViolation[]; notes: string[] };
}

const WORKER_LANES = ["spark", "ember", "desloppify", "verify"] as const;

/**
 * @param config        EFFECTIVE (global + project) config for this turn
 * @param parentModelId full id of the Forge model
 * @param resolve       builds a LanguageModel from "provider/model"
 * @param onResolveError when given, a lane whose model fails to build is
 *                       reported and left unset (Forge model is used);
 *                       when omitted — or when strict routing constrains the
 *                       lane — the error propagates (no silent substitute).
 */
export function buildSubagentRouting(
  config: AppConfig,
  parentModelId: string,
  resolve: (modelId: string) => LanguageModel,
  onResolveError?: (lane: string, modelId: string, err: unknown) => void,
): SubagentRouting {
  const build = (lane: string): { model?: LanguageModel; id?: string; route: LaneRoute } => {
    const route = resolveLaneRoute(lane, config, { parentModelId });
    // Only lanes with their OWN configured model get a distinct model object;
    // "parent" lanes use the Forge model the dispatcher already holds.
    if (!route.modelId || (route.modelSource !== "lane" && route.modelSource !== "legacy")) {
      return { route };
    }
    const strictLane = getStrictLanePolicy(config.taskRouter, lane) !== undefined;
    if (!onResolveError || strictLane) {
      return { model: resolve(route.modelId), id: route.modelId, route };
    }
    try {
      return { model: resolve(route.modelId), id: route.modelId, route };
    } catch (err) {
      onResolveError(lane, route.modelId, err);
      return { id: route.modelId, route };
    }
  };

  const lanes: SubagentLaneModels = {};
  let any = false;
  for (const lane of WORKER_LANES) {
    const { model } = build(lane);
    if (model) {
      lanes[lane] = model;
      any = true;
    }
  }
  const web = build("webSearch");
  const routes = resolveRoutingTable(config, parentModelId);
  // The web-search agent is launched per tool call without going through
  // createAgent, so enforce its strict policy here: a violation disables the
  // agent (reported via `strict.violations`; the plain scraper still works).
  const webStrict = enforceStrictRoute(web.route, config.taskRouter);
  const webOk = webStrict.ok || web.model === undefined;

  return {
    subagentModels: any ? lanes : undefined,
    webSearchModel: webOk ? web.model : undefined,
    webSearchModelId: web.id,
    webSearchRoute: webStrict.ok ? webStrict.route : web.route,
    routes,
    strict: validateStrictRoutes(routes, config.taskRouter),
  };
}

/**
 * Give a model the provider options of its lane effort, for agents that are
 * built without per-call providerOptions (the web-search agent). Returns the
 * model unchanged unless the lane or a dispatch explicitly sets an effort —
 * so existing configs send exactly what they did before.
 */
export async function withLaneProviderOptions(
  model: LanguageModel | undefined,
  route: LaneRoute,
  config: AppConfig,
): Promise<LanguageModel | undefined> {
  if (!model || typeof model === "string" || !route.modelId) return model;
  if (route.effortSource === "global" || route.effortSource === "unset") return model;
  if (route.effortSource === "builtin") return model;
  const { providerOptions } = await buildProviderOptions(
    route.modelId,
    applyLaneEffort(config, route),
  );
  if (Object.keys(providerOptions).length === 0) return model;
  const laneOptions = providerOptions as Record<string, JSONObject>;
  // Same v2/v3 spec bridge as resolveModel() in provider.ts.
  return wrapLanguageModel({
    model: model as Parameters<typeof wrapLanguageModel>[0]["model"],
    middleware: {
      specificationVersion: "v3",
      transformParams: async ({ params }) => {
        const merged: Record<string, JSONObject> = { ...laneOptions };
        for (const [k, v] of Object.entries(params.providerOptions ?? {})) {
          merged[k] = { ...(merged[k] ?? {}), ...v };
        }
        return { ...params, providerOptions: merged };
      },
    },
  });
}
