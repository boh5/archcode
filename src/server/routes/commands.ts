import { Hono } from "hono";
import { z } from "zod";
import type { SpecraRuntime } from "../../main";
import type { ProjectInfo } from "../../projects/types";
import type { AgentRunner } from "../agent-runner";
import { BadRequestError, ProjectNotFoundError, SessionNotFoundError } from "../errors";

const CommandRequestSchema = z.object({
  name: z.string().min(1),
  args: z.string().optional(),
}).strict();

export function createCommandsRoutes(runtime: SpecraRuntime, agentRunner: AgentRunner): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const slug = requiredParam(c.req.param("slug"), "slug");
    const sessionId = requiredParam(c.req.param("sessionId"), "sessionId");
    const body = await readCommandBody(c.req.json());
    const parsed = CommandRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestError(`Invalid command request: ${parsed.error.message}`);
    }

    await resolveProject(runtime, slug);
    if (!agentRunner.isRunning(sessionId)) {
      throw new SessionNotFoundError(sessionId);
    }

    const result = await agentRunner.dispatchCommand(sessionId, parsed.data.name, parsed.data.args);
    if (!result) {
      throw new SessionNotFoundError(sessionId);
    }

    return c.json(result);
  });

  return app;
}

function requiredParam(value: string | undefined, name: string): string {
  if (!value) {
    throw new BadRequestError(`${name} is required`);
  }

  return value;
}

async function readCommandBody(bodyPromise: Promise<unknown>): Promise<unknown> {
  try {
    return await bodyPromise;
  } catch {
    throw new BadRequestError("Invalid JSON body");
  }
}

async function resolveProject(runtime: SpecraRuntime, slug: string): Promise<ProjectInfo> {
  const project = await runtime.projectRegistry.get(slug);
  if (!project) {
    throw new ProjectNotFoundError(slug);
  }

  return project;
}
