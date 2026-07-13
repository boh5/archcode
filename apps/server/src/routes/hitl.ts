import { Hono } from "hono";
import type {
  HitlAllowedAction,
  HitlIdentity,
  HitlOwnerType,
  HitlProjection,
  HitlRecord,
  HitlResponse,
  HitlSource,
  HitlStatus,
  GlobalSSEEvent,
} from "@archcode/protocol";
import { hitlRequiresInspection, type AgentRuntime, type ProjectContext, type ResumeCoordinatorResult } from "@archcode/agent-core";
import { z } from "zod/v4";
import { BadRequestError, ServerError } from "../errors";
import { resolveProject } from "../resolve";
import { globalEventBus } from "../events/global-event-bus";

type HitlRouteScope = "project" | "session" | "goal";
type HitlRouteStatus = "pending" | "recent" | "all";

interface HitlMutationResponse {
  hitlId: string;
  status: HitlStatus;
  hitl: HitlProjection;
}

const HitlListStatusSchema = z.enum(["pending", "recent", "all"]);
const HitlScopeSchema = z.enum(["project", "session", "goal"]);
const HitlOwnerTypeSchema = z.enum(["session", "goal"]);

const GoalEvidenceRefSchema = z.strictObject({
  kind: z.enum(["session", "message", "tool_call", "diff", "test_output", "file", "url", "hitl"]),
  ref: z.string(),
  summary: z.string(),
  sessionId: z.string().optional(),
  messageId: z.string().optional(),
  toolCallId: z.string().optional(),
  path: z.string().optional(),
  url: z.string().optional(),
  createdAt: z.string().optional(),
});

const GoalReviewReceiptSchema = z.strictObject({
  reviewGeneration: z.number().int().nonnegative(),
  verdict: z.enum(["DONE", "NOT_DONE"]),
  summary: z.string(),
  evidenceRefs: z.array(GoalEvidenceRefSchema),
  unresolvedItems: z.array(z.string()).optional(),
  reviewerSessionId: z.string(),
  decidedAt: z.string(),
});

const HitlResponseSchema: z.ZodType<HitlResponse> = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("question_answer"),
    answers: z.array(z.string()),
    comment: z.string().optional(),
    answeredBy: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("permission_decision"),
    decision: z.enum(["approve_once", "approve_always", "deny"]),
    comment: z.string().optional(),
    decidedBy: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("approval_decision"),
    decision: z.enum(["approved", "denied"]),
    comment: z.string().optional(),
    decidedBy: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("review_outcome"),
    outcome: z.enum(["DONE", "NOT_DONE"]),
    comment: z.string().optional(),
    receipt: GoalReviewReceiptSchema.optional(),
    reviewedBy: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("cancel"),
    reason: z.string(),
    cancelledBy: z.string().optional(),
  }),
]);

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
    }));

    return c.json({ hitl });
  });

  app.post("/:slug/hitl/:ownerType/:ownerId/:hitlId/respond", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const identity = hitlIdentityFromParams(
      project.slug,
      c.req.param("ownerType"),
      c.req.param("ownerId"),
      c.req.param("hitlId"),
    );
    const { hitlId } = identity;
    const response = await readJsonBody(c.req.json(), HitlResponseSchema);
    const context = await runtime.contextResolver.resolve(project.workspaceRoot);
    const lookup = await context.hitl.lookup(identity);
    if (lookup.status === "missing") throw hitlNotFound(hitlId);

    validateResponseForSource(lookup.record.source, response);
    const preflight = nonPendingPreflight(lookup.record, response);
    if (preflight !== undefined) return c.json(toMutationResponse(project, preflight.record), preflight.statusCode);

    const releaseSessionForwarder = await forwardSessionResumeEvents(runtime, project.workspaceRoot, project.slug, identity.owner, hitlId);
    const coordinator = requiredResumeCoordinator(context.hitlResumeCoordinator);
    let result: ResumeCoordinatorResult;
    try {
      result = await coordinator.respond(identity, response);
    } catch (error) {
      releaseSessionForwarder();
      throw error;
    }
    if (!result.scheduled) releaseSessionForwarder();
    const record = recordFromCoordinatorResult(result, hitlId);
    const statusCode = isConflictingMutation(record, response) ? 409 : 200;
    return c.json(toMutationResponse(project, record), statusCode);
  });

  app.post("/:slug/hitl/:ownerType/:ownerId/:hitlId/cancel", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const identity = hitlIdentityFromParams(
      project.slug,
      c.req.param("ownerType"),
      c.req.param("ownerId"),
      c.req.param("hitlId"),
    );
    const { hitlId } = identity;
    const body = await readOptionalJsonBody(c.req.text(), HitlCancelBodySchema);
    const context = await runtime.contextResolver.resolve(project.workspaceRoot);
    const lookup = await context.hitl.lookup(identity);
    if (lookup.status === "missing") throw hitlNotFound(hitlId);

    const response: HitlResponse = {
      type: "cancel",
      reason: body.reason ?? "Cancelled",
      ...(body.cancelledBy === undefined ? {} : { cancelledBy: body.cancelledBy }),
    };
    const preflight = nonPendingPreflight(lookup.record, response);
    if (preflight !== undefined) return c.json(toMutationResponse(project, preflight.record), preflight.statusCode);
    validateCancelAction(lookup.record);

    const releaseSessionForwarder = await forwardSessionResumeEvents(runtime, project.workspaceRoot, project.slug, identity.owner, hitlId);
    const coordinator = requiredResumeCoordinator(context.hitlResumeCoordinator);
    let result: ResumeCoordinatorResult;
    try {
      result = await coordinator.cancel(identity, response.reason, response.cancelledBy);
    } catch (error) {
      releaseSessionForwarder();
      throw error;
    }
    if (!result.scheduled) releaseSessionForwarder();
    const record = recordFromCoordinatorResult(result, hitlId);
    const statusCode = isConflictingMutation(record, response) ? 409 : 200;
    return c.json(toMutationResponse(project, record), statusCode);
  });

  return app;
}

