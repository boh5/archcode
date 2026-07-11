import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { defaultAgentDefinitions } from "./agents";
import { resolveAgentModel } from "./agents/model-resolver";
import { SessionAgentManager } from "./agents/session-agent-manager";
import { BackgroundTaskManager } from "./background/manager";
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
import type { ProjectInfo } from "./projects/types";
import { SessionLifecycleService } from "./projects/session-lifecycle-service";
import { SkillService } from "./skills";
import type { SessionFile, SessionSummary } from "./store/helpers";
import { NotRootSessionError } from "./store/errors";
import type { CompressionOriginalRangeResult } from "./compression";
import type {
  GlobalSSEEvent,
  GlobalSSEHitlRealtimeEvent,
  GlobalSSEHitlSnapshotEvent,
  GlobalSSEResourceChangedEvent,
  GlobalSSESessionRuntimeChangedEvent,
  GlobalSSESessionRuntimeSnapshotEvent,
  HitlProjection,
  McpServerStatus,
  SessionFamilyActivity,
  SessionTreeResponse,
} from "@archcode/protocol";
import { CONFIG_FILE_NAME, ENV_WORKSPACE_ROOT } from "@archcode/protocol";
import { createRegistry as createToolRegistry, DuplicateToolError, type ToolRegistry } from "./tools/index";
import {
  SessionCwdReferenceMigrationService,
  SessionExecutionManager,
  SessionExecutionScopeValidator,
  SessionFamilyStopService,
  SessionHitlResumeAdapter,
  assertSessionHitlJournalAllowsExecution,
} from "./execution";
import type { ActiveSessionExecution, StartSessionExecutionInput, SubscribeSessionEventsInput } from "./execution";
import { GoalHitlResumeAdapter } from "./goals/hitl-resume-adapter";
import { GoalRunner } from "./goals/runner";
import { withGoalExecutionClaimLock } from "./goals/execution-claim";
import { GoalCancellationService, type GoalCancellationRequest } from "./goals/cancellation";
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
import { LoopCleanupService } from "./loops/cleanup";
import { LoopJobCoordinator } from "./loops/coordinator";
import { LoopSessionExecutionClaimResolver } from "./loops/session-execution-claim";
import { LoopSessionHitlContinuationCoordinator } from "./loops/session-hitl-continuation";
import type { LoopBudgetSnapshot, LoopCollisionSnapshot, LoopConfig, LoopIntegrationError, LoopIntegrationSnapshot, LoopRunReport, LoopState, LoopUpdateInput } from "./loops/state";
import { scopedKey } from "./store/key";
import { Logger, createConsoleLogger } from "./logger";
import { SessionStoreManager } from "./store/session-store-manager";
import { redactString } from "./tools/security";
import type { SessionRole } from "./store/types";
import { generateTitle } from "./title-generation";
import type { GoalState } from "./goals/state";

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
  /** Current execution directory; Session persistence remains under workspaceRoot. */
  readonly cwd?: string;
  readonly goalId?: string;
  readonly loopId?: string;
  readonly sessionRole?: SessionRole;
  readonly agentName?: string;
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

export interface ProjectControlPlaneSnapshot {
  readonly sessionRuntime: GlobalSSESessionRuntimeSnapshotEvent;
  readonly hitl: GlobalSSEHitlSnapshotEvent;
}

export interface ProjectRemovalResult {
  readonly project: ProjectInfo;
  readonly snapshot: ProjectControlPlaneSnapshot;
}

export class ProjectRuntimeActiveError extends Error {
  readonly code = "PROJECT_RUNTIME_ACTIVE";

  constructor(
    public readonly projectSlug: string,
    public readonly activeFamilies: ReadonlyArray<{
      readonly rootSessionId: string;
      readonly activity: Exclude<SessionFamilyActivity, "idle">;
    }>,
  ) {
    super(`Project "${projectSlug}" has active Session families and cannot be removed`);
    this.name = "ProjectRuntimeActiveError";
  }
}

