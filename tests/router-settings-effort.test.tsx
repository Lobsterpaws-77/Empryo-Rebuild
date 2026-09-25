/**
 * /router shows per-lane effort next to the model, distinguishes explicit
 * values from inherited/fallback ones (↳), and `e` cycles a lane's effort.
 * Drives the real OpenTUI renderer headlessly.
 */

import { expect, test } from "bun:test";
import type { KeyInput } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { RouterSettings } from "../src/components/settings/RouterSettings.js";
import { resolveRoutingTable } from "../src/core/llm/lane-routing.js";
import type { TaskRouter } from "../src/types/index.js";

const PARENT = "anthropic/claude-opus-4-6";
const OPTS = { width: 120, height: 42 } as const;

async function mount(router: TaskRouter) {
  const cycled: Array<[string, number]> = [];
  const routes = resolveRoutingTable({ taskRouter: router, performance: { effort: "high" } }, PARENT);
  const setup = await testRender(
    <RouterSettings
      visible
      router={router}
      defaultModel={PARENT}
      modelFallback={undefined}
      activeModel={PARENT}
      scope="global"
      onScopeChange={() => {}}
      onPickSlot={() => {}}
      onClearSlot={() => {}}
      routes={routes}
      onCycleEffort={(lane, dir) => cycled.push([lane, dir])}
      onPickerChange={() => {}}
      onAddFallback={() => {}}
      onClearFallbacks={() => {}}
      onClose={() => {}}
    />,
    OPTS,
  );
  await setup.flush();
  await setup.renderOnce();
  const press = async (key: KeyInput) => {
    await setup.mockInput.pressKey(key);
    await setup.flush();
    await new Promise((r) => setTimeout(r, 1));
    await setup.renderOnce();
  };
  return { ...setup, cycled, press };
}

const lineWith = (frame: string, label: string) =>
  frame.split("\n").find((l) => l.includes(label)) ?? "";

test("explicit lane effort vs inherited effort are distinguishable", async () => {
  const router = {
    verify: "openai/gpt-5",
    effort: { verify: "low" },
    strict: { enabled: true, lanes: { verify: { models: ["openai/gpt-5"] } } },
  } as unknown as TaskRouter;
  const { captureCharFrame } = await mount(router);
  const frame = captureCharFrame();
  // Review lane: explicit model + explicit effort, strict-marked.
  const review = lineWith(frame, "Review");
  expect(review).toContain("openai/gpt-5");
  expect(review).toMatch(/\blow\b/);
  expect(review).not.toContain("↳low");
  expect(review).toContain("strict");
  // Code lane: inherits the Forge model and the global effort.
  const code = lineWith(frame, "Code ");
  expect(code).toContain("↳ claude-opus-4-6");
  expect(code).toContain("↳high");
  // Explore: built-in low (inherited marker)
  expect(lineWith(frame, "Explore")).toContain("↳low");
  expect(frame).toContain("strict");
});

test("`e` cycles the selected lane's effort; non-configurable lanes ignore it", async () => {
  const { press, cycled } = await mount({} as TaskRouter);
  // First selectable row is Default (not effort-configurable) → ignored.
  await press("e");
  expect(cycled).toEqual([]);
  // Down to Web Search, then Explore.
  await press("ARROW_DOWN");
  await press("ARROW_DOWN");
  await press("e");
  expect(cycled).toEqual([["spark", 1]]);
});
