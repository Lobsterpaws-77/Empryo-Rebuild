import { logBackgroundError } from "../../stores/errors.js";
import { getCwd } from "../cwd.js";
import { CORE_RULES } from "../prompts/families/shared-rules.js";
import { buildCandidateManifest, readEvidence, recordEvidence } from "../provenance/evidence.js";
import { getSourceIdentity } from "../provenance/source.js";
import { projectTool } from "../tools/project.js";
import type { AgentBus, AgentTask } from "./agent-bus.js";
import { runAgentTask } from "./agent-runner.js";
import type { SubagentModels } from "./subagent-tools.js";

// ── De-sloppify ─────────────────────────────────────────────────────────
// Step 1: deterministic lint --fix (zero tokens)
// Step 2: LLM reviews for slop patterns the linter can't catch

const DESLOPPIFY_PROMPT = `${CORE_RULES}

ROLE: cleanup agent. Lint --fix already ran. Review for slop the linter missed. Report under 200 words — list files changed and what was removed. If clean, report done immediately without reading.

REMOVE:
- Tests that verify language/framework behavior rather than business logic.
- Redundant type assertions the type system already enforces.
- Over-defensive error handling for impossible states.
- console.log/debug/print statements not part of the feature.
- Dead code: unused vars, unreachable branches, empty catch blocks.

KEEP:
- TODO/FIXME/SECTION/placeholder comments.
- Business logic, meaningful error handling, type annotations.
- Comments explaining non-obvious decisions.

WORKFLOW: read files with ranges around edited sections → multi_edit → done.`;

