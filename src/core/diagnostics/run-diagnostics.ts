/**
 * Run diagnostics — a compact, exportable, JSON-serialisable report built
 * from data the harness already records: per-call model events and the
 * activity tracker's actor states / chronological feed.
 *
 * Pure: no I/O, no wall-clock reads, no store subscriptions. Callers collect
 * `RunDiagnosticsInput` from `useModelEventsStore` / `getActivityTracker()`
 * (or from a saved session) and hand it to `buildRunDiagnostics`. Wiring
 * this into a command or the UI is deliberately out of scope here.
 *
 * Input shapes are the real `ModelCallEvent` (stores/model-events) and
 * `ActivityState` / `ActivityEntry` (core/activity) types — type-only
 * imports, so this module stays pure.
 */

// ── Input shapes (the real harness types) ────────────────────────────────

import type { ModelCallEvent, ModelCallSource, ModelCallState } from "../../stores/model-events.js";
import type {
  ActivityEntry,
  ActivityPhase,
  ActivityState,
  ActorKind,
} from "../activity/activity.js";

export type {
  ActivityEntry,
  ActivityPhase,
  ActivityState,
  ActorKind,
  ModelCallEvent,
  ModelCallSource,
  ModelCallState,
};

export interface RunDiagnosticsSource {
  commit: string | null;
  branch: string | null;
  dirty: boolean;
  candidateId: string;
}

export interface RunDiagnosticsEvidenceInput {
  kind: string;
  ok: boolean;
  candidateId: string;
  at: number;
  summary?: string;
}

export interface RunDiagnosticsInput {
  runId: string;
  generatedAt: number;
  source?: RunDiagnosticsSource | null;
  modelCalls: readonly ModelCallEvent[];
  actors: readonly ActivityState[];
  feed: readonly ActivityEntry[];
  evidence?: readonly RunDiagnosticsEvidenceInput[];
  maxConcurrency?: number;
}

// ── Output shapes ────────────────────────────────────────────────────────

export interface RunDiagnosticsRun {
  runId: string;
  generatedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
}

export interface DispatchRow {
  actorId: string;
  name: string;
  kind: ActorKind;
  lane: string | null;
  model: string | null;
  effort: string | null;
  queuedMs: number | null;
  runMs: number;
  finalPhase: ActivityPhase;
  retries: number;
  failure: string | null;
}

export interface UsageTotals {
  calls: number;
  errors: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  freshInput: number;
}

export interface UsageByModel extends UsageTotals {
  modelId: string;
  totalMs: number;
}

export interface UsageByLane extends UsageTotals {
  lane: string;
  totalMs: number;
}

export interface UsageByPhase extends UsageTotals {
  phase: string;
  totalMs: number;
}

export interface UsageSummary extends UsageTotals {
  byModel: UsageByModel[];
  byLane: UsageByLane[];
  byPhase: UsageByPhase[];
}

export interface ErrorSummary {
  total: number;
  byCategory: Record<string, number>;
  retries: number;
}

export interface TimelineSummary {
  peakConcurrency: number;
  avgConcurrency: number;
  overlapMs: number;
  idleGapsMs: number;
  queuedWhileCapacityMs: number;
}

export interface GateEntry {
  at: number;
  name: string;
  label: string;
}

export interface ActivityFeedEntry {
  at: number;
  actorId: string;
  name: string;
  phase: ActivityPhase;
  label: string;
}

export interface EvidenceRow {
  kind: string;
  ok: boolean;
  candidateId: string;
  at: number;
  summary: string | null;
}

export type RunFinalState = "done" | "failed" | "cancelled" | "running";

export interface FinalSummary {
  state: RunFinalState;
  failedActors: string[];
}

export interface RunDiagnostics {
  run: RunDiagnosticsRun;
  source: RunDiagnosticsSource | null;
  dispatches: DispatchRow[];
  usage: UsageSummary;
  errors: ErrorSummary;
  timeline: TimelineSummary;
  gates: GateEntry[];
  activity: ActivityFeedEntry[];
  evidence: EvidenceRow[];
  final: FinalSummary;
}

