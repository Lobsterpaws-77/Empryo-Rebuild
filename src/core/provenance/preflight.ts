/**
 * Release preflight — before anything release-like, verify the exact source
 * state: identity, clean tree, optional tag / expected commit, and that the
 * required evidence is current AND passing for this very candidate.
 *
 * Dirty or source-ambiguous states are never presented as release
 * candidates; they are labelled development builds. Policy is opt-in per
 * project via `release` in config — generic workflows are unaffected.
 */

import type { ReleasePolicy } from "../../types/index.js";
import {
  type EvidenceKind,
  type EvidenceRecord,
  evidenceStatus,
  readEvidence,
  recordEvidence,
} from "./evidence.js";
import { formatSourceIdentity, getSourceIdentity, type SourceIdentity } from "./source.js";

export const DEFAULT_RELEASE_POLICY: Required<
  Pick<ReleasePolicy, "requireClean" | "requiredEvidence">
> = {
  requireClean: true,
  requiredEvidence: ["typecheck", "test"],
};

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PreflightReport {
  ok: boolean;
  /** True only when every check passed on a clean, identified source state. */
  releaseCandidate: boolean;
  identity: SourceIdentity;
  checks: PreflightCheck[];
  /** "release candidate <sha>" or "DEVELOPMENT BUILD — not a release (…)" */
  label: string;
}

/** Pure evaluation — exported for tests. */
export function evaluatePreflight(
  identity: SourceIdentity,
  records: readonly EvidenceRecord[],
  policy: ReleasePolicy = {},
): PreflightReport {
  const requireClean = policy.requireClean ?? DEFAULT_RELEASE_POLICY.requireClean;
  const required: readonly EvidenceKind[] =
    policy.requiredEvidence ?? DEFAULT_RELEASE_POLICY.requiredEvidence;
  const checks: PreflightCheck[] = [];

  checks.push({
    name: "source identity",
    ok: identity.isGit && identity.commit !== null,
    detail: formatSourceIdentity(identity),
  });
  if (requireClean) {
    checks.push({
      name: "clean tree",
      ok: identity.isGit && !identity.dirty,
      detail: identity.dirty
        ? `${String(identity.changedFiles)} uncommitted/untracked file(s)`
        : "no uncommitted changes",
    });
  }
  if (policy.requireTag) {
    checks.push({
      name: "tagged commit",
      ok: identity.tag !== null,
      detail: identity.tag ? `HEAD is tagged ${identity.tag}` : "HEAD has no tag",
    });
  }
  if (policy.expectedCommit) {
    const want = policy.expectedCommit;
    const ok = !!identity.commit && identity.commit.startsWith(want);
    checks.push({
      name: "expected commit",
      ok,
      detail: ok
        ? `HEAD matches ${want}`
        : `HEAD ${identity.shortCommit ?? "?"} ≠ expected ${want}`,
    });
  }
  for (const kind of required) {
    const status = evidenceStatus(records, kind, identity.candidateId);
    checks.push({
      name: `${kind} evidence`,
      ok: status === "pass",
      detail:
        status === "pass"
          ? "passed on this exact candidate"
          : status === "fail"
            ? "FAILED on this exact candidate"
            : status === "stale"
              ? "only recorded for an older candidate — re-run"
              : "never recorded — run it first",
    });
  }

  const ok = checks.every((c) => c.ok);
  const releaseCandidate = ok && identity.isGit && !identity.dirty && identity.commit !== null;
  const why = identity.dirty
    ? "dirty tree"
    : !identity.isGit
      ? "no git identity"
      : (checks.find((c) => !c.ok)?.name ?? "checks failed");
  const label = releaseCandidate
    ? `release candidate ${identity.shortCommit ?? ""}${identity.tag ? ` (${identity.tag})` : ""}`
    : `DEVELOPMENT BUILD — not a release (${why})`;
  return { ok, releaseCandidate, identity, checks, label };
}

export async function runPreflight(
  cwd: string,
  policy: ReleasePolicy = {},
  opts: { record?: boolean } = {},
): Promise<PreflightReport> {
  const identity = await getSourceIdentity(cwd);
  const report = evaluatePreflight(identity, readEvidence(cwd), policy);
  if (opts.record !== false) {
    recordEvidence(cwd, identity, {
      kind: "preflight",
      ok: report.ok,
      source: "preflight",
      summary: report.label,
    });
  }
  return report;
}

export function formatPreflightReport(r: PreflightReport): string {
  const lines = [`Preflight: ${r.ok ? "PASS" : "FAIL"} — ${r.label}`];
  for (const c of r.checks) lines.push(`  ${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
  return lines.join("\n");
}
