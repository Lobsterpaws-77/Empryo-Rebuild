/**
 * Tests for the pure run-diagnostics aggregator. All fixtures are hand
 * built — no global stores are touched.
 */

import { describe, expect, it } from "bun:test";
import {
  buildRunDiagnostics,
  formatRunDiagnosticsMarkdown,
  type ActivityEntry,
  type ActivityState,
  type ModelCallEvent,
  type RunDiagnosticsInput,
} from "../src/core/diagnostics/run-diagnostics.js";

function mkCall(overrides: Partial<ModelCallEvent> & { id: string }): ModelCallEvent {
  return {
    modelId: "model-x",
    source: "main",
    startedAt: 0,
    durationMs: 100,
    state: "ok",
    ...overrides,
  };
}

function mkActor(overrides: Partial<ActivityState> & { actorId: string }): ActivityState {
  return {
    kind: "worker",
    name: overrides.actorId,
    phase: "done",
    label: "Completed",
    since: 0,
    lastEventAt: 0,
    startedAt: 0,
    ...overrides,
  };
}

function baseInput(overrides: Partial<RunDiagnosticsInput> = {}): RunDiagnosticsInput {
  return {
    runId: "run-1",
    generatedAt: 10_000,
    modelCalls: [],
    actors: [],
    feed: [],
    ...overrides,
  };
}

describe("usage totals and freshInput", () => {
  it("sums calls, errors, tokens, and floors freshInput at 0", () => {
    const calls: ModelCallEvent[] = [
      mkCall({ id: "1", modelId: "gpt-a", source: "main", startedAt: 1000, durationMs: 200, input: 100, output: 50, cacheRead: 40, cacheWrite: 10, lane: "lane1" }),
      mkCall({ id: "2", modelId: "gpt-a", source: "subagent", startedAt: 1300, durationMs: 300, input: 200, output: 80, cacheRead: 150, cacheWrite: 0, lane: "lane1" }),
      mkCall({ id: "3", modelId: "gpt-b", source: "main", startedAt: 1700, durationMs: 100, state: "error", errorCategory: "provider-rate-limit", input: 50, output: 0, cacheRead: 0, cacheWrite: 5, lane: "lane2" }),
      mkCall({ id: "4", modelId: "gpt-b", source: "compaction", startedAt: 2000, durationMs: 150, state: "error", input: 30, output: 0, cacheRead: 0, cacheWrite: 0 }),
    ];
    const d = buildRunDiagnostics(baseInput({ modelCalls: calls }));

    expect(d.usage.calls).toBe(4);
    expect(d.usage.errors).toBe(2);
    expect(d.usage.input).toBe(380);
    expect(d.usage.output).toBe(130);
    expect(d.usage.cacheRead).toBe(190);
    expect(d.usage.cacheWrite).toBe(15);
    expect(d.usage.freshInput).toBe(190);
  });

  it("floors freshInput at 0 when cacheRead exceeds input", () => {
    const calls: ModelCallEvent[] = [
      mkCall({ id: "1", input: 10, cacheRead: 50 }),
    ];
    const d = buildRunDiagnostics(baseInput({ modelCalls: calls }));
    expect(d.usage.freshInput).toBe(0);
  });
});