export interface AgentRuntime {
  readonly mcpManager: McpManager;
  readonly toolRegistry: ToolRegistry;
  readonly providerRegistry: ProviderRegistry;
  readonly skillService: SkillService;
  readonly warnings: McpWarning[];
  readonly projectRegistry: ProjectRegistry;
  readonly contextResolver: ProjectContextResolver;
  removeProject(projectSlug: string): Promise<ProjectRemovalResult | undefined>;
  recoverHitlResumes(workspaceRoot: string): Promise<ResumeRecoverySummary | undefined>;
  listPendingHitlEvents(): Promise<GlobalSSEEvent[]>;
  subscribeHitlEvents(listener: (event: GlobalSSEHitlRealtimeEvent) => void): () => void;
  listSessionRuntimeEvents(): Promise<GlobalSSESessionRuntimeSnapshotEvent[]>;
  getProjectControlPlaneSnapshot(workspaceRoot: string, projectSlug: string): Promise<ProjectControlPlaneSnapshot>;
  subscribeSessionRuntimeChanges(listener: (event: GlobalSSESessionRuntimeChangedEvent) => void): () => void;
  subscribeResourceChanges?(listener: (event: GlobalSSEResourceChangedEvent) => void): () => void;
  queueGoalTitleGeneration?(workspaceRoot: string, goalId: string): void;
  cancelGoal(workspaceRoot: string, goalId: string, request: GoalCancellationRequest): Promise<GoalState>;
  queueLoopTitleGeneration?(workspaceRoot: string, loopId: string): void;
  subscribeMcpStatusChanges(listener: (serverName: string, status: McpServerStatus) => void): () => void;
  getMcpServerStatuses(): Map<string, McpServerStatus>;
  createSession(workspaceRoot: string, options?: CreateRuntimeSessionOptions): Promise<SessionFile>;
  getSessionFile(workspaceRoot: string, sessionId: string): Promise<SessionFile>;
  resolveCompressionOriginalRange(workspaceRoot: string, sessionId: string, blockRef: string): Promise<CompressionOriginalRangeResult>;
  listSessions(workspaceRoot: string): Promise<SessionSummary[]>;
  startSessionExecution(input: StartSessionExecutionInput): ActiveSessionExecution;
  /** User-message entry point with cold Session/root cwd validation. */
  startSessionMessageExecution(input: StartSessionExecutionInput): Promise<ActiveSessionExecution>;
  getSessionFamilyActivity(workspaceRoot: string, rootSessionId: string): SessionFamilyActivity;
  stopSessionFamily(workspaceRoot: string, rootSessionId: string): Promise<void>;
  abortAllSessionExecutions(): Promise<void>;
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
  createLoop(workspaceRoot: string, config: LoopConfig): Promise<LoopState>;
  updateLoop(workspaceRoot: string, loopId: string, updates: LoopUpdateInput): Promise<LoopState>;
  pauseLoop(workspaceRoot: string, loopId: string): Promise<LoopState>;
  resumeLoop(workspaceRoot: string, loopId: string): Promise<LoopState>;
  triggerLoopRun(workspaceRoot: string, loopId: string): Promise<LoopRunReport | undefined>;
  readLoopKillState(workspaceRoot: string): Promise<LoopKillState>;
  cancelLoopCurrentRun(workspaceRoot: string, loopId: string): Promise<LoopRunReport | undefined>;
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
    const projectSlugsByWorkspace = new Map(
      (await projectRegistry.list()).map((project) => [project.workspaceRoot, project.slug]),
    );
    const rememberProject = async (workspaceRoot: string): Promise<void> => {
      const project = await projectRegistry.getByWorkspace(workspaceRoot);
      if (project !== undefined) projectSlugsByWorkspace.set(project.workspaceRoot, project.slug);
    };
    const sessionStoreManager = new SessionStoreManager({ logger });
    const hitlListeners = new Set<(event: GlobalSSEHitlRealtimeEvent) => void>();
    const sessionRuntimeListeners = new Set<(event: GlobalSSESessionRuntimeChangedEvent) => void>();
    const resourceChangeListeners = new Set<(event: GlobalSSEResourceChangedEvent) => void>();
    const resourceTitleTasks = new BackgroundTaskManager({ logger: runtimeLogger.child({ module: "title-generation.resources" }) });
    const publishHitlEvent = (event: GlobalSSEHitlRealtimeEvent): void => {
      for (const listener of hitlListeners) listener(event);
    };
    const publishResourceChanged = (event: GlobalSSEResourceChangedEvent): void => {
      for (const listener of resourceChangeListeners) listener(event);
    };
    let contextResolver!: ProjectContextResolver;
    let executionScopeValidator!: SessionExecutionScopeValidator;
    contextResolver = new ProjectContextResolver({
      projectInfoFactory: async (workspaceRoot) => {
        const project = await projectRegistry.getByWorkspace(workspaceRoot);
        if (project === undefined) {
          throw new Error(`Project is not registered: ${workspaceRoot}`);
        }
        projectSlugsByWorkspace.set(project.workspaceRoot, project.slug);
        return project;
      },
      hitlFactory: (hitlOptions) => new HitlService({
        ...hitlOptions,
        realtimePublisher: publishHitlEvent,
        logger: runtimeLogger.child({ module: "hitl" }),
      }),
      goalCancellationFactory: ({ workspaceRoot, goalState, hitl }) => new GoalCancellationService({
        workspaceRoot,
        goalStateManager: goalState,
        hitlService: hitl,
        sessionStoreManager,
        sessionFamilyController: {
          acquireStop: (input) => executionManager.acquireSessionFamilyStop(input),
        },
      }),
      sessionStoreManager,
      resumeCoordinatorFactory: ({ workspaceRoot, hitl, goalState, loopState }) => new ResumeCoordinator({
        hitl,
        adapters: {
          session: new SessionHitlResumeAdapter({
            workspaceRoot,
            storeManager: sessionStoreManager,
            toolRegistry,
            projectContextResolver: contextResolver,
            executionScopeValidator,
            skillService,
            getAgent: (agentWorkspaceRoot, sessionId) => sessionAgentManager.getOrCreate(agentWorkspaceRoot, sessionId),
            startChildExecution: (childWorkspaceRoot, request) => executionManager.startChildExecution(childWorkspaceRoot, request),
            cancelChildSession: (childWorkspaceRoot, parentSessionId, childSessionId) => executionManager.cancelChildSession(childWorkspaceRoot, parentSessionId, childSessionId),
            resumeChildSession: (childWorkspaceRoot, request) => executionManager.resumeChildExecution(childWorkspaceRoot, request),
            reserveSessionHitlResume: (childWorkspaceRoot, sessionId, rootSessionId, acquireOptions) => (
              executionManager.reserveSessionHitlResume(childWorkspaceRoot, sessionId, rootSessionId, acquireOptions)
            ),
            updateChildSessionLinkForHitl: (childWorkspaceRoot, sessionId, status) => (
              executionManager.updateChildSessionLinkForHitl(childWorkspaceRoot, sessionId, status)
            ),
            loopContinuation: {
              acquire: async (input) => await (await getLoopSessionHitlContinuation(workspaceRoot)).acquire(input),
            },
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
            goalCancellation: new GoalCancellationService({
              workspaceRoot,
              goalStateManager: goalState,
              hitlService: hitl,
              sessionStoreManager,
              sessionFamilyController: {
                acquireStop: (input) => executionManager.acquireSessionFamilyStop(input),
              },
            }),
          }),
        },
        logger: runtimeLogger.child({ module: "projects" }),
      }),
      logger: runtimeLogger.child({ module: "projects" }),
    });
    executionScopeValidator = new SessionExecutionScopeValidator({
      projectContextResolver: contextResolver,
      loopExecutionClaimResolver: new LoopSessionExecutionClaimResolver(),
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
      flushSessionStore: (sessionId, workspaceRoot) => sessionStoreManager.flushSession(sessionId, workspaceRoot),
      getSessionStore: (sessionId, workspaceRoot) => sessionStoreManager.get(sessionId, workspaceRoot),
      loadSessionStore: (sessionId, workspaceRoot) => sessionStoreManager.getOrLoad(sessionId, workspaceRoot),
      deleteSessionStore: (sessionId, workspaceRoot, deleteOptions) => sessionStoreManager.delete(sessionId, workspaceRoot, deleteOptions),
      resolveRootSessionId: (sessionId, workspaceRoot) => sessionStoreManager.resolveRootSessionId(sessionId, workspaceRoot),
      buildSessionTree: (workspaceRoot, rootSessionId) => sessionStoreManager.buildSessionTree(workspaceRoot, rootSessionId),
      trackSession,
      untrackSession,
      executionScopeValidator,
      executionClaimCoordinator: {
        run: (ownerId, action) => withGoalExecutionClaimLock(ownerId, action),
      },
      sessionHitlExecutionGate: {
        assertAllowed: (workspaceRoot, sessionId) => (
          assertSessionHitlJournalAllowsExecution(workspaceRoot, sessionId)
        ),
      },
      deletionPreflight: new SessionLifecycleService({
        storeManager: sessionStoreManager,
        projectContextResolver: contextResolver,
      }),
      logger,
    });
    const sessionFamilyStopService = new SessionFamilyStopService({
      sessionFamilyController: {
        acquireStop: (input) => executionManager.acquireSessionFamilyStop(input),
      },
      sessionStoreManager,
      resolveHitlOwner: async (workspaceRoot) => {
        const context = await contextResolver.resolve(workspaceRoot);
        return { projectSlug: context.project.slug, hitl: context.hitl };
      },
    });
    executionManager.subscribeSessionRuntimeChanges((change) => {
      const projectSlug = projectSlugsByWorkspace.get(change.workspaceRoot);
      if (projectSlug === undefined) {
        runtimeLogger.warn("session.runtime.project_missing", {
          message: "Dropped Session runtime change for an unregistered workspace",
          context: { rootSessionId: change.rootSessionId, activity: change.activity },
        });
        return;
      }
      const event: GlobalSSESessionRuntimeChangedEvent = {
        type: "session.runtime_changed",
        projectSlug,
        rootSessionId: change.rootSessionId,
        activity: change.activity,
        createdAt: Date.now(),
      };
      for (const listener of sessionRuntimeListeners) {
        try {
          listener(event);
        } catch (error) {
          runtimeLogger.warn("session.runtime.listener.failed", {
            error,
            context: { projectSlug, rootSessionId: change.rootSessionId, activity: change.activity },
          });
        }
      }
    });
    const sessionCwdReferenceMigration = new SessionCwdReferenceMigrationService({
      storeManager: sessionStoreManager,
      acquireIdleSessionFamilyCwdTransitions: (projectRoot, rootSessionIds) => (
        executionManager.acquireIdleSessionFamilyCwdTransitions(projectRoot, rootSessionIds)
      ),
      releaseSessionAgent: (projectRoot, sessionId) => sessionAgentManager.releaseAgent(projectRoot, sessionId),
    });
    type LoopRuntimeServices = {
      readonly scheduler: LoopScheduler;
      readonly sessionHitlContinuation: LoopSessionHitlContinuationCoordinator;
    };
    const loopRuntimeServices = new Map<string, Promise<LoopRuntimeServices>>();
    let loopSchedulersStarted = false;

