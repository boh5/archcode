import { z } from "zod";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { createTextToolResult } from "../results";

// ─── Constants ───

const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;

// ─── Input Schema ───

export const TodoWriteInputSchema = z
  .object({
    todos: z.array(
      z
        .object({
          id: z.string().optional().describe("Stable item identifier. Provide one on the first call for any item you expect to update later, then preserve it on every replacement call. If omitted, one is generated for the current update but is not returned to the model."),
          content: z.string().describe("Specific, actionable task outcome. Preserve user-provided commands, flags, arguments, and ordering verbatim when they are part of the requirement."),
          status: z.enum(TODO_STATUSES).describe("`pending` not started; `in_progress` actively being worked; `completed` fully finished and verified; `cancelled` no longer needed."),
        })
        .strict(),
    ).describe("Full replacement list. Omitting an existing item removes it, so include every item that should remain."),
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
  description: [
    "Create and replace the Session's complete todo list for non-trivial work.",
    "",
    "Use it when the request has at least three distinct conceptual steps, multiple user-visible deliverables, an unclear scope that must be resolved in stages, or new instructions that materially extend existing work. Do not use it for a single localized edit, one command followed by a report, a simple answer, or other work where tracking adds no value.",
    "",
    "Workflow rules:",
    "- Send every current item on each call because the input replaces the whole list. Preserve existing ids and preserve exact user-provided commands or flags inside the relevant item.",
    "- Give each continuing item an explicit, stable id on the initial call; generated ids are not returned in the tool result and therefore cannot be reused reliably.",
    "- Keep exactly one item `in_progress` while work remains. Update status when work state changes rather than batching completions at the end.",
    "- If work is blocked or only partially done, keep it `in_progress` and add or update a specific blocker item. Mark `completed` only after the outcome and required verification are actually finished.",
    "",
    "Example initial call: `todo_write({\"todos\":[{\"id\":\"inspect-contract\",\"content\":\"Inspect the current contract and competitor evidence\",\"status\":\"in_progress\"},{\"id\":\"implement-contract\",\"content\":\"Implement the verified contract changes\",\"status\":\"pending\"},{\"id\":\"verify-contract\",\"content\":\"Run typecheck and targeted tests\",\"status\":\"pending\"}]})`. On later calls, resend all three items with these same ids and updated statuses.",
  ].join("\n"),
  inputSchema: TodoWriteInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: true },
  outputPolicy: { kind: "inline", previewDirection: "head" },
  execute: (input, ctx) => {
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
    return createTextToolResult(buildTodoSummary(todos));
  },
});
