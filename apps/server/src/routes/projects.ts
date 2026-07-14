import { Hono } from "hono";
import type { AgentRuntime, ProjectControlPlaneSnapshot, ProjectInfo } from "@archcode/agent-core";
import { ProjectRegistryError, ProjectRuntimeActiveError } from "@archcode/agent-core";
import { z } from "zod/v4";
import { BadRequestError, ProjectNotFoundError, ProjectRemoveConflictHttpError } from "../errors";
import { zValidator } from "../validation";

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
const ProjectParamsSchema = z.strictObject({ slug: z.string().min(1) });

export function createProjectsRoutes(runtime: AgentRuntime, options: ProjectsRoutesOptions): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const projects = await runtime.projectRegistry.list();
    return c.json({ projects });
  });

  app.post("/", zValidator("json", CreateProjectBodySchema), async (c) => {
    const { workspaceRoot, name } = c.req.valid("json");

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

  app.delete("/:slug", zValidator("param", ProjectParamsSchema), async (c) => {
    const { slug } = c.req.valid("param");
    try {
      const removed = await runtime.removeProject(slug);
      if (removed !== undefined) await options.onProjectRemoved(removed.snapshot);
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof ProjectRuntimeActiveError) {
        throw new ProjectRemoveConflictHttpError(error.projectSlug, error.activeFamilies);
      }
      throw error;
    }
  });

  app.patch("/:slug", zValidator("param", ProjectParamsSchema), zValidator("json", UpdateProjectBodySchema), async (c) => {
    const { slug } = c.req.valid("param");
    const { name } = c.req.valid("json");

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

  app.post("/:slug/touch", zValidator("param", ProjectParamsSchema), async (c) => {
    const { slug } = c.req.valid("param");
    const project = await runtime.projectRegistry.touch(slug);
    if (!project) {
      throw new ProjectNotFoundError(slug);
    }

    return c.json(project);
  });

  return app;
}
