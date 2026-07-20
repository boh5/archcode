import { homedir } from "node:os";
import { join } from "node:path";
import { defaultAgentDefinitions } from "./agents";
import type { AgentName } from "./agents";
import { SessionCwdTransitionConflictError, SessionCwdTransitionInProgressError } from "./agents/errors";
import { SessionAgentManager } from "./agents/session-agent-manager";
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
import {
  collectRuntimeSecretLiterals,
  resolveGithubIntegrationConfig,
} from "./config";
import { registerBuiltinTools } from "./core/index";
import {
  BUILTIN_MCP_SERVERS,
  McpManager,
  type McpWarning,
} from "./mcp/index";
import { ModelSelectionResolver, type ModelRuntime } from "./models";
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
  ExecutionModelBindingSummary,
  GlobalSSEEvent,
  GlobalSSEHitlRealtimeEvent,
  GlobalSSEHitlSnapshotEvent,
  GlobalSSEModelRuntimeChangedEvent,
  GlobalSSEResourceChangedEvent,
  GlobalSessionEventEnvelope,
  GlobalSSESessionRuntimeChangedEvent,
  GlobalSSESessionRuntimeSnapshotEvent,
  HitlResponse,
  HitlView,
  McpServerStatus,
  SessionNextModelSelection,
  SessionModelState,
  RequestedModelSelection,
  SessionFamilyActivity,
  SessionTreeResponse,
} from "@archcode/protocol";
import { createRegistry as createToolRegistry, createToolExecutionContext, DuplicateToolError, type ToolRegistry } from "./tools/index";
import {
  applySessionToolBatchResponse,
  cancelSessionToolBatch,
  hasRunnableSessionToolBatch,
  validateSessionToolBatchResponse,
  SessionExecutionManager,
  SessionExecutionScopeValidator,
  SessionFamilyStopService,
  SessionDeleteInProgressError,
  SessionFamilyStopInProgressError,
  SessionFamilyActiveError,
} from "./execution";
import type { ActiveSessionExecution, StartSessionExecutionInput } from "./execution";
import { SessionEventBridge } from "./events";
import {
  MAX_HITL_DELIVERY_ATTEMPTS,
  HitlBoundaryCodec,
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
import {
  SessionModelSelectionInvalidError,
  SessionModelSelectionService,
} from "./session-input/model-selection-service";
import { WorktreeService } from "./worktrees";
import { ProjectTodoService, ProjectTodoStateManager } from "./todos";
import {
  SessionGoalCoordinator,
  SessionGoalService,
  SessionGoalServiceError,
  isBenignGoalReconcileError,
} from "./session-goal";
import {
  createScopeBoundToolOutputAccess,
  type ScopedOutputReadInput,
  type ScopedOutputSearchInput,
  type ToolOutputAccessService,
} from "./tool-output/access-service";
import { ToolOutputArtifactStore, computeProjectIdentity } from "./tool-output/artifact-store";
import { ToolOutputFinalizer } from "./tool-output/finalizer";
import { createRuntimeLogSafetyBoundary, SecretRedactionPolicy } from "./security";
import { USER_DATA_DIR_NAME } from "@archcode/protocol";

type SessionToolBatchExecutionInput = Omit<StartSessionExecutionInput, "input" | "origin">;
type SessionToolBatchExecutor = (input: SessionToolBatchExecutionInput) => Promise<ActiveSessionExecution>;

export interface AcceptSessionMessageInput {
  readonly slug: string;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly text: string;
  readonly clientRequestId: string;
  readonly source: "user" | "automation";
  readonly requestedModelSelection: RequestedModelSelection;
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
  mcpManagerFactory?: (config: ResolvedMcpConfig, redactionPolicy: SecretRedactionPolicy) => McpManager;
  /** Already-resolved process-owned secrets, such as the server password. */
  externalSecretLiterals?: readonly string[];
  projectRegistryHomeDir?: string;
  /** Internal storage location override for isolated tests. */
  toolOutputRootDir?: string;
  automationSchedulerTimer?: AutomationSchedulerTimer;
  automationSchedulerClock?: AutomationSchedulerClock;
  logger?: Logger;
}

interface AgentRuntimeInternalOptions extends AgentRuntimeOptions {
  /** Test-only seam kept out of the package contract. */
  toolOutputStoreFactory?: (rootDir: string) => ToolOutputArtifactStore;
}

export interface CreateRuntimeSessionOptions {
  readonly agentName: AgentName;
  /** Current execution directory; Session persistence remains under workspaceRoot. */
  readonly cwd?: string;
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
  readonly toolRegistry: ToolRegistry;
  readonly modelRuntime: ModelRuntime;
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
  subscribeModelRuntimeChanges(listener: (event: GlobalSSEModelRuntimeChangedEvent) => void): () => void;
  subscribeResourceChanges?(listener: (event: GlobalSSEResourceChangedEvent) => void): () => void;
  subscribeMcpStatusChanges(listener: (serverName: string, status: McpServerStatus) => void): () => void;
  getMcpServerStatuses(): Map<string, McpServerStatus>;
  createSession(workspaceRoot: string, options: CreateRuntimeSessionOptions): Promise<RuntimeSessionFile>;
  getSessionFile(workspaceRoot: string, sessionId: string): Promise<RuntimeSessionFile>;
  updateSessionGoalControl(input: {
    readonly workspaceRoot: string;
    readonly sessionId: string;
    readonly action: "edit" | "pause" | "resume" | "clear" | "budget";
    readonly objective?: string;
    readonly expectedGeneration?: number;
    readonly tokenBudget?: number;
  }): Promise<RuntimeSessionFile>;
  getSessionModelState(workspaceRoot: string, sessionId: string): Promise<SessionModelState>;
  patchSessionModelSelection(input: {
    readonly workspaceRoot: string;
    readonly sessionId: string;
    readonly expectedRevision: number;
    readonly requestedModelSelection: RequestedModelSelection;
  }): Promise<SessionModelState>;
  getToolOutputAccess(workspaceRoot: string, sessionId: string): Promise<ToolOutputAccessService>;
  readToolOutput(workspaceRoot: string, sessionId: string, input: ScopedOutputReadInput): ReturnType<ToolOutputAccessService["read"]>;
  searchToolOutputs(workspaceRoot: string, sessionId: string, input: ScopedOutputSearchInput): ReturnType<ToolOutputAccessService["search"]>;
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
  /** Recovers durable HITL and Session continuations through the managed Session executor. */
  recoverSessionContinuations(): Promise<void>;
  /** Recovers durable Project Todo checkpoints after the managed Session executor is installed. */
  recoverProjectTodos(): Promise<void>;
  reconcileRegisteredProject(workspaceRoot: string, projectSlug: string): Promise<void>;
  stopAutomationSchedulers(): Promise<void>;
  disposeToolOutputs(): Promise<void>;
  /** Closes every Runtime-owned resource through its safe internal boundaries. */
  shutdown(): Promise<void>;
  notifyRuntimeShutdown(reason: string): void;
}

export type RuntimeSessionFile = SessionFile & {
  readonly nextModelSelection: SessionNextModelSelection;
  readonly activeModelBinding?: ExecutionModelBindingSummary;
};

export interface HitlMutationResult {
  readonly hitlId: string;
  readonly status: import("@archcode/protocol").HitlStatus;
  readonly view: HitlView;
}

export async function createRuntime(
  options: AgentRuntimeOptions = {},
): Promise<AgentRuntime> {
  const internalOptions = options as AgentRuntimeInternalOptions;
  const logger = options.logger ?? createConsoleLogger({ level: "info" });
  const warnings: McpWarning[] = [];
  const configService = options.configService ?? new ServerConfigService();
  const config = await configService.loadForStartup();
  const modelRuntime = configService.modelRuntime;
  const modelSelectionResolver = new ModelSelectionResolver();

  const projectSessionModels = (file: SessionFile): RuntimeSessionFile => {
    const snapshot = modelRuntime.current;
    const validOverride = file.modelSelection.override !== undefined
      && snapshot.tryResolveSelection(file.modelSelection.override) !== undefined;
    const agentDefault = snapshot.getAgentDefault(file.agentName);
    if (agentDefault === undefined) {
      throw new Error(`Agent "${file.agentName}" has no configured default model`);
    }
    const requested = validOverride
      ? { mode: "session_override" as const, selection: { ...file.modelSelection.override! } }
      : { mode: "agent_default" as const, selection: { ...agentDefault } };
    const resolved = modelSelectionResolver.resolve({
      snapshot,
      agentName: file.agentName,
      ...(validOverride ? { sessionOverride: file.modelSelection.override } : {}),
    }).summary;
    const activeModelBinding = [...file.executions]
      .reverse()
      .find((execution) => execution.status === "running")
      ?.binding;
    return {
      ...file,
      nextModelSelection: { requested, resolved },
      ...(activeModelBinding === undefined ? {} : { activeModelBinding }),
    };
  };
  const resolvedMcpConfig = resolveMcpConfig(config.mcp);
  const resolvedGithubConfig = resolveGithubIntegrationConfig(config.integrations?.github);
  const literalRegistry = collectRuntimeSecretLiterals({
    providers: config.provider,
    userMcp: resolvedMcpConfig,
    github: resolvedGithubConfig,
    externalLiterals: options.externalSecretLiterals ?? [],
  });
  const redactionPolicy = new SecretRedactionPolicy(literalRegistry.values());
  const runtimeLogger = createRuntimeLogSafetyBoundary(logger, redactionPolicy).child({ module: "runtime" });

  const toolOutputRootDir = options.toolOutputRootDir
    ?? join(options.projectRegistryHomeDir ?? homedir(), USER_DATA_DIR_NAME, "tool-output");
  const toolOutputArtifactStore = internalOptions.toolOutputStoreFactory?.(toolOutputRootDir)
    ?? new ToolOutputArtifactStore({ rootDir: toolOutputRootDir });
  let mcpManager: McpManager | undefined;
  const recordWarning = (warning: McpWarning): void => {
    const safeWarning = redactionPolicy.redactValue(warning);
    warnings.push(safeWarning);
    runtimeLogger.warn("mcp.discovery.warning", {
      message: safeWarning.message,
      context: safeWarning.toolName ? { toolName: safeWarning.toolName } : undefined,
      meta: { warning: safeWarning },
    });
  };

  try {
    mcpManager = options.mcpManagerFactory
      ? options.mcpManagerFactory(resolvedMcpConfig, redactionPolicy)
      : new McpManager(BUILTIN_MCP_SERVERS, resolvedMcpConfig.servers, redactionPolicy, undefined, runtimeLogger.child({ module: "mcp" }));
    const activeMcpManager = mcpManager;
    await toolOutputArtifactStore.ready();
    const finalizer = new ToolOutputFinalizer({
      artifactStore: toolOutputArtifactStore,
      redactionPolicy,
    });
    const hitlCodec = new HitlBoundaryCodec(redactionPolicy);
    const toolRegistry = createToolRegistry({ finalizer, hitlCodec, logger: runtimeLogger.child({ module: "tools.registry" }) });
    registerBuiltinTools(toolRegistry, runtimeLogger.child({ module: "tools" }), {
      github: resolvedGithubConfig,
    });
    const skillService = new SkillService();

    configureDefaultLspClientPoolLogger(runtimeLogger.child({ module: "lsp" }));
    configureDefaultBinaryManagerLogger(runtimeLogger.child({ module: "binary" }));
    configureDefaultProcessRunnerLogger(runtimeLogger.child({ module: "process" }));
    configureDefaultLspToolLogger(runtimeLogger.child({ module: "lsp.tools" }));
    configureDefaultWebFetchLogger(runtimeLogger.child({ module: "webfetch" }));

    activeMcpManager.startBackgroundDiscovery(
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

    const projectRegistry = new ProjectRegistry({ homeDir: options.projectRegistryHomeDir, logger: runtimeLogger.child({ module: "projects.registry" }) });
    const projectSlugsByWorkspace = new Map(
      (await projectRegistry.list()).map((project) => [project.workspaceRoot, project.slug]),
    );
    const rememberProject = async (workspaceRoot: string): Promise<void> => {
      const project = await projectRegistry.getByWorkspace(workspaceRoot);
      if (project !== undefined) projectSlugsByWorkspace.set(project.workspaceRoot, project.slug);
    };
    const sessionStoreManager = new SessionStoreManager({ logger: runtimeLogger.child({ module: "sessions.store" }) });
    const sessionGoalService = new SessionGoalService(sessionStoreManager);
    const sessionInputService = new SessionInputService(sessionStoreManager);
    const sessionModelSelectionService = new SessionModelSelectionService(sessionStoreManager);
    const sessionEventBridge = new SessionEventBridge({
      source: sessionStoreManager,
      resolveProjectSlug: (workspaceRoot) => projectSlugsByWorkspace.get(workspaceRoot),
    });
    const hitlListeners = new Set<(event: GlobalSSEHitlRealtimeEvent) => void>();
    const sessionRuntimeListeners = new Set<(event: GlobalSSESessionRuntimeChangedEvent) => void>();
    const resourceChangeListeners = new Set<(event: GlobalSSEResourceChangedEvent) => void>();
    const projectReconcileRetries = new Map<string, { attempt: number; timer?: ReturnType<typeof setTimeout> }>();
    const projectReconcileInFlight = new Set<string>();
    const hitlDispatches = new Map<string, Promise<HitlRecord>>();
    const cancelledReconcileWorkspaces = new Set<string>();
    let reconciliationShuttingDown = false;
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
      hitlCodec,
      projectInfoFactory: async (workspaceRoot) => {
        const project = await projectRegistry.getByWorkspace(workspaceRoot);
        if (project === undefined) {
          throw new Error(`Project is not registered: ${workspaceRoot}`);
        }
        projectSlugsByWorkspace.set(project.workspaceRoot, project.slug);
        return project;
      },
      hitlFactory: ({ workspaceRoot, codec }) => new ProjectHitlQueue({
        workspaceRoot,
        codec,
        onEvent: (event) => publishProjectHitlEvent(workspaceRoot, event),
      }),
      projectTodoFactory: ({ workspaceRoot, project }) => new ProjectTodoService({
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
    executionScopeValidator = new SessionExecutionScopeValidator();
    let executionManager!: SessionExecutionManager;
    let sessionGoalCoordinator!: SessionGoalCoordinator;
    const sessionAgentManager = new SessionAgentManager({
      definitions: defaultAgentDefinitions,
      toolRegistry,
      skillService,
      memoryConfig: config.memory,
      projectContextResolver: contextResolver,
      sessionGoalService,
      consumeFreshUserInput: (input) => executionManager.consumeFreshUserInput(input),
      resolveMcpStatuses: () => activeMcpManager.getStatus(),
      storeManager: sessionStoreManager,
      createToolOutputAccess: (workspaceRoot, rootSessionId) => createScopeBoundToolOutputAccess(
        toolOutputArtifactStore,
        { workspaceRoot, rootSessionId },
      ),
      logger: runtimeLogger.child({ module: "sessions.agents" }),
    });
    const activeSessionKeys = new Map<string, { workspaceRoot: string; sessionId: string }>();
    function notifyRuntimeShutdown(reason: string): void {
      shutdownReconciliation();
      runtimeLogger.info("runtime.shutdown", { message: reason, meta: { activeSessions: activeSessionKeys.size } });
    }

    const trackSession = (workspaceRoot: string, sessionId: string): void => {
      activeSessionKeys.set(scopedKey(workspaceRoot, sessionId), { workspaceRoot, sessionId });
    };

    const untrackSession = (workspaceRoot: string, sessionId: string): void => {
      activeSessionKeys.delete(scopedKey(workspaceRoot, sessionId));
    };

    executionManager = new SessionExecutionManager({
      sessionAgentManager,
      modelRuntime,
      modelSelectionResolver,
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
      onFreshUserInput: async ({ workspaceRoot, rootSessionId }) => {
        await sessionGoalService.advanceUserInputCursor({
          workspaceRoot,
          sessionId: rootSessionId,
          authority: { kind: "runtime" },
        });
      },
      onSessionInputMutationReleased: ({ workspaceRoot, rootSessionId }) => {
        const projectSlug = projectSlugsByWorkspace.get(workspaceRoot);
        if (projectSlug === undefined) return;
        if (executionManager.getSessionFamilyActivity(workspaceRoot, rootSessionId) !== "idle") return;
        void sessionGoalCoordinator.reconcile({ workspaceRoot, projectSlug, rootSessionId })
          .catch((error) => {
            if (isBenignGoalReconcileError(error)) return;
            runtimeLogger.warn("session.input-mutation.release-reconcile_failed", {
              error,
              context: { rootSessionId },
              meta: { workspaceRoot },
            });
          });
      },
      onGoalReviewRequested: async ({ workspaceRoot, rootSessionId, reason }) => {
        const projectSlug = projectSlugsByWorkspace.get(workspaceRoot);
        if (projectSlug === undefined) throw new Error(`Project is not registered: ${workspaceRoot}`);
        await sessionGoalCoordinator.requestReview({
          workspaceRoot,
          projectSlug,
          rootSessionId,
          requestedBy: "engineer",
          reason,
        });
      },
      onExecutionUsage: async ({ workspaceRoot, rootSessionId, usage, executionTimeMs, outcome }) => {
        const goal = await sessionGoalService.get({ workspaceRoot, sessionId: rootSessionId });
        if (goal === undefined || goal.status === "complete") return;
        await sessionGoalService.recordUsage({
          workspaceRoot,
          sessionId: rootSessionId,
          authority: { kind: "runtime" },
          usage,
          executionTimeMs,
          outcome,
        });
      },
      validateGoalReviewClaim: async ({
        workspaceRoot,
        rootSessionId,
        reviewClaimId,
        reviewerSessionId,
        reviewerExecutionId,
      }) => {
        const goal = await sessionGoalService.get({ workspaceRoot, sessionId: rootSessionId });
        return goal?.status === "active"
          && goal.review?.phase === "review_running"
          && goal.review.claim.claimId === reviewClaimId
          && goal.review.reviewerSessionId === reviewerSessionId
          && goal.review.reviewerExecutionId === reviewerExecutionId;
      },
      prepareGoalReviewToolBatchResume: async ({
        workspaceRoot,
        rootSessionId,
        reviewClaimId,
        reviewerSessionId,
        reviewerExecutionId,
      }) => {
        try {
          await sessionGoalService.continueReviewAttempt({
            workspaceRoot,
            sessionId: rootSessionId,
            authority: { kind: "runtime" },
            claimId: reviewClaimId,
            reviewerSessionId,
            reviewerExecutionId,
          });
          const projectSlug = projectSlugsByWorkspace.get(workspaceRoot);
          if (projectSlug === undefined) return false;
          return await sessionGoalCoordinator.ensureReviewMonitor({
            workspaceRoot,
            projectSlug,
            rootSessionId,
            claimId: reviewClaimId,
            reviewerSessionId,
            reviewerExecutionId,
          });
        } catch (error) {
          if (error instanceof SessionGoalServiceError) return false;
          throw error;
        }
      },
      prepareGoalRemediationToolBatchResume: async ({
        workspaceRoot,
        rootSessionId,
        previousExecutionId,
        proposedExecutionId,
      }) => {
        const store = await sessionStoreManager.getOrLoad(rootSessionId, workspaceRoot);
        const state = store.getState();
        const review = state.goal?.review;
        if (state.goal?.status !== "active" || review?.phase !== "remediation_running") {
          return { kind: "not_remediation" as const };
        }
        const currentExecutionId = review.remediationExecutionId;
        if (currentExecutionId === undefined) return { kind: "stale" as const };
        if (currentExecutionId === previousExecutionId) {
          await sessionGoalService.continueRemediationExecution({
            workspaceRoot,
            sessionId: rootSessionId,
            authority: { kind: "runtime" },
            claimId: review.claim.claimId,
            previousExecutionId,
            executionId: proposedExecutionId,
          });
          return { kind: "prepared" as const, executionId: proposedExecutionId };
        }
        // A prior wake may have durably rebound the Goal and then failed before
        // SessionExecutionManager could claim the Execution. Reuse that exact
        // id so repeated wake/reconcile paths cannot fork the remediation.
        if (!state.executions.some((execution) => execution.id === currentExecutionId)) {
          return { kind: "prepared" as const, executionId: currentExecutionId };
        }
        return { kind: "stale" as const };
      },
      deletionLifecycle: new SessionLifecycleService({
        storeManager: sessionStoreManager,
        cancelSessionToolBatch: (sessionId, workspaceRoot, reason) => (
          cancelSessionBatchAndHitl(sessionId, workspaceRoot, reason)
        ),
        deleteToolOutputs: async ({ workspaceRoot, rootSessionId, sessionIds }) => {
          await toolOutputArtifactStore.deleteProducerSessions(
            {
              projectIdentity: await computeProjectIdentity(workspaceRoot),
              rootSessionId,
            },
            new Set(sessionIds),
          );
        },
        findProjectTodoOwners: async (input) => {
          const context = await contextResolver.resolve(input.workspaceRoot);
          return await context.todos.findSessionOwners(input.sessionIds);
        },
      }),
      logger: runtimeLogger.child({ module: "sessions.execution" }),
    });
    sessionGoalCoordinator = new SessionGoalCoordinator({
      service: sessionGoalService,
      storeManager: sessionStoreManager,
      executionManager,
      modelRuntime,
      modelSelectionResolver,
      logger: runtimeLogger.child({ module: "session-goal.coordinator" }),
    });
    const startCheckedSessionExecution = (
      input: StartSessionExecutionInput,
    ): Promise<ActiveSessionExecution> => executionManager.startCheckedExecution(input);
    const sessionToolBatchExecutor: SessionToolBatchExecutor = (input) => (
      executionManager.startSessionToolBatchExecution(input)
    );
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
          await applySessionToolBatchResponse({
            registry: toolRegistry,
            storeManager: sessionStoreManager,
            workspaceRoot,
            sessionId: dispatching.owner.id,
            hitlId: dispatching.hitlId,
            requestKey: dispatching.requestKey,
            response: dispatching.response!,
          });

          const applied = await context.hitl.resolve(dispatching.hitlId, { type: "applied" });
          void sessionToolBatchExecutor({
            slug: projectSlug,
            workspaceRoot,
            sessionId: applied.owner.id,
          }).catch((error) => {
            const failure = hitlCodec.redactFailure(error);
            runtimeLogger.warn("session.tool_batch.wake_failed", {
              context: redactionPolicy.redactValue({ projectSlug, sessionId: applied.owner.id, hitlId: applied.hitlId }),
              meta: { failure },
            });
          });
          return applied;
        } catch (error) {
          const attempts = dispatching.delivery?.attempts ?? 0;
          const failure = hitlCodec.redactFailure(error);
          current = await context.hitl.resolve(dispatching.hitlId, {
            type: "delivery_failed",
            error: failure.message,
            ...(attempts < MAX_HITL_DELIVERY_ATTEMPTS
              ? { retryAt: new Date().toISOString() }
              : {}),
          });
          runtimeLogger.warn("hitl.delivery.failed", {
            context: redactionPolicy.redactValue({ projectSlug, hitlId: dispatching.hitlId, ownerType: dispatching.owner.type }),
            meta: { attempts, failure },
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
            registry: toolRegistry,
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
        settleSystem: async (call, step, raw) => {
          const store = await sessionStoreManager.getOrLoad(sessionId, workspaceRoot);
          const state = store.getState();
          const outcome = await toolRegistry.settleSystem(
            call,
            createToolExecutionContext({
              store,
              storeManager: sessionStoreManager,
              toolName: call.toolName,
              toolCallId: call.toolCallId,
              input: call.input,
              step,
              abort: new AbortController().signal,
              agentName: state.agentName,
              startedAt: Date.now(),
              allowedTools: new Set(),
              agentSkills: state.activeSkillNames,
              skillService,
              projectContext: context,
              cwd: state.cwd,
            }),
            raw,
          );
          return outcome;
        },
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
          const failure = hitlCodec.redactFailure(error);
          runtimeLogger.warn("hitl.delivery.reconcile_failed", {
            context: redactionPolicy.redactValue({ projectSlug, hitlId: record.hitlId, ownerType: record.owner.type }),
            meta: { failure },
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
              requestedModelSelection: input.requestedModelSelection,
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
                  requestedModelSelection: input.requestedModelSelection,
                }, async (binding, signal): Promise<SessionMessageAcceptance> => {
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
                    result = await agent.executeCommand(command, binding, { abort: signal });
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
                    requestedModelSelection: input.requestedModelSelection,
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
          requestedModelSelection: input.requestedModelSelection,
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
            await sessionGoalCoordinator.reconcile({
              projectSlug,
              workspaceRoot: change.workspaceRoot,
              rootSessionId: change.rootSessionId,
            });
          })
          .catch((error) => {
            if (isBenignGoalReconcileError(error)) return;
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
            const session = projectSessionModels(await sessionStoreManager.getSessionFile(
              input.workspaceRoot,
              input.sessionId,
            ));
            const accepted = await acceptSessionMessage({
              ...input,
              requestedModelSelection: session.nextModelSelection.requested,
            });
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

    function shutdownReconciliation(): void {
      reconciliationShuttingDown = true;
      for (const retry of projectReconcileRetries.values()) {
        if (retry.timer !== undefined) clearTimeout(retry.timer);
      }
      projectReconcileRetries.clear();
    }

    function cancelWorkspaceReconciliation(workspaceRoot: string): void {
      cancelledReconcileWorkspaces.add(workspaceRoot);
      const prefix = `${workspaceRoot}\0`;
      for (const [key, retry] of projectReconcileRetries) {
        if (!key.startsWith(prefix)) continue;
        if (retry.timer !== undefined) clearTimeout(retry.timer);
        projectReconcileRetries.delete(key);
      }
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
      if (
        session.sessionId !== session.rootSessionId
        || session.parentSessionId !== undefined
        || session.agentName !== "engineer"
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
          await contextResolver.resolve(project.workspaceRoot);
          await reconcileAnsweredHitl(project.workspaceRoot, project.slug);
          await continueRunnableToolBatches(project.workspaceRoot, project.slug);
          await recoverQueuedSessionInputs(project.workspaceRoot, project.slug);
          await sessionGoalCoordinator.reconcileAll(project.workspaceRoot, project.slug);
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
      if (reconciliationShuttingDown || projectReconcileInFlight.has(key) || projectReconcileRetries.get(key)?.timer !== undefined) return;
      projectReconcileInFlight.add(key);
      try {
        projectSlugsByWorkspace.set(workspaceRoot, projectSlug);
        const context = await contextResolver.resolve(workspaceRoot);
        await context.todos.reconcileAll();
        await reconcileAnsweredHitl(workspaceRoot, projectSlug);
        await continueRunnableToolBatches(workspaceRoot, projectSlug);
        await recoverQueuedSessionInputs(workspaceRoot, projectSlug);
        await sessionGoalCoordinator.reconcileAll(workspaceRoot, projectSlug);
        projectReconcileRetries.delete(key);
      } catch (error) {
        if (reconciliationShuttingDown || cancelledReconcileWorkspaces.has(workspaceRoot)) {
          projectReconcileRetries.delete(key);
          return;
        }
        const attempt = (projectReconcileRetries.get(key)?.attempt ?? 0) + 1;
        const delay = Math.min(100 * 2 ** (attempt - 1), 30_000);
        const retry: { attempt: number; timer?: ReturnType<typeof setTimeout> } = { attempt };
        retry.timer = setTimeout(() => {
          retry.timer = undefined;
          if (reconciliationShuttingDown || cancelledReconcileWorkspaces.has(workspaceRoot)) {
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

    async function getToolOutputAccess(
      workspaceRoot: string,
      sessionId: string,
    ): Promise<ToolOutputAccessService> {
      const rootSessionId = await sessionStoreManager.resolveRootSessionId(sessionId, workspaceRoot);
      return createScopeBoundToolOutputAccess(toolOutputArtifactStore, {
        workspaceRoot,
        rootSessionId,
      });
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
        // Project removal is unregister-only. Session and Tool Output data remain
        // owned by the workspace identity so re-registering the same workspace
        // can recover unexpired refs.
        cancelWorkspaceReconciliation(project.workspaceRoot);
        const projectRetryKey = `${project.workspaceRoot}\0${project.slug}`;
        const projectRetry = projectReconcileRetries.get(projectRetryKey);
        if (projectRetry?.timer !== undefined) clearTimeout(projectRetry.timer);
        projectReconcileRetries.delete(projectRetryKey);
        projectSlugsByWorkspace.delete(project.workspaceRoot);
        automationRuntimeServices.delete(project.workspaceRoot);
        await sessionGoalCoordinator.disposeWorkspace(project.workspaceRoot);
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

    const abortAllSessionExecutions = (): Promise<void> => {
      shutdownReconciliation();
      return executionManager.abortAll();
    };
    let shutdownPromise: Promise<void> | undefined;
    const shutdown = (): Promise<void> => {
      if (shutdownPromise !== undefined) return shutdownPromise;

      shutdownPromise = (async () => {
        await Promise.all([
          stopAutomationSchedulers(),
          abortAllSessionExecutions(),
          sessionGoalCoordinator.dispose(),
          toolOutputArtifactStore.dispose(),
          closeMcpManager(activeMcpManager, warnings, runtimeLogger),
        ]);
        sessionAgentManager.disposeAll();
      })();
      return shutdownPromise;
    };

    return {
      toolRegistry,
      modelRuntime,
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
      subscribeModelRuntimeChanges: (listener) => modelRuntime.subscribe((snapshot) => listener({
        type: "model_runtime.changed",
        revision: snapshot.revision,
        createdAt: Date.now(),
      })),
      subscribeResourceChanges: (listener) => {
        resourceChangeListeners.add(listener);
        return () => {
          resourceChangeListeners.delete(listener);
        };
      },
      subscribeMcpStatusChanges: (listener) => activeMcpManager.onStatusChange(listener),
      getMcpServerStatuses: () => activeMcpManager.getStatus(),
      createSession: async (workspaceRoot, createOptions) => {
        executionManager.assertWorkspaceOpen(workspaceRoot);
        assertRuntimeSessionAgentScope(createOptions);
        return projectSessionModels(await sessionStoreManager.createSessionFile(workspaceRoot, createOptions));
      },
      getSessionFile: async (workspaceRoot, sessionId) => {
        await sessionStoreManager.flushSession(sessionId, workspaceRoot);
        return projectSessionModels(await sessionStoreManager.getSessionFile(workspaceRoot, sessionId));
      },
      updateSessionGoalControl: async (input) => {
        const target = { workspaceRoot: input.workspaceRoot, sessionId: input.sessionId, authority: { kind: "user_control" as const } };
        if (input.action === "edit") {
          if (input.objective === undefined || input.expectedGeneration === undefined) {
            throw new Error("Editing a Session Goal requires objective and expectedGeneration");
          }
          await sessionGoalService.edit({ ...target, objective: input.objective, expectedGeneration: input.expectedGeneration });
        } else if (input.action === "pause") {
          await sessionGoalService.pause(target);
        } else if (input.action === "resume") {
          await sessionGoalService.resume(target);
        } else if (input.action === "clear") {
          await sessionGoalService.clear(target);
        } else {
          await sessionGoalService.setTokenBudget({ ...target, tokenBudget: input.tokenBudget });
        }
        if (input.action !== "pause" && input.action !== "clear") {
          const projectSlug = projectSlugsByWorkspace.get(input.workspaceRoot);
          if (projectSlug !== undefined
            && executionManager.getSessionFamilyActivity(input.workspaceRoot, input.sessionId) === "idle") {
            void sessionGoalCoordinator.reconcile({
              workspaceRoot: input.workspaceRoot,
              projectSlug,
              rootSessionId: input.sessionId,
            }).catch((error) => runtimeLogger.warn("session-goal.control.reconcile_failed", {
              error,
              context: { sessionId: input.sessionId, action: input.action },
            }));
          }
        }
        return projectSessionModels(await sessionStoreManager.getSessionFile(input.workspaceRoot, input.sessionId));
      },
      getSessionModelState: async (workspaceRoot, sessionId) => {
        const projected = projectSessionModels(await sessionStoreManager.getSessionFile(workspaceRoot, sessionId));
        return {
          modelSelection: projected.modelSelection,
          nextModelSelection: projected.nextModelSelection,
          ...(projected.activeModelBinding === undefined ? {} : { activeModelBinding: projected.activeModelBinding }),
        };
      },
      patchSessionModelSelection: async (input) => {
        const file = await sessionStoreManager.getSessionFile(input.workspaceRoot, input.sessionId);
        if (input.requestedModelSelection.mode === "session_override"
          && modelRuntime.current.tryResolveSelection(input.requestedModelSelection.selection) === undefined) {
          throw new SessionModelSelectionInvalidError(input.requestedModelSelection);
        }
        await sessionModelSelectionService.patch(input);
        const projected = projectSessionModels(await sessionStoreManager.getSessionFile(input.workspaceRoot, input.sessionId));
        if (projected.agentName !== file.agentName) {
          throw new Error(`Session "${input.sessionId}" Agent identity changed during model selection update`);
        }
        return {
          modelSelection: projected.modelSelection,
          nextModelSelection: projected.nextModelSelection,
          ...(projected.activeModelBinding === undefined ? {} : { activeModelBinding: projected.activeModelBinding }),
        };
      },
      getToolOutputAccess,
      readToolOutput: async (workspaceRoot, sessionId, input) => (
        await (await getToolOutputAccess(workspaceRoot, sessionId)).read(input)
      ),
      searchToolOutputs: async (workspaceRoot, sessionId, input) => (
        await (await getToolOutputAccess(workspaceRoot, sessionId)).search(input)
      ),
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
      getSessionFamilyActivity: (workspaceRoot, rootSessionId) => executionManager.getSessionFamilyActivity(workspaceRoot, rootSessionId),
      stopSessionFamily: async (workspaceRoot, rootSessionId) => {
        await rememberProject(workspaceRoot);
        const store = await sessionStoreManager.getOrLoad(rootSessionId, workspaceRoot);
        const state = store.getState();
        if (state.parentSessionId !== undefined || state.rootSessionId !== rootSessionId) {
          throw new NotRootSessionError(rootSessionId, state.parentSessionId ?? state.rootSessionId);
        }
        if (state.goal?.status === "active") {
          await sessionGoalService.pause({ workspaceRoot, sessionId: rootSessionId, authority: { kind: "user_control" } });
        }
        await sessionFamilyStopService.stop(workspaceRoot, rootSessionId);
      },
      abortAllSessionExecutions,
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
      disposeToolOutputs: () => toolOutputArtifactStore.dispose(),
      shutdown,
      notifyRuntimeShutdown,
    };
  } catch (err) {
    const errorName = err instanceof Error ? err.name : "NonErrorThrow";
    const errorCode = typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
      ? err.code
      : "RUNTIME_INIT_FAILED";
    runtimeLogger.error("runtime.init.failed", {
      message: redactionPolicy.redactString(errorMessage(err)),
      meta: { errorName, errorCode },
    });
    if (mcpManager !== undefined) await closeMcpManager(mcpManager, warnings, runtimeLogger);
    await toolOutputArtifactStore.dispose();
    throw err;
  }
}

function assertRuntimeSessionAgentScope(options: CreateRuntimeSessionOptions): void {
  if (options.agentName !== "engineer" && options.agentName !== "shaper") {
    throw new Error(`Root Sessions require agentName "engineer" or "shaper", got "${options.agentName}"`);
  }
}

/**
 * MCP close failures cross a process boundary. Deliberately do not preserve
 * their message, server name, stderr, or stack: those values can contain
 * credentials, URLs, and local paths. The Runtime is the sole owner of this
 * boundary; callers only receive the stable warning record and log event.
 */
async function closeMcpManager(
  mcpManager: McpManager,
  warnings: McpWarning[],
  logger: Logger,
): Promise<void> {
  try {
    const closeWarnings = await mcpManager.closeAll();
    for (const _warning of closeWarnings) recordMcpShutdownWarning(warnings, logger);
  } catch {
    recordMcpShutdownWarning(warnings, logger);
  }
}

function recordMcpShutdownWarning(warnings: McpWarning[], logger: Logger): void {
  const warning: McpWarning = { message: "MCP shutdown failed" };
  warnings.push(warning);
  logger.warn("mcp.shutdown.warning", {
    message: warning.message,
    meta: { failure: { name: "McpShutdownError", code: "MCP_SHUTDOWN_FAILED" } },
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}
