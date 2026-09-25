/**
 * Optional model-authored operational narration for the Forge.
 *
 *   quiet   — default. Current behaviour: silent tool loop, one final answer.
 *             Nothing is added to the prompt (byte-identical system prompt).
 *   normal  — short user-facing updates at meaningful phase changes/findings.
 *   verbose — Codex/Claude-style running commentary before most actions.
 *
 * This is progress REPORTING, not reasoning disclosure: the instructions
 * forbid reproducing hidden reasoning. It is independent of harness activity
 * (core/activity — token-free, always on) and of the reasoning/verbose
 * display switches (rendering only). Narration costs output tokens and stays
 * in context, which is why quiet is the default.
 *
 * Applies to the Forge only; dispatched workers keep their own contracts.
 */

export type NarrationMode = "quiet" | "normal" | "verbose";

export const NARRATION_MODES: readonly NarrationMode[] = ["quiet", "normal", "verbose"];

export function normalizeNarrationMode(v: unknown): NarrationMode {
  return v === "normal" || v === "verbose" ? v : "quiet";
}

const SHARED = `This section OVERRIDES any earlier rule requiring zero text between tool calls, and any instruction to suppress preambles or progress notes.

Narration is user-facing progress reporting — what you are about to inspect or change, an important finding, why your next action changed, what remains uncertain. It is NOT your reasoning: never reproduce or paraphrase hidden thinking, never write deliberation, candidate lists, or self-talk. State conclusions and intentions plainly in one or two sentences, first person, present tense. Never narrate trivial reads, never repeat a previous update, and never restate tool output the user can already see.`;

const NORMAL = `## Progress narration (normal)
${SHARED}

Cadence: write an update only at a meaningful moment — starting a new phase, a finding that changes the plan, a surprise or failure, or before a risky or long-running action. Most tool calls get no update. Typical turns have 1–4 updates.`;

const VERBOSE = `## Progress narration (verbose)
${SHARED}

Cadence: before each significant action (a search with a purpose, an edit, a command, a dispatch), write one short line saying what you are doing and why; after a notable result, one line on what it means. Batch consecutive trivial reads under a single line.`;

export function getNarrationInstructions(mode: NarrationMode): string | null {
  if (mode === "normal") return NORMAL;
  if (mode === "verbose") return VERBOSE;
  return null;
}

/**
 * Replacement for the long-session persona nudge when narration is on, so the
 * silence reminder never contradicts the user's chosen mode.
 */
export function getNarrationNudge(mode: NarrationMode): string | null {
  if (mode === "quiet") return null;
  return mode === "normal"
    ? "Voice check (narration: normal): brief user-facing updates only at meaningful moments — phase changes, findings, surprises. No reasoning dumps, no filler, no restating tool output. Otherwise keep working through tool calls."
    : "Voice check (narration: verbose): one short line before each significant action and after notable results. Progress reporting only — never reasoning, self-talk or restated tool output.";
}
