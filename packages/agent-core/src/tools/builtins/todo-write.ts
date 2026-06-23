import { z } from "zod";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { ToolExecutionResult } from "../types";

// ─── Constants ───

const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;

// ─── Input Schema ───

export const TodoWriteInputSchema = z
  .object({
    todos: z.array(
      z
        .object({
          id: z.string().optional().describe("Stable identifier. If omitted, one is generated automatically."),
          content: z.string().describe("Brief description of the task"),
          status: z.enum(TODO_STATUSES).describe("Current state: pending | in_progress | completed | cancelled"),
        })
        .strict(),
    ).describe("Full replacement list of todo items. Each: { id?, content, status }"),
  })
  .strict();

export type TodoWriteInput = z.infer<typeof TodoWriteInputSchema>;

// ─── Summary Formatting ───

function buildTodoSummary(
  todos: Array<{ id: string; content: string; status: string }>,
): string {
  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  let cancelled = 0;
  let currentItem: string | undefined;

  for (const todo of todos) {
    switch (todo.status) {
      case "pending":
        pending++;
        break;
      case "in_progress":
        inProgress++;
        currentItem = todo.content;
        break;
      case "completed":
        completed++;
        break;
      case "cancelled":
        cancelled++;
        break;
    }
  }

  const summary = `Todos updated — ${pending} pending, ${inProgress} in_progress, ${completed} completed, ${cancelled} cancelled`;
  if (currentItem) {
    return `${summary}\nCurrent: "${currentItem}"`;
  }
  return summary;
}

// ─── Tool Definition ───

export const todoWriteTool = defineTool({
  name: "todo_write",
  description:
    "Replaces the full todo list with the given items. Each todo has content, status, and an optional id. If no id is provided, one is generated automatically.",
  inputSchema: TodoWriteInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: true },
  execute: (input, ctx): string | ToolExecutionResult => {
    // 1. Generate deterministic IDs for items without id
    const todos = input.todos.map((todo, index) => ({
      ...todo,
      id: todo.id ?? `todo-${index + 1}`,
    }));

    // 2. Check for duplicate IDs
    const idSet = new Set<string>();
    const duplicates = new Set<string>();
    for (const todo of todos) {
      if (idSet.has(todo.id)) {
        duplicates.add(todo.id);
      }
      idSet.add(todo.id);
    }
    if (duplicates.size > 0) {
      return createToolErrorResult({
        kind: "todo-validation",
        code: "TOOL_TODO_VALIDATION",
        message: `Duplicate todo IDs: ${[...duplicates].join(", ")}`,
      });
    }

    // 3. Check for >1 in_progress (store also validates, but this gives a clean error)
    const inProgressCount = todos.filter((t) => t.status === "in_progress").length;
    if (inProgressCount > 1) {
      return createToolErrorResult({
        kind: "todo-validation",
        code: "TOOL_TODO_VALIDATION",
        message: "Only one todo can be in_progress",
      });
    }

    // 4. Append to store (handles full-list replacement)
    ctx.store.getState().append({ type: "todo-write", todos });

    // 5. Build and return summary
    return buildTodoSummary(todos);
  },
});
