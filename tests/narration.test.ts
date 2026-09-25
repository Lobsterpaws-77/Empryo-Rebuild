/**
 * Optional model-authored narration (private rebuild CP6).
 * Quiet must be byte-identical to the pre-rebuild prompt; normal/verbose add
 * one precedence-taking section that forbids reasoning disclosure.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextManager } from "../src/core/context/manager.js";
import { buildSystemPrompt, type PromptBuilderOptions } from "../src/core/prompts/builder.js";
import {
  getNarrationInstructions,
  getNarrationNudge,
  normalizeNarrationMode,
} from "../src/core/prompts/narration.js";
import { parseHeadlessArgs } from "../src/headless/index.js";

const base: PromptBuilderOptions = {
  modelId: "anthropic/claude-sonnet-4-6",
  hasRepoMap: false,
  hasSymbols: false,
  forgeMode: "default",
  projectInstructions: "PROJECT RULES",
};

describe("system prompt", () => {
  test("quiet (and unset) is byte-identical — no prompt change, no cache churn", () => {
    const unset = buildSystemPrompt(base);
    expect(buildSystemPrompt({ ...base, narration: "quiet" })).toBe(unset);
    expect(unset).not.toContain("Progress narration");
  });

  for (const mode of ["normal", "verbose"] as const) {
    test(`${mode}: one section, last, overriding the silent-loop rule`, () => {
      const p = buildSystemPrompt({ ...base, narration: mode });
      expect(p).toContain(`## Progress narration (${mode})`);
      expect(p.indexOf("## Progress narration")).toBeGreaterThan(p.indexOf("PROJECT RULES"));
      expect(p.trimEnd().endsWith(getNarrationInstructions(mode)?.trimEnd() ?? "")).toBe(true);
      expect(p).toContain("OVERRIDES any earlier rule requiring zero text between tool calls");
    });
  }

  test("all modes forbid reasoning disclosure; OpenAI preamble suppression is overridden too", () => {
    for (const mode of ["normal", "verbose"] as const) {
      const text = getNarrationInstructions(mode) ?? "";
      expect(text).toContain("NOT your reasoning");
      expect(text).toContain("never reproduce or paraphrase hidden thinking");
      expect(text).toContain("suppress preambles");
    }
    const openai = buildSystemPrompt({ ...base, modelId: "openai/gpt-5", narration: "normal" });
    expect(openai.lastIndexOf("## Progress narration")).toBeGreaterThan(
      openai.indexOf("suppress them here"),
    );
  });

  test("modes differ in cadence", () => {
    expect(getNarrationInstructions("normal")).toContain("Most tool calls get no update");
    expect(getNarrationInstructions("verbose")).toContain("before each significant action");
  });
});

describe("nudge + normalisation", () => {
  test("quiet keeps the original silence nudge; others replace it", () => {
    expect(getNarrationNudge("quiet")).toBeNull();
    expect(getNarrationNudge("normal")).toContain("narration: normal");
    expect(getNarrationNudge("verbose")).toContain("never reasoning");
  });

  test("unknown values fall back to quiet", () => {
    expect(normalizeNarrationMode(undefined)).toBe("quiet");
    expect(normalizeNarrationMode("chatty")).toBe("quiet");
    expect(normalizeNarrationMode("verbose")).toBe("verbose");
  });
});

describe("ContextManager", () => {
  let TMP: string;
  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "narration-"));
  });
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  test("mode flows into the Forge system prompt and the instructions cache key", () => {
    const cm = new ContextManager(TMP);
    const quietKey = cm.getInstructionsCacheKey("anthropic/claude-sonnet-4-6");
    expect(cm.buildSystemPrompt("anthropic/claude-sonnet-4-6")).not.toContain("Progress narration");
    cm.setNarrationMode("verbose");
    expect(cm.getInstructionsCacheKey("anthropic/claude-sonnet-4-6")).not.toBe(quietKey);
    expect(cm.buildSystemPrompt("anthropic/claude-sonnet-4-6")).toContain(
      "## Progress narration (verbose)",
    );
  });
});

describe("headless --narration", () => {
  test("parses the flag for run and chat", async () => {
    const run = await parseHeadlessArgs(["--headless", "--narration", "normal", "hi"]);
    expect(run?.type === "run" && run.opts.narration).toBe("normal");
    const chat = await parseHeadlessArgs(["--headless", "--chat", "--narration", "verbose"]);
    expect(chat?.type === "chat" && chat.opts.narration).toBe("verbose");
    const none = await parseHeadlessArgs(["--headless", "hi"]);
    expect(none?.type === "run" && none.opts.narration).toBeUndefined();
  });
});