    const createGoalRunnerForLoop = (workspaceRoot: string, loopId?: string): Promise<GoalRunner> => {
      return contextResolver.resolve(workspaceRoot).then((projectContext) => new GoalRunner({
        goalStateManager: projectContext.goalState,
        workspaceRoot,
        createSession: async (createOptions) => (await sessionStoreManager.createSessionFile(workspaceRoot, {
          ...createOptions,
          ...(loopId !== undefined && createOptions?.loopId === undefined ? { loopId } : {}),
        })).sessionId,
        getSessionCwd: async (sessionId) => (await sessionStoreManager.getSessionFile(workspaceRoot, sessionId)).cwd,
        isSessionActive: async (sessionId) => {
          const session = await sessionStoreManager.getSessionFile(workspaceRoot, sessionId);
          return executionManager.getSessionFamilyActivity(workspaceRoot, session.rootSessionId) !== "idle";
        },
      }));
    };

    async function createLoopRunner(
      workspaceRoot: string,
      collisionLedger?: CollisionLedger,
      worktreeManager = new LoopWorktreeManager({ canonicalRoot: workspaceRoot }),
    ): Promise<LoopRunner> {
      const projectContext = await contextResolver.resolve(workspaceRoot);
      return new LoopRunner({
        stateManager: projectContext.loopState,
        runtime: {
          createSession: (projectRoot, createOptions) => sessionStoreManager.createSessionFile(projectRoot, createOptions),
          getSessionFile: (projectRoot, sessionId) => sessionStoreManager.getSessionFile(projectRoot, sessionId),
          startSessionExecution: (input) => executionManager.startExecution(input),
          releaseSessionAgent: (projectRoot, sessionId) => sessionAgentManager.releaseAgent(projectRoot, sessionId),
        },
        goalStateManager: projectContext.goalState,
        goalRunner: {
          start: async (goalId, startOptions) => (
            await createGoalRunnerForLoop(workspaceRoot, startOptions.executionScope.loopId)
          ).start(goalId, startOptions),
        },
        workspaceRoot,
        projectSlug: projectContext.project.slug,
        ...(collisionLedger === undefined ? {} : { collisionLedger }),
        worktreeManager,
        queueGoalTitleGeneration: (goalId) => queueGoalTitleGeneration(workspaceRoot, goalId),
      });
    }