describe("byModel / byLane grouping", () => {
  const calls: ModelCallEvent[] = [
    mkCall({ id: "1", modelId: "gpt-a", source: "main", startedAt: 1000, durationMs: 200, input: 100, output: 50, cacheRead: 40, cacheWrite: 10, lane: "lane1" }),
    mkCall({ id: "2", modelId: "gpt-a", source: "subagent", startedAt: 1300, durationMs: 300, input: 200, output: 80, cacheRead: 150, cacheWrite: 0, lane: "lane1" }),
    mkCall({ id: "3", modelId: "gpt-b", source: "main", startedAt: 1700, durationMs: 100, state: "error", errorCategory: "provider-rate-limit", input: 50, output: 0, cacheRead: 0, cacheWrite: 5, lane: "lane2" }),
    mkCall({ id: "4", modelId: "gpt-b", source: "compaction", startedAt: 2000, durationMs: 150, state: "error", input: 30, output: 0, cacheRead: 0, cacheWrite: 0 }),
  ];
  const d = buildRunDiagnostics(baseInput({ modelCalls: calls }));

  it("groups by model", () => {
    const gptA = d.usage.byModel.find((m) => m.modelId === "gpt-a");
    const gptB = d.usage.byModel.find((m) => m.modelId === "gpt-b");
    expect(gptA).toEqual({
      modelId: "gpt-a",
      calls: 2,
      errors: 0,
      input: 300,
      output: 130,
      cacheRead: 190,
      cacheWrite: 10,
      freshInput: 110,
      totalMs: 500,
    });
    expect(gptB).toEqual({
      modelId: "gpt-b",
      calls: 2,
      errors: 2,
      input: 80,
      output: 0,
      cacheRead: 0,
      cacheWrite: 5,
      freshInput: 80,
      totalMs: 250,
    });
  });

  it("groups by lane, defaulting missing lane to 'unspecified'", () => {
    const lane1 = d.usage.byLane.find((l) => l.lane === "lane1");
    const lane2 = d.usage.byLane.find((l) => l.lane === "lane2");
    const unspecified = d.usage.byLane.find((l) => l.lane === "unspecified");
    expect(lane1?.calls).toBe(2);
    expect(lane1?.totalMs).toBe(500);
    expect(lane2?.calls).toBe(1);
    expect(lane2?.errors).toBe(1);
    expect(unspecified?.calls).toBe(1);
    expect(unspecified?.totalMs).toBe(150);
  });

  it("groups by phase (call.source)", () => {
    const main = d.usage.byPhase.find((p) => p.phase === "main");
    const subagent = d.usage.byPhase.find((p) => p.phase === "subagent");
    const compaction = d.usage.byPhase.find((p) => p.phase === "compaction");
    expect(main?.calls).toBe(2);
    expect(subagent?.calls).toBe(1);
    expect(compaction?.calls).toBe(1);
  });
});

describe("errors and retries", () => {
  it("groups error calls by category (defaulting to 'unknown') and sums actor retries", () => {
    const calls: ModelCallEvent[] = [
      mkCall({ id: "1", state: "error", errorCategory: "provider-rate-limit" }),
      mkCall({ id: "2", state: "error", errorCategory: "provider-rate-limit" }),
      mkCall({ id: "3", state: "error" }),
      mkCall({ id: "4", state: "ok" }),
    ];
    const actors: ActivityState[] = [
      mkActor({ actorId: "forge:main", kind: "forge", retryCount: 1 }),
      mkActor({ actorId: "w1", kind: "worker", retryCount: 2 }),
      mkActor({ actorId: "w2", kind: "worker" }),
    ];
    const d = buildRunDiagnostics(baseInput({ modelCalls: calls, actors }));

    expect(d.errors.total).toBe(3);
    expect(d.errors.byCategory).toEqual({ "provider-rate-limit": 2, unknown: 1 });
    expect(d.errors.retries).toBe(3);
  });
});

describe("timeline concurrency — three-worker hand-computed scenario", () => {
  // A: [0,1000)   B: [500,1500)   idle gap [1500,2000)   C: [2000,3000)
  //  [0,500)=1  [500,1000)=2  [1000,1500)=1  [1500,2000)=0  [2000,3000)=1
  const actors: ActivityState[] = [
    mkActor({ actorId: "w-a", kind: "worker", startedAt: 0, endedAt: 1000 }),
    mkActor({ actorId: "w-b", kind: "worker", startedAt: 500, endedAt: 1500 }),
    mkActor({ actorId: "w-c", kind: "worker", startedAt: 2000, endedAt: 3000 }),
  ];
  const d = buildRunDiagnostics(baseInput({ actors, generatedAt: 5000 }));

  it("computes peak concurrency", () => {
    expect(d.timeline.peakConcurrency).toBe(2);
  });

  it("computes time-weighted average concurrency over the active span", () => {
    // areaSum = 1*500 + 2*500 + 1*500 + 1*1000 = 3000; activeMs = 2500 -> avg 1.2
    expect(d.timeline.avgConcurrency).toBeCloseTo(1.2, 10);
  });

  it("computes overlap time (>=2 concurrent workers)", () => {
    expect(d.timeline.overlapMs).toBe(500);
  });

  it("computes idle gaps strictly inside the worker span", () => {
    expect(d.timeline.idleGapsMs).toBe(500);
  });
});

