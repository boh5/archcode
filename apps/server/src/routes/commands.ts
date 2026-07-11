import { Hono } from "hono";
import { z } from "zod";
import type { AgentRuntime } from "@archcode/agent-core";
import { BadRequestError, SessionNotFoundError } from "../errors";
import { resolveProject } from "../resolve";

const CommandRequestSchema = z.object({
  name: z.string().min(1),
  args: z.string().optional(),
}).strict();

export function createCommandsRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const slug = requiredParam(c.req.param("slug"), "slug");
    const sessionId = requiredParam(c.req.param("sessionId"), "sessionId");
    const body = await readCommandBody(c.req.json());
    const parsed = CommandRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestError(`Invalid command request: ${parsed.error.message}`);
    }

    const project = await resolveProject(runtime, slug);
    const result = await runtime.dispatchCommand(project.workspaceRoot, sessionId, parsed.data.name, parsed.data.args);
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
