/**
 * Build the per-turn set of worker-lane models from ONE effective config
 * snapshot. Shared by the TUI (useChat) and headless runner so both surfaces
 * resolve lanes identically (they previously each hand-rolled the
 * `spark ?? exploration ?? trivial` chains).
 */

import type { LanguageModel } from "ai";
import type { AppConfig } from "../../types/index.js";
import { type LaneRoute, resolveLaneRoute, resolveRoutingTable } from "./lane-routing.js";

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
  /** Resolved route for every registered lane — for logs and the /router view. */
  routes: LaneRoute[];
}

const WORKER_LANES = ["spark", "ember", "desloppify", "verify"] as const;

/**
 * @param config        EFFECTIVE (global + project) config for this turn
 * @param parentModelId full id of the Forge model
 * @param resolve       builds a LanguageModel from "provider/model"
 * @param onResolveError when given, a lane whose model fails to build is
 *                       reported and left unset (Forge model is used);
 *                       when omitted, the error propagates.
 */
export function buildSubagentRouting(
  config: AppConfig,
  parentModelId: string,
  resolve: (modelId: string) => LanguageModel,
  onResolveError?: (lane: string, modelId: string, err: unknown) => void,
): SubagentRouting {
  const build = (lane: string): { model?: LanguageModel; id?: string } => {
    const route = resolveLaneRoute(lane, config, { parentModelId });
    // Only lanes with their OWN configured model get a distinct model object;
    // "parent" lanes use the Forge model the dispatcher already holds.
    if (!route.modelId || (route.modelSource !== "lane" && route.modelSource !== "legacy")) {
      return {};
    }
    if (!onResolveError) return { model: resolve(route.modelId), id: route.modelId };
    try {
      return { model: resolve(route.modelId), id: route.modelId };
    } catch (err) {
      onResolveError(lane, route.modelId, err);
      return { id: route.modelId };
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

  return {
    subagentModels: any ? lanes : undefined,
    webSearchModel: web.model,
    webSearchModelId: web.id,
    routes: resolveRoutingTable(config, parentModelId),
  };
}
