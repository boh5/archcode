import {
  PROJECT_TODO_CONTENT_MAX_LENGTH,
  PROJECT_TODO_REJECTION_REASON_MAX_LENGTH,
  MAX_ATTACHMENTS_PER_TODO,
  type CreateProjectTodoSessionInput,
  type ProjectTodo,
  type ProjectTodoRunNowInput,
  type ProjectTodoStartDiscussionInput,
  type ProjectTodoStartDiscussionReceipt,
  type ProjectTodoUpdateInput,
} from "@archcode/protocol";
import { z } from "zod/v4";

export const ProjectTodoContentSchema = z.string().trim().min(1).max(PROJECT_TODO_CONTENT_MAX_LENGTH);
export const ProjectTodoRejectionReasonSchema = z.string().trim().min(1).max(PROJECT_TODO_REJECTION_REASON_MAX_LENGTH);
export const ProjectTodoStatusSchema = z.enum(["idea", "ready", "in_progress", "done", "rejected"]);
export const ProjectTodoAttachmentIdSchema = z.uuid();
export const ProjectTodoAttachmentIdsSchema = z.array(ProjectTodoAttachmentIdSchema)
  .max(MAX_ATTACHMENTS_PER_TODO)
  .superRefine((attachmentIds, context) => {
    addUniqueIssues(attachmentIds, "Todo attachment id", context);
  });
export const ProjectTodoSessionEntrySchema = z.enum(["discussion", "work", "automation"]);
export const CreateProjectTodoSessionSchema = z.discriminatedUnion("entry", [
  z.strictObject({
    expectedRevision: z.number().int().positive(),
    entry: z.literal("discussion"),
    initialIntent: z.literal("plan").optional(),
  }),
  z.strictObject({
    expectedRevision: z.number().int().positive(),
    entry: z.literal("work"),
  }),
  z.strictObject({
    expectedRevision: z.number().int().positive(),
    entry: z.literal("automation"),
  }),
]) satisfies z.ZodType<CreateProjectTodoSessionInput>;

export const ProjectTodoSchema = z.strictObject({
  id: z.uuid(),
  content: ProjectTodoContentSchema,
  attachmentIds: ProjectTodoAttachmentIdsSchema,
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

export const ProjectTodoRunNowReceiptSchema = z.strictObject({
  clientRequestId: z.uuid(),
  requestHash: z.string().length(64),
  todoId: z.uuid(),
  sessionId: z.uuid(),
  status: z.enum(["preparing", "recovery_required", "accepted"]),
});

export const ProjectTodoStartDiscussionReceiptSchema = z.strictObject({
  clientRequestId: z.uuid(),
  requestHash: z.string().length(64),
  todoId: z.uuid(),
  sessionId: z.uuid(),
  status: z.enum(["preparing", "recovery_required", "accepted"]),
}) satisfies z.ZodType<ProjectTodoStartDiscussionReceipt>;

export const ProjectTodoStateFileSchema = z.strictObject({
  todos: z.array(ProjectTodoSchema),
  runNowReceipts: z.array(ProjectTodoRunNowReceiptSchema),
  startDiscussionReceipts: z.array(ProjectTodoStartDiscussionReceiptSchema),
}).superRefine((state, context) => {
  addUniqueIssues(state.todos.map((todo) => todo.id), "Todo id", context);
  addUniqueIssues(state.runNowReceipts.map((receipt) => receipt.clientRequestId), "Run-now clientRequestId", context);
  addUniqueIssues(
    state.startDiscussionReceipts.map((receipt) => receipt.clientRequestId),
    "Start-discussion clientRequestId",
    context,
  );
});

export type ProjectTodoStateFile = z.infer<typeof ProjectTodoStateFileSchema>;

export const ProjectTodoCreateSchema = z.strictObject({
  content: ProjectTodoContentSchema,
});

export const ProjectTodoRunNowSchema = z.strictObject({
  clientRequestId: z.uuid(),
  content: ProjectTodoContentSchema,
}) satisfies z.ZodType<ProjectTodoRunNowInput>;

export const ProjectTodoStartDiscussionSchema = z.strictObject({
  clientRequestId: z.uuid(),
  content: ProjectTodoContentSchema,
}) satisfies z.ZodType<ProjectTodoStartDiscussionInput>;

export const ProjectTodoUpdateSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  content: ProjectTodoContentSchema.optional(),
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
  content: ProjectTodoContentSchema.optional(),
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
