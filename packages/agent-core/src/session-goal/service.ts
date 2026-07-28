import {
  addUsage,
  createEmptySessionStats,
  type GoalNoticePart,
  type NormalizedUsage,
  type Reminder,
  type SessionGoal,
  type SessionGoalChangedEvent,
  type SessionGoalNoticeAction,
  type SessionMessage,
} from "@archcode/protocol";
import { SessionStoreManager } from "../store/session-store-manager";
import type { SessionStoreState } from "../store/types";
import {
  goalSnapshot,
  sessionGoalNoticeInvariantError,
} from "./invariant";
import {
  GoalNoticePartSchema,
  SessionGoalBlockedReasonSchema,
  SessionGoalObjectiveSchema,
  SessionGoalSchema,
} from "./schema";

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
      | "NOT_ROOT_LEAD"
      | "GOAL_NOT_FOUND"
      | "GOAL_ALREADY_ACTIVE"
      | "GOAL_TERMINAL"
      | "PENDING_SETTLEMENTS"
      | "GENERATION_CONFLICT"
      | "INVALID_TRANSITION"
      | "AUTHORITY_DENIED"
      | "CONTRACT_VIOLATION",
    message: string,
  ) {
    super(message);
    this.name = "SessionGoalServiceError";
  }
}

export class SessionGoalService {
  readonly #operationTails = new Map<string, Promise<void>>();

  constructor(private readonly sessions: SessionStoreManager) {}

  async get(target: SessionGoalTarget): Promise<SessionGoal | undefined> {
    return (await this.sessions.getSessionFile(target.workspaceRoot, target.sessionId)).goal;
  }

  async create(input: SessionGoalTarget & {
    readonly authority: SessionGoalAuthority;
    readonly objective: string;
  }): Promise<SessionGoal> {
    requireAuthority(input.authority, "user_control");
    const objective = SessionGoalObjectiveSchema.parse(input.objective);
    const current = await this.sessions.getSessionFile(input.workspaceRoot, input.sessionId);
    if (current.goal?.status === "complete") {
      // Goal completion has already fenced live descendants, and startup replay
      // finishes before requests open. This scan closes the remaining
      // receipt-written/session-not-yet-marked crash window before replacement.
      await this.#assertNoPendingFamilySettlements(input, current.goal.instanceId);
    }
    return await this.mutate(input, (state, now) => {
      if (state.goal !== undefined && state.goal.status !== "complete") {
        throw new SessionGoalServiceError("GOAL_ALREADY_ACTIVE", "A non-terminal Goal already exists");
      }
      if (state.goal !== undefined) assertNoPendingGoalSettlements(state, state.goal.instanceId);
      const goal = checkedGoal({
        instanceId: crypto.randomUUID(),
        generation: 1,
        objective,
        status: "active",
        usage: { tokens: createEmptySessionStats().usage, executionTimeMs: 0, executionCount: 0 },
        settlementReceipts: [],
        createdAt: now,
        activatedAt: now,
        updatedAt: now,
      });
      return semanticChange(goal, "created", "created", input.authority.kind, now);
    });
  }

  async assertNoPendingFamilySettlements(target: SessionGoalTarget): Promise<void> {
    const goal = await this.get(target);
    if (goal === undefined) return;
    await this.#assertNoPendingFamilySettlements(target, goal.instanceId);
  }

