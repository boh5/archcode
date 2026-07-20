import {
  addUsage,
  createEmptySessionStats,
  type NormalizedUsage,
  type SessionGoal,
  type SessionGoalChangedEvent,
} from "@archcode/protocol";
import { SessionStoreManager } from "../store/session-store-manager";
import type { SessionStoreState } from "../store/types";
import { SessionGoalObjectiveSchema, SessionGoalSchema } from "./schema";

export type SessionGoalAuthority =
  | { readonly kind: "user_control" }
  | { readonly kind: "agent" }
  | { readonly kind: "runtime" };

export interface SessionGoalTarget {
  readonly workspaceRoot: string;
  readonly sessionId: string;
}

export class SessionGoalServiceError extends Error {
  constructor(
    public readonly code:
      | "NOT_ROOT_ENGINEER"
      | "GOAL_NOT_FOUND"
      | "GOAL_ALREADY_ACTIVE"
      | "GOAL_TERMINAL"
      | "GENERATION_CONFLICT"
      | "INVALID_TRANSITION"
      | "AUTHORITY_DENIED",
    message: string,
  ) {
    super(message);
    this.name = "SessionGoalServiceError";
  }
}

export class SessionGoalService {
  constructor(private readonly sessions: SessionStoreManager) {}

  async get(target: SessionGoalTarget): Promise<SessionGoal | undefined> {
    return (await this.sessions.getSessionFile(target.workspaceRoot, target.sessionId)).goal;
  }

  async create(input: SessionGoalTarget & {
    readonly authority: SessionGoalAuthority;
    readonly objective: string;
    readonly tokenBudget?: number;
  }): Promise<SessionGoal> {
    requireAuthority(input.authority, "user_control");
    const objective = SessionGoalObjectiveSchema.parse(input.objective);
    return await this.mutate(input, (state, now) => {
      if (state.goal !== undefined && state.goal.status !== "complete") {
        throw new SessionGoalServiceError("GOAL_ALREADY_ACTIVE", "A non-terminal Goal already exists");
      }
      const goal = checkedGoal({
        instanceId: crypto.randomUUID(),
        generation: 1,
        objective,
        status: "active",
        ...(input.tokenBudget === undefined ? {} : { tokenBudget: positiveInt(input.tokenBudget, "tokenBudget") }),
        usage: { tokens: createEmptySessionStats().usage, executionTimeMs: 0, executionCount: 0 },
        createdAt: now,
        activatedAt: now,
        updatedAt: now,
      });
      return change(goal, "created", now);
    });
  }

  async edit(input: SessionGoalTarget & {
    readonly authority: SessionGoalAuthority;
    readonly expectedGeneration: number;
    readonly objective: string;
  }): Promise<SessionGoal> {
    requireAuthority(input.authority, "user_control");
    const objective = SessionGoalObjectiveSchema.parse(input.objective);
    return await this.mutate(input, (state, now) => {
      const current = goalAtGeneration(state, input.expectedGeneration);
      const goal = checkedGoal({
        ...current,
        generation: current.generation + 1,
        objective,
        updatedAt: now,
      });
      return change(goal, "edited", now);
    });
  }

  async pause(input: SessionGoalTarget & { readonly authority: SessionGoalAuthority }): Promise<SessionGoal> {
    requireAuthority(input.authority, "user_control");
    return await this.mutate(input, (state, now) => {
      const current = nonTerminalGoal(state);
      if (current.status === "paused") return unchanged(current);
      if (current.status === "budget_limited") {
        if (current.pausedAt !== undefined) return unchanged(current);
        return change(checkedGoal({
          ...current,
          pausedAt: now,
          blockedReason: undefined,
          updatedAt: now,
        }), "paused", now);
      }
      if (current.status !== "active") {
        throw new SessionGoalServiceError("INVALID_TRANSITION", `Cannot pause Goal from ${current.status}`);
      }
      return change(checkedGoal({
        ...current,
        status: "paused",
        pausedAt: now,
        blockedReason: undefined,
        updatedAt: now,
      }), "paused", now);
    });
  }

