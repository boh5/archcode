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
export const AutomationNameSchema = NonEmptyTextSchema.max(AUTOMATION_NAME_MAX_LENGTH)
  .describe("Confirmed display name for the Automation. Non-empty; max 200 characters.");
export const AutomationMessageSchema = NonEmptyTextSchema.max(AUTOMATION_MESSAGE_MAX_LENGTH);
export const AutomationTimezoneSchema = NonEmptyTextSchema.max(AUTOMATION_TIMEZONE_MAX_LENGTH)
  .describe("IANA timezone used to evaluate the cron expression, for example Asia/Shanghai.");

export const AutomationTriggerSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("once").describe("Select a one-time trigger."),
    at: IsoDateTimeSchema.describe("ISO 8601 date-time with an explicit UTC offset for the one-time fire."),
  }),
  z.strictObject({
    kind: z.literal("interval").describe("Select a recurring fixed interval trigger."),
    everyMs: z.number().int().min(MIN_AUTOMATION_INTERVAL_MS)
      .describe("Interval in milliseconds between fires; integer >= 30000."),
  }),
  z.strictObject({
    kind: z.literal("cron").describe("Select a recurring cron trigger."),
    expression: NonEmptyTextSchema.describe("Exactly 5 cron fields: minute hour day-of-month month day-of-week."),
    timezone: AutomationTimezoneSchema,
  }),
]).superRefine((trigger, context) => {
  if (trigger.kind !== "cron") return;
  try {
    validateCronTrigger(trigger.expression, trigger.timezone);
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Trigger is invalid" });
  }
}).describe("Exactly one trigger: once, interval, or cron.") satisfies z.ZodType<AutomationTrigger>;

export const AutomationActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("start_session").describe("Start a new ordinary Engineer Session when the trigger fires."),
    message: AutomationMessageSchema.describe("Initial user message for the new Engineer Session. Max 10000 characters."),
    location: z.enum(["project", "worktree"]).describe("project uses the project workspace; worktree uses a managed worktree."),
  }),
  z.strictObject({
    kind: z.literal("send_message").describe("Send a message to an existing Session when the trigger fires."),
    sessionId: z.uuid().describe("UUID of the target existing Session."),
    message: AutomationMessageSchema.describe("Message to enqueue in the target Session. Max 10000 characters."),
  }),
]).describe("Exactly one action: start a new Engineer Session or send a message to an existing Session.") satisfies z.ZodType<AutomationAction>;

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