    function queueGoalTitleGeneration(workspaceRoot: string, goalId: string): void {
      resourceTitleTasks.dispatch(scopedKey(workspaceRoot, `goal-title:${goalId}`), async () => {
        const projectContext = await contextResolver.resolve(workspaceRoot);
        const goal = await projectContext.goalState.read(goalId);
        if (goal.title !== null) return;
        const title = await generateResourceTitle("goal", goalTitleSource(goal));
        if (title === null) return;
        const updated = await projectContext.goalState.setTitleIfEmpty(goal.id, title);
        if (updated === undefined) return;
        publishResourceChanged({
          type: "resource.changed",
          projectSlug: projectContext.project.slug,
          resourceType: "goal",
          resourceId: goal.id,
          reason: "title_generated",
          createdAt: Date.now(),
        });
      });
    }

    function queueLoopTitleGeneration(workspaceRoot: string, loopId: string): void {
      resourceTitleTasks.dispatch(scopedKey(workspaceRoot, `loop-title:${loopId}`), async () => {
        const projectContext = await contextResolver.resolve(workspaceRoot);
        const loop = await projectContext.loopState.read(loopId);
        if (loop.config.title !== null) return;
        const title = await generateResourceTitle("loop", loopTitleSource(loop));
        if (title === null) return;
        const updated = await projectContext.loopState.setTitleIfEmpty(loop.loopId, title);
        if (updated === undefined) return;
        publishResourceChanged({
          type: "resource.changed",
          projectSlug: projectContext.project.slug,
          resourceType: "loop",
          resourceId: loop.loopId,
          reason: "title_generated",
          createdAt: Date.now(),
        });
      });
    }

