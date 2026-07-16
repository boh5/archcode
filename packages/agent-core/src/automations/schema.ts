import {
  AUTOMATION_MESSAGE_MAX_LENGTH,
  AUTOMATION_NAME_MAX_LENGTH,
  AUTOMATION_TIMEZONE_MAX_LENGTH,
  MIN_AUTOMATION_INTERVAL_MS,
  type Automation,
  type AutomationAction,
  type AutomationInvocation,
  type AutomationTrigger,
} from "@archcode/protocol";
import { z } from "zod/v4";

import { validateCronTrigger } from "./trigger-validation";

const IsoDateTimeSchema = z.string().datetime({ offset: true });
const NonEmptyTextSchema = z.string().trim().min(1);
export const AutomationNameSchema = NonEmptyTextSchema.max(AUTOMATION_NAME_MAX_LENGTH);
export const AutomationMessageSchema = NonEmptyTextSchema.max(AUTOMATION_MESSAGE_MAX_LENGTH);
export const AutomationTimezoneSchema = NonEmptyTextSchema.max(AUTOMATION_TIMEZONE_MAX_LENGTH);

export const AutomationTriggerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("once"), at: IsoDateTimeSchema }),
  z.strictObject({ kind: z.literal("interval"), everyMs: z.number().int().min(MIN_AUTOMATION_INTERVAL_MS) }),
  z.strictObject({ kind: z.literal("cron"), expression: NonEmptyTextSchema, timezone: AutomationTimezoneSchema }),
]).superRefine((trigger, context) => {
  if (trigger.kind !== "cron") return;
  try {
    validateCronTrigger(trigger.expression, trigger.timezone);
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Trigger is invalid" });
  }
}) satisfies z.ZodType<AutomationTrigger>;

export const AutomationActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("start_session"),
    message: AutomationMessageSchema,
    location: z.enum(["project", "worktree"]),
  }),
  z.strictObject({
    kind: z.literal("send_message"),
    sessionId: z.uuid(),
    message: AutomationMessageSchema,
  }),
]) satisfies z.ZodType<AutomationAction>;

export const AutomationSchema = z.strictObject({
  id: z.uuid(),
  projectSlug: NonEmptyTextSchema,
  createdFromSessionId: z.uuid(),
  name: AutomationNameSchema,
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
  sessionId: z.uuid().optional(),
  createdAt: IsoDateTimeSchema,
  dispatchedAt: IsoDateTimeSchema.optional(),
  completedAt: IsoDateTimeSchema.optional(),
  error: z.string().optional(),
}) satisfies z.ZodType<AutomationInvocation>;

export const AutomationStateFileSchema = z.strictObject({
  automations: z.array(AutomationSchema),
  invocations: z.array(AutomationInvocationSchema),
});

export type AutomationStateFile = z.infer<typeof AutomationStateFileSchema>;

export const AutomationCreateSchema = z.strictObject({
  name: AutomationNameSchema,
  trigger: AutomationTriggerSchema,
  action: AutomationActionSchema,
});

export const AutomationUpdateSchema = AutomationCreateSchema.partial().refine(
  (input) => Object.keys(input).length > 0,
  { message: "At least one patch field is required" },
);
