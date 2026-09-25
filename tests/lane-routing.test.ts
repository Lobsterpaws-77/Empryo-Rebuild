/**
 * Lane routing — model AND effort per worker lane, resolved together from one
 * effective config snapshot.
 *
 * Acceptance-matrix mapping (private rebuild handoff §23, "Routing correctness"):
 *   Graph Node / Graph Judge  → registered extension lanes (the desktop lanes
 *                               plug in through registerRoutingLane) + the core
 *                               analogues: verify (reviewer/judge) and
 *                               desloppify (post-dispatch worker)
 *   Ember                     → ember lane (code workers)
 */
import { afterEach, describe, expect, test } from "bun:test";
import { AgentBus, type AgentTask } from "../src/core/agents/agent-bus.js";
import { classifyTask, resolveTaskLane, selectModel } from "../src/core/agents/agent-runner.js";
import { createAgent, resolveTaskRoute } from "../src/core/agents/subagent-tools.js";
import {
  applyLaneEffort,
  formatLaneRoute,
  getLanePolicy,
  laneEffortDelivery,
  type RoutingConfig,
  registerRoutingLane,
  resolveLaneRoute,
  resolveRoutingTable,
} from "../src/core/llm/lane-routing.js";
import { buildSubagentRouting } from "../src/core/llm/subagent-routing.js";
import type { AppConfig } from "../src/types/index.js";

const PARENT = "anthropic/claude-opus-4-6";

// biome-ignore lint/suspicious/noExplicitAny: minimal LanguageModel stand-in
const mockModel = (id: string): any => ({
  specificationVersion: "v3",
  provider: "mock",
  modelId: id,
  supportedUrls: {},
  doGenerate: async () => ({}),
  doStream: async () => ({}),
});

function cfg(partial: Partial<AppConfig>): AppConfig {
  return { defaultModel: PARENT, ...partial } as AppConfig;
}

const unregister: Array<() => void> = [];
afterEach(() => {
  while (unregister.length) unregister.pop()?.();
});

function registerGraphLikeLanes() {
  // Stand-ins for desktop Graph Node / Graph Judge — NOT desktop types, just
  // extension lanes proving the plug-in path.
  unregister.push(
    registerRoutingLane({
      id: "example.node",
      label: "Example Node",
      modelKeys: ["example.node"],
      modelFallback: "parent",
      effortFallback: { kind: "global" },
      effortConfigurable: true,
    }),
    registerRoutingLane({
      id: "example.judge",
      label: "Example Judge",
      modelKeys: ["example.judge"],
      modelFallback: "parent",
      effortFallback: { kind: "global" },
      effortConfigurable: true,
    }),
  );
}

