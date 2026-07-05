import { Hono } from "hono";
import {
  expandLoopPreset,
  getUnsupportedLoopPresetReason,
  isSupportedLoopPreset,
  LoopActiveConflictError,
  LoopConfigSchema,
  LoopNotFoundError,
  LoopRunLogError,
  LoopStateError,
  LoopUuidSchema,
  type AgentRuntime,
  type LoopConfig,
  type LoopUpdateInput,
} from "@archcode/agent-core";
import { z } from "zod/v4";
import { BadRequestError, ServerError } from "../errors";
import { resolveProject } from "../resolve";

const CreateLoopBodySchema = z.union([
  z.strictObject({
    config: LoopConfigSchema,
    author: z.string().trim().min(1).max(200).optional(),
  }),
  z.strictObject({
    presetId: z.string().trim().min(1).max(200),
    author: z.string().trim().min(1).max(200).optional(),
  }),
]);

const PatchLoopBodySchema = z.strictObject({
  config: LoopConfigSchema.optional(),
  status: z.enum(["active", "paused", "disabled", "error"]).optional(),
});

const ActivateKillBodySchema = z.strictObject({
  activatedBy: z.string().trim().min(1).max(200).optional(),
  reason: z.string().trim().min(1).max(20_000).optional(),
});

type CreateLoopBody = z.infer<typeof CreateLoopBodySchema>;
type PatchLoopBody = z.infer<typeof PatchLoopBodySchema>;

export function createLoopsRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();

  app.get("/:slug/loops", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    try {
      return c.json({ loops: await runtime.listLoops(project.workspaceRoot) });
    } catch (error) {
      throw mapLoopError(error);
    }
  });

  app.post("/:slug/loops", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const body = await readJsonBody(c.req.json(), CreateLoopBodySchema);
    const config = createConfigFromBody(body);
    assertPhase4ApiLoopConfig(config);

    try {
      const loop = await runtime.createLoop(project.workspaceRoot, config, body.author);
      return c.json({ loop }, 201);
    } catch (error) {
      throw mapLoopError(error);
    }
  });

  app.get("/:slug/loops/kill-state", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));

    try {
      return c.json({ killState: await runtime.readLoopKillState(project.workspaceRoot) });
    } catch (error) {
      throw mapLoopError(error);
    }
  });

  app.post("/:slug/loops/kill-all", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const body = await readOptionalJsonBody(c.req.text(), ActivateKillBodySchema);

    try {
      return c.json({ killState: await runtime.activateLoopGlobalKill(project.workspaceRoot, body) });
    } catch (error) {
      throw mapLoopError(error);
    }
  });

  app.delete("/:slug/loops/kill-all", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));

    try {
      return c.json({ killState: await runtime.clearLoopGlobalKill(project.workspaceRoot) });
    } catch (error) {
      throw mapLoopError(error);
    }
  });

  app.get("/:slug/loops/:loopId", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const loopId = requiredLoopId(c.req.param("loopId"));

    try {
      return c.json({ loop: await runtime.readLoop(project.workspaceRoot, loopId) });
    } catch (error) {
      throw mapLoopError(error);
    }
  });

  app.patch("/:slug/loops/:loopId", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const loopId = requiredLoopId(c.req.param("loopId"));
    const body = await readJsonBody(c.req.json(), PatchLoopBodySchema);
    if (Object.keys(body).length === 0) {
      throw new BadRequestError("At least one patch field is required");
    }
    if (body.config !== undefined) assertPhase4ApiLoopConfig(body.config);

    try {
      const loop = await runtime.updateLoop(project.workspaceRoot, loopId, toLoopUpdates(body));
      return c.json({ loop });
    } catch (error) {
      throw mapLoopError(error);
    }
  });

  app.post("/:slug/loops/:loopId/trigger", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const loopId = requiredLoopId(c.req.param("loopId"));

    try {
      const report = await runtime.triggerLoopRun(project.workspaceRoot, loopId);
      if (report?.reason === "global_kill_active") {
        throw new ServerError("LOOP_ACTIVE_CONFLICT", "Global Loop kill switch is active; manual trigger blocked.", 409, {
          loopId,
          trigger: "manual",
          reason: "global_kill_active",
          report,
        });
      }
      return c.json({ report: report ?? null });
    } catch (error) {
      throw mapLoopError(error);
    }
  });

  app.post("/:slug/loops/:loopId/runs/current/cancel", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const loopId = requiredLoopId(c.req.param("loopId"));

    try {
      const report = await runtime.cancelLoopCurrentRun(project.workspaceRoot, loopId);
      if (report === undefined) return c.json({ ok: true, loopId, runId: null, status: "not_running" });
      return c.json({ ok: true, loopId, runId: report.runId, status: report.status, reason: report.reason, report });
    } catch (error) {
      throw mapLoopError(error);
    }
  });

  app.post("/:slug/loops/:loopId/pause", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const loopId = requiredLoopId(c.req.param("loopId"));

    try {
      return c.json({ loop: await runtime.pauseLoop(project.workspaceRoot, loopId) });
    } catch (error) {
      throw mapLoopError(error);
    }
  });

  app.post("/:slug/loops/:loopId/resume", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const loopId = requiredLoopId(c.req.param("loopId"));

    try {
      return c.json({ loop: await runtime.resumeLoop(project.workspaceRoot, loopId) });
    } catch (error) {
      throw mapLoopError(error);
    }
  });

  app.get("/:slug/loops/:loopId/runs", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const loopId = requiredLoopId(c.req.param("loopId"));
    const limit = parseOptionalLimit(c.req.query("limit"));

    try {
      return c.json({ runs: await runtime.readLoopRunLog(project.workspaceRoot, loopId, limit) });
    } catch (error) {
      throw mapLoopError(error);
    }
  });

  app.get("/:slug/loops/:loopId/budget", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const loopId = requiredLoopId(c.req.param("loopId"));

    try {
      return c.json({ loopId, budget: await runtime.readLoopBudget(project.workspaceRoot, loopId) });
    } catch (error) {
      throw mapLoopError(error);
    }
  });

  app.get("/:slug/loops/:loopId/collisions", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const loopId = requiredLoopId(c.req.param("loopId"));

    try {
      return c.json({ loopId, collisions: await runtime.readLoopCollisions(project.workspaceRoot, loopId) });
    } catch (error) {
      throw mapLoopError(error);
    }
  });

  app.get("/:slug/loops/:loopId/integrations", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const loopId = requiredLoopId(c.req.param("loopId"));

    try {
      return c.json({ loopId, integrations: await runtime.readLoopIntegrationStatus(project.workspaceRoot, loopId) });
    } catch (error) {
      throw mapLoopError(error);
    }
  });

  app.get("/:slug/loops/:loopId/state", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const loopId = requiredLoopId(c.req.param("loopId"));

    try {
      const markdown = await runtime.readLoopStateMarkdown(project.workspaceRoot, loopId);
      const loop = await runtime.readLoop(project.workspaceRoot, loopId);
      return c.json({ markdown, state: loop });
    } catch (error) {
      throw mapLoopError(error);
    }
  });

  return app;
}

