import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { Hono } from "hono";
import {
  expandLoopTemplate,
  LoopActiveConflictError,
  LoopNotFoundError,
  LoopRunLogError,
  LoopStateError,
  LoopUuidSchema,
  type AgentRuntime,
  type LoopConfig,
  type LoopIntegrationStatusSnapshot,
  type LoopRunReport,
  type LoopState,
  type LoopUpdateInput,
} from "@archcode/agent-core";
import type {
  LoopApprovalPolicy,
  LoopGoalTemplate,
  LoopIntegrationSnapshot,
  LoopLimits,
  LoopScheduleSpec,
  LoopTemplateId,
  LoopTriggerSpec,
} from "@archcode/protocol";
import { z } from "zod/v4";
import { BadRequestError, ServerError } from "../errors";
import { redactPublicString } from "../redact";
import { resolveProject } from "../resolve";

const LoopTextSchema = z.string().trim().min(1).max(10_000);
const LoopIdentifierSchema = z.string().trim().min(1).max(200);
const TriggerCadenceMsSchema = z.number().int().min(30_000);
const CronExpressionSchema = z.string().trim().refine((value) => value.split(/\s+/).length === 5, {
  message: "Cron expressions must use exactly 5 UTC fields",
});

const LoopTemplateIdSchema = z.enum(["watch_report", "maintain_fix", "pr_babysitter", "goal_runner"]) satisfies z.ZodType<LoopTemplateId>;
const LoopApprovalPolicySchema = z.enum(["interactive", "explicit_per_run"]) satisfies z.ZodType<LoopApprovalPolicy>;
const LoopScheduleSpecSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("manual") }),
  z.strictObject({ kind: z.literal("interval"), everyMs: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("cron"), expression: CronExpressionSchema }),
]) satisfies z.ZodType<LoopScheduleSpec>;

const BudgetThresholdRatioSchema = z.number().min(0).max(1);
const LoopLimitsSchema = z.strictObject({
  maxIterationsPerRun: z.number().int().positive(),
  maxTokensPerRun: z.number().int().positive().optional(),
  maxEstimatedUsdPerRun: z.number().positive().optional(),
  maxWallClockMsPerRun: z.number().int().positive().optional(),
  maxRunsPerDay: z.number().int().positive().optional(),
  softThresholdRatio: BudgetThresholdRatioSchema,
  hardThresholdRatio: BudgetThresholdRatioSchema,
}) satisfies z.ZodType<LoopLimits>;

const LoopPullRequestScopeSchema = z.enum(["open", "authored", "assigned", "review_requested"]);
const LoopTriggerSpecSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("on_commit"),
    branch: LoopIdentifierSchema.optional(),
    cadenceMs: TriggerCadenceMsSchema,
  }),
  z.strictObject({
    kind: z.literal("on_pr"),
    branch: LoopIdentifierSchema.optional(),
    baseBranch: LoopIdentifierSchema.optional(),
    prScope: LoopPullRequestScopeSchema.optional(),
    cadenceMs: TriggerCadenceMsSchema,
  }),
  z.strictObject({
    kind: z.literal("on_ci_fail"),
    branch: LoopIdentifierSchema.optional(),
    baseBranch: LoopIdentifierSchema.optional(),
    checkName: LoopIdentifierSchema.optional(),
    workflowName: LoopIdentifierSchema.optional(),
    cadenceMs: TriggerCadenceMsSchema,
  }),
]) satisfies z.ZodType<LoopTriggerSpec>;

const LoopGoalTemplateBodySchema = z.strictObject({
  objective: LoopTextSchema,
  acceptanceCriteria: LoopTextSchema,
});

const CreateLoopBodySchema = z.strictObject({
  templateId: LoopTemplateIdSchema,
  schedule: LoopScheduleSpecSchema,
  approvalPolicy: LoopApprovalPolicySchema,
  limits: LoopLimitsSchema,
  taskPrompt: LoopTextSchema.optional(),
  goalTemplate: LoopGoalTemplateBodySchema.optional(),
  triggers: z.array(LoopTriggerSpecSchema).max(50).optional(),
  useWorktree: z.boolean(),
});

const PatchLoopBodySchema = z.strictObject({
  status: z.enum(["active", "paused", "disabled", "error"]).optional(),
  templateId: LoopTemplateIdSchema.optional(),
  schedule: LoopScheduleSpecSchema.optional(),
  approvalPolicy: LoopApprovalPolicySchema.optional(),
  limits: LoopLimitsSchema.optional(),
  taskPrompt: LoopTextSchema.optional(),
  goalTemplate: LoopGoalTemplateBodySchema.optional(),
  triggers: z.array(LoopTriggerSpecSchema).max(50).optional(),
  useWorktree: z.boolean().optional(),
});

