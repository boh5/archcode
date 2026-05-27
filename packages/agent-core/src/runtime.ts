import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { defaultAgentDefinitions } from "./agents";
import { SessionAgentManager } from "./agents/session-agent-manager";
import type { CommandResult } from "./commands/types";
import { loadConfig } from "./config/load";
import {
  resolveMcpConfig,
  type ResolvedMcpConfig,
  type ResolvedMcpServerConfig,
} from "./config/mcp";
import { registerBuiltinTools } from "./core/index";
import {
  BUILTIN_MCP_SERVERS,
  McpManager,
  redactMcpMessage,
  type McpDiscoveryResult,
  type McpWarning,
} from "./mcp/index";
import { createRegistry as createProviderRegistry, type Registry as ProviderRegistry } from "./provider/index";
import { ProjectContextResolver } from "./projects/context-resolver";
import { ProjectRegistry } from "./projects/registry";
import { SkillService } from "./skills";
import type { SessionFile, SessionSummary } from "./store/helpers";
import { createRegistry as createToolRegistry, DuplicateToolError, type ToolRegistry } from "./tools/index";
import { DeferredPermissionService, DeferredQuestionService } from "./deferred";
import type { AskUserResponse, DeferredSessionEvent } from "./deferred";
import type { AskUserRequest, ToolConfirmationRequest, ToolConfirmationResult } from "./tools/types";
import { AgentJobRunner } from "./runner";
import type { RunningJob, SubscribeSessionEventsInput } from "./runner";
import { scopedKey } from "./store/key";
import { Logger, createConsoleLogger } from "./logger";
import { SessionStoreManager } from "./store/session-store-manager";

const DEFAULT_CONFIG_PATH = ".specra.json";

export interface SpecraRuntimeOptions {
  configPath?: string;
  workspaceRoot?: string;
  mcpManagerFactory?: (config: ResolvedMcpConfig) => McpManager;
  logger?: Logger;
}