function createConfigFromBody(body: CreateLoopBody): LoopConfig {
  if ("config" in body) return body.config;

  if (!isSupportedLoopPreset(body.presetId)) {
    const reason = getUnsupportedLoopPresetReason(body.presetId);
    throw new BadRequestError(reason === undefined
      ? `Unsupported loop preset: ${body.presetId}`
      : `Unsupported loop preset: ${body.presetId}. ${reason}`);
  }

  try {
    return expandLoopPreset(body.presetId);
  } catch (error) {
    if (error instanceof RangeError) throw new BadRequestError(error.message);
    throw error;
  }
}

function toLoopUpdates(body: PatchLoopBody): LoopUpdateInput {
  return {
    ...(body.config === undefined ? {} : { config: body.config }),
    ...(body.status === undefined ? {} : { status: body.status }),
  };
}

function assertPhase4ApiLoopConfig(config: LoopConfig): void {
  const unsupportedFields: string[] = [];
  if (config.schedule.kind === "cron") unsupportedFields.push("schedule.kind=cron");
  if (config.triggers !== undefined) unsupportedFields.push("triggers");
  if (config.cleanupPolicy !== undefined) unsupportedFields.push("cleanupPolicy");

  if (unsupportedFields.length > 0) {
    throw new BadRequestError("Request body is invalid", {
      unsupportedFields,
      reason: "Phase 5 Loop API fields are not enabled on server routes yet",
    });
  }
}

function requiredParam(value: string | undefined, name: string): string {
  if (!value) throw new BadRequestError(`${name} is required`);
  return value;
}

function requiredLoopId(value: string | undefined): string {
  const loopId = requiredParam(value, "loopId");
  if (!LoopUuidSchema.safeParse(loopId).success) {
    throw new BadRequestError("loopId must be a UUID");
  }
  return loopId;
}

function parseOptionalLimit(value: string | undefined): number | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new BadRequestError("limit must be a non-negative integer");
  }
  return parsed;
}

async function readJsonBody<Schema extends z.ZodType>(bodyPromise: Promise<unknown>, schema: Schema): Promise<z.infer<Schema>> {
  let body: unknown;
  try {
    body = await bodyPromise;
  } catch {
    throw new BadRequestError("Request body must be valid JSON");
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestError("Request body is invalid", z.treeifyError(result.error));
  }
  return result.data;
}

async function readOptionalJsonBody<Schema extends z.ZodType>(bodyPromise: Promise<string>, schema: Schema): Promise<z.infer<Schema>> {
  const text = await bodyPromise;
  if (text.trim().length === 0) return schema.parse({});

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new BadRequestError("Request body must be valid JSON");
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestError("Request body is invalid", z.treeifyError(result.error));
  }
  return result.data;
}

function mapLoopError(error: unknown): Error {
  if (error instanceof LoopNotFoundError) {
    return new ServerError("SESSION_NOT_FOUND", error.message, 404);
  }
  if (error instanceof LoopActiveConflictError || isLoopActiveConflict(error)) {
    return new ServerError("LOOP_ACTIVE_CONFLICT", error.message, 409, {
      loopId: error.loopId,
      trigger: error.trigger,
      activeRunId: error.activeRunId,
      sessionId: error.sessionId,
    });
  }
  if (error instanceof LoopRunLogError || error instanceof LoopStateError) {
    return new ServerError("BAD_REQUEST", error.message, 409);
  }
  if (hasErrorName(error, "LoopPathError") || hasErrorName(error, "LoopInvalidIdError")) {
    return new BadRequestError(error.message);
  }
  if (error instanceof z.ZodError) {
    return new BadRequestError("Request body is invalid", z.treeifyError(error));
  }
  if (error instanceof Error) return error;
  return new Error(String(error));
}

function isLoopActiveConflict(error: unknown): error is Error & {
  code: "LOOP_ACTIVE_CONFLICT";
  loopId: string;
  trigger: string;
  activeRunId?: string;
  sessionId?: string;
} {
  return error instanceof Error && "code" in error && error.code === "LOOP_ACTIVE_CONFLICT" && "loopId" in error && "trigger" in error;
}

function hasErrorName(error: unknown, name: string): error is Error {
  return error instanceof Error && error.name === name;
}
