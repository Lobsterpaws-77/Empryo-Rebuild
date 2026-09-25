/**
 * Source identity — a stable id for the exact candidate state evidence was
 * produced against. Uses git as the source of truth (no parallel SCM):
 *
 *   clean tree  → candidateId = HEAD commit
 *   dirty tree  → candidateId = HEAD + "+" + hash(tracked diff vs HEAD,
 *                                          untracked file names + contents)
 *
 * Any edit to a tracked or untracked (non-ignored) file changes the id, so
 * evidence recorded against the previous id is detectably stale. Read-only:
 * never writes to the repository or its object store.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { run } from "../git/status.js";

export interface SourceIdentity {
  isGit: boolean;
  commit: string | null;
  shortCommit: string | null;
  branch: string | null;
  dirty: boolean;
  /** Changed tracked files + untracked files. */
  changedFiles: number;
  /** Stable id of the exact working-tree state (see module doc). */
  candidateId: string;
  /** Tag pointing at HEAD, if any. */
  tag: string | null;
}

const MAX_UNTRACKED_FILES = 2000;
/** Harness-owned state (evidence ledger, plans, sessions) never counts as source. */
const HARNESS_DIRS = [".soulforge/"];
const isHarnessPath = (p: string) => HARNESS_DIRS.some((d) => p.startsWith(d));
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;

/** Pure: derive the candidate id from the pieces. */
export function computeCandidateId(
  commit: string | null,
  trackedDiff: string,
  untracked: ReadonlyArray<{ path: string; digest: string }>,
): string {
  const base = commit ?? "no-commit";
  if (!trackedDiff && untracked.length === 0) return base;
  const h = createHash("sha256");
  h.update(trackedDiff);
  for (const u of [...untracked].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(`\0${u.path}\0${u.digest}`);
  }
  return `${base}+${h.digest("hex").slice(0, 12)}`;
}

function digestFile(cwd: string, rel: string): string {
  try {
    const abs = join(cwd, rel);
    const st = statSync(abs);
    if (!st.isFile()) return "not-a-file";
    // Large files: size+mtime is a pragmatic stand-in for content.
    if (st.size > MAX_UNTRACKED_BYTES) return `size:${String(st.size)}:${String(st.mtimeMs)}`;
    return createHash("sha256").update(readFileSync(abs)).digest("hex").slice(0, 16);
  } catch {
    return "unreadable";
  }
}

export async function getSourceIdentity(cwd: string): Promise<SourceIdentity> {
  const head = await run(["rev-parse", "HEAD"], cwd);
  const inside = await run(["rev-parse", "--is-inside-work-tree"], cwd);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return {
      isGit: false,
      commit: null,
      shortCommit: null,
      branch: null,
      dirty: true,
      changedFiles: 0,
      candidateId: "no-git",
      tag: null,
    };
  }
  const commit = head.ok ? head.stdout.trim() || null : null;
  const [branchRes, tagRes, diffRes, untrackedRes, statusRes] = await Promise.all([
    run(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    run(["tag", "--points-at", "HEAD"], cwd),
    run(
      [
        "diff",
        ...(commit ? ["HEAD"] : ["--cached"]),
        "--binary",
        "--no-color",
        "--no-ext-diff",
        "--",
        ".",
        ":(exclude).soulforge",
      ],
      cwd,
      20_000,
    ),
    run(["ls-files", "--others", "--exclude-standard", "-z"], cwd, 10_000),
    run(["status", "--porcelain"], cwd, 10_000),
  ]);
  const untrackedPaths = untrackedRes.stdout
    .split("\0")
    .filter((p) => p && !isHarnessPath(p))
    .slice(0, MAX_UNTRACKED_FILES);
  const untracked = untrackedPaths.map((p) => ({ path: p, digest: digestFile(cwd, p) }));
  const trackedDiff = diffRes.stdout;
  const changedFiles = statusRes.stdout
    .split("\n")
    .filter((l) => l.trim() && !isHarnessPath(l.slice(3).replace(/^"/, ""))).length;
  const dirty = changedFiles > 0 || trackedDiff.length > 0;
  const branch = branchRes.ok ? branchRes.stdout.trim() || null : null;
  const tag = tagRes.ok ? (tagRes.stdout.trim().split("\n")[0] ?? "") || null : null;
  return {
    isGit: true,
    commit,
    shortCommit: commit ? commit.slice(0, 7) : null,
    branch: branch === "HEAD" ? null : branch,
    dirty,
    changedFiles,
    candidateId: computeCandidateId(commit, dirty ? trackedDiff : "", dirty ? untracked : []),
    tag,
  };
}

/** One-line human label, e.g. `482edfb (dirty, 3 files) · candidate 482edfb…+9f3a…`. */
export function formatSourceIdentity(s: SourceIdentity): string {
  if (!s.isGit) return "not a git repository — source identity unavailable";
  const state = s.dirty ? `dirty, ${String(s.changedFiles)} file(s)` : "clean";
  const tag = s.tag ? ` · tag ${s.tag}` : "";
  return `${s.shortCommit ?? "no commit"}${s.branch ? ` on ${s.branch}` : ""} (${state})${tag} · candidate ${s.candidateId}`;
}
