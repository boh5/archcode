import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { defaultAgentDefinitions } from "./agents";
import { SessionAgentManager } from "./agents/session-agent-manager";
import type { SlashCommandResult } from "./commands/types";
import { loadConfig } from "./config/load";
import { configureDefaultLspClientPoolLogger } from "./lsp/client-pool";
import { configureDefaultBinaryManagerLogger } from "./binary/manager";
import { configureDefaultProcessRunnerLogger } from "./process/runner";
import { configureDefaultLspToolLogger } from "./tools/builtins/lsp/tool-logger";
import { configureDefaultWebFetchLogger } from "./tools/builtins/web-fetch";
import { GithubIntegrationTokenError, resolveGithubIntegrationConfig } from "./config";
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
import { createRegistry as createProviderRegistry, type ProviderRegistry } from "./provider/index";
import { ProjectContextResolver } from "./projects/context-resolver";
import { ProjectRegistry } from "./projects/registry";
import { SkillService } from "./skills";
import type { SessionFile, SessionSummary } from "./store/helpers";
import type { CompressionOriginalRangeResult } from "./compression";
import type {
  GlobalSSEEvent,
  GlobalSSEHitlRealtimeEvent,
  McpServerStatus,
  SessionTreeResponse,
} from "@archcode/protocol";
import { CONFIG_FILE_NAME, ENV_WORKSPACE_ROOT } from "@archcode/protocol";
import { createRegistry as createToolRegistry, DuplicateToolError, type ToolRegistry } from "./tools/index";
import { SessionExecutionManager, SessionHitlResumeAdapter } from "./execution";
import type { ActiveSessionExecution, StartSessionExecutionInput, SubscribeSessionEventsInput } from "./execution";
import { GoalHitlResumeAdapter } from "./goals/hitl-resume-adapter";
import { GoalRunner } from "./goals/runner";
import { HitlService } from "./hitl/service";
import { ResumeCoordinator, type ResumeRecoverySummary } from "./hitl/resume-coordinator";
import { createGitHubConnector } from "./integrations/github";
import { LoopRunner } from "./loops/runner";
import { LoopHitlResumeAdapter } from "./loops/hitl-resume-adapter";
import { LoopBudgetLedger } from "./loops/budget-ledger";
import { CollisionLedger } from "./loops/collision-ledger";
import { LoopKillStateManager, type LoopKillActivateInput, type LoopKillState } from "./loops/kill-state";
import { LoopJobQueue } from "./loops/job-queue";
import { LoopTriggerPoller } from "./loops/triggers";
import { LoopScheduler, type LoopSchedulerTimer } from "./loops/scheduler";
import { LoopWorktreeManager } from "./loops/worktree-manager";
import type { LoopBudgetSnapshot, LoopCollisionSnapshot, LoopConfig, LoopIntegrationError, LoopIntegrationSnapshot, LoopRunReport, LoopState, LoopUpdateInput } from "./loops/state";
import { scopedKey } from "./store/key";
import { Logger, createConsoleLogger } from "./logger";
import { SessionStoreManager } from "./store/session-store-manager";
import { redactString } from "./tools/security";
import type { SessionRole } from "./store/types";

const DEFAULT_CONFIG_PATH = CONFIG_FILE_NAME;

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

export interface LoopIntegrationStatus {
  readonly integrationId: "github" | "github_actions";
  readonly status: "disabled" | "ready" | "auth_missing" | "rate_limited" | "error";
  readonly reason?: "integration_auth_missing" | "integration_rate_limited";
  readonly message?: string;
  readonly retryAfterMs?: number;
  readonly updatedAt: number;
}

