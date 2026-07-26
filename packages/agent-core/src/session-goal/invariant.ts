import type {
  GoalNoticePart,
  Reminder,
  SessionGoal,
  SessionGoalNoticeSnapshot,
  SessionMessage,
} from "@archcode/protocol";

export interface SessionGoalNoticeState {
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly parentSessionId?: string;
  readonly agentName: string;
  readonly goal?: SessionGoal;
  readonly messages: readonly SessionMessage[];
  readonly reminders: readonly Reminder[];
}

export function assertSessionGoalNoticeInvariant(state: SessionGoalNoticeState): void {
  const error = sessionGoalNoticeInvariantError(state);
  if (error !== undefined) throw new Error(error);
}

export function sessionGoalNoticeInvariantError(state: SessionGoalNoticeState): string | undefined {
  const goalReminders = state.reminders.filter((reminder): reminder is GoalReminder =>
    reminder.delivery === "model_context" && reminder.source.type === "session_goal_changed"
  );
  const goalMessages = state.messages.filter((message) =>
    message.parts.some((part) => part.type === "goal-notice")
  );
  const hasGoalHistory = goalReminders.length > 0 || goalMessages.length > 0;

  if ((state.goal !== undefined || hasGoalHistory) && !isRootLead(state)) {
    return "Session Goal notices and reminders belong only to root Lead Sessions";
  }

  const remindersById = new Map<string, GoalReminder>();
  let pendingSeen = false;
  const consumedReminderIds: string[] = [];
  for (const reminder of goalReminders) {
    if (remindersById.has(reminder.id)) {
      return `Session Goal reminder id ${reminder.id} is duplicated`;
    }
    remindersById.set(reminder.id, reminder);
    if (reminder.consumedAt === null) {
      pendingSeen = true;
      if (state.messages.some((message) => message.id === reminder.id)) {
        return `Pending Session Goal reminder ${reminder.id} must not have a materialized message`;
      }
      continue;
    }
    if (pendingSeen) {
      return `Consumed Session Goal reminder ${reminder.id} cannot follow a pending Goal reminder`;
    }
    consumedReminderIds.push(reminder.id);
    const message = state.messages.find((candidate) => candidate.id === reminder.id);
    if (!isExactGoalNoticeMessage(message, reminder.source.notice)) {
      return `Consumed Session Goal reminder ${reminder.id} has no exact internal message`;
    }
  }

  const messageIds: string[] = [];
  const seenMessageIds = new Set<string>();
  for (const message of goalMessages) {
    const notice = message.parts.find((part): part is GoalNoticePart => part.type === "goal-notice");
    if (notice === undefined) continue;
    if (seenMessageIds.has(notice.id)) {
      return `Session Goal message id ${notice.id} is duplicated`;
    }
    seenMessageIds.add(notice.id);
    messageIds.push(notice.id);
    const reminder = remindersById.get(notice.id);
    if (reminder === undefined || !sameGoalNotice(reminder.source.notice, notice)) {
      return `Session Goal message ${notice.id} has no matching reminder`;
    }
    if (reminder.consumedAt === null) {
      return `Session Goal message ${notice.id} belongs to a pending reminder`;
    }
  }
  if (!sameOrder(messageIds, consumedReminderIds)) {
    return "Materialized Session Goal messages do not preserve reminder append order";
  }

  if (!hasGoalHistory) {
    return state.goal === undefined
      ? undefined
      : `Session Goal ${state.goal.instanceId} generation ${state.goal.generation} has no pending or materialized Goal notice`;
  }

  const latestProof = goalReminders.at(-1)!.source.notice;
  if (state.goal === undefined) {
    return latestProof.action === "cleared" && latestProof.goal === null
      ? undefined
      : "Session has no Goal but its latest Goal notice is not cleared";
  }
  return noticeProvesGoal(latestProof, state.goal)
    ? undefined
    : `Session Goal ${state.goal.instanceId} generation ${state.goal.generation} does not match its latest pending or materialized Goal notice`;
}

export function goalSnapshot(goal: SessionGoal): SessionGoalNoticeSnapshot {
  return {
    objective: goal.objective,
    status: goal.status,
    ...(goal.tokenBudget === undefined ? {} : { tokenBudget: goal.tokenBudget }),
    ...(goal.blockedReason === undefined ? {} : { blockedReason: goal.blockedReason }),
  };
}

function isExactGoalNoticeMessage(
  message: SessionMessage | undefined,
  notice: GoalNoticePart,
): boolean {
  return message !== undefined
    && message.id === notice.id
    && message.role === "user"
    && message.parts.length === 1
    && message.parts[0]?.type === "goal-notice"
    && sameGoalNotice(message.parts[0], notice)
    && message.createdAt === notice.createdAt
    && message.completedAt === notice.createdAt
    && message.clientRequestId === undefined
    && message.modelAudit === undefined
    && message.executionId === undefined;
}

type GoalReminder = Reminder & {
  readonly source: Extract<Reminder["source"], { type: "session_goal_changed" }>;
};

function isRootLead(state: SessionGoalNoticeState): boolean {
  return state.agentName === "lead"
    && state.sessionId === state.rootSessionId
    && state.parentSessionId === undefined;
}

function noticeProvesGoal(notice: GoalNoticePart, goal: SessionGoal): boolean {
  return notice.instanceId === goal.instanceId
    && notice.generation === goal.generation
    && notice.goal !== null
    && sameSnapshot(notice.goal, goalSnapshot(goal));
}

function sameGoalNotice(left: GoalNoticePart, right: GoalNoticePart): boolean {
  return left.type === right.type
    && left.id === right.id
    && left.action === right.action
    && left.authority === right.authority
    && left.instanceId === right.instanceId
    && left.previousGeneration === right.previousGeneration
    && left.generation === right.generation
    && left.createdAt === right.createdAt
    && (
      left.goal === null
        ? right.goal === null
        : right.goal !== null && sameSnapshot(left.goal, right.goal)
    );
}

function sameSnapshot(left: SessionGoalNoticeSnapshot, right: SessionGoalNoticeSnapshot): boolean {
  return left.objective === right.objective
    && left.status === right.status
    && left.tokenBudget === right.tokenBudget
    && left.blockedReason === right.blockedReason;
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
