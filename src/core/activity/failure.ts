/**
 * Failure / retry attribution — classify an error into a stable category so
 * activity, model-events and diagnostics can say WHY something failed or
 * retried, not just that it did.
 *
 * Pure and read-only: it mirrors the patterns the retry loops already use
 * (useChat isTransient/isConnErr, agent-runner isRetryable) but never changes
 * a retry decision.
 */

export type FailureCategory =
  | "cancelled"
  | "stall-watchdog"
  | "strict-routing"
  | "context-limit"
  | "provider-rate-limit"
  | "provider-overloaded"
  | "provider-auth"
  | "provider-http"
  | "provider-stream-closed"
  | "network"
  | "timeout"
  | "tool-failure"
  | "dependency-failed"
  | "user-block"
  | "harness"
  | "unknown";

const LABEL: Record<FailureCategory, string> = {
  cancelled: "cancelled",
  "stall-watchdog": "provider stalled (watchdog)",
  "strict-routing": "strict routing refused",
  "context-limit": "context limit",
  "provider-rate-limit": "provider rate limit",
  "provider-overloaded": "provider overloaded",
  "provider-auth": "provider authentication",
  "provider-http": "provider API error",
  "provider-stream-closed": "provider stream closed",
  network: "network error",
  timeout: "timeout",
  "tool-failure": "tool failure",
  "dependency-failed": "dependency failed",
  "user-block": "blocked on user",
  harness: "harness error",
  unknown: "error",
};

export function failureLabel(category: FailureCategory): string {
  return LABEL[category];
}

function errorText(error: unknown): string {
  const parts: string[] = [];
  let cur: unknown = error;
  for (let i = 0; i < 5 && cur; i++) {
    if (cur instanceof Error) {
      parts.push(`${cur.name}: ${cur.message}`);
      cur = (cur as { cause?: unknown }).cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.join(" | ");
}

function statusOf(error: unknown): number | undefined {
  const s = (error as { statusCode?: unknown; status?: unknown } | null)?.statusCode;
  if (typeof s === "number") return s;
  const t = (error as { status?: unknown } | null)?.status;
  return typeof t === "number" ? t : undefined;
}

/** Classify an error. `hint` lets a caller that already knows the cause say so. */
export function classifyFailure(
  error: unknown,
  hint?: { aborted?: boolean; stall?: boolean; tool?: boolean },
): FailureCategory {
  if (hint?.stall) return "stall-watchdog";
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "StrictRoutingError") return "strict-routing";
  if (name === "DependencyFailedError") return "dependency-failed";
  const text = errorText(error).toLowerCase();
  const status = statusOf(error);

  if (
    /context.?(length|window|limit)|prompt is too long|too many tokens|maximum context/.test(text)
  )
    return "context-limit";
  if (status === 429 || /rate.?limit|too many requests|\b429\b/.test(text))
    return "provider-rate-limit";
  if (status === 529 || status === 503 || /overloaded|\b529\b|\b503\b|capacity/.test(text))
    return "provider-overloaded";
  if (
    status === 401 ||
    status === 403 ||
    /unauthori[sz]ed|invalid api key|\b401\b|\b403\b/.test(text)
  )
    return "provider-auth";
  if (/stream (?:error|closed)|premature close|terminated|socket hang up/.test(text))
    return "provider-stream-closed";
  if (
    /fetch failed|failed to fetch|econnreset|econnrefused|enotfound|eai_again|network|cannot connect|unable to connect|connection (?:error|reset|refused|closed)/.test(
      text,
    )
  )
    return "network";
  if (/timed out|timeout|etimedout/.test(text)) return "timeout";
  if (hint?.aborted || name === "AbortError" || /\baborted\b|cancel/.test(text)) return "cancelled";
  if (typeof status === "number" && status >= 400) return "provider-http";
  if (/ai_apicallerror|api call error|bad request|\b4\d\d\b|\b5\d\d\b/.test(text))
    return "provider-http";
  if (hint?.tool) return "tool-failure";
  if (error instanceof TypeError || error instanceof ReferenceError) return "harness";
  return "unknown";
}