  async #assertNoPendingFamilySettlements(
    target: SessionGoalTarget,
    goalInstanceId: string,
  ): Promise<void> {
    for (const settlement of await this.sessions.listUnappliedExecutionSettlements(target.workspaceRoot)) {
      if (settlement.goalInstanceId !== goalInstanceId) continue;
      const settlementRootSessionId = await this.sessions.resolveRootSessionId(
        settlement.sessionId,
        target.workspaceRoot,
      );
      if (settlementRootSessionId === target.sessionId) {
        throw new SessionGoalServiceError(
          "PENDING_SETTLEMENTS",
          "Goal has unapplied Execution settlements in its Session family",
        );
      }
    }
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
      return semanticChange(
        goal,
        "edited",
        "edited",
        input.authority.kind,
        now,
        current.generation,
      );
    });
  }

  async pause(input: SessionGoalTarget & { readonly authority: SessionGoalAuthority }): Promise<SessionGoal> {
    requireAuthority(input.authority, "user_control");
    return await this.mutate(input, (state, now) => {
      const current = nonTerminalGoal(state);
      if (current.status === "paused") return unchanged(current);
      if (current.status === "budget_limited") {
        if (current.pausedAt !== undefined) return unchanged(current);
        return semanticChange(checkedGoal({
          ...current,
          pausedAt: now,
          blockedReason: undefined,
          updatedAt: now,
        }), "paused", "paused", input.authority.kind, now);
      }
      if (current.status !== "active") {
        throw new SessionGoalServiceError("INVALID_TRANSITION", `Cannot pause Goal from ${current.status}`);
      }
      return semanticChange(checkedGoal({
        ...current,
        status: "paused",
        pausedAt: now,
        blockedReason: undefined,
        updatedAt: now,
      }), "paused", "paused", input.authority.kind, now);
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
      return semanticChange(checkedGoal({
        ...current,
        status: "active",
        pausedAt: undefined,
        blockedReason: undefined,
        updatedAt: now,
      }), "resumed", "resumed", input.authority.kind, now);
    });
  }

  async clear(input: SessionGoalTarget & { readonly authority: SessionGoalAuthority }): Promise<void> {
    requireAuthority(input.authority, "user_control");
    await this.#serial(input, async () => {
      await this.sessions.commitDurableSessionMutation(input.sessionId, input.workspaceRoot, (state) => {
        assertRootLead(state);
        assertGoalContract(state);
        const goal = requiredGoal(state);
        assertNoPendingGoalSettlements(state, goal.instanceId);
        const occurredAt = Date.now();
        const reminder = goalReminder({
          goal,
          action: "cleared",
          authority: input.authority.kind,
          now: occurredAt,
        });
        return {
          result: undefined,
          events: [
            eventFor(goal, "cleared", occurredAt),
            { type: "reminder", reminder },
          ],
        };
      });
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
      if (current.tokenBudget === tokenBudget && current.status === status) return unchanged(current);
      return semanticChange(checkedGoal({
        ...current,
        tokenBudget,
        status,
        updatedAt: now,
      }), "budget_updated", "budget_updated", input.authority.kind, now);
    });
  }

  async recordSettlement(input: SessionGoalTarget & {
    readonly authority: SessionGoalAuthority;
    readonly settlementKey: string;
    readonly goalInstanceId: string;
    readonly usage: NormalizedUsage;
    readonly executionTimeMs: number;
    readonly terminal: boolean;
  }): Promise<SessionGoal> {
    requireAuthority(input.authority, "runtime");
    const settlementKey = requiredText(input.settlementKey, "settlementKey");
    return await this.mutate(input, (state, now) => {
      const current = requiredGoal(state);
      if (current.instanceId !== input.goalInstanceId) {
        throw new SessionGoalServiceError(
          "GENERATION_CONFLICT",
          `Expected Goal ${input.goalInstanceId}, found ${current.instanceId}`,
        );
      }
      if (current.settlementReceipts.includes(settlementKey)) return unchanged(current);
      const tokens = addUsage(current.usage.tokens, input.usage);
      const budgetLimited = current.status !== "complete"
        && current.tokenBudget !== undefined
        && tokens.totalTokens >= current.tokenBudget;
      const status = budgetLimited ? "budget_limited" as const : current.status;
      const goal = checkedGoal({
        ...current,
        status,
        usage: {
          tokens,
          executionTimeMs: current.usage.executionTimeMs + nonNegativeInt(input.executionTimeMs, "executionTimeMs"),
          executionCount: current.usage.executionCount + (input.terminal ? 1 : 0),
        },
        settlementReceipts: [...current.settlementReceipts, settlementKey].sort((left, right) => left.localeCompare(right)),
        // Usage is telemetry, not a semantic Goal revision. Keep updatedAt stable
        // unless usage itself crosses the budget boundary and changes status so
        // a review created during an Execution is not invalidated by settlement.
        updatedAt: status === current.status ? current.updatedAt : now,
      });
      return status === current.status
        ? persistedChange(goal, "usage_recorded", now)
        : semanticChange(goal, "usage_recorded", "budget_limited", input.authority.kind, now);
    });
  }

  async block(input: SessionGoalTarget & {
    readonly authority: SessionGoalAuthority;
    readonly reason: string;
  }): Promise<SessionGoal> {
    requireAuthority(input.authority, "agent");
    return await this.mutate(input, (state, now) => {
      const current = requireActiveGoal(state);
      const reason = SessionGoalBlockedReasonSchema.parse(input.reason);
      return semanticChange(checkedGoal({
        ...current,
        status: "blocked",
        blockedReason: reason,
        updatedAt: now,
      }), "blocked", "blocked", input.authority.kind, now, undefined, reason);
    });
  }

  async complete(input: SessionGoalTarget & {
    readonly authority: SessionGoalAuthority;
    readonly reason: string;
    readonly expectedInstanceId: string;
    readonly expectedGeneration: number;
  }): Promise<SessionGoal> {
    requireAuthority(input.authority, "agent");
    return await this.mutate(input, (state, now) => {
      const current = activeGoalAtIdentity(state, input.expectedInstanceId, input.expectedGeneration);
      const reason = requiredText(input.reason, "reason");
      return semanticChange(checkedGoal({
        ...current,
        status: "complete",
        completedAt: now,
        updatedAt: now,
      }), "completed", "completed", input.authority.kind, now, undefined, reason);
    });
  }

  async materializeModelContextNotices(target: SessionGoalTarget): Promise<void> {
    await this.#serial(target, async () => {
      await this.sessions.commitDurableSessionMutation(target.sessionId, target.workspaceRoot, (state) => {
        assertRootLead(state);
        assertGoalContract(state);
        const highWater = state.reminders.length;
        const pending = state.reminders.slice(0, highWater).filter(isPendingGoalReminder);
        if (pending.length === 0) return { result: undefined };

        const consumedAt = Date.now();
        const messages = [...state.messages];
        const messageIds = new Set(messages.map((message) => message.id));
        for (const reminder of pending) {
          const notice = reminder.source.notice;
          if (messageIds.has(notice.id)) {
            throw contractViolation(`Pending Goal notice id ${notice.id} already exists as a Session message`);
          }
          messages.push(messageFor(notice));
          messageIds.add(notice.id);
        }

        const pendingIds = new Set(pending.map((reminder) => reminder.id));
        const reminders = state.reminders.map((reminder, index) =>
          index < highWater && pendingIds.has(reminder.id) && reminder.consumedAt === null
            ? { ...reminder, consumedAt }
            : reminder
        );
        assertGoalContract({ ...state, messages, reminders });
        return {
          result: undefined,
          patch: { messages, reminders },
        };
      });
    });
  }

  private async mutate(
    target: SessionGoalTarget,
    operation: (state: Readonly<SessionStoreState>, now: number) => MutationResult,
  ): Promise<SessionGoal> {
    return await this.#serial(target, async () => {
      return await this.sessions.commitDurableSessionMutation(target.sessionId, target.workspaceRoot, (state) => {
        assertRootLead(state);
        assertGoalContract(state);
        const outcome = operation(state, Date.now());
        if (outcome.event === undefined) return { result: outcome.goal };

        const events: Array<SessionGoalChangedEvent | { type: "reminder"; reminder: Reminder }> = [
          eventFor(outcome.goal, outcome.event.action, outcome.event.occurredAt, outcome.event.reason),
        ];
        if (outcome.notice !== undefined) {
          const reminder = goalReminder({
            goal: outcome.goal,
            action: outcome.notice.action,
            authority: outcome.notice.authority,
            now: outcome.event.occurredAt,
            previousGeneration: outcome.notice.previousGeneration,
          });
          events.push({ type: "reminder", reminder });
          assertGoalContract({
            ...state,
            goal: outcome.goal,
            reminders: [...state.reminders, reminder],
          });
        } else {
          assertGoalContract({
            ...state,
            goal: outcome.goal,
          });
        }
        return { result: outcome.goal, events };
      });
    });
  }

  async #serial<T>(target: SessionGoalTarget, operation: () => Promise<T>): Promise<T> {
    const key = `${target.workspaceRoot}\0${target.sessionId}`;
    const prior = this.#operationTails.get(key) ?? Promise.resolve();
    const result = prior.then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.#operationTails.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.#operationTails.get(key) === tail) this.#operationTails.delete(key);
    }
  }
}

