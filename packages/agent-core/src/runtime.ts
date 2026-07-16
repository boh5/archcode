import { defaultAgentDefinitions } from "./agents";
import type { AgentName } from "./agents";
import { SessionCwdTransitionConflictError, SessionCwdTransitionInProgressError } from "./agents/errors";
import { resolveAgentModel } from "./agents/model-resolver";
import { SessionAgentManager } from "./agents/session-agent-manager";
import { BackgroundTaskManager } from "./background/manager";
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
  GlobalSessionEventEnvelope,
  GlobalSSESessionRuntimeChangedEvent,
  GlobalSSESessionRuntimeSnapshotEvent,
  HitlResponse,
  HitlView,
  McpServerStatus,
  SessionFamilyActivity,
  SessionTreeResponse,
} from "@archcode/protocol";
import { createRegistry as createToolRegistry, DuplicateToolError, type ToolRegistry } from "./tools/index";
import {
  applySessionToolBatchResponse,
  cancelSessionToolBatch,
  hasRunnableSessionToolBatch,
  validateSessionToolBatchResponse,
  SessionExecutionManager,
  SessionExecutionScopeValidator,
  SessionFamilyStopService,
  RoleDrivenSessionGoalDelegationAdmission,
  SessionDeleteInProgressError,
  SessionFamilyStopInProgressError,
  SessionFamilyActiveError,
} from "./execution";
import type { ActiveSessionExecution, StartSessionExecutionInput } from "./execution";
import { SessionEventBridge } from "./events";
import { GoalBudgetHandler } from "./goals/budget-handler";
import {
  GoalLeadContinuationService,
  type GoalLeadContinuationCoordinator,
  type GoalLeadContinuationOptions,
} from "./goals/goal-lead-continuation";
import { withGoalExecutionClaimLock } from "./goals/execution-claim";
import { GoalCancellationService, type GoalCancellationRequest } from "./goals/cancellation";
import { GoalLifecycleService } from "./goals/lifecycle-service";
import {
  MAX_HITL_DELIVERY_ATTEMPTS,
  HitlConflictError,
  ProjectHitlQueue,
  requiresInspection,
  toHitlView,
  type HitlRecord,
  type ProjectHitlQueueEvent,
} from "./hitl";
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
import { SessionInputService, type CommandRequestReplay, type MessageAcceptance } from "./session-input/service";
import type { SessionRole } from "./store/types";
import { generateTitle } from "./title-generation";
import type { GoalState } from "./goals/state";
import { WorktreeService } from "./worktrees";
import { ProjectTodoService, ProjectTodoStateManager } from "./todos";

type SessionToolBatchExecutionInput = Omit<StartSessionExecutionInput, "input" | "origin">;
type SessionToolBatchExecutor = (input: SessionToolBatchExecutionInput) => Promise<ActiveSessionExecution>;

export interface AcceptSessionMessageInput {
  readonly slug: string;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly text: string;
  readonly clientRequestId: string;
  readonly source: "user" | "automation";
}

export type SessionMessageAcceptance =
  | (MessageAcceptance & { readonly status: "pending" | "canonical" | "deleted" })
  | { readonly clientRequestId: string; readonly status: "command" };

export class SessionCommandConflictError extends Error {
  readonly code = "SESSION_COMMAND_CONFLICT";

  constructor(public readonly sessionId: string) {
    super(`Session "${sessionId}" commands require an idle root Session with an empty Queue and no pending HITL`);
    this.name = "SessionCommandConflictError";
  }
}

export class SessionCommandOutcomeError extends Error {
  readonly code: "SESSION_COMMAND_FAILED" | "SESSION_COMMAND_OUTCOME_INDETERMINATE";

