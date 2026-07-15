import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AgentRuntime, ManagedSessionExecutionForwarder, ProjectInfo } from "@archcode/agent-core";
import { isTerminalChildSessionStatus, type GlobalSSEEvent, type GlobalSessionEventEnvelope, type ToolChildSessionLinkEvent } from "@archcode/protocol";
import { errorHandler } from "./error-handler";
import { UnauthorizedError } from "./errors";
import { requestLogger } from "./logger";
import { createCommandsRoutes } from "./routes/commands";
import { createConfigRoutes } from "./routes/config";
import { createAgentsRoutes } from "./routes/agents";
import { createCompressionRoutes } from "./routes/compression";
import { createDirectoriesRoutes } from "./routes/directories";
import { createDashboardRoutes } from "./routes/dashboard";
import { createFilesRoutes } from "./routes/files";
import { createGlobalEventsRoutes } from "./routes/global-events";
import { createGoalsRoutes } from "./routes/goals";
import { createHitlRoutes } from "./routes/hitl";
import { createAutomationsRoutes } from "./routes/automations";
import { createMessagesRoutes } from "./routes/messages";
import { createMcpRoutes } from "./routes/mcp";
import { createProjectsRoutes } from "./routes/projects";
import { createSessionsRoutes } from "./routes/sessions";
import { createTodosRoutes } from "./routes/todos";
import { createEmbeddedAssetHandler } from "./serve-web";
import { globalEventBus } from "./events/global-event-bus";

export interface CreateServerAppOptions {
  dev?: boolean;
  password?: string;
}

export function createServerApp(
  runtime: AgentRuntime,
  options: CreateServerAppOptions = {},
): { app: Hono; runtime: AgentRuntime; forwardSessionExecution: ManagedSessionExecutionForwarder } {
  const app = new Hono();
  const serverRuntime = createServerEventRuntime(runtime);
  const forwardSessionExecution = createManagedSessionExecutionForwarder(runtime);

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

  const projects = createProjectsRoutes(serverRuntime, {
    onProjectRegistered: async (project) => {
      await publishProjectControlPlaneSnapshot(serverRuntime, globalEventBus, project);
      await serverRuntime.reconcileRegisteredProject(project.workspaceRoot, project.slug);
      await serverRuntime.startAutomationScheduler(project.workspaceRoot);
    },
    onProjectRemoved: async (snapshot) => {
      globalEventBus.emit(snapshot.sessionRuntime);
      globalEventBus.emit(snapshot.hitl);
    },
  });
  const dashboard = createDashboardRoutes(serverRuntime);
  const goals = createGoalsRoutes(serverRuntime);
  const projectHitl = createHitlRoutes(serverRuntime);
  const automations = createAutomationsRoutes(serverRuntime);
  const todos = createTodosRoutes(serverRuntime);
  const sessions = createSessionsRoutes(serverRuntime);
  const messages = createMessagesRoutes(serverRuntime);
  const globalEvents = createGlobalEventsRoutes(globalEventBus, {
    initialEvents: async () => {
      const [sessionRuntimeEvents, hitlEvents] = await Promise.all([
        serverRuntime.listSessionRuntimeEvents(),
        serverRuntime.listHitlSnapshotEvents(),
      ]);
      return [...sessionRuntimeEvents, ...hitlEvents];
    },
  });
  const commands = createCommandsRoutes(serverRuntime);
  const compression = createCompressionRoutes(serverRuntime);
  const agents = createAgentsRoutes(serverRuntime);
  const files = createFilesRoutes(serverRuntime);
  const directories = createDirectoriesRoutes();
  const mcp = createMcpRoutes(serverRuntime);
  const config = createConfigRoutes(serverRuntime.configService);

  app.route("/api", dashboard);
  app.route("/api/projects", projects);
  app.route("/api/projects", goals);
  app.route("/api/projects", automations);
  app.route("/api/projects", todos);
  app.route("/api/projects", projectHitl);
  app.route("/api/projects/:slug/sessions", sessions);
  app.route("/api/projects/:slug/sessions/:sessionId", messages);
  app.route("/api/projects/:slug/sessions/:sessionId/compression", compression);
  app.route("/api/events", globalEvents);
  app.route("/api/projects/:slug/sessions/:sessionId/commands", commands);
  app.route("/api/projects", files);
  app.route("/api/mcp", mcp);
  app.route("/api/config", config);
  app.route("/api/sessions", new Hono());
  app.route("/api/commands", new Hono());
  app.route("/api/agents", agents);
  app.route("/api/files", new Hono());
  app.route("/api/directories", directories);

  if (!options.dev) {
    app.use("/*", createEmbeddedAssetHandler());
  }

  wireHitlRealtimeBridge(serverRuntime, globalEventBus);
  wireSessionRuntimeBridge(serverRuntime, globalEventBus);
  wireMcpStatusBridge(serverRuntime, globalEventBus);
  wireResourceChangeBridge(serverRuntime, globalEventBus);

  return { app, runtime: serverRuntime, forwardSessionExecution };
}

export function createServerEventRuntime(runtime: AgentRuntime): AgentRuntime {
  return {
    ...runtime,
    startSessionExecution(input) {
      const forwarding = prepareSessionForwarding(runtime, input);
      try {
        return forwarding.attach(runtime.startSessionExecution(input));
      } catch (error) {
        forwarding.dispose();
        throw error;
      }
    },
    async startSessionMessageExecution(input) {
      const forwarding = prepareSessionForwarding(runtime, input);
      try {
        return forwarding.attach(await runtime.startSessionMessageExecution(input));
      } catch (error) {
        forwarding.dispose();
        throw error;
      }
    },
  };
}