describe("resolveLaneRoute — acceptance matrix", () => {
  test("node basic: lane model + lane effort, no explicit per-node effort", () => {
    registerGraphLikeLanes();
    const c: RoutingConfig = {
      performance: { effort: "max" },
      taskRouter: {
        ...({ "example.node": "openai/gpt-luna" } as object),
        effort: { "example.node": "high", ember: "max" },
      } as AppConfig["taskRouter"],
    };
    const r = resolveLaneRoute("example.node", c, { parentModelId: PARENT });
    expect(r.modelId).toBe("openai/gpt-luna");
    expect(r.modelSource).toBe("lane");
    expect(r.effort).toBe("high");
    expect(r.effortSource).toBe("lane");
  });

  test("node change: effort edit is picked up on next resolution", () => {
    registerGraphLikeLanes();
    const tr = { "example.node": "openai/gpt-luna", effort: { "example.node": "high" } };
    const c = { taskRouter: tr } as unknown as RoutingConfig;
    expect(resolveLaneRoute("example.node", c, { parentModelId: PARENT }).effort).toBe("high");
    tr.effort["example.node"] = "medium";
    const r = resolveLaneRoute("example.node", c, { parentModelId: PARENT });
    expect(r.modelId).toBe("openai/gpt-luna");
    expect(r.effort).toBe("medium");
  });

  test("judge basic + change (verify lane is the core reviewer/judge)", () => {
    const tr = { verify: "openai/gpt-sol", effort: { verify: "high" as const } };
    const c = { taskRouter: tr, performance: { effort: "max" } } as RoutingConfig;
    let r = resolveLaneRoute("verify", c, { parentModelId: PARENT });
    expect([r.modelId, r.effort]).toEqual(["openai/gpt-sol", "high"]);
    tr.effort.verify = "low" as "high";
    r = resolveLaneRoute("verify", c, { parentModelId: PARENT });
    expect([r.modelId, r.effort]).toEqual(["openai/gpt-sol", "low"]);
  });

  test("explicit per-dispatch effort beats lane effort", () => {
    registerGraphLikeLanes();
    const c = {
      taskRouter: { effort: { "example.node": "high" } },
    } as unknown as RoutingConfig;
    const r = resolveLaneRoute("example.node", c, {
      parentModelId: PARENT,
      override: { effort: "xhigh" },
    });
    expect(r.effort).toBe("xhigh");
    expect(r.effortSource).toBe("override");
  });

  test("ember isolation: ember=max never leaks into another lane", () => {
    registerGraphLikeLanes();
    const c = {
      performance: { effort: "low" },
      taskRouter: { effort: { ember: "max", "example.node": "medium" } },
    } as unknown as RoutingConfig;
    expect(resolveLaneRoute("example.node", c, { parentModelId: PARENT }).effort).toBe("medium");
    // Lanes WITHOUT their own effort fall back to global — not to ember.
    for (const lane of ["desloppify", "verify", "compact", "example.judge"]) {
      const r = resolveLaneRoute(lane, c, { parentModelId: PARENT });
      expect(r.effort).toBe("low");
      expect(r.effortSource).toBe("global");
    }
  });

  test("judge isolation: ember=max, verify=low → verify stays low", () => {
    const c = {
      performance: { effort: "max" },
      taskRouter: { effort: { ember: "max", verify: "low" } },
    } as RoutingConfig;
    expect(resolveLaneRoute("verify", c, { parentModelId: PARENT }).effort).toBe("low");
  });

  test("standalone coder keeps ember routing", () => {
    const c = {
      performance: { effort: "medium" },
      taskRouter: { ember: "anthropic/claude-sonnet-4-6", effort: { ember: "max" } },
    } as RoutingConfig;
    const r = resolveLaneRoute("ember", c, { parentModelId: PARENT });
    expect([r.modelId, r.effort, r.effortSource]).toEqual([
      "anthropic/claude-sonnet-4-6",
      "max",
      "lane",
    ]);
  });

  test("saved config with no lane effort → documented fallbacks", () => {
    const c = {
      performance: { effort: "high" },
      taskRouter: { coding: "openai/gpt-5", exploration: "openai/gpt-5-mini" },
    } as unknown as RoutingConfig;
    const ember = resolveLaneRoute("ember", c, { parentModelId: PARENT });
    expect([ember.modelId, ember.modelSource, ember.modelKey]).toEqual([
      "openai/gpt-5",
      "legacy",
      "taskRouter.coding",
    ]);
    expect([ember.effort, ember.effortSource]).toEqual(["high", "global"]);
    // Explore keeps its historical built-in "low" when any effort is configured.
    const spark = resolveLaneRoute("spark", c, { parentModelId: PARENT });
    expect([spark.effort, spark.effortSource]).toEqual(["low", "builtin"]);
    // …and sends nothing when no effort is configured anywhere.
    const none = resolveLaneRoute("spark", { taskRouter: c.taskRouter }, { parentModelId: PARENT });
    expect([none.effort, none.effortSource]).toEqual([undefined, "unset"]);
  });

  test("model fallbacks: parent / router-default / disabled", () => {
    const c = { taskRouter: { default: "openai/gpt-5" } } as RoutingConfig;
    expect(resolveLaneRoute("verify", c, { parentModelId: PARENT }).modelSource).toBe("parent");
    const compact = resolveLaneRoute("compact", c, { parentModelId: PARENT });
    expect([compact.modelId, compact.modelSource]).toEqual(["openai/gpt-5", "router-default"]);
    const desloppify = resolveLaneRoute("desloppify", c, { parentModelId: PARENT });
    expect([desloppify.modelId, desloppify.modelSource]).toEqual([null, "disabled"]);
  });

  test("invalid lane effort values are ignored (fallback applies)", () => {
    const c = {
      performance: { effort: "medium" },
      taskRouter: { effort: { verify: "extreme" } },
    } as unknown as RoutingConfig;
    const r = resolveLaneRoute("verify", c, { parentModelId: PARENT });
    expect([r.effort, r.effortSource]).toEqual(["medium", "global"]);
  });

  test("effort is ignored on lanes whose calls carry no reasoning options", () => {
    const c = {
      performance: { effort: "medium" },
      taskRouter: { effort: { semantic: "max" } },
    } as RoutingConfig;
    expect(resolveLaneRoute("semantic", c, { parentModelId: PARENT }).effortSource).toBe("global");
  });

  test("built-in lanes cannot be replaced; unknown lanes throw", () => {
    expect(() =>
      registerRoutingLane({ ...(getLanePolicy("verify") as never), id: "verify" }),
    ).toThrow();
    expect(() => resolveLaneRoute("nope", {}, { parentModelId: PARENT })).toThrow();
  });

  test("routing table covers every lane and formats readably", () => {
    const rows = resolveRoutingTable({ performance: { effort: "high" } }, PARENT);
    expect(rows.map((r) => r.lane)).toEqual([
      "forge",
      "default",
      "spark",
      "ember",
      "webSearch",
      "desloppify",
      "verify",
      "compact",
      "semantic",
    ]);
    const verify = rows.find((r) => r.lane === "verify");
    expect(verify && formatLaneRoute(verify)).toBe(
      `verify → ${PARENT} (inherits Forge model) · effort high (inherits global effort)`,
    );
  });
});