describe("queuedWhileCapacityMs", () => {
  it("is 0 when running workers already fill capacity", () => {
    const actors: ActivityState[] = [
      mkActor({ actorId: "w-a", kind: "worker", queuedAt: 0, startedAt: 0, endedAt: 1000 }),
      mkActor({ actorId: "w-b", kind: "worker", queuedAt: 0, startedAt: 0, endedAt: 1000 }),
      // queued for the whole [0,1000) window while 2 workers already run at maxConcurrency=2
      mkActor({ actorId: "w-c", kind: "worker", queuedAt: 0, startedAt: 1000, endedAt: 1500 }),
    ];
    const d = buildRunDiagnostics(baseInput({ actors, maxConcurrency: 2, generatedAt: 5000 }));
    expect(d.timeline.queuedWhileCapacityMs).toBe(0);
  });

  it("accrues the full queued window when capacity is free", () => {
    const actors: ActivityState[] = [
      mkActor({ actorId: "w-a", kind: "worker", startedAt: 0, endedAt: 1000 }),
      // queued for the whole [0,1000) window while only 1 worker runs at maxConcurrency=3
      mkActor({ actorId: "w-d", kind: "worker", queuedAt: 0, startedAt: 1000, endedAt: 1500 }),
    ];
    const d = buildRunDiagnostics(baseInput({ actors, maxConcurrency: 3, generatedAt: 5000 }));
    expect(d.timeline.queuedWhileCapacityMs).toBe(1000);
  });
});

describe("final state derivation", () => {
  it("is 'running' when a forge actor has no endedAt", () => {
    const actors: ActivityState[] = [
      mkActor({ actorId: "forge:main", kind: "forge", phase: "streaming", startedAt: 0 }),
    ];
    const d = buildRunDiagnostics(baseInput({ actors }));
    expect(d.final.state).toBe("running");
  });

  it("is 'failed' with failedActors when a forge actor ended failed", () => {
    const actors: ActivityState[] = [
      mkActor({ actorId: "forge:main", kind: "forge", phase: "failed", startedAt: 0, endedAt: 100 }),
      // A failed worker must not leak into failedActors — only forge actors count.
      mkActor({ actorId: "w1", kind: "worker", phase: "failed", startedAt: 0, endedAt: 100 }),
    ];
    const d = buildRunDiagnostics(baseInput({ actors }));
    expect(d.final.state).toBe("failed");
    expect(d.final.failedActors).toEqual(["forge:main"]);
  });

  it("is 'cancelled' when a forge actor ended cancelled and none failed", () => {
    const actors: ActivityState[] = [
      mkActor({ actorId: "forge:main", kind: "forge", phase: "cancelled", startedAt: 0, endedAt: 100 }),
    ];
    const d = buildRunDiagnostics(baseInput({ actors }));
    expect(d.final.state).toBe("cancelled");
  });

  it("is 'done' when all forge actors ended done", () => {
    const actors: ActivityState[] = [
      mkActor({ actorId: "forge:main", kind: "forge", phase: "done", startedAt: 0, endedAt: 100 }),
    ];
    const d = buildRunDiagnostics(baseInput({ actors }));
    expect(d.final.state).toBe("done");
    expect(d.final.failedActors).toEqual([]);
  });
});

