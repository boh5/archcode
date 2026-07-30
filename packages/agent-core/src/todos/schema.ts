import {
  PROJECT_TODO_BODY_MAX_LENGTH,
  PROJECT_TODO_REJECTION_REASON_MAX_LENGTH,
  PROJECT_TODO_TITLE_MAX_LENGTH,
  type ProjectTodo,
  type ProjectTodoUpdateInput,
} from "@archcode/protocol";
import { z } from "zod/v4";

export const ProjectTodoTitleSchema = z.string().trim().min(1).max(PROJECT_TODO_TITLE_MAX_LENGTH);
export const ProjectTodoBodySchema = z.string().max(PROJECT_TODO_BODY_MAX_LENGTH);
export const ProjectTodoRejectionReasonSchema = z.string().trim().min(1).max(PROJECT_TODO_REJECTION_REASON_MAX_LENGTH);
export const ProjectTodoStatusSchema = z.enum(["idea", "ready", "in_progress", "done", "rejected"]);
export const ProjectTodoSessionEntrySchema = z.enum(["discussion", "work", "automation"]);
export const CreateProjectTodoSessionSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  entry: ProjectTodoSessionEntrySchema,
  initialIntent: z.literal("plan").optional(),
}).superRefine((input, context) => {
  if (input.initialIntent !== undefined && input.entry !== "discussion") {
    context.addIssue({
      code: "custom",
      path: ["initialIntent"],
      message: "initialIntent is available only for Discussion Sessions",
    });
  }
});

export const ProjectTodoSchema = z.strictObject({
  id: z.uuid(),
  title: ProjectTodoTitleSchema,
  body: ProjectTodoBodySchema,
  status: ProjectTodoStatusSchema,
  rejectionReason: ProjectTodoRejectionReasonSchema.optional(),
  revision: z.number().int().positive(),
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
  if (todo.updatedAt < todo.createdAt) {
    context.addIssue({ code: "custom", path: ["updatedAt"], message: "updatedAt must not precede createdAt" });
  }
}) satisfies z.ZodType<ProjectTodo>;

export const ProjectTodoStateFileSchema = z.strictObject({
  todos: z.array(ProjectTodoSchema),
}).superRefine((state, context) => {
  addUniqueIssues(state.todos.map((todo) => todo.id), "Todo id", context);
});

export type ProjectTodoStateFile = z.infer<typeof ProjectTodoStateFileSchema>;

export const ProjectTodoCreateSchema = z.strictObject({
  title: ProjectTodoTitleSchema,
  body: ProjectTodoBodySchema.optional(),
});

export const ProjectTodoUpdateSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  title: ProjectTodoTitleSchema.optional(),
  body: ProjectTodoBodySchema.optional(),
  status: ProjectTodoStatusSchema.optional(),
  rejectionReason: ProjectTodoRejectionReasonSchema.optional(),
  archived: z.boolean().optional(),
  beforeTodoId: z.uuid().nullable().optional(),
}).superRefine((input, context) => {
  const mutationFields = Object.keys(input).filter((key) => key !== "expectedRevision");
  if (mutationFields.length === 0) {
    context.addIssue({ code: "custom", message: "At least one Todo field is required" });
  }
  if (input.archived !== undefined && mutationFields.length !== 1) {
    context.addIssue({ code: "custom", path: ["archived"], message: "archived cannot be combined with other Todo fields" });
  }
}) satisfies z.ZodType<ProjectTodoUpdateInput>;

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
