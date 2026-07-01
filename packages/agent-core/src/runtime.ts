import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { defaultAgentDefinitions } from "./agents";
import { SessionAgentManager } from "./agents/session-agent-manager";
import type { CommandResult } from "./commands/types";
import { loadConfig } from "./config/load";
import { configureDefaultLspClientPoolLogger } from "./lsp/client-pool";
import { configureDefaultBinaryManagerLogger } from "./binary/manager";
import { configureDefaultProcessRunnerLogger } from "./process/runner";
import { configureDefaultLspToolLogger } from "./tools/builtins/lsp/tool-logger";
import { configureDefaultWebFetchLogger } from "./tools/builtins/web-fetch";
import {
  resolveMcpConfig,
  type ResolvedMcpConfig,
  type ResolvedMcpServerConfig,
} from "./config/mcp";
import { registerBuiltinTools } from "./core/index";
import {
  BUILTIN_MCP_SERVERS,
  McpManager,
  type McpWarning,
} from "./mcp/index";
import { createRegistry as createProviderRegistry, type Registry as ProviderRegistry } from "./provider/index";
import { ProjectContextResolver } from "./projects/context-resolver";
import { ProjectRegistry } from "./projects/registry";
import { SkillService } from "./skills";
import type { SessionFile, SessionSummary } from "./store/helpers";
import type { McpServerStatus, SessionTreeResponse } from "@archcode/protocol";
import { createRegistry as createToolRegistry, DuplicateToolError, type ToolRegistry } from "./tools/index";
import { DeferredPermissionService, DeferredQuestionService } from "./deferred";
import type { AskUserResponse, DeferredSessionEvent } from "./deferred";
import type { AskUserRequest, ToolConfirmationRequest, ToolConfirmationResult } from "./tools/types";
import { SessionExecutionManager } from "./execution";
import type { ActiveSessionExecution, SubscribeSessionEventsInput } from "./execution";
import { GoalRunner } from "./goals/runner";
import { HitlService } from "./hitl/service";
import { scopedKey } from "./store/key";
import { Logger, createConsoleLogger } from "./logger";
import { SessionStoreManager } from "./store/session-store-manager";

const DEFAULT_CONFIG_PATH = ".archcode.json";

export interface AgentRuntimeOptions {
  configPath?: string;
  workspaceRoot?: string;
  mcpManagerFactory?: (config: ResolvedMcpConfig) => McpManager;
  projectRegistryHomeDir?: string;
  logger?: Logger;
}

export interface AgentRuntime {
  readonly mcpManager: McpManager;
  readonly toolRegistry: ToolRegistry;
  readonly providerRegistry: ProviderRegistry;
  readonly skillService: SkillService;
  readonly warnings: McpWarning[];
  readonly projectRegistry: ProjectRegistry;
  readonly contextResolver: ProjectContextResolver;
  readonly hitl: HitlService;
  subscribeMcpStatusChanges(listener: (serverName: string, status: McpServerStatus) => void): () => void;
  getMcpServerStatuses(): Map<string, McpServerStatus>;
  createSession(workspaceRoot: string): Promise<SessionFile>;
  getSessionFile(workspaceRoot: string, sessionId: string): Promise<SessionFile>;
  listSessions(workspaceRoot: string): Promise<SessionSummary[]>;
  startSessionExecution(input: { slug: string; workspaceRoot: string; sessionId: string; userMessage: string }): ActiveSessionExecution;
  abortSessionExecution(workspaceRoot: string, sessionId: string): boolean;
  abortSessionExecutionAndWait(workspaceRoot: string, sessionId: string): Promise<void>;
  abortAllSessionExecutions(): Promise<void>;
  isSessionExecutionRunning(workspaceRoot: string, sessionId: string): boolean;
  getSessionExecution(workspaceRoot: string, sessionId: string): ActiveSessionExecution | undefined;
  subscribeSessionEvents(input: SubscribeSessionEventsInput): () => void;
  deleteSession(workspaceRoot: string, sessionId: string): Promise<void>;
  listSessionTree(workspaceRoot: string, rootSessionId: string): Promise<SessionTreeResponse>;
  disposeSessionAgent(workspaceRoot: string, sessionId: string): void;
  disposeAllSessionAgents(): void;
  isSessionTombstoned(workspaceRoot: string, sessionId: string): boolean;
  dispatchCommand(workspaceRoot: string, sessionId: string, name: string, args?: string): Promise<CommandResult | null>;
  requestPermission(
    workspaceRoot: string,
    sessionId: string,
    request: ToolConfirmationRequest,
    abortSignal?: AbortSignal,
  ): Promise<ToolConfirmationResult>;
  respondPermission(permissionId: string, response: ToolConfirmationResult): boolean;
  requestQuestion(workspaceRoot: string, sessionId: string, request: AskUserRequest): Promise<AskUserResponse>;
  respondQuestion(questionId: string, response: AskUserResponse): boolean;
  cleanupDeferredSession(workspaceRoot: string, sessionId: string): void;
  notifyRuntimeShutdown(reason: string): void;
}

