/**
 * Strict routing (opt-in fail-closed) + CP3 routing controls.
 * Maps handoff §23 "Strict routing" matrix onto the core lanes.
 */
import { describe, expect, test } from "bun:test";
import { AgentBus } from "../src/core/agents/agent-bus.js";
import { createAgent } from "../src/core/agents/subagent-tools.js";
import {
  cycleLaneEffort,
  type LaneRoute,
  resolveLaneRoute,
} from "../src/core/llm/lane-routing.js";
import {
  clampToPermitted,
  enforceStrictRoute,
  filterStrictFallbacks,
  StrictRoutingError,
  validateStrictRoutes,
} from "../src/core/llm/strict-routing.js";
import { buildSubagentRouting, withLaneProviderOptions } from "../src/core/llm/subagent-routing.js";
import type { AppConfig, TaskRouter } from "../src/types/index.js";

const PARENT = "anthropic/claude-opus-4-6";

// biome-ignore lint/suspicious/noExplicitAny: minimal LanguageModel stand-in
const mockModel = (id: string, onCall?: (params: any) => void): any => ({
  specificationVersion: "v3",
  provider: "mock",
  modelId: id,
  supportedUrls: {},
  doGenerate: async (params: unknown) => {
    onCall?.(params);
    return {
      content: [{ type: "text", text: "ok" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    };
  },
  doStream: async () => ({}),
});

function route(partial: Partial<LaneRoute>): LaneRoute {
  return {
    lane: "ember",
    modelId: "anthropic/claude-sonnet-4-6",
    modelSource: "lane",
    effort: "high",
    effortSource: "lane",
    ...partial,
  };
}

function strictRouter(lanes: NonNullable<TaskRouter["strict"]>["lanes"], enabled = true) {
  return { strict: { enabled, lanes } } as TaskRouter;
}

describe("enforceStrictRoute — acceptance matrix", () => {
  test("permitted model available → proceeds", () => {
    const tr = strictRouter({ ember: { models: ["anthropic/claude-sonnet-4-6"] } });
    const out = enforceStrictRoute(route({}), tr);
    expect(out.ok).toBe(true);
  });

  test("strict model not permitted → visible failure, no substitute", () => {
    const tr = strictRouter({ ember: { models: ["openai/gpt-5-mini"] } });
    const out = enforceStrictRoute(route({ modelSource: "parent", modelId: PARENT }), tr);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.violation.kind).toBe("model-not-permitted");
      expect(out.violation.message).toContain(PARENT);
      expect(out.violation.message).toContain("No substitute");
    }
  });

  test("explicit allowed fallback → proceeds and is reported", () => {
    const tr = strictRouter({
      verify: { models: ["openai/gpt-5"], fallbackModels: ["anthropic/claude-sonnet-4-6"] },
    });
    const out = enforceStrictRoute(route({ lane: "verify" }), tr);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.notes[0]).toContain("permitted fallback");
  });

  test("effort outside policy → rejected by default", () => {
    const tr = strictRouter({ verify: { efforts: ["high", "max"] } });
    const out = enforceStrictRoute(route({ lane: "verify", effort: "low" }), tr);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.violation.kind).toBe("effort-not-permitted");
  });

  test("effort outside policy → clamped when policy says clamp", () => {
    const tr = strictRouter({ ember: { efforts: ["low", "medium"], effortViolation: "clamp" } });
    const out = enforceStrictRoute(route({ effort: "max" }), tr);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.route.effort).toBe("medium");
      expect(out.notes[0]).toContain("clamped");
    }
  });

  test("unset lane effort counts as off", () => {
    const tr = strictRouter({ ember: { efforts: ["high"] } });
    const out = enforceStrictRoute(route({ effort: undefined, effortSource: "unset" }), tr);
    expect(out.ok).toBe(false);
  });

  test("effort policy on a provider that can't take per-request effort → rejected", () => {
    const tr = strictRouter({ ember: { efforts: ["high"] } });
    const out = enforceStrictRoute(route({ modelId: "groq/qwen3-32b" }), tr);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.violation.kind).toBe("effort-not-enforceable");
  });

  test("flexible (strict off or lane unlisted) → unchanged behaviour", () => {
    const off = strictRouter({ ember: { models: ["x/y"] } }, false);
    expect(enforceStrictRoute(route({}), off).ok).toBe(true);
    const unlisted = strictRouter({ verify: { models: ["x/y"] } });
    expect(enforceStrictRoute(route({}), unlisted).ok).toBe(true);
    expect(enforceStrictRoute(route({}), undefined).ok).toBe(true);
  });

  test("clampToPermitted picks nearest, ties go down", () => {
    expect(clampToPermitted("max", ["low", "high"])).toBe("high");
    expect(clampToPermitted("medium", ["low", "high"])).toBe("low");
    expect(clampToPermitted("off", ["medium", "max"])).toBe("medium");
  });
});