const DEFAULT_MAX_CONCURRENCY = 3;
const MAX_ACTIVITY_ENTRIES = 200;
const ACTIVITY_FEED_PHASES = new Set<ActivityPhase>(["tool", "retrying", "failed", "done"]);

// ── Run window ───────────────────────────────────────────────────────────

function computeRunWindow(input: RunDiagnosticsInput): RunDiagnosticsRun {
  const starts: number[] = [];
  const ends: number[] = [];
  let anyRunning = false;

  for (const actor of input.actors) {
    starts.push(actor.startedAt);
    if (actor.endedAt != null) {
      ends.push(actor.endedAt);
    } else {
      anyRunning = true;
    }
  }
  for (const call of input.modelCalls) {
    starts.push(call.startedAt);
    ends.push(call.startedAt + call.durationMs);
  }

  if (starts.length === 0) {
    return {
      runId: input.runId,
      generatedAt: input.generatedAt,
      startedAt: null,
      endedAt: null,
      durationMs: null,
    };
  }

  const startedAt = Math.min(...starts);
  if (anyRunning || ends.length === 0) {
    return {
      runId: input.runId,
      generatedAt: input.generatedAt,
      startedAt,
      endedAt: null,
      durationMs: Math.max(0, input.generatedAt - startedAt),
    };
  }

  const endedAt = Math.max(...ends);
  return {
    runId: input.runId,
    generatedAt: input.generatedAt,
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
  };
}

// ── Dispatches ───────────────────────────────────────────────────────────

function computeDispatches(input: RunDiagnosticsInput): DispatchRow[] {
  const rows = input.actors.map((actor): DispatchRow => {
    const end = actor.endedAt ?? input.generatedAt;
    return {
      actorId: actor.actorId,
      name: actor.name,
      kind: actor.kind,
      lane: actor.lane ?? null,
      model: actor.modelId ?? null,
      effort: actor.effort ?? null,
      queuedMs: actor.queuedAt != null ? Math.max(0, actor.startedAt - actor.queuedAt) : null,
      runMs: Math.max(0, end - actor.startedAt),
      finalPhase: actor.phase,
      retries: actor.retryCount ?? 0,
      failure: actor.failure ?? null,
    };
  });
  rows.sort((a, b) => {
    const aStart = input.actors.find((x) => x.actorId === a.actorId)?.startedAt ?? 0;
    const bStart = input.actors.find((x) => x.actorId === b.actorId)?.startedAt ?? 0;
    return aStart - bStart || a.actorId.localeCompare(b.actorId);
  });
  return rows;
}

// ── Usage ────────────────────────────────────────────────────────────────

function emptyTotals(): UsageTotals {
  return { calls: 0, errors: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, freshInput: 0 };
}

function addCall(totals: UsageTotals, call: ModelCallEvent): void {
  totals.calls += 1;
  if (call.state === "error") totals.errors += 1;
  totals.input += call.input ?? 0;
  totals.output += call.output ?? 0;
  totals.cacheRead += call.cacheRead ?? 0;
  totals.cacheWrite += call.cacheWrite ?? 0;
}

function finalizeFreshInput(totals: UsageTotals): void {
  totals.freshInput = Math.max(0, totals.input - totals.cacheRead);
}

