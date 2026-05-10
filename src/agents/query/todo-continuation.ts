import type { Reminder, SessionStoreState, StoredTodo } from "../../store/types";

export const TODO_CONTINUATION_COOLDOWN_MS = 30_000;
export const TODO_CONTINUATION_STAGNATION_THRESHOLD = 3;
export const TODO_CONTINUATION_MAX_COUNT = 10;

export interface SubAgentManagerLike {
  readonly activeCount: number;
}

export interface StagnationResult {
  isStagnant: boolean;
  newCount: number;
  newHash: string;
}

export interface ContinuationCheckOptions {
  readonly stagnationCount?: number;
  readonly trigger?: "stagnation" | "loop_end";
}

export type ContinuationBlockReason =
  | "no_pending_todos"
  | "cooldown"
  | "not_stagnant"
  | "pending_question"
  | "running_sub_agents"
  | "max_continuations";

export type ContinuationInjectReason = "stagnation" | "loop_end";

export type ContinuationCheckResult =
  | {
      should: true;
      reason: ContinuationInjectReason;
      pendingTodos: StoredTodo[];
      reminder: Reminder;
    }
  | {
      should: false;
      reason: ContinuationBlockReason;
    };

export function computeTodoHash(todos: readonly StoredTodo[]): string {
  return hashString(JSON.stringify(todos.map((todo) => [todo.id, todo.status])));
}

export function checkStagnation(
  currentHash: string,
  lastHash: string | null,
  count: number,
): StagnationResult {
  const newCount = lastHash === currentHash ? count + 1 : 0;

  return {
    isStagnant: newCount >= TODO_CONTINUATION_STAGNATION_THRESHOLD,
    newCount,
    newHash: currentHash,
  };
}

export function shouldInjectContinuationReminder(
  state: SessionStoreState,
  now: number,
  continuationCount: number,
  subAgentManager?: SubAgentManagerLike,
  options: ContinuationCheckOptions = {},
): ContinuationCheckResult {
  const pendingTodos = getPendingTodos(state.todos);
  if (pendingTodos.length === 0) {
    return { should: false, reason: "no_pending_todos" };
  }

  const lastInjectionTime = findLastTodoContinuationInjectionTime(state.reminders);
  if (lastInjectionTime !== null && now - lastInjectionTime < TODO_CONTINUATION_COOLDOWN_MS) {
    return { should: false, reason: "cooldown" };
  }

  const trigger = options.trigger ?? "stagnation";
  if (
    trigger === "stagnation" &&
    (options.stagnationCount ?? 0) < TODO_CONTINUATION_STAGNATION_THRESHOLD
  ) {
    return { should: false, reason: "not_stagnant" };
  }

  if (hasPendingQuestion(state)) {
    return { should: false, reason: "pending_question" };
  }

  if ((subAgentManager?.activeCount ?? 0) > 0) {
    return { should: false, reason: "running_sub_agents" };
  }

  if (continuationCount >= TODO_CONTINUATION_MAX_COUNT) {
    return { should: false, reason: "max_continuations" };
  }

  return {
    should: true,
    reason: trigger,
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
    (part) => part.type === "tool" && part.toolName === "ask_user",
  ) ?? false;
}

function getPendingTodos(todos: readonly StoredTodo[]): StoredTodo[] {
  return todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress");
}

function findLastTodoContinuationInjectionTime(reminders: readonly Reminder[]): number | null {
  let lastInjectionTime: number | null = null;

  for (const reminder of reminders) {
    if (reminder.source.type !== "todo_continuation") continue;
    if (lastInjectionTime === null || reminder.createdAt > lastInjectionTime) {
      lastInjectionTime = reminder.createdAt;
    }
  }

  return lastInjectionTime;
}

function createTodoContinuationReminder(pendingTodos: StoredTodo[], now: number): Reminder {
  return {
    id: crypto.randomUUID(),
    source: { type: "todo_continuation", pendingTodos },
    delivery: "auto_inject",
    content: formatTodoContinuationContent(pendingTodos),
    payload: { pendingTodos },
    createdAt: now,
    consumedAt: null,
  };
}

function formatTodoContinuationContent(pendingTodos: readonly StoredTodo[]): string {
  const todoLines = pendingTodos.map((todo) => `- [ ] ${todo.content}`).join("\n");
  return `[TODO CONTINUATION]\n以下任务尚未完成：\n${todoLines}\n请继续工作。`;
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash.toString(16).padStart(8, "0");
}