const ActivateKillBodySchema = z.strictObject({
  activatedBy: z.string().trim().min(1).max(200).optional(),
  reason: z.string().trim().min(1).max(20_000).optional(),
});

type CreateLoopBody = z.infer<typeof CreateLoopBodySchema>;
type PatchLoopBody = z.infer<typeof PatchLoopBodySchema>;
type LoopGoalTemplateBody = z.infer<typeof LoopGoalTemplateBodySchema>;
type EditableLoopBody = {
  readonly templateId?: LoopTemplateId;
  readonly schedule?: LoopScheduleSpec;
  readonly approvalPolicy?: LoopApprovalPolicy;
  readonly limits?: LoopLimits;
  readonly taskPrompt?: string;
  readonly goalTemplate?: LoopGoalTemplateBody;
  readonly triggers?: LoopTriggerSpec[];
  readonly useWorktree?: boolean;
};
const EDITABLE_LOOP_BODY_FIELDS = [
  "templateId",
  "schedule",
  "approvalPolicy",
  "limits",
  "taskPrompt",
  "goalTemplate",
  "triggers",
  "useWorktree",
] as const satisfies readonly (keyof EditableLoopBody)[];

export function createLoopsRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();

  app.get("/:slug/loops", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    try {
      const loops = await runtime.listLoops(project.workspaceRoot);
      return c.json({ loops: loops.map((loop) => sanitizeLoopState(loop, project.workspaceRoot)) });
    } catch (error) {
      throw mapLoopError(error);
    }
  });

  app.post("/:slug/loops", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const body = await readJsonBody(c.req.json(), CreateLoopBodySchema, rejectUnsupportedProjectConfig);
    const config = createConfigFromBody(body);
    assertRouteLoopConfig(config);

    try {
      const loop = await runtime.createLoop(project.workspaceRoot, config);
      return c.json({ loop: sanitizeLoopState(loop, project.workspaceRoot) }, 201);
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
      const loop = await runtime.readLoop(project.workspaceRoot, loopId);
      return c.json({ loop: sanitizeLoopState(loop, project.workspaceRoot) });
    } catch (error) {
      throw mapLoopError(error);
    }
  });

  app.patch("/:slug/loops/:loopId", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const loopId = requiredLoopId(c.req.param("loopId"));
    const body = await readJsonBody(c.req.json(), PatchLoopBodySchema, rejectUnsupportedProjectConfig);
    if (Object.keys(body).length === 0) {
      throw new BadRequestError("At least one patch field is required");
    }

    try {
      const currentConfig = hasEditableLoopBodyFields(body)
        ? (await runtime.readLoop(project.workspaceRoot, loopId)).config
        : undefined;
      const updates = toLoopUpdates(body, currentConfig);
      if (updates.config !== undefined) assertRouteLoopConfig(updates.config);
      const loop = await runtime.updateLoop(project.workspaceRoot, loopId, updates);
      return c.json({ loop: sanitizeLoopState(loop, project.workspaceRoot) });
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
          report: sanitizeRunReport(report, project.workspaceRoot),
        });
      }
      return c.json({ report: report === undefined ? null : sanitizeRunReport(report, project.workspaceRoot) });
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
      return c.json({ ok: true, loopId, runId: report.runId, status: report.status, reason: report.reason, report: sanitizeRunReport(report, project.workspaceRoot) });
    } catch (error) {
      throw mapLoopError(error);
    }
  });

  app.post("/:slug/loops/:loopId/pause", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const loopId = requiredLoopId(c.req.param("loopId"));

    try {
      const loop = await runtime.pauseLoop(project.workspaceRoot, loopId);
      return c.json({ loop: sanitizeLoopState(loop, project.workspaceRoot) });
    } catch (error) {
      throw mapLoopError(error);
    }
  });

  app.post("/:slug/loops/:loopId/resume", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const loopId = requiredLoopId(c.req.param("loopId"));

    try {
      const loop = await runtime.resumeLoop(project.workspaceRoot, loopId);
      return c.json({ loop: sanitizeLoopState(loop, project.workspaceRoot) });
    } catch (error) {
      throw mapLoopError(error);
    }
  });

  app.get("/:slug/loops/:loopId/runs", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const loopId = requiredLoopId(c.req.param("loopId"));
    const limit = parseOptionalLimit(c.req.query("limit"));

    try {
      const runs = await runtime.readLoopRunLog(project.workspaceRoot, loopId, limit);
      return c.json({ runs: runs.map((run) => sanitizeRunReport(run, project.workspaceRoot)) });
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
      const integrations = await runtime.readLoopIntegrationStatus(project.workspaceRoot, loopId);
      return c.json({ loopId, integrations: sanitizeIntegrationStatusSnapshot(integrations) });
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
      return c.json({ markdown, state: sanitizeLoopState(loop, project.workspaceRoot) });
    } catch (error) {
      throw mapLoopError(error);
    }
  });

  return app;
}

