import type { AgentRuntime } from "@archcode/agent-core";
import { Hono } from "hono";
import { z } from "zod/v4";

import { GlobalWorkReadService } from "../global-work-read-service";
import { zValidator } from "../validation";

const GlobalSearchQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(200),
});

export function createGlobalWorkRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();
  const reads = new GlobalWorkReadService(runtime);

  app.get("/home", async (c) => c.json(await reads.readHome()));
  app.get("/search", zValidator("query", GlobalSearchQuerySchema), async (c) => (
    c.json(await reads.search(c.req.valid("query").q))
  ));

  return app;
}
