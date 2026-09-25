/**
 * Harness-generated activity (private rebuild CP5): token-free status for the
 * Forge and workers, explicit wait states, retry/failure attribution.
 */
import { describe, expect, test } from "bun:test";
import {
  ActivityTracker,
  describeActivity,
  formatDuration,
  toolActivityLabel,
} from "../src/core/activity/activity.js";
import { classifyFailure, failureLabel } from "../src/core/activity/failure.js";
import {
  multiAgentEventToActivity,
  subagentStepToActivity,
  workerActorId,
} from "../src/core/activity/worker-bridge.js";

function clockAt(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function forge(t = clockAt()) {
  const tr = new ActivityTracker(50, t.now);
  tr.apply({ type: "start", actorId: "f", kind: "forge", name: "Forge" });
  return { tr, t };
}

describe("tracker phases", () => {
  test("worker dispatch: queued → running → tool → waiting on provider → done", () => {
    const t = clockAt();
    const tr = new ActivityTracker(50, t.now);
    tr.apply({ type: "start", actorId: "w", kind: "worker", name: "c1", phase: "queued" });
    expect(tr.get("w")?.phase).toBe("queued");
    t.advance(2000);
    tr.apply({ type: "start", actorId: "w", kind: "worker", name: "c1", lane: "ember", effort: "high" });
    expect(tr.get("w")?.queuedAt).toBe(1_000_000);
    tr.apply({ type: "tool-start", actorId: "w", tool: "read", args: "src/a.ts" });
    expect(tr.get("w")?.label).toBe("Reading src/a.ts");
    tr.apply({ type: "tool-end", actorId: "w", tool: "read", ok: true });
    expect(tr.get("w")?.phase).toBe("requesting");
    tr.apply({ type: "end", actorId: "w", outcome: "done" });
    expect(tr.get("w")?.phase).toBe("done");
  });

  test("a finished tool never leaves a stale 'running tool' label", () => {
    const { tr, t } = forge();
    tr.apply({ type: "tool-start", actorId: "f", tool: "shell", args: { command: "bun test" } });
    expect(describeActivity(tr.get("f")!, t.now())).toContain("Running tests");
    tr.apply({ type: "tool-end", actorId: "f", tool: "shell", ok: true });
    t.advance(4 * 60_000 + 12_000);
    expect(describeActivity(tr.get("f")!, t.now())).toBe(
      "Waiting on provider — no activity for 4m 12s",
    );
  });

  test("streaming is distinguished from waiting; unresponsive threshold optional", () => {
    const { tr, t } = forge();
    tr.apply({ type: "chunk", actorId: "f", kind: "reasoning" });
    expect(describeActivity(tr.get("f")!, t.now())).toBe("Reasoning…");
    tr.apply({ type: "chunk", actorId: "f", kind: "text" });
    expect(describeActivity(tr.get("f")!, t.now())).toBe("Writing…");
    t.advance(20_000);
    expect(describeActivity(tr.get("f")!, t.now())).toContain("Waiting on provider");
    t.advance(200_000);
    expect(describeActivity(tr.get("f")!, t.now(), { unresponsiveMs: 180_000 })).toContain(
      "Provider unresponsive",
    );
  });

  test("worker wait is distinct from provider wait", () => {
    const { tr, t } = forge();
    tr.apply({ type: "tool-start", actorId: "f", tool: "dispatch" });
    tr.apply({ type: "workers", actorId: "f", active: 2 });
    t.advance(65_000);
    expect(describeActivity(tr.get("f")!, t.now())).toBe("Waiting on 2 workers — 1m 5s");
  });

  test("blocked on user, then back to the previous phase", () => {
    const { tr, t } = forge();
    tr.apply({ type: "tool-start", actorId: "f", tool: "dispatch" });
    tr.apply({ type: "blocked", actorId: "f", label: "Waiting for your approval" });
    t.advance(3000);
    expect(describeActivity(tr.get("f")!, t.now())).toBe("Waiting for your approval — 3s");
    tr.apply({ type: "unblocked", actorId: "f" });
    expect(tr.get("f")?.phase).toBe("waiting-worker");
  });

  test("unblocked without a block is a no-op", () => {
    const { tr } = forge();
    tr.apply({ type: "chunk", actorId: "f", kind: "text" });
    tr.apply({ type: "unblocked", actorId: "f" });
    expect(tr.get("f")?.phase).toBe("streaming");
  });

  test("retry shows attributed reason and count", () => {
    const { tr, t } = forge();
    tr.apply({ type: "retry", actorId: "f", error: new Error("429 Too Many Requests") });
    const s = tr.get("f")!;
    expect(s.failure).toBe("provider-rate-limit");
    expect(describeActivity(s, t.now())).toBe("Retrying (#1) — provider rate limit");
    tr.apply({ type: "retry", actorId: "f", stall: true });
    expect(describeActivity(tr.get("f")!, t.now())).toBe(
      "Retrying (#2) — provider stalled (watchdog)",
    );
  });

  test("terminal states: done / failed (attributed) / cancelled, then frozen", () => {
    const { tr, t } = forge();
    t.advance(90_000);
    tr.apply({ type: "end", actorId: "f", outcome: "failed", error: new Error("prompt is too long") });
    const s = tr.get("f")!;
    expect(s.failure).toBe("context-limit");
    expect(describeActivity(s, t.now())).toContain("Failed — context limit");
    tr.apply({ type: "chunk", actorId: "f", kind: "text" });
    expect(tr.get("f")?.phase).toBe("failed");
  });

  test("feed records meaningful transitions only, bounded", () => {
    const t = clockAt();
    const tr = new ActivityTracker(5, t.now);
    tr.apply({ type: "start", actorId: "f", kind: "forge", name: "Forge" });
    for (let i = 0; i < 20; i++) {
      tr.apply({ type: "chunk", actorId: "f", kind: "text" });
      tr.apply({ type: "tool-start", actorId: "f", tool: "read", args: "x.ts" });
      tr.apply({ type: "tool-end", actorId: "f", tool: "read", ok: true });
    }
    // Reads/chunks are quiet: only the start entry is logged.
    expect(tr.getFeed().map((e) => e.phase)).toEqual(["requesting"]);
    for (let i = 0; i < 10; i++) {
      tr.apply({ type: "tool-start", actorId: "f", tool: "edit_file", args: { path: `f${i}.ts` } });
    }
    expect(tr.getFeed().length).toBe(5);
    expect(tr.getFeed().at(-1)?.label).toBe("Editing f9.ts");
  });
});

describe("labels", () => {
  test("tool labels are human and token-free", () => {
    expect(toolActivityLabel("grep", "/effort/")).toBe("Searching /effort/");
    expect(toolActivityLabel("edit_file", { path: "src/a.ts" })).toBe("Editing src/a.ts");
    expect(toolActivityLabel("project", { action: "typecheck" })).toBe("Typechecking");
    expect(toolActivityLabel("shell", { command: "bun run build" })).toBe("Building: bun run build");
    expect(toolActivityLabel("dispatch")).toBe("Dispatching workers");
    expect(toolActivityLabel("mystery_tool")).toBe("Running mystery_tool");
  });

  test("durations", () => {
    expect(formatDuration(8_000)).toBe("8s");
    expect(formatDuration(494_000)).toBe("8m 14s");
    expect(formatDuration(3_720_000)).toBe("1h 2m");
  });
});

describe("failure attribution", () => {
  const cases: Array<[unknown, string]> = [
    [new Error("Overloaded"), "provider-overloaded"],
    [Object.assign(new Error("x"), { statusCode: 529 }), "provider-overloaded"],
    [new Error("rate limit exceeded"), "provider-rate-limit"],
    [Object.assign(new Error("Unauthorized"), { statusCode: 401 }), "provider-auth"],
    [new Error("socket hang up"), "provider-stream-closed"],
    [new Error("fetch failed"), "network"],
    [new Error("request timed out"), "timeout"],
    [new Error("maximum context length is 200000 tokens"), "context-limit"],
    [Object.assign(new Error("Bad request"), { statusCode: 400 }), "provider-http"],
    [Object.assign(new Error("x"), { name: "StrictRoutingError" }), "strict-routing"],
    [Object.assign(new Error("x"), { name: "AbortError" }), "cancelled"],
    [new TypeError("undefined is not a function"), "harness"],
    [new Error("something odd"), "unknown"],
  ];
  for (const [err, cat] of cases) {
    test(`${String((err as Error).message)} → ${cat}`, () => {
      expect(classifyFailure(err)).toBe(cat);
    });
  }
  test("cause chain is inspected; hints win", () => {
    const wrapped = new Error("Retry failed", { cause: new Error("ECONNRESET") });
    expect(classifyFailure(wrapped)).toBe("network");
    expect(classifyFailure(new Error("x"), { stall: true })).toBe("stall-watchdog");
    expect(failureLabel("stall-watchdog")).toBe("provider stalled (watchdog)");
  });
});

describe("worker bridge", () => {
  test("maps dispatch events to worker activity", () => {
    const start = multiAgentEventToActivity({
      parentToolCallId: "tc",
      type: "agent-start",
      agentId: "c1",
      role: "code",
      lane: "ember",
      effort: "high",
      modelId: "gpt-5",
    });
    expect(start).toMatchObject({
      type: "start",
      actorId: workerActorId("tc", "c1"),
      name: "c1 (code)",
      lane: "ember",
      effort: "high",
    });
    expect(
      multiAgentEventToActivity({ parentToolCallId: "tc", type: "agent-error", agentId: "c1", error: "boom" }),
    ).toMatchObject({ type: "end", outcome: "failed" });
    expect(multiAgentEventToActivity({ parentToolCallId: "tc", type: "dispatch-start" })).toBeNull();
  });

  test("maps steps; ignores cache bookkeeping", () => {
    expect(
      subagentStepToActivity({ parentToolCallId: "tc", agentId: "c1", toolName: "read", args: "a.ts", state: "running" }),
    ).toMatchObject({ type: "tool-start", tool: "read" });
    expect(
      subagentStepToActivity({ parentToolCallId: "tc", agentId: "c1", toolName: "read", state: "error" }),
    ).toMatchObject({ type: "tool-end", ok: false });
    expect(
      subagentStepToActivity({ parentToolCallId: "tc", agentId: "c1", toolName: "read", state: "done", cacheState: "hit" }),
    ).toBeNull();
  });
});
