/**
 * Evidence ledger — build/test/typecheck/lint/review/acceptance/preflight
 * results tied to the exact candidate (SourceIdentity.candidateId) they ran
 * against. Evidence is reusable while the candidate is unchanged and becomes
 * stale the moment the source changes.
 *
 * Stored per project in `<cwd>/.soulforge/evidence.jsonl` (bounded). All
 * writes are best-effort and never throw into the caller.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatSourceIdentity, getSourceIdentity, type SourceIdentity } from "./source.js";

export type EvidenceKind =
  | "build"
  | "test"
  | "typecheck"
  | "lint"
  | "review"
  | "acceptance"
  | "preflight";

export interface EvidenceRecord {
  kind: EvidenceKind;
  ok: boolean;
  candidateId: string;
  commit: string | null;
  dirty: boolean;
  at: number;
  source: "project-tool" | "verifier" | "preflight" | "manual";
  command?: string;
  summary?: string;
}

export type EvidenceStatus = "pass" | "fail" | "stale" | "missing";

const MAX_RECORDS = 500;

function ledgerPath(cwd: string): string {
  return join(cwd, ".soulforge", "evidence.jsonl");
}

export function readEvidence(cwd: string): EvidenceRecord[] {
  try {
    const file = ledgerPath(cwd);
    if (!existsSync(file)) return [];
    const out: EvidenceRecord[] = [];
    for (const line of readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as EvidenceRecord);
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

export function appendEvidence(cwd: string, record: EvidenceRecord): void {
  try {
    const dir = join(cwd, ".soulforge");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const records = [...readEvidence(cwd), record].slice(-MAX_RECORDS);
    writeFileSync(ledgerPath(cwd), `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  } catch {}
}

/**
 * Status of `kind` for `candidateId`, from the most recent matching record:
 *  - pass / fail : latest record for this exact candidate
 *  - stale       : records exist, but only for other candidates
 *  - missing     : never recorded
 */
export function evidenceStatus(
  records: readonly EvidenceRecord[],
  kind: EvidenceKind,
  candidateId: string,
): EvidenceStatus {
  let sawKind = false;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i] as EvidenceRecord;
    if (r.kind !== kind) continue;
    sawKind = true;
    if (r.candidateId === candidateId) return r.ok ? "pass" : "fail";
  }
  return sawKind ? "stale" : "missing";
}

/**
 * Record evidence for the candidate as it was when the check STARTED —
 * pass the identity captured before running (edits during the run make the
 * result ambiguous, and the next identity will differ anyway).
 */
export function recordEvidence(
  cwd: string,
  identity: SourceIdentity,
  entry: Omit<EvidenceRecord, "candidateId" | "commit" | "dirty" | "at">,
): EvidenceRecord | null {
  if (!identity.isGit) return null;
  const record: EvidenceRecord = {
    ...entry,
    candidateId: identity.candidateId,
    commit: identity.commit,
    dirty: identity.dirty,
    at: Date.now(),
  };
  appendEvidence(cwd, record);
  return record;
}

/** Map a `project` tool action to an evidence kind (null = not evidence). */
export function evidenceKindForProjectAction(action: string): EvidenceKind | null {
  if (action === "test" || action === "typecheck" || action === "lint" || action === "build") {
    return action;
  }
  return null;
}

/**
 * Wrap a check: capture identity first, run, record. Never throws from the
 * recording side; the check's own result/exception passes through.
 */
export async function withEvidence<T>(
  cwd: string,
  kind: EvidenceKind,
  source: EvidenceRecord["source"],
  command: string | undefined,
  runCheck: () => Promise<T>,
  judge: (result: T) => { ok: boolean; summary?: string },
): Promise<T> {
  // Capture the candidate BEFORE the check starts (an edit made while it runs
  // must not be attributed to this result).
  const identity = await getSourceIdentity(cwd).catch(() => null);
  const result = await runCheck();
  try {
    if (identity) {
      const { ok, summary } = judge(result);
      recordEvidence(cwd, identity, { kind, ok, source, command, summary: summary?.slice(0, 300) });
    }
  } catch {}
  return result;
}

export const MANIFEST_KINDS: readonly EvidenceKind[] = [
  "typecheck",
  "lint",
  "test",
  "build",
  "review",
];

/**
 * Compact candidate manifest for reviewers and reports: which exact source
 * state this is, what changed, and which evidence is current for it.
 */
export function buildCandidateManifest(
  identity: SourceIdentity,
  records: readonly EvidenceRecord[],
  changedPaths: readonly string[] = [],
): string {
  const lines = [`Candidate: ${formatSourceIdentity(identity)}`];
  if (changedPaths.length > 0) {
    const shown = changedPaths.slice(0, 20);
    lines.push(
      `Changed in this dispatch: ${shown.join(", ")}${changedPaths.length > shown.length ? ` (+${String(changedPaths.length - shown.length)} more)` : ""}`,
    );
  }
  const ev = MANIFEST_KINDS.map((k) => `${k}: ${evidenceStatus(records, k, identity.candidateId)}`);
  lines.push(`Evidence for this exact candidate — ${ev.join(" · ")}`);
  return lines.join("\n");
}