function computeUsage(input: RunDiagnosticsInput): UsageSummary {
  const totals = emptyTotals();
  const byModel = new Map<string, UsageByModel>();
  const byLane = new Map<string, UsageByLane>();
  const byPhase = new Map<string, UsageByPhase>();

  for (const call of input.modelCalls) {
    addCall(totals, call);

    const modelKey = call.modelId;
    const modelAgg =
      byModel.get(modelKey) ??
      ({ ...emptyTotals(), modelId: modelKey, totalMs: 0 } as UsageByModel);
    addCall(modelAgg, call);
    modelAgg.totalMs += call.durationMs;
    byModel.set(modelKey, modelAgg);

    const laneKey = call.lane ?? "unspecified";
    const laneAgg =
      byLane.get(laneKey) ?? ({ ...emptyTotals(), lane: laneKey, totalMs: 0 } as UsageByLane);
    addCall(laneAgg, call);
    laneAgg.totalMs += call.durationMs;
    byLane.set(laneKey, laneAgg);

    const phaseKey = call.source;
    const phaseAgg =
      byPhase.get(phaseKey) ?? ({ ...emptyTotals(), phase: phaseKey, totalMs: 0 } as UsageByPhase);
    addCall(phaseAgg, call);
    phaseAgg.totalMs += call.durationMs;
    byPhase.set(phaseKey, phaseAgg);
  }

  finalizeFreshInput(totals);
  for (const agg of byModel.values()) finalizeFreshInput(agg);
  for (const agg of byLane.values()) finalizeFreshInput(agg);
  for (const agg of byPhase.values()) finalizeFreshInput(agg);

  const sortByMs = <T extends { totalMs: number }>(list: T[], key: (t: T) => string): T[] =>
    list.sort((a, b) => b.totalMs - a.totalMs || key(a).localeCompare(key(b)));

  return {
    ...totals,
    byModel: sortByMs([...byModel.values()], (t) => t.modelId),
    byLane: sortByMs([...byLane.values()], (t) => t.lane),
    byPhase: sortByMs([...byPhase.values()], (t) => t.phase),
  };
}

// ── Errors ───────────────────────────────────────────────────────────────

function computeErrors(input: RunDiagnosticsInput): ErrorSummary {
  const byCategory: Record<string, number> = {};
  let total = 0;
  for (const call of input.modelCalls) {
    if (call.state !== "error") continue;
    total += 1;
    const category = call.errorCategory ?? "unknown";
    byCategory[category] = (byCategory[category] ?? 0) + 1;
  }
  const retries = input.actors.reduce((sum, actor) => sum + (actor.retryCount ?? 0), 0);
  return { total, byCategory, retries };
}

// ── Timeline (worker concurrency) ───────────────────────────────────────

interface WorkerInterval {
  actorId: string;
  start: number;
  end: number;
  queuedAt: number | null;
}

function workerIntervals(input: RunDiagnosticsInput): WorkerInterval[] {
  const out: WorkerInterval[] = [];
  for (const actor of input.actors) {
    if (actor.kind !== "worker") continue;
    // Still waiting for a slot/dependency at export time: queued, not running.
    if (actor.phase === "queued" && actor.endedAt == null) {
      out.push({
        actorId: actor.actorId,
        start: input.generatedAt,
        end: input.generatedAt,
        queuedAt: actor.startedAt < input.generatedAt ? actor.startedAt : null,
      });
      continue;
    }
    const end = Math.max(actor.startedAt, actor.endedAt ?? input.generatedAt);
    out.push({
      actorId: actor.actorId,
      start: actor.startedAt,
      end,
      queuedAt: actor.queuedAt != null && actor.queuedAt < actor.startedAt ? actor.queuedAt : null,
    });
  }
  return out;
}