describe("validateStrictRoutes / filterStrictFallbacks", () => {
  test("launch-time validation reports violations and skips disabled optional lanes", () => {
    const config = {
      taskRouter: strictRouter({
        forge: { models: ["openai/gpt-5"] },
        desloppify: { models: ["openai/gpt-5-mini"] },
      }),
    };
    const routes = ["forge", "desloppify"].map((l) =>
      resolveLaneRoute(l, config, { parentModelId: PARENT }),
    );
    const { violations } = validateStrictRoutes(routes, config.taskRouter);
    expect(violations.map((v) => v.lane)).toEqual(["forge"]);
  });

  test("fallback chain drops non-permitted models", () => {
    const tr = strictRouter({ forge: { models: ["a/one"], fallbackModels: ["b/two"] } });
    expect(filterStrictFallbacks("forge", ["b/two", "c/three"], tr)).toEqual({
      allowed: ["b/two"],
      blocked: ["c/three"],
    });
    expect(filterStrictFallbacks("forge", ["c/three"], undefined).allowed).toEqual(["c/three"]);
  });
});

describe("strict routing at dispatch", () => {
  test("createAgent refuses a disallowed worker model with StrictRoutingError", async () => {
    const config = {
      defaultModel: PARENT,
      taskRouter: strictRouter({ ember: { models: ["openai/gpt-5-mini"] } }),
    } as AppConfig;
    await expect(
      createAgent(
        { agentId: "c1", role: "code", task: "x" },
        { defaultModel: mockModel("claude-opus-4-6"), routingConfig: config, parentModelId: PARENT },
        new AgentBus(),
      ),
    ).rejects.toBeInstanceOf(StrictRoutingError);
  });

  test("createAgent applies a clamped effort", async () => {
    const config = {
      defaultModel: PARENT,
      performance: { effort: "max" },
      taskRouter: strictRouter({ ember: { efforts: ["low", "medium"], effortViolation: "clamp" } }),
    } as AppConfig;
    const r = await createAgent(
      { agentId: "c1", role: "code", task: "x" },
      { defaultModel: mockModel("claude-opus-4-6"), routingConfig: config, parentModelId: PARENT },
      new AgentBus(),
    );
    expect(r.route.effort).toBe("medium");
    // biome-ignore lint/suspicious/noExplicitAny: inspect ToolLoopAgent settings
    expect((r.agent as any).settings.providerOptions.anthropic.effort).toBe("medium");
  });

  test("strict lane model that fails to build is not silently replaced", () => {
    const config = {
      defaultModel: PARENT,
      taskRouter: {
        ember: "bad/model",
        ...strictRouter({ ember: { models: ["bad/model"] } }),
      },
    } as AppConfig;
    const boom = () => {
      throw new Error("cannot build");
    };
    expect(() => buildSubagentRouting(config, PARENT, boom, () => {})).toThrow("cannot build");
  });
});

describe("web-search lane effort", () => {
  test("no lane effort → provider default (historical: nothing sent)", () => {
    const r = resolveLaneRoute("webSearch", { performance: { effort: "max" } }, {
      parentModelId: PARENT,
    });
    expect([r.effort, r.effortSource]).toEqual([undefined, "unset"]);
  });

  test("lane effort is injected into every call; unset leaves the model untouched", async () => {
    const config = {
      defaultModel: PARENT,
      taskRouter: { webSearch: "anthropic/claude-sonnet-4-6", effort: { webSearch: "low" } },
    } as AppConfig;
    // biome-ignore lint/suspicious/noExplicitAny: captured call params
    let seen: any;
    const base = mockModel("claude-sonnet-4-6", (p) => {
      seen = p;
    });
    const route = resolveLaneRoute("webSearch", config, { parentModelId: PARENT });
    const wrapped = await withLaneProviderOptions(base, route, config);
    expect(wrapped).not.toBe(base);
    // biome-ignore lint/suspicious/noExplicitAny: call the wrapped model directly
    await (wrapped as any).doGenerate({ prompt: [], providerOptions: { anthropic: { x: 1 } } });
    expect(seen.providerOptions.anthropic).toEqual({ effort: "low", x: 1 });

    const noEffort = { ...config, taskRouter: { webSearch: "anthropic/claude-sonnet-4-6" } };
    const r2 = resolveLaneRoute("webSearch", noEffort, { parentModelId: PARENT });
    expect(await withLaneProviderOptions(base, r2, noEffort as AppConfig)).toBe(base);
  });
});

describe("web-search strict", () => {
  test("violation disables the web-search agent and is reported", () => {
    const config = {
      defaultModel: PARENT,
      taskRouter: {
        webSearch: "openai/gpt-5",
        ...strictRouter({ webSearch: { models: ["openai/gpt-5-mini"] } }),
      },
    } as AppConfig;
    const r = buildSubagentRouting(config, PARENT, (id) => mockModel(id));
    expect(r.webSearchModel).toBeUndefined();
    expect(r.strict.violations.map((v) => v.lane)).toEqual(["webSearch"]);
  });
});

describe("cycleLaneEffort", () => {
  test("cycles inherit → off → … → max → inherit, both directions", () => {
    expect(cycleLaneEffort(undefined)).toBe("off");
    expect(cycleLaneEffort("off")).toBe("low");
    expect(cycleLaneEffort("max")).toBeUndefined();
    expect(cycleLaneEffort(undefined, -1)).toBe("max");
    expect(cycleLaneEffort("low", -1)).toBe("off");
  });
});
