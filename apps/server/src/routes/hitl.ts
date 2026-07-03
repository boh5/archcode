import { Hono } from "hono";
import type { AgentRuntime, ProjectInfo } from "@archcode/agent-core";
import { z } from "zod/v4";
import { BadRequestError, ServerError } from "../errors";
import { resolveProject } from "../resolve";

const HitlResponseBodySchema = z.strictObject({
  decision: z.string().trim().min(1).optional(),
  answers: z.unknown().optional(),
  outcome: z.enum(["DONE", "NOT_DONE"]).optional(),
  comment: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

const HitlCancelBodySchema = z.strictObject({
  reason: z.string().trim().min(1).optional(),
});

type HitlRequest = {
  hitlId: string;
  sessionId: string;
  kind: "question" | "approval" | "review";
  payload: unknown;
  displayPayload?: unknown;
  approvalKey?: string;
  trigger: {
    projectSlug?: string;
    goalId?: string;
    loopId?: string;
    source?: string;
    approvalPoint?: string;
    toolCallId?: string;
    timeoutMs?: number;
  };
  createdAt: number;
};

type HitlDisplayPayload = {
  title: string;
  summary?: string;
  fields?: Array<{ label: string; value: string }>;
  redacted: true;
};

type DashboardHitlRequest = {
  hitlId: string;
  sessionId: string;
  kind: HitlRequest["kind"];
  trigger: HitlRequest["trigger"];
  createdAt: number;
  displayPayload?: HitlDisplayPayload;
  approvalKey?: string;
  projectSlug: string;
  projectName: string;
  status: "pending";
};

type HitlRouteScope = "global" | "project";

export function createHitlRoutes(runtime: AgentRuntime, scope: HitlRouteScope = "global"): Hono {
  const app = new Hono();

  if (scope === "global") {
    app.get("/hitl", async (c) => {
      const status = parseHitlStatusFilter(c.req.query("status"));
      const hitl = status === "pending" ? await aggregatePendingHitl(runtime) : [];
      return c.json({ hitl });
    });

    app.post("/hitl/:id/respond", async (c) => {
      const hitlId = requiredParam(c.req.param("id"), "id");
      throw projectScopedHitlMutationRequired(hitlId);
    });

    app.post("/hitl/:id/cancel", async (c) => {
      const hitlId = requiredParam(c.req.param("id"), "id");
      throw projectScopedHitlMutationRequired(hitlId);
    });
  }

  if (scope === "project") {
    app.get("/:slug/hitl", async (c) => {
      const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
      const context = await runtime.contextResolver.resolve(project.workspaceRoot);
      const hitl = context.hitl.listPending(project.slug).map((request) => withProject(request as HitlRequest, project));
      return c.json({ hitl });
    });

    app.post("/:slug/hitl/:id/respond", async (c) => {
      const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
      const hitlIdentifier = requiredParam(c.req.param("id"), "id");
      const body = await readJsonBody(c.req.json(), HitlResponseBodySchema);
      const context = await runtime.contextResolver.resolve(project.workspaceRoot);
      const hitlId = resolveProjectScopedHitlId(context.hitl.listPending(project.slug) as HitlRequest[], hitlIdentifier);

      if (hitlId === undefined || !context.hitl.respond(hitlId, body, project.slug)) throw hitlNotFound(hitlIdentifier);
      return c.json({ ok: true, hitlId });
    });

    app.post("/:slug/hitl/:id/cancel", async (c) => {
      const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
      const hitlIdentifier = requiredParam(c.req.param("id"), "id");
      const body = await readOptionalJsonBody(c.req.json(), HitlCancelBodySchema);
      const context = await runtime.contextResolver.resolve(project.workspaceRoot);
      const hitlId = resolveProjectScopedHitlId(context.hitl.listPending(project.slug) as HitlRequest[], hitlIdentifier);

      if (hitlId === undefined || !context.hitl.cancel(hitlId, body.reason, project.slug)) throw hitlNotFound(hitlIdentifier);
      return c.json({ ok: true, hitlId });
    });
  }

  return app;
}

async function aggregatePendingHitl(runtime: AgentRuntime): Promise<DashboardHitlRequest[]> {
  const hitl: DashboardHitlRequest[] = [];
  for (const project of await listProjects(runtime)) {
    try {
      const context = await runtime.contextResolver.resolve(project.workspaceRoot);
      hitl.push(...context.hitl.listPending(project.slug).map((request) => withProject(request as HitlRequest, project)));
    } catch {
      // Keep Dashboard HITL aggregation available when one project context is bad.
    }
  }
  return hitl;
}

function withProject(request: HitlRequest, project: ProjectInfo): DashboardHitlRequest {
  return {
    hitlId: request.hitlId,
    sessionId: request.sessionId,
    kind: request.kind,
    trigger: request.trigger,
    createdAt: request.createdAt,
    displayPayload: normalizeDisplayPayload(request.displayPayload),
    approvalKey: request.approvalKey,
    projectSlug: project.slug,
    projectName: project.name,
    status: "pending",
  };
}

function normalizeDisplayPayload(displayPayload: unknown): HitlDisplayPayload | undefined {
  if (displayPayload === undefined || displayPayload === null || typeof displayPayload !== "object") return undefined;
  const payload = displayPayload as Record<string, unknown>;
  if (typeof payload.title !== "string" || payload.redacted !== true) return undefined;

  const fields = Array.isArray(payload.fields)
    ? payload.fields.flatMap((field) => {
      if (field === null || typeof field !== "object") return [];
      const entry = field as Record<string, unknown>;
      return typeof entry.label === "string" && typeof entry.value === "string"
        ? [{ label: entry.label, value: entry.value }]
        : [];
    })
    : undefined;

  return {
    title: payload.title,
    summary: typeof payload.summary === "string" ? payload.summary : undefined,
    fields: fields === undefined || fields.length === 0 ? undefined : fields,
    redacted: true,
  };
}

function resolveProjectScopedHitlId(pendingRequests: HitlRequest[], identifier: string): string | undefined {
  const directMatch = pendingRequests.find((request) => request.hitlId === identifier || request.approvalKey === identifier);
  if (directMatch) return directMatch.hitlId;

  const approvalPointMatches = pendingRequests.filter((request) => request.trigger.approvalPoint === identifier);
  return approvalPointMatches.length === 1 ? approvalPointMatches[0]!.hitlId : undefined;
}

function parseHitlStatusFilter(status: string | undefined): "pending" {
  if (status === undefined || status === "pending") return "pending";
  throw new BadRequestError("status must be pending");
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
  if (!result.success) {
    throw new BadRequestError("Request body is invalid", z.treeifyError(result.error));
  }
  return result.data;
}

async function readOptionalJsonBody<Schema extends z.ZodType>(bodyPromise: Promise<unknown>, schema: Schema): Promise<z.infer<Schema>> {
  try {
    return await readJsonBody(bodyPromise, schema);
  } catch (error) {
    if (error instanceof BadRequestError && error.message === "Request body must be valid JSON") {
      return schema.parse({});
    }
    throw error;
  }
}

async function listProjects(runtime: AgentRuntime): Promise<ProjectInfo[]> {
  const registry = runtime.projectRegistry as AgentRuntime["projectRegistry"] & {
    listProjects?: () => Promise<ProjectInfo[]>;
  };
  return await (registry.listProjects?.() ?? registry.list());
}

function hitlNotFound(hitlId: string): ServerError {
  return new ServerError("QUESTION_NOT_FOUND", `HITL request not found: ${hitlId}`, 404);
}

function projectScopedHitlMutationRequired(hitlId: string): ServerError {
  return new ServerError(
    "PROJECT_SCOPED_HITL_REQUIRED",
    `HITL mutation requires a project-scoped route: ${hitlId}`,
    404,
  );
}