/** Sums deltas that share the same timestamp, then sorts ascending by time. */
function collapseEvents<E extends { t: number }>(events: E[], merge: (a: E, b: E) => E): E[] {
  const byTime = new Map<number, E>();
  for (const ev of events) {
    const prev = byTime.get(ev.t);
    byTime.set(ev.t, prev ? merge(prev, ev) : ev);
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

function computeConcurrency(intervals: WorkerInterval[]): {
  peakConcurrency: number;
  avgConcurrency: number;
  overlapMs: number;
  idleGapsMs: number;
} {
  if (intervals.length === 0) {
    return { peakConcurrency: 0, avgConcurrency: 0, overlapMs: 0, idleGapsMs: 0 };
  }

  type Ev = { t: number; delta: number };
  const raw: Ev[] = [];
  for (const iv of intervals) {
    raw.push({ t: iv.start, delta: 1 });
    raw.push({ t: iv.end, delta: -1 });
  }
  const events = collapseEvents(raw, (a, b) => ({ t: a.t, delta: a.delta + b.delta }));

  let count = 0;
  let peakConcurrency = 0;
  let areaSum = 0;
  let activeMs = 0;
  let overlapMs = 0;

  const spanStart = events[0]?.t ?? 0;
  const spanEnd = events[events.length - 1]?.t ?? 0;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev) continue;
    count += ev.delta;
    peakConcurrency = Math.max(peakConcurrency, count);
    const next = events[i + 1];
    const dt = next ? next.t - ev.t : 0;
    if (dt > 0) {
      if (count >= 1) {
        areaSum += count * dt;
        activeMs += dt;
      }
      if (count >= 2) overlapMs += dt;
    }
  }

  const totalSpan = Math.max(0, spanEnd - spanStart);
  const idleGapsMs = Math.max(0, totalSpan - activeMs);
  const avgConcurrency = activeMs > 0 ? areaSum / activeMs : 0;

  return { peakConcurrency, avgConcurrency, overlapMs, idleGapsMs };
}

function computeQueuedWhileCapacityMs(intervals: WorkerInterval[], maxConcurrency: number): number {
  type Ev = { t: number; dRun: number; dQueued: number };
  const raw: Ev[] = [];
  for (const iv of intervals) {
    raw.push({ t: iv.start, dRun: 1, dQueued: 0 });
    raw.push({ t: iv.end, dRun: -1, dQueued: 0 });
    if (iv.queuedAt != null) {
      raw.push({ t: iv.queuedAt, dRun: 0, dQueued: 1 });
      raw.push({ t: iv.start, dRun: 0, dQueued: -1 });
    }
  }
  if (raw.length === 0) return 0;

  const events = collapseEvents(raw, (a, b) => ({
    t: a.t,
    dRun: a.dRun + b.dRun,
    dQueued: a.dQueued + b.dQueued,
  }));

  let runningCount = 0;
  let queuedCount = 0;
  let queuedWhileCapacityMs = 0;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev) continue;
    runningCount += ev.dRun;
    queuedCount += ev.dQueued;
    const next = events[i + 1];
    const dt = next ? next.t - ev.t : 0;
    if (dt > 0 && queuedCount > 0 && runningCount < maxConcurrency) {
      queuedWhileCapacityMs += dt;
    }
  }

  return queuedWhileCapacityMs;
}

function computeTimeline(input: RunDiagnosticsInput): TimelineSummary {
  const intervals = workerIntervals(input);
  const maxConcurrency = input.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const { peakConcurrency, avgConcurrency, overlapMs, idleGapsMs } = computeConcurrency(intervals);
  const queuedWhileCapacityMs = computeQueuedWhileCapacityMs(intervals, maxConcurrency);
  return { peakConcurrency, avgConcurrency, overlapMs, idleGapsMs, queuedWhileCapacityMs };
}

// ── Gates / activity feed ───────────────────────────────────────────────

function computeGates(input: RunDiagnosticsInput): GateEntry[] {
  return input.feed
    .filter((e) => e.phase === "blocked-user")
    .map((e) => ({ at: e.at, name: e.name, label: e.label }));
}

function computeActivity(input: RunDiagnosticsInput): ActivityFeedEntry[] {
  const filtered = input.feed
    .filter((e) => ACTIVITY_FEED_PHASES.has(e.phase))
    .map((e) => ({ at: e.at, actorId: e.actorId, name: e.name, phase: e.phase, label: e.label }));
  return filtered.length > MAX_ACTIVITY_ENTRIES
    ? filtered.slice(filtered.length - MAX_ACTIVITY_ENTRIES)
    : filtered;
}

function computeEvidence(input: RunDiagnosticsInput): EvidenceRow[] {
  return (input.evidence ?? []).map((e) => ({
    kind: e.kind,
    ok: e.ok,
    candidateId: e.candidateId,
    at: e.at,
    summary: e.summary ?? null,
  }));
}