export async function runDesloppify(
  bus: AgentBus,
  tasks: AgentTask[],
  models: SubagentModels,
  parentToolCallId: string,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  if (models.agentFeatures?.desloppify !== true) return null;
  if (tasks.filter((t) => t.role === "code").length === 0) return null;
  if (!models.desloppifyModel) return null;

  const editedFiles = bus.getEditedFiles();
  if (editedFiles.size === 0) return null;
  const editedPaths = [...editedFiles.keys()];

  // Step 1: deterministic lint --fix (zero tokens, instant)
  let lintResult = "";
  try {
    const lint = await projectTool.execute({ action: "lint", fix: true, timeout: 30_000 });
    if (!lint.success && lint.output) {
      const relevant = lint.output
        .split("\n")
        .filter((l: string) => editedPaths.some((p) => l.includes(p)));
      if (relevant.length > 0) lintResult = `\nLint issues after fix:\n${relevant.join("\n")}`;
    }
  } catch {}

  // Invalidate bus cache — code agents wrote new content
  for (const p of editedPaths) {
    bus.invalidateFile(p, "desloppify");
  }

  // Step 2: LLM cleanup via runAgentTask (same flow as any code agent)
  const desloppifyTask: AgentTask = {
    agentId: "desloppify",
    role: "code",
    tier: "ember",
    // Model AND effort come from the desloppify lane — not from generic
    // code/ember routing (which would inherit the coder's effort).
    lane: "desloppify",
    task: `${DESLOPPIFY_PROMPT}${lintResult}\n\nFiles to review:\n${editedPaths.map((p) => `- ${p}`).join("\n")}`,
    targetFiles: editedPaths,
  };
  bus.registerTasks([desloppifyTask]);

  try {
    const { resultText } = await runAgentTask(
      desloppifyTask,
      { ...models, parentMessagesRef: undefined },
      bus,
      parentToolCallId,
      tasks.length + 1,
      abortSignal,
    );
    return resultText.length > 20 ? `\n\n### De-sloppify pass\n${resultText}` : null;
  } catch (err) {
    logBackgroundError("desloppify", err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ── Verifier ────────────────────────────────────────────────────────────
// Step 1: deterministic typecheck + test (zero tokens)
// Step 2: LLM checks logic correctness against the original task

const VERIFY_PROMPT = `${CORE_RULES}

ROLE: verification agent. Fresh eyes — you did NOT write this code. Read edited files with ranges around changed sections, not full files.

PROCESS:
1. Check typecheck/test results below — errors are automatic FAIL.
2. Read each edited file (ranges around changes) and verify:
   - Does the implementation match what the task asked for?
   - Missing edge cases? Incorrect imports? Signature mismatches?
3. If exports changed signatures, \`navigate(references)\` on one caller.

SKIP: formatting/style (de-sloppify handles it), typecheck/tests (results below).

OUTPUT — end with exactly one of:
  VERDICT: PASS — [one-line summary]
  VERDICT: FAIL — [file:line, what's wrong]
  VERDICT: PARTIAL — [what couldn't be verified]`;

export async function runVerifier(
  bus: AgentBus,
  tasks: AgentTask[],
  models: SubagentModels,
  parentToolCallId: string,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  if (models.agentFeatures?.verifyEdits !== true) return null;
  if (tasks.filter((t) => t.role === "code").length === 0) return null;

  const editedFiles = bus.getEditedFiles();
  if (editedFiles.size === 0) return null;
  const editedPaths = [...editedFiles.keys()];

  // Step 1: deterministic typecheck + test (zero tokens)
  const checkResults: string[] = [];
  try {
    const tc = await projectTool.execute({ action: "typecheck", timeout: 30_000 });
    if (!tc.success && tc.output) {
      const relevant = tc.output
        .split("\n")
        .filter((l: string) => editedPaths.some((p) => l.includes(p)));
      checkResults.push(
        relevant.length > 0
          ? `TYPECHECK FAILED:\n${relevant.join("\n")}`
          : "Typecheck: passed (no errors in edited files)",
      );
    } else {
      checkResults.push("Typecheck: passed");
    }
  } catch {
    checkResults.push("Typecheck: unavailable");
  }
  try {
    const test = await projectTool.execute({ action: "test", timeout: 60_000 });
    if (!test.success && test.output) {
      checkResults.push(`TESTS FAILED:\n${test.output.slice(-500)}`);
    } else if (test.success) {
      checkResults.push("Tests: passed");
    }
  } catch {
    checkResults.push("Tests: unavailable");
  }

  // Candidate manifest: the exact source state under review and which
  // evidence (incl. the checks just run) is current for it.
  const cwd = getCwd();
  const identity = await getSourceIdentity(cwd).catch(() => null);
  const manifest =
    identity?.isGit === true
      ? buildCandidateManifest(identity, readEvidence(cwd), editedPaths)
      : null;

  // Step 2: LLM verification via runAgentTask
  const taskContext = tasks
    .map((t) => {
      const r = bus.getResult(t.agentId);
      return r?.result ? `[${t.agentId}] task: ${t.task.split("\n")[0]?.slice(0, 200)}` : null;
    })
    .filter(Boolean)
    .join("\n");

  const verifyPrompt = [
    VERIFY_PROMPT,
    "",
    "--- Automated check results ---",
    checkResults.join("\n"),
    ...(manifest ? ["", "--- Candidate manifest ---", manifest] : []),
    "",
    "--- Files edited ---",
    editedPaths.map((p) => `- ${p}`).join("\n"),
    "",
    "--- What was requested ---",
    taskContext,
  ].join("\n");

  const verifyTask: AgentTask = {
    agentId: "verifier",
    // explore = read-only tools. Routing is independent of role: model AND
    // effort come from the verify lane (previously effort leaked in from the
    // explore lane's built-in "low").
    role: "explore",
    lane: "verify",
    task: verifyPrompt,
    targetFiles: editedPaths,
  };
  bus.registerTasks([verifyTask]);

  try {
    // Verifier must NOT inherit parentMessagesRef — doppelganger mode would
    // replay the parent forge's full chat history as the prefix, which Anthropic
    // cannot cache (different breakpoint position vs the parent's last call).
    // Without parentMessagesRef, verifier runs as a regular spark: same forge
    // instructions + tools as parent → prefix cache hits the parent's prior prefix.
    const { resultText } = await runAgentTask(
      verifyTask,
      { ...models, parentMessagesRef: undefined },
      bus,
      parentToolCallId,
      tasks.length + 1,
      abortSignal,
    );
    if (identity) {
      const verdict = parseVerdict(resultText);
      if (verdict === "PASS" || verdict === "FAIL") {
        recordEvidence(cwd, identity, {
          kind: "review",
          ok: verdict === "PASS",
          source: "verifier",
          summary: resultText
            .split("\n")
            .find((l) => /VERDICT:/i.test(l))
            ?.trim(),
        });
      }
    }
    return `\n\n### Verification\n${resultText}`;
  } catch (err) {
    logBackgroundError("verifier", err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ── Review-driven repair ────────────────────────────────────────────────
// Findings from the verifier go to a repair WORKER (repair lane — by default
// the configured coder), then the verifier re-checks. The Forge keeps
// ownership of orchestration and gets the final verdict; it is not turned
// into the coder just because findings exist.

export type ReviewVerdict = "PASS" | "FAIL" | "PARTIAL" | "UNKNOWN";

/** Last `VERDICT: X` line in a verifier report. */
export function parseVerdict(text: string | null | undefined): ReviewVerdict {
  if (!text) return "UNKNOWN";
  const matches = [...text.matchAll(/VERDICT:\s*(PASS|FAIL|PARTIAL)\b/gi)];
  const last = matches.at(-1)?.[1]?.toUpperCase();
  return last === "PASS" || last === "FAIL" || last === "PARTIAL" ? last : "UNKNOWN";
}

const REPAIR_PROMPT = `${CORE_RULES}

ROLE: repair agent. A reviewer found defects in code that other agents just wrote. Fix exactly the findings below — nothing else. Do not refactor, restyle, or widen scope. Read the cited ranges, make minimal edits, then report in under 150 words: each finding → fixed / not reproducible / cannot fix (why).`;

export function getMaxRepairRounds(models: SubagentModels): number {
  const v = models.agentFeatures?.maxRepairRounds;
  if (v == null || !Number.isFinite(v)) return 1;
  return Math.min(3, Math.max(1, Math.round(v)));
}

export async function runRepair(
  bus: AgentBus,
  tasks: AgentTask[],
  models: SubagentModels,
  parentToolCallId: string,
  findings: string,
  round: number,
  abortSignal?: AbortSignal,
  runner: typeof runAgentTask = runAgentTask,
): Promise<string | null> {
  const editedPaths = [...bus.getEditedFiles().keys()];
  const repairTask: AgentTask = {
    agentId: round === 1 ? "repair" : `repair-${String(round)}`,
    role: "code",
    tier: "ember",
    lane: "repair",
    task: `${REPAIR_PROMPT}\n\n--- Reviewer findings ---\n${findings.trim()}\n\n--- Files in scope ---\n${editedPaths.map((p) => `- ${p}`).join("\n")}`,
    targetFiles: editedPaths,
  };
  bus.registerTasks([repairTask]);
  try {
    const { resultText } = await runner(
      repairTask,
      { ...models, parentMessagesRef: undefined },
      bus,
      parentToolCallId,
      tasks.length + 1,
      abortSignal,
    );
    return resultText;
  } catch (err) {
    logBackgroundError("repair", err instanceof Error ? err.message : String(err));
    return null;
  }
}

export interface ReviewRepairHooks {
  /** Re-acquire the workspace edit lock before a repair worker edits. */
  beforeRepair?: () => void;
  /** Release it again once the repair worker finishes. */
  afterRepair?: () => void;
}

/**
 * Verify, and — when enabled and the verdict is FAIL — repair via the repair
 * lane and re-verify, up to maxRepairRounds. Returns the report sections to
 * append to the dispatch output (null when verification is off / no edits).
 */
export async function runReviewAndRepair(
  bus: AgentBus,
  tasks: AgentTask[],
  models: SubagentModels,
  parentToolCallId: string,
  abortSignal?: AbortSignal,
  hooks?: ReviewRepairHooks,
  deps: { verify: typeof runVerifier; repair: typeof runRepair } = {
    verify: runVerifier,
    repair: runRepair,
  },
): Promise<string | null> {
  let report = await deps.verify(bus, tasks, models, parentToolCallId, abortSignal);
  if (!report) return null;
  if (models.agentFeatures?.repairOnReviewFail !== true || models.readOnly) return report;

  const parts = [report];
  const maxRounds = getMaxRepairRounds(models);
  let verdict = parseVerdict(report);
  let round = 0;
  while (verdict === "FAIL" && round < maxRounds && !abortSignal?.aborted) {
    round++;
    hooks?.beforeRepair?.();
    let repaired: string | null;
    try {
      repaired = await deps.repair(
        bus,
        tasks,
        models,
        parentToolCallId,
        report,
        round,
        abortSignal,
      );
    } finally {
      hooks?.afterRepair?.();
    }
    parts.push(
      `\n\n### Repair (round ${String(round)}, repair lane)\n${repaired ?? "Repair worker failed — see errors."}`,
    );
    if (!repaired) break;
    const recheck = await deps.verify(bus, tasks, models, parentToolCallId, abortSignal);
    if (!recheck) break;
    report = recheck;
    verdict = parseVerdict(recheck);
    parts.push(recheck.replace("### Verification", `### Verification (recheck ${String(round)})`));
  }
  if (round > 0) {
    parts.push(
      verdict === "PASS"
        ? `\n\nReview → repair → recheck: PASS after ${String(round)} repair round(s).`
        : `\n\nReview → repair → recheck: still ${verdict} after ${String(round)} repair round(s). ` +
            "Decide next step as coordinator — dispatch a code agent with the remaining findings " +
            "rather than editing directly, unless the user asked you to implement it yourself.",
    );
  }
  return parts.join("");
}
