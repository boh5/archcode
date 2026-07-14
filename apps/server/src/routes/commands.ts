import { Hono } from "hono";
import { z } from "zod";
import type { AgentRuntime } from "@archcode/agent-core";
import { SessionNotFoundError } from "../errors";
import { resolveProject } from "../resolve";
import { zValidator } from "../validation";

const CommandRequestSchema = z.object({
  name: z.string().min(1),
  args: z.string().optional(),
}).strict();
const CommandParamsSchema = z.strictObject({
  slug: z.string().min(1),
  sessionId: z.string().min(1),
});

export function createCommandsRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();

  app.post("/", zValidator("param", CommandParamsSchema), zValidator("json", CommandRequestSchema), async (c) => {
    const { slug, sessionId } = c.req.valid("param");
    const { name, args } = c.req.valid("json");

    const project = await resolveProject(runtime, slug);
    const result = await runtime.dispatchCommand(project.workspaceRoot, sessionId, name, args);
    if (!result) {
      throw new SessionNotFoundError(sessionId);
    }

    return c.json(result);
  });

  return app;
}