// ── Final state ──────────────────────────────────────────────────────────

function computeFinal(input: RunDiagnosticsInput): FinalSummary {
  const forgeActors = input.actors.filter((a) => a.kind === "forge");
  const failedActors = forgeActors.filter((a) => a.phase === "failed").map((a) => a.actorId);

  if (forgeActors.length === 0) return { state: "running", failedActors: [] };
  if (forgeActors.some((a) => a.endedAt == null)) return { state: "running", failedActors };
  if (failedActors.length > 0) return { state: "failed", failedActors };
  if (forgeActors.some((a) => a.phase === "cancelled")) return { state: "cancelled", failedActors };
  return { state: "done", failedActors };
}

// ── Public API ───────────────────────────────────────────────────────────

export function buildRunDiagnostics(input: RunDiagnosticsInput): RunDiagnostics {
  return {
    run: computeRunWindow(input),
    source: input.source ?? null,
    dispatches: computeDispatches(input),
    usage: computeUsage(input),
    errors: computeErrors(input),
    timeline: computeTimeline(input),
    gates: computeGates(input),
    activity: computeActivity(input),
    evidence: computeEvidence(input),
    final: computeFinal(input),
  };
}

// ── Markdown formatting ──────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m ${String(s % 60)}s`;
  const h = Math.floor(m / 60);
  return `${String(h)}h ${String(m % 60)}m`;
}

function fmtMs(ms: number | null): string {
  return ms == null ? "—" : formatDuration(ms);
}

function fmtTime(ms: number | null): string {
  return ms == null ? "—" : new Date(ms).toISOString();
}

function esc(s: string): string {
  return s.replace(/\|/g, "\\|");
}

function mdTable(headers: string[], rows: string[][]): string {
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
  return [head, sep, body].join("\n");
}

