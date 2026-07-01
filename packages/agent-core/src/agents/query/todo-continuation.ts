import type { Reminder, ExecutionEndEvent, SessionStoreState, StoredTodo } from "../../store/types";

export const TODO_REMINDER_STEP_INTERVAL = 10;
export const TODO_REMINDER_COOLDOWN_MS = 30_000;
export const TODO_REMINDER_MAX_COUNT = 10;

export const TODO_CONTINUATION_COOLDOWN_MS = 60_000;
export const TODO_CONTINUATION_MAX_COUNT = 5;
export const TODO_CONTINUATION_STAGNATION_THRESHOLD = 3;

export type ReminderBlockReason =
  | "no_pending_todos"
  | "cooldown"
  | "steps_since_write_below_threshold"
  | "pending_question"
  | "running_sub_agents"
  | "max_reminders";

export type ReminderCheckResult =
  | {
      should: true;
      pendingTodos: StoredTodo[];
      reminder: Reminder;
    }
  | {
      should: false;
      reason: ReminderBlockReason;
    };

export type ContinuationBlockReason =
  | "no_pending_todos"
  | "cooldown"
  | "pending_question"
  | "running_sub_agents"
  | "max_continuations"
  | "stagnation"
  | "disallowed_status";

export type ContinuationCheckResult =
  | {
      should: true;
      pendingTodos: StoredTodo[];
      reminder: Reminder;
    }
  | {
      should: false;
      reason: ContinuationBlockReason;
    };

export function getStepsSinceLastTodoWrite(state: SessionStoreState): number {
  const currentStepIndex = state.steps.length - 1;
  if (currentStepIndex < 0) return 0;
  if (state.lastTodoWriteStepIndex === null) return currentStepIndex + 1;
  return currentStepIndex - state.lastTodoWriteStepIndex;
}

export function getStepsSinceLastReminder(state: SessionStoreState): number {
  const currentStepIndex = state.steps.length - 1;
  if (currentStepIndex < 0) return TODO_REMINDER_STEP_INTERVAL;
  if (state.lastTodoReminderStepIndex === null) return currentStepIndex + 1;
  return currentStepIndex - state.lastTodoReminderStepIndex;
}

export function shouldInjectReminder(
  state: SessionStoreState,
  now: number,
): ReminderCheckResult {
  const pendingTodos = getPendingTodos(state.todos);
  if (pendingTodos.length === 0) {
    return { should: false, reason: "no_pending_todos" };
  }

  const stepsSinceWrite = getStepsSinceLastTodoWrite(state);
  if (stepsSinceWrite < TODO_REMINDER_STEP_INTERVAL) {
    return { should: false, reason: "steps_since_write_below_threshold" };
  }

  const stepsSinceReminder = getStepsSinceLastReminder(state);
  if (stepsSinceReminder < TODO_REMINDER_STEP_INTERVAL) {
    return { should: false, reason: "steps_since_write_below_threshold" };
  }

  const lastInjectionTime = findLastStepReminderInjectionTime(state.reminders);
  if (lastInjectionTime !== null && now - lastInjectionTime < TODO_REMINDER_COOLDOWN_MS) {
    return { should: false, reason: "cooldown" };
  }

  if (hasPendingQuestion(state)) {
    return { should: false, reason: "pending_question" };
  }

  if (state.todoStepReminderCount >= TODO_REMINDER_MAX_COUNT) {
    return { should: false, reason: "max_reminders" };
  }

  return {
    should: true,
    pendingTodos,
    reminder: createTodoReminderReminder(pendingTodos, now),
  };
}

export function shouldContinueAfterLoop(
  state: SessionStoreState,
  loopEndStatus: ExecutionEndEvent["status"],
  now: number,
): ContinuationCheckResult {
  if (!isLoopEndAllowed(loopEndStatus)) {
    return { should: false, reason: "disallowed_status" };
  }

  const pendingTodos = getPendingTodos(state.todos);
  if (pendingTodos.length === 0) {
    return { should: false, reason: "no_pending_todos" };
  }

  const lastInjectionTime = findLastLoopContinuationInjectionTime(state.reminders);
  if (lastInjectionTime !== null && now - lastInjectionTime < TODO_CONTINUATION_COOLDOWN_MS) {
    return { should: false, reason: "cooldown" };
  }

  if (hasPendingQuestion(state)) {
    return { should: false, reason: "pending_question" };
  }

  if (state.todoLoopContinuationCount >= TODO_CONTINUATION_MAX_COUNT) {
    return { should: false, reason: "max_continuations" };
  }

  if (hasStagnated(state, pendingTodos)) {
    const newStagnationCount = state.todoContinuationStagnationCount + 1;
    if (newStagnationCount >= TODO_CONTINUATION_STAGNATION_THRESHOLD) {
      return { should: false, reason: "stagnation" };
    }
  }

  return {
    should: true,
    pendingTodos,
    reminder: createTodoContinuationReminder(pendingTodos, now),
  };
}

