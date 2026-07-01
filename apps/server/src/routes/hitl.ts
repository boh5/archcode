import { Hono } from "hono";
import type { AgentRuntime, ProjectInfo } from "@archcode/agent-core";
import { z } from "zod/v4";
import { BadRequestError, ServerError } from "../errors";
import { resolveProject } from "../resolve";

const HitlResponseBodySchema = z.strictObject({
  decision: z.string().trim().min(1).optional(),
  answers: z.unknown().optional(),
  verdict: z.enum(["approve", "reject", "request_changes"]).optional(),
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
  trigger: {
    projectSlug?: string;
    goalId?: string;
    loopId?: string;
    source?: string;
    timeoutMs?: number;
  };
  createdAt: number;
};

type DashboardHitlRequest = HitlRequest & {
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
      const body = await readJsonBody(c.req.json(), HitlResponseBodySchema);
      const found = await findPendingHitl(runtime, hitlId);
      if (!found) throw hitlNotFound(hitlId);

      if (!found.context.hitl.respond(hitlId, body)) throw hitlNotFound(hitlId);
      return c.json({ ok: true, hitlId });
    });

    app.post("/hitl/:id/cancel", async (c) => {
      const hitlId = requiredParam(c.req.param("id"), "id");
      const body = await readOptionalJsonBody(c.req.json(), HitlCancelBodySchema);
      const found = await findPendingHitl(runtime, hitlId);
      if (!found) throw hitlNotFound(hitlId);

      if (!found.context.hitl.cancel(hitlId, body.reason)) throw hitlNotFound(hitlId);
      return c.json({ ok: true, hitlId });
    });
  }

  if (scope === "project") {
    app.get("/:slug/hitl", async (c) => {
      const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
      const context = await runtime.contextResolver.resolve(project.workspaceRoot);
      const hitl = context.hitl.listPending(project.slug).map((request) => withProject(request as HitlRequest, project));
      return c.json({ hitl });
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

async function findPendingHitl(runtime: AgentRuntime, hitlId: string): Promise<{ context: Awaited<ReturnType<AgentRuntime["contextResolver"]["resolve"]>> } | undefined> {
  for (const project of await listProjects(runtime)) {
    try {
      const context = await runtime.contextResolver.resolve(project.workspaceRoot);
      if (context.hitl.has(hitlId)) return { context };
    } catch {
      // Corrupt projects are skipped during global HITL lookup.
    }
  }
  return undefined;
}

function withProject(request: HitlRequest, project: ProjectInfo): DashboardHitlRequest {
  return {
    ...request,
    projectSlug: project.slug,
    projectName: project.name,
    status: "pending",
  };
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