  async resume(input: SessionGoalTarget & { readonly authority: SessionGoalAuthority }): Promise<SessionGoal> {
    requireAuthority(input.authority, "user_control");
    return await this.mutate(input, (state, now) => {
      const current = nonTerminalGoal(state);
      if (current.status !== "paused" && current.status !== "blocked" && current.status !== "budget_limited") {
        throw new SessionGoalServiceError("INVALID_TRANSITION", `Cannot resume Goal from ${current.status}`);
      }
      if (current.tokenBudget !== undefined && current.usage.tokens.totalTokens >= current.tokenBudget) {
        throw new SessionGoalServiceError("INVALID_TRANSITION", "Increase the token budget before resuming");
      }
      return change(checkedGoal({
        ...current,
        status: "active",
        pausedAt: undefined,
        blockedReason: undefined,
        updatedAt: now,
      }), "resumed", now);
    });
  }

  async clear(input: SessionGoalTarget & { readonly authority: SessionGoalAuthority }): Promise<void> {
    requireAuthority(input.authority, "user_control");
    await this.sessions.commitDurableSessionMutation(input.sessionId, input.workspaceRoot, (state) => {
      assertRootEngineer(state);
      const goal = requiredGoal(state);
      const occurredAt = Date.now();
      return {
        result: undefined,
        patch: { goal: undefined },
        events: [eventFor(goal, "cleared", occurredAt)],
      };
    });
  }

  async setTokenBudget(input: SessionGoalTarget & {
    readonly authority: SessionGoalAuthority;
    readonly tokenBudget?: number;
  }): Promise<SessionGoal> {
    requireAuthority(input.authority, "user_control");
    return await this.mutate(input, (state, now) => {
      const current = nonTerminalGoal(state);
      const tokenBudget = input.tokenBudget === undefined ? undefined : positiveInt(input.tokenBudget, "tokenBudget");
      const exhausted = tokenBudget !== undefined && current.usage.tokens.totalTokens >= tokenBudget;
      const status = exhausted
        ? "budget_limited" as const
        : current.status === "budget_limited"
          ? current.pausedAt !== undefined
            ? "paused" as const
            : current.blockedReason !== undefined
              ? "blocked" as const
              : "active" as const
          : current.status;
      return change(checkedGoal({
        ...current,
        tokenBudget,
        status,
        updatedAt: now,
      }), "budget_updated", now);
    });
  }

  async recordUsage(input: SessionGoalTarget & {
    readonly authority: SessionGoalAuthority;
    readonly usage: NormalizedUsage;
    readonly executionTimeMs: number;
  }): Promise<SessionGoal> {
    requireAuthority(input.authority, "runtime");
    return await this.mutate(input, (state, now) => {
      const current = requiredGoal(state);
      const tokens = addUsage(current.usage.tokens, input.usage);
      const budgetLimited = current.status !== "complete"
        && current.tokenBudget !== undefined
        && tokens.totalTokens >= current.tokenBudget;
      const goal = checkedGoal({
        ...current,
        status: budgetLimited ? "budget_limited" : current.status,
        usage: {
          tokens,
          executionTimeMs: current.usage.executionTimeMs + nonNegativeInt(input.executionTimeMs, "executionTimeMs"),
          executionCount: current.usage.executionCount + 1,
        },
        updatedAt: now,
      });
      return change(goal, "usage_recorded", now);
    });
  }

  async block(input: SessionGoalTarget & {
    readonly authority: SessionGoalAuthority;
    readonly reason: string;
  }): Promise<SessionGoal> {
    requireAuthority(input.authority, "agent");
    return await this.mutate(input, (state, now) => {
      const current = requireActiveGoal(state);
      const reason = requiredText(input.reason, "reason");
      return change(checkedGoal({
        ...current,
        status: "blocked",
        blockedReason: reason,
        updatedAt: now,
      }), "blocked", now, reason);
    });
  }

