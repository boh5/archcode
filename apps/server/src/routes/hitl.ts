import { Hono } from "hono";
import type {
  HitlAllowedAction,
  HitlOwnerType,
  HitlProjection,
  HitlRecord,
  HitlResponse,
  HitlSource,
  HitlStatus,
} from "@archcode/protocol";
import type { AgentRuntime, ProjectContext, ResumeCoordinatorResult } from "@archcode/agent-core";
import { z } from "zod/v4";
import { globalEventBus } from "../events/global-event-bus";
import { BadRequestError, ServerError } from "../errors";
import { resolveProject } from "../resolve";

type HitlRouteScope = "project" | "session" | "goal" | "loop";
type HitlRouteStatus = "pending" | "recent" | "all";
type ResumeStatus = "idle" | "claimed" | "failed" | "terminal";

type HitlMutationBody = z.infer<typeof HitlMutationBodySchema>;

interface HitlApiProjection extends HitlProjection {
  resumeStatus: ResumeStatus;
}

interface HitlMutationResponse {
  hitlId: string;
  status: HitlStatus;
  resumeStatus: ResumeStatus;
  hitl: HitlApiProjection;
}

const HitlListStatusSchema = z.enum(["pending", "recent", "all"]);
const HitlScopeSchema = z.enum(["project", "session", "goal", "loop"]);

const HitlMutationBodySchema = z.strictObject({
  type: z.enum(["question_answer", "permission_decision", "approval_decision", "review_outcome"]).optional(),
  answers: z.array(z.string()).optional(),
  decision: z.enum(["approve_once", "approve_always", "deny", "approved", "denied"]).optional(),
  outcome: z.enum(["DONE", "NOT_DONE"]).optional(),
  comment: z.string().optional(),
  answeredBy: z.string().optional(),
  decidedBy: z.string().optional(),
  reviewedBy: z.string().optional(),
});

const HitlCancelBodySchema = z.strictObject({
  reason: z.string().trim().min(1).optional(),
  cancelledBy: z.string().optional(),
});

const TERMINAL_STATUSES = new Set<HitlStatus>(["resolved", "cancelled"]);

export function createHitlRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();

  app.get("/:slug/hitl", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const context = await runtime.contextResolver.resolve(project.workspaceRoot);
    const query = parseListQuery(c.req.query());
    await assertOwnerExists(runtime, project.workspaceRoot, context, query.scope, query.ownerId);

    const hitl = (await context.hitl.list({
      scope: query.scope,
      ...(query.ownerId === undefined ? {} : { ownerId: query.ownerId }),
      includeChildren: query.includeChildren,
      status: statusForService(query.status),
    })).map(withResumeStatus);

    return c.json({ hitl });
  });

  app.post("/:slug/hitl/:hitlId/respond", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const hitlId = requiredParam(c.req.param("hitlId"), "hitlId");
    const body = await readJsonBody(c.req.json(), HitlMutationBodySchema);
    const context = await runtime.contextResolver.resolve(project.workspaceRoot);
    const lookup = await context.hitl.lookup(hitlId);
    if (lookup.status === "missing") throw hitlNotFound(hitlId);
    if (lookup.status === "ambiguous") throw ambiguousHitl(hitlId);
    if (lookup.owner.projectSlug !== project.slug) throw hitlNotFound(hitlId);

    const response = responseForSource(lookup.record.source, body);
    const preflight = nonPendingPreflight(lookup.record, response);
    if (preflight !== undefined) return c.json(toMutationResponse(project, preflight.record), preflight.statusCode);

    const coordinator = requiredResumeCoordinator(context.hitlResumeCoordinator);
    const result = await coordinator.respond(hitlId, response);
    const record = recordFromCoordinatorResult(result, hitlId);
    if (lookup.record.status === "pending" && result.status === "claimed") emitHitlChanged(record);
    const statusCode = isConflictingMutation(record, response) ? 409 : 200;
    return c.json(toMutationResponse(project, record), statusCode);
  });

  app.post("/:slug/hitl/:hitlId/cancel", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const hitlId = requiredParam(c.req.param("hitlId"), "hitlId");
    const body = await readOptionalJsonBody(c.req.json(), HitlCancelBodySchema);
    const context = await runtime.contextResolver.resolve(project.workspaceRoot);
    const lookup = await context.hitl.lookup(hitlId);
    if (lookup.status === "missing") throw hitlNotFound(hitlId);
    if (lookup.status === "ambiguous") throw ambiguousHitl(hitlId);
    if (lookup.owner.projectSlug !== project.slug) throw hitlNotFound(hitlId);

    const response: HitlResponse = {
      type: "cancel",
      reason: body.reason ?? "Cancelled",
      ...(body.cancelledBy === undefined ? {} : { cancelledBy: body.cancelledBy }),
    };
    const preflight = nonPendingPreflight(lookup.record, response);
    if (preflight !== undefined) return c.json(toMutationResponse(project, preflight.record), preflight.statusCode);
    validateCancelAction(lookup.record);

    const coordinator = requiredResumeCoordinator(context.hitlResumeCoordinator);
    const result = await coordinator.cancel(hitlId, response.reason, response.cancelledBy);
    const record = recordFromCoordinatorResult(result, hitlId);
    if (lookup.record.status === "pending" && result.status === "claimed") emitHitlChanged(record);
    const statusCode = isConflictingMutation(record, response) ? 409 : 200;
    return c.json(toMutationResponse(project, record), statusCode);
  });

  return app;
}