function createConfigFromBody(body: CreateLoopBody): LoopConfig {
  try {
    return applyEditableConfigFields(expandLoopTemplate(body.templateId), body);
  } catch (error) {
    if (error instanceof RangeError) throw new BadRequestError(error.message);
    throw error;
  }
}

function toLoopUpdates(body: PatchLoopBody, currentConfig: LoopConfig | undefined): LoopUpdateInput {
  const baseConfig = currentConfig === undefined
    ? undefined
      : body.templateId === undefined
        ? currentConfig
        : { ...expandLoopTemplate(body.templateId), title: currentConfig.title };
  return {
    ...(baseConfig === undefined ? {} : { config: applyEditableConfigFields(baseConfig, body) }),
    ...(body.status === undefined ? {} : { status: body.status }),
  };
}

function applyEditableConfigFields(baseConfig: LoopConfig, body: EditableLoopBody): LoopConfig {
  const nextConfig: LoopConfig = {
    ...baseConfig,
    ...(body.templateId === undefined ? {} : { templateId: body.templateId }),
    ...(body.schedule === undefined ? {} : { schedule: body.schedule }),
    ...(body.approvalPolicy === undefined ? {} : { approvalPolicy: body.approvalPolicy }),
    ...(body.limits === undefined ? {} : { limits: body.limits }),
    ...(body.taskPrompt === undefined ? {} : { taskPrompt: body.taskPrompt }),
    ...(body.goalTemplate === undefined ? {} : { goalTemplate: toLoopGoalTemplate(body.goalTemplate) }),
    ...(body.triggers === undefined ? {} : { triggers: body.triggers }),
    ...(body.useWorktree === undefined ? {} : { useWorktree: body.useWorktree }),
  };
  assertRouteLoopConfig(nextConfig);
  return nextConfig;
}

function hasEditableLoopBodyFields(body: PatchLoopBody): boolean {
  return EDITABLE_LOOP_BODY_FIELDS.some((field) => body[field] !== undefined);
}

function assertRouteLoopConfig(config: LoopConfig): void {
  if (config.templateId === "goal_runner" && config.goalTemplate === undefined) {
    throw new BadRequestError("Request body is invalid", {
      validationMessages: ["goalTemplate is required for goal_runner loops"],
    });
  }

  if (config.schedule.kind !== "cron") return;

  try {
    const next = Bun.cron.parse(config.schedule.expression, new Date(0));
    if (next === null) throw new Error("Cron expression has no future occurrence");
  } catch {
    throw new BadRequestError("Request body is invalid", {
      validationMessages: ["schedule.expression must be a valid 5-field UTC cron expression"],
    });
  }
}

function toLoopGoalTemplate(body: LoopGoalTemplateBody): LoopGoalTemplate {
  return {
    title: null,
    objective: body.objective,
    acceptanceCriteria: body.acceptanceCriteria,
  };
}

function sanitizeLoopState(loop: LoopState, workspaceRoot: string): LoopState {
  return {
    ...loop,
    ...(loop.lastRun === undefined ? {} : { lastRun: sanitizeRunReport(loop.lastRun, workspaceRoot) }),
    ...(loop.currentRun === undefined ? {} : { currentRun: sanitizeRunReport(loop.currentRun, workspaceRoot) }),
    ...(loop.latestIntegrations === undefined ? {} : { latestIntegrations: sanitizeIntegrationSnapshot(loop.latestIntegrations) }),
    ...(loop.triggerHealth === undefined ? {} : { triggerHealth: loop.triggerHealth.map((health) => ({
      ...health,
      ...(health.lastError === undefined ? {} : { lastError: redactPublicString(health.lastError) }),
    })) }),
  };
}

