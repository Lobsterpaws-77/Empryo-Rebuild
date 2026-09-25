/**
 * Collect run diagnostics from the live harness (activity tracker, model
 * events, evidence ledger, source identity) and write Markdown + JSON to
 * `<cwd>/.soulforge/diagnostics/`. Used by `/diagnostics` and headless
 * `--diagnostics`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useModelEventsStore } from "../../stores/model-events.js";
import { getActivityTracker } from "../activity/activity.js";
import { getMaxConcurrentAgents } from "../agents/agent-runner.js";
import { readEvidence } from "../provenance/evidence.js";
import { getSourceIdentity } from "../provenance/source.js";
import {
  buildRunDiagnostics,
  formatRunDiagnosticsMarkdown,
  type RunDiagnostics,
} from "./run-diagnostics.js";

export interface DiagnosticsExport {
  diagnostics: RunDiagnostics;
  markdownPath: string;
  jsonPath: string;
  /** False when per-call model events were not being recorded (usage tables empty). */
  modelEventsEnabled: boolean;
}

export async function exportRunDiagnostics(
  cwd: string,
  runId?: string,
): Promise<DiagnosticsExport> {
  const now = Date.now();
  const tracker = getActivityTracker();
  const events = useModelEventsStore.getState();
  const identity = await getSourceIdentity(cwd).catch(() => null);
  const diagnostics = buildRunDiagnostics({
    runId: runId ?? `run-${new Date(now).toISOString()}`,
    generatedAt: now,
    source: identity?.isGit
      ? {
          commit: identity.commit,
          branch: identity.branch,
          dirty: identity.dirty,
          candidateId: identity.candidateId,
        }
      : null,
    modelCalls: events.events,
    actors: tracker.all(),
    feed: tracker.getFeed(),
    evidence: readEvidence(cwd).slice(-50),
    maxConcurrency: getMaxConcurrentAgents(),
  });

  const dir = join(cwd, ".soulforge", "diagnostics");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const markdownPath = join(dir, `run-${stamp}.md`);
  const jsonPath = join(dir, `run-${stamp}.json`);
  let md = formatRunDiagnosticsMarkdown(diagnostics);
  if (!events.enabled) {
    md +=
      "\n\n> Per-call usage was not recorded — enable `/model-events` before a run to include tokens, cache and per-model/lane timings.\n";
  }
  writeFileSync(markdownPath, md);
  writeFileSync(jsonPath, `${JSON.stringify(diagnostics, null, 2)}\n`);
  return { diagnostics, markdownPath, jsonPath, modelEventsEnabled: events.enabled };
}

export function summarizeExport(e: DiagnosticsExport): string {
  const d = e.diagnostics;
  return [
    `Diagnostics written:\n  ${e.markdownPath}\n  ${e.jsonPath}`,
    `Final: ${d.final.state} · actors ${String(d.dispatches.length)} · calls ${String(d.usage.calls)} · errors ${String(d.errors.total)} · retries ${String(d.errors.retries)} · peak concurrency ${String(d.timeline.peakConcurrency)}`,
    e.modelEventsEnabled
      ? ""
      : "(per-call usage not recorded — enable /model-events for token/timing tables)",
  ]
    .filter(Boolean)
    .join("\n");
}
