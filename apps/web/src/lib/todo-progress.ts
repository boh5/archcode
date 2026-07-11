import type { SessionExecutionRecord, SessionTodo } from "@archcode/protocol";

export type TodoProgressState = "running" | "waiting" | "blocked" | "failed" | "completed" | "idle";
export type TodoPriority = "high" | "medium" | "low";

const TODO_PRIORITY_PATTERN = /\b(P0|P1|P2)\b/i;

export function presentTodoContent(content: string): { content: string; priority: TodoPriority | null } {
  const match = TODO_PRIORITY_PATTERN.exec(content);
  if (!match) return { content, priority: null };
  const tag = match[1].toUpperCase();
  return {
    content: content.replace(TODO_PRIORITY_PATTERN, "").replace(/\s{2,}/g, " ").trim(),
    priority: tag === "P0" ? "high" : tag === "P1" ? "medium" : "low",
  };
}

export interface TodoProgress {
  total: number;
  completed: number;
  current: number;
  upcoming: number;
  percent: number;
  state: TodoProgressState;
}

export interface TodoExecutionState {
  isRunning: boolean;
  lastExecutionStatus?: SessionExecutionRecord["status"];
  blockedByHitlIds?: string[];
}

export function deriveTodoProgress(
  todos: SessionTodo[],
  execution: TodoExecutionState,
): TodoProgress | null {
  if (todos.length === 0) return null;
  const completed = todos.filter((todo) => todo.status === "completed").length;
  const current = todos.filter((todo) => todo.status === "in_progress").length;
  const upcoming = todos.filter((todo) => todo.status === "pending").length;
  let state: TodoProgressState = "idle";

  if (completed === todos.length) state = "completed";
  else if ((execution.blockedByHitlIds?.length ?? 0) > 0) state = "blocked";
  else if (execution.lastExecutionStatus === "waiting_for_human") state = "waiting";
  else if (execution.lastExecutionStatus === "failed" || execution.lastExecutionStatus === "timed_out") state = "failed";
  else if (execution.isRunning || current > 0) state = "running";

  return {
    total: todos.length,
    completed,
    current,
    upcoming,
    percent: Math.round((completed / todos.length) * 100),
    state,
  };
}
