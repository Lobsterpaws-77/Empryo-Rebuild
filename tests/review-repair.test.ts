/**
 * Review scope + review-driven worker repair (private rebuild CP4).
 *
 * Core "Review" = the post-dispatch verifier. Scope (reproduced from source):
 * it reviews the files edited by the dispatch's workers, as tracked on the
 * AgentBus (all agents, incl. de-sloppify and repair); Forge-authored edits
 * are outside a dispatch and are not reviewed; no edits → no review.
 */
import { describe, expect, test } from "bun:test";
import { AgentBus, type AgentTask } from "../src/core/agents/agent-bus.js";
import {
  getMaxRepairRounds,
  parseVerdict,
  runRepair,
  runReviewAndRepair,
  runVerifier,
} from "../src/core/agents/agent-verification.js";
import type { SubagentModels } from "../src/core/agents/subagent-tools.js";
import { resolveLaneRoute } from "../src/core/llm/lane-routing.js";
import type { AppConfig } from "../src/types/index.js";

const PARENT = "anthropic/claude-opus-4-6";
// biome-ignore lint/suspicious/noExplicitAny: minimal LanguageModel stand-in
const mockModel = (id: string): any => ({ modelId: id, doGenerate: async () => ({}) });

const codeTask: AgentTask = { agentId: "c1", role: "code", task: "edit foo" };

function models(features: SubagentModels["agentFeatures"], extra: Partial<SubagentModels> = {}) {
  return {
    defaultModel: mockModel("claude-opus-4-6"),
    agentFeatures: { verifyEdits: true, ...features },
    ...extra,
  } as SubagentModels;
}

/** Scripted verifier: returns reports in order. */
function scriptedVerify(reports: Array<string | null>) {
  const calls: number[] = [];
  const verify = (async () => {
    calls.push(calls.length);
    return reports[Math.min(calls.length - 1, reports.length - 1)] ?? null;
  }) as unknown as typeof runVerifier;
  return { verify, calls };
}

function scriptedRepair(result: string | null = "fixed foo.ts:3") {
  const findingsSeen: string[] = [];
  const repair = (async (
    _bus: AgentBus,
    _tasks: AgentTask[],
    _m: SubagentModels,
    _id: string,
    findings: string,
  ) => {
    findingsSeen.push(findings);
    return result;
  }) as unknown as typeof runRepair;
  return { repair, findingsSeen };
}

const FAIL = "\n\n### Verification\nfoo.ts:3 wrong sign\nVERDICT: FAIL — foo.ts:3";
const PASS = "\n\n### Verification\nlooks right\nVERDICT: PASS — ok";

describe("parseVerdict", () => {
  test("reads the last verdict line", () => {
    expect(parseVerdict(FAIL)).toBe("FAIL");
    expect(parseVerdict(PASS)).toBe("PASS");
    expect(parseVerdict("VERDICT: FAIL x\n…\nVERDICT: PASS y")).toBe("PASS");
    expect(parseVerdict("verdict: partial — couldn't run tests")).toBe("PARTIAL");
    expect(parseVerdict("no verdict")).toBe("UNKNOWN");
    expect(parseVerdict(null)).toBe("UNKNOWN");
  });
});

