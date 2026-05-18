import { Hono } from "hono";
import { cors } from "hono/cors";
import type { SpecraRuntime } from "../main";
import { AgentRunner } from "./agent-runner";
import { errorHandler } from "./error-handler";
import { UnauthorizedError } from "./errors";
import { requestLogger } from "./logger";
import { PermissionService } from "./permission-service";
import { createEventsRoutes } from "./routes/events";
import { createMessagesRoutes } from "./routes/messages";
import { createPermissionRoutes } from "./routes/permissions";
import { createProjectsRoutes } from "./routes/projects";
import { createSessionsRoutes } from "./routes/sessions";

export interface CreateServerAppOptions {
  dev?: boolean;
  password?: string;
}

export function createServerApp(
  runtime: SpecraRuntime,
  options: CreateServerAppOptions = {},
): Hono {
  const app = new Hono();

  app.onError(errorHandler);
  app.use("*", requestLogger());
  app.use(
    "*",
    cors({
      origin: options.dev ? "*" : "",
      credentials: !options.dev,
    }),
  );

  if (options.password) {
    app.use("/api/*", async (c, next) => {
      const auth = c.req.header("Authorization");
      if (!auth) {
        throw new UnauthorizedError("Authentication required");
      }

      if (!auth.startsWith("Basic ")) {
        throw new UnauthorizedError("Invalid credentials");
      }

      let decoded: string;
      try {
        decoded = atob(auth.slice("Basic ".length));
      } catch {
        throw new UnauthorizedError("Invalid credentials");
      }

      const separatorIndex = decoded.indexOf(":");
      const password = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : "";
      if (password !== options.password) {
        throw new UnauthorizedError("Invalid credentials");
      }

      await next();
    });
  }

  app.get("/api/health", (c) => c.json({ ok: true }));

  const projects = createProjectsRoutes(runtime);
  const sessions = createSessionsRoutes(runtime);
  const permissionService = new PermissionService();
  const agentRunner = new AgentRunner(runtime, permissionService);
  const messages = createMessagesRoutes(runtime, agentRunner);
  const events = createEventsRoutes(runtime, agentRunner);
  const permissions = createPermissionRoutes(permissionService);
  const questions = new Hono();
  const commands = new Hono();
  const agents = new Hono();
  const workflow = new Hono();
  const files = new Hono();

  app.route("/api/projects", projects);
  app.route("/api/projects/:slug/sessions", sessions);
  app.route("/api/projects/:slug/sessions/:sessionId", messages);
  app.route("/api/projects/:slug/sessions/:sessionId/events", events);
  app.route("/api/sessions", new Hono());
  app.route("/api/permissions", permissions);
  app.route("/api/questions", questions);
  app.route("/api/commands", commands);
  app.route("/api/agents", agents);
  app.route("/api/workflow", workflow);
  app.route("/api/files", files);

  if (!options.dev) {
    // Static files will be mounted after the web build pipeline exists.
  }

  return app;
}