export interface LoopIntegrationStatusSnapshot {
  readonly statuses: LoopIntegrationStatus[];
  readonly snapshot: LoopIntegrationSnapshot | null;
  readonly updatedAt: number;
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
  recoverHitlResumes(workspaceRoot: string): Promise<ResumeRecoverySummary | undefined>;
  listPendingHitlEvents(): Promise<GlobalSSEEvent[]>;
  subscribeHitlEvents(listener: (event: GlobalSSEHitlRealtimeEvent) => void): () => void;
  subscribeMcpStatusChanges(listener: (serverName: string, status: McpServerStatus) => void): () => void;
  getMcpServerStatuses(): Map<string, McpServerStatus>;
  createSession(workspaceRoot: string, options?: CreateRuntimeSessionOptions): Promise<SessionFile>;
  getSessionFile(workspaceRoot: string, sessionId: string): Promise<SessionFile>;
  resolveCompressionOriginalRange(workspaceRoot: string, sessionId: string, blockRef: string): Promise<CompressionOriginalRangeResult>;
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
  dispatchCommand(workspaceRoot: string, sessionId: string, name: string, args?: string): Promise<SlashCommandResult | null>;
  listLoops(workspaceRoot: string): Promise<LoopState[]>;
  readLoop(workspaceRoot: string, loopId: string): Promise<LoopState>;
  createLoop(workspaceRoot: string, config: LoopConfig, author?: string): Promise<LoopState>;
  updateLoop(workspaceRoot: string, loopId: string, updates: LoopUpdateInput): Promise<LoopState>;
  pauseLoop(workspaceRoot: string, loopId: string): Promise<LoopState>;
  resumeLoop(workspaceRoot: string, loopId: string): Promise<LoopState>;
  triggerLoopRun(workspaceRoot: string, loopId: string): Promise<LoopRunReport | undefined>;
  readLoopKillState(workspaceRoot: string): Promise<LoopKillState>;
  cancelLoopCurrentRun(workspaceRoot: string, loopId: string): Promise<LoopRunReport | undefined>;
  cancelCurrentLoopRun(workspaceRoot: string, loopId: string): Promise<LoopRunReport | undefined>;
  activateLoopGlobalKill(workspaceRoot: string, input?: LoopKillActivateInput): Promise<LoopKillState>;
  clearLoopGlobalKill(workspaceRoot: string): Promise<LoopKillState>;
  readLoopBudget(workspaceRoot: string, loopId: string): Promise<LoopBudgetSnapshot | null>;
  readLoopCollisions(workspaceRoot: string, loopId: string): Promise<LoopCollisionSnapshot>;
  readLoopIntegrationStatus(workspaceRoot: string, loopId: string): Promise<LoopIntegrationStatusSnapshot>;
  readLoopRunLog(workspaceRoot: string, loopId: string, limit?: number): Promise<LoopRunReport[]>;
  readLoopStateMarkdown(workspaceRoot: string, loopId: string): Promise<string>;
  startLoopSchedulers(): Promise<void>;
  stopLoopSchedulers(): Promise<void>;
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
    const hitlListeners = new Set<(event: GlobalSSEHitlRealtimeEvent) => void>();
    const publishHitlEvent = (event: GlobalSSEHitlRealtimeEvent): void => {
      for (const listener of hitlListeners) listener(event);
    };
    const hitl = new HitlService({ sessions: sessionStoreManager, realtimePublisher: publishHitlEvent });
    let contextResolver!: ProjectContextResolver;
    contextResolver = new ProjectContextResolver({
      projectInfoFactory: (workspaceRoot) => projectRegistry.getByWorkspace(workspaceRoot),
      hitlFactory: (workspaceRoot) => new HitlService({ workspaceRoot, realtimePublisher: publishHitlEvent }),
      sessionStoreManager,
      resumeCoordinatorFactory: ({ workspaceRoot, hitl, goalState, loopState }) => new ResumeCoordinator({
        hitl,
        adapters: {
          session: new SessionHitlResumeAdapter({
            workspaceRoot,
            storeManager: sessionStoreManager,
            toolRegistry,
            projectContextResolver: contextResolver,
            skillService,
            getAgent: (agentWorkspaceRoot, sessionId) => sessionAgentManager.getOrCreate(agentWorkspaceRoot, sessionId),
            startChildExecution: (childWorkspaceRoot, request) => executionManager.startChildExecution(childWorkspaceRoot, request),
            cancelChildSession: (childWorkspaceRoot, parentSessionId, childSessionId) => executionManager.cancelChildSession(childWorkspaceRoot, parentSessionId, childSessionId),
            resumeChildSession: (childWorkspaceRoot, request) => executionManager.resumeChildExecution(childWorkspaceRoot, request),
            abortSessionExecutionAndWait: (childWorkspaceRoot, sessionId) => executionManager.abortAndWait(childWorkspaceRoot, sessionId),
            attachSessionEvents: (eventWorkspaceRoot, sessionId, store) => executionManager.attachSessionEvents(eventWorkspaceRoot, sessionId, store),
            detachSessionEvents: (eventWorkspaceRoot, sessionId) => executionManager.detachSessionEvents(eventWorkspaceRoot, sessionId),
          }),
          loop: new LoopHitlResumeAdapter({
            workspaceRoot,
            stateManager: loopState,
            jobQueue: new LoopJobQueue({ workspaceRoot, clock: options.loopSchedulerClock }),
            now: options.loopSchedulerClock?.now,
            onContinuationQueued: async () => {
              await (await getLoopScheduler(workspaceRoot)).dispatchPendingJobs();
            },
          }),
          goal: new GoalHitlResumeAdapter({
            workspaceRoot,
            goalStateManager: goalState,
            hitlService: hitl,
          }),
        },
        logger: runtimeLogger.child({ module: "projects" }),
      }),
      resumeAdapters: {
        session: { resume: async () => { throw new Error("Session HITL adapter factory was not used"); } },
        goal: { resume: async () => { throw new Error("Goal HITL adapter factory was not used"); } },
        loop: { resume: async () => { throw new Error("Loop HITL adapter factory was not used"); } },
      },
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
    async function dispatchCommand(
      workspaceRoot: string,
      sessionId: string,
      name: string,
      args?: string,
    ): Promise<SlashCommandResult | null> {
      return await executionManager.dispatchCommand(workspaceRoot, sessionId, name, args);
    }

    function notifyRuntimeShutdown(reason: string): void {
      runtimeLogger.info("runtime.shutdown", { message: reason, meta: { activeSessions: activeSessionKeys.size } });
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
      trackSession,
      untrackSession,
      logger,
    });
    const loopSchedulers = new Map<string, LoopScheduler>();
    let loopSchedulersStarted = false;

    const createGoalRunnerForLoop = (workspaceRoot: string, loopId?: string): Promise<GoalRunner> => {
      return contextResolver.resolve(workspaceRoot).then((projectContext) => new GoalRunner({
        goalStateManager: projectContext.goalState,
        hitlService: projectContext.hitl,
        workspaceRoot,
        createSession: async (createOptions) => (await sessionStoreManager.createSessionFile(workspaceRoot, {
          ...createOptions,
          ...(loopId !== undefined && createOptions?.loopId === undefined ? { loopId } : {}),
        })).sessionId,
        isSessionActive: async (sessionId) => executionManager.isRunning(workspaceRoot, sessionId),
      }));
    };

    async function createLoopRunner(workspaceRoot: string, collisionLedger?: CollisionLedger): Promise<LoopRunner> {
      const projectContext = await contextResolver.resolve(workspaceRoot);
      return new LoopRunner({
        stateManager: projectContext.loopState,
        runtime: {
          createSession: (sessionWorkspaceRoot, createOptions) => sessionStoreManager.createSessionFile(sessionWorkspaceRoot, createOptions),
          getSessionFile: (sessionWorkspaceRoot, sessionId) => sessionStoreManager.getSessionFile(sessionWorkspaceRoot, sessionId),
          startSessionExecution: (input) => executionManager.startExecution(input),
          prepareSessionWorkspace: async (sessionWorkspaceRoot, canonicalWorkspaceRoot) => {
            const canonicalContext = await contextResolver.resolve(canonicalWorkspaceRoot);
            contextResolver.alias(sessionWorkspaceRoot, {
              ...canonicalContext,
              project: {
                ...canonicalContext.project,
                workspaceRoot: sessionWorkspaceRoot,
              },
            });
          },
          releaseSessionWorkspace: (sessionWorkspaceRoot, sessionId) => {
            if (sessionId !== undefined) sessionAgentManager.release(sessionWorkspaceRoot, sessionId);
            sessionAgentManager.releaseWorkspace(sessionWorkspaceRoot);
            sessionStoreManager.releaseWorkspace(sessionWorkspaceRoot);
            contextResolver.dispose(sessionWorkspaceRoot);
          },
        },
        goalStateManager: projectContext.goalState,
        goalRunner: {
          start: async (goalId, startOptions) => (await createGoalRunnerForLoop(startOptions?.workspaceRoot ?? workspaceRoot, startOptions?.loopId)).start(goalId, startOptions),
        },
        workspaceRoot,
        projectSlug: projectContext.project.slug,
        ...(collisionLedger === undefined ? {} : { collisionLedger }),
        worktreeManager: new LoopWorktreeManager({ canonicalRoot: workspaceRoot }),
      });
    }

    async function getLoopScheduler(workspaceRoot: string): Promise<LoopScheduler> {
      const existing = loopSchedulers.get(workspaceRoot);
      if (existing) return existing;

      const projectContext = await contextResolver.resolve(workspaceRoot);
      const schedulerClock = options.loopSchedulerClock ?? { now: () => Date.now() };
      const budgetLedger = new LoopBudgetLedger({
        stateManager: projectContext.loopState,
        workspaceRoot,
        clock: schedulerClock,
      });
      const collisionLedger = new CollisionLedger({
        stateManager: projectContext.loopState,
        workspaceRoot,
        clock: schedulerClock,
      });
      const jobQueue = new LoopJobQueue({
        workspaceRoot,
        clock: schedulerClock,
      });
      const github = createGitHubConnector({ config: config.integrations?.github });
      const triggerPoller = new LoopTriggerPoller({
        workspaceRoot,
        stateManager: projectContext.loopState,
        queue: jobQueue,
        github,
        repository: config.integrations?.github?.defaultOwner === undefined || config.integrations.github.defaultRepo === undefined
          ? undefined
          : { owner: config.integrations.github.defaultOwner, repo: config.integrations.github.defaultRepo },
        clock: schedulerClock,
      });
      const runner = await createLoopRunner(workspaceRoot, collisionLedger);
      const scheduler = new LoopScheduler({
        stateManager: projectContext.loopState,
        runner: runner.createSchedulerRunner(),
        clock: schedulerClock,
        ...(options.loopSchedulerTimer === undefined ? {} : { timer: options.loopSchedulerTimer }),
        budgetLedger,
        collisionLedger,
        jobQueue,
        hitl: projectContext.hitl,
        triggerPoller,
        killStateManager: new LoopKillStateManager(workspaceRoot, {
          clock: schedulerClock,
          logger: runtimeLogger.child({ module: "loops.kill-state" }),
        }),
        abortSessionExecutionAndWait: (sessionId) => executionManager.abortAndWait(workspaceRoot, sessionId),
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

    async function readLoopKillState(workspaceRoot: string): Promise<LoopKillState> {
      return await (await getLoopScheduler(workspaceRoot)).readKillState();
    }

    async function cancelCurrentLoopRun(workspaceRoot: string, loopId: string): Promise<LoopRunReport | undefined> {
      return await (await getLoopScheduler(workspaceRoot)).cancelCurrentRun(loopId);
    }

    async function cancelLoopCurrentRun(workspaceRoot: string, loopId: string): Promise<LoopRunReport | undefined> {
      return await cancelCurrentLoopRun(workspaceRoot, loopId);
    }

    async function activateLoopGlobalKill(workspaceRoot: string, input?: LoopKillActivateInput): Promise<LoopKillState> {
      return await (await getLoopScheduler(workspaceRoot)).activateGlobalKill(input);
    }

    async function clearLoopGlobalKill(workspaceRoot: string): Promise<LoopKillState> {
      return await (await getLoopScheduler(workspaceRoot)).clearGlobalKill();
    }

    async function readLoopBudget(workspaceRoot: string, loopId: string): Promise<LoopBudgetSnapshot | null> {
      const loop = await readLoop(workspaceRoot, loopId);
      return loop.latestBudget ?? null;
    }

    async function readLoopCollisions(workspaceRoot: string, loopId: string): Promise<LoopCollisionSnapshot> {
      const loop = await readLoop(workspaceRoot, loopId);
      return loop.latestCollisions ?? {
        targets: loop.config.collisionTargets ?? [],
        activeLeases: [],
        conflicts: [],
        updatedAt: loop.updatedAt,
      };
    }

    async function readLoopIntegrationStatus(workspaceRoot: string, loopId: string): Promise<LoopIntegrationStatusSnapshot> {
      const loop = await readLoop(workspaceRoot, loopId);
      const snapshot = loop.latestIntegrations ?? null;
      const statusById = new Map<LoopIntegrationStatus["integrationId"], LoopIntegrationStatus>();

      const githubStatus = githubIntegrationStatus(config.integrations?.github, loop.updatedAt);
      statusById.set(githubStatus.integrationId, githubStatus);

      for (const error of snapshot?.errors ?? []) {
        statusById.set(error.integrationId, statusFromIntegrationError(error));
      }

      const updatedAt = Math.max(loop.updatedAt, snapshot?.updatedAt ?? 0, ...[...statusById.values()].map((status) => status.updatedAt));
      return {
        statuses: [...statusById.values()].sort((left, right) => left.integrationId.localeCompare(right.integrationId)),
        snapshot: snapshot === null ? null : sanitizeIntegrationSnapshot(snapshot),
        updatedAt,
      };
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

    async function stopLoopSchedulers(): Promise<void> {
      loopSchedulersStarted = false;
      await Promise.all([...loopSchedulers.values()].map((scheduler) => scheduler.stop()));
      loopSchedulers.clear();
    }

    sessionAgentManager.setStartChildExecution((workspaceRoot, request) => executionManager.startChildExecution(workspaceRoot, request));
    sessionAgentManager.setCancelChildSession((workspaceRoot, parentSessionId, childSessionId) => executionManager.cancelChildSession(workspaceRoot, parentSessionId, childSessionId));
    sessionAgentManager.setResumeChildSession((workspaceRoot, request) => executionManager.resumeChildExecution(workspaceRoot, request));
    sessionAgentManager.setAbortSessionExecutionAndWait((workspaceRoot, sessionId) => executionManager.abortAndWait(workspaceRoot, sessionId));

    return {
      mcpManager,
      toolRegistry,
      providerRegistry,
      skillService,
      warnings,
      projectRegistry,
      contextResolver,
      hitl,
      recoverHitlResumes: async (workspaceRoot) => (await contextResolver.resolve(workspaceRoot)).hitlResumeCoordinator?.recover(),
      listPendingHitlEvents: async () => {
        const projects = await projectRegistry.list();
        const events: GlobalSSEEvent[] = [{
          type: "hitl.snapshot",
          projectSlugs: projects.map((project) => project.slug),
          createdAt: Date.now(),
        }];
        for (const project of projects) {
          const context = await contextResolver.resolve(project.workspaceRoot);
          for (const projection of await context.hitl.list({ scope: "project", status: "active" })) {
            events.push({
              type: "hitl.event",
              projectSlug: projection.project.slug,
              owner: projection.owner,
              hitlId: projection.hitlId,
              createdAt: Date.now(),
              payload: { type: "hitl.snapshot", status: projection.status },
              projection,
            });
          }
        }
        return events;
      },
      subscribeHitlEvents: (listener) => {
        hitlListeners.add(listener);
        return () => {
          hitlListeners.delete(listener);
        };
      },
      subscribeMcpStatusChanges: (listener) => mcpManager.onStatusChange(listener),
      getMcpServerStatuses: () => mcpManager.getStatus(),
      createSession: (workspaceRoot, createOptions) => sessionStoreManager.createSessionFile(workspaceRoot, createOptions),
      getSessionFile: (workspaceRoot, sessionId) => sessionStoreManager.getSessionFile(workspaceRoot, sessionId),
      resolveCompressionOriginalRange: (workspaceRoot, sessionId, blockRef) => sessionStoreManager.resolveCompressionOriginalRange(workspaceRoot, sessionId, blockRef),
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
      readLoopKillState,
      cancelLoopCurrentRun,
      cancelCurrentLoopRun,
      activateLoopGlobalKill,
      clearLoopGlobalKill,
      readLoopBudget,
      readLoopCollisions,
      readLoopIntegrationStatus,
      readLoopRunLog,
      readLoopStateMarkdown,
      startLoopSchedulers,
      stopLoopSchedulers,
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

function githubIntegrationStatus(githubConfig: Parameters<typeof resolveGithubIntegrationConfig>[0], updatedAt: number): LoopIntegrationStatus {
  try {
    const resolved = resolveGithubIntegrationConfig(githubConfig);
    if (!resolved.enabled) {
      return {
        integrationId: "github",
        status: "disabled",
        updatedAt,
      };
    }
    return {
      integrationId: "github",
      status: "ready",
      updatedAt,
    };
  } catch (error) {
    if (error instanceof GithubIntegrationTokenError) {
      return {
        integrationId: "github",
        status: "auth_missing",
        reason: "integration_auth_missing",
        message: redactString(error.message),
        updatedAt,
      };
    }
    return {
      integrationId: "github",
      status: "error",
      message: error instanceof Error ? redactString(error.message) : redactString(String(error)),
      updatedAt,
    };
  }
}

function statusFromIntegrationError(error: LoopIntegrationError): LoopIntegrationStatus {
  return {
    integrationId: error.integrationId,
    status: error.reason === "integration_auth_missing" ? "auth_missing" : "rate_limited",
    reason: error.reason,
    message: redactString(error.message),
    retryAfterMs: error.retryAfterMs,
    updatedAt: error.occurredAt,
  };
}

function sanitizeIntegrationSnapshot(snapshot: LoopIntegrationSnapshot): LoopIntegrationSnapshot {
  return {
    ...snapshot,
    errors: snapshot.errors.map((error) => ({
      ...error,
      message: redactString(error.message),
    })),
  };
}

async function resolveWorkspaceRoot(options: AgentRuntimeOptions): Promise<string> {
  if (options.workspaceRoot) return options.workspaceRoot;
  if (Bun.env[ENV_WORKSPACE_ROOT]) return Bun.env[ENV_WORKSPACE_ROOT];

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
