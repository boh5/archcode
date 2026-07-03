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
import type {
  HitlPayload as ProtocolHitlPayload,
  HitlRequest as ProtocolHitlRequest,
  HitlResponse as ProtocolHitlResponse,
  HitlStreamEvent,
  McpServerStatus,
  SessionTreeResponse,
} from "@archcode/protocol";
import { createRegistry as createToolRegistry, DuplicateToolError, type ToolRegistry } from "./tools/index";
import { DeferredPermissionService, DeferredQuestionService } from "./deferred";
import type { AskUserResponse, DeferredSessionEvent } from "./deferred";
import type { AskUserRequest, ToolConfirmationRequest, ToolConfirmationResult } from "./tools/types";
import { SessionExecutionManager } from "./execution";
import type { ActiveSessionExecution, StartSessionExecutionInput, SubscribeSessionEventsInput } from "./execution";
import { GoalRunner } from "./goals/runner";
import { HitlService } from "./hitl/service";
import { LoopRunner } from "./loops/runner";
import { LoopScheduler, type LoopSchedulerTimer } from "./loops/scheduler";
import type { LoopConfig, LoopRunReport, LoopState, LoopUpdateInput } from "./loops/state";
import type { HitlEvent, HitlEventSubmitter, HitlPayload, HitlResponsePayload } from "./hitl/types";
import { scopedKey } from "./store/key";
import { Logger, createConsoleLogger } from "./logger";
import { SessionStoreManager } from "./store/session-store-manager";
import type { SessionRole } from "./store/types";

const DEFAULT_CONFIG_PATH = ".archcode.json";

export interface AgentRuntimeOptions {
  configPath?: string;
  workspaceRoot?: string;
  mcpManagerFactory?: (config: ResolvedMcpConfig) => McpManager;
  projectRegistryHomeDir?: string;
  loopSchedulerTimer?: LoopSchedulerTimer;
  loopSchedulerClock?: { now(): number };
  logger?: Logger;
}

export interface CreateRuntimeSessionOptions {
  readonly goalId?: string;
  readonly loopId?: string;
  readonly sessionRole?: SessionRole;
  readonly title?: string;
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
  createSession(workspaceRoot: string, options?: CreateRuntimeSessionOptions): Promise<SessionFile>;
  getSessionFile(workspaceRoot: string, sessionId: string): Promise<SessionFile>;
  listSessions(workspaceRoot: string): Promise<SessionSummary[]>;
  startSessionExecution(input: StartSessionExecutionInput): ActiveSessionExecution;
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
  listLoops(workspaceRoot: string): Promise<LoopState[]>;
  readLoop(workspaceRoot: string, loopId: string): Promise<LoopState>;
  createLoop(workspaceRoot: string, config: LoopConfig, author?: string): Promise<LoopState>;
  updateLoop(workspaceRoot: string, loopId: string, updates: LoopUpdateInput): Promise<LoopState>;
  pauseLoop(workspaceRoot: string, loopId: string): Promise<LoopState>;
  resumeLoop(workspaceRoot: string, loopId: string): Promise<LoopState>;
  triggerLoopRun(workspaceRoot: string, loopId: string): Promise<LoopRunReport | undefined>;
  readLoopRunLog(workspaceRoot: string, loopId: string, limit?: number): Promise<LoopRunReport[]>;
  readLoopStateMarkdown(workspaceRoot: string, loopId: string): Promise<string>;
  startLoopSchedulers(): Promise<void>;
  stopLoopSchedulers(): void;
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
    const sessionStoreManager = new SessionStoreManager({ logger });
    const hitlEvents: HitlEventSubmitter = {
      submitHitlEvent: (sessionId, event) => {
        const protocolEvent = toProtocolHitlEvent(event);
        if (protocolEvent) sessionStoreManager.appendSessionEvent(sessionId, protocolEvent);
      },
    };
    const hitl = new HitlService(hitlEvents);
    const contextResolver = new ProjectContextResolver({
      projectInfoFactory: (workspaceRoot) => projectRegistry.getByWorkspace(workspaceRoot),
      hitlFactory: () => new HitlService(hitlEvents),
      logger: runtimeLogger.child({ module: "projects" }),
    });
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
    const loopSchedulers = new Map<string, LoopScheduler>();
    let loopSchedulersStarted = false;

    const createGoalRunnerForLoop = (workspaceRoot: string, loopId?: string): Promise<GoalRunner> => {
      return contextResolver.resolve(workspaceRoot).then((projectContext) => new GoalRunner({
        goalStateManager: projectContext.goalState,
        goalArtifacts: projectContext.goalArtifacts,
        hitlService: projectContext.hitl,
        workspaceRoot,
        createSession: async (createOptions) => (await sessionStoreManager.createSessionFile(workspaceRoot, {
          ...createOptions,
          ...(loopId !== undefined && createOptions?.loopId === undefined ? { loopId } : {}),
        })).sessionId,
        isSessionActive: async (sessionId) => executionManager.isRunning(workspaceRoot, sessionId),
      }));
    };

