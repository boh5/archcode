import type { Automation, AutomationAction, AutomationInvocation, AutomationTrigger } from "@archcode/protocol";
import { z } from "zod/v4";

export const MIN_AUTOMATION_INTERVAL_MS = 30_000;

const IsoDateTimeSchema = z.string().datetime({ offset: true });
const NonEmptyTextSchema = z.string().trim().min(1);

export const AutomationTriggerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("once"), at: IsoDateTimeSchema }),
  z.strictObject({ kind: z.literal("interval"), everyMs: z.number().int().min(MIN_AUTOMATION_INTERVAL_MS) }),
  z.strictObject({ kind: z.literal("cron"), expression: NonEmptyTextSchema, timezone: NonEmptyTextSchema }),
]) satisfies z.ZodType<AutomationTrigger>;

export const AutomationActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("start_session"),
    message: NonEmptyTextSchema,
    location: z.enum(["project", "worktree"]),
  }),
  z.strictObject({
    kind: z.literal("send_message"),
    sessionId: z.uuid(),
    message: NonEmptyTextSchema,
  }),
]) satisfies z.ZodType<AutomationAction>;

export const AutomationSchema = z.strictObject({
  id: z.uuid(),
  projectId: NonEmptyTextSchema,
  createdFromSessionId: z.uuid(),
  name: NonEmptyTextSchema,
  trigger: AutomationTriggerSchema,
  action: AutomationActionSchema,
  status: z.enum(["active", "paused", "disabled"]),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  nextFireAt: IsoDateTimeSchema.optional(),
}) satisfies z.ZodType<Automation>;

export const AutomationInvocationSchema = z.strictObject({
  id: z.uuid(),
  automationId: z.uuid(),
  dueAt: IsoDateTimeSchema,
  status: z.enum(["pending", "dispatched", "failed", "cancelled", "missed"]),
  executionId: z.uuid(),
  sessionId: z.uuid().optional(),
  createdAt: IsoDateTimeSchema,
  dispatchedAt: IsoDateTimeSchema.optional(),
  completedAt: IsoDateTimeSchema.optional(),
  error: z.string().optional(),
}) satisfies z.ZodType<AutomationInvocation>;

export const AutomationStateFileSchema = z.strictObject({
  version: z.literal(2),
  automations: z.array(AutomationSchema),
  invocations: z.array(AutomationInvocationSchema),
});

export type AutomationStateFile = z.infer<typeof AutomationStateFileSchema>;