interface MutationResult {
  readonly goal: SessionGoal;
  readonly event?: {
    readonly action: SessionGoalChangedEvent["action"];
    readonly occurredAt: number;
    readonly reason?: string;
  };
  readonly notice?: {
    readonly action: SessionGoalNoticeAction;
    readonly authority: SessionGoalAuthority["kind"];
    readonly previousGeneration?: number;
  };
}

function semanticChange(
  goal: SessionGoal,
  eventAction: SessionGoalChangedEvent["action"],
  noticeAction: SessionGoalNoticeAction,
  authority: SessionGoalAuthority["kind"],
  now: number,
  previousGeneration?: number,
  reason?: string,
): MutationResult {
  return {
    goal,
    event: { action: eventAction, occurredAt: now, ...(reason === undefined ? {} : { reason }) },
    notice: {
      action: noticeAction,
      authority,
      ...(previousGeneration === undefined ? {} : { previousGeneration }),
    },
  };
}

function persistedChange(
  goal: SessionGoal,
  action: SessionGoalChangedEvent["action"],
  now: number,
  reason?: string,
): MutationResult {
  return {
    goal,
    event: { action, occurredAt: now, ...(reason === undefined ? {} : { reason }) },
  };
}

function unchanged(goal: SessionGoal): MutationResult {
  return { goal };
}

