import { Hono } from "hono";
import type { SpecraRuntime } from "../../main";
import { ProjectRegistryError } from "../../projects/registry";
import { BadRequestError, ProjectNotFoundError } from "../errors";

interface CreateProjectBody {
  workspaceRoot?: unknown;
  name?: unknown;
}

export function createProjectsRoutes(runtime: SpecraRuntime): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const projects = await runtime.projectRegistry.list();
    return c.json({ projects });
  });

  app.post("/", async (c) => {
    const body = await readCreateProjectBody(c.req.json());
    const { workspaceRoot, name } = body;

    if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
      throw new BadRequestError("workspaceRoot is required");
    }
    if (name !== undefined && typeof name !== "string") {
      throw new BadRequestError("name must be a string");
    }

    try {
      const project = await runtime.projectRegistry.add({ workspaceRoot, name });
      return c.json(project, 201);
    } catch (error) {
      if (error instanceof ProjectRegistryError) {
        throw new BadRequestError(error.message, { workspaceRoot });
      }
      throw error;
    }
  });

  app.delete("/:slug", async (c) => {
    await runtime.projectRegistry.remove(c.req.param("slug"));
    return c.json({ ok: true });
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

async function readCreateProjectBody(bodyPromise: Promise<unknown>): Promise<CreateProjectBody> {
  try {
    const body = await bodyPromise;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new BadRequestError("Request body must be an object");
    }

    return body;
  } catch (error) {
    if (error instanceof BadRequestError) throw error;
    throw new BadRequestError("Request body must be valid JSON");
  }
}
