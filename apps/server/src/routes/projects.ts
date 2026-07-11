import { Hono } from "hono";
import type { AgentRuntime, ProjectControlPlaneSnapshot, ProjectInfo } from "@archcode/agent-core";
import { ProjectRegistryError, ProjectRuntimeActiveError } from "@archcode/agent-core";
import { z } from "zod/v4";
import { BadRequestError, ProjectNotFoundError, ProjectRemoveConflictHttpError } from "../errors";

export interface ProjectsRoutesOptions {
  readonly onProjectRegistered: (project: ProjectInfo) => Promise<void>;
  readonly onProjectRemoved: (snapshot: ProjectControlPlaneSnapshot) => Promise<void>;
}

const CreateProjectBodySchema = z.strictObject({
  workspaceRoot: z.string({ error: "workspaceRoot is required" }).min(1, "workspaceRoot is required"),
  name: z.string({ error: "name must be a string" }).optional(),
});

const UpdateProjectBodySchema = z.strictObject({
  name: z.string({ error: "name is required" })
    .trim()
    .min(1, "name must not be empty")
    .max(80, "name must be 80 characters or fewer"),
});

export function createProjectsRoutes(runtime: AgentRuntime, options: ProjectsRoutesOptions): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const projects = await runtime.projectRegistry.list();
    return c.json({ projects });
  });

  app.post("/", async (c) => {
    const body = await readJsonBody(c.req.json(), CreateProjectBodySchema);
    const { workspaceRoot, name } = body;

    try {
      const registration = await runtime.projectRegistry.addWithResult({ workspaceRoot, name });
      try {
        await options.onProjectRegistered(registration.project);
      } catch (error) {
        if (registration.created) await runtime.projectRegistry.remove(registration.project.slug);
        throw error;
      }
      return c.json(registration.project, 201);
    } catch (error) {
      if (error instanceof ProjectRegistryError) {
        throw new BadRequestError(error.message, { workspaceRoot });
      }
      throw error;
    }
  });

  app.delete("/:slug", async (c) => {
    try {
      const removed = await runtime.removeProject(c.req.param("slug"));
      if (removed !== undefined) await options.onProjectRemoved(removed.snapshot);
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof ProjectRuntimeActiveError) {
        throw new ProjectRemoveConflictHttpError(error.projectSlug, error.activeFamilies);
      }
      throw error;
    }
  });

  app.patch("/:slug", async (c) => {
    const slug = c.req.param("slug");
    const { name } = await readJsonBody(c.req.json(), UpdateProjectBodySchema);

    try {
      const project = await runtime.projectRegistry.updateName(slug, name);
      return c.json(project);
    } catch (error) {
      if (error instanceof ProjectRegistryError && error.message === `Project not found: ${slug}`) {
        throw new ProjectNotFoundError(slug);
      }
      if (error instanceof ProjectRegistryError) {
        throw new BadRequestError(error.message);
      }
      throw error;
    }
  });

  app.post("/:slug/touch", async (c) => {
    const slug = c.req.param("slug");
    const project = await runtime.projectRegistry.touch(slug);
    if (!project) {
      throw new ProjectNotFoundError(slug);
    }

    return c.json(project);
  });

  return app;
}

async function readJsonBody<Schema extends z.ZodType>(
  bodyPromise: Promise<unknown>,
  schema: Schema,
): Promise<z.infer<Schema>> {
  let body: unknown;
  try {
    body = await bodyPromise;
  } catch {
    throw new BadRequestError("Request body must be valid JSON");
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestError(result.error.issues[0]?.message ?? "Request body is invalid");
  }
  return result.data;
}
