/** Wiring for run diagnostics export + CLI flags (private rebuild CP7). */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportActivity } from "../src/core/activity/activity.js";
import { exportRunDiagnostics, summarizeExport } from "../src/core/diagnostics/export.js";
import { parseHeadlessArgs } from "../src/headless/index.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "diag-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("export writes Markdown + JSON from live harness state", async () => {
  reportActivity({ type: "start", actorId: "worker:tc:x1", kind: "worker", name: "x1 (code)", lane: "ember", effort: "high" });
  reportActivity({ type: "end", actorId: "worker:tc:x1", outcome: "done" });
  const exp = await exportRunDiagnostics(dir, "run-test");
  expect(existsSync(exp.markdownPath)).toBe(true);
  const json = JSON.parse(readFileSync(exp.jsonPath, "utf-8"));
  expect(json.run.runId).toBe("run-test");
  expect(json.source).toBeNull(); // not a git repo
  const row = json.dispatches.find((r: { actorId: string }) => r.actorId === "worker:tc:x1");
  expect(row).toMatchObject({ lane: "ember", effort: "high" });
  const md = readFileSync(exp.markdownPath, "utf-8");
  expect(md).toContain("x1 (code)");
  expect(md).toContain("/model-events"); // hint when per-call events were off
  expect(summarizeExport(exp)).toContain("Diagnostics written");
});

test("CLI: --diagnostics and --preflight parse", async () => {
  const run = await parseHeadlessArgs(["--headless", "--diagnostics", "do it"]);
  expect(run?.type === "run" && run.opts.diagnostics).toBe(true);
  expect(await parseHeadlessArgs(["--preflight", "--cwd", "/tmp/x"])).toEqual({
    type: "preflight",
    cwd: "/tmp/x",
  });
});
