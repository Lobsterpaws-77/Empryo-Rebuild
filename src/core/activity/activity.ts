/**
 * Harness-generated activity — what the Forge and each worker are doing
 * RIGHT NOW, derived from structured events the harness already has.
 * No model tokens are spent: every label here is generated from event data.
 *
 * Separate from (and independent of) display switches such as verbose tool
 * output or reasoning visibility — those change rendering only.
 *
 * Shape:
 *   ActivityState   per actor (the Forge of a tab, or one dispatched worker)
 *   ActivityEntry   meaningful transitions for the chronological feed
 *   describeActivity(state, now) → the one-line status a surface renders,
 *                   including explicit waiting states with elapsed silence.
 *
 * Surfaces subscribe with onActivity(); headless --events forwards it.
 */

import { classifyFailure, type FailureCategory, failureLabel } from "./failure.js";

export type ActivityPhase =
  /** Dispatched but waiting for a concurrency slot or dependency. */
  | "queued"
  /** Request sent to the provider; nothing received yet (or between steps). */
  | "requesting"
  /** Receiving answer text. */
  | "streaming"
  /** Receiving reasoning content. */
  | "reasoning"
  /** Executing a tool. */
  | "tool"
  /** Forge is inside `dispatch`, waiting on its workers. */
  | "waiting-worker"
  /** Waiting on the user (question, plan review, approval). */
  | "blocked-user"
  | "retrying"
  | "done"
  | "failed"
  | "cancelled";

export type ActorKind = "forge" | "worker";

export interface ActivityState {
  actorId: string;
  kind: ActorKind;
  /** Display name, e.g. "Forge" or "c1 (code)". */
  name: string;
  tabId?: string;
  phase: ActivityPhase;
  /** Human label for the current phase ("Reading src/a.ts"). */
  label: string;
  /** When the current phase began. */
  since: number;
  /** Last time ANY event arrived for this actor (stream chunk, tool, step). */
  lastEventAt: number;
  startedAt: number;
  /** When the actor was first queued (workers waiting for a slot/dependency). */
  queuedAt?: number;
  endedAt?: number;
  tool?: string;
  lane?: string;
  modelId?: string;
  effort?: string;
  retryCount?: number;
  failure?: FailureCategory;
  detail?: string;
  /** Workers currently running under a Forge dispatch. */
  activeWorkers?: number;
}

export interface ActivityEntry {
  at: number;
  actorId: string;
  name: string;
  phase: ActivityPhase;
  label: string;
}

// ── Labels (harness-generated, zero tokens) ─────────────────────────────

function short(s: string, max = 60): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function argOf(args: unknown, ...keys: string[]): string {
  if (typeof args === "string") return args;
  if (!args || typeof args !== "object") return "";
  const rec = args as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v) return v;
    if (Array.isArray(v) && typeof v[0] === "string")
      return v.length > 1 ? `${v[0]} +${v.length - 1}` : v[0];
  }
  return "";
}

const TEST_RE = /\b(test|jest|vitest|pytest|bun test|cargo test|go test)\b/;
const BUILD_RE = /\b(build|tsc|typecheck|compile|make|cargo build)\b/;

/** Human, present-tense label for a tool call. `args` may be an object or a pre-formatted string. */
export function toolActivityLabel(toolName: string, args?: unknown): string {
  const path = argOf(args, "path", "file", "files", "paths");
  switch (toolName) {
    case "read":
    case "read_file":
      return path ? `Reading ${short(path)}` : "Reading files";
    case "grep":
    case "glob":
    case "search":
    case "soul_grep":
    case "soul_find": {
      const q = argOf(args, "pattern", "query");
      return q ? `Searching ${short(q, 40)}` : "Searching the repository";
    }
    case "edit_file":
    case "multi_edit":
    case "write_file":
    case "create_file":
    case "str_replace_based_edit_tool":
      return path ? `Editing ${short(path)}` : "Applying edits";
    case "rename_symbol":
    case "move_symbol":
    case "refactor":
      return "Refactoring";
    case "shell": {
      const cmd = argOf(args, "command");
      if (TEST_RE.test(cmd)) return `Running tests: ${short(cmd, 40)}`;
      if (BUILD_RE.test(cmd)) return `Building: ${short(cmd, 40)}`;
      return cmd ? `Running ${short(cmd, 48)}` : "Running a command";
    }
    case "project": {
      const action = argOf(args, "action");
      if (action === "test") return "Running tests";
      if (action === "typecheck") return "Typechecking";
      if (action === "lint") return "Linting";
      if (action === "build") return "Building";
      return action ? `Project: ${action}` : "Running project task";
    }
    case "dispatch":
      return "Dispatching workers";
    case "web_search":
      return "Searching the web";
    case "fetch_page":
    case "web_fetch":
      return "Fetching a page";
    case "navigate":
    case "analyze":
      return "Navigating code";
    case "ask_user":
      return "Asking you a question";
    case "plan":
      return "Writing a plan";
    case "done":
      return "Reporting results";
    default:
      return `Running ${toolName}`;
  }
}