  async complete(input: SessionGoalTarget & {
    readonly authority: SessionGoalAuthority;
    readonly reason: string;
  }): Promise<SessionGoal> {
    requireAuthority(input.authority, "agent");
    return await this.mutate(input, (state, now) => {
      const current = requireActiveGoal(state);
      const reason = requiredText(input.reason, "reason");
      return change(checkedGoal({
        ...current,
        status: "complete",
        completedAt: now,
        updatedAt: now,
      }), "completed", now, reason);
    });
  }

  private async mutate(
    target: SessionGoalTarget,
    operation: (state: Readonly<SessionStoreState>, now: number) => MutationResult,
  ): Promise<SessionGoal> {
    return await this.sessions.commitDurableSessionMutation(target.sessionId, target.workspaceRoot, (state) => {
      assertRootEngineer(state);
      const outcome = operation(state, Date.now());
      return { result: outcome.goal, patch: { goal: outcome.goal }, events: outcome.events };
    });
  }
}

interface MutationResult {
  readonly goal: SessionGoal;
  readonly events?: readonly SessionGoalChangedEvent[];
}

function change(goal: SessionGoal, action: SessionGoalChangedEvent["action"], now: number, reason?: string): MutationResult {
  return { goal, events: [eventFor(goal, action, now, reason)] };
}

function unchanged(goal: SessionGoal): MutationResult {
  return { goal };
}

function eventFor(goal: SessionGoal, action: SessionGoalChangedEvent["action"], occurredAt: number, reason?: string): SessionGoalChangedEvent {
  return {
    type: "session.goal_changed",
    action,
    instanceId: goal.instanceId,
    generation: goal.generation,
    goal: action === "cleared" ? null : goal,
    status: goal.status,
    ...(reason === undefined ? {} : { reason }),
    occurredAt,
  };
}

function checkedGoal(value: unknown): SessionGoal {
  return SessionGoalSchema.parse(value);
}

function assertRootEngineer(state: Readonly<SessionStoreState>): void {
  if (state.parentSessionId !== undefined || state.rootSessionId !== state.sessionId || state.agentName !== "engineer") {
    throw new SessionGoalServiceError("NOT_ROOT_ENGINEER", "Session Goals belong only to root Engineer Sessions");
  }
}

function requiredGoal(state: Readonly<SessionStoreState>): SessionGoal {
  if (state.goal === undefined) throw new SessionGoalServiceError("GOAL_NOT_FOUND", "Session has no Goal");
  return state.goal;
}

function nonTerminalGoal(state: Readonly<SessionStoreState>): SessionGoal {
  const goal = requiredGoal(state);
  if (goal.status === "complete") throw new SessionGoalServiceError("GOAL_TERMINAL", "Completed Goal is immutable");
  return goal;
}

function goalAtGeneration(state: Readonly<SessionStoreState>, expectedGeneration: number): SessionGoal {
  const goal = nonTerminalGoal(state);
  if (goal.generation !== expectedGeneration) {
    throw new SessionGoalServiceError("GENERATION_CONFLICT", `Expected generation ${expectedGeneration}, found ${goal.generation}`);
  }
  return goal;
}

function requireActiveGoal(state: Readonly<SessionStoreState>): SessionGoal {
  const goal = nonTerminalGoal(state);
  if (goal.status !== "active") throw new SessionGoalServiceError("INVALID_TRANSITION", `Goal is ${goal.status}, not active`);
  return goal;
}

function requireAuthority(authority: SessionGoalAuthority, expected: SessionGoalAuthority["kind"]): void {
  if (authority.kind !== expected) throw new SessionGoalServiceError("AUTHORITY_DENIED", `${expected} authority required`);
}

function requiredText(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new SessionGoalServiceError("INVALID_TRANSITION", `${field} must not be empty`);
  return trimmed;
}

function positiveInt(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new SessionGoalServiceError("INVALID_TRANSITION", `${field} must be a positive safe integer`);
  return value;
}

function nonNegativeInt(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new SessionGoalServiceError("INVALID_TRANSITION", `${field} must be a non-negative safe integer`);
  return value;
}
