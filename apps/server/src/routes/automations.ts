import { Hono } from "hono";
import {
  AutomationUpdateSchema,
  type AgentRuntime,
} from "@archcode/agent-core";
import type { Automation } from "@archcode/protocol";
import { z } from "zod/v4";
import { BadRequestError, ServerError } from "../errors";
import { resolveProject } from "../resolve";
import { zValidator } from "../validation";

const AutomationIdSchema = z.uuid();
const AutomationListParamsSchema = z.strictObject({ slug: z.string().min(1) });
const AutomationParamsSchema = z.strictObject({
  slug: z.string().min(1),
  automationId: AutomationIdSchema,
});
const InvocationQuerySchema = z.strictObject({
  limit: z.string()
    .regex(/^\d+$/, "limit must be a positive integer")
    .transform(Number)
    .pipe(z.number().int().min(1).max(500, "limit must be between 1 and 500"))
    .optional(),
});

export function createAutomationsRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();

  app.get("/:slug/automations", zValidator("param", AutomationListParamsSchema), async (c) => {
    const project = await resolveProject(runtime, c.req.valid("param").slug);
    return c.json({ automations: await runtime.listAutomations(project.workspaceRoot) });
  });

  app.get("/:slug/automations/:automationId", zValidator("param", AutomationParamsSchema), async (c) => {
    const { slug, automationId } = c.req.valid("param");
    const project = await resolveProject(runtime, slug);
    return c.json({ automation: await readAutomation(runtime, project.workspaceRoot, automationId) });
  });

  app.patch("/:slug/automations/:automationId", zValidator("param", AutomationParamsSchema), zValidator("json", AutomationUpdateSchema), async (c) => {
    const { slug, automationId } = c.req.valid("param");
    const project = await resolveProject(runtime, slug);
    const input = c.req.valid("json");
    return c.json({ automation: await withAutomationNotFound(automationId, () => runtime.updateAutomation(project.workspaceRoot, automationId, input)) });
  });

  app.delete("/:slug/automations/:automationId", zValidator("param", AutomationParamsSchema), async (c) => {
    const { slug, automationId } = c.req.valid("param");
    const project = await resolveProject(runtime, slug);
    await withAutomationNotFound(automationId, () => runtime.deleteAutomation(project.workspaceRoot, automationId));
    return c.json({ ok: true });
  });

  app.post("/:slug/automations/:automationId/pause", zValidator("param", AutomationParamsSchema), async (c) => {
    await requireEmptyBody(c.req.text());
    const { slug, automationId } = c.req.valid("param");
    const project = await resolveProject(runtime, slug);
    return c.json({ automation: await withAutomationNotFound(automationId, () => runtime.pauseAutomation(project.workspaceRoot, automationId)) });
  });

  app.post("/:slug/automations/:automationId/resume", zValidator("param", AutomationParamsSchema), async (c) => {
    await requireEmptyBody(c.req.text());
    const { slug, automationId } = c.req.valid("param");
    const project = await resolveProject(runtime, slug);
    return c.json({ automation: await withAutomationNotFound(automationId, () => runtime.resumeAutomation(project.workspaceRoot, automationId)) });
  });

  app.post("/:slug/automations/:automationId/run-now", zValidator("param", AutomationParamsSchema), async (c) => {
    await requireEmptyBody(c.req.text());
    const { slug, automationId } = c.req.valid("param");
    const project = await resolveProject(runtime, slug);
    return c.json({ invocation: await withAutomationNotFound(automationId, () => runtime.runAutomationNow(project.workspaceRoot, automationId)) }, 202);
  });

  app.get("/:slug/automations/:automationId/invocations", zValidator("param", AutomationParamsSchema), zValidator("query", InvocationQuerySchema), async (c) => {
    const { slug, automationId } = c.req.valid("param");
    const { limit } = c.req.valid("query");
    const project = await resolveProject(runtime, slug);
    return c.json({ invocations: await withAutomationNotFound(automationId, () => runtime.listAutomationInvocations(project.workspaceRoot, automationId, limit)) });
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

async function requireEmptyBody(bodyPromise: Promise<string>): Promise<void> {
  if ((await bodyPromise).trim().length > 0) throw new BadRequestError("Request body is not supported");
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