// ── Describe (what a surface renders) ───────────────────────────────────

export interface DescribeOptions {
  /** Silence after which a streaming/requesting actor is shown as waiting. Default 15s. */
  quietMs?: number;
  /** Silence after which the provider is called unresponsive (watchdog threshold). */
  unresponsiveMs?: number;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m ${String(s % 60)}s`;
  return `${String(Math.floor(m / 60))}h ${String(m % 60)}m`;
}

/**
 * One-line status. Never shows a stale tool label: a finished tool moves the
 * actor to "requesting", which renders as waiting-on-provider after quietMs.
 */
export function describeActivity(
  state: ActivityState,
  now: number,
  opts: DescribeOptions = {},
): string {
  const quiet = now - state.lastEventAt;
  const quietMs = opts.quietMs ?? 15_000;
  switch (state.phase) {
    case "queued":
      return `Queued — ${formatDuration(now - state.since)}`;
    case "requesting":
    case "streaming":
    case "reasoning": {
      if (opts.unresponsiveMs && quiet >= opts.unresponsiveMs)
        return `Provider unresponsive — no activity for ${formatDuration(quiet)}`;
      if (quiet >= quietMs) return `Waiting on provider — no activity for ${formatDuration(quiet)}`;
      if (state.phase === "reasoning") return "Reasoning…";
      if (state.phase === "streaming") return "Writing…";
      return "Waiting on provider…";
    }
    case "tool":
      return `${state.label}… ${formatDuration(now - state.since)}`;
    case "waiting-worker": {
      const n = state.activeWorkers ?? 0;
      return `Waiting on ${n === 1 ? "1 worker" : `${String(n)} workers`} — ${formatDuration(now - state.since)}`;
    }
    case "blocked-user":
      return `${state.label || "Waiting for you"} — ${formatDuration(now - state.since)}`;
    case "retrying":
      return `Retrying${state.retryCount ? ` (#${String(state.retryCount)})` : ""} — ${state.label}`;
    case "done":
      return `Completed in ${formatDuration((state.endedAt ?? now) - state.startedAt)}`;
    case "failed":
      return `Failed — ${state.label}`;
    case "cancelled":
      return "Cancelled";
  }
}

// ── Tracker ─────────────────────────────────────────────────────────────

export type ActivityInput =
  | {
      type: "start";
      actorId: string;
      kind: ActorKind;
      name: string;
      tabId?: string;
      phase?: "queued" | "requesting";
      lane?: string;
      modelId?: string;
      effort?: string;
    }
  | { type: "request"; actorId: string }
  | { type: "chunk"; actorId: string; kind: "text" | "reasoning" | "other" }
  | { type: "tool-start"; actorId: string; tool: string; args?: unknown }
  | { type: "tool-end"; actorId: string; tool: string; ok: boolean }
  | { type: "workers"; actorId: string; active: number }
  | { type: "blocked"; actorId: string; label: string }
  | { type: "unblocked"; actorId: string }
  | { type: "retry"; actorId: string; error?: unknown; reason?: string; stall?: boolean }
  | { type: "end"; actorId: string; outcome: "done" | "failed" | "cancelled"; error?: unknown };

/** Phases worth a feed entry (keeps the default feed free of per-chunk noise). */
const FEED_PHASES = new Set<ActivityPhase>([
  "queued",
  "tool",
  "waiting-worker",
  "blocked-user",
  "retrying",
  "done",
  "failed",
  "cancelled",
]);

/** Tools too frequent/trivial for the default feed (they still update the status line). */
const QUIET_TOOLS = new Set(["read", "read_file", "grep", "glob", "navigate", "analyze"]);

export class ActivityTracker {
  private states = new Map<string, ActivityState>();
  private feed: ActivityEntry[] = [];
  private preBlock = new Map<string, ActivityPhase>();

  constructor(
    private readonly maxFeed = 300,
    private readonly clock: () => number = Date.now,
  ) {}

  get(actorId: string): ActivityState | undefined {
    return this.states.get(actorId);
  }

  all(): ActivityState[] {
    return [...this.states.values()];
  }

  getFeed(): readonly ActivityEntry[] {
    return this.feed;
  }

  /** Forget finished actors older than `ms` (keeps long sessions bounded). */
  prune(ms: number): void {
    const cutoff = this.clock() - ms;
    for (const [id, s] of this.states) {
      if (s.endedAt && s.endedAt < cutoff) this.states.delete(id);
    }
  }

  apply(input: ActivityInput): ActivityState | undefined {
    const now = this.clock();
    if (input.type === "start") {
      const phase = input.phase ?? "requesting";
      const prior = this.states.get(input.actorId);
      const queuedAt =
        prior && !prior.endedAt && prior.phase === "queued" ? prior.startedAt : undefined;
      const s: ActivityState = {
        actorId: input.actorId,
        kind: input.kind,
        name: input.name,
        tabId: input.tabId,
        phase,
        label: phase === "queued" ? "Queued" : "Starting",
        since: now,
        lastEventAt: now,
        startedAt: now,
        lane: input.lane,
        modelId: input.modelId,
        effort: input.effort,
        ...(queuedAt !== undefined ? { queuedAt } : {}),
      };
      this.states.set(input.actorId, s);
      this.log(s);
      return s;
    }
    const s = this.states.get(input.actorId);
    if (!s || s.endedAt) return s;
    s.lastEventAt = now;
    const prev = s.phase;
    const enter = (phase: ActivityPhase, label: string) => {
      if (phase !== s.phase || label !== s.label) s.since = now;
      s.phase = phase;
      s.label = label;
    };
    switch (input.type) {
      case "request":
        if (s.phase !== "blocked-user") enter("requesting", "Waiting on provider");
        break;
      case "chunk":
        if (s.phase === "tool" || s.phase === "waiting-worker" || s.phase === "blocked-user") break;
        enter(
          input.kind === "reasoning"
            ? "reasoning"
            : input.kind === "text"
              ? "streaming"
              : s.phase === "queued"
                ? "requesting"
                : s.phase,
          input.kind === "reasoning" ? "Reasoning" : "Writing",
        );
        break;
      case "tool-start":
        s.tool = input.tool;
        enter(
          input.tool === "dispatch" ? "waiting-worker" : "tool",
          toolActivityLabel(input.tool, input.args),
        );
        if (input.tool === "dispatch") s.activeWorkers = s.activeWorkers ?? 0;
        if (!QUIET_TOOLS.has(input.tool)) this.log(s);
        return s;
      case "tool-end":
        s.tool = undefined;
        if (!input.ok) s.detail = `${input.tool} failed`;
        // The model is now composing its next step — waiting on the provider,
        // not "still running <tool>".
        enter("requesting", "Waiting on provider");
        if (input.tool === "dispatch") s.activeWorkers = 0;
        return s;
      case "workers":
        s.activeWorkers = input.active;
        break;
      case "blocked":
        if (s.phase !== "blocked-user") this.preBlock.set(s.actorId, s.phase);
        enter("blocked-user", input.label);
        break;
      case "unblocked": {
        if (s.phase !== "blocked-user") break;
        const back = this.preBlock.get(s.actorId) ?? "requesting";
        this.preBlock.delete(s.actorId);
        enter(back, back === "tool" || back === "waiting-worker" ? s.label : "Waiting on provider");
        break;
      }
      case "retry": {
        s.retryCount = (s.retryCount ?? 0) + 1;
        const cat = classifyFailure(input.error, { stall: input.stall });
        s.failure = cat;
        enter("retrying", input.reason ?? failureLabel(cat));
        break;
      }
      case "end": {
        s.endedAt = now;
        s.tool = undefined;
        if (input.outcome === "failed") {
          const cat = classifyFailure(input.error);
          s.failure = cat;
          const msg =
            input.error instanceof Error
              ? input.error.message
              : input.error
                ? String(input.error)
                : "";
          enter("failed", msg ? `${failureLabel(cat)}: ${short(msg, 80)}` : failureLabel(cat));
        } else {
          enter(input.outcome, input.outcome === "done" ? "Completed" : "Cancelled");
        }
        break;
      }
    }
    if (s.phase !== prev && FEED_PHASES.has(s.phase)) this.log(s);
    return s;
  }

  private log(s: ActivityState): void {
    this.feed.push({
      at: this.clock(),
      actorId: s.actorId,
      name: s.name,
      phase: s.phase,
      label: s.label,
    });
    if (this.feed.length > this.maxFeed) this.feed.splice(0, this.feed.length - this.maxFeed);
  }
}

/** Actor id for a tab's Forge (main conversation). */
export function forgeActorId(tabId: string | null | undefined): string {
  return `forge:${tabId ?? "main"}`;
}

// ── Global emitter (same pattern as subagent-events) ────────────────────

type Listener = (state: ActivityState, input: ActivityInput) => void;
const listeners = new Set<Listener>();
const tracker = new ActivityTracker();

/** Apply an activity input to the shared tracker and notify listeners. Never throws. */
export function reportActivity(input: ActivityInput): void {
  try {
    const state = tracker.apply(input);
    if (!state) return;
    for (const fn of listeners) fn(state, input);
  } catch {}
}

export function onActivity(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getActivityTracker(): ActivityTracker {
  return tracker;
}