  constructor(
    public readonly sessionId: string,
    public readonly clientRequestId: string,
    public readonly status: "failed" | "indeterminate",
    message: string,
  ) {
    super(message);
    this.name = "SessionCommandOutcomeError";
    this.code = status === "failed"
      ? "SESSION_COMMAND_FAILED"
      : "SESSION_COMMAND_OUTCOME_INDETERMINATE";
  }
}

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
  respondToHitl(input: {
    readonly slug: string;
    readonly workspaceRoot: string;
    readonly hitlId: string;
    readonly response: Exclude<HitlResponse, { type: "cancel" }>;
  }): Promise<HitlMutationResult>;
  cancelHitl(input: {
    readonly slug: string;
    readonly workspaceRoot: string;
    readonly hitlId: string;
    readonly reason: string;
    readonly cancelledBy?: string;
  }): Promise<HitlMutationResult>;
  listHitlSnapshotEvents(): Promise<GlobalSSEEvent[]>;
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
  /** Durably accepts a root Session message; execution dispatch is a separate best-effort consequence. */
  acceptSessionMessage(input: AcceptSessionMessageInput): Promise<SessionMessageAcceptance>;
  editPendingSessionMessage(input: {
    readonly workspaceRoot: string;
    readonly sessionId: string;
    readonly messageId: string;
    readonly expectedRevision: number;
    readonly text: string;
  }): ReturnType<SessionInputService["editMessage"]>;
  deletePendingSessionMessage(input: {
    readonly workspaceRoot: string;
    readonly sessionId: string;
    readonly messageId: string;
    readonly expectedRevision: number;
  }): ReturnType<SessionInputService["deleteMessage"]>;
  steerPendingSessionMessage(input: {
    readonly workspaceRoot: string;
    readonly sessionId: string;
    readonly messageId: string;
    readonly expectedRevision: number;
    readonly expectedExecutionId: string;
  }): ReturnType<SessionExecutionManager["steerQueuedMessage"]>;
  /** Checked Goal retry entry point; acquires the Goal claim before the private live execution claim. */
  startGoalSessionExecution(input: StartSessionExecutionInput): Promise<ActiveSessionExecution>;
  getSessionFamilyActivity(workspaceRoot: string, rootSessionId: string): SessionFamilyActivity;
  stopSessionFamily(workspaceRoot: string, rootSessionId: string): Promise<void>;
  abortAllSessionExecutions(): Promise<void>;
  getSessionExecution(workspaceRoot: string, sessionId: string): ActiveSessionExecution | undefined;
  subscribeSessionEvents(listener: (event: GlobalSessionEventEnvelope) => void): () => void;
  deleteSession(workspaceRoot: string, sessionId: string): Promise<void>;
  listSessionTree(workspaceRoot: string, rootSessionId: string): Promise<SessionTreeResponse>;
  disposeSessionAgent(workspaceRoot: string, sessionId: string): void;
  disposeAllSessionAgents(): void;
  isSessionTombstoned(workspaceRoot: string, sessionId: string): boolean;
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
  /** Recovers durable Goal, HITL, and Session continuations through the managed Session executor. */
  recoverSessionContinuations(): Promise<void>;
  /** Recovers durable Project Todo checkpoints after the managed Session executor is installed. */
  recoverProjectTodos(): Promise<void>;
  reconcileRegisteredProject(workspaceRoot: string, projectSlug: string): Promise<void>;
  stopAutomationSchedulers(): Promise<void>;
  notifyRuntimeShutdown(reason: string): void;
}

