export type RelativeTimeStyle = "full" | "short";

function requireFinite(value: number, name: string): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be a finite number`);
  }
  return value;
}

function nonNegativeDifference(later: number, earlier: number): number {
  return Math.max(0, requireFinite(later, "later") - requireFinite(earlier, "earlier"));
}

/**
 * Formats a timestamp relative to an explicit wall-clock snapshot.
 *
 * This helper is intentionally pure: callers that need a live value must obtain
 * `now` from the shared temporal clock.
 */
export function formatRelativeTime(
  timestamp: number,
  now: number,
  style: RelativeTimeStyle = "full",
): string {
  const seconds = Math.floor(nonNegativeDifference(now, timestamp) / 1_000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (style === "short") {
    if (seconds < 60) return "just now";
    if (minutes < 60) return `${minutes}m`;
    if (hours < 24) return `${hours}h`;
    if (days === 1) return "yesterday";
    return `${days}d ago`;
  }

  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

/** Formats a settled or explicitly computed elapsed duration. */
export function formatElapsedDuration(durationMs: number): string {
  const seconds = Math.floor(Math.max(0, requireFinite(durationMs, "durationMs")) / 1_000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (seconds < 60) return `${seconds}s`;
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${hours}h ${minutes % 60}m`;
}

/**
 * Formats the remaining time to a target. A reached target has no countdown.
 */
export function formatCountdown(targetAt: number, now: number): string | null {
  const remainingMs = requireFinite(targetAt, "targetAt") - requireFinite(now, "now");
  if (remainingMs <= 0) return null;

  const seconds = Math.ceil(remainingMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Full local absolute time used by relative-time tooltips. */
export function formatLocalDateTime(timestamp: number): string {
  return new Date(requireFinite(timestamp, "timestamp")).toLocaleString();
}
