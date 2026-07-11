import { Hono } from "hono";
import type { AgentRuntime } from "@archcode/agent-core";
import { ProjectRegistryError } from "@archcode/agent-core";
import { z } from "zod/v4";
import { BadRequestError, ProjectNotFoundError } from "../errors";

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

export function createProjectsRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const projects = await runtime.projectRegistry.list();
    return c.json({ projects });
  });

  app.post("/", async (c) => {
    const body = await readJsonBody(c.req.json(), CreateProjectBodySchema);
    const { workspaceRoot, name } = body;

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
