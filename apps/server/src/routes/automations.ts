import { Hono } from "hono";
import {
  MIN_AUTOMATION_INTERVAL_MS,
  validateAutomationTrigger,
  type AgentRuntime,
} from "@archcode/agent-core";
import type {
  Automation,
  AutomationAction,
  AutomationTrigger,
} from "@archcode/protocol";
import { z } from "zod/v4";
import { BadRequestError, ServerError } from "../errors";
import { resolveProject } from "../resolve";

const AutomationIdSchema = z.uuid();
const NameSchema = z.string().trim().min(1).max(200);
const MessageSchema = z.string().trim().min(1).max(10_000);
const DateTimeSchema = z.string().datetime({ offset: true });
const CronExpressionSchema = z.string().trim().min(1);
const TimezoneSchema = z.string().trim().min(1).max(100);

const TriggerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("once"), at: DateTimeSchema }),
  z.strictObject({ kind: z.literal("interval"), everyMs: z.number().int().min(MIN_AUTOMATION_INTERVAL_MS) }),
  z.strictObject({ kind: z.literal("cron"), expression: CronExpressionSchema, timezone: TimezoneSchema }),
]).superRefine((trigger, context) => {
  try {
    validateAutomationTrigger(trigger);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Trigger is invalid",
    });
  }
}) satisfies z.ZodType<AutomationTrigger>;

const ActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("start_session"),
    message: MessageSchema,
    location: z.enum(["project", "worktree"]),
  }),
  z.strictObject({ kind: z.literal("send_message"), sessionId: z.uuid(), message: MessageSchema }),
]) satisfies z.ZodType<AutomationAction>;

const UpdateAutomationBodySchema = z.strictObject({
  name: NameSchema.optional(),
  trigger: TriggerSchema.optional(),
  action: ActionSchema.optional(),
});

export function createAutomationsRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();

  app.get("/:slug/automations", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    return c.json({ automations: await runtime.listAutomations(project.workspaceRoot) });
  });

  app.get("/:slug/automations/:automationId", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const automationId = requiredAutomationId(c.req.param("automationId"));
    return c.json({ automation: await readAutomation(runtime, project.workspaceRoot, automationId) });
  });

  app.patch("/:slug/automations/:automationId", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const automationId = requiredAutomationId(c.req.param("automationId"));
    const input = await readJsonBody(c.req.json(), UpdateAutomationBodySchema);
    if (Object.keys(input).length === 0) throw new BadRequestError("At least one patch field is required");
    return c.json({ automation: await withAutomationNotFound(automationId, () => runtime.updateAutomation(project.workspaceRoot, automationId, input)) });
  });

  app.delete("/:slug/automations/:automationId", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const automationId = requiredAutomationId(c.req.param("automationId"));
    await withAutomationNotFound(automationId, () => runtime.deleteAutomation(project.workspaceRoot, automationId));
    return c.json({ ok: true });
  });

  app.post("/:slug/automations/:automationId/pause", async (c) => {
    await requireEmptyBody(c.req.text());
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const automationId = requiredAutomationId(c.req.param("automationId"));
    return c.json({ automation: await withAutomationNotFound(automationId, () => runtime.pauseAutomation(project.workspaceRoot, automationId)) });
  });

  app.post("/:slug/automations/:automationId/resume", async (c) => {
    await requireEmptyBody(c.req.text());
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const automationId = requiredAutomationId(c.req.param("automationId"));
    return c.json({ automation: await withAutomationNotFound(automationId, () => runtime.resumeAutomation(project.workspaceRoot, automationId)) });
  });

  app.post("/:slug/automations/:automationId/run-now", async (c) => {
    await requireEmptyBody(c.req.text());
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const automationId = requiredAutomationId(c.req.param("automationId"));
    return c.json({ invocation: await withAutomationNotFound(automationId, () => runtime.runAutomationNow(project.workspaceRoot, automationId)) }, 202);
  });

  app.get("/:slug/automations/:automationId/invocations", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const automationId = requiredAutomationId(c.req.param("automationId"));
    return c.json({ invocations: await withAutomationNotFound(automationId, () => runtime.listAutomationInvocations(project.workspaceRoot, automationId, parseLimit(c.req.query("limit")))) });
  });

  return app;
}

async function readAutomation(runtime: AgentRuntime, workspaceRoot: string, automationId: string): Promise<Automation> {
  return await withAutomationNotFound(automationId, () => runtime.readAutomation(workspaceRoot, automationId));
}

async function withAutomationNotFound<T>(automationId: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (hasCode(error, "AUTOMATION_NOT_FOUND")) {
      throw new ServerError("AUTOMATION_NOT_FOUND", `Automation not found: ${automationId}`, 404);
    }
    throw error;
  }
}

function requiredParam(value: string | undefined, name: string): string {
  if (!value) throw new BadRequestError(`${name} is required`);
  return value;
}

function requiredAutomationId(value: string | undefined): string {
  const automationId = requiredParam(value, "automationId");
  if (!AutomationIdSchema.safeParse(automationId).success) throw new BadRequestError("automationId must be a UUID");
  return automationId;
}

async function readJsonBody<T>(bodyPromise: Promise<unknown>, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await bodyPromise;
  } catch {
    throw new BadRequestError("Invalid JSON body");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? "Request body is invalid");
  return parsed.data;
}

async function requireEmptyBody(bodyPromise: Promise<string>): Promise<void> {
  if ((await bodyPromise).trim().length > 0) throw new BadRequestError("Request body is not supported");
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new BadRequestError("limit must be a positive integer");
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new BadRequestError("limit must be between 1 and 500");
  }
  return limit;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
