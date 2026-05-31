import { Hono } from "hono";
import { cors } from "hono/cors";
import type { SpecraRuntime } from "@specra/agent-core";
import { AskUserService } from "./ask-user-service";
import { errorHandler } from "./error-handler";
import { UnauthorizedError } from "./errors";
import { PermissionService } from "./permission-service";
import { requestLogger } from "./logger";
import { createCommandsRoutes } from "./routes/commands";
import { createDirectoriesRoutes } from "./routes/directories";
import { createFilesRoutes } from "./routes/files";
import { createGlobalEventsRoutes } from "./routes/global-events";
import { createMessagesRoutes } from "./routes/messages";
import { createPermissionRoutes } from "./routes/permissions";
import { createProjectsRoutes } from "./routes/projects";
import { createQuestionsRoutes } from "./routes/questions";
import { createSessionsRoutes } from "./routes/sessions";
import { createWorkflowRoutes } from "./routes/workflow";
import { createEmbeddedAssetHandler } from "./serve-web";
import { globalEventBus } from "./events/global-event-bus";

export interface CreateServerAppOptions {
  dev?: boolean;
  password?: string;
}

export function createServerApp(
  runtime: SpecraRuntime,
  options: CreateServerAppOptions = {},
): { app: Hono } {
  const app = new Hono();
  const serverRuntime = createServerEventRuntime(runtime);

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

  const projects = createProjectsRoutes(serverRuntime);
  const sessions = createSessionsRoutes(serverRuntime);
  const messages = createMessagesRoutes(serverRuntime);
  const globalEvents = createGlobalEventsRoutes(globalEventBus);
  const permissions = createPermissionRoutes(new PermissionService(serverRuntime));
  const questions = createQuestionsRoutes(new AskUserService(serverRuntime));
  const commands = createCommandsRoutes(serverRuntime);
  const agents = new Hono();
  const workflow = createWorkflowRoutes(serverRuntime);
  const files = createFilesRoutes(serverRuntime);
  const directories = createDirectoriesRoutes();

  app.route("/api/projects", projects);
  app.route("/api/projects/:slug/sessions", sessions);
  app.route("/api/projects/:slug/sessions/:sessionId", messages);
  app.route("/api/events", globalEvents);
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
    app.use("/*", createEmbeddedAssetHandler());
  }

  return { app };
}

function createServerEventRuntime(runtime: SpecraRuntime): SpecraRuntime {
  return {
    ...runtime,
    startSessionExecution(input) {
      const unsubscribe = runtime.subscribeSessionEvents({
        slug: input.slug,
        workspaceRoot: input.workspaceRoot,
        sessionId: input.sessionId,
        onEvent: (event) => globalEventBus.emit(event),
      });

      try {
        const execution = runtime.startSessionExecution(input);
        void execution.promise.finally(unsubscribe);
        return execution;
      } catch (error) {
        unsubscribe();
        throw error;
      }
    },
  };
}