describe("Markdown formatting", () => {
  it("includes all populated sections and omits empty ones", () => {
    const calls: ModelCallEvent[] = [
      mkCall({ id: "1", modelId: "gpt-a", startedAt: 0, durationMs: 500, input: 100, output: 50 }),
      mkCall({ id: "2", modelId: "gpt-a", startedAt: 600, durationMs: 100, state: "error", errorCategory: "timeout" }),
    ];
    const actors: ActivityState[] = [
      mkActor({ actorId: "forge:main", kind: "forge", name: "Forge", phase: "done", startedAt: 0, endedAt: 1000 }),
      mkActor({ actorId: "w1", kind: "worker", name: "w1 (code)", phase: "done", startedAt: 100, endedAt: 900 }),
    ];
    const feed: ActivityEntry[] = [
      { at: 50, actorId: "forge:main", name: "Forge", phase: "blocked-user", label: "Approve plan?" },
      { at: 200, actorId: "w1", name: "w1 (code)", phase: "tool", label: "Reading a.ts" },
    ];
    const d = buildRunDiagnostics(
      baseInput({
        source: { commit: "abc123", branch: "main", dirty: false, candidateId: "c1" },
        modelCalls: calls,
        actors,
        feed,
        evidence: [{ kind: "test", ok: true, candidateId: "c1", at: 900, summary: "all green" }],
        generatedAt: 1000,
      }),
    );

    const md = formatRunDiagnosticsMarkdown(d);
    expect(md).toContain("## Run");
    expect(md).toContain("## Source");
    expect(md).toContain("## Dispatches");
    expect(md).toContain("## Usage");
    expect(md).toContain("## Errors & Retries");
    expect(md).toContain("## Timeline");
    expect(md).toContain("## User Gates");
    expect(md).toContain("## Evidence");
    expect(md).toContain("## Final");
    expect(md).toContain("abc123");
    expect(md).toContain("all green");
  });

  it("omits empty sections but always includes Run and Final", () => {
    const d = buildRunDiagnostics(baseInput());
    const md = formatRunDiagnosticsMarkdown(d);
    expect(md).toContain("## Run");
    expect(md).toContain("## Final");
    expect(md).not.toContain("## Source");
    expect(md).not.toContain("## Dispatches");
    expect(md).not.toContain("## Usage");
    expect(md).not.toContain("## Errors & Retries");
    expect(md).not.toContain("## Timeline");
    expect(md).not.toContain("## User Gates");
    expect(md).not.toContain("## Evidence");
  });
});

describe("JSON round-trip", () => {
  it("survives JSON.parse(JSON.stringify(d)) with deep equality", () => {
    const calls: ModelCallEvent[] = [
      mkCall({ id: "1", modelId: "gpt-a", startedAt: 0, durationMs: 500, input: 100, output: 50, lane: "lane1" }),
      mkCall({ id: "2", modelId: "gpt-b", startedAt: 600, durationMs: 100, state: "error", errorCategory: "timeout" }),
    ];
    const actors: ActivityState[] = [
      mkActor({ actorId: "forge:main", kind: "forge", phase: "done", startedAt: 0, endedAt: 1000, retryCount: 1 }),
      mkActor({ actorId: "w1", kind: "worker", phase: "done", startedAt: 100, endedAt: 900, queuedAt: 50 }),
    ];
    const feed: ActivityEntry[] = [
      { at: 50, actorId: "forge:main", name: "Forge", phase: "blocked-user", label: "Approve plan?" },
      { at: 200, actorId: "w1", name: "w1", phase: "tool", label: "Reading a.ts" },
      { at: 900, actorId: "w1", name: "w1", phase: "done", label: "Completed" },
    ];
    const d = buildRunDiagnostics(
      baseInput({
        source: { commit: "abc", branch: "main", dirty: true, candidateId: "c1" },
        modelCalls: calls,
        actors,
        feed,
        evidence: [{ kind: "test", ok: false, candidateId: "c1", at: 900 }],
        generatedAt: 1000,
        maxConcurrency: 2,
      }),
    );

    const roundTripped = JSON.parse(JSON.stringify(d)) as unknown;
    expect(roundTripped).toEqual(d);
  });
});

describe("still-queued workers (integration review fix)", () => {
  it("counts a worker still queued at export as queued, not running", () => {
    const d = buildRunDiagnostics(
      baseInput({
        generatedAt: 10_000,
        maxConcurrency: 3,
        actors: [
          mkActor({ actorId: "w1", startedAt: 0, endedAt: 10_000 }),
          mkActor({ actorId: "w2", phase: "queued", startedAt: 4_000 }),
        ],
      }),
    );
    expect(d.timeline.peakConcurrency).toBe(1);
    expect(d.timeline.overlapMs).toBe(0);
    // Queued 4s→10s while only 1 of 3 slots was busy.
    expect(d.timeline.queuedWhileCapacityMs).toBe(6_000);
  });
});
