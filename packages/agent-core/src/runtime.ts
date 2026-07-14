import { defaultAgentDefinitions } from "./agents";
import type { AgentName } from "./agents";
import { resolveAgentModel } from "./agents/model-resolver";
import { SessionAgentManager } from "./agents/session-agent-manager";
import { BackgroundTaskManager } from "./background/manager";
import type { SlashCommandResult } from "./commands/types";
import { ServerConfigService } from "./config/server-config-service";
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
  AgentDescriptor,
  Automation,
  AutomationInvocation,
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
import { createRegistry as createToolRegistry, DuplicateToolError, type ToolRegistry } from "./tools/index";
import {
  SessionExecutionManager,
  SessionExecutionScopeValidator,
  SessionFamilyStopService,
  RoleDrivenSessionGoalDelegationAdmission,
  SessionHitlResumeAdapter,
  assertSessionHitlJournalAllowsExecution,
} from "./execution";
import type { ActiveSessionExecution, StartSessionExecutionInput, SubscribeSessionEventsInput } from "./execution";
import { GoalHitlResumeAdapter } from "./goals/hitl-resume-adapter";
import {
  GoalLeadContinuationService,
  type GoalLeadContinuationCoordinator,
  type GoalLeadContinuationOptions,
} from "./goals/goal-lead-continuation";
import { withGoalExecutionClaimLock } from "./goals/execution-claim";
import { GoalCancellationService, type GoalCancellationRequest } from "./goals/cancellation";
import { GoalLifecycleService } from "./goals/lifecycle-service";
import { HitlService } from "./hitl/service";
import { ResumeCoordinator, type ResumeRecoverySummary } from "./hitl/resume-coordinator";
import {
  AutomationCoordinator,
  AutomationDispatcher,
  AutomationScheduler,
  AutomationStateManager,
  type AutomationSchedulerClock,
  type AutomationSchedulerTimer,
  type CreateAutomationInput,
  type UpdateAutomationInput,
} from "./automations";
import { RuntimeSessionDispatchGateway } from "./automations/runtime-session-gateway";
import { scopedKey } from "./store/key";
import { Logger, createConsoleLogger } from "./logger";
import { SessionStoreManager } from "./store/session-store-manager";
import type { SessionRole } from "./store/types";
import { generateTitle } from "./title-generation";
import type { GoalState } from "./goals/state";
import { WorktreeService } from "./worktrees";

export interface AgentRuntimeOptions {
  /** Explicit dependency-injection seam for isolated tests. */
  configService?: ServerConfigService;
  mcpManagerFactory?: (config: ResolvedMcpConfig) => McpManager;
  projectRegistryHomeDir?: string;
  automationSchedulerTimer?: AutomationSchedulerTimer;
  automationSchedulerClock?: AutomationSchedulerClock;
  logger?: Logger;
  goalLeadContinuationFactory?: (options: GoalLeadContinuationOptions) => GoalLeadContinuationCoordinator;
}

export interface CreateRuntimeSessionOptions {
  readonly agentName: AgentName;
  /** Current execution directory; Session persistence remains under workspaceRoot. */
  readonly cwd?: string;
  readonly goalId?: string;
  readonly sessionRole?: SessionRole;
  readonly title?: string;
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

export class ResourceCreationSourceError extends Error {
  readonly code = "RESOURCE_CREATION_SOURCE_INVALID";