export function formatRunDiagnosticsMarkdown(d: RunDiagnostics): string {
  const sections: string[] = [];

  // Run — always present.
  sections.push(
    [
      "## Run",
      `- Run ID: \`${d.run.runId}\``,
      `- Generated: ${fmtTime(d.run.generatedAt)}`,
      `- Started: ${fmtTime(d.run.startedAt)}`,
      `- Ended: ${d.run.endedAt == null ? "running" : fmtTime(d.run.endedAt)}`,
      `- Duration: ${fmtMs(d.run.durationMs)}`,
    ].join("\n"),
  );

  // Source — omit if absent.
  if (d.source) {
    sections.push(
      [
        "## Source",
        `- Commit: ${d.source.commit ? `\`${d.source.commit}\`` : "—"}`,
        `- Branch: ${d.source.branch ? `\`${d.source.branch}\`` : "—"}`,
        `- Dirty: ${d.source.dirty ? "yes" : "no"}`,
        `- Candidate: \`${d.source.candidateId}\``,
      ].join("\n"),
    );
  }

  // Dispatches — omit if empty.
  if (d.dispatches.length > 0) {
    const rows = d.dispatches.map((r) => [
      esc(r.name),
      r.kind,
      r.lane ?? "—",
      r.model ?? "—",
      r.effort ?? "—",
      fmtMs(r.queuedMs),
      fmtMs(r.runMs),
      r.finalPhase,
      String(r.retries),
      r.failure ?? "—",
    ]);
    sections.push(
      [
        "## Dispatches",
        mdTable(
          [
            "Actor",
            "Kind",
            "Lane",
            "Model",
            "Effort",
            "Queued",
            "Run",
            "Phase",
            "Retries",
            "Failure",
          ],
          rows,
        ),
      ].join("\n"),
    );
  }

  // Usage — omit if no calls.
  if (d.usage.calls > 0) {
    const lines = [
      "## Usage",
      `- Calls: ${String(d.usage.calls)} (errors: ${String(d.usage.errors)})`,
      `- Input: ${String(d.usage.input)} (fresh: ${String(d.usage.freshInput)}, cache read: ${String(d.usage.cacheRead)})`,
      `- Output: ${String(d.usage.output)}`,
      `- Cache write: ${String(d.usage.cacheWrite)}`,
    ];
    if (d.usage.byModel.length > 0) {
      lines.push(
        "",
        "**By model**",
        "",
        mdTable(
          [
            "Model",
            "Calls",
            "Errors",
            "Input",
            "Output",
            "Fresh",
            "Cache read",
            "Cache write",
            "Time",
          ],
          d.usage.byModel.map((m) => [
            esc(m.modelId),
            String(m.calls),
            String(m.errors),
            String(m.input),
            String(m.output),
            String(m.freshInput),
            String(m.cacheRead),
            String(m.cacheWrite),
            fmtMs(m.totalMs),
          ]),
        ),
      );
    }
    if (d.usage.byLane.length > 0) {
      lines.push(
        "",
        "**By lane**",
        "",
        mdTable(
          [
            "Lane",
            "Calls",
            "Errors",
            "Input",
            "Output",
            "Fresh",
            "Cache read",
            "Cache write",
            "Time",
          ],
          d.usage.byLane.map((l) => [
            esc(l.lane),
            String(l.calls),
            String(l.errors),
            String(l.input),
            String(l.output),
            String(l.freshInput),
            String(l.cacheRead),
            String(l.cacheWrite),
            fmtMs(l.totalMs),
          ]),
        ),
      );
    }
    sections.push(lines.join("\n"));
  }

  // Errors & retries — omit if none.
  if (d.errors.total > 0 || d.errors.retries > 0) {
    const lines = [
      "## Errors & Retries",
      `- Total errors: ${String(d.errors.total)}`,
      `- Retries: ${String(d.errors.retries)}`,
    ];
    const categories = Object.entries(d.errors.byCategory);
    if (categories.length > 0) {
      lines.push(
        `- By category: ${categories.map(([cat, n]) => `${cat} (${String(n)})`).join(", ")}`,
      );
    }
    sections.push(lines.join("\n"));
  }

  // Timeline — omit if there was no worker activity at all.
  const t = d.timeline;
  const timelineEmpty =
    t.peakConcurrency === 0 &&
    t.avgConcurrency === 0 &&
    t.overlapMs === 0 &&
    t.idleGapsMs === 0 &&
    t.queuedWhileCapacityMs === 0;
  if (!timelineEmpty) {
    sections.push(
      [
        "## Timeline",
        `- Peak concurrency: ${String(t.peakConcurrency)}`,
        `- Avg concurrency: ${t.avgConcurrency.toFixed(2)}`,
        `- Overlap: ${fmtMs(t.overlapMs)}`,
        `- Idle gaps: ${fmtMs(t.idleGapsMs)}`,
        `- Queued while capacity available: ${fmtMs(t.queuedWhileCapacityMs)}`,
      ].join("\n"),
    );
  }

  // User gates — omit if none.
  if (d.gates.length > 0) {
    sections.push(
      [
        "## User Gates",
        ...d.gates.map((g) => `- ${fmtTime(g.at)}: ${esc(g.name)} — ${esc(g.label)}`),
      ].join("\n"),
    );
  }

  // Evidence — omit if none.
  if (d.evidence.length > 0) {
    sections.push(
      [
        "## Evidence",
        mdTable(
          ["Kind", "OK", "Candidate", "At", "Summary"],
          d.evidence.map((e) => [
            esc(e.kind),
            e.ok ? "yes" : "no",
            esc(e.candidateId),
            fmtTime(e.at),
            e.summary ? esc(e.summary) : "—",
          ]),
        ),
      ].join("\n"),
    );
  }

  // Final — always present.
  sections.push(
    [
      "## Final",
      `- State: ${d.final.state}`,
      `- Failed actors: ${d.final.failedActors.length > 0 ? d.final.failedActors.join(", ") : "none"}`,
    ].join("\n"),
  );

  return sections.join("\n\n");
}