    async function createLoopRunner(workspaceRoot: string): Promise<LoopRunner> {
      const projectContext = await contextResolver.resolve(workspaceRoot);
      return new LoopRunner({
        stateManager: projectContext.loopState,
        runtime: {
          createSession: (sessionWorkspaceRoot, createOptions) => sessionStoreManager.createSessionFile(sessionWorkspaceRoot, createOptions),
          getSessionFile: (sessionWorkspaceRoot, sessionId) => sessionStoreManager.getSessionFile(sessionWorkspaceRoot, sessionId),
          startSessionExecution: (input) => executionManager.startExecution(input),
        },
        goalStateManager: projectContext.goalState,
        goalRunner: {
          start: async (goalId, startOptions) => (await createGoalRunnerForLoop(workspaceRoot, startOptions?.loopId)).start(goalId, startOptions),
        },
        workspaceRoot,
        projectSlug: projectContext.project.slug,
      });
    }

    async function getLoopScheduler(workspaceRoot: string): Promise<LoopScheduler> {
      const existing = loopSchedulers.get(workspaceRoot);
      if (existing) return existing;

      const projectContext = await contextResolver.resolve(workspaceRoot);
      const runner = await createLoopRunner(workspaceRoot);
      const scheduler = new LoopScheduler({
        stateManager: projectContext.loopState,
        runner: runner.createSchedulerRunner(),
        ...(options.loopSchedulerClock === undefined ? {} : { clock: options.loopSchedulerClock }),
        ...(options.loopSchedulerTimer === undefined ? {} : { timer: options.loopSchedulerTimer }),
        logger: runtimeLogger.child({ module: "loops.scheduler" }),
      });
      loopSchedulers.set(workspaceRoot, scheduler);
      return scheduler;
    }

    async function scheduleLoopIfStarted(workspaceRoot: string, loopId: string): Promise<void> {
      if (!loopSchedulersStarted) return;
      await (await getLoopScheduler(workspaceRoot)).scheduleLoop(loopId);
    }

    async function listLoops(workspaceRoot: string): Promise<LoopState[]> {
      const projectContext = await contextResolver.resolve(workspaceRoot);
      return await projectContext.loopState.list(projectContext.project.slug);
    }

    async function readLoop(workspaceRoot: string, loopId: string): Promise<LoopState> {
      return await (await contextResolver.resolve(workspaceRoot)).loopState.read(loopId);
    }

    async function createLoop(workspaceRoot: string, config: LoopConfig, author?: string): Promise<LoopState> {
      const projectContext = await contextResolver.resolve(workspaceRoot);
      const loop = await projectContext.loopState.create(projectContext.project.slug, config, author);
      await scheduleLoopIfStarted(workspaceRoot, loop.loopId);
      return loop;
    }

    async function updateLoop(workspaceRoot: string, loopId: string, updates: LoopUpdateInput): Promise<LoopState> {
      const updated = await (await contextResolver.resolve(workspaceRoot)).loopState.update(loopId, updates);
      await scheduleLoopIfStarted(workspaceRoot, loopId);
      return updated;
    }

    async function pauseLoop(workspaceRoot: string, loopId: string): Promise<LoopState> {
      const scheduler = loopSchedulers.get(workspaceRoot);
      if (scheduler) return await scheduler.pause(loopId);
      return await (await contextResolver.resolve(workspaceRoot)).loopState.pause(loopId);
    }

    async function resumeLoop(workspaceRoot: string, loopId: string): Promise<LoopState> {
      const scheduler = loopSchedulers.get(workspaceRoot);
      if (scheduler) return await scheduler.resume(loopId);
      const resumed = await (await contextResolver.resolve(workspaceRoot)).loopState.resume(loopId);
      await scheduleLoopIfStarted(workspaceRoot, loopId);
      return resumed;
    }

    async function triggerLoopRun(workspaceRoot: string, loopId: string): Promise<LoopRunReport | undefined> {
      return await (await getLoopScheduler(workspaceRoot)).runManual(loopId);
    }

    async function readLoopRunLog(workspaceRoot: string, loopId: string, limit?: number): Promise<LoopRunReport[]> {
      return await (await contextResolver.resolve(workspaceRoot)).loopState.readRunLog(loopId, limit);
    }

    async function readLoopStateMarkdown(workspaceRoot: string, loopId: string): Promise<string> {
      return await (await contextResolver.resolve(workspaceRoot)).loopState.readGeneratedStateMarkdown(loopId);
    }

    async function startLoopSchedulers(): Promise<void> {
      if (loopSchedulersStarted) return;
      loopSchedulersStarted = true;
      const projects = await projectRegistry.list();
      for (const project of projects) {
        await (await getLoopScheduler(project.workspaceRoot)).start(project.slug);
      }
    }

    function stopLoopSchedulers(): void {
      loopSchedulersStarted = false;
      for (const scheduler of loopSchedulers.values()) scheduler.stop();
      loopSchedulers.clear();
    }