  constructor(
    public readonly sessionId: string,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "ResourceCreationSourceError";
  }
}

export interface AgentRuntime {
  readonly mcpManager: McpManager;
  readonly toolRegistry: ToolRegistry;
  readonly providerRegistry: ProviderRegistry;
  readonly skillService: SkillService;
  readonly warnings: McpWarning[];
  readonly configService: ServerConfigService;
  readonly projectRegistry: ProjectRegistry;
  readonly contextResolver: ProjectContextResolver;
  listAgentDescriptors(): readonly AgentDescriptor[];
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
  subscribeMcpStatusChanges(listener: (serverName: string, status: McpServerStatus) => void): () => void;
  getMcpServerStatuses(): Map<string, McpServerStatus>;
  createSession(workspaceRoot: string, options: CreateRuntimeSessionOptions): Promise<SessionFile>;
  getSessionFile(workspaceRoot: string, sessionId: string): Promise<SessionFile>;
  resolveCompressionOriginalRange(workspaceRoot: string, sessionId: string, blockRef: string): Promise<CompressionOriginalRangeResult>;
  listSessions(workspaceRoot: string): Promise<SessionSummary[]>;
  startSessionExecution(input: StartSessionExecutionInput): ActiveSessionExecution;
  /** User-message entry point with cold Session/root cwd validation. */
  startSessionMessageExecution(input: StartSessionExecutionInput): Promise<ActiveSessionExecution>;
  /** Installs the server transport wrapper used by Automation Session dispatch. */
  setAutomationSessionMessageExecutor(
    executor: (input: StartSessionExecutionInput) => Promise<ActiveSessionExecution>,
  ): void;
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
  listAutomations(workspaceRoot: string): Promise<Automation[]>;
  readAutomation(workspaceRoot: string, automationId: string): Promise<Automation>;
  createAutomation(workspaceRoot: string, input: Omit<CreateAutomationInput, "projectSlug">): Promise<Automation>;
  updateAutomation(workspaceRoot: string, automationId: string, input: UpdateAutomationInput): Promise<Automation>;
  deleteAutomation(workspaceRoot: string, automationId: string): Promise<void>;
  pauseAutomation(workspaceRoot: string, automationId: string): Promise<Automation>;
  resumeAutomation(workspaceRoot: string, automationId: string): Promise<Automation>;
  runAutomationNow(workspaceRoot: string, automationId: string): Promise<AutomationInvocation>;
  listAutomationInvocations(workspaceRoot: string, automationId: string, limit?: number): Promise<AutomationInvocation[]>;
  startAutomationScheduler(workspaceRoot: string): Promise<void>;
  startAutomationSchedulers(): Promise<void>;
  reconcileRegisteredProject(workspaceRoot: string, projectSlug: string): Promise<void>;
  stopAutomationSchedulers(): Promise<void>;
  notifyRuntimeShutdown(reason: string): void;
}

export async function createRuntime(
  options: AgentRuntimeOptions = {},
): Promise<AgentRuntime> {
  const logger = options.logger ?? createConsoleLogger({ level: "info" });
  const runtimeLogger = logger.child({ module: "runtime" });
  const warnings: McpWarning[] = [];
  const configService = options.configService ?? new ServerConfigService();
  const config = await configService.loadForStartup();
  const providerRegistry = createProviderRegistry(config.provider);
  const toolRegistry = createToolRegistry();
  registerBuiltinTools(toolRegistry, logger.child({ module: "tools" }), {
    ...(config.integrations?.github === undefined ? {} : { github: config.integrations.github }),
  });
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
    const goalStateReconcileRetries = new Map<string, { attempt: number; timer?: ReturnType<typeof setTimeout> }>();
    const goalStateReconcileInFlight = new Set<string>();
    const projectReconcileRetries = new Map<string, { attempt: number; timer?: ReturnType<typeof setTimeout> }>();
    const projectReconcileInFlight = new Set<string>();
    const cancelledReconcileWorkspaces = new Set<string>();
    let goalStateReconciliationShuttingDown = false;
    let goalLeadContinuation: GoalLeadContinuationCoordinator | undefined;
    const publishHitlEvent = (event: GlobalSSEHitlRealtimeEvent): void => {
      for (const listener of hitlListeners) listener(event);
    };
    const publishResourceChanged = (event: GlobalSSEResourceChangedEvent): void => {
      for (const listener of resourceChangeListeners) {
        try {
          listener(event);
        } catch (error) {
          runtimeLogger.warn("resource.changed.listener.failed", {
            error,
            context: { resourceType: event.resourceType, resourceId: event.resourceId },
          });
        }
      }
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
      goalCommitted: ({ workspaceRoot, project, goal }) => {
        publishResourceChanged({
          type: "resource.changed",
          projectSlug: project.slug,
          resourceType: "goal",
          resourceId: goal.id,
          createdAt: Date.now(),
        });
      },
      goalLifecycleFactory: ({ workspaceRoot, goalState }) => new GoalLifecycleService({
        workspaceRoot,
        goalStateManager: goalState,
        readSourceSession: (projectRoot, sessionId) => sessionStoreManager.getSessionFile(projectRoot, sessionId),
        ensureSessionFile: (projectRoot, sessionId, createOptions) => (
          sessionStoreManager.ensureSessionFile(projectRoot, sessionId, createOptions)
        ),
        startCheckedExecutionWithinGoalClaim: (input) => (
          executionManager.startCheckedExecutionWithinGoalClaim(input)
        ),
        onCreated: (goal) => queueGoalTitleGeneration(workspaceRoot, goal.id),
      }),
      createAutomation: (workspaceRoot, input) => createAutomation(workspaceRoot, input),
      sessionStoreManager,
      resumeCoordinatorFactory: ({ workspaceRoot, hitl, goalState }) => new ResumeCoordinator({
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
            attachSessionEvents: (eventWorkspaceRoot, sessionId, store) => executionManager.attachSessionEvents(eventWorkspaceRoot, sessionId, store),
            detachSessionEvents: (eventWorkspaceRoot, sessionId) => executionManager.detachSessionEvents(eventWorkspaceRoot, sessionId),
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
            onGoalStateChanged: (goalId) => notifyGoalStateChanged(workspaceRoot, goalId),
          }),
        },
        logger: runtimeLogger.child({ module: "projects" }),
      }),
      logger: runtimeLogger.child({ module: "projects" }),
    });
    executionScopeValidator = new SessionExecutionScopeValidator({ projectContextResolver: contextResolver });
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
      goalLeadContinuation?.shutdown();
      shutdownGoalStateReconciliation();
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
      listSessionFamilyBlockedHitlIds: (workspaceRoot, rootSessionId) => (
        sessionStoreManager.listSessionFamilyBlockedHitlIds(workspaceRoot, rootSessionId)
      ),
      trackSession,
      untrackSession,
      executionScopeValidator,
      executionClaimCoordinator: {
        run: (ownerId, action) => withGoalExecutionClaimLock(ownerId, action),
      },
      goalDelegationAdmission: new RoleDrivenSessionGoalDelegationAdmission(contextResolver),
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
    const continuationOptions: GoalLeadContinuationOptions = {
      projectContextResolver: contextResolver,
      sessionRuntime: {
        getSessionFile: (workspaceRoot, sessionId) => sessionStoreManager.getSessionFile(workspaceRoot, sessionId),
        getSessionFamilyActivity: (workspaceRoot, rootSessionId) => executionManager.getSessionFamilyActivity(workspaceRoot, rootSessionId),
        listSessionFamilyBlockedHitlIds: (workspaceRoot, rootSessionId) => (
          sessionStoreManager.listSessionFamilyBlockedHitlIds(workspaceRoot, rootSessionId)
        ),
        startCheckedExecutionWithinGoalClaim: (input) => executionManager.startCheckedExecutionWithinGoalClaim(input),
      },
      logger: runtimeLogger.child({ module: "goals.continuation" }),
    };
    const continuationService = options.goalLeadContinuationFactory?.(continuationOptions)
      ?? new GoalLeadContinuationService(continuationOptions);
    goalLeadContinuation = continuationService;
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
      if (change.activity === "idle") {
        void continuationService.onFamilyIdle(change.workspaceRoot, change.rootSessionId).catch((error) => {
          runtimeLogger.warn("goal.continuation.idle.failed", {
            error,
            context: { rootSessionId: change.rootSessionId },
            meta: { workspaceRoot: change.workspaceRoot },
          });
        });
        if (automationSchedulersStarted) {
          void getAutomationRuntimeServices(change.workspaceRoot)
            .then(({ scheduler }) => scheduler.tick())
            .catch((error) => {
              runtimeLogger.warn("automations.pending_dispatch.failed", {
                error,
                context: { rootSessionId: change.rootSessionId },
                meta: { workspaceRoot: change.workspaceRoot },
              });
            });
        }
      }
    });
    type AutomationRuntimeServices = {
      readonly stateManager: AutomationStateManager;
      readonly scheduler: AutomationScheduler;
    };
    const automationRuntimeServices = new Map<string, Promise<AutomationRuntimeServices>>();
    let automationSchedulersStarted = false;
    let automationSessionMessageExecutor = (input: StartSessionExecutionInput) => (
      executionManager.startCheckedExecution(input)
    );

    async function createAutomationRuntimeServices(workspaceRoot: string): Promise<AutomationRuntimeServices> {
      const project = await projectRegistry.getByWorkspace(workspaceRoot);
      if (project === undefined) throw new Error(`Project is not registered: ${workspaceRoot}`);
      projectSlugsByWorkspace.set(workspaceRoot, project.slug);
      const clock = options.automationSchedulerClock ?? { now: () => Date.now() };
      const now = (): number => clock.now();
      const stateManager = new AutomationStateManager(workspaceRoot, { now });
      const onChange = (change: { automationId: string }): void => {
        publishResourceChanged({
          type: "resource.changed",
          projectSlug: project.slug,
          resourceType: "automation",
          resourceId: change.automationId,
          createdAt: Date.now(),
        });
      };
      const coordinator = new AutomationCoordinator();
      const gateway = new RuntimeSessionDispatchGateway({
        sessionStoreManager,
        sessionRuntime: {
          getSessionExecution: (projectRoot, sessionId) => executionManager.getExecution(projectRoot, sessionId),
          getSessionFamilyActivity: (projectRoot, rootSessionId) => (
            executionManager.getSessionFamilyActivity(projectRoot, rootSessionId)
          ),
          startSessionMessageExecution: (input) => automationSessionMessageExecutor(input),
        },
        resolveProject: (projectSlug) => projectRegistry.get(projectSlug),
      });
      const dispatcher = new AutomationDispatcher({ stateManager, gateway, now, onChange, coordinator });
      const scheduler = new AutomationScheduler({
        stateManager,
        dispatcher,
        clock,
        onChange,
        ...(options.automationSchedulerTimer === undefined ? {} : { timer: options.automationSchedulerTimer }),
      });
      return { stateManager, scheduler };
    }

    async function getAutomationRuntimeServices(workspaceRoot: string): Promise<AutomationRuntimeServices> {
      const existing = automationRuntimeServices.get(workspaceRoot);
      if (existing !== undefined) return await existing;
      const pending = createAutomationRuntimeServices(workspaceRoot);
      automationRuntimeServices.set(workspaceRoot, pending);
      try {
        return await pending;
      } catch (error) {
        if (automationRuntimeServices.get(workspaceRoot) === pending) automationRuntimeServices.delete(workspaceRoot);
        throw error;
      }
    }

    function queueGoalTitleGeneration(workspaceRoot: string, goalId: string): void {
      resourceTitleTasks.dispatch(scopedKey(workspaceRoot, `goal-title:${goalId}`), async () => {
        const projectContext = await contextResolver.resolve(workspaceRoot);
        const goal = await projectContext.goalState.read(goalId);
        if (goal.title !== null) return;
        const title = await generateGoalTitle(goalTitleSource(goal));
        if (title === null) return;
        const updated = await projectContext.goalState.setTitleIfEmpty(goal.id, title);
        if (updated === undefined) return;
      });
    }

    async function generateGoalTitle(text: string): Promise<string | null> {
      const { modelInfo, options: modelOptions } = resolveAgentModel("engineer", config, providerRegistry);
      return await generateTitle({ kind: "goal", text, modelInfo, modelOptions });
    }

    async function notifyGoalStateChanged(workspaceRoot: string, goalId: string): Promise<void> {
      const key = `${workspaceRoot}\0${goalId}`;
      if (goalStateReconciliationShuttingDown || cancelledReconcileWorkspaces.has(workspaceRoot) || goalStateReconcileInFlight.has(key) || goalStateReconcileRetries.get(key)?.timer !== undefined) return;
      goalStateReconcileInFlight.add(key);
      try {
        await contextResolver.resolve(workspaceRoot);
        await goalLeadContinuation?.kick(workspaceRoot, goalId);
        goalStateReconcileRetries.delete(key);
      } catch (error) {
        if (goalStateReconciliationShuttingDown || cancelledReconcileWorkspaces.has(workspaceRoot)) return;
        const attempt = (goalStateReconcileRetries.get(key)?.attempt ?? 0) + 1;
        const delay = Math.min(100 * 2 ** (attempt - 1), 30_000);
        const retry: { attempt: number; timer?: ReturnType<typeof setTimeout> } = { attempt };
        retry.timer = setTimeout(() => {
          retry.timer = undefined;
          if (goalStateReconciliationShuttingDown || cancelledReconcileWorkspaces.has(workspaceRoot)) {
            goalStateReconcileRetries.delete(key);
            return;
          }
          void notifyGoalStateChanged(workspaceRoot, goalId);
        }, delay);
        retry.timer.unref?.();
        goalStateReconcileRetries.set(key, retry);
        runtimeLogger.warn("goals.reconcile_failed", {
          error,
          context: { goalId },
          meta: { workspaceRoot, attempt, retryDelayMs: delay },
        });
      } finally {
        goalStateReconcileInFlight.delete(key);
      }
    }

    function shutdownGoalStateReconciliation(): void {
      goalStateReconciliationShuttingDown = true;
      for (const retry of goalStateReconcileRetries.values()) {
        if (retry.timer !== undefined) clearTimeout(retry.timer);
      }
      goalStateReconcileRetries.clear();
      for (const retry of projectReconcileRetries.values()) {
        if (retry.timer !== undefined) clearTimeout(retry.timer);
      }
      projectReconcileRetries.clear();
    }

    function cancelWorkspaceReconciliation(workspaceRoot: string): void {
      cancelledReconcileWorkspaces.add(workspaceRoot);
      const prefix = `${workspaceRoot}\0`;
      for (const [key, retry] of goalStateReconcileRetries) {
        if (!key.startsWith(prefix)) continue;
        if (retry.timer !== undefined) clearTimeout(retry.timer);
        goalStateReconcileRetries.delete(key);
      }
      for (const [key, retry] of projectReconcileRetries) {
        if (!key.startsWith(prefix)) continue;
        if (retry.timer !== undefined) clearTimeout(retry.timer);
        projectReconcileRetries.delete(key);
      }
      goalLeadContinuation?.releaseWorkspace(workspaceRoot);
    }

    async function listAutomations(workspaceRoot: string): Promise<Automation[]> {
      return await (await getAutomationRuntimeServices(workspaceRoot)).scheduler.listAutomations();
    }

    async function readAutomation(workspaceRoot: string, automationId: string): Promise<Automation> {
      return await (await getAutomationRuntimeServices(workspaceRoot)).scheduler.readAutomation(automationId);
    }

    async function createAutomation(
      workspaceRoot: string,
      input: Omit<CreateAutomationInput, "projectSlug">,
    ): Promise<Automation> {
      const project = await projectRegistry.getByWorkspace(workspaceRoot);
      if (project === undefined) throw new Error(`Project is not registered: ${workspaceRoot}`);
      await assertResourceCreationSource(workspaceRoot, input.createdFromSessionId);
      await assertAutomationWorktreeSupported(workspaceRoot, input.action);
      return await (await getAutomationRuntimeServices(workspaceRoot)).scheduler.createAutomation({
        ...input,
        projectSlug: project.slug,
      });
    }

    async function assertResourceCreationSource(
      workspaceRoot: string,
      sessionId: string,
    ): Promise<void> {
      let session: SessionFile;
      try {
        session = await sessionStoreManager.getSessionFile(workspaceRoot, sessionId);
      } catch (error) {
        throw new ResourceCreationSourceError(
          sessionId,
          `Creation source Session ${sessionId} does not exist in this project`,
          { cause: error },
        );
      }
      const ordinaryRole = session.sessionRole === undefined || session.sessionRole === "standalone";
      if (
        session.sessionId !== session.rootSessionId
        || session.parentSessionId !== undefined
        || session.goalId !== undefined
        || session.agentName !== "engineer"
        || !ordinaryRole
      ) {
        throw new ResourceCreationSourceError(
          sessionId,
          `Creation source Session ${sessionId} must be an ordinary root Engineer Session`,
        );
      }
    }

    async function updateAutomation(
      workspaceRoot: string,
      automationId: string,
      input: UpdateAutomationInput,
    ): Promise<Automation> {
      const services = await getAutomationRuntimeServices(workspaceRoot);
      const current = await services.scheduler.readAutomation(automationId);
      await assertAutomationWorktreeSupported(workspaceRoot, input.action ?? current.action);
      return await services.scheduler.updateAutomation(automationId, input);
    }

    async function assertAutomationWorktreeSupported(
      workspaceRoot: string,
      action: Automation["action"],
    ): Promise<void> {
      if (action.kind !== "start_session" || action.location !== "worktree") return;
      await new WorktreeService({ canonicalRoot: workspaceRoot }).list();
    }

    async function startAutomationScheduler(workspaceRoot: string): Promise<void> {
      await (await getAutomationRuntimeServices(workspaceRoot)).scheduler.start();
    }

    async function startAutomationSchedulers(): Promise<void> {
      automationSchedulersStarted = true;
      for (const project of await projectRegistry.list()) {
        await startAutomationScheduler(project.workspaceRoot);
      }
    }

    async function reconcileRegisteredProject(workspaceRoot: string, projectSlug: string): Promise<void> {
      const key = `${workspaceRoot}\0${projectSlug}`;
      const registered = await projectRegistry.get(projectSlug);
      if (registered?.workspaceRoot !== workspaceRoot) {
        projectReconcileRetries.delete(key);
        return;
      }
      cancelledReconcileWorkspaces.delete(workspaceRoot);
      if (goalStateReconciliationShuttingDown || projectReconcileInFlight.has(key) || projectReconcileRetries.get(key)?.timer !== undefined) return;
      projectReconcileInFlight.add(key);
      try {
        projectSlugsByWorkspace.set(workspaceRoot, projectSlug);
        await (await contextResolver.resolve(workspaceRoot)).goalLifecycle.reconcile();
        await continuationService.reconcileWorkspace(workspaceRoot);
        projectReconcileRetries.delete(key);
      } catch (error) {
        if (goalStateReconciliationShuttingDown || cancelledReconcileWorkspaces.has(workspaceRoot)) {
          projectReconcileRetries.delete(key);
          return;
        }
        const attempt = (projectReconcileRetries.get(key)?.attempt ?? 0) + 1;
        const delay = Math.min(100 * 2 ** (attempt - 1), 30_000);
        const retry: { attempt: number; timer?: ReturnType<typeof setTimeout> } = { attempt };
        retry.timer = setTimeout(() => {
          retry.timer = undefined;
          if (goalStateReconciliationShuttingDown || cancelledReconcileWorkspaces.has(workspaceRoot)) {
            projectReconcileRetries.delete(key);
            return;
          }
          void reconcileRegisteredProject(workspaceRoot, projectSlug);
        }, delay);
        retry.timer.unref?.();
        projectReconcileRetries.set(key, retry);
        runtimeLogger.warn("project.runtime.reconcile_failed", {
          error,
          context: { projectSlug },
          meta: { workspaceRoot, attempt, retryDelayMs: delay },
        });
      } finally {
        projectReconcileInFlight.delete(key);
      }
    }

    async function stopAutomationSchedulers(): Promise<void> {
      automationSchedulersStarted = false;
      const services = await Promise.allSettled([...automationRuntimeServices.values()]);
      for (const result of services) {
        if (result.status === "fulfilled") result.value.scheduler.dispose();
      }
      automationRuntimeServices.clear();
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

        const automationServices = automationRuntimeServices.get(project.workspaceRoot);
        if (automationServices !== undefined) (await automationServices).scheduler.dispose();

        const removed = await projectRegistry.remove(project.slug);
        if (removed === undefined) return undefined;
        cancelWorkspaceReconciliation(project.workspaceRoot);
        const projectRetryKey = `${project.workspaceRoot}\0${project.slug}`;
        const projectRetry = projectReconcileRetries.get(projectRetryKey);
        if (projectRetry?.timer !== undefined) clearTimeout(projectRetry.timer);
        projectReconcileRetries.delete(projectRetryKey);
        projectSlugsByWorkspace.delete(project.workspaceRoot);
        automationRuntimeServices.delete(project.workspaceRoot);
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

    const startupProjects = await projectRegistry.list();
    const startupContinuationResults = await Promise.allSettled(
      startupProjects.map(async (project) => {
        await (await contextResolver.resolve(project.workspaceRoot)).goalLifecycle.reconcile();
        await continuationService.reconcileWorkspace(project.workspaceRoot);
      }),
    );
    startupContinuationResults.forEach((result, index) => {
      if (result.status === "rejected") runtimeLogger.warn("goal.continuation.startup.failed", {
        error: result.reason,
        context: { projectSlug: startupProjects[index]?.slug },
      });
    });

    return {
      mcpManager,
      toolRegistry,
      providerRegistry,
      skillService,
      warnings,
      configService,
      projectRegistry,
      contextResolver,
      listAgentDescriptors: () => defaultAgentDefinitions.map(({ name, displayName }) => ({ name, displayName })),
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
        const goal = await service.cancel(goalId, request);
        await notifyGoalStateChanged(workspaceRoot, goalId);
        return goal;
      },
      subscribeMcpStatusChanges: (listener) => mcpManager.onStatusChange(listener),
      getMcpServerStatuses: () => mcpManager.getStatus(),
      createSession: (workspaceRoot, createOptions) => {
        executionManager.assertWorkspaceOpen(workspaceRoot);
        assertRuntimeSessionAgentScope(createOptions);
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
      setAutomationSessionMessageExecutor: (executor) => {
        automationSessionMessageExecutor = executor;
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
      abortAllSessionExecutions: () => {
        continuationService.shutdown();
        shutdownGoalStateReconciliation();
        return executionManager.abortAll();
      },
      getSessionExecution: (workspaceRoot, sessionId) => executionManager.getExecution(workspaceRoot, sessionId),
      subscribeSessionEvents: (input) => executionManager.subscribe(input),
      deleteSession: (workspaceRoot, sessionId) => executionManager.deleteSession(workspaceRoot, sessionId),
      listSessionTree: (workspaceRoot, rootSessionId) => sessionStoreManager.buildSessionTree(workspaceRoot, rootSessionId),
      disposeSessionAgent: (workspaceRoot, sessionId) => sessionAgentManager.dispose(workspaceRoot, sessionId),
      disposeAllSessionAgents: () => sessionAgentManager.disposeAll(),
      isSessionTombstoned: (workspaceRoot, sessionId) => sessionAgentManager.isTombstoned(workspaceRoot, sessionId),
      dispatchCommand,
      listAutomations,
      readAutomation,
      createAutomation,
      updateAutomation,
      deleteAutomation: async (workspaceRoot, automationId) => {
        await (await getAutomationRuntimeServices(workspaceRoot)).scheduler.deleteAutomation(automationId);
      },
      pauseAutomation: async (workspaceRoot, automationId) => (
        await (await getAutomationRuntimeServices(workspaceRoot)).scheduler.pauseAutomation(automationId)
      ),
      resumeAutomation: async (workspaceRoot, automationId) => (
        await (await getAutomationRuntimeServices(workspaceRoot)).scheduler.resumeAutomation(automationId)
      ),
      runAutomationNow: async (workspaceRoot, automationId) => (
        await (await getAutomationRuntimeServices(workspaceRoot)).scheduler.runAutomationNow(automationId)
      ),
      listAutomationInvocations: async (workspaceRoot, automationId, limit) => {
        const scheduler = (await getAutomationRuntimeServices(workspaceRoot)).scheduler;
        await scheduler.readAutomation(automationId);
        return await scheduler.listAutomationInvocations(automationId, limit);
      },
      startAutomationScheduler,
      startAutomationSchedulers,
      reconcileRegisteredProject,
      stopAutomationSchedulers,
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

function goalTitleSource(goal: GoalState): string {
  return [
    "Objective:",
    goal.objective,
    "Acceptance criteria:",
    goal.acceptanceCriteria,
  ].join("\n");
}

function assertRuntimeSessionAgentScope(options: CreateRuntimeSessionOptions): void {
  if (options.goalId !== undefined) {
    if (options.agentName !== "goal_lead") {
      throw new Error(`Goal Sessions require agentName "goal_lead", got "${options.agentName}"`);
    }
    return;
  }
  if (options.agentName === "goal_lead") {
    throw new Error('Agent "goal_lead" requires a Goal-bound Session');
  }
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
