// Loop status presentation helper — single source of truth for deriving
// the canonical user-facing current state/activity of a Loop.
//
// Authoritative inputs: currentRun.status + loop.status.
// lastRun is historical metadata only (shown as "last result"), never the
// primary current state. currentJob is a dead backend projection and must
// not be referenced here.
//
// Used by loops.tsx, loop-detail.tsx, and dashboard.tsx.

import type { LoopRunReportStatus, LoopRunTrigger, LoopStatus } from "../api/types";

// ─── Canonical display states ───

export type LoopDisplayState =
  | "running"
  | "waiting_for_input"
  | "ready"
  | "paused"
  | "disabled"
  | "error";

export interface LoopStatusInfo {
  state: LoopDisplayState;
  label: string;
  badgeClass: string;
  activity: string;
  canCancel: boolean;
}

// Minimal shape shared by LoopState and DashboardLoop. Both satisfy this
// structurally, so the helper works for list, detail, and dashboard surfaces.
// lastRun intentionally is not part of this input: history must not influence
// the current state presentation.
export interface LoopStatusInput {
  status: LoopStatus;
  currentRun?: LoopStatusRun;
}

export interface LoopStatusRun {
  status: LoopRunReportStatus;
  trigger: LoopRunTrigger;
  sessionId?: string;
}

// ─── State label / badge maps ───

const LOOP_STATE_LABEL: Record<LoopDisplayState, string> = {
  running: "Running",
  waiting_for_input: "Awaiting Input",
  ready: "Ready",
  paused: "Paused",
  disabled: "Disabled",
  error: "Error",
};

const LOOP_STATE_BADGE_CLASS: Record<LoopDisplayState, string> = {
  running: "bg-success-muted text-success",
  waiting_for_input: "bg-warning-muted text-warning",
  ready: "bg-bg-active text-text-secondary",
  paused: "bg-bg-active text-text-muted",
  disabled: "bg-bg-active text-text-tertiary",
  error: "bg-error-muted text-error",
};

// ─── State derivation ───

/**
 * Derive the canonical display state from authoritative fields.
 *
 * Priority:
 *   1. currentRun.status === "running"     → running
 *   2. currentRun.status === "needs_user"  → waiting_for_input
 *   3. loop.status === "error"             → error
 *   4. loop.status === "paused"            → paused
 *   5. loop.status === "disabled"           → disabled
 *   6. active with no current run           → ready (idle)
 */
export function deriveLoopDisplayState(input: LoopStatusInput): LoopDisplayState {
  const { status, currentRun } = input;

  if (currentRun?.status === "running") return "running";
  if (currentRun?.status === "needs_user") return "waiting_for_input";

  if (status === "error") return "error";
  if (status === "paused") return "paused";
  if (status === "disabled") return "disabled";

  return "ready";
}

export function deriveLoopStatus(input: LoopStatusInput): LoopStatusInfo {
  const state = deriveLoopDisplayState(input);
  return {
    state,
    label: LOOP_STATE_LABEL[state],
    badgeClass: LOOP_STATE_BADGE_CLASS[state],
    activity: formatLoopActivity(input),
    canCancel: input.currentRun?.status === "running",
  };
}

export function formatLoopActivity(input: LoopStatusInput): string {
  const run = input.currentRun;

  if (run?.status === "running") {
    return `Running ${run.trigger} run${run.sessionId ? ` (session ${run.sessionId})` : ""}`;
  }
  if (run?.status === "needs_user") {
    return "Waiting for user input";
  }

  switch (input.status) {
    case "error":
      return "Error";
    case "paused":
      return "Paused";
    case "disabled":
      return "Disabled";
    default:
      return "Ready";
  }
}

// ─── Historical run status (metadata, not current state) ───

export type RunHistoryLabel = "Running" | "Awaiting Input" | "Completed" | "Failed" | "Skipped" | "Cancelled";

const RUN_HISTORY_LABEL: Record<LoopRunReportStatus, RunHistoryLabel> = {
  running: "Running",
  succeeded: "Completed",
  failed: "Failed",
  budget_exceeded: "Failed",
  needs_user: "Awaiting Input",
  skipped: "Skipped",
  cancelled: "Cancelled",
};

const RUN_HISTORY_BADGE_CLASS: Record<RunHistoryLabel, string> = {
  Running: "bg-success-muted text-success",
  "Awaiting Input": "bg-warning-muted text-warning",
  Completed: "bg-accent-muted text-accent",
  Failed: "bg-error-muted text-error",
  Skipped: "bg-bg-active text-text-tertiary",
  Cancelled: "bg-bg-active text-text-tertiary",
};

export function formatRunHistoryLabel(status: LoopRunReportStatus): RunHistoryLabel {
  return RUN_HISTORY_LABEL[status];
}

export function formatRunHistoryBadgeClass(status: LoopRunReportStatus): string {
  return RUN_HISTORY_BADGE_CLASS[formatRunHistoryLabel(status)];
}
