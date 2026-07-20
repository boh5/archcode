import { Hono } from "hono";
import type { AgentRuntime } from "@archcode/agent-core";
import { z } from "zod/v4";
import { DashboardProjectionService } from "../dashboard-projection-service";
import { ProjectNotFoundError } from "../errors";
import { zValidator } from "../validation";

const ProjectDashboardParamsSchema = z.strictObject({ slug: z.string().min(1) });

/**
 * The Dashboard has one read-model contract. Scope is selected by endpoint,
 * never by a client-supplied switch that could accidentally broaden access.
 */
export function createDashboardRoutes(runtime: AgentRuntime): Hono {
  const app = new Hono();
  const projection = new DashboardProjectionService(runtime);

  app.get("/dashboard", async (c) => c.json(await projection.read({ kind: "global" })));
  app.get(
    "/projects/:slug/dashboard",
    zValidator("param", ProjectDashboardParamsSchema),
    async (c) => {
      const { slug } = c.req.valid("param");
      if (await runtime.projectRegistry.get(slug) === undefined) throw new ProjectNotFoundError(slug);
      return c.json(await projection.read({ kind: "project", projectSlug: slug }));
    },
  );

  return app;
}
