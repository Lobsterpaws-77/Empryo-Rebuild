/**
 * The TUI activity line renders harness state (no model output involved),
 * including the explicit waiting-on-provider state after silence.
 */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { ActivityLine } from "../src/components/chat/ActivityLine.js";
import { getActivityTracker, reportActivity } from "../src/core/activity/activity.js";

test("shows the live tool label, then waiting-on-provider after silence", async () => {
  const actorId = "forge:activity-line-test";
  reportActivity({ type: "start", actorId, kind: "forge", name: "Forge" });
  reportActivity({ type: "tool-start", actorId, tool: "project", args: { action: "test" } });
  const setup = await testRender(<ActivityLine actorId={actorId} active />, { width: 80, height: 3 });
  await setup.flush();
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("Running tests");

  reportActivity({ type: "tool-end", actorId, tool: "project", ok: true });
  const s = getActivityTracker().get(actorId);
  if (s) s.lastEventAt = Date.now() - (8 * 60_000 + 14_000);
  // Let the activity-triggered state update commit, then paint.
  await setup.flush();
  await new Promise((r) => setTimeout(r, 5));
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("Waiting on provider — no activity for 8m 14s");
  setup.renderer.destroy();
});

test("renders nothing when inactive or ended", async () => {
  const actorId = "forge:activity-line-ended";
  reportActivity({ type: "start", actorId, kind: "forge", name: "Forge" });
  reportActivity({ type: "end", actorId, outcome: "done" });
  const setup = await testRender(<ActivityLine actorId={actorId} active />, { width: 80, height: 3 });
  await setup.flush();
  await setup.renderOnce();
  expect(setup.captureCharFrame().trim()).toBe("");
  setup.renderer.destroy();
});