describe("applyLaneEffort", () => {
  const base = {
    performance: { effort: "max", openaiReasoningEffort: "high", xaiReasoningEffort: "high" },
  } as RoutingConfig;

  test("global/unset routes return config unchanged", () => {
    const r = resolveLaneRoute("ember", base, { parentModelId: PARENT });
    expect(applyLaneEffort(base, r)).toBe(base);
  });

  test("builtin route replaces only the unified knob (historical explore behaviour)", () => {
    const r = resolveLaneRoute("spark", base, { parentModelId: PARENT });
    const out = applyLaneEffort(base, r);
    expect(out.performance).toEqual({ ...base.performance, effort: "low" });
  });

  test("lane route is authoritative across provider knobs", () => {
    const c = { ...base, taskRouter: { effort: { verify: "max" } } } as RoutingConfig;
    const r = resolveLaneRoute("verify", c, { parentModelId: PARENT });
    const perf = applyLaneEffort(c, r).performance;
    expect(perf?.effort).toBe("max");
    expect(perf?.openaiReasoningEffort).toBe("xhigh");
    expect(perf?.xaiReasoningEffort).toBeUndefined();
  });
});

describe("laneEffortDelivery", () => {
  test("classifies providers", () => {
    expect(laneEffortDelivery("anthropic/claude-opus-4-6")).toBe("request");
    expect(laneEffortDelivery("openai/gpt-5")).toBe("request");
    expect(laneEffortDelivery("proxy/claude-sonnet-4-6")).toBe("request");
    expect(laneEffortDelivery("proxy/gemini-3-pro")).toBe("construction");
    expect(laneEffortDelivery("groq/qwen3-32b")).toBe("construction");
    expect(laneEffortDelivery("codex/gpt-5-codex")).toBe("unsupported");
  });
});

describe("task lanes (dispatch)", () => {
  const defaultModel = mockModel("claude-opus-4-6");
  const sparkModel = mockModel("claude-haiku-4-5");
  const verifyModel = mockModel("gpt-5");
  const task = (t: Partial<AgentTask>): AgentTask => ({
    agentId: "a",
    role: "explore",
    task: "x",
    ...t,
  });

  test("lane derives from role, explicit lane wins, read-only forces spark", () => {
    expect(resolveTaskLane(task({ role: "explore" }))).toBe("spark");
    expect(resolveTaskLane(task({ role: "code" }))).toBe("ember");
    expect(resolveTaskLane(task({ role: "code" }), { readOnly: true })).toBe("spark");
    expect(resolveTaskLane(task({ role: "explore", lane: "verify" }))).toBe("verify");
  });

  test("verifier gets the verify-lane model (not the spark model)", () => {
    const { model } = selectModel(task({ lane: "verify" }), {
      defaultModel,
      sparkModel,
      verifyModel,
    });
    expect(model.modelId).toBe("gpt-5");
  });

  test("cache tier follows the lane model actually used", () => {
    // verify on parent model → spark (shares cache) even when spark lane differs
    expect(classifyTask(task({ lane: "verify" }), { defaultModel, sparkModel })).toBe("spark");
    expect(classifyTask(task({ lane: "verify" }), { defaultModel, verifyModel })).toBe("ember");
  });

  test("model override only applies when a factory can build it", () => {
    const models = { defaultModel, sparkModel };
    const t = task({ model: "openai/gpt-override" });
    expect(selectModel(t, models).model.modelId).toBe("claude-haiku-4-5");
    const route = resolveTaskRoute(t, models, cfg({}));
    expect(route.modelSource).not.toBe("override");
    const withFactory = { ...models, modelFactory: (id: string) => mockModel(id.split("/")[1]) };
    expect(selectModel(t, withFactory).model.modelId).toBe("gpt-override");
    expect(resolveTaskRoute(t, withFactory, cfg({})).modelSource).toBe("override");
  });
});

