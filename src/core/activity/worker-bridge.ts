/**
 * Bridge existing dispatch events (subagent-events) into worker activity.
 * No agent code changes are needed for routine activity — the bus events
 * the UI already consumed are translated here into ActivityInput.
 */

import {
  type MultiAgentEvent,
  onAgentStats,
  onMultiAgentEvent,
  onSubagentStep,
  type SubagentStep,
} from "../agents/subagent-events.js";
import { type ActivityInput, reportActivity } from "./activity.js";

export function workerActorId(parentToolCallId: string, agentId: string): string {
  return `worker:${parentToolCallId}:${agentId}`;
}

/** Pure mapping — exported for tests. */
export function multiAgentEventToActivity(evt: MultiAgentEvent): ActivityInput | null {
  if (!evt.agentId) return null;
  const actorId = workerActorId(evt.parentToolCallId, evt.agentId);
  switch (evt.type) {
    case "agent-start":
      return {
        type: "start",
        actorId,
        kind: "worker",
        name: evt.role ? `${evt.agentId} (${evt.role})` : evt.agentId,
        lane: evt.lane,
        modelId: evt.modelId,
        effort: evt.effort,
      };
    case "agent-done":
      return { type: "end", actorId, outcome: "done" };
    case "agent-error":
      return { type: "end", actorId, outcome: "failed", error: evt.error };
    case "agent-retry":
      return { type: "retry", actorId, reason: evt.warning ?? "retrying" };
    default:
      return null;
  }
}

export function subagentStepToActivity(step: SubagentStep): ActivityInput | null {
  if (!step.agentId) return null;
  // Cache hits/waits are bus bookkeeping, not agent work.
  if (step.cacheState) return null;
  const actorId = workerActorId(step.parentToolCallId, step.agentId);
  if (step.state === "running") {
    return { type: "tool-start", actorId, tool: step.toolName, args: step.args };
  }
  return { type: "tool-end", actorId, tool: step.toolName, ok: step.state === "done" };
}

let installed = false;

/** Idempotent. Called when dispatch tools are built. */
export function installWorkerActivityBridge(): void {
  if (installed) return;
  installed = true;
  onMultiAgentEvent((evt) => {
    const input = multiAgentEventToActivity(evt);
    if (input) reportActivity(input);
  });
  onSubagentStep((step) => {
    const input = subagentStepToActivity(step);
    if (input) reportActivity(input);
  });
  // A finished step means the worker is composing its next request.
  onAgentStats((evt) => {
    reportActivity({ type: "request", actorId: workerActorId(evt.parentToolCallId, evt.agentId) });
  });
}

/** Mark dispatched tasks as queued until their agent-start arrives. */
export function reportWorkersQueued(
  parentToolCallId: string,
  tasks: ReadonlyArray<{ agentId: string; role?: string }>,
): void {
  for (const t of tasks) {
    reportActivity({
      type: "start",
      actorId: workerActorId(parentToolCallId, t.agentId),
      kind: "worker",
      name: t.role ? `${t.agentId} (${t.role})` : t.agentId,
      phase: "queued",
    });
  }
}