function createManagedSessionExecutionForwarder(runtime: AgentRuntime): ManagedSessionExecutionForwarder {
  return async (input, start) => {
    const forwarding = prepareSessionForwarding(runtime, input);
    try {
      return forwarding.attach(await start());
    } catch (error) {
      forwarding.dispose();
      throw error;
    }
  };
}

function prepareSessionForwarding(
  runtime: AgentRuntime,
  input: Parameters<AgentRuntime["startSessionExecution"]>[0],
) {
  const subscriptions = new Map<string, () => void>();
  const terminalChildren = new Set<string>();
  const rootKey = scopedSessionSubscriptionKey(input.slug, input.sessionId);
  let rootCompleted = false;
  let releaseCheck = Promise.resolve();

  const unsubscribeSession = (slug: string, sessionId: string) => {
    const key = scopedSessionSubscriptionKey(slug, sessionId);
    if (key === rootKey) return;
    subscriptions.get(key)?.();
    subscriptions.delete(key);
  };

  const maybeReleaseRoot = () => {
    if (!rootCompleted) return;
    releaseCheck = releaseCheck.then(async () => {
      const activeChildren = [...subscriptions.keys()].filter((key) => key !== rootKey && !terminalChildren.has(key));
      if (activeChildren.length > 0) return;
      try {
        const session = await runtime.getSessionFile(input.workspaceRoot, input.sessionId);
        if (session.executions.at(-1)?.status === "running") return;
        if (session.toolBatches.some((batch) => batch.archivedAt === undefined)) return;
      } catch {
        // A deleted Session has no later events to forward.
      }
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
    });
  };

  const subscribe = (sessionId: string) => {
    const key = scopedSessionSubscriptionKey(input.slug, sessionId);
    if (subscriptions.has(key)) return;
    const unsubscribe = runtime.subscribeSessionEvents({
      slug: input.slug,
      workspaceRoot: input.workspaceRoot,
      sessionId,
      onEvent: (event) => {
        globalEventBus.emit(event);
        if (!isChildSessionLinkEvent(event)) {
          maybeReleaseRoot();
          return;
        }

        const childSessionId = event.payload.link.childSessionId;
        const childKey = scopedSessionSubscriptionKey(input.slug, childSessionId);
        if (isTerminalChildSessionStatus(event.payload.link.status)) {
          terminalChildren.add(childKey);
          unsubscribeSession(input.slug, childSessionId);
          maybeReleaseRoot();
          return;
        }
        subscribe(childSessionId);
        maybeReleaseRoot();
      },
    });
    subscriptions.set(key, unsubscribe);
  };

  subscribe(input.sessionId);
  return {
    attach(execution: ReturnType<AgentRuntime["startSessionExecution"]>) {
      void execution.promise.finally(() => {
        rootCompleted = true;
        maybeReleaseRoot();
      });
      return execution;
    },
    dispose() {
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
    },
  };
}

function scopedSessionSubscriptionKey(slug: string, sessionId: string): string {
  return `${slug}\0${sessionId}`;
}

function isChildSessionLinkEvent(event: GlobalSSEEvent): event is GlobalSessionEventEnvelope<ToolChildSessionLinkEvent> {
  return event.type === "event" && event.payload.type === "tool-child-session-link";
}

function wireHitlRealtimeBridge(runtime: AgentRuntime, bus: typeof globalEventBus): void {
  if (typeof runtime.subscribeHitlEvents !== "function") return;
  runtime.subscribeHitlEvents((event) => bus.emit(event));
}

function wireSessionRuntimeBridge(
  runtime: AgentRuntime,
  bus: { emit(event: GlobalSSEEvent): void },
): void {
  runtime.subscribeSessionRuntimeChanges((event) => bus.emit(event));
}

/**
 * Bridges runtime MCP status changes to the global SSE event bus.
 *
 * Wired once at server creation. Runtime always provides
 * `subscribeMcpStatusChanges` in production; the guard keeps partial test
 * doubles (which omit MCP methods) from crashing during route-level tests.
 */
function wireMcpStatusBridge(
  runtime: AgentRuntime,
  bus: { emit(event: GlobalSSEEvent): void },
): void {
  if (typeof runtime.subscribeMcpStatusChanges !== "function") return;
  runtime.subscribeMcpStatusChanges((serverName, status) => {
    bus.emit({
      type: "mcp_status",
      serverName,
      status,
      createdAt: Date.now(),
    });
  });
}

function wireResourceChangeBridge(
  runtime: AgentRuntime,
  bus: { emit(event: GlobalSSEEvent): void },
): void {
  runtime.subscribeResourceChanges?.((event) => bus.emit(event));
}

async function publishProjectControlPlaneSnapshot(
  runtime: AgentRuntime,
  bus: typeof globalEventBus,
  project: Pick<ProjectInfo, "slug" | "workspaceRoot">,
): Promise<void> {
  let liveRevision = 0;
  const unsubscribe = bus.subscribe((event) => {
    if (isProjectControlPlaneLiveEvent(event, project.slug)) liveRevision += 1;
  });

  try {
    while (true) {
      const revisionBeforeRead = liveRevision;
      const snapshot = await runtime.getProjectControlPlaneSnapshot(project.workspaceRoot, project.slug);

      if (liveRevision !== revisionBeforeRead) continue;

      // There is deliberately no await between the stability check and these
      // synchronous emits: live deltas cannot overtake the authoritative pair.
      bus.emit(snapshot.sessionRuntime);
      bus.emit(snapshot.hitl);
      return;
    }
  } finally {
    unsubscribe();
  }
}

function isProjectControlPlaneLiveEvent(event: GlobalSSEEvent, projectSlug: string): boolean {
  return (event.type === "session.runtime_changed" || event.type === "hitl.event")
    && event.projectSlug === projectSlug;
}