export async function createRuntime(
  options: AgentRuntimeOptions = {},
): Promise<AgentRuntime> {
  const logger = options.logger ?? createConsoleLogger({ level: "info" });
  const runtimeLogger = logger.child({ module: "runtime" });
  const warnings: McpWarning[] = [];
  const config = await loadConfig(options.configPath ?? DEFAULT_CONFIG_PATH, { logger: runtimeLogger });
  const providerRegistry = createProviderRegistry(config.provider);
  const toolRegistry = createToolRegistry();
  registerBuiltinTools(toolRegistry, logger.child({ module: "tools" }));
  const skillService = new SkillService();

  const resolvedMcpConfig = resolveMcpConfig(config.mcp);
  const mcpManager = options.mcpManagerFactory
    ? options.mcpManagerFactory(resolvedMcpConfig)
    : new McpManager(BUILTIN_MCP_SERVERS, resolvedMcpConfig.servers, undefined, runtimeLogger.child({ module: "mcp" }));

  configureDefaultLspClientPoolLogger(runtimeLogger.child({ module: "lsp" }));
  configureDefaultBinaryManagerLogger(runtimeLogger.child({ module: "binary" }));
  configureDefaultProcessRunnerLogger(runtimeLogger.child({ module: "process" }));
  configureDefaultLspToolLogger(runtimeLogger.child({ module: "lsp.tools" }));
  configureDefaultWebFetchLogger(runtimeLogger.child({ module: "webfetch" }));

  const recordWarning = (warning: McpWarning): void => {
    warnings.push(warning);
    runtimeLogger.warn("mcp.discovery.warning", {
      message: warning.message,
      context: warning.toolName ? { toolName: warning.toolName } : undefined,
      meta: { warning },
    });
  };

  try {
    mcpManager.startBackgroundDiscovery(
      (descriptors) => {
        for (const descriptor of descriptors) {
          if (toolRegistry.get(descriptor.name)) {
            recordWarning({
              toolName: descriptor.name,
              message: `Duplicate MCP tool descriptor "${descriptor.name}" skipped during startup`,
            });
            continue;
          }

          try {
            toolRegistry.register(descriptor);
          } catch (err) {
            if (err instanceof DuplicateToolError) {
              recordWarning({
                toolName: descriptor.name,
                message: `Duplicate MCP tool descriptor "${descriptor.name}" skipped during startup`,
              });
              continue;
            }
            throw err;
          }
        }
      },
      (warning) => recordWarning(warning),
    );

    await resolveWorkspaceRoot(options);
    const projectRegistry = new ProjectRegistry({ homeDir: options.projectRegistryHomeDir, logger: logger.child({ module: "projects.registry" }) });
    const hitl = new HitlService();
    const contextResolver = new ProjectContextResolver({
      hitlFactory: () => hitl,
      logger: runtimeLogger.child({ module: "projects" }),
    });
    const sessionStoreManager = new SessionStoreManager({ logger });
    const sessionAgentManager = new SessionAgentManager({
      definitions: defaultAgentDefinitions,
      providerRegistry,
      toolRegistry,
      skillService,
      config,
      projectContextResolver: contextResolver,
      storeManager: sessionStoreManager,
      logger,
    });
    const activeSessionKeys = new Map<string, { workspaceRoot: string; sessionId: string }>();
    const submitDeferredEvent = (
      workspaceRoot: string,
      sessionId: string,
      event: DeferredSessionEvent,
    ): void => {
      const store = sessionStoreManager.get(sessionId, workspaceRoot);
      store?.getState().append(event);
    };
    const deferredEvents = { submitDeferredEvent };
    const permissionService = new DeferredPermissionService(deferredEvents);
    const questionService = new DeferredQuestionService(deferredEvents);

    async function dispatchCommand(
      workspaceRoot: string,
      sessionId: string,
      name: string,
      args?: string,
    ): Promise<CommandResult | null> {
      return await executionManager.dispatchCommand(workspaceRoot, sessionId, name, args);
    }

    function requestPermission(
      workspaceRoot: string,
      sessionId: string,
      request: ToolConfirmationRequest,
      abortSignal?: AbortSignal,
    ): Promise<ToolConfirmationResult> {
      activeSessionKeys.set(scopedKey(workspaceRoot, sessionId), { workspaceRoot, sessionId });
      return permissionService.request(sessionId, workspaceRoot, request, abortSignal);
    }

    function requestQuestion(
      workspaceRoot: string,
      sessionId: string,
      request: AskUserRequest,
    ): Promise<AskUserResponse> {
      activeSessionKeys.set(scopedKey(workspaceRoot, sessionId), { workspaceRoot, sessionId });
      return questionService.request(sessionId, workspaceRoot, request);
    }

    function cleanupDeferredSession(workspaceRoot: string, sessionId: string): void {
      permissionService.cleanup(sessionId, workspaceRoot);
      questionService.cleanup(sessionId, workspaceRoot);
      activeSessionKeys.delete(scopedKey(workspaceRoot, sessionId));
    }

    function notifyRuntimeShutdown(reason: string): void {
      for (const { workspaceRoot, sessionId } of activeSessionKeys.values()) {
        submitDeferredEvent(workspaceRoot, sessionId, { type: "shutdown", reason });
      }
    }

    const trackSession = (workspaceRoot: string, sessionId: string): void => {
      activeSessionKeys.set(scopedKey(workspaceRoot, sessionId), { workspaceRoot, sessionId });
    };

    const untrackSession = (workspaceRoot: string, sessionId: string): void => {
      activeSessionKeys.delete(scopedKey(workspaceRoot, sessionId));
    };

    const executionManager = new SessionExecutionManager({
      sessionAgentManager,
      createSessionStore: (sessionId, workspaceRoot, createOptions) => sessionStoreManager.create(sessionId, workspaceRoot, createOptions),
      getSessionStore: (sessionId, workspaceRoot) => sessionStoreManager.get(sessionId, workspaceRoot),
      deleteSessionStore: (sessionId, workspaceRoot, deleteOptions) => sessionStoreManager.delete(sessionId, workspaceRoot, deleteOptions),
      resolveRootSessionId: (sessionId, workspaceRoot) => sessionStoreManager.resolveRootSessionId(sessionId, workspaceRoot),
      buildSessionTree: (workspaceRoot, rootSessionId) => sessionStoreManager.buildSessionTree(workspaceRoot, rootSessionId),
      requestPermission,
      requestQuestion,
      cleanupDeferredSession,
      trackSession,
      untrackSession,
      logger,
    });
    await recoverRegisteredProjectGoals({
      projectRegistry,
      contextResolver,
      hitl,
      isSessionActive: (workspaceRoot, sessionId) => executionManager.isRunning(workspaceRoot, sessionId),
      createSession: async (workspaceRoot) => (await sessionStoreManager.createSessionFile(workspaceRoot)).sessionId,
      logger: runtimeLogger,
    });
    sessionAgentManager.setStartChildExecution((workspaceRoot, request) => executionManager.startChildExecution(workspaceRoot, request));
    sessionAgentManager.setCancelChildSession((workspaceRoot, parentSessionId, childSessionId) => executionManager.cancelChildSession(workspaceRoot, parentSessionId, childSessionId));
    sessionAgentManager.setResumeChildSession((workspaceRoot, request) => executionManager.resumeChildExecution(workspaceRoot, request));

    return {
      mcpManager,
      toolRegistry,
      providerRegistry,
      skillService,
      warnings,
      projectRegistry,
      contextResolver,
      hitl,
      subscribeMcpStatusChanges: (listener) => mcpManager.onStatusChange(listener),
      getMcpServerStatuses: () => mcpManager.getStatus(),
      createSession: (workspaceRoot) => sessionStoreManager.createSessionFile(workspaceRoot),
      getSessionFile: (workspaceRoot, sessionId) => sessionStoreManager.getSessionFile(workspaceRoot, sessionId),
      listSessions: (workspaceRoot) => sessionStoreManager.listSessionSummaries(workspaceRoot),
      startSessionExecution: (input) => executionManager.startExecution(input),
      abortSessionExecution: (workspaceRoot, sessionId) => executionManager.abort(workspaceRoot, sessionId),
      abortSessionExecutionAndWait: (workspaceRoot, sessionId) => executionManager.abortAndWait(workspaceRoot, sessionId),
      abortAllSessionExecutions: () => executionManager.abortAll(),
      isSessionExecutionRunning: (workspaceRoot, sessionId) => executionManager.isRunning(workspaceRoot, sessionId),
      getSessionExecution: (workspaceRoot, sessionId) => executionManager.getExecution(workspaceRoot, sessionId),
      subscribeSessionEvents: (input) => executionManager.subscribe(input),
      deleteSession: (workspaceRoot, sessionId) => executionManager.deleteSession(workspaceRoot, sessionId),
      listSessionTree: (workspaceRoot, rootSessionId) => sessionStoreManager.buildSessionTree(workspaceRoot, rootSessionId),
      disposeSessionAgent: (workspaceRoot, sessionId) => sessionAgentManager.dispose(workspaceRoot, sessionId),
      disposeAllSessionAgents: () => sessionAgentManager.disposeAll(),
      isSessionTombstoned: (workspaceRoot, sessionId) => sessionAgentManager.isTombstoned(workspaceRoot, sessionId),
      dispatchCommand,
      requestPermission,
      respondPermission: (permissionId, response) => permissionService.respond(permissionId, response),
      requestQuestion,
      respondQuestion: (questionId, response) => questionService.respond(questionId, response),
      cleanupDeferredSession,
      notifyRuntimeShutdown,
    };
  } catch (err) {
    runtimeLogger.error("runtime.init.failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    await closeMcpManagerBestEffort(mcpManager, recordWarning);
    throw err;
  }
}

async function recoverRegisteredProjectGoals(input: {
  projectRegistry: ProjectRegistry;
  contextResolver: ProjectContextResolver;
  hitl: HitlService;
  createSession: (workspaceRoot: string) => Promise<string>;
  isSessionActive: (workspaceRoot: string, sessionId: string) => boolean;
  logger: Logger;
}): Promise<void> {
  const projects = await input.projectRegistry.list();
  for (const project of projects) {
    try {
      const projectContext = await input.contextResolver.resolve(project.workspaceRoot);
      const runner = new GoalRunner({
        goalStateManager: projectContext.goalState,
        hitlService: projectContext.hitl,
        workspaceRoot: project.workspaceRoot,
        createSession: () => input.createSession(project.workspaceRoot),
        isSessionActive: async (sessionId) => input.isSessionActive(project.workspaceRoot, sessionId),
      });
      const recovered = await runner.recoverInterruptedGoals(project.workspaceRoot);
      if (recovered.length > 0) {
        input.logger.info("goals.recovery.completed", {
          context: { workspaceRoot: project.workspaceRoot },
          meta: { recovered: recovered.map((goal) => ({ id: goal.id, status: goal.status })) },
        });
      }
    } catch (error) {
      input.logger.warn("goals.recovery.failed", {
        error,
        context: { workspaceRoot: project.workspaceRoot },
      });
    }
  }
}

async function resolveWorkspaceRoot(options: AgentRuntimeOptions): Promise<string> {
  if (options.workspaceRoot) return options.workspaceRoot;
  if (Bun.env.ARCHCODE_WORKSPACE_ROOT) return Bun.env.ARCHCODE_WORKSPACE_ROOT;

  return realpath(dirname(options.configPath ?? DEFAULT_CONFIG_PATH));
}

function collectMcpSecrets(
  ...serverGroups: Array<Record<string, ResolvedMcpServerConfig>>
): string[] {
  const secrets: string[] = [];
  for (const servers of serverGroups) {
    for (const server of Object.values(servers)) {
      if (server.headers) {
        secrets.push(...Object.values(server.headers));
        // Only redact URL when server has auth headers — URL may contain
        // embedded credentials (e.g. tokens in query params) that should not
        // leak into error messages alongside the auth headers.
        secrets.push(server.url);
      }
      // Public servers without auth headers have no secrets to redact;
      // their URLs are safe to show in error messages.
    }
  }
  return secrets;
}

export async function closeMcpManagerBestEffort(
  mcpManager: McpManager,
  warn?: (warning: McpWarning) => void,
): Promise<void> {
  try {
    const closeWarnings = await mcpManager.closeAll();
    for (const warning of closeWarnings) {
      warn?.(warning);
    }
  } catch (err) {
    warn?.({
      message: `Failed to close MCP manager during shutdown: ${errorMessage(err)}`,
    });
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}