describe("review scope", () => {
  test("clean / no edits → no review", async () => {
    const bus = new AgentBus();
    expect(await runVerifier(bus, [codeTask], models({}), "tc")).toBeNull();
  });

  test("no code tasks → no review", async () => {
    const bus = new AgentBus();
    bus.recordFileEdit("x", "src/a.ts");
    const explore: AgentTask = { agentId: "e1", role: "explore", task: "read" };
    expect(await runVerifier(bus, [explore], models({}), "tc")).toBeNull();
  });

  test("repair worker is scoped to every worker-edited file (mixed agents)", async () => {
    const bus = new AgentBus();
    bus.recordFileEdit("c1", "src/a.ts");
    bus.recordFileEdit("c2", "src/b.ts");
    bus.recordFileEdit("desloppify", "src/a.ts");
    let captured: AgentTask | undefined;
    const runner = (async (task: AgentTask) => {
      captured = task;
      return { resultText: "fixed", doneResult: null, callbacks: {}, result: {} };
    }) as never;
    const out = await runRepair(bus, [codeTask], models({}), "tc", FAIL, 1, undefined, runner);
    expect(out).toBe("fixed");
    expect(captured?.lane).toBe("repair");
    expect(captured?.role).toBe("code");
    expect(captured?.targetFiles?.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(captured?.task).toContain("foo.ts:3 wrong sign");
  });
});

describe("runReviewAndRepair", () => {
  const bus = () => new AgentBus();

  test("repair off → verifier report returned unchanged (existing behaviour)", async () => {
    const { verify, calls } = scriptedVerify([FAIL]);
    const { repair, findingsSeen } = scriptedRepair();
    const out = await runReviewAndRepair(bus(), [codeTask], models({}), "tc", undefined, undefined, {
      verify,
      repair,
    });
    expect(out).toBe(FAIL);
    expect(calls.length).toBe(1);
    expect(findingsSeen).toEqual([]);
  });

  test("FAIL → repair worker → recheck PASS; lock held only during repair", async () => {
    const { verify, calls } = scriptedVerify([FAIL, PASS]);
    const { repair, findingsSeen } = scriptedRepair();
    const lock: string[] = [];
    const out = await runReviewAndRepair(
      bus(),
      [codeTask],
      models({ repairOnReviewFail: true }),
      "tc",
      undefined,
      { beforeRepair: () => lock.push("acquire"), afterRepair: () => lock.push("release") },
      { verify, repair },
    );
    expect(calls.length).toBe(2);
    expect(findingsSeen[0]).toContain("VERDICT: FAIL");
    expect(lock).toEqual(["acquire", "release"]);
    expect(out).toContain("### Repair (round 1, repair lane)");
    expect(out).toContain("### Verification (recheck 1)");
    expect(out).toContain("PASS after 1 repair round(s)");
  });

  test("still FAIL after max rounds → coordinator guidance, bounded", async () => {
    const { verify, calls } = scriptedVerify([FAIL, FAIL, FAIL, FAIL]);
    const { repair, findingsSeen } = scriptedRepair();
    const out = await runReviewAndRepair(
      bus(),
      [codeTask],
      models({ repairOnReviewFail: true, maxRepairRounds: 2 }),
      "tc",
      undefined,
      undefined,
      { verify, repair },
    );
    expect(findingsSeen.length).toBe(2);
    expect(calls.length).toBe(3);
    expect(out).toContain("still FAIL after 2 repair round(s)");
    expect(out).toContain("dispatch a code agent");
  });

  test("PASS / PARTIAL / read-only / aborted → no repair", async () => {
    for (const [report, extra, signal] of [
      [PASS, {}, undefined],
      ["VERDICT: PARTIAL — no tests", {}, undefined],
      [FAIL, { readOnly: true }, undefined],
      [FAIL, {}, AbortSignal.abort()],
    ] as const) {
      const { verify } = scriptedVerify([report]);
      const { repair, findingsSeen } = scriptedRepair();
      await runReviewAndRepair(
        bus(),
        [codeTask],
        models({ repairOnReviewFail: true }, extra),
        "tc",
        signal,
        undefined,
        { verify, repair },
      );
      expect(findingsSeen).toEqual([]);
    }
  });

  test("repair worker failure stops the loop and is reported", async () => {
    const { verify, calls } = scriptedVerify([FAIL, PASS]);
    const { repair } = scriptedRepair(null);
    const out = await runReviewAndRepair(
      bus(),
      [codeTask],
      models({ repairOnReviewFail: true }),
      "tc",
      undefined,
      undefined,
      { verify, repair },
    );
    expect(calls.length).toBe(1);
    expect(out).toContain("Repair worker failed");
  });

  test("maxRepairRounds is clamped to 1–3", () => {
    expect(getMaxRepairRounds(models({}))).toBe(1);
    expect(getMaxRepairRounds(models({ maxRepairRounds: 9 }))).toBe(3);
    expect(getMaxRepairRounds(models({ maxRepairRounds: 0 }))).toBe(1);
  });
});

describe("repair lane routing", () => {
  const route = (tr: object, perf: object = { effort: "high" }) =>
    resolveLaneRoute("repair", { taskRouter: tr, performance: perf } as AppConfig, {
      parentModelId: PARENT,
    });

  test("unset → configured coder's model AND effort together", () => {
    const r = route({ ember: "openai/gpt-5-mini", effort: { ember: "medium" } });
    expect([r.modelId, r.modelSource, r.effort, r.effortSource]).toEqual([
      "openai/gpt-5-mini",
      "inherited",
      "medium",
      "inherited",
    ]);
  });

  test("coder on global effort → repair keeps the global source", () => {
    const r = route({ ember: "openai/gpt-5-mini" });
    expect([r.effort, r.effortSource]).toEqual(["high", "global"]);
  });

  test("own model → effort does NOT come from ember", () => {
    const r = route({ repair: "anthropic/claude-sonnet-4-6", effort: { ember: "max" } });
    expect([r.modelId, r.modelSource, r.effort, r.effortSource]).toEqual([
      "anthropic/claude-sonnet-4-6",
      "lane",
      "high",
      "global",
    ]);
  });

  test("own effort → wins over the inherited pair", () => {
    const r = route({ ember: "openai/gpt-5-mini", effort: { ember: "max", repair: "low" } });
    expect([r.modelId, r.effort, r.effortSource]).toEqual(["openai/gpt-5-mini", "low", "lane"]);
  });
});