function parseListQuery(query: Record<string, string | undefined>): {
  scope: HitlRouteScope;
  ownerId?: string;
  includeChildren: boolean;
  status: HitlRouteStatus;
} {
  const scope = parseOptionalEnum(query.scope, HitlScopeSchema, "scope") ?? "project";
  const status = parseOptionalEnum(query.status, HitlListStatusSchema, "status") ?? "pending";
  const includeChildren = parseIncludeChildren(query.includeChildren);
  const ownerId = query.ownerId?.trim();
  if (scope !== "project" && !ownerId) throw new BadRequestError("ownerId is required for session, goal, and loop HITL scope");
  if (scope === "project" && ownerId) throw new BadRequestError("ownerId is only valid for session, goal, and loop HITL scope");

  return {
    scope,
    ...(ownerId ? { ownerId } : {}),
    includeChildren,
    status,
  };
}

function parseIncludeChildren(value: string | undefined): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new BadRequestError("includeChildren must be true or false");
}

function parseOptionalEnum<Schema extends z.ZodEnum>(value: string | undefined, schema: Schema, name: string): z.infer<Schema> | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestError(`${name} is invalid`, z.treeifyError(result.error));
  return result.data;
}

function statusForService(status: HitlRouteStatus): "active" | "terminal" | "all" {
  switch (status) {
    case "pending":
      return "active";
    case "recent":
      return "terminal";
    case "all":
      return "all";
  }
}

async function assertOwnerExists(
  runtime: AgentRuntime,
  workspaceRoot: string,
  context: ProjectContext,
  scope: HitlRouteScope,
  ownerId: string | undefined,
): Promise<void> {
  if (scope === "project") return;
  const id = ownerId ?? "";
  try {
    if (scope === "session") {
      await runtime.getSessionFile(workspaceRoot, id);
      return;
    }
    if (scope === "goal") {
      await context.goalState.read(id);
      return;
    }
    await context.loopState.read(id);
  } catch (error) {
    if (error instanceof ServerError) throw error;
    throw ownerNotFound(scope, id);
  }
}

function responseForSource(source: HitlSource, body: HitlMutationBody): HitlResponse {
  switch (source.type) {
    case "ask_user":
    case "goal_question":
    case "loop_question":
      return questionResponse(body);
    case "tool_permission":
      return permissionResponse(body);
    case "goal_approval":
    case "goal_budget":
    case "loop_approval":
      return approvalResponse(body, { allowDenied: true });
    case "loop_blocker":
    case "loop_retry":
      return approvalResponse(body, { allowDenied: false });
    case "goal_review":
      return reviewResponse(body);
  }
}