    await recoverRegisteredProjectGoals({
      projectRegistry,
      contextResolver,
      hitl,
      isSessionActive: (workspaceRoot, sessionId) => executionManager.isRunning(workspaceRoot, sessionId),
      createSession: async (workspaceRoot, createOptions) => (await sessionStoreManager.createSessionFile(workspaceRoot, createOptions)).sessionId,
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
      createSession: (workspaceRoot, createOptions) => sessionStoreManager.createSessionFile(workspaceRoot, createOptions),
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
      listLoops,
      readLoop,
      createLoop,
      updateLoop,
      pauseLoop,
      resumeLoop,
      triggerLoopRun,
      readLoopRunLog,
      readLoopStateMarkdown,
      startLoopSchedulers,
      stopLoopSchedulers,
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

function toProtocolHitlEvent(event: HitlEvent): HitlStreamEvent | undefined {
  if (event.type === "hitl.request") {
    return {
      type: "hitl.request",
      request: {
        id: event.hitlId,
        sessionId: event.sessionId,
        ...(event.trigger.goalId === undefined ? {} : { goalId: event.trigger.goalId }),
        ...(event.trigger.loopId === undefined ? {} : { loopId: event.trigger.loopId }),
        kind: event.kind,
        prompt: hitlPrompt(event.payload),
        payload: protocolHitlPayload(event.payload),
        ...(event.displayPayload === undefined ? {} : { displayPayload: event.displayPayload }),
        trigger: event.trigger.source?.startsWith("goal.") || event.kind !== "question" ? "approval_point" : "agent_request",
        ...(event.approvalKey === undefined ? {} : { decisionKey: event.approvalKey }),
        status: "pending",
        createdAt: new Date(event.createdAt).toISOString(),
      } satisfies ProtocolHitlRequest,
    };
  }

  return {
    type: "hitl.resolved",
    hitlId: event.hitlId,
    status: event.status,
    ...(event.status === "resolved" ? { response: protocolHitlResponse(event.kind, event.response) } : {}),
  };
}

function hitlPrompt(payload: HitlPayload): string {
  return payload.message ?? payload.title ?? ("action" in payload ? payload.action : "Human input requested");
}

function protocolHitlPayload(payload: HitlPayload): ProtocolHitlPayload {
  if (payload.kind === "question") {
    return {
      kind: "question",
      ...(payload.options === undefined ? {} : { options: payload.options.map(({ label, description }) => ({ label, ...(description === undefined ? {} : { description }) })) }),
      ...(payload.multiple === undefined ? {} : { multiple: payload.multiple }),
      ...(payload.custom === undefined ? {} : { custom: payload.custom }),
      ...(payload.recommendedOption === undefined ? {} : { recommendedOption: payload.recommendedOption }),
      ...(payload.rationale === undefined ? {} : { rationale: payload.rationale }),
    };
  }
  if (payload.kind === "approval") {
    return { kind: "approval", action: payload.action, context: payload.context };
  }
  if (payload.kind === "review") {
    return {
      kind: "review",
      artifacts: payload.artifacts.map((artifact) => ({
        name: "review.md",
        path: artifact.path,
        mediaType: "text/markdown",
      })),
    };
  }
  return { kind: "question", custom: true };
}

function protocolHitlResponse(kind: HitlEvent["kind"], response: HitlResponsePayload): ProtocolHitlResponse {
  if (kind === "approval") {
    const approved = response.decision === "approved" || response.decision === "approve" || response.outcome === "DONE" || response.data?.approved === true;
    return {
      kind: "approval",
      approved,
      ...(response.data?.approveAlways === true ? { approveAlways: true } : {}),
      ...(response.comment === undefined ? {} : { comment: response.comment }),
    };
  }
  if (kind === "review") {
    return {
      kind: "review",
      outcome: response.outcome ?? (response.decision === "approved" ? "DONE" : "NOT_DONE"),
      ...(response.comment === undefined ? {} : { comment: response.comment }),
    };
  }
  const answers = Array.isArray(response.answers)
    ? response.answers.map((answer) => String(answer))
    : response.decision === undefined ? [] : [response.decision];
  return {
    kind: "question",
    answers,
    ...(response.comment === undefined ? {} : { comment: response.comment }),
  };
}

async function recoverRegisteredProjectGoals(input: {
  projectRegistry: ProjectRegistry;
  contextResolver: ProjectContextResolver;
  hitl: HitlService;
  createSession: (workspaceRoot: string, options?: CreateRuntimeSessionOptions) => Promise<string>;
  isSessionActive: (workspaceRoot: string, sessionId: string) => boolean;
  logger: Logger;
}): Promise<void> {
  const projects = await input.projectRegistry.list();
  for (const project of projects) {
    try {
      const projectContext = await input.contextResolver.resolve(project.workspaceRoot);
      const runner = new GoalRunner({
        goalStateManager: projectContext.goalState,
        goalArtifacts: projectContext.goalArtifacts,
        hitlService: projectContext.hitl,
        workspaceRoot: project.workspaceRoot,
        createSession: (createOptions) => input.createSession(project.workspaceRoot, createOptions),
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
