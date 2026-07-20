import {
  PROJECT_TODO_BODY_MAX_LENGTH,
  PROJECT_TODO_REJECTION_REASON_MAX_LENGTH,
  PROJECT_TODO_TITLE_MAX_LENGTH,
  type ProjectTodo,
  type ProjectTodoActivation,
} from "@archcode/protocol";
import { z } from "zod/v4";

export const ProjectTodoTitleSchema = z.string().trim().min(1).max(PROJECT_TODO_TITLE_MAX_LENGTH);
export const ProjectTodoBodySchema = z.string().max(PROJECT_TODO_BODY_MAX_LENGTH);
export const ProjectTodoRejectionReasonSchema = z.string().trim().min(1).max(PROJECT_TODO_REJECTION_REASON_MAX_LENGTH);
export const ProjectTodoStatusSchema = z.enum(["idea", "ready", "done", "rejected"]);

export const ProjectTodoActivationSchema = z.strictObject({
  kind: z.enum(["session", "automation"]),
  sourceSessionId: z.uuid(),
  todoRevision: z.number().int().positive(),
  snapshot: z.strictObject({
    title: ProjectTodoTitleSchema,
    body: ProjectTodoBodySchema,
  }),
  resourceId: z.uuid().optional(),
}).superRefine((activation, context) => {
  if (activation.kind === "session" && activation.resourceId !== activation.sourceSessionId) {
    context.addIssue({
      code: "custom",
      path: ["resourceId"],
      message: "Session Activation resourceId must equal sourceSessionId",
    });
  }
}) satisfies z.ZodType<ProjectTodoActivation>;

export const ProjectTodoSchema = z.strictObject({
  id: z.uuid(),
  title: ProjectTodoTitleSchema,
  body: ProjectTodoBodySchema,
  status: ProjectTodoStatusSchema,
  rejectionReason: ProjectTodoRejectionReasonSchema.optional(),
  revision: z.number().int().positive(),
  discussionSessionId: z.uuid().optional(),
  activation: ProjectTodoActivationSchema.optional(),
  archivedAt: z.number().int().nonnegative().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).superRefine((todo, context) => {
  if (todo.status === "rejected" && todo.rejectionReason === undefined) {
    context.addIssue({ code: "custom", path: ["rejectionReason"], message: "Rejected Todo requires a rejection reason" });
  }
  if (todo.status !== "rejected" && todo.rejectionReason !== undefined) {
    context.addIssue({ code: "custom", path: ["rejectionReason"], message: "Only a rejected Todo may retain a rejection reason" });
  }
  if (todo.activation !== undefined && todo.status !== "ready" && todo.status !== "done") {
    context.addIssue({ code: "custom", path: ["activation"], message: "Activation requires ready or done status" });
  }
  if (todo.archivedAt !== undefined && todo.activation !== undefined && todo.status === "ready") {
    context.addIssue({ code: "custom", path: ["archivedAt"], message: "An active Todo cannot be archived" });
  }
  if (todo.updatedAt < todo.createdAt) {
    context.addIssue({ code: "custom", path: ["updatedAt"], message: "updatedAt must not precede createdAt" });
  }
}) satisfies z.ZodType<ProjectTodo>;

export const ProjectTodoStateFileSchema = z.strictObject({
  todos: z.array(ProjectTodoSchema),
}).superRefine((state, context) => {
  addUniqueIssues(state.todos.map((todo) => todo.id), "Todo id", context);
  addUniqueIssues(state.todos.flatMap((todo) => [
    ...(todo.discussionSessionId === undefined ? [] : [todo.discussionSessionId]),
    ...(todo.activation === undefined ? [] : [todo.activation.sourceSessionId]),
  ]), "Todo-owned Session", context);
});

export type ProjectTodoStateFile = z.infer<typeof ProjectTodoStateFileSchema>;

export const ProjectTodoCreateSchema = z.strictObject({
  title: ProjectTodoTitleSchema,
  body: ProjectTodoBodySchema.optional(),
});

export const ProjectTodoUpdatePatchSchema = z.strictObject({
  title: ProjectTodoTitleSchema.optional(),
  body: ProjectTodoBodySchema.optional(),
  status: ProjectTodoStatusSchema.optional(),
  rejectionReason: ProjectTodoRejectionReasonSchema.optional(),
}).refine((input) => Object.keys(input).length > 0, { message: "At least one Todo field is required" });

export const ProjectTodoDiscussionUpdatePatchSchema = z.strictObject({
  title: ProjectTodoTitleSchema.optional(),
  body: ProjectTodoBodySchema.optional(),
  status: z.enum(["idea", "ready", "rejected"]).optional(),
  rejectionReason: ProjectTodoRejectionReasonSchema.optional(),
}).refine((input) => Object.keys(input).length > 0, { message: "At least one Todo field is required" });

function addUniqueIssues(values: readonly string[], label: string, context: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) context.addIssue({ code: "custom", message: `${label} must be unique: ${value}` });
    seen.add(value);
  }
}
