import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import type { SpecraRuntime } from "../runtime";
import { AgentRunner } from "./agent-runner";
import { AskUserService } from "./ask-user-service";
import { errorHandler } from "./error-handler";
import { UnauthorizedError } from "./errors";
import { requestLogger } from "./logger";
import { PermissionService } from "./permission-service";
import { createCommandsRoutes } from "./routes/commands";
import { createDirectoriesRoutes } from "./routes/directories";
import { createEventsRoutes } from "./routes/events";
import { createFilesRoutes } from "./routes/files";
import { createMessagesRoutes } from "./routes/messages";
import { createPermissionRoutes } from "./routes/permissions";
import { createProjectsRoutes } from "./routes/projects";
import { createQuestionsRoutes } from "./routes/questions";
import { createSessionsRoutes } from "./routes/sessions";
import { createWorkflowRoutes } from "./routes/workflow";

export interface CreateServerAppOptions {
  dev?: boolean;
  password?: string;
}

export function createServerApp(
  runtime: SpecraRuntime,
  options: CreateServerAppOptions = {},
): { app: Hono; agentRunner: AgentRunner } {
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
  const permissionService = new PermissionService();
  const askUserService = new AskUserService();
  const agentRunner = new AgentRunner(runtime, permissionService, askUserService);
  const sessions = createSessionsRoutes(runtime, agentRunner);
  const messages = createMessagesRoutes(runtime, agentRunner);
  const events = createEventsRoutes(runtime, agentRunner);
  const permissions = createPermissionRoutes(permissionService);
  const questions = createQuestionsRoutes(askUserService);
  const commands = createCommandsRoutes(runtime, agentRunner);
  const agents = new Hono();
  const workflow = createWorkflowRoutes(runtime);
  const files = createFilesRoutes(runtime);
  const directories = createDirectoriesRoutes();

  app.route("/api/projects", projects);
  app.route("/api/projects/:slug/sessions", sessions);
  app.route("/api/projects/:slug/sessions/:sessionId", messages);
  app.route("/api/projects/:slug/sessions/:sessionId/events", events);
  app.route("/api/projects/:slug/sessions/:sessionId/commands", commands);
  app.route("/api/projects", workflow);
  app.route("/api/projects", files);
  app.route("/api/sessions", new Hono());
  app.route("/api/permissions", permissions);
  app.route("/api/questions", questions);
  app.route("/api/commands", new Hono());
  app.route("/api/agents", agents);
  app.route("/api/workflow", new Hono());
  app.route("/api/files", new Hono());
  app.route("/api/directories", directories);

  if (!options.dev) {
    app.use("/*", serveStatic({ root: "./src/web/dist" }));

    app.get("/*", async (c) => {
      const path = new URL(c.req.url).pathname;
      if (path.startsWith("/api") || path.startsWith("/assets/")) {
        return c.notFound();
      }

      const index = Bun.file("./src/web/dist/index.html");
      return new Response(index, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    });
  }

  return { app, agentRunner };
}