function questionResponse(body: HitlMutationBody): HitlResponse {
  if (body.type !== undefined && body.type !== "question_answer") throw invalidResponsePayload("question_answer");
  if (body.answers === undefined || body.answers.length === 0) throw new BadRequestError("answers are required for question HITL responses");
  return {
    type: "question_answer",
    answers: body.answers,
    ...(body.comment === undefined ? {} : { comment: body.comment }),
    ...(body.answeredBy === undefined ? {} : { answeredBy: body.answeredBy }),
  };
}

function permissionResponse(body: HitlMutationBody): HitlResponse {
  if (body.type !== undefined && body.type !== "permission_decision") throw invalidResponsePayload("permission_decision");
  if (body.decision !== "approve_once" && body.decision !== "approve_always" && body.decision !== "deny") {
    throw new BadRequestError("decision must be approve_once, approve_always, or deny for permission HITL responses");
  }
  return {
    type: "permission_decision",
    decision: body.decision,
    ...(body.comment === undefined ? {} : { comment: body.comment }),
    ...(body.decidedBy === undefined ? {} : { decidedBy: body.decidedBy }),
  };
}

function approvalResponse(body: HitlMutationBody, options: { allowDenied: boolean }): HitlResponse {
  if (body.type !== undefined && body.type !== "approval_decision") throw invalidResponsePayload("approval_decision");
  if (body.decision !== "approved" && body.decision !== "denied") {
    throw new BadRequestError("decision must be approved or denied for approval HITL responses");
  }
  if (!options.allowDenied && body.decision === "denied") throw new BadRequestError("deny is not an allowed action for this HITL source");
  return {
    type: "approval_decision",
    decision: body.decision,
    ...(body.comment === undefined ? {} : { comment: body.comment }),
    ...(body.decidedBy === undefined ? {} : { decidedBy: body.decidedBy }),
  };
}

function reviewResponse(body: HitlMutationBody): HitlResponse {
  if (body.type !== undefined && body.type !== "review_outcome") throw invalidResponsePayload("review_outcome");
  if (body.outcome !== "DONE" && body.outcome !== "NOT_DONE") {
    throw new BadRequestError("outcome must be DONE or NOT_DONE for review HITL responses");
  }
  return {
    type: "review_outcome",
    outcome: body.outcome,
    ...(body.comment === undefined ? {} : { comment: body.comment }),
    ...(body.reviewedBy === undefined ? {} : { reviewedBy: body.reviewedBy }),
  };
}

function validateCancelAction(record: HitlRecord): void {
  if (!allowedActionsFor(record).includes("cancel")) throw new BadRequestError(`Cannot cancel HITL with status ${record.status}`);
}

function nonPendingPreflight(record: HitlRecord, response: HitlResponse): { statusCode: 200 | 409; record: HitlRecord } | undefined {
  if (record.status === "pending") return undefined;
  if (record.response !== undefined) return { statusCode: responsesEquivalent(record.response, response) ? 200 : 409, record };
  if (TERMINAL_STATUSES.has(record.status)) return { statusCode: 409, record };
  throw new BadRequestError(`Cannot mutate HITL with status ${record.status}`);
}

function recordFromCoordinatorResult(
  result: ResumeCoordinatorResult,
  hitlId: string,
): HitlRecord {
  if (result.status === "missing") throw hitlNotFound(hitlId);
  if (result.status === "ambiguous") throw ambiguousHitl(hitlId);
  return result.record;
}

function isConflictingMutation(record: HitlRecord, response: HitlResponse): boolean {
  return record.response !== undefined && !responsesEquivalent(record.response, response);
}

function responsesEquivalent(left: HitlResponse | undefined, right: HitlResponse): boolean {
  if (left === undefined) return false;
  return stableJson(left) === stableJson(right);
}

function toMutationResponse(project: { slug: string; name?: string }, record: HitlRecord): HitlMutationResponse {
  const hitl = withResumeStatus(toProjection(project, record));
  return {
    hitlId: record.hitlId,
    status: record.status,
    resumeStatus: hitl.resumeStatus,
    hitl,
  };
}

function toProjection(project: { slug: string; name?: string }, record: HitlRecord): HitlProjection {
  return {
    hitlId: record.hitlId,
    project: { slug: project.slug, ...(project.name === undefined ? {} : { name: project.name }) },
    owner: record.owner,
    source: record.source,
    status: record.status,
    displayPayload: record.displayPayload,
    allowedActions: allowedActionsFor(record),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.resolvedAt === undefined ? {} : { resolvedAt: record.resolvedAt }),
  };
}