    async function generateResourceTitle(kind: "goal" | "loop", text: string): Promise<string | null> {
      const { modelInfo, options: modelOptions } = resolveAgentModel("orchestrator", config, providerRegistry);
      return await generateTitle({ kind, text, modelInfo, modelOptions });
    }

    async function createLoopRuntimeServices(workspaceRoot: string): Promise<LoopRuntimeServices> {
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
      const jobCoordinator = new LoopJobCoordinator({ queue: jobQueue, clock: schedulerClock });
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
      const worktreeManager = new LoopWorktreeManager({ canonicalRoot: workspaceRoot });
      const runner = await createLoopRunner(workspaceRoot, collisionLedger, worktreeManager);
      const cleanupService = new LoopCleanupService({
        stateManager: projectContext.loopState,
        jobQueue,
        collisionLedger,
        worktreeManager,
        workspaceRoot,
        clock: schedulerClock,
        migrateSessionCwdReferencesForRemoval: (migrationInput, operation) => (
          sessionCwdReferenceMigration.migrateForRemoval(migrationInput, operation)
        ),
      });
      const scheduler = new LoopScheduler({
        stateManager: projectContext.loopState,
        runner: runner.createSchedulerRunner(),
        clock: schedulerClock,
        ...(options.loopSchedulerTimer === undefined ? {} : { timer: options.loopSchedulerTimer }),
        budgetLedger,
        collisionLedger,
        jobQueue,
        coordinator: jobCoordinator,
        hitl: projectContext.hitl,
        cleanupJob: (jobId) => cleanupService.cleanupJob(jobId),
        readSessionAttempt: async (sessionId, executionId) => {
          const session = await sessionStoreManager.getSessionFile(workspaceRoot, sessionId);
          return {
            execution: session.executions.find((execution) => execution.id === executionId),
            blockedByHitlIds: session.blockedByHitlIds
              ?? (session.blockedHitl === undefined ? undefined : [session.blockedHitl.hitlId]),
          };
        },
        triggerPoller,
        killStateManager: new LoopKillStateManager(workspaceRoot, {
          clock: schedulerClock,
          logger: runtimeLogger.child({ module: "loops.kill-state" }),
        }),
        stopSessionFamily: async (sessionId) => {
          const session = await sessionStoreManager.getSessionFile(workspaceRoot, sessionId);
          await executionManager.stopSessionFamily(workspaceRoot, session.rootSessionId);
        },
        logger: runtimeLogger.child({ module: "loops.scheduler" }),
      });
      const sessionHitlContinuation = new LoopSessionHitlContinuationCoordinator({
        stateManager: projectContext.loopState,
        jobQueue,
        jobCoordinator,
        collisionLedger,
        now: schedulerClock.now,
        scheduleCleanup: ({ loopId, runId, jobId }) => {
          const timer = setTimeout(() => {
            void (async () => {
              await cleanupService.cleanupJob(jobId);
              const completed = await jobQueue.read(jobId);
              if (completed.cleanupState === undefined || completed.cleanupState === "in_progress") return;
              await projectContext.loopState.recordRunCleanupCompletion(loopId, runId, {
                cleanupState: completed.cleanupState,
                cleanupWarning: completed.cleanupWarning,
                observedArtifacts: completed.observedArtifacts,
              });
            })().catch((error) => {
              runtimeLogger.warn("loops.session_hitl.cleanup.failed", {
                error,
                meta: { workspaceRoot, loopId, runId, jobId },
              });
            });
          }, 0);
          if (typeof timer === "object" && "unref" in timer) timer.unref();
        },
      });
      return { scheduler, sessionHitlContinuation };
    }

