/**
 * Strict routing — opt-in fail-closed policy on top of lane routing.
 *
 * Flexible fallback stays the default. When `taskRouter.strict.enabled` is
 * true, each lane listed in `taskRouter.strict.lanes` is checked before a
 * worker launches:
 *
 *  - model must be in `models`, or in `fallbackModels` (allowed, reported as
 *    a visible fallback). Anything else → StrictRoutingError, no substitute.
 *  - effort must be in `efforts`. Out-of-policy effort is rejected by default,
 *    or clamped to the nearest permitted value when `effortViolation: "clamp"`
 *    (ties clamp DOWN). A lane with no effort configured counts as "off".
 *  - when `efforts` is set, the model's provider must honour per-request
 *    effort (see laneEffortDelivery); otherwise the policy can't be enforced
 *    and the launch is rejected.
 *
 * Lanes not listed are unconstrained. Because the policy lives in
 * `taskRouter`, it follows the same global/project scope (and presets) as the
 * lane models themselves.
 */

import type { StrictLanePolicy, StrictRoutingPolicy, TaskRouter } from "../../types/index.js";
import {
  LANE_EFFORT_VALUES,
  type LaneEffort,
  type LaneRoute,
  laneEffortDelivery,
} from "./lane-routing.js";

export type StrictViolationKind =
  | "model-not-permitted"
  | "lane-disabled"
  | "effort-not-permitted"
  | "effort-not-enforceable";

export interface StrictViolation {
  lane: string;
  kind: StrictViolationKind;
  message: string;
}

export type StrictOutcome =
  | { ok: true; route: LaneRoute; notes: string[] }
  | { ok: false; violation: StrictViolation };

export class StrictRoutingError extends Error {
  constructor(public readonly violation: StrictViolation) {
    super(violation.message);
    this.name = "StrictRoutingError";
  }
}

export function getStrictPolicy(router: TaskRouter | undefined): StrictRoutingPolicy | undefined {
  const p = router?.strict;
  return p?.enabled ? p : undefined;
}

export function getStrictLanePolicy(
  router: TaskRouter | undefined,
  lane: string,
): StrictLanePolicy | undefined {
  return getStrictPolicy(router)?.lanes?.[lane];
}

const effortRank = (e: LaneEffort): number => LANE_EFFORT_VALUES.indexOf(e);

/** Nearest permitted effort; ties resolve to the lower effort. */
export function clampToPermitted(effort: LaneEffort, permitted: readonly LaneEffort[]): LaneEffort {
  const r = effortRank(effort);
  let best = permitted[0] as LaneEffort;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const p of permitted) {
    const d = Math.abs(effortRank(p) - r);
    if (d < bestDist || (d === bestDist && effortRank(p) < effortRank(best))) {
      best = p;
      bestDist = d;
    }
  }
  return best;
}

function list(v: readonly string[] | undefined): string {
  return v && v.length > 0 ? v.join(", ") : "(none)";
}

/** Check (and possibly clamp) a resolved route against the strict policy. */
export function enforceStrictRoute(
  route: LaneRoute,
  router: TaskRouter | undefined,
): StrictOutcome {
  const policy = getStrictLanePolicy(router, route.lane);
  if (!policy) return { ok: true, route, notes: [] };
  const notes: string[] = [];
  const lane = route.lane;

  // ── model ──
  const models = policy.models?.filter(Boolean) ?? [];
  const fallbacks = policy.fallbackModels?.filter(Boolean) ?? [];
  if (models.length > 0 || fallbacks.length > 0) {
    if (!route.modelId) {
      return {
        ok: false,
        violation: {
          lane,
          kind: "lane-disabled",
          message: `Strict routing: lane "${lane}" has no model configured; permitted: ${list(models)}.`,
        },
      };
    }
    if (!models.includes(route.modelId)) {
      if (fallbacks.includes(route.modelId)) {
        notes.push(`lane "${lane}" is using permitted fallback model ${route.modelId}`);
      } else {
        return {
          ok: false,
          violation: {
            lane,
            kind: "model-not-permitted",
            message:
              `Strict routing: lane "${lane}" resolved model ${route.modelId} (${route.modelSource}), ` +
              `which is not permitted. Permitted: ${list(models)}; fallbacks: ${list(fallbacks)}. ` +
              `No substitute model was used.`,
          },
        };
      }
    }
  }

  // ── effort ──
  const efforts = policy.efforts?.filter((e) => LANE_EFFORT_VALUES.includes(e)) ?? [];
  if (efforts.length === 0) return { ok: true, route, notes };

  if (route.modelId && laneEffortDelivery(route.modelId) !== "request") {
    return {
      ok: false,
      violation: {
        lane,
        kind: "effort-not-enforceable",
        message:
          `Strict routing: lane "${lane}" restricts effort, but ${route.modelId} does not accept ` +
          `per-request effort (${laneEffortDelivery(route.modelId)}), so the policy cannot be enforced.`,
      },
    };
  }

  const effective: LaneEffort = route.effort ?? "off";
  if (efforts.includes(effective)) return { ok: true, route, notes };

  if (policy.effortViolation === "clamp") {
    const clamped = clampToPermitted(effective, efforts);
    notes.push(`lane "${lane}" effort ${effective} clamped to ${clamped} by strict policy`);
    return {
      ok: true,
      route: { ...route, effort: clamped, effortSource: route.effortSource },
      notes,
    };
  }
  return {
    ok: false,
    violation: {
      lane,
      kind: "effort-not-permitted",
      message:
        `Strict routing: lane "${lane}" resolved effort ${effective} (${route.effortSource}), ` +
        `which is not permitted. Permitted: ${efforts.join(", ")}. No substitute effort was used.`,
    },
  };
}

/** Validate every constrained lane up front — for launch-time reporting. */
export function validateStrictRoutes(
  routes: readonly LaneRoute[],
  router: TaskRouter | undefined,
): { violations: StrictViolation[]; notes: string[] } {
  const violations: StrictViolation[] = [];
  const notes: string[] = [];
  const policy = getStrictPolicy(router);
  if (!policy) return { violations, notes };
  for (const route of routes) {
    if (!policy.lanes?.[route.lane]) continue;
    // A disabled optional lane (e.g. desloppify with no model) never launches.
    if (!route.modelId && route.modelSource === "disabled") continue;
    const out = enforceStrictRoute(route, router);
    if (out.ok) notes.push(...out.notes);
    else violations.push(out.violation);
  }
  return { violations, notes };
}

/**
 * Filter a transient-error model fallback chain for a lane: models the strict
 * policy does not permit are removed (and reported) instead of being silently
 * switched to.
 */
export function filterStrictFallbacks(
  lane: string,
  chain: readonly string[],
  router: TaskRouter | undefined,
): { allowed: string[]; blocked: string[] } {
  const policy = getStrictLanePolicy(router, lane);
  const permitted = [...(policy?.models ?? []), ...(policy?.fallbackModels ?? [])];
  if (!policy || permitted.length === 0) return { allowed: [...chain], blocked: [] };
  const allowed: string[] = [];
  const blocked: string[] = [];
  for (const m of chain) (permitted.includes(m) ? allowed : blocked).push(m);
  return { allowed, blocked };
}
