import {
  BusyError,
  InvalidTodoStateError,
  type SessionStoreState,
  type SessionTodo,
  type StreamEvent,
} from "./types";
import { reduceStreamEvent as protocolReduceStreamEvent } from "@archcode/protocol";

const TODO_STATUSES = new Set<SessionTodo["status"]>([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

/**
 * Runtime-specific wrapper around the protocol reducer.
 *
 * Adds two runtime-only behaviours:
 * 1. `execution-start` — throws BusyError if already running (protocol doesn't enforce this)
 * 2. `todo-write` — throws InvalidTodoStateError on invalid todos (protocol silently
 *    returns {}), and tracks `lastTodoWriteStepIndex`
 */
export function reduceStreamEvent(
  state: SessionStoreState,
  event: StreamEvent,
): Partial<SessionStoreState> {
  // Runtime-specific guards
  if (event.type === "execution-start" && state.isRunning) {
    throw new BusyError(state.sessionId);
  }

  if (event.type === "todo-write") {
    validateTodos(event.todos);
  }

  // Delegate to protocol reducer (SessionStoreState structurally satisfies
  // SessionProjection on all shared fields)
  const partial = protocolReduceStreamEvent(state, event, {
    timestamp: Date.now(),
    generateId: () => crypto.randomUUID(),
  }) as Partial<SessionStoreState>;

  // Augment with runtime-only fields
  if (event.type === "todo-write") {
    const currentStepIndex = state.steps.length - 1;
    partial.lastTodoWriteStepIndex = currentStepIndex >= 0 ? currentStepIndex : null;
  }

  return partial;
}

function validateTodos(todos: readonly SessionTodo[]): void {
  let inProgressCount = 0;

  for (const todo of todos) {
    if (!TODO_STATUSES.has(todo.status)) {
      throw new InvalidTodoStateError(
        `todo "${todo.id}" has invalid status "${String(todo.status)}"`,
      );
    }

    if (todo.status === "in_progress") {
      inProgressCount += 1;
    }
  }

  if (inProgressCount > 1) {
    throw new InvalidTodoStateError("only one todo can be in_progress");
  }
}
