/**
 * Harness activity rendering — token-free "what is happening now" for the
 * Forge and for workers, from core/activity. Independent of the verbose /
 * reasoning display switches (those only change how the stream is drawn).
 */

import { useEffect, useState } from "react";
import {
  type ActivityState,
  describeActivity,
  getActivityTracker,
  onActivity,
} from "../../core/activity/activity.js";
import { useTheme } from "../../core/theme/index.js";

/** Silence before a streaming actor is shown as "waiting on provider". */
const QUIET_MS = 15_000;

/** Re-render once a second (elapsed counters) and on every activity change for `actorId`. */
export function useActivity(actorId: string | undefined, active = true): ActivityState | undefined {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!actorId || !active) return;
    const bump = () => setTick((x) => (x + 1) % 1_000_000);
    const timer = setInterval(bump, 1000);
    const unsub = onActivity((s) => {
      if (s.actorId === actorId) bump();
    });
    return () => {
      clearInterval(timer);
      unsub();
    };
  }, [actorId, active]);
  return actorId ? getActivityTracker().get(actorId) : undefined;
}

export function activityColor(
  state: ActivityState,
  now: number,
  t: ReturnType<typeof useTheme>,
): string {
  const quiet = now - state.lastEventAt >= QUIET_MS;
  switch (state.phase) {
    case "failed":
      return t.error;
    case "retrying":
      return t.warning;
    case "blocked-user":
      return t.info;
    case "requesting":
    case "streaming":
    case "reasoning":
      return quiet ? t.warning : t.textMuted;
    default:
      return t.textMuted;
  }
}

export function describeForUi(state: ActivityState, now: number): string {
  return describeActivity(state, now, { quietMs: QUIET_MS });
}

/** One-line Forge status for a tab. Renders nothing when the tracker has no state. */
export function ActivityLine({ actorId, active }: { actorId: string; active: boolean }) {
  const t = useTheme();
  const state = useActivity(actorId, active);
  if (!active || !state || state.endedAt) return null;
  const now = Date.now();
  return (
    <box paddingX={1} height={1} flexShrink={0}>
      <text truncate fg={activityColor(state, now, t)}>
        {describeForUi(state, now)}
      </text>
    </box>
  );
}

/** Inline worker activity text (used inside dispatch cards). */
export function WorkerActivityText({ actorId }: { actorId: string }) {
  const t = useTheme();
  const state = useActivity(actorId, true);
  if (!state || state.endedAt) {
    return <span fg={t.textMuted}> thinking...</span>;
  }
  const now = Date.now();
  return <span fg={activityColor(state, now, t)}> {describeForUi(state, now)}</span>;
}
