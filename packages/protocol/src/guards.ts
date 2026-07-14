import type { SessionEventPayload, StreamEvent, ToolChildSessionLinkStatus } from "./types";

const STREAM_EVENT_TYPES = new Set<StreamEvent["type"]>([
  "execution-start", "execution-end", "session.cwd_changed", "user-message", "system-notice",
  "text-start", "text-delta", "text-end", "reasoning-start", "reasoning-delta", "reasoning-end",
  "tool-input-start", "tool-call", "tool-input-resolved", "tool-attempt", "tool-result",
  "tool-child-session-link", "todo-write", "reminder", "reminder-consumed", "step-start", "step-end",
  "execution-error", "llm-retry", "llm-recovery", "llm-recovery-failed", "compact",
  "compression.block_committed", "compression.block_failed", "compression.ref_map_updated",
  "goal.state_change", "hitl.request", "hitl.updated", "hitl.resolved",
]);

const TERMINAL_CHILD_SESSION_STATUSES = new Set<ToolChildSessionLinkStatus>([
  "completed", "failed", "timed_out", "cancelled", "interrupted",
]);

export type TerminalChildSessionStatus = Extract<
  ToolChildSessionLinkStatus,
  "completed" | "failed" | "timed_out" | "cancelled" | "interrupted"
>;

export function isStreamEvent(event: SessionEventPayload): event is StreamEvent {
  return STREAM_EVENT_TYPES.has(event.type as StreamEvent["type"]);
}

export function isTerminalChildSessionStatus(
  status: ToolChildSessionLinkStatus,
): status is TerminalChildSessionStatus {
  return TERMINAL_CHILD_SESSION_STATUSES.has(status);
}
