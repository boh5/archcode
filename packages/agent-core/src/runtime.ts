import { join } from "node:path";
import { defaultAgentDefinitions, isUserFacingRootSession } from "./agents";
import type { AgentName } from "./agents";
import { AgentRunningError } from "./agents/errors";
import { SessionAgentManager } from "./agents/session-agent-manager";
import {
  ServerConfigService,
  type ServerConfigActivation,
} from "./config/server-config-service";
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
  McpRuntimeService,
  type McpRuntime,
  type McpRuntimeServiceOptions,
  type McpTestResult,
} from "./mcp/index";
import { ModelSelectionResolver, type ModelRuntime } from "./models";
import { ProjectContextResolver } from "./projects/context-resolver";
import type { ProjectRegistry } from "./projects/registry";
import type { ProjectInfo } from "./projects/types";
import { SessionLifecycleService } from "./projects/session-lifecycle-service";
import { SkillService } from "./skills";
import { normalizeSkillUseArgs, validateSkillActivation } from "./commands/skill";
import type { SessionFile, SessionSummary } from "./store/helpers";
import { projectSessionCompression } from "./store/session-read-projection";
import { resolveSessionProfile } from "./agents/session-profile";
import { NotRootSessionError } from "./store/errors";
import type { CompressionOriginalRangeResult } from "./compression";
import type {
  AgentDescriptor,
  Automation,
  AutomationInvocation,
  ExecutionModelBindingSummary,
  GlobalSSEEvent,
  GlobalSSEHitlRealtimeEvent,
  GlobalSSEHitlEntry,
  GlobalSSEHitlSnapshotEvent,
  GlobalSSEModelRuntimeChangedEvent,
  GlobalSSEResourceChangedEvent,
  GlobalSessionEventEnvelope,
  GlobalSSESessionRuntimeChangedEvent,
  GlobalSSESessionRuntimeSnapshotEvent,
  HitlResponse,
  HitlView,
  McpServerStatus,
  McpServerInventoryResponse,
  McpServerStatusResponse,
  NormalizedUsage,
  SessionNextModelSelection,
  SessionModelState,
  RequestedModelSelection,
  SessionFamilyActivity,
  SessionExecutionRecord,
  CompressionStateSnapshot,
  SessionGoal,
  SessionProjection,
  SessionTreeResponse,
  RootSessionSource,
  RootSessionSummary,
  ProjectSessionInventoryItem,
  ProjectAutomationInventoryItem,
  ProjectSkillInventoryResponse,
  UpdateServerConfigRequest,
} from "@archcode/protocol";
import { createRegistry as createToolRegistry, createToolExecutionContext, type ToolRegistry } from "./tools/index";
import {
  applySessionToolBatchResponse,
  applySessionToolBatchChildOutcome,
  cancelSessionToolBatch,
  repairSessionToolBatchHitlIds,
  validateSessionToolBatchResponse,
  SessionExecutionManager,
  SessionExecutionScopeValidator,
  SessionFamilyStopService,
  SessionDeleteInProgressError,
  SessionFamilyStopInProgressError,
  SessionFamilyActiveError,
} from "./execution";
import type { ActiveSessionExecution, StartSessionExecutionInput } from "./execution";
import { collectSessionTreeIds } from "./execution/session-tree";
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
import {
  SessionInputConflictError,
  SessionInputService,
  type CommandRequestReplay,
  type MessageAcceptance,
} from "./session-input/service";
import {
  SessionModelSelectionInvalidError,
  SessionModelSelectionService,
  resolveDurableSessionModelOverride,
} from "./session-input/model-selection-service";
import { WorktreeService } from "./worktrees";
import { ProjectTodoService, ProjectTodoStateManager } from "./todos";
import { SessionGoalService } from "./session-goal";
import {
  createScopeBoundToolOutputAccess,
  type ScopedOutputReadInput,
  type ScopedOutputSearchInput,
  type ToolOutputAccessService,
} from "./tool-output/access-service";
import { ToolOutputArtifactStore, computeProjectIdentity } from "./tool-output/artifact-store";
import { ToolOutputFinalizer } from "./tool-output/finalizer";
import { createRuntimeLogSafetyBoundary, SecretRedactionPolicy } from "./security";
import { rootSessionSourceTodoId, USER_DATA_DIR_NAME } from "@archcode/protocol";
import {
  resolveAttachmentReadPaths,
  ProjectAttachmentStorage,
  SessionAttachmentModelProjector,
  SessionAttachmentService,
  type OpenSessionAttachmentInput,
  type OpenProjectAttachmentResult,
  type UploadSessionAttachmentInput,
  type UploadProjectAttachmentResult,
} from "./attachments";

interface ActiveGoalReconciliationSnapshot {
  readonly isRootLead: boolean;
  readonly goalStatus?: SessionGoal["status"];
  readonly lastRootExecutionStatus?: SessionExecutionRecord["status"];
}

interface ActiveGoalReconciliationDependencies {
  readonly getFamilyActivity: () => SessionFamilyActivity;
  readonly hasUnresolvedToolBatchHitl: () => Promise<boolean>;
  readonly startQueuedExecution: () => Promise<boolean>;
  readonly loadSnapshot: () => Promise<ActiveGoalReconciliationSnapshot>;
  readonly startContinuation: () => Promise<void>;
}

/**
 * One stateless Goal-continuation predicate shared by idle-family and startup
 * recovery triggers. Runtime-owned admission remains the final concurrency gate.
 */
export async function reconcileActiveSessionGoal(
  input: { readonly forceStartupRecovery: boolean },
  dependencies: ActiveGoalReconciliationDependencies,
): Promise<void> {
  if (dependencies.getFamilyActivity() !== "idle") return;
  if (await dependencies.hasUnresolvedToolBatchHitl()) return;
  if (await dependencies.startQueuedExecution()) return;

  const snapshot = await dependencies.loadSnapshot();
  if (!snapshot.isRootLead || snapshot.goalStatus !== "active") return;
  if (!input.forceStartupRecovery
    && snapshot.lastRootExecutionStatus !== "completed"
    && snapshot.lastRootExecutionStatus !== "max_steps") return;

  try {
    await dependencies.startContinuation();
  } catch (error) {
    if (
      error instanceof AgentRunningError
      || error instanceof SessionFamilyActiveError
      || error instanceof SessionFamilyStopInProgressError
      || error instanceof SessionDeleteInProgressError
    ) return;
    throw error;
  }
}

export interface AcceptSessionMessageInput {
  readonly slug: string;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly text: string;
  readonly attachmentIds: readonly string[];
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
  /** Process-owned configuration service that produced activation. */
  configService: ServerConfigService;
  /** Explicit, validated startup activation. Runtime never reads configuration from disk. */
  activation: ServerConfigActivation;
  /** Test seam for the process-owned live MCP service. */
  mcpRuntimeFactory?: (options: McpRuntimeServiceOptions) => McpRuntime;
  /** Already-resolved process-owned secret literals that are not part of global Config. */
  externalSecretLiterals?: readonly string[];
  /** Process-owned registry shared with the control plane. Runtime never constructs one. */
  projectRegistry: ProjectRegistry;
  /** Test-only base directory for Runtime-owned process storage such as tool outputs. */
  runtimeStorageHomeDir?: string;
  /** Internal storage location override for isolated tests. */
  toolOutputRootDir?: string;
  automationSchedulerTimer?: AutomationSchedulerTimer;
  automationSchedulerClock?: AutomationSchedulerClock;
  logger?: Logger;
}