export function isLoopEndAllowed(reason: string): boolean {
  return reason === "completed" || reason === "max_steps";
}

export function hasPendingQuestion(state: Pick<SessionStoreState, "messages">): boolean {
  const lastAssistantMessage = [...state.messages].reverse().find((message) => message.role === "assistant");

  return lastAssistantMessage?.parts.some(
    (part) =>
      part.type === "tool" &&
      part.toolName === "ask_user" &&
      (part.state === "pending" || part.state === "running"),
  ) ?? false;
}

function hasStagnated(
  state: SessionStoreState,
  currentPendingTodos: StoredTodo[],
): boolean {
  const lastPendingCount = state.lastTodoContinuationPendingCount;
  if (lastPendingCount === null) return false;

  // If count decreased, there's progress — no stagnation
  if (currentPendingTodos.length < lastPendingCount) return false;

  // If count increased, LLM added new tasks — not stagnation
  if (currentPendingTodos.length > lastPendingCount) return false;

  // Same count: check if any previously-pending todo was completed
  // (which means LLM completed old ones and added new ones = progress)
  // For simplicity and safety, same count with same stagnation counter means stagnation
  return true;
}

function getPendingTodos(todos: readonly StoredTodo[]): StoredTodo[] {
  return todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress");
}

function findLastStepReminderInjectionTime(reminders: readonly Reminder[]): number | null {
  let lastInjectionTime: number | null = null;

  for (const reminder of reminders) {
    if (reminder.source.type !== "todo_step_reminder") continue;
    if (lastInjectionTime === null || reminder.createdAt > lastInjectionTime) {
      lastInjectionTime = reminder.createdAt;
    }
  }

  return lastInjectionTime;
}

function findLastLoopContinuationInjectionTime(reminders: readonly Reminder[]): number | null {
  let lastInjectionTime: number | null = null;

  for (const reminder of reminders) {
    if (reminder.source.type !== "todo_loop_continuation") continue;
    if (lastInjectionTime === null || reminder.createdAt > lastInjectionTime) {
      lastInjectionTime = reminder.createdAt;
    }
  }

  return lastInjectionTime;
}

function createTodoReminderReminder(pendingTodos: StoredTodo[], now: number): Reminder {
  return {
    id: crypto.randomUUID(),
    source: { type: "todo_step_reminder", pendingTodos },
    delivery: "auto_inject",
    content: formatTodoReminderContent(pendingTodos),
    payload: { pendingTodos },
    createdAt: now,
    consumedAt: null,
  };
}

function createTodoContinuationReminder(pendingTodos: StoredTodo[], now: number): Reminder {
  return {
    id: crypto.randomUUID(),
    source: { type: "todo_loop_continuation", pendingTodos },
    delivery: "auto_inject",
    content: formatTodoContinuationContent(pendingTodos),
    payload: { pendingTodos },
    createdAt: now,
    consumedAt: null,
  };
}

function formatTodoReminderContent(pendingTodos: readonly StoredTodo[]): string {
  const todoLines = pendingTodos
    .map((todo) => `- [${todo.status === "in_progress" ? "x" : " "}] ${todo.content}`)
    .join("\n");
  return [
    "TODO REMINDER",
    "",
    "It's been a while since you updated your todo list. Consider using the",
    "todo_write tool to track progress if it's relevant to the current task.",
    "",
    "Current todos:",
    todoLines,
  ].join("\n");
}

function formatTodoContinuationContent(pendingTodos: readonly StoredTodo[]): string {
  const todoLines = pendingTodos
    .map((todo) => `- [${todo.status === "in_progress" ? "=" : " "}] ${todo.content}`)
    .join("\n");
  return [
    "TODO CONTINUATION",
    "",
    "The following tasks are not yet completed:",
    todoLines,
    "",
    "Please continue working. Do not stop.",
  ].join("\n");
}
