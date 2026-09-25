/**
 * Source identity, evidence staleness, preflight, dirty-build labels and
 * standardized worker results (private rebuild CP7).
 * Uses real throwaway git repos — read-only identity must track edits.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkerResult } from "../src/core/agents/agent-results.js";
import {
  buildCandidateManifest,
  type EvidenceRecord,
  evidenceStatus,
  readEvidence,
  recordEvidence,
  withEvidence,
} from "../src/core/provenance/evidence.js";
import { evaluatePreflight, runPreflight } from "../src/core/provenance/preflight.js";
import { computeCandidateId, getSourceIdentity } from "../src/core/provenance/source.js";
import { versionLabel } from "../src/core/version.js";

let dir: string;
const git = (...args: string[]) =>
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "prov-"));
  git("init", "-q");
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-qm", "init");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("source identity", () => {
  test("clean tree → candidate is the commit", async () => {
    const id = await getSourceIdentity(dir);
    expect(id.isGit).toBe(true);
    expect(id.dirty).toBe(false);
    expect(id.candidateId).toBe(id.commit as string);
  });

  test("tracked edit, untracked file and content changes all change the candidate", async () => {
    const clean = (await getSourceIdentity(dir)).candidateId;
    writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
    const edited = await getSourceIdentity(dir);
    expect(edited.dirty).toBe(true);
    expect(edited.candidateId).not.toBe(clean);
    expect(edited.candidateId.startsWith(`${edited.commit}+`)).toBe(true);

    writeFileSync(join(dir, "new.ts"), "x");
    const withNew = await getSourceIdentity(dir);
    expect(withNew.candidateId).not.toBe(edited.candidateId);
    writeFileSync(join(dir, "new.ts"), "y");
    expect((await getSourceIdentity(dir)).candidateId).not.toBe(withNew.candidateId);
  });

  test("same content → same candidate (evidence reusable)", async () => {
    writeFileSync(join(dir, "a.ts"), "export const a = 3;\n");
    const one = await getSourceIdentity(dir);
    const two = await getSourceIdentity(dir);
    expect(two.candidateId).toBe(one.candidateId);
  });

  test("harness state (.soulforge/) never changes the candidate", async () => {
    const before = await getSourceIdentity(dir);
    mkdirSync(join(dir, ".soulforge"), { recursive: true });
    writeFileSync(join(dir, ".soulforge", "evidence.jsonl"), "{}\n");
    const after = await getSourceIdentity(dir);
    expect(after.candidateId).toBe(before.candidateId);
    expect(after.dirty).toBe(false);
  });

  test("non-git directory", async () => {
    const plain = mkdtempSync(join(tmpdir(), "plain-"));
    const id = await getSourceIdentity(plain);
    expect([id.isGit, id.candidateId]).toEqual([false, "no-git"]);
    rmSync(plain, { recursive: true, force: true });
  });

  test("computeCandidateId is order-independent for untracked files", () => {
    const a = computeCandidateId("c", "d", [
      { path: "x", digest: "1" },
      { path: "y", digest: "2" },
    ]);
    const b = computeCandidateId("c", "d", [
      { path: "y", digest: "2" },
      { path: "x", digest: "1" },
    ]);
    expect(a).toBe(b);
  });
});

describe("evidence", () => {
  test("candidate A evidence; B makes it stale; A again reuses it", async () => {
    const A = await getSourceIdentity(dir);
    recordEvidence(dir, A, { kind: "test", ok: true, source: "manual" });
    expect(evidenceStatus(readEvidence(dir), "test", A.candidateId)).toBe("pass");

    writeFileSync(join(dir, "a.ts"), "export const a = 99;\n");
    const B = await getSourceIdentity(dir);
    expect(evidenceStatus(readEvidence(dir), "test", B.candidateId)).toBe("stale");
    expect(evidenceStatus(readEvidence(dir), "lint", B.candidateId)).toBe("missing");

    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    const A2 = await getSourceIdentity(dir);
    expect(A2.candidateId).toBe(A.candidateId);
    expect(evidenceStatus(readEvidence(dir), "test", A2.candidateId)).toBe("pass");
  });

  test("latest record for the candidate wins", () => {
    const recs = [
      { kind: "test", ok: true, candidateId: "c" },
      { kind: "test", ok: false, candidateId: "c" },
    ] as EvidenceRecord[];
    expect(evidenceStatus(recs, "test", "c")).toBe("fail");
  });

  test("withEvidence records against the identity captured before the run", async () => {
    const before = await getSourceIdentity(dir);
    await withEvidence(
      dir,
      "build",
      "project-tool",
      "build",
      async () => {
        writeFileSync(join(dir, "a.ts"), "changed during build\n");
        return { success: true };
      },
      (r) => ({ ok: r.success }),
    );
    const rec = readEvidence(dir).at(-1);
    expect(rec?.candidateId).toBe(before.candidateId);
    expect(rec?.kind).toBe("build");
  });

  test("manifest names the candidate and per-kind evidence status", async () => {
    const id = await getSourceIdentity(dir);
    recordEvidence(dir, id, { kind: "typecheck", ok: true, source: "manual" });
    const m = buildCandidateManifest(id, readEvidence(dir), ["a.ts"]);
    expect(m).toContain(`candidate ${id.candidateId}`);
    expect(m).toContain("typecheck: pass");
    expect(m).toContain("test: missing");
    expect(m).toContain("Changed in this dispatch: a.ts");
  });
});

describe("preflight", () => {
  test("clean + current passing evidence → release candidate", async () => {
    const id = await getSourceIdentity(dir);
    recordEvidence(dir, id, { kind: "typecheck", ok: true, source: "manual" });
    recordEvidence(dir, id, { kind: "test", ok: true, source: "manual" });
    const r = await runPreflight(dir);
    expect(r.ok).toBe(true);
    expect(r.releaseCandidate).toBe(true);
    expect(r.label).toStartWith("release candidate");
    expect(readEvidence(dir).at(-1)?.kind).toBe("preflight");
  });

  test("dirty tree is never a release candidate", async () => {
    writeFileSync(join(dir, "b.ts"), "x");
    const r = await runPreflight(dir, { requiredEvidence: [] }, { record: false });
    expect(r.releaseCandidate).toBe(false);
    expect(r.label).toContain("DEVELOPMENT BUILD");
    expect(r.checks.find((c) => c.name === "clean tree")?.ok).toBe(false);
  });

  test("stale / failed evidence and tag / commit policies are reported", async () => {
    const id = await getSourceIdentity(dir);
    const recs = [
      { kind: "test", ok: false, candidateId: id.candidateId },
      { kind: "typecheck", ok: true, candidateId: "older" },
    ] as EvidenceRecord[];
    const r = evaluatePreflight(id, recs, { requireTag: true, expectedCommit: "deadbeef" });
    const detail = Object.fromEntries(r.checks.map((c) => [c.name, c.detail]));
    expect(detail["test evidence"]).toContain("FAILED");
    expect(detail["typecheck evidence"]).toContain("older candidate");
    expect(detail["tagged commit"]).toContain("no tag");
    expect(detail["expected commit"]).toContain("≠ expected deadbeef");
    expect(r.ok).toBe(false);
  });
});

describe("dirty-build label", () => {
  test("labels", () => {
    expect(versionLabel("1.0.0", null)).toBe("1.0.0 (running from source)");
    expect(
      versionLabel("1.0.0", { commit: "abcdef123", dirty: false, tag: "v1.0.0", builtAt: "" }),
    ).toBe("1.0.0 (abcdef1, v1.0.0)");
    expect(
      versionLabel("1.0.0", { commit: "abcdef123", dirty: true, tag: null, builtAt: "" }),
    ).toBe("1.0.0+dev.abcdef1.dirty — DEVELOPMENT BUILD, not a release");
  });
});

describe("worker result metadata", () => {
  test("parses the RESULT footer tolerantly", () => {
    const text = `Fixed the sign.\n\n**RESULT**\nreproduced: yes\nchanged: \`src/a.ts\`, src/b.ts\ntests: bun test a → 3 pass\nvalidation: pass\nuncertainty: none\ninvariants: public API unchanged`;
    expect(parseWorkerResult(text)).toEqual({
      reproduced: "yes",
      changed: ["src/a.ts", "src/b.ts"],
      tests: "bun test a → 3 pass",
      validation: "pass",
      uncertainty: "none",
      invariants: "public API unchanged",
    });
    expect(parseWorkerResult("RESULT\nchanged: none\nvalidation: not run")).toEqual({
      changed: [],
      validation: "not-run",
    });
    expect(parseWorkerResult("no footer here")).toBeNull();
  });
});