interface AgentRuntimeInternalOptions extends AgentRuntimeOptions {
  /** Test-only seam kept out of the package contract. */
  toolOutputStoreFactory?: (rootDir: string) => ToolOutputArtifactStore;
  /** Test-only seam for best-effort attachment cleanup failures. */
  attachmentRootRemover?: (path: string) => Promise<void>;
  /** Test-only seams for proving Runtime shutdown cleanup ordering. */
  executionManagerShutdown?: () => Promise<void>;
  sessionAgentManagerDisposeAll?: () => void;
}

export interface CreateRuntimeSessionOptions {
  readonly agentName: AgentName;
  /** Current execution directory; Session persistence remains under workspaceRoot. */
  readonly cwd?: string;
  readonly title?: string;
  readonly source: RootSessionSource;
}

export type RuntimeAutomationDefinitionInput = Pick<
  CreateAutomationInput,
  "name" | "trigger" | "action"
>;

export interface SessionAutomationCreateInput extends RuntimeAutomationDefinitionInput {
  readonly sourceSessionId: string;
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

export class SessionAutomationReferenceConflictError extends Error {
  readonly code = "SESSION_AUTOMATION_REFERENCE_CONFLICT";

  constructor(
    public readonly sessionId: string,
    public readonly automations: ReadonlyArray<{
      readonly id: string;
      readonly name: string;
    }>,
  ) {
    super(
      `Session "${sessionId}" is targeted by ${automations.length} Automation${automations.length === 1 ? "" : "s"}`,
    );
    this.name = "SessionAutomationReferenceConflictError";
  }
}

export interface AgentRuntime {
  readonly toolRegistry: ToolRegistry;
  readonly modelRuntime: ModelRuntime;
  readonly skillService: SkillService;
  readonly configService: ServerConfigService;
  readonly projectRegistry: ProjectRegistry;
  readonly contextResolver: ProjectContextResolver;
  listAgentDescriptors(): readonly AgentDescriptor[];
  getSessionSkillCatalog(
    workspaceRoot: string,
    sessionId: string,
    cursor?: string,
  ): Promise<ProjectSkillInventoryResponse>;
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
  getMcpServerStatus(): McpServerStatusResponse;
  getMcpServerInventory(): McpServerInventoryResponse;
  applyMcpConfig(config: ResolvedMcpConfig): Promise<void>;
  testMcpServerDraft(
    serverName: string,
    request: UpdateServerConfigRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<McpTestResult>;
  reconnectMcpServer(serverName: string): Promise<void>;
  uploadSessionAttachment(input: UploadSessionAttachmentInput): Promise<UploadProjectAttachmentResult>;
  openSessionAttachment(input: OpenSessionAttachmentInput): Promise<OpenProjectAttachmentResult>;
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
  listSessionInventory(workspaceRoot: string): Promise<ProjectSessionInventoryItem[]>;
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
  listAutomationInventory(workspaceRoot: string): Promise<ProjectAutomationInventoryItem[]>;
  readAutomation(workspaceRoot: string, automationId: string): Promise<Automation>;
  createAutomation(workspaceRoot: string, input: SessionAutomationCreateInput): Promise<Automation>;
  createDirectAutomation(workspaceRoot: string, input: RuntimeAutomationDefinitionInput): Promise<Automation>;
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
  reconcileRegisteredProject(workspaceRoot: string, projectSlug: string): Promise<void>;
  stopAutomationSchedulers(): Promise<void>;
  /**
   * Closes new Runtime work only when no execution or control mutation is
   * active. Successful admission is permanent because process restart follows.
   */
  prepareForRestart(): {
    readonly ready: boolean;
    readonly activeFamilyCount?: number;
  };
  disposeToolOutputs(): Promise<void>;
  /** Closes every Runtime-owned resource through its safe internal boundaries. */
  shutdown(): Promise<void>;
  notifyRuntimeShutdown(reason: string): void;
}

export type RuntimeSessionFile = Omit<SessionFile, "compression"> & Pick<
  SessionProjection,
  "executionCount" | "isRunning" | "isStreamingModel"
> & {
  readonly currentExecutionId: SessionProjection["currentExecutionId"];
  readonly currentAssistantMessageId: SessionProjection["currentAssistantMessageId"];
  readonly compression: CompressionStateSnapshot;
  readonly profile: import("./config").ProfileName;
  readonly nextModelSelection: SessionNextModelSelection;
  readonly activeModelBinding?: ExecutionModelBindingSummary;
};

export interface HitlMutationResult {
  readonly hitlId: string;
  readonly status: import("@archcode/protocol").HitlStatus;
  readonly view: HitlView;
}

export async function createRuntime(
  options: AgentRuntimeOptions,
): Promise<AgentRuntime> {
  const internalOptions = options as AgentRuntimeInternalOptions;
  const logger = options.logger ?? createConsoleLogger({ level: "info" });
  const configService = options.configService;
  const config = configService.resolveRuntimeConfig(options.activation);
  const modelRuntime = configService.modelRuntime;
  const modelSelectionResolver = new ModelSelectionResolver();

  const projectSessionModels = (
    file: SessionFile,
    liveState: Pick<
      SessionProjection,
      "executionCount" | "isRunning" | "isStreamingModel" | "currentExecutionId" | "currentAssistantMessageId"
    >,
  ): RuntimeSessionFile => {
    const snapshot = modelRuntime.current;
    const profile = resolveSessionProfile(file);
    const durableOverride = resolveDurableSessionModelOverride(file);
    const validOverride = durableOverride !== undefined
      && snapshot.tryResolveSelection(durableOverride) !== undefined;
    const profileDefault = snapshot.getProfileDefault(profile);
    const requested = validOverride
      ? { mode: "session_override" as const, selection: { ...durableOverride } }
      : { mode: "profile_default" as const, selection: { ...profileDefault } };
    const resolved = modelSelectionResolver.resolve({
      snapshot,
      profile,
      ...(validOverride ? { sessionOverride: durableOverride } : {}),
    }).summary;
    const activeExecution = file.executions.find((execution) =>
      execution.id === liveState.currentExecutionId
    );
    const activeModelBinding = activeExecution?.runs.at(-1)?.binding;
    const currentExecutionId = liveState.currentExecutionId;
    return {
      ...file,
      compression: projectSessionCompression(file.compression),
      executionCount: liveState.executionCount,
      isRunning: liveState.isRunning,
      isStreamingModel: liveState.isStreamingModel,
      currentExecutionId,
      currentAssistantMessageId: liveState.currentAssistantMessageId,
      profile,
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
    ?? join(options.runtimeStorageHomeDir ?? options.configService.homeDir, USER_DATA_DIR_NAME, "tool-output");
  const toolOutputArtifactStore = internalOptions.toolOutputStoreFactory?.(toolOutputRootDir)
    ?? new ToolOutputArtifactStore({ rootDir: toolOutputRootDir });
  let mcpRuntime: McpRuntime | undefined;

  try {
    const mcpOptions: McpRuntimeServiceOptions = {
      logger: runtimeLogger.child({ module: "mcp" }),
    };
    mcpRuntime = options.mcpRuntimeFactory?.(mcpOptions)
      ?? new McpRuntimeService(mcpOptions);
    const activeMcpRuntime = mcpRuntime;
    await toolOutputArtifactStore.ready();
    const finalizer = new ToolOutputFinalizer({
      artifactStore: toolOutputArtifactStore,
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

    // Initial MCP connection is intentionally non-blocking. The synchronous
    // prefix of apply publishes connecting/disabled before Runtime activation;
    // each model boundary sees the current live projection thereafter.
    void activeMcpRuntime.apply(resolvedMcpConfig).catch((error) => {
      runtimeLogger.error("mcp.runtime.initial-apply.failed", {
        error: { name: error instanceof Error ? error.name : "NonErrorThrow" },
      });
    });

    const projectRegistry = options.projectRegistry;
    const projectSlugsByWorkspace = new Map(
      (await projectRegistry.list()).map((project) => [project.workspaceRoot, project.slug]),
    );
    const rememberProject = async (workspaceRoot: string): Promise<void> => {
      const project = await projectRegistry.getByWorkspace(workspaceRoot);
      if (project !== undefined) projectSlugsByWorkspace.set(project.workspaceRoot, project.slug);
    };
    const sessionStoreManager = new SessionStoreManager({ logger: runtimeLogger.child({ module: "sessions.store" }) });
    const projectAttachmentStorage = new ProjectAttachmentStorage({
      removeDirectory: internalOptions.attachmentRootRemover,
    });
    const sessionAttachmentService = new SessionAttachmentService({
      validateRootSession: async (workspaceRoot, rootSessionId) => {
        const file = await sessionStoreManager.getSessionFile(workspaceRoot, rootSessionId);
        if (
          file.parentSessionId !== undefined
          || file.rootSessionId !== rootSessionId
          || !isUserFacingRootSession(file)
        ) {
          throw new NotRootSessionError(
            rootSessionId,
            file.parentSessionId ?? file.rootSessionId,
          );
        }
      },
      storage: projectAttachmentStorage,
    });
    const readProjectedSessionModels = async (
      workspaceRoot: string,
      sessionId: string,
    ): Promise<RuntimeSessionFile> => {
      const snapshot = await sessionStoreManager.getSessionReadSnapshot(workspaceRoot, sessionId);
      return projectSessionModels(snapshot.file, snapshot.liveState);
    };
    const sessionGoalService = new SessionGoalService(sessionStoreManager);
    const sessionInputService = new SessionInputService(
      sessionStoreManager,
      sessionAttachmentService,
    );
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
    const hitlProjectionDispatches = new Map<string, Promise<void>>();
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
    const publishSessionResourceChanged = async (
      workspaceRoot: string,
      rootSessionId: string,
    ): Promise<void> => {
      const projectSlug = projectSlugsByWorkspace.get(workspaceRoot)
        ?? (await projectRegistry.getByWorkspace(workspaceRoot))?.slug;
      if (projectSlug === undefined) {
        runtimeLogger.warn("session.changed.project_missing", {
          context: { rootSessionId },
          meta: { workspaceRoot },
        });
        return;
      }
      projectSlugsByWorkspace.set(workspaceRoot, projectSlug);
      publishResourceChanged({
        type: "resource.changed",
        projectSlug,
        resourceType: "session",
        resourceId: rootSessionId,
        createdAt: Date.now(),
      });
    };
    const publishProjectHitlEvent = (workspaceRoot: string, event: ProjectHitlQueueEvent): Promise<void> => {
      const previous = hitlProjectionDispatches.get(workspaceRoot) ?? Promise.resolve();
      const current = previous.catch(() => undefined).then(async () => {
        await publishProjectHitlEventNow(workspaceRoot, event);
      });
      hitlProjectionDispatches.set(workspaceRoot, current);
      void current.finally(() => {
        if (hitlProjectionDispatches.get(workspaceRoot) === current) hitlProjectionDispatches.delete(workspaceRoot);
      });
      return current;
    };
    const publishProjectHitlEventNow = async (workspaceRoot: string, event: ProjectHitlQueueEvent): Promise<void> => {
      const projectSlug = projectSlugsByWorkspace.get(workspaceRoot);
      if (projectSlug === undefined) {
        runtimeLogger.warn("hitl.event.project_missing", {
          context: { hitlId: event.view.hitlId },
          meta: { workspaceRoot },
        });
        return;
      }
      const ownerSessionId = event.view.owner.id;
      const rootSessionId = (await sessionStoreManager.getSessionFile(workspaceRoot, ownerSessionId)).rootSessionId;
      const payload = event.type === "hitl.created"
        ? { type: "hitl.request" as const }
        : event.type === "hitl.resolved" || event.type === "hitl.cancelled"
          ? { type: "hitl.resolved" as const }
          : { type: "hitl.updated" as const };
      publishHitlEvent({
        type: "hitl.event",
        projectSlug,
        hitlId: event.view.hitlId,
        ownerSessionId,
        rootSessionId,
        createdAt: Date.now(),
        payload,
        view: event.view,
      });
    };
    const toGlobalHitlEntries = async (
      workspaceRoot: string,
      projectSlug: string,
      views: readonly HitlView[],
    ): Promise<GlobalSSEHitlEntry[]> => await Promise.all(views.map(async (view) => {
      const ownerSessionId = view.owner.id;
      const rootSessionId = (await sessionStoreManager.getSessionFile(workspaceRoot, ownerSessionId)).rootSessionId;
      return { projectSlug, hitlId: view.hitlId, ownerSessionId, rootSessionId, view };
    }));
    const contextResolver = new ProjectContextResolver({
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
        attachmentStorage: projectAttachmentStorage,
        logger: runtimeLogger.child({ module: "todos" }),
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
          createRootSession: async (input) => {
            const session = await sessionStoreManager.createSessionFile(input.workspaceRoot, {
              agentName: input.agentName,
              title: input.title,
              cwd: input.workspaceRoot,
              source: input.source,
            });
            return { sessionId: session.sessionId };
          },
          acceptMessage: async (input) => {
            const session = await readProjectedSessionModels(
              input.workspaceRoot,
              input.sessionId,
            );
            await acceptSessionMessage({
              slug: project.slug,
              workspaceRoot: input.workspaceRoot,
              sessionId: input.sessionId,
              text: input.text,
              attachmentIds: [],
              clientRequestId: input.clientRequestId,
              source: "user",
              requestedModelSelection: session.nextModelSelection.requested,
            });
          },
          readRootSession: async (input) => {
            const file = await sessionStoreManager.getSessionFile(input.workspaceRoot, input.sessionId);
            return projectRootSessionSummary(file);
          },
          hasDurableMessage: async (input) => await sessionInputService.hasDurableMessage(input),
          deleteSession: async (input) => {
            await executionManager.deleteSession(input.workspaceRoot, input.sessionId);
          },
        },
      }),
      createAutomation: (workspaceRoot, input) => createAutomation(workspaceRoot, input),
      logger: runtimeLogger.child({ module: "projects" }),
    });
    const resolveCurrentTodoAttachments = async (input: {
      readonly workspaceRoot: string;
      readonly rootSessionId: string;
    }) => {
      const root = await sessionStoreManager.getSessionFile(
        input.workspaceRoot,
        input.rootSessionId,
      );
      const todoId = root.source === undefined
        ? undefined
        : rootSessionSourceTodoId(root.source);
      if (todoId === undefined) return undefined;
      const todos = (await contextResolver.resolve(input.workspaceRoot)).todos;
      const current = await todos.listAttachments(todoId);
      return {
        attachments: current.attachments,
        resolveReadPath: async (descriptor: import("@archcode/protocol").AttachmentDescriptor) => (
          await todos.resolveAttachmentReadPath(
            { todoId, attachmentId: descriptor.id },
            descriptor,
          )
        ),
        readVerified: async (descriptor: import("@archcode/protocol").AttachmentDescriptor) => (
          await todos.readVerifiedAttachment(
            { todoId, attachmentId: descriptor.id },
            descriptor,
          )
        ),
      };
    };
    const attachmentProjector = new SessionAttachmentModelProjector(
      sessionAttachmentService,
      resolveCurrentTodoAttachments,
    );
    const sessionModelSelectionService = new SessionModelSelectionService(sessionStoreManager);
    const executionScopeValidator = new SessionExecutionScopeValidator();
    let executionManager!: SessionExecutionManager;
    const sessionAgentManager = new SessionAgentManager({
      definitions: defaultAgentDefinitions,
      toolRegistry,
      skillService,
      memoryConfig: config.memory,
      projectContextResolver: contextResolver,
      sessionGoalService,
      resolveMcpToolSnapshot: (builtinServerNames) => activeMcpRuntime.snapshotTools({
        builtinServerNames,
      }),
      storeManager: sessionStoreManager,
      createToolOutputAccess: (workspaceRoot, rootSessionId) => createScopeBoundToolOutputAccess(
        toolOutputArtifactStore,
        { workspaceRoot, rootSessionId },
      ),
      attachmentProjector,
      resolveAttachmentReadPaths: (workspaceRoot, rootSessionId) => (
        resolveAttachmentReadPaths({
          workspaceRoot,
          rootSessionId,
          storeManager: sessionStoreManager,
          attachments: sessionAttachmentService,
          resolveCurrentTodoAttachments,
        })
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
      cancelSessionToolBatch: (sessionId, workspaceRoot, reason) => (
        cancelSessionBatchAndHitl(sessionId, workspaceRoot, reason)
      ),
      sessionInputService,
      skillService,
      trackSession,
      untrackSession,
      executionScopeValidator,
      onSessionInputMutationReleased: async ({ workspaceRoot, rootSessionId }) => {
        const projectSlug = projectSlugsByWorkspace.get(workspaceRoot);
        if (projectSlug === undefined) {
          throw new Error(`Cannot reconcile released Session input for unregistered workspace ${workspaceRoot}`);
        }
        await reconcileRegisteredProject(workspaceRoot, projectSlug, {
          rootSessionId,
        });
      },
      onContinuationAdmissionReleased: async ({ workspaceRoot, sessionId }) => {
        const projectSlug = projectSlugsByWorkspace.get(workspaceRoot);
        if (projectSlug === undefined) {
          throw new Error(`Cannot reconcile released continuation for unregistered workspace ${workspaceRoot}`);
        }
        await reconcileRegisteredProject(workspaceRoot, projectSlug, {
          sessionId,
        });
      },
      resolveGoalInstanceId: async ({ workspaceRoot, rootSessionId }) => (
        (await sessionGoalService.get({ workspaceRoot, sessionId: rootSessionId }))?.instanceId ?? null
      ),
      onExecutionSettlement: async ({
        workspaceRoot,
        rootSessionId,
        sessionId,
        executionId,
        settlements,
      }) => {
        for (const settlement of settlements) {
          if (settlement.goalInstanceId !== null) {
            await sessionGoalService.recordSettlement({
              workspaceRoot,
              sessionId: rootSessionId,
              authority: { kind: "runtime" },
              settlementKey: settlement.key,
              goalInstanceId: settlement.goalInstanceId,
              usage: settlement.usage,
              executionTimeMs: settlement.executionTimeMs,
              terminal: settlement.kind === "terminal",
            });
          }
          await sessionStoreManager.markExecutionSettlementApplied(
            sessionId,
            workspaceRoot,
            settlement.kind === "terminal"
              ? { executionId, terminal: true, expectedKey: settlement.key }
              : {
                  executionId,
                  runOrdinal: settlement.runOrdinal,
                  expectedKey: settlement.key,
                },
          );
        }
      },
      applyChildDependencyOutcome: async (input) => {
        await applySessionToolBatchChildOutcome({
          storeManager: sessionStoreManager,
          sessionId: input.parentSessionId,
          workspaceRoot: input.workspaceRoot,
          batchId: input.parentToolBatchId,
          toolCallId: input.parentToolCallId,
          childSessionId: input.childSessionId,
          childExecutionId: input.childExecutionId,
          outcome: input.outcome,
        });
        const projectSlug = projectSlugsByWorkspace.get(input.workspaceRoot);
        if (projectSlug !== undefined) {
          await executionManager.reconcileDurableSession({
            slug: projectSlug,
            workspaceRoot: input.workspaceRoot,
            sessionId: input.parentSessionId,
          });
        }
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
      }),
      logger: runtimeLogger.child({ module: "sessions.execution" }),
    });
    const startCheckedSessionExecution = (
      input: StartSessionExecutionInput,
    ): Promise<ActiveSessionExecution> => executionManager.startCheckedExecution(input);

    async function reconcileActiveGoal(input: {
      readonly workspaceRoot: string;
      readonly projectSlug: string;
      readonly rootSessionId: string;
      readonly force: boolean;
    }): Promise<void> {
      await reconcileActiveSessionGoal({ forceStartupRecovery: input.force }, {
        getFamilyActivity: () => (
          executionManager.getSessionFamilyActivity(input.workspaceRoot, input.rootSessionId)
        ),
        hasUnresolvedToolBatchHitl: async () => (
          (await sessionStoreManager.listSessionFamilyToolBatchHitlIds(
            input.workspaceRoot,
            input.rootSessionId,
          )).length > 0
        ),
        startQueuedExecution: async () => (
          await executionManager.tryStartQueuedExecution({
            slug: input.projectSlug,
            workspaceRoot: input.workspaceRoot,
            sessionId: input.rootSessionId,
          })
        ) !== undefined,
        loadSnapshot: async () => {
          const state = (await sessionStoreManager.getOrLoad(
            input.rootSessionId,
            input.workspaceRoot,
          )).getState();
          return {
            isRootLead: state.parentSessionId === undefined
              && state.rootSessionId === state.sessionId
              && state.agentName === "lead",
            goalStatus: state.goal?.status,
            lastRootExecutionStatus: state.executions.at(-1)?.status,
          };
        },
        startContinuation: async () => {
          await startCheckedSessionExecution({
            slug: input.projectSlug,
            workspaceRoot: input.workspaceRoot,
            sessionId: input.rootSessionId,
            input: { kind: "goal" },
            origin: "goal_continuation",
          });
        },
      });
    }

    async function reconcileAllActiveGoals(workspaceRoot: string, projectSlug: string): Promise<void> {
      const summaries = await sessionStoreManager.listAllSessionSummaries(workspaceRoot);
      for (const summary of summaries) {
        if (summary.sessionId !== summary.rootSessionId || summary.goal?.status !== "active") continue;
        await reconcileActiveGoal({
          workspaceRoot,
          projectSlug,
          rootSessionId: summary.sessionId,
          force: true,
        });
      }
    }

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
          const target = await validateSessionToolBatchResponse({
            registry: toolRegistry,
            storeManager: sessionStoreManager,
            workspaceRoot,
            sessionId: dispatching.owner.id,
            hitlId: dispatching.hitlId,
            requestKey: dispatching.requestKey,
            response: dispatching.response!,
          });
          await executionManager.awaitExactRunBoundary(
            workspaceRoot,
            dispatching.owner.id,
            target.executionId,
          );
          await applySessionToolBatchResponse({
            registry: toolRegistry,
            storeManager: sessionStoreManager,
            workspaceRoot,
            sessionId: dispatching.owner.id,
            hitlId: dispatching.hitlId,
            requestKey: dispatching.requestKey,
            response: dispatching.response!,
            logger: runtimeLogger,
          });

          const execution = await executionManager.reconcileDurableSession({
            slug: projectSlug,
            workspaceRoot,
            sessionId: dispatching.owner.id,
          });
          const applied = await context.hitl.resolve(dispatching.hitlId, { type: "applied" });
          if (execution === undefined) {
            runtimeLogger.debug("session.execution.resume_deferred", {
              context: redactionPolicy.redactValue({
                projectSlug,
                sessionId: applied.owner.id,
                hitlId: applied.hitlId,
              }),
            });
          }
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
          const batch = state.toolBatches.find((candidate) =>
            candidate.archivedAt === undefined
            && candidate.calls.some((candidateCall) => candidateCall.toolCallId === call.toolCallId)
          );
          if (batch === undefined) {
            throw new Error(`Cannot settle cancelled tool call ${call.toolCallId} without its active Tool Batch`);
          }
          const outcome = await toolRegistry.settleSystem(
            call,
            createToolExecutionContext({
              store,
              storeManager: sessionStoreManager,
              toolName: call.toolName,
              toolCallId: call.toolCallId,
              input: call.input,
              step,
              executionId: batch.executionId,
              runOrdinal: batch.runOrdinal,
              toolBatchId: batch.batchId,
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
        logger: runtimeLogger,
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
        if (record.delivery?.error !== undefined && record.delivery.retryAt === undefined) {
          throw new Error(`Answered HITL ${record.hitlId} exhausted delivery attempts`);
        }
        const delivered = await dispatchAnsweredHitl(workspaceRoot, projectSlug, record);
        if (delivered.status === "answered") {
          throw new Error(`Startup could not apply answered HITL ${delivered.hitlId}`);
        }
      }
    }

    async function continueRunnableToolBatches(
      workspaceRoot: string,
      projectSlug: string,
    ): Promise<void> {
      const summaries = await sessionStoreManager.listAllSessionSummaries(workspaceRoot);
      const hitlQueue = (await contextResolver.resolve(workspaceRoot)).hitl;
      for (const summary of summaries) {
        const store = await sessionStoreManager.getOrLoad(summary.sessionId, workspaceRoot);
        const activeBatch = store.getState().toolBatches.find((batch) => batch.archivedAt === undefined);
        if (activeBatch !== undefined) {
          await repairSessionToolBatchHitlIds({
            store,
            storeManager: sessionStoreManager,
            workspaceRoot,
            hitlQueue,
            batchId: activeBatch.batchId,
          });
        }
        await executionManager.reconcileDurableSession({
          slug: projectSlug,
          workspaceRoot,
          sessionId: summary.sessionId,
        });
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
        let accepted: MessageAcceptance | undefined;
        if (input.source === "user") {
          const agent = await sessionAgentManager.getOrCreate(input.workspaceRoot, input.sessionId);
          const command = agent.classifyCommand(input.text);
          if (command !== null) {
            if (input.attachmentIds.length > 0) {
              throw new SessionInputConflictError(
                "state",
                "Slash commands cannot include attachments",
              );
            }
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
            const skillActivation = command.name === "skill"
              ? normalizeSkillUseArgs(command.args)
              : null;
            if (skillActivation !== null) {
              const skillInput = { ...replayInput, activation: skillActivation };
              const replay = await sessionInputService.getSkillCommandReplay(skillInput);
              if (replay !== undefined) {
                accepted = replay;
              } else {
                const definition = defaultAgentDefinitions.find(({ name }) => name === state.agentName);
                if (definition === undefined) throw new Error(`Unknown Agent definition: ${state.agentName}`);
                const validation = await validateSkillActivation({
                  skillService,
                  cwd: state.cwd,
                  agentName: definition.name,
                  agentSkills: definition.skills,
                  activation: skillActivation,
                });
                if (validation.success) {
                  let commandRun;
                  try {
                    commandRun = await executionManager.runSessionCommand({
                      workspaceRoot: input.workspaceRoot,
                      sessionId: input.sessionId,
                      clientRequestId: input.clientRequestId,
                      requestedModelSelection: input.requestedModelSelection,
                    }, async (_binding, signal): Promise<MessageAcceptance> => {
                      if ((await sessionStoreManager.listSessionFamilyToolBatchHitlIds(
                        input.workspaceRoot,
                        input.sessionId,
                      )).length > 0) {
                        throw new SessionCommandConflictError(input.sessionId);
                      }
                      signal.throwIfAborted();
                      return await sessionInputService.acceptSkillCommandMessage(skillInput);
                    });
                  } catch (error) {
                    if (error instanceof SessionFamilyActiveError
                      || error instanceof SessionFamilyStopInProgressError
                      || error instanceof SessionDeleteInProgressError) {
                      throw new SessionCommandConflictError(input.sessionId);
                    }
                    throw error;
                  }
                  if (commandRun.kind === "joined") {
                    const joinedReplay = await sessionInputService.getSkillCommandReplay(skillInput);
                    if (joinedReplay === undefined) {
                      if (commandRun.error !== undefined) throw commandRun.error;
                      throw new SessionCommandOutcomeError(
                        input.sessionId,
                        input.clientRequestId,
                        "indeterminate",
                        "Skill activation outcome is unknown and cannot be replayed safely",
                      );
                    }
                    accepted = joinedReplay;
                  } else {
                    accepted = commandRun.result;
                  }
                }
              }
            }
            if (accepted === undefined) {
              const existingReplay = await sessionInputService.getCommandReplay(replayInput);
              if (existingReplay !== undefined
                && !(existingReplay.kind === "command" && existingReplay.status === "executing")) {
                const replayAcceptance = settledAcceptance(existingReplay);
                if (replayAcceptance.status === "command") {
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
                      executionSkillNames: result.executionSkillNames,
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
                  return commandAcceptance;
                }
                accepted = commandAcceptance;
              }
            }
          }
        }

        accepted ??= await sessionInputService.acceptMessage({
          sessionId: input.sessionId,
          workspaceRoot: input.workspaceRoot,
          text: input.text,
          attachmentIds: input.attachmentIds,
          clientRequestId: input.clientRequestId,
          source: input.source,
          requestedModelSelection: input.requestedModelSelection,
        });
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
            await reconcileActiveGoal({
              projectSlug,
              workspaceRoot: change.workspaceRoot,
              rootSessionId: change.rootSessionId,
              force: false,
            });
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
            const session = await readProjectedSessionModels(
              input.workspaceRoot,
              input.sessionId,
            );
            const accepted = await acceptSessionMessage({
              ...input,
              attachmentIds: [],
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
        runRuntimeMutation: (workspaceRoot, operation) => (
          executionManager.runRuntimeMutation(workspaceRoot, operation)
        ),
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

    async function listAutomationInventory(workspaceRoot: string): Promise<ProjectAutomationInventoryItem[]> {
      return await (await getAutomationRuntimeServices(workspaceRoot)).scheduler.listInventory();
    }

    async function readAutomation(workspaceRoot: string, automationId: string): Promise<Automation> {
      return await (await getAutomationRuntimeServices(workspaceRoot)).scheduler.readAutomation(automationId);
    }

    async function createAutomation(
      workspaceRoot: string,
      input: SessionAutomationCreateInput,
    ): Promise<Automation> {
      const project = await projectRegistry.getByWorkspace(workspaceRoot);
      if (project === undefined) throw new Error(`Project is not registered: ${workspaceRoot}`);
      const sourceSession = await assertResourceCreationSource(workspaceRoot, input.sourceSessionId);
      await assertAutomationWorktreeSupported(workspaceRoot, input.action);
      const { sourceSessionId: _, ...definition } = input;
      const todoId = sourceSession.source === undefined
        ? undefined
        : rootSessionSourceTodoId(sourceSession.source);
      const automation = await (await getAutomationRuntimeServices(workspaceRoot)).scheduler.createAutomation({
        ...definition,
        projectSlug: project.slug,
        origin: todoId !== undefined
          ? {
            kind: "todo",
            todoId,
            sessionId: sourceSession.sessionId,
          }
          : { kind: "session", sessionId: sourceSession.sessionId },
      });
      return automation;
    }

    async function createDirectAutomation(
      workspaceRoot: string,
      input: RuntimeAutomationDefinitionInput,
    ): Promise<Automation> {
      const project = await projectRegistry.getByWorkspace(workspaceRoot);
      if (project === undefined) throw new Error(`Project is not registered: ${workspaceRoot}`);
      await assertAutomationWorktreeSupported(workspaceRoot, input.action);
      return await (await getAutomationRuntimeServices(workspaceRoot)).scheduler.createAutomation({
        ...input,
        projectSlug: project.slug,
        origin: { kind: "direct" },
      });
    }

    async function assertResourceCreationSource(
      workspaceRoot: string,
      sessionId: string,
    ): Promise<SessionFile> {
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
        || session.agentName !== "lead"
      ) {
        throw new ResourceCreationSourceError(
          sessionId,
          `Creation source Session ${sessionId} must be an ordinary root Lead Session`,
        );
      }
      return session;
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
        if (executionManager.getSessionFamilyActivity(workspaceRoot, summary.sessionId) !== "idle") continue;
        await executionManager.tryStartQueuedExecution({
          slug: projectSlug,
          workspaceRoot,
          sessionId: summary.sessionId,
        });
      }
    }

    async function replayExecutionSettlements(workspaceRoot: string): Promise<void> {
      for (const settlement of await sessionStoreManager.listUnappliedExecutionSettlements(workspaceRoot)) {
        const rootSessionId = await sessionStoreManager.resolveRootSessionId(
          settlement.sessionId,
          workspaceRoot,
        );
        if (settlement.goalInstanceId !== null) {
          await sessionGoalService.recordSettlement({
            workspaceRoot,
            sessionId: rootSessionId,
            authority: { kind: "runtime" },
            settlementKey: settlement.key,
            goalInstanceId: settlement.goalInstanceId,
            usage: "terminal" in settlement ? zeroNormalizedUsage() : settlement.usageDelta,
            executionTimeMs: "terminal" in settlement ? 0 : settlement.durationMs,
            terminal: "terminal" in settlement,
          });
        }
        await sessionStoreManager.markExecutionSettlementApplied(
          settlement.sessionId,
          workspaceRoot,
          "terminal" in settlement
            ? {
                executionId: settlement.executionId,
                terminal: true,
                expectedKey: settlement.key,
              }
            : {
                executionId: settlement.executionId,
                runOrdinal: settlement.runOrdinal,
                expectedKey: settlement.key,
              },
        );
      }
    }

    async function recoverSessionContinuations(): Promise<void> {
      const projects = await projectRegistry.list();
      await Promise.all(
        projects.map(async (project) => {
          projectSlugsByWorkspace.set(project.workspaceRoot, project.slug);
          await contextResolver.resolve(project.workspaceRoot);
          await replayExecutionSettlements(project.workspaceRoot);
          await continueRunnableToolBatches(project.workspaceRoot, project.slug);
          await reconcileAnsweredHitl(project.workspaceRoot, project.slug);
          await continueRunnableToolBatches(project.workspaceRoot, project.slug);
          await recoverQueuedSessionInputs(project.workspaceRoot, project.slug);
          await reconcileAllActiveGoals(project.workspaceRoot, project.slug);
        }),
      );
    }

    function scheduleProjectReconciliationRetry(
      workspaceRoot: string,
      projectSlug: string,
      error: unknown,
      context: { readonly sessionId?: string; readonly rootSessionId?: string } = {},
    ): void {
      const key = `${workspaceRoot}\0${projectSlug}`;
      if (reconciliationShuttingDown || cancelledReconcileWorkspaces.has(workspaceRoot)) {
        projectReconcileRetries.delete(key);
        throw error;
      }
      if (projectReconcileRetries.get(key)?.timer !== undefined) return;
      const attempt = (projectReconcileRetries.get(key)?.attempt ?? 0) + 1;
      const delay = Math.min(100 * 2 ** (attempt - 1), 30_000);
      const retry: { attempt: number; timer?: ReturnType<typeof setTimeout> } = { attempt };
      retry.timer = setTimeout(() => {
        retry.timer = undefined;
        if (reconciliationShuttingDown || cancelledReconcileWorkspaces.has(workspaceRoot)) {
          projectReconcileRetries.delete(key);
          return;
        }
        void reconcileRegisteredProject(workspaceRoot, projectSlug).catch((retryError) => {
          runtimeLogger.error("project.runtime.reconcile_retry_unavailable", {
            error: retryError,
            context: { projectSlug },
            meta: { workspaceRoot },
          });
        });
      }, delay);
      retry.timer.unref?.();
      projectReconcileRetries.set(key, retry);
      runtimeLogger.warn("project.runtime.reconcile_failed", {
        error,
        context: { projectSlug, ...context },
        meta: { workspaceRoot, attempt, retryDelayMs: delay },
      });
    }

    async function reconcileRegisteredProject(
      workspaceRoot: string,
      projectSlug: string,
      releaseContext: {
        readonly sessionId?: string;
        readonly rootSessionId?: string;
      } = {},
    ): Promise<void> {
      const key = `${workspaceRoot}\0${projectSlug}`;
      const registered = await projectRegistry.get(projectSlug);
      if (registered?.workspaceRoot !== workspaceRoot) {
        projectReconcileRetries.delete(key);
        return;
      }
      cancelledReconcileWorkspaces.delete(workspaceRoot);
      if (reconciliationShuttingDown) {
        throw new Error(`Cannot reconcile project ${projectSlug} during Runtime shutdown`);
      }
      if (projectReconcileRetries.get(key)?.timer !== undefined) return;
      if (projectReconcileInFlight.has(key)) {
        scheduleProjectReconciliationRetry(
          workspaceRoot,
          projectSlug,
          new Error(`Project reconciliation for ${projectSlug} is already in flight`),
          releaseContext,
        );
        return;
      }
      projectReconcileInFlight.add(key);
      try {
        projectSlugsByWorkspace.set(workspaceRoot, projectSlug);
        await contextResolver.resolve(workspaceRoot);
        await replayExecutionSettlements(workspaceRoot);
        await continueRunnableToolBatches(workspaceRoot, projectSlug);
        await reconcileAnsweredHitl(workspaceRoot, projectSlug);
        await continueRunnableToolBatches(workspaceRoot, projectSlug);
        await recoverQueuedSessionInputs(workspaceRoot, projectSlug);
        await reconcileAllActiveGoals(workspaceRoot, projectSlug);
        projectReconcileRetries.delete(key);
      } catch (error) {
        scheduleProjectReconciliationRetry(workspaceRoot, projectSlug, error);
      } finally {
        projectReconcileInFlight.delete(key);
      }
    }

    async function stopAutomationSchedulers(): Promise<void> {
      automationSchedulersStarted = false;
      const entries = [...automationRuntimeServices.entries()];
      const services = await Promise.allSettled(entries.map(([, service]) => service));
      const errors: unknown[] = [];
      for (const [index, result] of services.entries()) {
        const [workspaceRoot, service] = entries[index]!;
        if (result.status === "rejected") {
          errors.push(result.reason);
          continue;
        }
        try {
          result.value.scheduler.dispose();
          if (automationRuntimeServices.get(workspaceRoot) === service) {
            automationRuntimeServices.delete(workspaceRoot);
          }
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "Automation scheduler shutdown failed");
      }
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
      const entries = await toGlobalHitlEntries(workspaceRoot, projectSlug, views);
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
          entries,
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
    type ShutdownStep = {
      completed: boolean;
      readonly operation: () => void | Promise<void>;
    };
    const shutdownSteps: ShutdownStep[] = [
      { completed: false, operation: stopAutomationSchedulers },
      { completed: false, operation: shutdownReconciliation },
      {
        completed: false,
        operation: () => internalOptions.executionManagerShutdown !== undefined
          ? internalOptions.executionManagerShutdown()
          : executionManager.shutdown(),
      },
      { completed: false, operation: () => toolOutputArtifactStore.dispose() },
      { completed: false, operation: () => activeMcpRuntime.close() },
      {
        completed: false,
        operation: () => internalOptions.sessionAgentManagerDisposeAll !== undefined
          ? internalOptions.sessionAgentManagerDisposeAll()
          : sessionAgentManager.disposeAll(),
      },
    ];
    let shutdownPromise: Promise<void> | undefined;
    const shutdown = (): Promise<void> => {
      if (shutdownPromise !== undefined) return shutdownPromise;

      const currentShutdown = (async () => {
        const errors: unknown[] = [];
        const attempt = async (step: ShutdownStep): Promise<void> => {
          if (step.completed) return;
          try {
            await step.operation();
            step.completed = true;
          } catch (error) {
            errors.push(error);
          }
        };

        for (const step of shutdownSteps) await attempt(step);

        if (errors.length > 0) {
          throw new AggregateError(errors, "AgentRuntime shutdown failed");
        }
      })();
      shutdownPromise = currentShutdown;
      void currentShutdown.then(
        () => undefined,
        () => {
          if (shutdownPromise === currentShutdown) shutdownPromise = undefined;
        },
      );
      return currentShutdown;
    };

    return {
      toolRegistry,
      modelRuntime,
      skillService,
      configService,
      projectRegistry,
      contextResolver,
      listAgentDescriptors: () => defaultAgentDefinitions.map(({ name, displayName }) => ({ name, displayName })),
      getSessionSkillCatalog: async (workspaceRoot, sessionId, cursor) => {
        const state = (await sessionStoreManager.getOrLoad(sessionId, workspaceRoot)).getState();
        const definition = defaultAgentDefinitions.find(({ name }) => name === state.agentName);
        if (definition === undefined) throw new Error(`Unknown Agent definition: ${state.agentName}`);
        const [page, promptProjection] = await Promise.all([
          skillService.inventoryPage(state.cwd, cursor, definition.skills),
          skillService.projectPromptCatalog(state.cwd, definition.skills),
        ]);
        return {
          items: page.items.map((item) => ({
            name: item.name,
            source: item.source,
            winner: item.winner,
            shadowed: item.shadowed,
            valid: item.valid,
            ...(item.description === undefined ? {} : { description: item.description }),
            ...(item.diagnostic === undefined ? {} : {
              diagnostic: {
                code: item.diagnostic.code,
                message: item.diagnostic.message,
              },
            }),
          })),
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
          promptProjection,
        };
      },
      removeProject,
      respondToHitl,
      cancelHitl,
      listHitlSnapshotEvents: async () => {
        const projects = await projectRegistry.list();
        const entries: GlobalSSEHitlEntry[] = [];
        for (const project of projects) {
          const context = await contextResolver.resolve(project.workspaceRoot);
          const views = (await context.hitl.list({ statuses: ["pending", "answered"] }))
            .filter((record) => record.status === "pending" || requiresInspection(record))
            .map(toHitlView);
          entries.push(...await toGlobalHitlEntries(project.workspaceRoot, project.slug, views));
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
      subscribeMcpStatusChanges: (listener) => activeMcpRuntime.onStatusChange(listener),
      getMcpServerStatus: () => activeMcpRuntime.getStatus(),
      getMcpServerInventory: () => activeMcpRuntime.getInventory(),
      applyMcpConfig: (nextConfig) => activeMcpRuntime.apply(nextConfig),
      testMcpServerDraft: async (serverName, request, options) => {
        const draft = await configService.resolveMcpDraft(request);
        const serverConfig = draft.servers[serverName]
          ?? BUILTIN_MCP_SERVERS[serverName as keyof typeof BUILTIN_MCP_SERVERS];
        if (serverConfig === undefined) {
          throw new Error(`MCP server "${serverName}" is not configured`);
        }
        return await activeMcpRuntime.testServer(serverName, serverConfig, options);
      },
      reconnectMcpServer: (serverName) => activeMcpRuntime.reconnect(serverName),
      uploadSessionAttachment: (input) => sessionAttachmentService.upload(input),
      openSessionAttachment: (input) => sessionAttachmentService.openDownload(input),
      createSession: async (workspaceRoot, createOptions) => {
        assertRuntimeSessionAgentScope(createOptions);
        return await executionManager.runRuntimeMutation(
          workspaceRoot,
          async () => {
            const file = await sessionStoreManager.createSessionFile(
              workspaceRoot,
              createOptions,
            );
            return await readProjectedSessionModels(workspaceRoot, file.sessionId);
          },
        );
      },
      getSessionFile: async (workspaceRoot, sessionId) => {
        await sessionStoreManager.flushSession(sessionId, workspaceRoot);
        return await readProjectedSessionModels(workspaceRoot, sessionId);
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
          const cleared = await executionManager.tryRunSessionFamilyControl({
            workspaceRoot: input.workspaceRoot,
            rootSessionId: input.sessionId,
          }, async () => {
            await sessionGoalService.assertNoPendingFamilySettlements(target);
            await sessionGoalService.clear(target);
          });
          if (cleared.kind === "blocked") {
            const activity = executionManager.getSessionFamilyActivity(input.workspaceRoot, input.sessionId);
            throw new SessionFamilyActiveError(
              input.sessionId,
              input.sessionId,
              activity === "stopping" ? "stopping" : "running",
            );
          }
        } else {
          await sessionGoalService.setTokenBudget({ ...target, tokenBudget: input.tokenBudget });
        }
        if (input.action !== "pause" && input.action !== "clear") {
          const projectSlug = projectSlugsByWorkspace.get(input.workspaceRoot);
          if (projectSlug !== undefined
            && executionManager.getSessionFamilyActivity(input.workspaceRoot, input.sessionId) === "idle") {
            void reconcileActiveGoal({
              workspaceRoot: input.workspaceRoot,
              projectSlug,
              rootSessionId: input.sessionId,
              force: true,
            }).catch((error) => runtimeLogger.warn("session-goal.control.reconcile_failed", {
              error,
              context: { sessionId: input.sessionId, action: input.action },
            }));
          }
        }
        return await readProjectedSessionModels(input.workspaceRoot, input.sessionId);
      },
      getSessionModelState: async (workspaceRoot, sessionId) => {
        const projected = await readProjectedSessionModels(workspaceRoot, sessionId);
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
        const projected = await readProjectedSessionModels(input.workspaceRoot, input.sessionId);
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
      listSessionInventory: (workspaceRoot) => sessionStoreManager.listSessionInventory(workspaceRoot),
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
      deleteSession: async (workspaceRoot, sessionId) => {
        let file: SessionFile;
        try {
          file = await sessionStoreManager.getSessionFile(workspaceRoot, sessionId);
        } catch {
          // SessionExecutionManager remains the deletion/error owner.
          await executionManager.deleteSession(workspaceRoot, sessionId);
          return;
        }
        const rootSessionId = file.rootSessionId;
        const tree = await sessionStoreManager.buildSessionTree(workspaceRoot, rootSessionId);
        const deletedSessionIds = new Set(collectSessionTreeIds(tree.root, sessionId));
        const automationReferences = (await listAutomations(workspaceRoot))
          .filter((automation) => (
            automation.action.kind === "send_message"
            && deletedSessionIds.has(automation.action.sessionId)
          ))
          .map(({ id, name }) => ({ id, name }))
          .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
        if (automationReferences.length > 0) {
          throw new SessionAutomationReferenceConflictError(sessionId, automationReferences);
        }

        if (file.parentSessionId !== undefined || file.rootSessionId !== sessionId) {
          await executionManager.deleteSession(workspaceRoot, sessionId);
          return;
        }

        await sessionAttachmentService.withRootDeletionLease(
          workspaceRoot,
          sessionId,
          async () => {
            await executionManager.deleteSession(workspaceRoot, sessionId);
            try {
              await sessionAttachmentService.cleanupRootAttachments(workspaceRoot, sessionId);
            } catch (error) {
              runtimeLogger.warn("session.attachments.cleanup_failed", {
                context: { rootSessionId: sessionId },
                meta: {
                  errorName: error instanceof Error ? error.name : "UnknownError",
                },
              });
            }
          },
        );
        await publishSessionResourceChanged(workspaceRoot, rootSessionId);
      },
      listSessionTree: (workspaceRoot, rootSessionId) => sessionStoreManager.buildSessionTree(workspaceRoot, rootSessionId),
      disposeSessionAgent: (workspaceRoot, sessionId) => sessionAgentManager.dispose(workspaceRoot, sessionId),
      disposeAllSessionAgents: () => sessionAgentManager.disposeAll(),
      isSessionTombstoned: (workspaceRoot, sessionId) => sessionAgentManager.isTombstoned(workspaceRoot, sessionId),
      listAutomations,
      listAutomationInventory,
      readAutomation,
      createAutomation,
      createDirectAutomation,
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
      reconcileRegisteredProject,
      stopAutomationSchedulers,
      prepareForRestart: () => executionManager.closeAdmissionIfIdle(),
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
    if (mcpRuntime !== undefined) await mcpRuntime.close();
    await toolOutputArtifactStore.dispose();
    throw err;
  }
}

function assertRuntimeSessionAgentScope(options: CreateRuntimeSessionOptions): void {
  if (options.agentName !== "lead") {
    throw new Error(`Ordinary Session creation requires agentName "lead", got "${options.agentName}"`);
  }
}

function projectRootSessionSummary(file: SessionFile): RootSessionSummary {
  if (file.parentSessionId !== undefined || file.rootSessionId !== file.sessionId || file.source === undefined) {
    throw new Error(`Session ${file.sessionId} is not a sourced root Session`);
  }
  return {
    sessionId: file.sessionId,
    cwd: file.cwd,
    rootSessionId: file.rootSessionId,
    source: file.source,
    agentName: file.agentName,
    profile: resolveSessionProfile(file),
    activeSkillNames: file.activeSkillNames,
    modelSelection: file.modelSelection,
    title: file.title,
    ...(file.goal === undefined ? {} : { goal: file.goal }),
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}

function zeroNormalizedUsage(): NormalizedUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
  };
}