function withResumeStatus(projection: HitlProjection): HitlApiProjection {
  return { ...projection, resumeStatus: resumeStatusFor(projection.status) };
}

function emitHitlChanged(record: HitlRecord): void {
  globalEventBus.emit({
    type: "hitl.changed",
    projectSlug: record.owner.projectSlug,
    ownerType: record.owner.ownerType,
    ownerId: record.owner.ownerId,
    hitlId: record.hitlId,
    ...hitlIdentifierHints(record.source),
    createdAt: Date.now(),
  });
}

function hitlIdentifierHints(source: HitlSource): { goalId?: string; loopId?: string; sessionId?: string } {
  switch (source.type) {
    case "ask_user":
    case "tool_permission":
      return { sessionId: source.sessionId };
    case "goal_approval":
    case "goal_review":
    case "goal_budget":
    case "goal_question":
      return { goalId: source.goalId };
    case "loop_approval":
    case "loop_blocker":
    case "loop_retry":
    case "loop_question":
      return { loopId: source.loopId };
  }
}

function resumeStatusFor(status: HitlStatus): ResumeStatus {
  switch (status) {
    case "pending":
      return "idle";
    case "resume_claimed":
      return "claimed";
    case "resume_failed":
      return "failed";
    case "resolved":
    case "cancelled":
      return "terminal";
  }
}

function allowedActionsFor(record: HitlRecord): HitlAllowedAction[] {
  if (record.status === "resume_failed") return ["retry_resume", "cancel"];
  if (record.status !== "pending") return [];
  switch (record.source.type) {
    case "ask_user":
    case "goal_question":
    case "loop_question":
      return ["answer", "cancel"];
    case "tool_permission":
      return ["approve", "deny", "cancel"];
    case "goal_approval":
    case "goal_budget":
    case "loop_approval":
      return ["approve", "deny", "cancel"];
    case "goal_review":
      return ["approve", "deny", "cancel"];
    case "loop_blocker":
    case "loop_retry":
      return ["approve", "cancel"];
  }
}

function requiredResumeCoordinator(
  coordinator: ProjectContext["hitlResumeCoordinator"],
): NonNullable<ProjectContext["hitlResumeCoordinator"]> {
  if (coordinator === undefined) throw new ServerError("INTERNAL_ERROR", "HITL resume coordinator is not available", 500);
  return coordinator;
}

function requiredParam(value: string | undefined, name: string): string {
  if (!value) throw new BadRequestError(`${name} is required`);
  return value;
}

async function readJsonBody<Schema extends z.ZodType>(bodyPromise: Promise<unknown>, schema: Schema): Promise<z.infer<Schema>> {
  let body: unknown;
  try {
    body = await bodyPromise;
  } catch {
    throw new BadRequestError("Request body must be valid JSON");
  }

  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestError("Request body is invalid", z.treeifyError(result.error));
  return result.data;
}

async function readOptionalJsonBody<Schema extends z.ZodType>(bodyPromise: Promise<unknown>, schema: Schema): Promise<z.infer<Schema>> {
  try {
    return await readJsonBody(bodyPromise, schema);
  } catch (error) {
    if (error instanceof BadRequestError && error.message === "Request body must be valid JSON") return schema.parse({});
    throw error;
  }
}

function invalidResponsePayload(expectedType: HitlResponse["type"]): BadRequestError {
  return new BadRequestError(`Response type must be ${expectedType}`);
}

function ownerNotFound(scope: HitlOwnerType, ownerId: string): ServerError {
  return new ServerError("QUESTION_NOT_FOUND", `HITL ${scope} owner not found: ${ownerId}`, 404);
}

function hitlNotFound(hitlId: string): ServerError {
  return new ServerError("QUESTION_NOT_FOUND", `HITL request not found: ${hitlId}`, 404);
}

function ambiguousHitl(hitlId: string): ServerError {
  return new ServerError("INTERNAL_ERROR", `Ambiguous HITL request id: ${hitlId}`, 500);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sortJson(entry)]));
}