export interface HitlMutationResult {
  readonly hitlId: string;
  readonly status: import("@archcode/protocol").HitlStatus;
  readonly view: HitlView;
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
    const sessionInputService = new SessionInputService(sessionStoreManager);
    const sessionEventBridge = new SessionEventBridge({
      source: sessionStoreManager,
      resolveProjectSlug: (workspaceRoot) => projectSlugsByWorkspace.get(workspaceRoot),
    });
    const hitlListeners = new Set<(event: GlobalSSEHitlRealtimeEvent) => void>();
    const sessionRuntimeListeners = new Set<(event: GlobalSSESessionRuntimeChangedEvent) => void>();
    const resourceChangeListeners = new Set<(event: GlobalSSEResourceChangedEvent) => void>();
    const resourceTitleTasks = new BackgroundTaskManager({ logger: runtimeLogger.child({ module: "title-generation.resources" }) });
    const goalStateReconcileRetries = new Map<string, { attempt: number; timer?: ReturnType<typeof setTimeout> }>();
    const goalStateReconcileInFlight = new Set<string>();
    const projectReconcileRetries = new Map<string, { attempt: number; timer?: ReturnType<typeof setTimeout> }>();
    const projectReconcileInFlight = new Set<string>();
    const hitlDispatches = new Map<string, Promise<HitlRecord>>();
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
    const publishProjectHitlEvent = (workspaceRoot: string, event: ProjectHitlQueueEvent): void => {
      const projectSlug = projectSlugsByWorkspace.get(workspaceRoot);
      if (projectSlug === undefined) {
        runtimeLogger.warn("hitl.event.project_missing", {
          context: { hitlId: event.view.hitlId },
          meta: { workspaceRoot },
        });
        return;
      }
      const payload = event.type === "hitl.created"
        ? { type: "hitl.request" as const }
        : event.type === "hitl.resolved" || event.type === "hitl.cancelled"
          ? { type: "hitl.resolved" as const }
          : { type: "hitl.updated" as const };
      publishHitlEvent({
        type: "hitl.event",
        projectSlug,
        hitlId: event.view.hitlId,
        createdAt: Date.now(),
        payload,
        view: event.view,
      });
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
      hitlFactory: ({ workspaceRoot }) => new ProjectHitlQueue({
        workspaceRoot,
        onEvent: (event) => publishProjectHitlEvent(workspaceRoot, event),
      }),
      goalCancellationFactory: ({ workspaceRoot, goalState }) => new GoalCancellationService({
        workspaceRoot,
        goalStateManager: goalState,
        sessionStoreManager,
        sessionFamilyController: {
          acquireStop: (input) => executionManager.acquireSessionFamilyStop(input),
        },
        cancelSessionToolBatch: (sessionId, projectRoot, reason) => (
          cancelSessionBatchAndHitl(sessionId, projectRoot, reason)
        ),
        cancelGoalBudgetHitl: (hitlId, reason) => cancelGoalBudgetHitl(workspaceRoot, hitlId, reason),
      }),
      goalCommitted: ({ workspaceRoot, project, goal }) => {
        publishResourceChanged({
          type: "resource.changed",
          projectSlug: project.slug,
          resourceType: "goal",
          resourceId: goal.id,
          createdAt: Date.now(),
        });
        void contextResolver.resolve(workspaceRoot)
          .then((context) => context.todos.handleResourceCreated({
            kind: "goal",
            sourceSessionId: goal.createdFromSessionId,
            resourceId: goal.id,
          }))
          .catch((error: unknown) => {
            runtimeLogger.warn("todos.goal_resource_binding.failed", {
              error,
              context: { todoSourceSessionId: goal.createdFromSessionId, goalId: goal.id },
              meta: { workspaceRoot },
            });
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
          startGoalExecutionWithinClaim(input)
        ),
        onCreated: (goal) => queueGoalTitleGeneration(workspaceRoot, goal.id),
      }),
      projectTodoFactory: ({ workspaceRoot, project, goalState }) => new ProjectTodoService({
        workspaceRoot,
        projectSlug: project.slug,
        state: new ProjectTodoStateManager(workspaceRoot, {
          logger: runtimeLogger.child({ module: "todos.state" }),
          onCommitted: (todo) => {
            publishResourceChanged({
              type: "resource.changed",
              projectSlug: project.slug,
              resourceType: "todo",
              resourceId: todo.id,
              createdAt: Date.now(),
            });
          },
        }),
        sessions: {
          ensureRootSession: async (input) => {
            await sessionStoreManager.ensureSessionFile(input.workspaceRoot, input.sessionId, {
              agentName: input.agentName,
              title: input.title,
              rootSessionId: input.sessionId,
              sessionRole: "standalone",
              cwd: input.workspaceRoot,
            });
          },
          ensureExecution: async (input) => {
            const active = executionManager.getExecution(input.workspaceRoot, input.sessionId);
            if (active?.executionId === input.executionId) return;
            const session = await sessionStoreManager.getSessionFile(input.workspaceRoot, input.sessionId);
            if (session.executions.some((execution) => execution.id === input.executionId)) return;
            const execution = await startCheckedSessionExecution({
              slug: project.slug,
              workspaceRoot: input.workspaceRoot,
              sessionId: input.sessionId,
              input: { kind: "direct", text: input.userMessage },
              executionId: input.executionId,
            });
            void execution.promise.catch((error: unknown) => {
              runtimeLogger.warn("todos.session_execution.failed", {
                error,
                context: { sessionId: input.sessionId, executionId: input.executionId },
                meta: { workspaceRoot: input.workspaceRoot },
              });
            });
          },
          acquireIdleFamily: async (input) => {
            if (executionManager.getSessionFamilyActivity(input.workspaceRoot, input.rootSessionId) !== "idle") {
              return undefined;
            }
            try {
              const release = executionManager.acquireIdleSessionCwdTransition(
                input.workspaceRoot,
                input.rootSessionId,
              );
              return { release };
            } catch (error) {
              if (
                error instanceof SessionCwdTransitionConflictError
                || error instanceof SessionCwdTransitionInProgressError
                || error instanceof SessionDeleteInProgressError
                || error instanceof SessionFamilyStopInProgressError
              ) return undefined;
              throw error;
            }
          },
        },
        provenance: {
          listResources: async ({ kind, sourceSessionId }) => {
            if (kind === "goal") {
              return (await goalState.listGoals(project.slug))
                .filter((goal) => goal.createdFromSessionId === sourceSessionId)
                .map((goal) => ({
                  kind: "goal" as const,
                  id: goal.id,
                  createdFromSessionId: goal.createdFromSessionId,
                  createdAt: goal.createdAt,
                  status: goal.status,
                }));
            }
            return (await listAutomations(workspaceRoot))
              .filter((automation) => automation.createdFromSessionId === sourceSessionId)
              .map((automation) => ({
                kind: "automation" as const,
                id: automation.id,
                createdFromSessionId: automation.createdFromSessionId,
                createdAt: automation.createdAt,
                status: automation.status,
              }));
          },
        },
      }),
      createAutomation: (workspaceRoot, input) => createAutomation(workspaceRoot, input),
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
      resolveSessionDepth: (workspaceRoot, sessionId) => sessionStoreManager.resolveSessionDepth(workspaceRoot, sessionId),
      buildSessionTree: (workspaceRoot, rootSessionId) => sessionStoreManager.buildSessionTree(workspaceRoot, rootSessionId),
      listSessionFamilyToolBatchHitlIds: (workspaceRoot, rootSessionId) => (
        sessionStoreManager.listSessionFamilyToolBatchHitlIds(workspaceRoot, rootSessionId)
      ),
      sessionInputService,
      trackSession,
      untrackSession,
      executionScopeValidator,
      executionClaimCoordinator: {
        run: (ownerId, action) => withGoalExecutionClaimLock(ownerId, action),
      },
      goalDelegationAdmission: new RoleDrivenSessionGoalDelegationAdmission(contextResolver),
      deletionLifecycle: new SessionLifecycleService({
        storeManager: sessionStoreManager,
        cancelSessionToolBatch: (sessionId, workspaceRoot, reason) => (
          cancelSessionBatchAndHitl(sessionId, workspaceRoot, reason)
        ),
        findProjectTodoOwners: async (input) => {
          const context = await contextResolver.resolve(input.workspaceRoot);
          return await context.todos.findSessionOwners(input.sessionIds);
        },
      }),
      logger,
    });
    const continuationOptions: GoalLeadContinuationOptions = {
      projectContextResolver: contextResolver,
      sessionRuntime: {
        getSessionFile: (workspaceRoot, sessionId) => sessionStoreManager.getSessionFile(workspaceRoot, sessionId),
        getSessionFamilyActivity: (workspaceRoot, rootSessionId) => executionManager.getSessionFamilyActivity(workspaceRoot, rootSessionId),
        listSessionFamilyToolBatchHitlIds: (workspaceRoot, rootSessionId) => (
          sessionStoreManager.listSessionFamilyToolBatchHitlIds(workspaceRoot, rootSessionId)
        ),
        startCheckedExecutionWithinGoalClaim: (input) => startGoalExecutionWithinClaim(input),
      },
      logger: runtimeLogger.child({ module: "goals.continuation" }),
    };
    const continuationService = options.goalLeadContinuationFactory?.(continuationOptions)
      ?? new GoalLeadContinuationService(continuationOptions);
    goalLeadContinuation = continuationService;

    const startCheckedSessionExecution = (
      input: StartSessionExecutionInput,
    ): Promise<ActiveSessionExecution> => executionManager.startCheckedExecution(input);
    const sessionToolBatchExecutor: SessionToolBatchExecutor = (input) => (
      executionManager.startSessionToolBatchExecution(input)
    );
    const startGoalExecutionWithinClaim = (
      input: StartSessionExecutionInput,
    ): Promise<ActiveSessionExecution> => executionManager.startCheckedExecutionWithinGoalClaim({
      ...input,
      origin: "goal_claim",
    });

    async function dispatchAnsweredHitl(
      workspaceRoot: string,
      projectSlug: string,
      accepted: HitlRecord,
    ): Promise<HitlRecord> {
      if (accepted.status !== "answered") return accepted;
      if (accepted.response === undefined) throw new Error(`Answered HITL ${accepted.hitlId} has no response`);
      const dispatchKey = scopedKey(workspaceRoot, accepted.hitlId);
      const existing = hitlDispatches.get(dispatchKey);
      if (existing !== undefined) return await existing;
      const pending = deliverAnsweredHitl(workspaceRoot, projectSlug, accepted);
      hitlDispatches.set(dispatchKey, pending);
      try {
        return await pending;
      } finally {
        if (hitlDispatches.get(dispatchKey) === pending) hitlDispatches.delete(dispatchKey);
      }
    }

    async function deliverAnsweredHitl(
      workspaceRoot: string,
      projectSlug: string,
      accepted: HitlRecord,
    ): Promise<HitlRecord> {
      const context = await contextResolver.resolve(workspaceRoot);
      let current = accepted;

      while ((current.delivery?.attempts ?? 0) < MAX_HITL_DELIVERY_ATTEMPTS) {
        const dispatching = await context.hitl.resolve(current.hitlId, { type: "dispatching" });
        try {
          switch (dispatching.owner.type) {
            case "session":
              await applySessionToolBatchResponse({
                storeManager: sessionStoreManager,
                workspaceRoot,
                sessionId: dispatching.owner.id,
                hitlId: dispatching.hitlId,
                requestKey: dispatching.requestKey,
                response: dispatching.response!,
              });
              break;
            case "goal":
              await new GoalBudgetHandler({ goalStateManager: context.goalState }).apply(dispatching);
              break;
          }

          const applied = await context.hitl.resolve(dispatching.hitlId, { type: "applied" });
          if (applied.owner.type === "session") {
            void sessionToolBatchExecutor({
              slug: projectSlug,
              workspaceRoot,
              sessionId: applied.owner.id,
            }).catch((error) => {
              runtimeLogger.warn("session.tool_batch.wake_failed", {
                error,
                context: { projectSlug, sessionId: applied.owner.id, hitlId: applied.hitlId },
              });
            });
          } else {
            void notifyGoalStateChanged(workspaceRoot, applied.owner.id);
          }
          return applied;
        } catch (error) {
          const attempts = dispatching.delivery?.attempts ?? 0;
          current = await context.hitl.resolve(dispatching.hitlId, {
            type: "delivery_failed",
            error: errorMessage(error),
            ...(attempts < MAX_HITL_DELIVERY_ATTEMPTS
              ? { retryAt: new Date().toISOString() }
              : {}),
          });
          runtimeLogger.warn("hitl.delivery.failed", {
            error,
            context: { projectSlug, hitlId: dispatching.hitlId, ownerType: dispatching.owner.type },
            meta: { attempts },
          });
        }
      }
      return current;
    }

    async function respondToHitl(input: {
      readonly slug: string;
      readonly workspaceRoot: string;
      readonly hitlId: string;
      readonly response: Exclude<HitlResponse, { type: "cancel" }>;
    }): Promise<HitlMutationResult> {
      const context = await contextResolver.resolve(input.workspaceRoot);
      if (context.project.slug !== input.slug) throw new Error(`HITL project scope mismatch: ${input.slug}`);
      const pending = (await context.hitl.list({ statuses: ["pending"] }))
        .find((record) => record.hitlId === input.hitlId);
      if (
        pending?.owner.type === "session"
        && pending.source.type === "ask_user"
        && input.response.type === "question_answer"
      ) {
        try {
          await validateSessionToolBatchResponse({
            storeManager: sessionStoreManager,
            workspaceRoot: input.workspaceRoot,
            sessionId: pending.owner.id,
            hitlId: pending.hitlId,
            requestKey: pending.requestKey,
            response: input.response,
          });
        } catch (error) {
          throw new HitlConflictError(input.hitlId, errorMessage(error));
        }
      }
      const accepted = await context.hitl.respond(input.hitlId, input.response);
      const record = await dispatchAnsweredHitl(
        input.workspaceRoot,
        input.slug,
        accepted,
      );
      return { hitlId: record.hitlId, status: record.status, view: toHitlView(record) };
    }

    async function cancelHitl(input: {
      readonly slug: string;
      readonly workspaceRoot: string;
      readonly hitlId: string;
      readonly reason: string;
      readonly cancelledBy?: string;
    }): Promise<HitlMutationResult> {
      const context = await contextResolver.resolve(input.workspaceRoot);
      if (context.project.slug !== input.slug) throw new Error(`HITL project scope mismatch: ${input.slug}`);
      const accepted = await context.hitl.cancel(input.hitlId, {
        type: "cancel",
        reason: input.reason,
        ...(input.cancelledBy === undefined ? {} : { cancelledBy: input.cancelledBy }),
      });
      const record = await dispatchAnsweredHitl(
        input.workspaceRoot,
        input.slug,
        accepted,
      );
      return { hitlId: record.hitlId, status: record.status, view: toHitlView(record) };
    }

    async function cancelSessionBatchAndHitl(
      sessionId: string,
      workspaceRoot: string,
      reason: string,
    ): Promise<void> {
      const context = await contextResolver.resolve(workspaceRoot);
      const projectSlug = context.project.slug;
      const cancelled = await cancelSessionToolBatch({
        storeManager: sessionStoreManager,
        hitlQueue: context.hitl,
        prepareHitlCancellation: async (hitlIds) => {
          const records = (await context.hitl.list({ owner: { type: "session", id: sessionId } }))
            .filter((record) => hitlIds.includes(record.hitlId));
          for (const record of records) {
            if (record.status === "resolved" || record.status === "cancelled") continue;
            if (record.status === "answered") {
              const applied = await dispatchAnsweredHitl(
                workspaceRoot,
                projectSlug,
                record,
              );
              if (applied.status === "answered") throw new Error(`Cannot apply answered HITL ${record.hitlId} before Session cancellation`);
              continue;
            }
            const accepted = await context.hitl.cancel(record.hitlId, { type: "cancel", reason });
            await context.hitl.resolve(accepted.hitlId, { type: "dispatching" });
          }
        },
        sessionId,
        workspaceRoot,
        reason,
      });
      if (cancelled.hitlIds.length === 0) return;
      const referenced = (await context.hitl.list({ owner: { type: "session", id: sessionId } }))
        .filter((record) => cancelled.hitlIds.includes(record.hitlId));
      for (const record of referenced) {
        if (record.status === "resolved" || record.status === "cancelled") continue;
        if (record.status !== "answered" || record.response?.type !== "cancel") {
          throw new Error(`Session cancellation left HITL ${record.hitlId} in ${record.status}`);
        }
        await context.hitl.resolve(record.hitlId, { type: "applied" });
      }
    }

    async function cancelGoalBudgetHitl(
      workspaceRoot: string,
      hitlId: string,
      reason: string,
    ): Promise<void> {
      const context = await contextResolver.resolve(workspaceRoot);
      const record = (await context.hitl.list()).find((candidate) => candidate.hitlId === hitlId);
      if (record === undefined) throw new Error(`Goal budget HITL ${hitlId} was not found`);
      if (record.status === "resolved" || record.status === "cancelled") return;
      const accepted = record.status === "pending"
        ? await context.hitl.cancel(hitlId, { type: "cancel", reason })
        : record;
      await dispatchAnsweredHitl(
        workspaceRoot,
        context.project.slug,
        accepted,
      );
    }

    async function reconcileAnsweredHitl(
      workspaceRoot: string,
      projectSlug: string,
    ): Promise<void> {
      const context = await contextResolver.resolve(workspaceRoot);
      for (const record of await context.hitl.list({ statuses: ["answered"] })) {
        if (record.delivery?.error !== undefined && record.delivery.retryAt === undefined) continue;
        try {
          await dispatchAnsweredHitl(workspaceRoot, projectSlug, record);
        } catch (error) {
          runtimeLogger.warn("hitl.delivery.reconcile_failed", {
            error,
            context: { projectSlug, hitlId: record.hitlId, ownerType: record.owner.type },
          });
        }
      }
    }

    async function continueRunnableToolBatches(
      workspaceRoot: string,
      projectSlug: string,
    ): Promise<void> {
      const summaries = await sessionStoreManager.listAllSessionSummaries(workspaceRoot);
      for (const summary of summaries) {
        const store = await sessionStoreManager.getOrLoad(summary.sessionId, workspaceRoot);
        if (!hasRunnableSessionToolBatch(store.getState())) continue;
        if (executionManager.getSessionFamilyActivity(workspaceRoot, summary.rootSessionId) !== "idle") continue;
        try {
          await sessionToolBatchExecutor({
            slug: projectSlug,
            workspaceRoot,
            sessionId: summary.sessionId,
          });
        } catch (error) {
          runtimeLogger.warn("session.tool_batch.reconcile_failed", {
            error,
            context: { projectSlug, sessionId: summary.sessionId },
          });
        }
      }
    }

    async function acceptSessionMessage(input: AcceptSessionMessageInput): Promise<SessionMessageAcceptance> {
      return await executionManager.runSessionInputMutation({
        workspaceRoot: input.workspaceRoot,
        rootSessionId: input.sessionId,
      }, async () => {
        projectSlugsByWorkspace.set(input.workspaceRoot, input.slug);
        const store = await sessionStoreManager.getOrLoad(input.sessionId, input.workspaceRoot);
        const state = store.getState();
        if (state.parentSessionId !== undefined || state.rootSessionId !== input.sessionId) {
          throw new NotRootSessionError(input.sessionId, state.parentSessionId ?? state.rootSessionId);
        }
        const triggerQueuedExecution = () => {
          void executionManager.tryStartQueuedExecution({
            slug: input.slug,
            workspaceRoot: input.workspaceRoot,
            sessionId: input.sessionId,
          }).catch((error) => {
            runtimeLogger.warn("session.queue.start_failed", {
              error,
              context: { projectSlug: input.slug, sessionId: input.sessionId },
              meta: { workspaceRoot: input.workspaceRoot },
            });
          });
        };

        let accepted: MessageAcceptance | undefined;
        if (input.source === "user") {
          const agent = await sessionAgentManager.getOrCreate(input.workspaceRoot, input.sessionId);
          const command = agent.classifyCommand(input.text);
          if (command !== null) {
            const replayInput = {
              sessionId: input.sessionId,
              workspaceRoot: input.workspaceRoot,
              text: input.text,
              clientRequestId: input.clientRequestId,
              source: input.source,
            } as const;
            const settledAcceptance = (replay: CommandRequestReplay | undefined): SessionMessageAcceptance => {
              if (replay === undefined || (replay.kind === "command" && replay.status === "executing")) {
                throw new SessionCommandOutcomeError(
                  input.sessionId,
                  input.clientRequestId,
                  "indeterminate",
                  "Command outcome is unknown and cannot be replayed safely",
                );
              }
              if (replay.kind === "message") return replay.acceptance;
              if (replay.kind === "error") {
                throw new SessionCommandOutcomeError(
                  input.sessionId,
                  replay.clientRequestId,
                  replay.status,
                  replay.error,
                );
              }
              return { clientRequestId: replay.clientRequestId, status: "command" as const };
            };
            const existingReplay = await sessionInputService.getCommandReplay(replayInput);
            if (existingReplay !== undefined
              && !(existingReplay.kind === "command" && existingReplay.status === "executing")) {
              const replayAcceptance = settledAcceptance(existingReplay);
              if (replayAcceptance.status === "command") {
                triggerQueuedExecution();
                return replayAcceptance;
              }
              accepted = replayAcceptance;
            } else {
              let commandRun;
              try {
                commandRun = await executionManager.runSessionCommand({
                  workspaceRoot: input.workspaceRoot,
                  sessionId: input.sessionId,
                  clientRequestId: input.clientRequestId,
                }, async (signal): Promise<SessionMessageAcceptance> => {
                  if ((await sessionStoreManager.listSessionFamilyToolBatchHitlIds(
                    input.workspaceRoot,
                    input.sessionId,
                  )).length > 0) {
                    throw new SessionCommandConflictError(input.sessionId);
                  }
                  const claim = await sessionInputService.claimCommand(replayInput);
                  if (claim.kind !== "claimed") return settledAcceptance(claim);
                  let result;
                  try {
                    signal.throwIfAborted();
                    result = await agent.executeCommand(command, { abort: signal });
                    signal.throwIfAborted();
                  } catch (error) {
                    await sessionInputService.failCommand({
                      sessionId: input.sessionId,
                      workspaceRoot: input.workspaceRoot,
                      clientRequestId: input.clientRequestId,
                      error: "Command execution failed before a durable result was recorded",
                    });
                    throw error;
                  }
                  if (result.kind === "handled") {
                    await sessionInputService.completeCommand({
                      sessionId: input.sessionId,
                      workspaceRoot: input.workspaceRoot,
                      clientRequestId: input.clientRequestId,
                    });
                    return { clientRequestId: input.clientRequestId, status: "command" };
                  }
                  return await sessionInputService.completeCommandAsMessage({
                    sessionId: input.sessionId,
                    workspaceRoot: input.workspaceRoot,
                    clientRequestId: input.clientRequestId,
                    text: result.content,
                    source: input.source,
                  });
                });
              } catch (error) {
                if (error instanceof SessionFamilyActiveError
                  || error instanceof SessionFamilyStopInProgressError
                  || error instanceof SessionDeleteInProgressError) {
                  throw new SessionCommandConflictError(input.sessionId);
                }
                throw error;
              }
              const joinedReplay = commandRun.kind === "joined"
                ? await sessionInputService.getCommandReplay(replayInput)
                : undefined;
              if (commandRun.kind === "joined" && joinedReplay === undefined && commandRun.error !== undefined) {
                throw commandRun.error;
              }
              const commandAcceptance = commandRun.kind === "joined"
                ? settledAcceptance(joinedReplay)
                : commandRun.result;
              if (commandAcceptance.status === "command") {
                triggerQueuedExecution();
                return commandAcceptance;
              }
              accepted = commandAcceptance;
            }
          }
        }

        accepted ??= await sessionInputService.acceptMessage({
          sessionId: input.sessionId,
          workspaceRoot: input.workspaceRoot,
          text: input.text,
          clientRequestId: input.clientRequestId,
          source: input.source,
        });
        triggerQueuedExecution();
        return accepted;
      });
    }

    const sessionFamilyStopService = new SessionFamilyStopService({
      sessionFamilyController: {
        acquireStop: (input) => executionManager.acquireSessionFamilyStop(input),
      },
      sessionStoreManager,
      cancelSessionToolBatch: (sessionId, workspaceRoot, reason) => (
        cancelSessionBatchAndHitl(sessionId, workspaceRoot, reason)
      ),
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
        ...(change.steerTargetExecutionId === undefined ? {} : {
          steerTargetExecutionId: change.steerTargetExecutionId,
        }),
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
        void continueRunnableToolBatches(
          change.workspaceRoot,
          projectSlug,
        )
          .then(async () => {
            if (executionManager.getSessionFamilyActivity(change.workspaceRoot, change.rootSessionId) !== "idle") return;
            const queued = await executionManager.tryStartQueuedExecution({
              slug: projectSlug,
              workspaceRoot: change.workspaceRoot,
              sessionId: change.rootSessionId,
            });
            if (queued !== undefined) return;
            if (executionManager.getSessionFamilyActivity(change.workspaceRoot, change.rootSessionId) !== "idle") return;
            await continuationService.onFamilyIdle(change.workspaceRoot, change.rootSessionId);
          })
          .catch((error) => {
            runtimeLogger.warn("session.idle.reconcile_failed", {
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
          acceptSessionMessage: async (input) => {
            const accepted = await acceptSessionMessage(input);
            if (accepted.status === "command") {
              throw new Error("Automation messages cannot execute Session commands");
            }
            return {
              clientRequestId: accepted.clientRequestId,
              messageId: accepted.messageId,
            };
          },
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
      const automation = await (await getAutomationRuntimeServices(workspaceRoot)).scheduler.createAutomation({
        ...input,
        projectSlug: project.slug,
      });
      try {
        const context = await contextResolver.resolve(workspaceRoot);
        await context.todos.handleResourceCreated({
          kind: "automation",
          sourceSessionId: automation.createdFromSessionId,
          resourceId: automation.id,
        });
      } catch (error) {
        // Automation is already committed. Binding remains recoverable from
        // createdFromSessionId and must never turn a retry into a duplicate.
        runtimeLogger.warn("todos.automation_resource_binding.failed", {
          error,
          context: { todoSourceSessionId: automation.createdFromSessionId, automationId: automation.id },
          meta: { workspaceRoot },
        });
      }
      return automation;
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

    async function recoverQueuedSessionInputs(workspaceRoot: string, projectSlug: string): Promise<void> {
      const summaries = await sessionStoreManager.listAllSessionSummaries(workspaceRoot);
      for (const summary of summaries) {
        if (summary.sessionId !== summary.rootSessionId) continue;
        await sessionInputService.recoverOrphanedSteers(summary.sessionId, workspaceRoot);
        if (executionManager.getSessionFamilyActivity(workspaceRoot, summary.sessionId) !== "idle") continue;
        await executionManager.tryStartQueuedExecution({
          slug: projectSlug,
          workspaceRoot,
          sessionId: summary.sessionId,
        });
      }
    }

    async function recoverSessionContinuations(): Promise<void> {
      const projects = await projectRegistry.list();
      const results = await Promise.allSettled(
        projects.map(async (project) => {
          projectSlugsByWorkspace.set(project.workspaceRoot, project.slug);
          const context = await contextResolver.resolve(project.workspaceRoot);
          await reconcileAnsweredHitl(project.workspaceRoot, project.slug);
          await continueRunnableToolBatches(project.workspaceRoot, project.slug);
          await recoverQueuedSessionInputs(project.workspaceRoot, project.slug);
          await context.goalLifecycle.reconcile();
          await continuationService.reconcileWorkspace(project.workspaceRoot);
        }),
      );
      results.forEach((result, index) => {
        if (result.status === "rejected") runtimeLogger.warn("project.continuation.startup.failed", {
          error: result.reason,
          context: { projectSlug: projects[index]?.slug },
        });
      });
    }

    async function recoverProjectTodos(): Promise<void> {
      for (const project of await projectRegistry.list()) {
        projectSlugsByWorkspace.set(project.workspaceRoot, project.slug);
        const context = await contextResolver.resolve(project.workspaceRoot);
        await context.todos.reconcileAll();
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
        const context = await contextResolver.resolve(workspaceRoot);
        await context.todos.reconcileAll();
        await reconcileAnsweredHitl(workspaceRoot, projectSlug);
        await continueRunnableToolBatches(workspaceRoot, projectSlug);
        await recoverQueuedSessionInputs(workspaceRoot, projectSlug);
        await context.goalLifecycle.reconcile();
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
      const views = (await context.hitl.list({ statuses: ["pending", "answered"] }))
        .filter((record) => record.status === "pending" || requiresInspection(record))
        .map(toHitlView);
      const families = executionManager.listSessionFamilyActivities().flatMap((family) => (
        family.workspaceRoot === workspaceRoot
          ? [{
            projectSlug,
            rootSessionId: family.rootSessionId,
            activity: family.activity,
            ...(family.steerTargetExecutionId === undefined ? {} : {
              steerTargetExecutionId: family.steerTargetExecutionId,
            }),
          }]
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
          entries: views.map((view) => ({ projectSlug, view })),
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
        for (const pending of executionManager.listPendingSessionInputMutations(project.workspaceRoot)) {
          if (activeIds.has(pending.rootSessionId)) continue;
          activeIds.add(pending.rootSessionId);
          activeFamilies.push({ rootSessionId: pending.rootSessionId, activity: "running" });
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
              entries: [],
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
      configService,
      projectRegistry,
      contextResolver,
      listAgentDescriptors: () => defaultAgentDefinitions.map(({ name, displayName }) => ({ name, displayName })),
      removeProject,
      respondToHitl,
      cancelHitl,
      listHitlSnapshotEvents: async () => {
        const projects = await projectRegistry.list();
        const entries: Array<{ projectSlug: string; view: HitlView }> = [];
        for (const project of projects) {
          const context = await contextResolver.resolve(project.workspaceRoot);
          const views = (await context.hitl.list({ statuses: ["pending", "answered"] }))
            .filter((record) => record.status === "pending" || requiresInspection(record))
            .map(toHitlView);
          entries.push(...views.map((view) => ({ projectSlug: project.slug, view })));
        }
        return [{
          type: "hitl.snapshot",
          projectSlugs: projects.map((project) => project.slug),
          entries,
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
            ...(family.steerTargetExecutionId === undefined ? {} : {
              steerTargetExecutionId: family.steerTargetExecutionId,
            }),
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
      getSessionFile: async (workspaceRoot, sessionId) => {
        await sessionStoreManager.flushSession(sessionId, workspaceRoot);
        return await sessionStoreManager.getSessionFile(workspaceRoot, sessionId);
      },
      resolveCompressionOriginalRange: (workspaceRoot, sessionId, blockRef) => sessionStoreManager.resolveCompressionOriginalRange(workspaceRoot, sessionId, blockRef),
      listSessions: (workspaceRoot) => sessionStoreManager.listSessionSummaries(workspaceRoot),
      acceptSessionMessage,
      editPendingSessionMessage: (input) => executionManager.runSessionInputMutation({
        workspaceRoot: input.workspaceRoot,
        rootSessionId: input.sessionId,
      }, () => sessionInputService.editMessage(input)),
      deletePendingSessionMessage: (input) => executionManager.runSessionInputMutation({
        workspaceRoot: input.workspaceRoot,
        rootSessionId: input.sessionId,
      }, () => sessionInputService.deleteMessage(input)),
      steerPendingSessionMessage: (input) => executionManager.steerQueuedMessage(input),
      startGoalSessionExecution: (input) => {
        projectSlugsByWorkspace.set(input.workspaceRoot, input.slug);
        if (input.origin !== undefined && input.origin !== "goal_claim") {
          throw new Error("Goal Session execution accepts only the goal_claim origin");
        }
        return startCheckedSessionExecution({ ...input, origin: "goal_claim" });
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
      subscribeSessionEvents: (listener) => sessionEventBridge.subscribe(listener),
      deleteSession: (workspaceRoot, sessionId) => executionManager.deleteSession(workspaceRoot, sessionId),
      listSessionTree: (workspaceRoot, rootSessionId) => sessionStoreManager.buildSessionTree(workspaceRoot, rootSessionId),
      disposeSessionAgent: (workspaceRoot, sessionId) => sessionAgentManager.dispose(workspaceRoot, sessionId),
      disposeAllSessionAgents: () => sessionAgentManager.disposeAll(),
      isSessionTombstoned: (workspaceRoot, sessionId) => sessionAgentManager.isTombstoned(workspaceRoot, sessionId),
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
      recoverSessionContinuations,
      recoverProjectTodos,
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