async function forwardSessionResumeEvents(
  runtime: AgentRuntime,
  workspaceRoot: string,
  slug: string,
  owner: HitlRecord["owner"],
  hitlId: string,
): Promise<() => void> {
  if (owner.ownerType !== "session") return () => undefined;

  const sessionId = owner.ownerId;
  const eventCursor = await runtime.getSessionFile(workspaceRoot, sessionId)
    .then((session) => session.eventCursor ?? -1)
    .catch(() => -1);
  let released = false;
  let unsubscribe: (() => void) | undefined;
  let unsubscribeHitl: (() => void) | undefined;
  const timeout = setTimeout(() => release(), 5 * 60 * 1000);

  const release = (): void => {
    if (released) return;
    released = true;
    clearTimeout(timeout);
    unsubscribe?.();
    unsubscribeHitl?.();
  };

  unsubscribe = runtime.subscribeSessionEvents({
    slug,
    workspaceRoot,
    sessionId,
    startEventId: eventCursor + 1,
    onEvent(event) {
      if (!isHitlSessionEvent(event)) globalEventBus.emit(event);
      if (isExecutionEndAfter(event, sessionId, eventCursor)) release();
    },
  });

  unsubscribeHitl = runtime.subscribeHitlEvents((event) => {
    if (event.hitlId === hitlId && event.owner.ownerType === "session" && event.owner.ownerId === sessionId && event.payload.type === "hitl.resolved") release();
  });

  return release;
}

function isHitlSessionEvent(event: GlobalSSEEvent): boolean {
  return event.type === "event" && (
    event.payload.type === "hitl.request"
    || event.payload.type === "hitl.updated"
    || event.payload.type === "hitl.resolved"
  );
}

function isExecutionEndAfter(event: GlobalSSEEvent, sessionId: string, eventCursor: number): boolean {
  return event.type === "event"
    && event.sessionId === sessionId
    && event.payload.type === "execution-end"
    && event.eventId > eventCursor;
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
  if (scope !== "project" && !ownerId) throw new BadRequestError("ownerId is required for session and goal HITL scope");
  if (scope === "project" && ownerId) throw new BadRequestError("ownerId is only valid for session and goal HITL scope");

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
  } catch (error) {
    if (error instanceof ServerError) throw error;
    throw ownerNotFound(scope, id);
  }
}

function validateResponseForSource(source: HitlSource, response: HitlResponse): void {
  const expectedType = responseTypeForSource(source);
  if (response.type !== expectedType) throw invalidResponsePayload(expectedType);
}

function responseTypeForSource(source: HitlSource): Exclude<HitlResponse["type"], "cancel"> {
  switch (source.type) {
    case "ask_user":
    case "goal_question":
      return "question_answer";
    case "tool_permission":
      return "permission_decision";
    case "goal_approval":
    case "goal_budget":
      return "approval_decision";
    case "goal_review":
      return "review_outcome";
  }
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
  return {
    hitlId: record.hitlId,
    status: record.status,
    hitl: toProjection(project, record),
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
    ...(hitlRequiresInspection(record) ? { requiresInspection: true as const } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.resolvedAt === undefined ? {} : { resolvedAt: record.resolvedAt }),
  };
}

function allowedActionsFor(record: HitlRecord): HitlAllowedAction[] {
  if (record.status !== "pending") return [];
  switch (record.source.type) {
    case "ask_user":
    case "goal_question":
      return ["answer", "cancel"];
    case "tool_permission":
      return ["approve", "deny", "cancel"];
    case "goal_approval":
    case "goal_budget":
      return ["approve", "deny", "cancel"];
    case "goal_review":
      return ["approve", "deny", "cancel"];
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

function hitlIdentityFromParams(
  projectSlug: string,
  ownerTypeValue: string | undefined,
  ownerIdValue: string | undefined,
  hitlIdValue: string | undefined,
): HitlIdentity {
  const ownerType = parseOptionalEnum(ownerTypeValue, HitlOwnerTypeSchema, "ownerType");
  if (ownerType === undefined) throw new BadRequestError("ownerType is required");
  return {
    owner: {
      projectSlug,
      ownerType,
      ownerId: requiredParam(ownerIdValue, "ownerId"),
    },
    hitlId: requiredParam(hitlIdValue, "hitlId"),
  };
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

async function readOptionalJsonBody<Schema extends z.ZodType>(bodyPromise: Promise<string>, schema: Schema): Promise<z.infer<Schema>> {
  let rawBody: string;
  try {
    rawBody = await bodyPromise;
  } catch {
    throw new BadRequestError("Request body must be valid JSON");
  }
  if (rawBody.trim() === "") return schema.parse({});

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new BadRequestError("Request body must be valid JSON");
  }
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestError("Request body is invalid", z.treeifyError(result.error));
  return result.data;
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

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sortJson(entry)]));
}