describe("createAgent — effort reaches the provider request", () => {
  const bus = () => new AgentBus();
  const anthropicEffort = (agent: unknown): unknown =>
    // biome-ignore lint/suspicious/noExplicitAny: inspect ToolLoopAgent settings
    ((agent as any).settings?.providerOptions?.anthropic as Record<string, unknown> | undefined)
      ?.effort;

  test("verifier uses verify-lane effort, not explore 'low' and not global 'max'", async () => {
    const c = cfg({
      performance: { effort: "max" },
      taskRouter: {
        verify: "anthropic/claude-sonnet-4-6",
        effort: { verify: "high" },
      } as AppConfig["taskRouter"],
    });
    const r = await createAgent(
      { agentId: "verifier", role: "explore", lane: "verify", task: "x" },
      {
        defaultModel: mockModel("claude-opus-4-6"),
        verifyModel: mockModel("claude-sonnet-4-6"),
        routingConfig: c,
        parentModelId: PARENT,
      },
      bus(),
    );
    expect(r.modelId).toBe("claude-sonnet-4-6");
    expect(r.route.effort).toBe("high");
    expect(anthropicEffort(r.agent)).toBe("high");
  });

  test("desloppify uses its lane effort, isolated from ember", async () => {
    const c = cfg({
      performance: { effort: "low" },
      taskRouter: {
        desloppify: "anthropic/claude-sonnet-4-6",
        effort: { ember: "max", desloppify: "medium" },
      } as AppConfig["taskRouter"],
    });
    const r = await createAgent(
      { agentId: "desloppify", role: "code", tier: "ember", lane: "desloppify", task: "x" },
      {
        defaultModel: mockModel("claude-opus-4-6"),
        desloppifyModel: mockModel("claude-sonnet-4-6"),
        routingConfig: c,
        parentModelId: PARENT,
      },
      bus(),
    );
    expect(anthropicEffort(r.agent)).toBe("medium");
  });

  test("code worker on parent model inherits global effort", async () => {
    const r = await createAgent(
      { agentId: "c1", role: "code", task: "x" },
      {
        defaultModel: mockModel("claude-opus-4-6"),
        routingConfig: cfg({ performance: { effort: "high" } }),
        parentModelId: PARENT,
      },
      bus(),
    );
    expect(r.route.effortSource).toBe("global");
    expect(anthropicEffort(r.agent)).toBe("high");
  });

  test("uses the passed effective snapshot, not the global config file", async () => {
    // Project-scope effort lives only in the snapshot.
    const snapshot = cfg({
      performance: { effort: "medium" },
      taskRouter: { effort: { ember: "low" } } as AppConfig["taskRouter"],
    });
    const r = await createAgent(
      { agentId: "c1", role: "code", task: "x" },
      { defaultModel: mockModel("claude-opus-4-6"), routingConfig: snapshot, parentModelId: PARENT },
      bus(),
    );
    expect(r.route.effortSource).toBe("lane");
    expect(anthropicEffort(r.agent)).toBe("low");
  });

  test("OpenAI lane effort max maps to reasoningEffort xhigh", async () => {
    const c = cfg({
      taskRouter: { ember: "openai/gpt-5", effort: { ember: "max" } } as AppConfig["taskRouter"],
    });
    const r = await createAgent(
      { agentId: "c1", role: "code", task: "x" },
      {
        defaultModel: mockModel("claude-opus-4-6"),
        emberModel: mockModel("gpt-5"),
        routingConfig: c,
        parentModelId: PARENT,
      },
      bus(),
    );
    // biome-ignore lint/suspicious/noExplicitAny: inspect ToolLoopAgent settings
    expect((r.agent as any).settings.providerOptions.openai.reasoningEffort).toBe("xhigh");
  });
});

describe("buildSubagentRouting", () => {
  const resolve = (id: string) => mockModel(id);

  test("only lanes with their own model get a model object", () => {
    const c = cfg({
      taskRouter: { exploration: "openai/gpt-5-mini", verify: "openai/gpt-5" } as AppConfig["taskRouter"],
    });
    const r = buildSubagentRouting(c, PARENT, resolve);
    expect(r.subagentModels?.spark?.modelId).toBe("openai/gpt-5-mini");
    expect(r.subagentModels?.verify?.modelId).toBe("openai/gpt-5");
    expect(r.subagentModels?.ember).toBeUndefined();
    expect(r.webSearchModel).toBeUndefined();
  });

  test("no worker lane models → undefined (all inherit Forge model)", () => {
    expect(buildSubagentRouting(cfg({}), PARENT, resolve).subagentModels).toBeUndefined();
  });

  test("resolve errors propagate unless a handler is given", () => {
    const c = cfg({ taskRouter: { ember: "bad/model" } as AppConfig["taskRouter"] });
    const boom = () => {
      throw new Error("nope");
    };
    expect(() => buildSubagentRouting(c, PARENT, boom)).toThrow("nope");
    const seen: string[] = [];
    const r = buildSubagentRouting(c, PARENT, boom, (lane, id) => seen.push(`${lane}:${id}`));
    expect(seen).toEqual(["ember:bad/model"]);
    expect(r.subagentModels).toBeUndefined();
  });
});
