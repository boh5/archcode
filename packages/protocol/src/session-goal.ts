import type { NormalizedUsage } from "./types";

export const SESSION_GOAL_OBJECTIVE_MAX_LENGTH = 4_000;

export const SESSION_GOAL_STATUSES = [
  "active",
  "paused",
  "blocked",
  "budget_limited",
  "complete",
] as const;

export type SessionGoalStatus = typeof SESSION_GOAL_STATUSES[number];

export interface SessionGoalUsage {
  tokens: NormalizedUsage;
  executionTimeMs: number;
  executionCount: number;
}

export interface SessionGoal {
  instanceId: string;
  generation: number;
  objective: string;
  status: SessionGoalStatus;
  tokenBudget?: number;
  usage: SessionGoalUsage;
  /** Retained while a higher-priority budget gate is visible. */
  blockedReason?: string;
  createdAt: number;
  activatedAt: number;
  updatedAt: number;
  /** Retained while a higher-priority budget gate is visible. */
  pausedAt?: number;
  completedAt?: number;
}

export const SESSION_GOAL_CHANGE_ACTIONS = [
  "created",
  "edited",
  "paused",
  "resumed",
  "cleared",
  "budget_updated",
  "blocked",
  "usage_recorded",
  "completed",
] as const;

export type SessionGoalChangeAction = typeof SESSION_GOAL_CHANGE_ACTIONS[number];

/** Durable Session event carrying the canonical post-mutation Goal snapshot. */
export interface SessionGoalChangedEvent {
  type: "session.goal_changed";
  action: SessionGoalChangeAction;
  instanceId: string;
  generation: number;
  goal: SessionGoal | null;
  status?: SessionGoalStatus;
  reason?: string;
  occurredAt: number;
}
