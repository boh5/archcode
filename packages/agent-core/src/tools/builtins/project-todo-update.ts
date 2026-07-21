import {
  PROJECT_TODO_BODY_MAX_LENGTH,
  PROJECT_TODO_REJECTION_REASON_MAX_LENGTH,
  PROJECT_TODO_TITLE_MAX_LENGTH,
  TOOL_PROJECT_TODO_UPDATE,
} from "@archcode/protocol";
import { z } from "zod/v4";

import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { createTextToolResult } from "../results";

const ProjectTodoDiscussionPatchSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(PROJECT_TODO_TITLE_MAX_LENGTH).optional()
      .describe("A corrected Todo title. Omit when the title is unchanged."),
    body: z.string().max(PROJECT_TODO_BODY_MAX_LENGTH).optional()
      .describe("The clarified Todo body. Omit when the body is unchanged."),
    decision: z.strictObject({
      action: z.enum(["keep_current", "mark_idea", "mark_ready", "reject"])
        .describe("Use keep_current when the user did not explicitly confirm a status change; otherwise use the one explicitly confirmed status action."),
      rationale: z.string().trim().min(1).max(PROJECT_TODO_REJECTION_REASON_MAX_LENGTH)
        .describe("Why this action is correct. For keep_current or mark_idea, describe what remains unresolved; for mark_ready, cite the user's confirmation; for reject, give the concrete rejection reason."),
    }).describe("A required, single Todo decision. Only reject persists the rationale as rejectionReason."),
  })
  .superRefine((patch, context) => {
    if (patch.decision.action === "keep_current" && patch.title === undefined && patch.body === undefined) {
      context.addIssue({
        code: "custom",
        path: ["decision", "action"],
        message: "keep_current requires a title or body correction; omit project_todo_update when nothing changed",
      });
    }
  });

export const ProjectTodoUpdateInputSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  patch: ProjectTodoDiscussionPatchSchema,
});

export const projectTodoUpdateTool = defineTool({
  name: TOOL_PROJECT_TODO_UPDATE,
  description: "Update the Project Todo bound to this root Lead Discussion. The current Todo is inferred from the Session; no Todo ID is accepted. Every update must make one explicit keep-current, Idea, Ready, or Reject decision with a rationale.",
  inputSchema: ProjectTodoUpdateInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  outputPolicy: { kind: "inline", previewDirection: "head" },
  execute: async (input, ctx) => {
    const state = ctx.store.getState();
    const agentName = ctx.agentName ?? state.agentName;
    const isRootSession = state.sessionId === state.rootSessionId && state.parentSessionId === undefined;

    if (agentName !== "lead" || !isRootSession) {
      return createToolErrorResult({
        kind: "permission-denied",
        code: "PROJECT_TODO_UPDATE_DENIED",
        message: `project_todo_update requires a bound root Lead Discussion, got ${agentName ?? "unknown"}/${isRootSession ? "root" : "child"}`,
      });
    }

    try {
      const { decision, ...contentPatch } = input.patch;
      const patch = decision.action === "keep_current"
        ? contentPatch
        : decision.action === "reject"
        ? {
            ...contentPatch,
            status: "rejected" as const,
            rejectionReason: decision.rationale,
          }
        : {
            ...contentPatch,
            status: decision.action === "mark_ready" ? "ready" as const : "idea" as const,
          };
      const todo = await ctx.projectContext.todos.updateFromDiscussion({
        authorization: {
          sessionId: state.sessionId,
          rootSessionId: state.rootSessionId,
          agentName,
          projectSlug: ctx.projectContext.project.slug,
        },
        expectedRevision: input.expectedRevision,
        patch,
      });
      return createTextToolResult(JSON.stringify(todo, null, 2));
    } catch (error) {
      return createToolErrorResult({
        kind: "execution",
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  },
});
