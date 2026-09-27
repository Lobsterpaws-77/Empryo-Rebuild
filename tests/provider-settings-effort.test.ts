import { describe, expect, test } from "bun:test";
import { resolveOptions } from "../src/components/settings/ProviderSettings.js";

const OPENAI_EFFORT_OPTIONS = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max"];

describe("/provider-settings → OpenAI → Effort options", () => {
  test("a Codex active model gets the full range, including xhigh and max", () => {
    for (const model of ["codex/gpt-6-luna", "codex/gpt-5.5"]) {
      expect(resolveOptions("openaiReasoningEffort", OPENAI_EFFORT_OPTIONS, model)).toEqual(
        OPENAI_EFFORT_OPTIONS,
      );
    }
  });

  test("other active models keep the OpenAI API range (no xhigh/max)", () => {
    for (const model of ["openai/gpt-5", "anthropic/claude-opus-4-7"]) {
      expect(resolveOptions("openaiReasoningEffort", OPENAI_EFFORT_OPTIONS, model)).toEqual([
        "off",
        "none",
        "minimal",
        "low",
        "medium",
        "high",
      ]);
    }
  });
});