function sanitizeRunReport(report: LoopRunReport, workspaceRoot: string): LoopRunReport {
  const worktreePath = safeWorktreePath(report.worktreePath, workspaceRoot);
  return {
    ...report,
    ...(worktreePath === undefined
      ? {
          worktreePath: undefined,
          worktreeBranchName: undefined,
          baseSha: undefined,
          resolvedHeadSha: undefined,
        }
      : { worktreePath }),
    ...(report.integrationErrors === undefined ? {} : {
      integrationErrors: report.integrationErrors.map((error) => ({
        ...error,
        message: redactPublicString(error.message),
      })),
    }),
    ...(report.error === undefined ? {} : { error: redactPublicString(report.error) }),
    ...(report.skippedReason === undefined ? {} : { skippedReason: redactPublicString(report.skippedReason) }),
    ...(report.summary === undefined ? {} : { summary: redactPublicString(report.summary) }),
    ...(report.blockedReason === undefined ? {} : { blockedReason: redactPublicString(report.blockedReason) }),
  };
}

function sanitizeIntegrationSnapshot(snapshot: LoopIntegrationSnapshot): LoopIntegrationSnapshot {
  return {
    ...snapshot,
    errors: snapshot.errors.map((error) => ({
      ...error,
      message: redactPublicString(error.message),
    })),
  };
}

function sanitizeIntegrationStatusSnapshot(snapshot: LoopIntegrationStatusSnapshot): LoopIntegrationStatusSnapshot {
  return {
    ...snapshot,
    statuses: snapshot.statuses.map((status) => ({
      ...status,
      ...(status.message === undefined ? {} : { message: redactPublicString(status.message) }),
    })),
    snapshot: snapshot.snapshot === null ? null : sanitizeIntegrationSnapshot(snapshot.snapshot),
  };
}

function safeWorktreePath(worktreePath: string | undefined, workspaceRoot: string): string | undefined {
  if (worktreePath === undefined || !isAbsolute(worktreePath)) return undefined;

  const managedRoot = resolve(dirname(workspaceRoot), `${basename(workspaceRoot)}.worktrees`);
  const normalizedPath = resolve(worktreePath);
  const relativePath = relative(managedRoot, normalizedPath);
  if (relativePath.length === 0 || relativePath.startsWith("..") || isAbsolute(relativePath)) return undefined;
  return normalizedPath;
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

async function readJsonBody<Schema extends z.ZodType>(
  bodyPromise: Promise<unknown>,
  schema: Schema,
  validateBody?: (body: unknown) => void,
): Promise<z.infer<Schema>> {
  let body: unknown;
  try {
    body = await bodyPromise;
  } catch {
    throw new BadRequestError("Request body must be valid JSON");
  }

  validateBody?.(body);

  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestError("Request body is invalid", validationDetails(result.error));
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
    throw new BadRequestError("Request body is invalid", validationDetails(result.error));
  }
  return result.data;
}

function rejectUnsupportedProjectConfig(body: unknown): void {
  if (!isRecord(body) || !("projectConfig" in body)) return;

  const projectConfig = body.projectConfig;
  if (isRecord(projectConfig)) {
    const coordinator = projectConfig.coordinator;
    if (isRecord(coordinator) && "maxConcurrent" in coordinator && !isPositiveInteger(coordinator.maxConcurrent)) {
      throw new BadRequestError("Request body is invalid", {
        validationMessages: ["projectConfig.coordinator.maxConcurrent must be greater than 0"],
      });
    }
  }

  throw new BadRequestError("Request body is invalid", {
    validationMessages: ["projectConfig is not currently supported by server loop routes"],
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function validationDetails(error: z.ZodError): unknown {
  const details = z.treeifyError(error) as Record<string, unknown>;
  const validationMessages = stableValidationMessages(error);
  if (validationMessages.length === 0) return details;
  return { ...details, validationMessages };
}

function stableValidationMessages(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join(".");
    if (path.endsWith("schedule.expression")) return "schedule.expression must be a valid 5-field UTC cron expression";
    if (path.includes("triggers") && path.endsWith("cadenceMs")) return `${path} must be at least 30000`;
    if (path === "projectConfig.coordinator.maxConcurrent") return "projectConfig.coordinator.maxConcurrent must be greater than 0";
    return issue.message;
  });
}

function mapLoopError(error: unknown): Error {
  if (error instanceof LoopNotFoundError) {
    return new ServerError("LOOP_NOT_FOUND", error.message, 404);
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