    async function getLoopRuntimeServices(workspaceRoot: string): Promise<LoopRuntimeServices> {
      const existing = loopRuntimeServices.get(workspaceRoot);
      if (existing !== undefined) return await existing;

      const pending = createLoopRuntimeServices(workspaceRoot);
      loopRuntimeServices.set(workspaceRoot, pending);
      try {
        return await pending;
      } catch (error) {
        if (loopRuntimeServices.get(workspaceRoot) === pending) loopRuntimeServices.delete(workspaceRoot);
        throw error;
      }
    }

    async function getLoopScheduler(workspaceRoot: string): Promise<LoopScheduler> {
      return (await getLoopRuntimeServices(workspaceRoot)).scheduler;
    }

    async function getLoopSessionHitlContinuation(workspaceRoot: string): Promise<LoopSessionHitlContinuationCoordinator> {
      return (await getLoopRuntimeServices(workspaceRoot)).sessionHitlContinuation;
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

    async function createLoop(workspaceRoot: string, config: LoopConfig): Promise<LoopState> {
      const projectContext = await contextResolver.resolve(workspaceRoot);
      const loop = await projectContext.loopState.create(projectContext.project.slug, config);
      queueLoopTitleGeneration(workspaceRoot, loop.loopId);
      await scheduleLoopIfStarted(workspaceRoot, loop.loopId);
      return loop;
    }

    async function updateLoop(workspaceRoot: string, loopId: string, updates: LoopUpdateInput): Promise<LoopState> {
      const updated = await (await contextResolver.resolve(workspaceRoot)).loopState.update(loopId, updates);
      await scheduleLoopIfStarted(workspaceRoot, loopId);
      return updated;
    }

    async function pauseLoop(workspaceRoot: string, loopId: string): Promise<LoopState> {
      const services = loopRuntimeServices.get(workspaceRoot);
      if (services !== undefined) return await (await services).scheduler.pause(loopId);
      return await (await contextResolver.resolve(workspaceRoot)).loopState.pause(loopId);
    }

    async function resumeLoop(workspaceRoot: string, loopId: string): Promise<LoopState> {
      const services = loopRuntimeServices.get(workspaceRoot);
      if (services !== undefined) return await (await services).scheduler.resume(loopId);
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

    async function cancelLoopCurrentRun(workspaceRoot: string, loopId: string): Promise<LoopRunReport | undefined> {
      return await (await getLoopScheduler(workspaceRoot)).cancelCurrentRun(loopId);
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
      const services = await Promise.allSettled([...loopRuntimeServices.values()]);
      await Promise.all(services.flatMap((result) => result.status === "fulfilled" ? [result.value.scheduler.stop()] : []));
      loopRuntimeServices.clear();
    }

    sessionAgentManager.setStartChildExecution((workspaceRoot, request) => executionManager.startChildExecution(workspaceRoot, request));
    sessionAgentManager.setCancelChildSession((workspaceRoot, parentSessionId, childSessionId) => executionManager.cancelChildSession(workspaceRoot, parentSessionId, childSessionId));
    sessionAgentManager.setResumeChildSession((workspaceRoot, request) => executionManager.resumeChildExecution(workspaceRoot, request));
    sessionAgentManager.setAcquireSessionCwdTransition((workspaceRoot, sessionId) => executionManager.acquireSessionCwdTransition(workspaceRoot, sessionId));

    async function getProjectControlPlaneSnapshot(
      workspaceRoot: string,
      projectSlug: string,
    ): Promise<ProjectControlPlaneSnapshot> {
      executionManager.assertWorkspaceOpen(workspaceRoot);
      const project = await projectRegistry.get(projectSlug);
      if (project === undefined || project.workspaceRoot !== workspaceRoot) {
        throw new Error(`Project control-plane snapshot scope mismatch: ${projectSlug}`);
      }
      projectSlugsByWorkspace.set(workspaceRoot, projectSlug);
      const context = await contextResolver.resolve(workspaceRoot);
      const projections = await context.hitl.list({ scope: "project", status: "active" });
      const families = executionManager.listSessionFamilyActivities().flatMap((family) => (
        family.workspaceRoot === workspaceRoot
          ? [{ projectSlug, rootSessionId: family.rootSessionId, activity: family.activity }]
          : []
      ));
      const createdAt = Date.now();
      return {
        sessionRuntime: {
          type: "session.runtime.snapshot",
          projectSlugs: [projectSlug],
          families,
          createdAt,
        },
        hitl: {
          type: "hitl.snapshot",
          projectSlugs: [projectSlug],
          projections,
          createdAt,
        },
      };
    }

    async function removeProject(projectSlug: string): Promise<ProjectRemovalResult | undefined> {
      const project = await projectRegistry.get(projectSlug);
      if (project === undefined) return undefined;

      const closeLease = executionManager.acquireWorkspaceClose(project.workspaceRoot);
      try {
        const liveFamilies = executionManager.listSessionFamilyActivities()
          .filter((family) => family.workspaceRoot === project.workspaceRoot && family.activity !== "idle")
          .map(({ rootSessionId, activity }) => ({
            rootSessionId,
            activity: activity as Exclude<SessionFamilyActivity, "idle">,
          }));
        const activeFamilies = [...liveFamilies];
        const activeIds = new Set(liveFamilies.map((family) => family.rootSessionId));
        for (const pending of executionManager.listPendingCheckedStarts(project.workspaceRoot)) {
          if (activeIds.has(pending.sessionId)) continue;
          activeIds.add(pending.sessionId);
          activeFamilies.push({ rootSessionId: pending.sessionId, activity: "running" });
        }
        if (activeFamilies.length > 0) {
          throw new ProjectRuntimeActiveError(project.slug, activeFamilies);
        }

        const loopServices = loopRuntimeServices.get(project.workspaceRoot);
        if (loopServices !== undefined) await (await loopServices).scheduler.stop();

        const removed = await projectRegistry.remove(project.slug);
        if (removed === undefined) return undefined;
        projectSlugsByWorkspace.delete(project.workspaceRoot);
        loopRuntimeServices.delete(project.workspaceRoot);
        await contextResolver.dispose(project.workspaceRoot);
        sessionAgentManager.releaseWorkspace(project.workspaceRoot);
        sessionStoreManager.releaseWorkspace(project.workspaceRoot);
        for (const [key, active] of activeSessionKeys) {
          if (active.workspaceRoot === project.workspaceRoot) activeSessionKeys.delete(key);
        }

        const createdAt = Date.now();
        return {
          project: removed,
          snapshot: {
            sessionRuntime: {
              type: "session.runtime.snapshot",
              projectSlugs: [removed.slug],
              families: [],
              createdAt,
            },
            hitl: {
              type: "hitl.snapshot",
              projectSlugs: [removed.slug],
              projections: [],
              createdAt,
            },
          },
        };
      } finally {
        closeLease.release();
      }
    }

    return {
      mcpManager,
      toolRegistry,
      providerRegistry,
      skillService,
      warnings,
      projectRegistry,
      contextResolver,
      removeProject,
      recoverHitlResumes: async (workspaceRoot) => (await contextResolver.resolve(workspaceRoot)).hitlResumeCoordinator.recover(),
      listPendingHitlEvents: async () => {
        const projects = await projectRegistry.list();
        const projections: HitlProjection[] = [];
        for (const project of projects) {
          const context = await contextResolver.resolve(project.workspaceRoot);
          projections.push(...await context.hitl.list({ scope: "project", status: "active" }));
        }
        return [{
          type: "hitl.snapshot",
          projectSlugs: projects.map((project) => project.slug),
          projections,
          createdAt: Date.now(),
        }];
      },
      subscribeHitlEvents: (listener) => {
        hitlListeners.add(listener);
        return () => {
          hitlListeners.delete(listener);
        };
      },
      listSessionRuntimeEvents: async () => {
        const projects = await projectRegistry.list();
        const registeredProjectSlugs = new Map(projects.map((project) => [project.workspaceRoot, project.slug]));
        for (const project of projects) projectSlugsByWorkspace.set(project.workspaceRoot, project.slug);
        const families = executionManager.listSessionFamilyActivities().flatMap((family) => {
          const projectSlug = registeredProjectSlugs.get(family.workspaceRoot);
          return projectSlug === undefined ? [] : [{
            projectSlug,
            rootSessionId: family.rootSessionId,
            activity: family.activity,
          }];
        });
        return [{
          type: "session.runtime.snapshot",
          projectSlugs: projects.map((project) => project.slug),
          families,
          createdAt: Date.now(),
        }];
      },
      getProjectControlPlaneSnapshot,
      subscribeSessionRuntimeChanges: (listener) => {
        sessionRuntimeListeners.add(listener);
        return () => {
          sessionRuntimeListeners.delete(listener);
        };
      },
      subscribeResourceChanges: (listener) => {
        resourceChangeListeners.add(listener);
        return () => {
          resourceChangeListeners.delete(listener);
        };
      },
      queueGoalTitleGeneration,
      cancelGoal: async (workspaceRoot, goalId, request) => {
        const service = (await contextResolver.resolve(workspaceRoot)).goalCancellation;
        if (service === undefined) throw new Error("Goal cancellation service is unavailable");
        return await service.cancel(goalId, request);
      },
      queueLoopTitleGeneration,
      subscribeMcpStatusChanges: (listener) => mcpManager.onStatusChange(listener),
      getMcpServerStatuses: () => mcpManager.getStatus(),
      createSession: (workspaceRoot, createOptions) => {
        executionManager.assertWorkspaceOpen(workspaceRoot);
        return sessionStoreManager.createSessionFile(workspaceRoot, createOptions);
      },
      getSessionFile: (workspaceRoot, sessionId) => sessionStoreManager.getSessionFile(workspaceRoot, sessionId),
      resolveCompressionOriginalRange: (workspaceRoot, sessionId, blockRef) => sessionStoreManager.resolveCompressionOriginalRange(workspaceRoot, sessionId, blockRef),
      listSessions: (workspaceRoot) => sessionStoreManager.listSessionSummaries(workspaceRoot),
      startSessionExecution: (input) => {
        projectSlugsByWorkspace.set(input.workspaceRoot, input.slug);
        return executionManager.startExecution(input);
      },
      startSessionMessageExecution: (input) => {
        projectSlugsByWorkspace.set(input.workspaceRoot, input.slug);
        return executionManager.startCheckedExecution(input);
      },
      getSessionFamilyActivity: (workspaceRoot, rootSessionId) => executionManager.getSessionFamilyActivity(workspaceRoot, rootSessionId),
      stopSessionFamily: async (workspaceRoot, rootSessionId) => {
        await rememberProject(workspaceRoot);
        const store = await sessionStoreManager.getOrLoad(rootSessionId, workspaceRoot);
        const state = store.getState();
        if (state.parentSessionId !== undefined || state.rootSessionId !== rootSessionId) {
          throw new NotRootSessionError(rootSessionId, state.parentSessionId ?? state.rootSessionId);
        }
        await sessionFamilyStopService.stop(workspaceRoot, rootSessionId);
      },
      abortAllSessionExecutions: () => executionManager.abortAll(),
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

function goalTitleSource(goal: GoalState): string {
  return [
    "Objective:",
    goal.objective,
    "Acceptance criteria:",
    goal.acceptanceCriteria,
  ].join("\n");
}

function loopTitleSource(loop: LoopState): string {
  const goalTemplate = loop.config.goalTemplate;
  return [
    `Template: ${loop.config.templateId}`,
    loop.config.taskPrompt === undefined ? undefined : `Run instructions:\n${loop.config.taskPrompt}`,
    goalTemplate === undefined ? undefined : `Goal objective:\n${goalTemplate.objective}`,
    goalTemplate === undefined ? undefined : `Goal acceptance criteria:\n${goalTemplate.acceptanceCriteria}`,
  ].filter((section): section is string => section !== undefined).join("\n\n");
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