function goalReminder(input: {
  readonly goal: SessionGoal;
  readonly action: SessionGoalNoticeAction;
  readonly authority: SessionGoalAuthority["kind"];
  readonly now: number;
  readonly previousGeneration?: number;
}): Reminder {
  const id = crypto.randomUUID();
  const notice = GoalNoticePartSchema.parse({
    type: "goal-notice",
    id,
    action: input.action,
    authority: input.authority,
    instanceId: input.goal.instanceId,
    ...(input.previousGeneration === undefined ? {} : {
      previousGeneration: input.previousGeneration,
    }),
    generation: input.goal.generation,
    goal: input.action === "cleared" ? null : goalSnapshot(input.goal),
    createdAt: input.now,
  });
  return {
    id,
    source: { type: "session_goal_changed", notice },
    delivery: "model_context",
    content: `Session Goal ${input.action}`,
    createdAt: input.now,
    consumedAt: null,
  };
}

function isPendingGoalReminder(
  reminder: Reminder,
): reminder is Reminder & {
  source: Extract<Reminder["source"], { type: "session_goal_changed" }>;
} {
  return reminder.delivery === "model_context"
    && reminder.consumedAt === null
    && reminder.source.type === "session_goal_changed";
}

function messageFor(notice: GoalNoticePart): SessionMessage {
  return {
    id: notice.id,
    role: "user",
    parts: [notice],
    createdAt: notice.createdAt,
    completedAt: notice.createdAt,
  };
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

function assertRootLead(state: Readonly<SessionStoreState>): void {
  if (state.parentSessionId !== undefined || state.rootSessionId !== state.sessionId || state.agentName !== "lead") {
    throw new SessionGoalServiceError("NOT_ROOT_LEAD", "Session Goals belong only to root Lead Sessions");
  }
}

function assertGoalContract(state: Readonly<SessionStoreState>): void {
  const error = sessionGoalNoticeInvariantError(state);
  if (error !== undefined) throw contractViolation(error);
}

function contractViolation(message: string): SessionGoalServiceError {
  return new SessionGoalServiceError("CONTRACT_VIOLATION", message);
}

function requiredGoal(state: Readonly<SessionStoreState>): SessionGoal {
  if (state.goal === undefined) throw new SessionGoalServiceError("GOAL_NOT_FOUND", "Session has no Goal");
  return state.goal;
}

function assertNoPendingGoalSettlements(
  state: Readonly<SessionStoreState>,
  goalInstanceId: string,
): void {
  for (const execution of state.executions) {
    for (const run of execution.runs) {
      const settlement = run.settlement;
      if (
        settlement !== undefined
        && settlement.goalInstanceId === goalInstanceId
        && settlement.appliedAt === undefined
      ) {
        throw new SessionGoalServiceError(
          "PENDING_SETTLEMENTS",
          "Goal has unapplied Execution settlements",
        );
      }
    }
    const terminalSettlement = execution.terminalSettlement;
    if (
      terminalSettlement !== undefined
      && terminalSettlement.goalInstanceId === goalInstanceId
      && terminalSettlement.appliedAt === undefined
    ) {
      throw new SessionGoalServiceError(
        "PENDING_SETTLEMENTS",
        "Goal has unapplied Execution settlements",
      );
    }
  }
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

function activeGoalAtIdentity(
  state: Readonly<SessionStoreState>,
  expectedInstanceId: string,
  expectedGeneration: number,
): SessionGoal {
  const goal = requireActiveGoal(state);
  if (goal.instanceId !== expectedInstanceId || goal.generation !== expectedGeneration) {
    throw new SessionGoalServiceError(
      "GENERATION_CONFLICT",
      `Expected Goal ${expectedInstanceId} generation ${expectedGeneration}, found ${goal.instanceId} generation ${goal.generation}`,
    );
  }
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