export interface SpecraRuntime {
  readonly mcpManager: McpManager;
  readonly toolRegistry: ToolRegistry;
  readonly providerRegistry: ProviderRegistry;
  readonly skillService: SkillService;
  readonly warnings: McpWarning[];
  readonly projectRegistry: ProjectRegistry;
  readonly contextResolver: ProjectContextResolver;
  createSession(workspaceRoot: string): Promise<SessionFile>;
  getSessionFile(workspaceRoot: string, sessionId: string): Promise<SessionFile>;
  listSessions(workspaceRoot: string): Promise<SessionSummary[]>;
  submitAgentJob(input: { slug: string; workspaceRoot: string; sessionId: string; userMessage: string }): RunningJob;
  abortAgentJob(workspaceRoot: string, sessionId: string): boolean;
  abortAgentJobAndWait(workspaceRoot: string, sessionId: string): Promise<void>;
  abortAllAgentJobs(): Promise<void>;
  isAgentJobRunning(workspaceRoot: string, sessionId: string): boolean;
  getAgentJob(workspaceRoot: string, sessionId: string): RunningJob | undefined;
  subscribeSessionEvents(input: SubscribeSessionEventsInput): () => void;
  deleteSession(workspaceRoot: string, sessionId: string): Promise<void>;
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

export async function createSpecraRuntime(
  options: SpecraRuntimeOptions = {},
): Promise<SpecraRuntime> {
  const logger = options.logger ?? createConsoleLogger({ level: "info" });
  const runtimeLogger = logger.child({ module: "runtime" });
  const warnings: McpWarning[] = [];
  const config = await loadConfig(options.configPath ?? DEFAULT_CONFIG_PATH);
  const providerRegistry = createProviderRegistry(config.provider);
  const toolRegistry = createToolRegistry();
  registerBuiltinTools(toolRegistry);
  const skillService = new SkillService();

  const resolvedMcpConfig = resolveMcpConfig(config.mcp);
  const mcpManager = options.mcpManagerFactory
    ? options.mcpManagerFactory(resolvedMcpConfig)
    : new McpManager(BUILTIN_MCP_SERVERS, resolvedMcpConfig.servers);
  const secrets = collectMcpSecrets(
    BUILTIN_MCP_SERVERS,
    resolvedMcpConfig.servers,
  );

  const recordWarning = (warning: McpWarning): void => {
    warnings.push(warning);
    runtimeLogger.warn("mcp.discovery.warning", {
      message: warning.message,
      context: warning.toolName ? { toolName: warning.toolName } : undefined,
      meta: { warning },
    });
  };

  try {
    const discovery = await discoverMcpTools(
      mcpManager,
      resolveMcpDiscoveryTimeout(resolvedMcpConfig),
      secrets,
      recordWarning,
    );
    for (const warning of discovery.warnings) {
      recordWarning(warning);
    }

    for (const descriptor of discovery.descriptors) {
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

    await resolveWorkspaceRoot(options);
    const projectRegistry = new ProjectRegistry({ logger: logger.child({ module: "projects.registry" }) });
    const contextResolver = new ProjectContextResolver();
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
      return await jobRunner.dispatchCommand(workspaceRoot, sessionId, name, args);
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

    const jobRunner = new AgentJobRunner({
      sessionAgentManager,
      storeManager: sessionStoreManager,
      requestPermission,
      requestQuestion,
      cleanupDeferredSession,
      trackSession,
      untrackSession,
      logger,
    });

    return {
      mcpManager,
      toolRegistry,
      providerRegistry,
      skillService,
      warnings,
      projectRegistry,
      contextResolver,
      createSession: (workspaceRoot) => sessionStoreManager.createSessionFile(workspaceRoot),
      getSessionFile: (workspaceRoot, sessionId) => sessionStoreManager.getSessionFile(workspaceRoot, sessionId),
      listSessions: (workspaceRoot) => sessionStoreManager.listSessionSummaries(workspaceRoot),
      submitAgentJob: (input) => jobRunner.submit(input),
      abortAgentJob: (workspaceRoot, sessionId) => jobRunner.abort(workspaceRoot, sessionId),
      abortAgentJobAndWait: (workspaceRoot, sessionId) => jobRunner.abortAndWait(workspaceRoot, sessionId),
      abortAllAgentJobs: () => jobRunner.abortAll(),
      isAgentJobRunning: (workspaceRoot, sessionId) => jobRunner.isRunning(workspaceRoot, sessionId),
      getAgentJob: (workspaceRoot, sessionId) => jobRunner.getJob(workspaceRoot, sessionId),
      subscribeSessionEvents: (input) => jobRunner.subscribe(input),
      deleteSession: (workspaceRoot, sessionId) => jobRunner.deleteSession(workspaceRoot, sessionId),
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
    await closeMcpManagerBestEffort(mcpManager, recordWarning);
    throw err;
  }
}

async function resolveWorkspaceRoot(options: SpecraRuntimeOptions): Promise<string> {
  if (options.workspaceRoot) return options.workspaceRoot;
  if (Bun.env.SPECRA_WORKSPACE_ROOT) return Bun.env.SPECRA_WORKSPACE_ROOT;

  return realpath(dirname(options.configPath ?? DEFAULT_CONFIG_PATH));
}

async function discoverMcpTools(
  mcpManager: McpManager,
  timeoutMs: number,
  secrets: readonly string[],
  warn: (warning: McpWarning) => void,
): Promise<McpDiscoveryResult> {
  try {
    return await withTimeout(mcpManager.discover(), timeoutMs);
  } catch (err) {
    warn({
      message: redactMcpMessage(
        `Failed to discover MCP tools during startup: ${errorMessage(err)}`,
        secrets,
      ),
    });
    return { descriptors: [], warnings: [] };
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`MCP discovery timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return await Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function resolveMcpDiscoveryTimeout(config: ResolvedMcpConfig): number {
  const serverTimeouts = Object.values(config.servers).map(
    (server) => server.timeout,
  );
  return Math.max(30000, ...serverTimeouts);
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
