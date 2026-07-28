import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createEmptySessionStats,
  isTerminalChildSessionStatus,
  type DelegationRequest,
  type SessionExecutionSuspension,
  type SessionExecutionTerminalStatus,
} from "@archcode/protocol";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { StoreApi } from "zustand";
import type { Agent, AgentCommand, AgentCommandResult, AgentResult, AgentRunOptions } from "../agents/types";
import type { AgentName } from "../agents/names";
import { ConfiguredAgent } from "../agents/configured-agent";
import { buildAgentDefinition, leadAgentDefinition, exploreAgentDefinition } from "../agents/definitions";
import { ProviderRegistry } from "../provider";
import { ModelInfo } from "../provider/model";
import { SkillService } from "../skills";
import { createTestProjectContextResolver } from "../agents/test-project-context-resolver";
import { createTestToolRegistryFixture } from "../tools/test-registry";
import { testExecutionEnd, testExecutionRecord, testExecutionStart, testExecutionSuspended } from "../testing/test-execution-fixtures";
import { applySessionToolBatchChildOutcome } from "./session-tool-batch-scheduler";
import { setLlmAdapterForTest } from "../llm/adapter";
import { AgentRunningError, ConcurrentLimitError, DelegateTargetNotAllowedError, DepthLimitError, ChildSessionNotFoundError, ChildSessionParentMismatchError, ChildSessionNotDescendantError, ChildSessionCwdMismatchError, SessionCwdTransitionConflictError, SessionCwdTransitionInProgressError, SessionToolBatchActiveError } from "../agents/errors";
import type { SessionAgentManager } from "../agents/session-agent-manager";
import { NotRootSessionError, SessionDeleteConflictError, SessionFileNotFoundError } from "../store/errors";
import { SessionDeleteInProgressError } from "./session-deletion";
import { SessionFamilyActiveError, SessionFamilyIdentityUnavailableError, SessionFamilyStopInProgressError } from "./session-family-control";
import type { SessionFile } from "../store/helpers";
import { SessionStoreManager } from "../store/session-store-manager";
import { getSessionDir, getSessionPath } from "../store/sessions-dir";
import {
  SessionExecutionManager,
  SessionExecutionManagerShuttingDownError,
  SessionSteerUnavailableError,
  type SessionExecutionDeadlineHandle,
  type SessionExecutionDeadlineScheduler,
  type StartSessionExecutionInput,
} from "./session-execution-manager";
import { SessionExecutionScopeConflictError } from "./session-execution-scope-validator";
import { SessionWorkspaceClosingError } from "./session-workspace-control";
import { silentLogger } from "../logger";
import type { SessionStoreState, SessionToolBatch, ToolChildSessionLink } from "../store/types";
import type { AgentFactory } from "../agents/factory";
import type { AgentDefinition } from "../agents/factory-types";
import { createEmptyCompressionState } from "../compression";
import { SessionInputConflictError, SessionInputService } from "../session-input/service";
import type { ArchCodeConfig, ModelConfig } from "../config";
import type { ExecutionModelBinding } from "../models";
import { ModelRuntime, ModelRuntimeSnapshot, ModelSelectionResolver } from "../models";
import type { ChildExecutionRequest, ResumeChildRequest } from "../delegation/types";

const testRoot = join(
  tmpdir(),
  `session-execution-manager-${crypto.randomUUID()}`,
);
const toolRegistryFixture = createTestToolRegistryFixture();
let workspaceRoot = join(testRoot, "bootstrap");
let defaultAgentWorkspaceRoot = workspaceRoot;
class TestSessionStoreManager extends SessionStoreManager {
  override create(
    sessionId: string,
    root: string,
    options: Parameters<SessionStoreManager["create"]>[2],
  ) {
    const normalizedOptions = options;
    if (normalizedOptions.parentSessionId === undefined || normalizedOptions.delegationRequest !== undefined) {
      return super.create(sessionId, root, normalizedOptions);
    }
    const request = delegationRequest({
      agent_type: normalizedOptions.agentName === "build" ? "build" : "explore",
      title: normalizedOptions.title ?? "Delegated child",
    });
    return super.create(sessionId, root, {
      ...normalizedOptions,
      delegationRequest: request,
    });
  }
}

const storeManager = new TestSessionStoreManager({ logger: silentLogger });
const TEST_REQUESTED_MODEL_SELECTION = {
  mode: "profile_default" as const,
  selection: { model: "test:model" },
};
const TEST_BINDING_SUMMARY = {
  selection: { model: "test:model" }, providerId: "test", modelId: "model",
  providerDisplayName: "Test Provider", modelDisplayName: "Test Model",
  resolution: "profile_default" as const, modelRuntimeRevision: "test-runtime-1",
};
interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolveValue: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return { promise, resolve: resolveValue };
}

interface TestDeadlineScheduler extends SessionExecutionDeadlineScheduler {
  fireScheduled(): void;
  whenScheduled(): Promise<void>;
  scheduledDelays(): readonly number[];
}

function createTestDeadlineScheduler(): TestDeadlineScheduler {
  let currentTime = 0;
  let nextId = 1;
  const scheduled = new Map<number, () => void>();
  const scheduledDelayHistory: number[] = [];
  const scheduleWaiters = new Set<() => void>();

  return {
    now: () => currentTime,
    sleep: async (delayMs) => {
      currentTime += delayMs;
    },
    schedule: (delayMs, callback) => {
      const id = nextId++;
      scheduledDelayHistory.push(delayMs);
      scheduled.set(id, callback);
      for (const resolve of scheduleWaiters) resolve();
      scheduleWaiters.clear();
      return { id };
    },
    cancel: (handle: SessionExecutionDeadlineHandle) => {
      if (typeof handle.id === "number") scheduled.delete(handle.id);
    },
    fireScheduled: () => {
      const callbacks = [...scheduled.values()];
      scheduled.clear();
      for (const callback of callbacks) callback();
    },
    whenScheduled: async () => {
      if (scheduled.size > 0) return;
      await new Promise<void>((resolve) => scheduleWaiters.add(resolve));
    },
    scheduledDelays: () => scheduledDelayHistory,
  };
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return await promise;
  signal.throwIfAborted();
  return await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }),
  ]);
}

function getUserMessageTexts(state: SessionStoreState): string[] {
  return state.messages
    .filter((message) => message.role === "user")
    .map((message) => message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""));
}

function delegationRequest(overrides: Partial<DelegationRequest> = {}): DelegationRequest {
  const agentType = overrides.agent_type ?? "explore";
  return {
    agent_type: agentType,
    profile: overrides.profile ?? (agentType === "build" || agentType === "analyst" ? "deep" : "fast"),
    title: "Delegated child",
    objective: "Inspect the delegated scope",
    skills: [],
    background: false,
    ...overrides,
  };
}

function createTestSession(
  manager: SessionStoreManager,
  sessionId: string,
  root: string,
  options: Parameters<SessionStoreManager["create"]>[2],
) {
  const normalizedOptions = options;
  if (normalizedOptions.parentSessionId === undefined || normalizedOptions.delegationRequest !== undefined) {
    return manager.create(sessionId, root, normalizedOptions);
  }
  const request = delegationRequest({
    agent_type: normalizedOptions.agentName === "build" ? "build" : "explore",
    title: normalizedOptions.title ?? "Delegated child",
  });
  return manager.create(sessionId, root, {
    ...normalizedOptions,
    delegationRequest: request,
  });
}

type MockAgentResult = {
  readonly text: string;
  readonly steps: number;
  readonly outcome?: "terminal" | "suspended";
  readonly status?: SessionExecutionTerminalStatus;
  readonly suspension?: Exclude<SessionExecutionSuspension, { kind: "resume_pending" }>;
  readonly error?: string;
  readonly cwdChanged?: AgentResult["cwdChanged"];
};

function normalizeMockAgentResult(result: MockAgentResult): AgentResult {
  if (result.outcome === "suspended") {
    if (result.suspension === undefined) throw new Error("Suspended mock result requires a suspension");
    return {
      outcome: "suspended",
      text: result.text,
      steps: result.steps,
      suspension: result.suspension,
      ...(result.cwdChanged === undefined ? {} : { cwdChanged: result.cwdChanged }),
    };
  }
  return {
    outcome: "terminal",
    text: result.text,
    steps: result.steps,
    status: result.status ?? "completed",
    ...(result.error === undefined ? {} : { error: result.error }),
    ...(result.cwdChanged === undefined ? {} : { cwdChanged: result.cwdChanged }),
  };
}

class MockAgent implements Agent {
  readonly store;
  readonly cwd: string;
  readonly runStarted = deferred<void>();
  readonly disposeMock = mock(() => undefined);
  readonly runBindings: ExecutionModelBinding[] = [];
  readonly runMock = mock(async (options: AgentRunOptions): Promise<AgentResult> => {
    this.runStarted.resolve(undefined);
    const signal = options.abort;
    const result = await withAbort(this.result, signal);
    this.store.getState().append({ type: "text-start" });
    this.store.getState().append({ type: "text-delta", text: result.text });
    this.store.getState().append({ type: "text-end" });
    return normalizeMockAgentResult(result);
  });

  constructor(
    readonly sessionId: string,
    readonly result: Promise<MockAgentResult>,
    readonly workspaceRoot: string = defaultAgentWorkspaceRoot,
    sessionStores: SessionStoreManager = storeManager,
  ) {
    this.store = createTestSession(sessionStores, sessionId, workspaceRoot, { agentName: "lead" });
    this.cwd = this.store.getState().cwd;
  }

  classifyCommand(_input: string): AgentCommand | null {
    return null;
  }

  async executeCommand(_command: AgentCommand): Promise<AgentCommandResult> {
    return { kind: "handled" };
  }

  run(binding: ExecutionModelBinding, options?: AgentRunOptions): Promise<AgentResult> {
    this.runBindings.push(binding);
    if (options === undefined) throw new Error("Execution identity is required");
    return this.runMock(options);
  }

  dispose(): void { this.disposeMock(); }
}

interface FakeManagerOptions {
  storeManager?: SessionStoreManager;
  factory?: AgentFactory;
  childRun?: Promise<MockAgentResult>;
  childRunStarted?: () => void;
  childCanonicalMessage?: (message: string) => void;
  childRunOptions?: (options: AgentRunOptions | undefined) => void;
  getAgent?: (sessionId: string) => Agent;
  onReleaseAgent?: (sessionId: string) => void;
  executionScopeValidator?: ConstructorParameters<typeof SessionExecutionManager>[0]["executionScopeValidator"];
  deletionLifecycle?: ConstructorParameters<typeof SessionExecutionManager>[0]["deletionLifecycle"];
  flushSessionStore?: ConstructorParameters<typeof SessionExecutionManager>[0]["flushSessionStore"];
  loadSessionStore?: ConstructorParameters<typeof SessionExecutionManager>[0]["loadSessionStore"];
  createSessionStore?: ConstructorParameters<typeof SessionExecutionManager>[0]["createSessionStore"];
  listSessionFamilyToolBatchHitlIds?: ConstructorParameters<typeof SessionExecutionManager>[0]["listSessionFamilyToolBatchHitlIds"];
  cancelSessionToolBatch?: ConstructorParameters<typeof SessionExecutionManager>[0]["cancelSessionToolBatch"];
  isDiscussionSession?: ConstructorParameters<typeof SessionExecutionManager>[0]["isDiscussionSession"];
  resolveSessionDepth?: ConstructorParameters<typeof SessionExecutionManager>[0]["resolveSessionDepth"];
  sessionInputService?: ConstructorParameters<typeof SessionExecutionManager>[0]["sessionInputService"];
  sessionFamilyStopTimeoutMs?: number;
  deadlineScheduler?: TestDeadlineScheduler;
  modelRuntime?: ModelRuntime;
  applyChildDependencyOutcome?: ConstructorParameters<typeof SessionExecutionManager>[0]["applyChildDependencyOutcome"];
  resolveGoalInstanceId?: ConstructorParameters<typeof SessionExecutionManager>[0]["resolveGoalInstanceId"];
  onExecutionSettlement?: ConstructorParameters<typeof SessionExecutionManager>[0]["onExecutionSettlement"];
  onSessionInputMutationReleased?: ConstructorParameters<typeof SessionExecutionManager>[0]["onSessionInputMutationReleased"];
  onContinuationAdmissionReleased?: ConstructorParameters<typeof SessionExecutionManager>[0]["onContinuationAdmissionReleased"];
  /**
   * Lets the small execution harness use a real ConfiguredAgent for a child
   * while retaining the rest of its intentionally narrow fake runtime.
   */
  childAgentFactory?: (input: {
    workspaceRoot: string;
    sessionId: string;
    store: MockAgent["store"];
    depth: number;
  }) => MockAgent;
}

const allowExecutionScope = { validate: async () => undefined };

type SessionExecutionManagerConfigForTest = ConstructorParameters<typeof SessionExecutionManager>[0];
type TestChildExecutionRequest = Omit<
  ChildExecutionRequest,
  "parentExecutionId" | "parentRunOrdinal" | "parentToolBatchId" | "childSessionId" | "childExecutionId"
> & Partial<Pick<
  ChildExecutionRequest,
  "parentExecutionId" | "parentRunOrdinal" | "parentToolBatchId" | "childSessionId" | "childExecutionId"
>>;
type TestResumeChildRequest = Omit<
  ResumeChildRequest,
  "parentExecutionId" | "parentRunOrdinal" | "parentToolBatchId" | "childExecutionId"
> & Partial<Pick<
  ResumeChildRequest,
  "parentExecutionId" | "parentRunOrdinal" | "parentToolBatchId" | "childExecutionId"
>>;
type TestSessionExecutionManager = Omit<
  SessionExecutionManager,
  "startChildExecution" | "resumeChildExecution"
> & {
  startChildExecution(
    workspaceRoot: string,
    request: TestChildExecutionRequest,
  ): ReturnType<SessionExecutionManager["startChildExecution"]>;
  resumeChildExecution(
    workspaceRoot: string,
    request: TestResumeChildRequest,
  ): ReturnType<SessionExecutionManager["resumeChildExecution"]>;
};

function testManagerFacade(raw: SessionExecutionManager): TestSessionExecutionManager {
  return new Proxy(raw, {
    get(target, property) {
      if (property === "startChildExecution") {
        return (
          root: string,
          request: TestChildExecutionRequest,
        ) => target.startChildExecution(root, {
          parentExecutionId: "test-parent-execution",
          parentRunOrdinal: 0,
          parentToolBatchId: "test-parent-batch",
          childSessionId: crypto.randomUUID(),
          childExecutionId: crypto.randomUUID(),
          ...request,
        });
      }
      if (property === "resumeChildExecution") {
        return (
          root: string,
          request: TestResumeChildRequest,
        ) => target.resumeChildExecution(root, {
          parentExecutionId: "test-parent-execution",
          parentRunOrdinal: 0,
          parentToolBatchId: "test-parent-batch",
          childExecutionId: crypto.randomUUID(),
          ...request,
        });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as TestSessionExecutionManager;
}

function storeCallbacks(manager: SessionStoreManager): Pick<
  SessionExecutionManagerConfigForTest,
  "createSessionStore" | "flushSessionStore" | "getSessionStore" | "loadSessionStore" | "deleteSessionStore" | "resolveRootSessionId" | "resolveSessionDepth" | "buildSessionTree" | "listSessionFamilyToolBatchHitlIds" | "isDiscussionSession"
> {
  return {
    createSessionStore: (sessionId, root, createOptions) => createTestSession(manager, sessionId, root, createOptions),
    flushSessionStore: (sessionId, root) => manager.flushSession(sessionId, root),
    getSessionStore: (sessionId, root) => manager.get(sessionId, root),
    loadSessionStore: (sessionId, root) => manager.getOrLoad(sessionId, root),
    deleteSessionStore: (sessionId, root, deleteOptions) => manager.delete(sessionId, root, deleteOptions),
    resolveRootSessionId: (sessionId, root) => manager.resolveRootSessionId(sessionId, root),
    resolveSessionDepth: async (root, sessionId) => {
      let depth = 0;
      let state = (manager.get(sessionId, root) ?? await manager.getOrLoad(sessionId, root)).getState();
      const visited = new Set<string>([sessionId]);
      while (state.parentSessionId !== undefined) {
        if (visited.has(state.parentSessionId)) throw new Error("Session parent cycle");
        visited.add(state.parentSessionId);
        depth += 1;
        state = (manager.get(state.parentSessionId, root) ?? await manager.getOrLoad(state.parentSessionId, root)).getState();
      }
      return depth;
    },
    buildSessionTree: (root, rootSessionId) => manager.buildSessionTree(root, rootSessionId),
    listSessionFamilyToolBatchHitlIds: (root, rootSessionId) => manager.listSessionFamilyToolBatchHitlIds(root, rootSessionId),
    isDiscussionSession: async () => false,
  };
}

function createFakeManager(agents: Record<string, MockAgent>, options: FakeManagerOptions = {}): SessionAgentManager {
  const cachedAgents = new Map<string, MockAgent>(Object.entries(agents));
  return {
    getOrCreate: mock(async (_root: string, sessionId: string) => {
      const cached = cachedAgents.get(sessionId);
      if (cached !== undefined) return cached;
      const agent = (options.getAgent?.(sessionId) ?? agents[sessionId]) as MockAgent | undefined;
      if (agent !== undefined) cachedAgents.set(sessionId, agent);
      return agent!;
    }),
    get: mock((_root: string, sessionId: string) => cachedAgents.get(sessionId)),
    getFactory: mock(() => options.factory ?? makeFactory()),
    createChildAgent: mock((input: { workspaceRoot: string; sessionId: string; store: MockAgent["store"]; depth: number }) => {
      const childAgent = options.childAgentFactory?.(input) ?? {
        store: input.store,
        classifyCommand: mock((_input: string) => null),
        executeCommand: mock(async (_command: AgentCommand): Promise<AgentCommandResult> => ({ kind: "handled" })),
        run: mock(async (_binding: ExecutionModelBinding, runOptions?: AgentRunOptions): Promise<AgentResult> => {
          const signal = runOptions?.abort;
          options.childCanonicalMessage?.(getUserMessageTexts(input.store.getState()).at(-1) ?? "");
          options.childRunOptions?.(runOptions);
          options.childRunStarted?.();
          signal?.throwIfAborted();
          const result: MockAgentResult = options.childRun
            ? await withAbort(options.childRun, signal)
            : { text: "child result", steps: 1 };
          input.store.getState().append({ type: "text-start" });
          input.store.getState().append({ type: "text-delta", text: result.text });
          input.store.getState().append({ type: "text-end" });
          return normalizeMockAgentResult(result);
        }),
        dispose: mock(() => undefined),
      } as unknown as MockAgent;
      agents[input.sessionId] = childAgent;
      cachedAgents.set(input.sessionId, childAgent);
      return childAgent;
    }),
    dispose: mock(() => undefined),
    releaseAgent: mock((_root: string, sessionId: string) => {
      cachedAgents.get(sessionId)?.dispose();
      cachedAgents.delete(sessionId);
      options.onReleaseAgent?.(sessionId);
    }),
  } as unknown as SessionAgentManager;
}

function makeFactory(overrides: Partial<AgentFactory> = {}): AgentFactory {
  const parentDefinition: AgentDefinition = {
    ...leadAgentDefinition,
    tools: { tools: ["delegate"], delegateTargets: ["explore"] },
    hooks: { autoCompact: false, autoInjectReminder: false, todoStepReminder: false, todoQueryLoopContinuation: false, memoryExtraction: false, memoryConsolidation: false, titleGeneration: "disabled" },
    childPolicy: { maxDepth: 2, maxConcurrent: 1, timeoutMs: 0, abortCascade: true, terminalReminders: true },
    includeMemoryInPrompt: false,
    skills: [],
  };
  const childDefinition: AgentDefinition = {
    ...parentDefinition,
    name: "explore",
    displayName: "Explore",
    profiles: ["fast"],
    tools: { tools: [] },
    childPolicy: undefined,
  };
  return {
    createRootAgent: mock(() => { throw new Error("unused"); }),
    createAgent: mock(() => { throw new Error("unused"); }),
    getDefinition: mock((name: string) => {
      if (name === "lead") return parentDefinition;
      if (name === "explore") return childDefinition;
      throw new Error(`Unknown agent definition: ${name}`);
    }),
    listAgentNames: mock(() => ["lead", "explore"]),
    resolveAllowedTools: mock((definition: AgentDefinition) => definition.tools.tools),
    getDelegateTargetsFor: mock((definition: AgentDefinition) => definition.tools.delegateTargets ?? []),
    resolveDelegatedSkillNames: mock(async () => []),
    ...overrides,
  } as AgentFactory;
}

function makeFactoryWithChildPolicy(
  policy: Partial<NonNullable<AgentDefinition["childPolicy"]>>,
): AgentFactory {
  const base = makeFactory();
  return makeFactory({
    getDefinition: mock((name: string) => {
      const definition = base.getDefinition(name);
      return name === "lead"
        ? { ...definition, childPolicy: { ...definition.childPolicy!, ...policy } }
        : definition;
    }),
  });
}

function makeBuildFactory(
  policy: Partial<NonNullable<AgentDefinition["childPolicy"]>> = {},
): AgentFactory {
  const base = makeFactory();
  const parentDefinition: AgentDefinition = {
    ...base.getDefinition("lead"),
    tools: { tools: ["delegate"], delegateTargets: ["build"] },
    childPolicy: {
      maxDepth: 2,
      maxConcurrent: 2,
      timeoutMs: 0,
      abortCascade: true,
      terminalReminders: true,
      ...policy,
    },
  };
  return makeFactory({
    getDefinition: mock((name: string) => {
      if (name === "lead") return parentDefinition;
      if (name === "build") return buildAgentDefinition;
      return base.getDefinition(name);
    }),
    listAgentNames: mock(() => ["lead", "build"]),
  });
}

function makeModelRuntime(
  withOtherModel = true,
  agentModel: "test:model" | "test:other" = "test:model",
  revision = "test-runtime-1",
  providerSecretValues: readonly string[] = [],
): ModelRuntime {
  const model: ModelConfig = {
    name: "Test Model",
    limit: { context: 100_000, output: 10_000 },
    modalities: { input: ["text"], output: ["text"] },
  };
  const otherModel: ModelConfig = {
    ...model,
    name: "Other Model",
  };
  const agent = { model: agentModel };
  const config: ArchCodeConfig = {
    provider: {
      test: {
        npm: "@ai-sdk/openai-compatible",
        name: "Test Provider",
        options: { baseURL: "http://localhost.invalid/v1" },
        models: withOtherModel ? { model, other: otherModel } : { model },
      },
    },
    profiles: {
      principal: { ...agent },
      deep: { ...agent },
      fast: { ...agent },
    },
  };
  const info = new ModelInfo({
    model: {} as LanguageModelV3,
    config: model,
    providerId: "test",
    modelId: "model",
    providerSecretValues,
  });
  const otherInfo = new ModelInfo({
    model: {} as LanguageModelV3,
    config: otherModel,
    providerId: "test",
    modelId: "other",
    providerSecretValues,
  });
  const registry = new ProviderRegistry(
    {} as ProviderRegistry["sdkRegistry"],
    new Map(withOtherModel
      ? [[info.qualifiedId, info], [otherInfo.qualifiedId, otherInfo]]
      : [[info.qualifiedId, info]]),
  );
  const runtime = new ModelRuntime();
  runtime.publish(new ModelRuntimeSnapshot({
    revision,
    config,
    providerRegistry: registry,
  }));
  return runtime;
}

function createManager(agents: Record<string, MockAgent>, options: FakeManagerOptions = {}) {
  const sessionAgentManager = createFakeManager(agents, options);
  const executionStoreManager = options.storeManager ?? storeManager;
  const trackSession = mock(() => undefined);
  const untrackSession = mock(() => undefined);
  const modelRuntime = options.modelRuntime ?? makeModelRuntime();
  const deadlineScheduler = options.deadlineScheduler ?? createTestDeadlineScheduler();
  const rawManager = new SessionExecutionManager({
    sessionAgentManager,
    modelRuntime,
    modelSelectionResolver: new ModelSelectionResolver(),
    ...storeCallbacks(executionStoreManager),
    ...(options.resolveSessionDepth === undefined ? {} : { resolveSessionDepth: options.resolveSessionDepth }),
    ...(options.createSessionStore === undefined ? {} : { createSessionStore: options.createSessionStore }),
    ...(options.loadSessionStore === undefined ? {} : { loadSessionStore: options.loadSessionStore }),
    flushSessionStore: options.flushSessionStore ?? (async () => undefined),
    listSessionFamilyToolBatchHitlIds: options.listSessionFamilyToolBatchHitlIds ?? (async () => []),
    cancelSessionToolBatch: options.cancelSessionToolBatch ?? (async () => undefined),
    isDiscussionSession: options.isDiscussionSession ?? (async () => false),
    trackSession,
    untrackSession,
    executionScopeValidator: options.executionScopeValidator ?? allowExecutionScope,
    sessionInputService: options.sessionInputService ?? new SessionInputService(executionStoreManager),
    ...(options.deletionLifecycle === undefined ? {} : { deletionLifecycle: options.deletionLifecycle }),
    ...(options.sessionFamilyStopTimeoutMs === undefined ? {} : { sessionFamilyStopTimeoutMs: options.sessionFamilyStopTimeoutMs }),
    applyChildDependencyOutcome: options.applyChildDependencyOutcome ?? (async () => undefined),
    onSessionInputMutationReleased: options.onSessionInputMutationReleased ?? (async () => undefined),
    onContinuationAdmissionReleased: options.onContinuationAdmissionReleased ?? (async () => undefined),
    resolveGoalInstanceId: options.resolveGoalInstanceId ?? (async () => null),
    onExecutionSettlement: options.onExecutionSettlement ?? (async () => undefined),
    deadlineScheduler,
    logger: silentLogger,
  });
  const manager = testManagerFacade(rawManager);
  return { manager, sessionAgentManager, trackSession, untrackSession, deadlineScheduler };
}

function inputServicePort(service: SessionInputService): NonNullable<FakeManagerOptions["sessionInputService"]> {
  return {
    beginQueueExecution: (input) => service.beginQueueExecution(input),
    beginDirectExecution: (input) => service.beginDirectExecution(input),
    claimSteer: (input) => service.claimSteer(input),
    commitSteers: (input) => service.commitSteers(input),
    rollbackSteers: (input) => service.rollbackSteers(input),
    getPendingMessages: (sessionId, root) => service.getPendingMessages(sessionId, root),
    recordQueueDispatchBarrier: (input) => service.recordQueueDispatchBarrier(input),
  };
}

async function writeSessionFile(input: {
  sessionId: string;
  rootSessionId?: string;
  parentSessionId?: string;
  cwd?: string;
  title?: string;
  executions?: SessionFile["executions"];
  steps?: SessionFile["steps"];
  childSessionLinks?: SessionFile["childSessionLinks"];
  toolBatches?: SessionFile["toolBatches"];
  agentName?: AgentName;
  delegationRequest?: DelegationRequest;
  projectTodo?: SessionFile["projectTodo"];
}): Promise<void> {
  const rootSessionId = input.rootSessionId ?? input.sessionId;
  const request = input.parentSessionId === undefined
    ? undefined
    : input.delegationRequest ?? delegationRequest({
      agent_type: input.agentName === "build" ? "build" : "explore",
      title: input.title ?? "Delegated child",
    });
  const file: SessionFile = {
    sessionId: input.sessionId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    cwd: input.cwd ?? workspaceRoot,
    agentName: input.agentName ?? (input.parentSessionId === undefined ? "lead" : "explore"),
    activeSkillNames: [],
    modelSelection: { revision: 0 },
    title: input.title ?? null,
    messages: [],
    pendingMessages: [],
    inputRequestReceipts: [],
    steps: input.steps ?? [],
    stats: createEmptySessionStats(),
    executions: input.executions ?? [],
    compression: createEmptyCompressionState(),
    todos: [],
    reminders: [],
    childSessionLinks: input.childSessionLinks ?? [],
    toolBatches: input.toolBatches ?? [],
    rootSessionId,
    ...(request === undefined ? {} : { delegationRequest: request }),
    ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
    ...(input.projectTodo === undefined ? {} : { projectTodo: input.projectTodo }),
  };
  await mkdir(getSessionDir(workspaceRoot, input.sessionId), { recursive: true });
  await Bun.write(getSessionPath(workspaceRoot, input.sessionId), JSON.stringify(file, null, 2));
}

function blockedToolBatch(hitlId: string): SessionToolBatch {
  const now = new Date().toISOString();
  const toolCallId = `tool-${hitlId}`;
  return {
    batchId: `batch-${hitlId}`,
    executionId: `execution-${hitlId}`,
    runOrdinal: 0,
    step: 0,
    agentName: "lead",
    allowedTools: ["ask_user"],
    agentSkills: [],
    partitions: [{ type: "serial", callIds: [toolCallId] }],
    calls: [{
      ordinal: 0,
      partitionIndex: 0,
      toolCallId,
      toolName: "ask_user",
      input: {},
      traits: { readOnly: true, destructive: false, concurrencySafe: false },
      state: "blocked",
      attempt: 1,
      checkpointAt: Date.parse(now),
      blocker: {
        requestKey: `request-${hitlId}`,
        hitlId,
        source: { type: "ask_user", toolCallId },
        displayPayload: { title: "Question", redacted: true },
      },
    }],
    createdAt: now,
    updatedAt: now,
  };
}

function makeChildLink(parentSessionId: string, childSessionId: string, childAgentName: string): ToolChildSessionLink {
  return {
    parentSessionId,
    parentToolCallId: `tool-${childSessionId}`,
    toolName: "delegate",
    childSessionId,
    childExecutionId: `execution-${childSessionId}`,
    childAgentName,
    childProfile: "fast",
    childSkillNames: [],
    title: "Delegated child",
    depth: 1,
    background: true,
    status: "running",
    createdAt: Date.now(),
  };
}

describe("SessionExecutionManager", () => {
  beforeEach(async () => {
    storeManager.clearAll();
    workspaceRoot = join(testRoot, crypto.randomUUID());
    defaultAgentWorkspaceRoot = workspaceRoot;
    await mkdir(workspaceRoot, { recursive: true });
  });

  afterAll(async () => {
    await toolRegistryFixture.dispose();
    await rm(testRoot, { recursive: true, force: true });
  });

  test("fixes one binding at claim and commits only the same-actual-selection Queue prefix", async () => {
    const rootId = crypto.randomUUID();
    const rootAgent = new MockAgent(rootId, Promise.resolve({ text: "done", steps: 1 }), workspaceRoot);
    const { manager } = createManager({ [rootId]: rootAgent });
    const service = new SessionInputService(storeManager);
    const defaultRequest = { mode: "profile_default" as const, selection: { model: "test:model" } };
    const otherRequest = { mode: "session_override" as const, selection: { model: "test:other" } };

    await service.acceptMessage({
      sessionId: rootId,
      workspaceRoot,
      text: "first",
      clientRequestId: "request-first",
      source: "user",
      requestedModelSelection: defaultRequest,
    });
    await service.acceptMessage({
      sessionId: rootId,
      workspaceRoot,
      text: "second",
      clientRequestId: "request-second",
      source: "user",
      requestedModelSelection: otherRequest,
    });

    const execution = await manager.tryStartQueuedExecution({ slug: "project", workspaceRoot, sessionId: rootId });
    expect(execution).toBeDefined();
    await execution!.promise;

    const state = rootAgent.store.getState();
    expect(getUserMessageTexts(state)).toEqual(["first"]);
    expect(state.pendingMessages.map((message) => message.content)).toEqual(["second"]);
    expect(state.messages[0]?.modelAudit).toEqual({
      requested: defaultRequest,
      actual: { model: "test:model" },
    });
    expect(state.executions[0]?.runs.at(-1)?.binding.selection).toEqual({ model: "test:model" });
    expect(state.executions[0]?.origin).toBe("user_message");
    expect(rootAgent.runBindings[0]!.summary).toEqual(state.executions[0]!.runs.at(-1)!.binding);
  });

  test("settles each run with the canonical persisted run duration", async () => {
    const sessionId = crypto.randomUUID();
    const agent = new MockAgent(
      sessionId,
      Promise.resolve({ text: "done", steps: 1 }),
      workspaceRoot,
    );
    const settlements: Parameters<NonNullable<FakeManagerOptions["onExecutionSettlement"]>>[0][] = [];
    const { manager } = createManager({ [sessionId]: agent }, {
      flushSessionStore: (id, root) => storeManager.flushSession(id, root),
      onExecutionSettlement: async (input) => { settlements.push(input); },
    });

    const execution = await manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId,
      input: { kind: "direct", text: "finish" },
    });
    await execution.promise;

    const persisted = await storeManager.getSessionFile(workspaceRoot, sessionId);
    const run = persisted.executions.find((record) => record.id === execution.executionId)!.runs[0]!;
    if (!("endedAt" in run)) throw new Error("Expected completed persisted run");
    const runSettlement = settlements.flatMap(({ settlements: entries }) => entries)
      .find((entry) => entry.kind === "run");
    expect(runSettlement).toBeDefined();
    expect(runSettlement).toMatchObject({
      runOrdinal: run.ordinal,
      executionTimeMs: run.durationMs,
    });
  });

  test("keeps an active binding on revision A and resolves the next execution from revision B", async () => {
    const rootId = crypto.randomUUID();
    const firstGate = deferred<MockAgentResult>();
    const rootAgent = new MockAgent(rootId, firstGate.promise, workspaceRoot);
    const modelRuntime = makeModelRuntime(true, "test:model", "runtime-a");
    const { manager } = createManager({ [rootId]: rootAgent }, { modelRuntime });

    const first = await manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId: rootId,
      input: { kind: "direct", text: "run on A" },
    });
    await first.started;
    expect(first.binding.summary).toMatchObject({
      selection: { model: "test:model" },
      modelRuntimeRevision: "runtime-a",
    });

    modelRuntime.publish(makeModelRuntime(true, "test:other", "runtime-b").current);
    expect(first.binding.summary).toMatchObject({
      selection: { model: "test:model" },
      modelRuntimeRevision: "runtime-a",
    });
    firstGate.resolve({ text: "A done", steps: 1 });
    await first.promise;

    const secondAgent = new MockAgent(rootId, Promise.resolve({ text: "B done", steps: 1 }), workspaceRoot);
    const nextManager = createManager({ [rootId]: secondAgent }, { modelRuntime }).manager;
    const second = await nextManager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId: rootId,
      input: { kind: "direct", text: "run on B" },
    });
    await second.promise;
    expect(second.binding.summary).toMatchObject({
      selection: { model: "test:other" },
      modelRuntimeRevision: "runtime-b",
    });
  });

  test("starts Goal continuation as a new logical Execution", async () => {
    const rootId = crypto.randomUUID();
    const rootAgent = new MockAgent(
      rootId,
      Promise.resolve({ text: "done", steps: 1 }),
      workspaceRoot,
    );
    const { manager } = createManager({ [rootId]: rootAgent });

    const first = await manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId: rootId,
      input: { kind: "direct", text: "initial work" },
      origin: "user_message",
    });
    await first.promise;
    const goal = await manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId: rootId,
      input: { kind: "goal" },
      origin: "goal_continuation",
    });
    await goal.promise;

    expect(goal.executionId).not.toBe(first.executionId);
    expect(rootAgent.store.getState().executions.map((record) => ({
      id: record.id,
      origin: record.origin,
    }))).toEqual([
      { id: first.executionId, origin: "user_message" },
      { id: goal.executionId, origin: "goal_continuation" },
    ]);
    expect(getUserMessageTexts(rootAgent.store.getState())).toEqual(["initial work"]);
  });

  test("dispatches X,X,Y as two FIFO executions and X,Y,X as three", async () => {
    async function runSequence(sequence: readonly ("model" | "other")[]) {
      const rootId = crypto.randomUUID();
      const rootAgent = new MockAgent(rootId, Promise.resolve({ text: "done", steps: 1 }), workspaceRoot);
      const { manager } = createManager({ [rootId]: rootAgent });
      const service = new SessionInputService(storeManager);
      for (const [index, model] of sequence.entries()) {
        await service.acceptMessage({
          sessionId: rootId,
          workspaceRoot,
          text: `message-${index}`,
          clientRequestId: `sequence-${rootId}-${index}`,
          source: "user",
          requestedModelSelection: {
            mode: model === "model" ? "profile_default" : "session_override",
            selection: { model: `test:${model}` },
          },
        });
      }

      while ((await service.getPendingMessages(rootId, workspaceRoot)).length > 0) {
        const execution = await manager.tryStartQueuedExecution({
          slug: "project",
          workspaceRoot,
          sessionId: rootId,
        });
        expect(execution).toBeDefined();
        await execution!.promise;
      }
      return rootAgent;
    }

    const grouped = await runSequence(["model", "model", "other"]);
    expect(grouped.store.getState().executions.map((execution) => execution.runs.at(-1)!.binding.selection.model))
      .toEqual(["test:model", "test:other"]);
    expect(grouped.store.getState().messages.filter((message) => message.role === "user").map((message) => message.executionId))
      .toEqual([
        grouped.store.getState().executions[0]!.id,
        grouped.store.getState().executions[0]!.id,
        grouped.store.getState().executions[1]!.id,
      ]);

    const alternating = await runSequence(["model", "other", "model"]);
    expect(alternating.store.getState().executions.map((execution) => execution.runs.at(-1)!.binding.selection.model))
      .toEqual(["test:model", "test:other", "test:model"]);
  });

  test("coalesces distinct invalid requests onto the current default with per-message audits", async () => {
    const rootId = crypto.randomUUID();
    const rootAgent = new MockAgent(rootId, Promise.resolve({ text: "done", steps: 1 }), workspaceRoot);
    const modelRuntime = makeModelRuntime(false, "test:model", "runtime-z");
    const { manager } = createManager({ [rootId]: rootAgent }, { modelRuntime });
    const service = new SessionInputService(storeManager);
    const requests = [
      { mode: "profile_default" as const, selection: { model: "removed:x" } },
      { mode: "session_override" as const, selection: { model: "removed:y", variant: "deep" } },
    ];
    for (const [index, requestedModelSelection] of requests.entries()) {
      await service.acceptMessage({
        sessionId: rootId,
        workspaceRoot,
        text: `invalid-${index}`,
        clientRequestId: `invalid-${index}`,
        source: "user",
        requestedModelSelection,
      });
    }

    const execution = await manager.tryStartQueuedExecution({
      slug: "project",
      workspaceRoot,
      sessionId: rootId,
    });
    await execution!.promise;

    const state = rootAgent.store.getState();
    expect(state.executions).toHaveLength(1);
    expect(state.executions[0]!.runs.at(-1)!.binding).toMatchObject({
      selection: { model: "test:model" },
      modelRuntimeRevision: "runtime-z",
    });
    expect(state.messages.filter((message) => message.role === "user").map((message) => message.modelAudit))
      .toEqual(requests.map((requestedModelSelection) => ({
        requested: requestedModelSelection,
        actual: { model: "test:model" },
        reason: "config_invalidated",
      })));
  });

  test("passes a fixed command binding to the command callback", async () => {
    const rootId = crypto.randomUUID();
    const rootAgent = new MockAgent(rootId, Promise.resolve({ text: "unused", steps: 0 }), workspaceRoot);
    const { manager } = createManager({ [rootId]: rootAgent });
    let seen: ExecutionModelBinding | undefined;
    const result = await manager.runSessionCommand({
      workspaceRoot,
      sessionId: rootId,
      clientRequestId: "command-binding",
      requestedModelSelection: {
        mode: "session_override",
        selection: { model: "test:other" },
      },
    }, async (binding) => {
      seen = binding;
      return "done";
    });
    expect(result).toEqual({ kind: "executed", result: "done" });
    expect(seen?.summary.selection).toEqual({ model: "test:other" });
  });

  test("rejects Steer when its resolved actual selection differs from the active binding", async () => {
    const rootId = crypto.randomUUID();
    const gate = deferred<MockAgentResult>();
    const rootAgent = new MockAgent(rootId, gate.promise, workspaceRoot);
    const modelRuntime = makeModelRuntime(false);
    const { manager } = createManager({ [rootId]: rootAgent }, { modelRuntime });
    const service = new SessionInputService(storeManager);
    const execution = await manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId: rootId,
      input: {
        kind: "direct",
        text: "start",
      },
    });
    await execution.started;
    expect(execution.binding.summary.resolution).toBe("profile_default");
    expect(rootAgent.store.getState().executions[0]?.origin).toBe("user_message");
    expect(rootAgent.store.getState().messages[0]?.modelAudit?.requested).toEqual({
      mode: "profile_default",
      selection: { model: "test:model" },
    });
    modelRuntime.publish(makeModelRuntime(true).current);
    const accepted = await service.acceptMessage({
      sessionId: rootId,
      workspaceRoot,
      text: "different model",
      clientRequestId: "steer-other",
      source: "user",
      requestedModelSelection: {
        mode: "session_override",
        selection: { model: "test:other" },
      },
    });
    await expect(manager.steerQueuedMessage({
      workspaceRoot,
      sessionId: rootId,
      messageId: accepted.messageId,
      expectedRevision: 0,
      expectedExecutionId: execution.executionId,
    })).rejects.toBeInstanceOf(SessionSteerUnavailableError);
    expect((await service.getPendingMessages(rootId, workspaceRoot))[0]?.state).toBe("queued");
    gate.resolve({ text: "done", steps: 1 });
    await execution.promise;
  });

  test("commands share family admission, coalesce identical requests, and fence Queue execution", async () => {
    const rootId = crypto.randomUUID();
    const commandGate = deferred<void>();
    const rootAgent = new MockAgent(rootId, Promise.resolve({ text: "queued result", steps: 1 }), workspaceRoot);
    const { manager } = createManager({ [rootId]: rootAgent });
    const service = new SessionInputService(storeManager);
    let commandCalls = 0;

    const first = manager.runSessionCommand({
      workspaceRoot,
      sessionId: rootId,
      clientRequestId: "command-1",
      requestedModelSelection: TEST_REQUESTED_MODEL_SELECTION,
    }, async (_binding, signal) => {
      commandCalls += 1;
      await withAbort(commandGate.promise, signal);
      return "done";
    });
    expect(manager.getSessionFamilyActivity(workspaceRoot, rootId)).toBe("running");

    const joined = manager.runSessionCommand({
      workspaceRoot,
      sessionId: rootId,
      clientRequestId: "command-1",
      requestedModelSelection: TEST_REQUESTED_MODEL_SELECTION,
    }, async () => {
      commandCalls += 1;
      return "must not run";
    });
    await expect(manager.runSessionCommand({
      workspaceRoot,
      sessionId: rootId,
      clientRequestId: "command-2",
      requestedModelSelection: TEST_REQUESTED_MODEL_SELECTION,
    }, async () => "must not run")).rejects.toBeInstanceOf(SessionFamilyActiveError);

    await service.acceptMessage({
      sessionId: rootId,
      workspaceRoot,
      text: "queued during command",
      clientRequestId: "queued-during-command",
      source: "user",
      requestedModelSelection: TEST_REQUESTED_MODEL_SELECTION,
    });
    expect(await manager.tryStartQueuedExecution({ slug: "project", workspaceRoot, sessionId: rootId })).toBeUndefined();
    expect(rootAgent.runMock).not.toHaveBeenCalled();

    commandGate.resolve(undefined);
    await expect(first).resolves.toEqual({ kind: "executed", result: "done" });
    await expect(joined).resolves.toEqual({ kind: "joined" });
    expect(commandCalls).toBe(1);
    expect(manager.getSessionFamilyActivity(workspaceRoot, rootId)).toBe("idle");

    const execution = await manager.tryStartQueuedExecution({ slug: "project", workspaceRoot, sessionId: rootId });
    expect(execution).toBeDefined();
    await execution!.started;
    await execution!.promise;
    expect(rootAgent.runMock).toHaveBeenCalledTimes(1);
  });

  test("same command join preserves a failure that happened before a durable receipt", async () => {
    const rootId = crypto.randomUUID();
    storeManager.create(rootId, workspaceRoot, { agentName: "lead" });
    const { manager } = createManager({});
    const failGate = deferred<void>();
    const failure = new SessionInputConflictError("state", "blocked before command claim");

    const first = manager.runSessionCommand({
      workspaceRoot,
      sessionId: rootId,
      clientRequestId: "command-pre-claim-failure",
      requestedModelSelection: TEST_REQUESTED_MODEL_SELECTION,
    }, async () => {
      await failGate.promise;
      throw failure;
    });
    const joined = manager.runSessionCommand({
      workspaceRoot,
      sessionId: rootId,
      clientRequestId: "command-pre-claim-failure",
      requestedModelSelection: TEST_REQUESTED_MODEL_SELECTION,
    }, async () => "must not run");

    failGate.resolve(undefined);
    await expect(first).rejects.toBe(failure);
    await expect(joined).resolves.toEqual({ kind: "joined", error: failure });
  });

  test("Stop aborts an active command, barriers queued work, and writes no unrelated execution fact", async () => {
    const rootId = crypto.randomUUID();
    const store = storeManager.create(rootId, workspaceRoot, { agentName: "lead" });
    const rootAgent = new MockAgent(rootId, Promise.resolve({ text: "queued result", steps: 1 }), workspaceRoot);
    const { manager } = createManager({ [rootId]: rootAgent });
    const service = new SessionInputService(storeManager);
    const commandStarted = deferred<void>();
    let commandSignal: AbortSignal | undefined;
    const command = manager.runSessionCommand({
      workspaceRoot,
      sessionId: rootId,
      clientRequestId: "command-stop",
      requestedModelSelection: TEST_REQUESTED_MODEL_SELECTION,
    }, async (_binding, signal) => {
      commandSignal = signal;
      commandStarted.resolve(undefined);
      await withAbort(new Promise<never>(() => undefined), signal);
    });
    const commandOutcome = command.then(
      () => ({ kind: "resolved" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    await commandStarted.promise;
    await service.acceptMessage({
      sessionId: rootId,
      workspaceRoot,
      text: "B before Stop",
      clientRequestId: "queued-before-command-stop",
      source: "user",
      requestedModelSelection: TEST_REQUESTED_MODEL_SELECTION,
    });

    await manager.stopSessionFamily(workspaceRoot, rootId);
    expect(await commandOutcome).toMatchObject({ kind: "rejected", error: { name: "AbortError" } });
    expect(commandSignal!.aborted).toBe(true);
    expect(store.getState().executions).toEqual([]);
    expect(store.getState().queueDispatchBarrierAt).toEqual(expect.any(Number));
    expect(manager.getSessionFamilyActivity(workspaceRoot, rootId)).toBe("idle");
    expect(await manager.tryStartQueuedExecution({ slug: "project", workspaceRoot, sessionId: rootId }))
      .toBeUndefined();

    const coldStores = new SessionStoreManager({ logger: silentLogger });
    await coldStores.getOrLoad(rootId, workspaceRoot);
    const coldAgent = new MockAgent(
      rootId,
      Promise.resolve({ text: "queued result", steps: 1 }),
      workspaceRoot,
      coldStores,
    );
    const { manager: coldManager } = createManager({ [rootId]: coldAgent }, { storeManager: coldStores });
    const coldService = new SessionInputService(coldStores);
    expect(await coldManager.tryStartQueuedExecution({ slug: "project", workspaceRoot, sessionId: rootId }))
      .toBeUndefined();

    await coldService.acceptMessage({
      sessionId: rootId,
      workspaceRoot,
      text: "D after Stop",
      clientRequestId: "queued-after-command-stop",
      source: "user",
      requestedModelSelection: TEST_REQUESTED_MODEL_SELECTION,
    });
    const restarted = await coldManager.tryStartQueuedExecution({ slug: "project", workspaceRoot, sessionId: rootId });
    if (restarted === undefined) throw new Error("Expected a post-Stop Queue execution");
    await restarted.promise;
    expect(coldAgent.store.getState().messages.filter((message) => (
      message.executionId === restarted.executionId && message.role === "user"
    ))
      .flatMap((message) => message.parts.filter((part) => part.type === "text").map((part) => part.text)))
      .toEqual(["B before Stop", "D after Stop"]);
    expect(coldAgent.store.getState().queueDispatchBarrierAt).toBeUndefined();
  });

  test("strong family stop exposes stopping until every descendant releases ownership", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const childRun = deferred<MockAgentResult>();
    storeManager.create(rootId, workspaceRoot, { agentName: "lead" });
    storeManager.create(childId, workspaceRoot, {
      rootSessionId: rootId,
      parentSessionId: rootId,
      agentName: "explore",
    });
    const rootAgent = new MockAgent(rootId, Promise.resolve({ text: "queued result", steps: 1 }), workspaceRoot);
    const childAgent = new MockAgent(childId, childRun.promise, workspaceRoot);
    const { manager } = createManager({ [rootId]: rootAgent, [childId]: childAgent });
    const service = new SessionInputService(storeManager);
    const activities: string[] = [];
    manager.subscribeSessionRuntimeChanges((change) => activities.push(change.activity));
    const childExecution = await manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId: childId,
      input: { kind: "direct", text: "child" },
      origin: "tool_call",
    });
    await childExecution.started;
    await service.acceptMessage({
      sessionId: rootId,
      workspaceRoot,
      text: "queued before descendant-only Stop",
      clientRequestId: "queued-before-descendant-stop",
      source: "user",
      requestedModelSelection: TEST_REQUESTED_MODEL_SELECTION,
    });

    const stopping = manager.stopSessionFamily(workspaceRoot, rootId);
    expect(manager.getSessionFamilyActivity(workspaceRoot, rootId)).toBe("stopping");
    expect(childExecution.abortController.signal.aborted).toBe(true);
    await stopping;

    expect(manager.getSessionFamilyActivity(workspaceRoot, rootId)).toBe("idle");
    expect(activities).toEqual(["running", "stopping", "idle"]);
    expect(storeManager.get(rootId, workspaceRoot)?.getState().queueDispatchBarrierAt)
      .toEqual(expect.any(Number));
    expect(await manager.tryStartQueuedExecution({ slug: "project", workspaceRoot, sessionId: rootId }))
      .toBeUndefined();
  });

  test("rejects a new root user message while a descendant owns the family", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const childRun = deferred<MockAgentResult>();
    const rootStore = storeManager.create(rootId, workspaceRoot, { agentName: "lead" });
    storeManager.create(childId, workspaceRoot, {
      rootSessionId: rootId,
      parentSessionId: rootId,
      agentName: "explore",
    });
    const rootAgent = new MockAgent(rootId, Promise.resolve({ text: "must not run", steps: 1 }), workspaceRoot);
    const childAgent = new MockAgent(childId, childRun.promise, workspaceRoot);
    const { manager } = createManager({ [rootId]: rootAgent, [childId]: childAgent });
    const childExecution = await manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId: childId,
      input: { kind: "direct", text: "child" },
      origin: "tool_call",
    });

    await expect(manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId: rootId,
      input: { kind: "direct", text: "new root message" },
    })).rejects.toEqual(expect.objectContaining({
      name: "SessionFamilyActiveError",
      sessionId: rootId,
      rootSessionId: rootId,
      activity: "running",
    }));
    expect(rootStore.getState().isRunning).toBe(false);

    childRun.resolve({ text: "done", steps: 1 });
    await childExecution.promise;
  });

  test("rejects a direct child user message while a sibling owns the family", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const siblingId = crypto.randomUUID();
    const siblingRun = deferred<MockAgentResult>();
    storeManager.create(rootId, workspaceRoot, { agentName: "lead" });
    const childStore = storeManager.create(childId, workspaceRoot, {
      rootSessionId: rootId,
      parentSessionId: rootId,
      agentName: "explore",
    });
    storeManager.create(siblingId, workspaceRoot, {
      rootSessionId: rootId,
      parentSessionId: rootId,
      agentName: "explore",
    });
    const childAgent = new MockAgent(childId, Promise.resolve({ text: "must not run", steps: 1 }), workspaceRoot);
    const siblingAgent = new MockAgent(siblingId, siblingRun.promise, workspaceRoot);
    const { manager } = createManager({ [childId]: childAgent, [siblingId]: siblingAgent });
    const siblingExecution = await manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId: siblingId,
      input: { kind: "direct", text: "sibling" },
      origin: "tool_call",
    });

    await expect(manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId: childId,
      input: { kind: "direct", text: "direct child message" },
    })).rejects.toBeInstanceOf(SessionFamilyActiveError);
    expect(childStore.getState().isRunning).toBe(false);

    siblingRun.resolve({ text: "done", steps: 1 });
    await siblingExecution.promise;
  });

  test("rejects a loaded child passed to the root-only family Stop contract", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    storeManager.create(rootId, workspaceRoot, { agentName: "lead" });
    storeManager.create(childId, workspaceRoot, { rootSessionId: rootId, parentSessionId: rootId, agentName: "explore" });
    const { manager } = createManager({});

    await expect(manager.stopSessionFamily(workspaceRoot, childId)).rejects.toBeInstanceOf(NotRootSessionError);
  });

  test("stops a canonical cold root without guessing a member identity", async () => {
    const rootId = crypto.randomUUID();
    await writeSessionFile({ sessionId: rootId });
    const coldStores = new SessionStoreManager({ logger: silentLogger });
    const { manager } = createManager({}, { storeManager: coldStores });
    const changes: string[] = [];
    manager.subscribeSessionRuntimeChanges((change) => changes.push(`${change.rootSessionId}:${change.activity}`));

    await manager.stopSessionFamily(workspaceRoot, rootId);

    expect(manager.getSessionFamilyActivity(workspaceRoot, rootId)).toBe("idle");
    expect(changes).toEqual([
      `${rootId}:stopping`,
      `${rootId}:idle`,
    ]);
  });

  test("fails closed when execution identity has not been loaded", async () => {
    const { manager } = createManager({});
    const missingSessionId = crypto.randomUUID();

    await expect(manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId: missingSessionId,
      input: { kind: "direct", text: "must not guess family identity" },
    })).rejects.toThrow(SessionFileNotFoundError);
  });

  test("checked execution starts once and rejects duplicate same-session starts", async () => {
    const run = deferred<MockAgentResult>();
    const sessionId = crypto.randomUUID();
    const agent = new MockAgent(sessionId, run.promise);
    const { manager } = createManager({ [sessionId]: agent });

    const execution = await manager.startCheckedExecution({ slug: "project", workspaceRoot, sessionId, input: { kind: "direct", text: "hello" } });

    expect(execution.sessionId).toBe(sessionId);
    expect(execution.agentName).toBe("lead");
    expect(execution.origin).toBe("user_message");
    expect(typeof execution.executionToken).toBe("symbol");
    expect(manager.getSessionFamilyActivity(workspaceRoot, sessionId)).toBe("running");
    await expect(manager.startCheckedExecution({ slug: "project", workspaceRoot, sessionId, input: { kind: "direct", text: "again" } })).rejects.toThrow(SessionFamilyActiveError);
    await agent.runStarted.promise;
    expect(agent.runMock).toHaveBeenCalledWith(expect.objectContaining({ abort: execution.abortController.signal }));
    expect(getUserMessageTexts(agent.store.getState())).toEqual(["hello"]);
    const options = agent.runMock.mock.calls[0]?.[0];
    if (!options) throw new Error("Expected AgentRunOptions");
    expect(options.maxSteps).toBe(50);
    run.resolve({ text: "done", steps: 1 });
    await execution.promise;
    expect(manager.getSessionFamilyActivity(workspaceRoot, sessionId)).toBe("idle");
  });

  test("commits every queued message at the cutoff into one next execution", async () => {
    const firstRun = deferred<MockAgentResult>();
    const sessionId = crypto.randomUUID();
    const agent = new MockAgent(sessionId, firstRun.promise);
    const { manager } = createManager({ [sessionId]: agent });
    const inputs = new SessionInputService(storeManager);

    const first = await manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId,
      input: { kind: "direct", text: "A" },
    });
    await first.started;
    const acceptedB = await inputs.acceptMessage({
      sessionId,
      workspaceRoot,
      text: "B",
      clientRequestId: crypto.randomUUID(),
      source: "user",
      requestedModelSelection: TEST_REQUESTED_MODEL_SELECTION,
    });
    const acceptedC = await inputs.acceptMessage({
      sessionId,
      workspaceRoot,
      text: "C",
      clientRequestId: crypto.randomUUID(),
      source: "user",
      requestedModelSelection: TEST_REQUESTED_MODEL_SELECTION,
    });

    expect(await manager.tryStartQueuedExecution({ slug: "project", workspaceRoot, sessionId })).toBeUndefined();
    firstRun.resolve({ text: "first done", steps: 1 });
    await first.promise;

    const second = await manager.tryStartQueuedExecution({ slug: "project", workspaceRoot, sessionId });
    if (second === undefined) throw new Error("Expected queued execution");
    await second.promise;

    const state = agent.store.getState();
    const queuedBatch = state.messages.filter((message) => (
      message.id === acceptedB.messageId || message.id === acceptedC.messageId
    ));
    expect(queuedBatch.flatMap((message) => (
      message.parts.filter((part) => part.type === "text").map((part) => part.text)
    ))).toEqual(["B", "C"]);
    expect(queuedBatch.map((message) => message.executionId)).toEqual([
      second.executionId,
      second.executionId,
    ]);
    expect(state.pendingMessages).toEqual([]);
    expect(state.executions).toHaveLength(2);
  });

  test("keeps queued messages on Stop and batches them with the next accepted message", async () => {
    const firstRun = deferred<MockAgentResult>();
    const sessionId = crypto.randomUUID();
    const agent = new MockAgent(sessionId, firstRun.promise);
    const { manager } = createManager({ [sessionId]: agent });
    const inputs = new SessionInputService(storeManager);

    const first = await manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId,
      input: { kind: "direct", text: "A" },
    });
    await first.started;
    for (const text of ["B", "C"]) {
      await inputs.acceptMessage({
        sessionId,
        workspaceRoot,
        text,
        clientRequestId: crypto.randomUUID(),
        source: "user",
        requestedModelSelection: TEST_REQUESTED_MODEL_SELECTION,
      });
    }

    await manager.stopSessionFamily(workspaceRoot, sessionId);
    firstRun.resolve({ text: "late", steps: 1 });
    expect(agent.store.getState().executions[0]).toMatchObject({
      id: first.executionId,
      status: "cancelled",
    });
    expect(typeof agent.store.getState().executions[0]?.stopRequestedAt).toBe("number");
    expect(agent.store.getState().pendingMessages.map((message) => message.content)).toEqual(["B", "C"]);

    await inputs.acceptMessage({
      sessionId,
      workspaceRoot,
      text: "D",
      clientRequestId: crypto.randomUUID(),
      source: "user",
      requestedModelSelection: TEST_REQUESTED_MODEL_SELECTION,
    });
    const second = await manager.tryStartQueuedExecution({ slug: "project", workspaceRoot, sessionId });
    if (second === undefined) throw new Error("Expected post-Stop queued execution");
    await second.promise;

    const messages = agent.store.getState().messages.filter((message) => (
      message.executionId === second.executionId && message.role === "user"
    ));
    expect(messages.flatMap((message) => message.parts.filter((part) => part.type === "text").map((part) => part.text)))
      .toEqual(["B", "C", "D"]);
    expect(agent.store.getState().pendingMessages).toEqual([]);
  });

  test("Stop before Queue canonicalization preserves the entire claimed batch", async () => {
    const sessionId = crypto.randomUUID();
    const agent = new MockAgent(sessionId, Promise.resolve({ text: "must not run", steps: 1 }));
    const inputs = new SessionInputService(storeManager);
    const beginEntered = deferred<void>();
    const releaseBegin = deferred<void>();
    const port = inputServicePort(inputs);
    const { manager } = createManager({ [sessionId]: agent }, {
      sessionInputService: {
        ...port,
        beginQueueExecution: async (input) => {
          beginEntered.resolve(undefined);
          await releaseBegin.promise;
          return await inputs.beginQueueExecution(input);
        },
      },
    });
    for (const text of ["B", "C"]) {
      await inputs.acceptMessage({
        sessionId,
        workspaceRoot,
        text,
        clientRequestId: crypto.randomUUID(),
        source: "user",
        requestedModelSelection: TEST_REQUESTED_MODEL_SELECTION,
      });
    }

    const starting = manager.tryStartQueuedExecution({ slug: "project", workspaceRoot, sessionId });
    await beginEntered.promise;
    const execution = await starting;
    if (execution === undefined) throw new Error("Expected provisional Queue execution");
    const stopping = manager.stopSessionFamily(workspaceRoot, sessionId);
    releaseBegin.resolve(undefined);
    await Promise.all([execution.promise, stopping]);

    const state = agent.store.getState();
    expect(state.pendingMessages.map((message) => message.content)).toEqual(["B", "C"]);
    expect(state.messages).toEqual([]);
    expect(state.executions).toEqual([
      expect.objectContaining({
        id: execution.executionId,
        status: "cancelled",
        stopRequestedAt: expect.any(Number),
      }),
    ]);
    expect(agent.runMock).toHaveBeenCalledTimes(0);
  });

  test("captures the exact Queue prefix at the final synchronous claim", async () => {
    const sessionId = crypto.randomUUID();
    const agent = new MockAgent(sessionId, Promise.resolve({ text: "done", steps: 1 }));
    const inputs = new SessionInputService(storeManager);
    const validationEntered = deferred<void>();
    const releaseValidation = deferred<void>();
    const beginEntered = deferred<void>();
    const releaseBegin = deferred<void>();
    let claimedSnapshotIds: string[] = [];
    let committedAtBegin: string[] = [];
    const port = inputServicePort(inputs);
    const { manager } = createManager({ [sessionId]: agent }, {
      executionScopeValidator: {
        validate: async () => {
          validationEntered.resolve(undefined);
          await releaseValidation.promise;
        },
      },
      sessionInputService: {
        ...port,
        beginQueueExecution: async (input) => {
          claimedSnapshotIds = input.snapshots.map((snapshot) => snapshot.pending.id);
          beginEntered.resolve(undefined);
          await releaseBegin.promise;
          const result = await inputs.beginQueueExecution(input);
          committedAtBegin = result.messages.map((message) => message.id);
          return result;
        },
      },
    });
    const acceptedB = await inputs.acceptMessage({
      sessionId,
      workspaceRoot,
      text: "B",
      clientRequestId: crypto.randomUUID(),
      source: "user",
      requestedModelSelection: TEST_REQUESTED_MODEL_SELECTION,
    });

    const starting = manager.tryStartQueuedExecution({ slug: "project", workspaceRoot, sessionId });
    await validationEntered.promise;
    const acceptedC = await inputs.acceptMessage({
      sessionId,
      workspaceRoot,
      text: "C",
      clientRequestId: crypto.randomUUID(),
      source: "user",
      requestedModelSelection: TEST_REQUESTED_MODEL_SELECTION,
    });
    releaseValidation.resolve(undefined);
    await beginEntered.promise;
    const acceptedD = await inputs.acceptMessage({
      sessionId,
      workspaceRoot,
      text: "D",
      clientRequestId: crypto.randomUUID(),
      source: "user",
      requestedModelSelection: TEST_REQUESTED_MODEL_SELECTION,
    });
    expect(claimedSnapshotIds).toEqual([acceptedB.messageId, acceptedC.messageId]);
    expect(claimedSnapshotIds).not.toContain(acceptedD.messageId);
    releaseBegin.resolve(undefined);
    const execution = await starting;
    if (execution === undefined) throw new Error("Expected Queue execution");
    await execution.promise;

    const state = agent.store.getState();
    expect(committedAtBegin).toEqual([acceptedB.messageId, acceptedC.messageId]);
    expect(state.messages.filter((message) => (
      message.executionId === execution.executionId && message.role === "user"
    )).map((message) => message.id))
      .toEqual([acceptedB.messageId, acceptedC.messageId]);
    expect(state.pendingMessages.map((message) => message.id)).toEqual([acceptedD.messageId]);
  });

  test("commits a claimed Steer at the next safe point and publishes its execution fence", async () => {
    const sessionId = crypto.randomUUID();
    const store = storeManager.create(sessionId, workspaceRoot, { agentName: "lead" });
    const enteredRun = deferred<void>();
    const releaseSafePoint = deferred<void>();
    const agent: Agent = {
      store,
      cwd: workspaceRoot,
      classifyCommand: () => null,
      executeCommand: async () => ({ kind: "handled" }),
      run: async (_binding, options) => {
        enteredRun.resolve(undefined);
        await releaseSafePoint.promise;
        await options?.consumeSteers?.();
        return { outcome: "terminal", text: "done", steps: 1, status: "completed" };
      },
      dispose: () => undefined,
    };
    const { manager } = createManager({ [sessionId]: agent as unknown as MockAgent }, {
      getAgent: () => agent,
    });
    const inputs = new SessionInputService(storeManager);

    const execution = await manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId,
      input: { kind: "direct", text: "A" },
    });
    await enteredRun.promise;
    expect(manager.listSessionFamilyActivities()).toEqual([{
      workspaceRoot,
      rootSessionId: sessionId,
      activity: "running",
      steerTargetExecutionId: execution.executionId,
    }]);
    const accepted = await inputs.acceptMessage({
      sessionId,
      workspaceRoot,
      text: "B",
      clientRequestId: crypto.randomUUID(),
      source: "user",
      requestedModelSelection: TEST_REQUESTED_MODEL_SELECTION,
    });
    const steered = await manager.steerQueuedMessage({
      workspaceRoot,
      sessionId,
      messageId: accepted.messageId,
      expectedRevision: 0,
      expectedExecutionId: execution.executionId,
    });
    expect(steered).toMatchObject({ state: "steering", targetExecutionId: execution.executionId });

    releaseSafePoint.resolve(undefined);
    await execution.promise;

    const canonical = store.getState().messages.find((message) => message.id === accepted.messageId);
    expect(canonical).toMatchObject({ executionId: execution.executionId });
    expect(store.getState().pendingMessages).toEqual([]);
  });

  test("commits an accepted Steer before yielding to a HITL tool-batch continuation", async () => {
    const sessionId = crypto.randomUUID();
    const store = storeManager.create(sessionId, workspaceRoot, { agentName: "lead" });
    const enteredRun = deferred<void>();
    const releaseHitlBoundary = deferred<void>();
    let invocation = 0;
    let resumedUserMessages: string[] = [];
    const agent: Agent = {
      store,
      cwd: workspaceRoot,
      classifyCommand: () => null,
      executeCommand: async () => ({ kind: "handled" }),
      run: async (_binding, options) => {
        invocation += 1;
        if (invocation > 1) {
          resumedUserMessages = getUserMessageTexts(store.getState());
          return { outcome: "terminal", text: "resumed", steps: 1, status: "completed" };
        }
        enteredRun.resolve(undefined);
        await releaseHitlBoundary.promise;
        const batch = {
          ...blockedToolBatch("steer-before-hitl"),
          executionId: options!.executionId,
        };
        store.setState({ toolBatches: [batch] });
        return {
          outcome: "suspended",
          text: "waiting",
          steps: 1,
          suspension: {
            kind: "hitl",
            toolBatchId: batch.batchId,
            blockerIds: ["steer-before-hitl"],
          },
        };
      },
      dispose: () => undefined,
    };
    const { manager } = createManager({ [sessionId]: agent as unknown as MockAgent }, {
      getAgent: () => agent,
    });
    const inputs = new SessionInputService(storeManager);

    const execution = await manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId,
      input: { kind: "direct", text: "A" },
    });
    await enteredRun.promise;
    const accepted = await inputs.acceptMessage({
      sessionId,
      workspaceRoot,
      text: "B",
      clientRequestId: crypto.randomUUID(),
      source: "user",
      requestedModelSelection: TEST_REQUESTED_MODEL_SELECTION,
    });
    await manager.steerQueuedMessage({
      workspaceRoot,
      sessionId,
      messageId: accepted.messageId,
      expectedRevision: 0,
      expectedExecutionId: execution.executionId,
    });

    releaseHitlBoundary.resolve(undefined);
    await execution.promise;

    expect(store.getState().messages.find((message) => message.id === accepted.messageId)).toMatchObject({
      executionId: execution.executionId,
    });
    expect(store.getState().pendingMessages).toEqual([]);
    expect(store.getState().executions.at(-1)).toMatchObject({
      id: execution.executionId,
      status: "suspended",
    });

    store.setState((state) => ({
      toolBatches: state.toolBatches.map((batch) => ({
        ...batch,
        calls: batch.calls.map((call) => ({ ...call, state: "completed" as const, blocker: undefined })),
      })),
    }));
    const resumed = await manager.reconcileDurableSession({
      slug: "project",
      workspaceRoot,
      sessionId,
    });
    await resumed!.promise;

    expect(resumed!.executionId).toBe(execution.executionId);
    expect(resumedUserMessages).toEqual(["A", "B"]);
  });

  test("Stop still rolls back a HITL-boundary Steer before its durable commit", async () => {
    const sessionId = crypto.randomUUID();
    const store = storeManager.create(sessionId, workspaceRoot, { agentName: "lead" });
    const enteredRun = deferred<void>();
    const releaseHitlBoundary = deferred<void>();
    const commitEntered = deferred<void>();
    const releaseCommit = deferred<void>();
    const inputs = new SessionInputService(storeManager);
    const port = inputServicePort(inputs);
    const agent: Agent = {
      store,
      cwd: workspaceRoot,
      classifyCommand: () => null,
      executeCommand: async () => ({ kind: "handled" }),
      run: async (_binding, options) => {
        enteredRun.resolve(undefined);
        await releaseHitlBoundary.promise;
        const batch = {
          ...blockedToolBatch("stopped-steer-before-hitl"),
          executionId: options!.executionId,
        };
        store.setState({ toolBatches: [batch] });
        return {
          outcome: "suspended",
          text: "waiting",
          steps: 1,
          suspension: {
            kind: "hitl",
            toolBatchId: batch.batchId,
            blockerIds: ["stopped-steer-before-hitl"],
          },
        };
      },
      dispose: () => undefined,
    };
    const { manager } = createManager({ [sessionId]: agent as unknown as MockAgent }, {
      getAgent: () => agent,
      sessionInputService: {
        ...port,
        commitSteers: async (input) => {
          commitEntered.resolve(undefined);
          await releaseCommit.promise;
          return await inputs.commitSteers(input);
        },
      },
    });

    const execution = await manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId,
      input: { kind: "direct", text: "A" },
    });
    await enteredRun.promise;
    const accepted = await inputs.acceptMessage({
      sessionId,
      workspaceRoot,
      text: "B",
      clientRequestId: crypto.randomUUID(),
      source: "user",
      requestedModelSelection: TEST_REQUESTED_MODEL_SELECTION,
    });
    await manager.steerQueuedMessage({
      workspaceRoot,
      sessionId,
      messageId: accepted.messageId,
      expectedRevision: 0,
      expectedExecutionId: execution.executionId,
    });

    releaseHitlBoundary.resolve(undefined);
    await commitEntered.promise;
    const stopping = manager.stopSessionFamily(workspaceRoot, sessionId);
    releaseCommit.resolve(undefined);
    await Promise.all([execution.promise, stopping]);

    expect(store.getState().messages.some((message) => message.id === accepted.messageId)).toBe(false);
    expect(store.getState().pendingMessages).toEqual([
      expect.objectContaining({ id: accepted.messageId, state: "queued" }),
    ]);
  });

  test("rolls an unconsumed Steer back to Queue when Stop closes the gate", async () => {
    const run = deferred<MockAgentResult>();
    const sessionId = crypto.randomUUID();
    const agent = new MockAgent(sessionId, run.promise);
    const { manager } = createManager({ [sessionId]: agent });
    const inputs = new SessionInputService(storeManager);
    const execution = await manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId,
      input: { kind: "direct", text: "A" },
    });
    await execution.started;
    const accepted = await inputs.acceptMessage({
      sessionId,
      workspaceRoot,
      text: "B",
      clientRequestId: crypto.randomUUID(),
      source: "user",
      requestedModelSelection: TEST_REQUESTED_MODEL_SELECTION,
    });
    await manager.steerQueuedMessage({
      workspaceRoot,
      sessionId,
      messageId: accepted.messageId,
      expectedRevision: 0,
      expectedExecutionId: execution.executionId,
    });

    await manager.stopSessionFamily(workspaceRoot, sessionId);
    run.resolve({ text: "late", steps: 1 });

    expect(agent.store.getState().pendingMessages).toEqual([
      expect.objectContaining({
        id: accepted.messageId,
        content: "B",
        state: "queued",
        revision: 2,
      }),
    ]);
    expect(agent.store.getState().pendingMessages[0]).not.toHaveProperty("targetExecutionId");
  });

  test("Stop invalidates an in-flight Steer commit before its durable CAS", async () => {
    const sessionId = crypto.randomUUID();
    const store = storeManager.create(sessionId, workspaceRoot, { agentName: "lead" });
    const enteredRun = deferred<void>();
    const releaseSafePoint = deferred<void>();
    const commitEntered = deferred<void>();
    const releaseCommit = deferred<void>();
    const inputs = new SessionInputService(storeManager);
    const port = inputServicePort(inputs);
    const agent: Agent = {
      store,
      cwd: workspaceRoot,
      classifyCommand: () => null,
      executeCommand: async () => ({ kind: "handled" }),
      run: async (_binding, options) => {
        enteredRun.resolve(undefined);
        await releaseSafePoint.promise;
        await options?.consumeSteers?.();
        return { outcome: "terminal", text: "done", steps: 1, status: "completed" };
      },
      dispose: () => undefined,
    };
    const { manager } = createManager({ [sessionId]: agent as unknown as MockAgent }, {
      getAgent: () => agent,
      sessionInputService: {
        ...port,
        commitSteers: async (input) => {
          commitEntered.resolve(undefined);
          await releaseCommit.promise;
          return await inputs.commitSteers(input);
        },
      },
    });
    const execution = await manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId,
      input: { kind: "direct", text: "A" },
    });
    await enteredRun.promise;
    const accepted = await inputs.acceptMessage({
      sessionId,
      workspaceRoot,
      text: "B",
      clientRequestId: crypto.randomUUID(),
      source: "user",
      requestedModelSelection: TEST_REQUESTED_MODEL_SELECTION,
    });
    await manager.steerQueuedMessage({
      workspaceRoot,
      sessionId,
      messageId: accepted.messageId,
      expectedRevision: 0,
      expectedExecutionId: execution.executionId,
    });
    releaseSafePoint.resolve(undefined);
    await commitEntered.promise;

    const stopping = manager.stopSessionFamily(workspaceRoot, sessionId);
    releaseCommit.resolve(undefined);
    await Promise.all([execution.promise, stopping]);

    expect(store.getState().messages.some((message) => message.id === accepted.messageId)).toBe(false);
    expect(store.getState().pendingMessages).toEqual([
      expect.objectContaining({ id: accepted.messageId, state: "queued" }),
    ]);
    expect(store.getState().pendingMessages[0]).not.toHaveProperty("targetExecutionId");
  });

  test("keeps Todo query-loop continuations inside one durable execution", async () => {
    const sessionId = crypto.randomUUID();
    const store = storeManager.create(sessionId, workspaceRoot, { agentName: "lead" });
    store.setState({
      todos: [{ id: "todo-1", content: "finish the task", status: "pending" }],
    });

    const definition = {
      ...leadAgentDefinition,
      roleContract: {
        ...leadAgentDefinition.roleContract,
        requiredCapabilities: [],
        delegateTargets: [],
      },
      tools: { tools: [] },
      skills: leadAgentDefinition.skills,
      hooks: {
        ...leadAgentDefinition.hooks,
        autoCompact: false,
        autoInjectReminder: true,
        todoStepReminder: false,
        memoryExtraction: false,
        memoryConsolidation: false,
        titleGeneration: "disabled" as const,
      },
    };
    let modelRound = 0;
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    setLlmAdapterForTest({
      streamText: mock(() => {
        modelRound += 1;
        now += 60_001;
        if (modelRound === 2) store.setState({ todos: [{ id: "todo-1", content: "finish the task", status: "completed" }] });
        return {
          fullStream: (async function* () {
            yield { type: "text-delta", text: modelRound === 1 ? "started" : "finished" };
          })(),
          finishReason: Promise.resolve("stop"),
          text: Promise.resolve(modelRound === 1 ? "started" : "finished"),
          toolCalls: Promise.resolve([]),
          usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
        };
      }) as unknown as typeof import("ai").streamText,
    });

    const configuredAgent = new ConfiguredAgent({
      definition,
      toolRegistry: toolRegistryFixture.registry,
      skillService: new SkillService(),
      storeManager,
      store,
      toolOutputAccess: toolRegistryFixture.createToolOutputAccess(workspaceRoot, store.getState().rootSessionId),
      projectRoot: workspaceRoot,
      cwd: workspaceRoot,
      projectContextResolver: createTestProjectContextResolver(storeManager),
      resolveVersionControl: async () => "git",
      resolveAllowedTools: (agentDefinition) => agentDefinition.tools.tools,
      logger: silentLogger,
    });
    const { manager } = createManager({ [sessionId]: configuredAgent as unknown as MockAgent });

    try {
      const execution = await manager.startCheckedExecution({
        slug: "project",
        workspaceRoot,
        sessionId,
        input: { kind: "direct", text: "start the Todo" },
      });
      await execution.promise;

      const lifecycleEvents = store.getState().events
        .map((event) => event.payload)
        .filter((payload) => payload.type === "execution-start" || payload.type === "execution-end");
      expect(modelRound).toBe(2);
      expect(store.getState().todos[0]?.status).toBe("completed");
      expect(lifecycleEvents).toEqual([
        expect.objectContaining({
          type: "execution-start",
          executionId: execution.executionId,
          binding: execution.binding.summary,
          origin: "user_message",
        }),
        expect.objectContaining({
          type: "execution-end",
          executionId: execution.executionId,
          terminalStatus: "completed",
        }),
      ]);
      expect(store.getState().executions).toEqual([
        expect.objectContaining({ id: execution.executionId, status: "completed" }),
      ]);
    } finally {
      Date.now = realNow;
      setLlmAdapterForTest(undefined);
      configuredAgent.dispose();
    }
  });

  test("rebuilds the Agent and continues the same Session after cwd changes", async () => {
    const sessionId = crypto.randomUUID();
    const first = new MockAgent(sessionId, Promise.resolve({
      text: "",
      steps: 1,
      cwdChanged: { previousCwd: workspaceRoot, cwd: `${workspaceRoot}.worktrees/feature` },
    }));
    const second = new MockAgent(sessionId, Promise.resolve({ text: "continued", steps: 1 }));
    let released = false;
    const { manager, sessionAgentManager } = createManager({ [sessionId]: first }, {
      getAgent: () => released ? second : first,
      onReleaseAgent: () => { released = true; },
    });

    const execution = await manager.startCheckedExecution({ slug: "project", workspaceRoot, sessionId, input: { kind: "direct", text: "switch and continue" } });
    await execution.promise;

    expect(first.runMock).toHaveBeenCalledWith(expect.anything());
    expect(sessionAgentManager.releaseAgent).toHaveBeenCalledWith(workspaceRoot, sessionId);
    expect(second.runMock).toHaveBeenCalledWith(expect.anything());
    expect(getUserMessageTexts(second.store.getState())).toEqual(["switch and continue"]);
    expect(first.store.getState().executions).toHaveLength(1);
    expect(first.store.getState().executions[0]).toMatchObject({ id: execution.executionId, status: "completed" });
  });

  test("persists every Agent terminal status through one manager-owned lifecycle", async () => {
    const statuses: SessionExecutionTerminalStatus[] = [
      "completed", "max_steps", "failed", "aborted", "cancelled", "timed_out", "interrupted",
    ];
    for (const status of statuses) {
      const sessionId = crypto.randomUUID();
      const agent = new MockAgent(sessionId, Promise.resolve({
        text: status,
        steps: 1,
        status,
        ...(status === "failed" ? { error: "expected failure" } : {}),
      }), workspaceRoot);
      const { manager } = createManager({ [sessionId]: agent });
      const execution = await manager.startCheckedExecution({
        slug: "project",
        workspaceRoot,
        sessionId,
        input: { kind: "direct", text: status },
      });
      await execution.promise;
      expect(agent.store.getState().executions).toEqual([
        expect.objectContaining({
          id: execution.executionId,
          status,
          ...(status === "failed" ? { error: "expected failure" } : {}),
        }),
      ]);
    }
  });

  test("redacts Provider secrets from manager-owned terminal records", async () => {
    const sessionId = crypto.randomUUID();
    const secret = "configured-provider-secret";
    const agent = new MockAgent(sessionId, Promise.resolve({
      text: "safe partial output",
      steps: 1,
      status: "failed",
      error: `Provider echoed ${secret}`,
    }), workspaceRoot);
    const { manager } = createManager({ [sessionId]: agent }, {
      modelRuntime: makeModelRuntime(true, "test:model", "test-runtime-secret", [secret]),
    });

    const execution = await manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId,
      input: { kind: "direct", text: "fail safely" },
    });
    await execution.promise;

    const durable = JSON.stringify({
      events: agent.store.getState().events,
      executions: agent.store.getState().executions,
    });
    expect(durable).not.toContain(secret);
    expect(durable).toContain("[REDACTED_PROVIDER_SECRET]");
  });

  test("HITL suspends and resumes the same logical Execution with a fresh run binding", async () => {
    const sessionId = crypto.randomUUID();
    const store = storeManager.create(sessionId, workspaceRoot, { agentName: "lead" });
    const modelRuntime = makeModelRuntime(true, "test:model", "runtime-before-hitl");
    const bindings: ExecutionModelBinding[] = [];
    let invocation = 0;
    const agent = {
      store,
      cwd: workspaceRoot,
      classifyCommand: mock((_input: string) => null),
      executeCommand: mock(async (_command: AgentCommand): Promise<AgentCommandResult> => ({ kind: "handled" })),
      run: mock(async (binding: ExecutionModelBinding, options?: AgentRunOptions): Promise<AgentResult> => {
        bindings.push(binding);
        invocation += 1;
        if (invocation === 1) {
          const batch = {
            ...blockedToolBatch("resume-after-hitl"),
            executionId: options!.executionId,
          };
          store.setState({ toolBatches: [batch] });
          return {
            outcome: "suspended",
            text: "waiting",
            steps: 1,
            suspension: {
              kind: "hitl",
              toolBatchId: batch.batchId,
              blockerIds: ["resume-after-hitl"],
            },
          };
        }
        return { outcome: "terminal", text: "resumed", steps: 1, status: "completed" };
      }),
      dispose: mock(() => undefined),
    } as Agent;
    const { manager } = createManager({ [sessionId]: agent as MockAgent }, { modelRuntime });

    const waiting = await manager.startCheckedExecution({
      slug: "project", workspaceRoot, sessionId, input: { kind: "direct", text: "ask" },
    });
    await waiting.promise;
    modelRuntime.publish(makeModelRuntime(true, "test:other", "runtime-after-hitl").current);
    store.setState((state) => ({
      toolBatches: state.toolBatches.map((batch) => ({
        ...batch,
        calls: batch.calls.map((call) => ({ ...call, state: "completed" as const, blocker: undefined })),
      })),
    }));
    const resumed = await manager.reconcileDurableSession({
      slug: "project", workspaceRoot, sessionId,
    });
    await resumed!.promise;

    expect(waiting.executionId).toBe(resumed!.executionId);
    expect(store.getState().executions.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: waiting.executionId, status: "completed" },
    ]);
    expect(bindings.map((binding) => binding.summary)).toEqual([
      expect.objectContaining({
        selection: { model: "test:model" },
        modelRuntimeRevision: "runtime-before-hitl",
      }),
      expect.objectContaining({
        selection: { model: "test:other" },
        modelRuntimeRevision: "runtime-after-hitl",
      }),
    ]);
  });

  test("resumed child timeout uses remaining active duration and excludes suspended wait", async () => {
    const parentId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const executionId = `execution-${childId}`;
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
    const originalLink = makeChildLink(parentId, childId, "explore");
    parentStore.setState({
      childSessionLinks: [{
        ...originalLink,
        childExecutionId: executionId,
        status: "waiting_for_human",
      }],
    });
    const childStore = createTestSession(storeManager, childId, workspaceRoot, {
      rootSessionId: parentId,
      parentSessionId: parentId,
      agentName: "explore",
      title: "Delegated child",
    });
    childStore.getState().append({
      ...testExecutionStart(executionId),
      activeTimeoutMs: 100,
    });
    const startedAt = childStore.getState().executions[0]!.startedAt;
    const batch = blockedToolBatch("active-time");
    childStore.setState({
      toolBatches: [{
        ...batch,
        executionId,
        agentName: "explore",
        calls: batch.calls.map((call) => ({
          ...call,
          state: "completed" as const,
          blocker: undefined,
        })),
      }],
    });
    childStore.getState().append(testExecutionSuspended(
      executionId,
      { kind: "hitl", toolBatchId: batch.batchId, blockerIds: ["already-answered"] },
      { runEndedAt: startedAt + 40 },
    ));

    const resumedRun = deferred<MockAgentResult>();
    const childAgent = {
      store: childStore,
      cwd: workspaceRoot,
      classifyCommand: mock((_input: string) => null),
      executeCommand: mock(async (_command: AgentCommand): Promise<AgentCommandResult> => ({ kind: "handled" })),
      run: mock(async (): Promise<AgentResult> => normalizeMockAgentResult(await resumedRun.promise)),
      dispose: mock(() => undefined),
    } as unknown as MockAgent;
    const deadlineScheduler = createTestDeadlineScheduler();
    const terminalLinkFlushed = deferred<void>();
    const { manager } = createManager({ [childId]: childAgent }, {
      factory: makeFactory(),
      deadlineScheduler,
      flushSessionStore: async (sessionId, root) => {
        await storeManager.flushSession(sessionId, root);
        if (
          sessionId === parentId
          && parentStore.getState().childSessionLinks.at(-1)?.status === "completed"
        ) terminalLinkFlushed.resolve(undefined);
      },
    });

    const resumed = await manager.reconcileDurableSession({
      slug: "project",
      workspaceRoot,
      sessionId: childId,
    });
    expect(resumed?.executionId).toBe(executionId);
    const resumedDelay = deadlineScheduler.scheduledDelays().at(-1)!;
    expect(resumedDelay).toBeGreaterThan(0);
    expect(resumedDelay).toBeLessThanOrEqual(60);
    expect(childStore.getState().executions[0]).toMatchObject({
      id: executionId,
      durationMs: 40,
      status: "running",
    });
    const runningLink = parentStore.getState().childSessionLinks.at(-1)!;
    expect(runningLink.createdAt).toBe(originalLink.createdAt);
    expect(runningLink.startedAt).toBe(startedAt);
    expect(runningLink.endedAt).toBeUndefined();
    expect(runningLink.durationMs).toBeGreaterThanOrEqual(40);
    expect(runningLink.durationUpdatedAt).toEqual(expect.any(Number));

    resumedRun.resolve({ text: "done", steps: 1 });
    await resumed!.promise;
    await terminalLinkFlushed.promise;
    const terminalLink = parentStore.getState().childSessionLinks.at(-1)!;
    expect(terminalLink.status).toBe("completed");
    expect(terminalLink.startedAt).toBe(startedAt);
    expect(terminalLink.durationMs).toBe(childStore.getState().executions[0]!.durationMs);
    expect(terminalLink.durationUpdatedAt).toEqual(expect.any(Number));
  });

  test("reconciles exact sync-child intent across absent, created, running, suspended, and terminal states", async () => {
    const cases = ["absent", "created", "running", "suspended", "terminal"] as const;
    for (const childState of cases) {
      const parentId = crypto.randomUUID();
      const childId = crypto.randomUUID();
      const parentExecutionId = `parent-${childState}`;
      const childExecutionId = `child-${childState}`;
      const batchId = `batch-${childState}`;
      const toolCallId = `delegate-${childState}`;
      const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
      const parentAgent = {
        store: parentStore,
        cwd: workspaceRoot,
        classifyCommand: mock((_input: string) => null),
        executeCommand: mock(async (_command: AgentCommand): Promise<AgentCommandResult> => ({ kind: "handled" })),
        run: mock(async (): Promise<AgentResult> => ({
          outcome: "terminal",
          text: "parent resumed",
          steps: 1,
          status: "completed",
        })),
        dispose: mock(() => undefined),
      } as unknown as MockAgent;
      parentStore.getState().append(testExecutionStart(parentExecutionId));
      const parentStartedAt = parentStore.getState().executions[0]!.startedAt;
      const parentBatch: SessionToolBatch = {
        batchId,
        executionId: parentExecutionId,
        runOrdinal: 0,
        step: 0,
        agentName: "lead",
        allowedTools: ["delegate"],
        agentSkills: [],
        partitions: [{ type: "serial", callIds: [toolCallId] }],
        calls: [{
          ordinal: 0,
          partitionIndex: 0,
          toolCallId,
          toolName: "delegate",
          input: delegationRequest({ objective: `recover ${childState}`, background: false }),
          traits: { readOnly: false, destructive: false, concurrencySafe: false },
          state: "child_launch",
          attempt: 1,
          checkpointAt: parentStartedAt,
          childDependency: {
            kind: "child_launch",
            parentExecutionId,
            runOrdinal: 0,
            toolCallId,
            childSessionId: childId,
            childExecutionId,
            createdAt: parentStartedAt,
          },
        }],
        createdAt: new Date(parentStartedAt).toISOString(),
        updatedAt: new Date(parentStartedAt).toISOString(),
      };
      parentStore.setState({ toolBatches: [parentBatch] });
      parentStore.getState().append(testExecutionSuspended(
        parentExecutionId,
        {
          kind: "child_dependency",
          toolBatchId: batchId,
          toolCallId,
          childSessionId: childId,
          childExecutionId,
        },
        {
          runEndedAt: parentStartedAt + 1,
          runSettlement: { key: `run:${parentId}:${parentExecutionId}:0`, goalInstanceId: null },
        },
      ));

      let childStore: StoreApi<SessionStoreState> | undefined;
      if (childState !== "absent") {
        childStore = createTestSession(storeManager, childId, workspaceRoot, {
          rootSessionId: parentId,
          parentSessionId: parentId,
          agentName: "explore",
          title: "Delegated child",
          delegationRequest: delegationRequest({ objective: `recover ${childState}`, background: false }),
        });
      }
      if (childState === "running" || childState === "suspended" || childState === "terminal") {
        childStore!.getState().append(testExecutionStart(childExecutionId));
      }
      if (childState === "suspended") {
        const childBatch = blockedToolBatch(`child-${childState}`);
        childStore!.setState({
          toolBatches: [{ ...childBatch, executionId: childExecutionId, agentName: "explore" }],
        });
        const childStartedAt = childStore!.getState().executions[0]!.startedAt;
        childStore!.getState().append(testExecutionSuspended(
          childExecutionId,
          { kind: "hitl", toolBatchId: childBatch.batchId, blockerIds: [`child-${childState}`] },
          {
            runEndedAt: childStartedAt + 1,
            runSettlement: { key: `run:${childId}:${childExecutionId}:0`, goalInstanceId: null },
          },
        ));
      } else if (childState === "terminal") {
        const childStartedAt = childStore!.getState().executions[0]!.startedAt;
        childStore!.getState().append(testExecutionEnd(childExecutionId, "completed", {
          endedAt: childStartedAt + 1,
          runEndedAt: childStartedAt + 1,
          runSettlement: { key: `run:${childId}:${childExecutionId}:0`, goalInstanceId: null },
          terminalSettlement: { key: `terminal:${childId}:${childExecutionId}`, goalInstanceId: null },
        }));
      }

      const childRun = deferred<MockAgentResult>();
      const applyOutcome = mock(async (outcome: Parameters<NonNullable<FakeManagerOptions["applyChildDependencyOutcome"]>>[0]) => {
        await applySessionToolBatchChildOutcome({
          storeManager,
          sessionId: outcome.parentSessionId,
          workspaceRoot: outcome.workspaceRoot,
          batchId: outcome.parentToolBatchId,
          toolCallId: outcome.parentToolCallId,
          childSessionId: outcome.childSessionId,
          childExecutionId: outcome.childExecutionId,
          outcome: outcome.outcome,
        });
      });
      const { manager } = createManager({ [parentId]: parentAgent }, {
        factory: makeFactory(),
        childRun: childRun.promise,
        applyChildDependencyOutcome: applyOutcome,
      });

      const reconciled = await manager.reconcileDurableSession({
        slug: "project",
        workspaceRoot,
        sessionId: parentId,
      });
      const canonicalChild = storeManager.get(childId, workspaceRoot);
      expect(canonicalChild, childState).toBeDefined();
      expect(canonicalChild!.getState().executions.filter((execution) => execution.id === childExecutionId), childState)
        .toHaveLength(1);
      expect(parentStore.getState().toolBatches[0]!.calls[0]!.childDependency?.kind, childState)
        .toBe("child_dependency");
      expect(parentStore.getState().childSessionLinks, childState).toContainEqual(expect.objectContaining({
        parentToolCallId: toolCallId,
        childSessionId: childId,
        childExecutionId,
      }));

      if (childState === "absent" || childState === "created") {
        expect(canonicalChild!.getState().executions[0]!.status, childState).toBe("running");
        expect(parentStore.getState().executions[0]!.status, childState).toBe("suspended");
        expect(manager.getSessionFamilyActivity(workspaceRoot, parentId), childState)
          .toBe("waiting_for_human");
        childRun.resolve({ text: "child recovered", steps: 1 });
        await manager.getExecution(workspaceRoot, childId)!.promise;
      } else if (childState === "suspended") {
        expect(canonicalChild!.getState().executions[0]!.status).toBe("suspended");
        expect(parentStore.getState().executions[0]!.status).toBe("suspended");
        expect(reconciled).toBeUndefined();
      } else {
        expect(applyOutcome).toHaveBeenCalledTimes(1);
        await reconciled?.promise;
        expect(parentStore.getState().executions[0]!.status, childState).toBe("completed");
      }
    }
  });

  test("reconciles a three-level sync dependency at the deepest resume-pending child first", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const grandchildId = crypto.randomUUID();
    const rootStore = storeManager.create(rootId, workspaceRoot, {
      agentName: "lead",
      title: "Root",
    });
    const childStore = createTestSession(storeManager, childId, workspaceRoot, {
      rootSessionId: rootId,
      parentSessionId: rootId,
      agentName: "build",
      title: "Build child",
      delegationRequest: delegationRequest({
        agent_type: "build",
        title: "Build child",
        background: false,
      }),
    });
    const grandchildStore = createTestSession(
      storeManager,
      grandchildId,
      workspaceRoot,
      {
        rootSessionId: rootId,
        parentSessionId: childId,
        agentName: "explore",
        title: "Explore grandchild",
        delegationRequest: delegationRequest({
          agent_type: "explore",
          title: "Explore grandchild",
          background: false,
        }),
      },
    );
    const seedDependency = (
      parentStore: StoreApi<SessionStoreState>,
      parentExecutionId: string,
      childSessionId: string,
      childExecutionId: string,
      agentName: "lead" | "build",
      agentType: "build" | "explore",
    ): void => {
      parentStore.getState().append(testExecutionStart(parentExecutionId));
      const startedAt = parentStore.getState().executions.at(-1)!.startedAt;
      const batchId = `batch-${parentExecutionId}`;
      const toolCallId = `delegate-${childSessionId}`;
      parentStore.setState({
        toolBatches: [{
          batchId,
          executionId: parentExecutionId,
          runOrdinal: 0,
          step: 0,
          agentName,
          allowedTools: ["delegate"],
          agentSkills: [],
          partitions: [{ type: "serial", callIds: [toolCallId] }],
          calls: [{
            ordinal: 0,
            partitionIndex: 0,
            toolCallId,
            toolName: "delegate",
            input: delegationRequest({
              agent_type: agentType,
              title: `Delegate ${childSessionId}`,
              background: false,
            }),
            traits: {
              readOnly: false,
              destructive: false,
              concurrencySafe: false,
            },
            state: "child_dependency",
            attempt: 1,
            checkpointAt: startedAt,
            childDependency: {
              kind: "child_dependency",
              parentExecutionId,
              runOrdinal: 0,
              toolCallId,
              childSessionId,
              childExecutionId,
              createdAt: startedAt,
              dependencyStartedAt: startedAt + 1,
            },
          }],
          createdAt: new Date(startedAt).toISOString(),
          updatedAt: new Date(startedAt + 1).toISOString(),
        }],
      });
      parentStore.getState().append(testExecutionSuspended(
        parentExecutionId,
        {
          kind: "child_dependency",
          toolBatchId: batchId,
          toolCallId,
          childSessionId,
          childExecutionId,
        },
        {
          runEndedAt: startedAt + 1,
          runSettlement: {
            key: `run:${parentStore.getState().sessionId}:${parentExecutionId}:0`,
            goalInstanceId: null,
          },
        },
      ));
    };
    seedDependency(
      rootStore,
      "execution-root",
      childId,
      "execution-child",
      "lead",
      "build",
    );
    seedDependency(
      childStore,
      "execution-child",
      grandchildId,
      "execution-grandchild",
      "build",
      "explore",
    );
    grandchildStore.getState().append(testExecutionStart("execution-grandchild"));
    const grandchildStartedAt =
      grandchildStore.getState().executions[0]!.startedAt;
    const grandchildBatch = blockedToolBatch("grandchild-ready");
    grandchildStore.setState({
      toolBatches: [{
        ...grandchildBatch,
        executionId: "execution-grandchild",
        agentName: "explore",
        calls: grandchildBatch.calls.map((call) => ({
          ...call,
          state: "queued" as const,
          blocker: undefined,
          checkpointAt: grandchildStartedAt + 1,
        })),
      }],
    });
    grandchildStore.getState().append(testExecutionSuspended(
      "execution-grandchild",
      {
        kind: "hitl",
        toolBatchId: grandchildBatch.batchId,
        blockerIds: ["grandchild-ready"],
      },
      {
        runEndedAt: grandchildStartedAt + 1,
        runSettlement: {
          key: `run:${grandchildId}:execution-grandchild:0`,
          goalInstanceId: null,
        },
      },
    ));
    grandchildStore.getState().append({
      type: "execution-suspension-updated",
      executionId: "execution-grandchild",
      suspension: {
        kind: "resume_pending",
        toolBatchId: grandchildBatch.batchId,
        readyAt: grandchildStartedAt + 1,
      },
    });
    const grandchildStarted = deferred<void>();
    const grandchildRun = deferred<MockAgentResult>();
    const grandchildAgent = {
      store: grandchildStore,
      cwd: workspaceRoot,
      classifyCommand: () => null,
      executeCommand: async () => ({ kind: "handled" as const }),
      run: mock(async (): Promise<AgentResult> => {
        grandchildStarted.resolve(undefined);
        return normalizeMockAgentResult(await grandchildRun.promise);
      }),
      dispose: () => undefined,
    } as unknown as MockAgent;
    const factory = makeBuildFactory();
    const { manager } = createManager(
      { [grandchildId]: grandchildAgent },
      {
        factory: makeFactory({
          getDefinition: factory.getDefinition,
          listAgentNames: mock(() => ["lead", "build", "explore"]),
        }),
      },
    );

    await manager.reconcileDurableSession({
      slug: "project",
      workspaceRoot,
      sessionId: rootId,
    });
    await grandchildStarted.promise;

    expect(rootStore.getState().executions[0]?.status).toBe("suspended");
    expect(childStore.getState().executions[0]?.status).toBe("suspended");
    expect(grandchildStore.getState().executions[0]).toMatchObject({
      id: "execution-grandchild",
      status: "running",
      runs: [{ ordinal: 0 }, { ordinal: 1 }],
    });

    const activeGrandchild = manager.getExecution(workspaceRoot, grandchildId);
    grandchildRun.resolve({ text: "deepest resumed", steps: 1 });
    await activeGrandchild!.promise;
  });

  test("automatically retries a capacity-blocked resume when the child slot is released", async () => {
    const parentId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, {
      agentName: "lead",
      title: "Parent",
    });
    const targetStore = createTestSession(storeManager, targetId, workspaceRoot, {
      rootSessionId: parentId,
      parentSessionId: parentId,
      agentName: "explore",
      title: "Resume target",
      delegationRequest: delegationRequest({
        agent_type: "explore",
        title: "Resume target",
        background: false,
      }),
    });
    const targetStarted = deferred<void>();
    const targetRun = deferred<MockAgentResult>();
    const targetRunMock = mock(async (): Promise<AgentResult> => {
      targetStarted.resolve(undefined);
      return normalizeMockAgentResult(await targetRun.promise);
    });
    const targetAgent = {
      store: targetStore,
      cwd: workspaceRoot,
      classifyCommand: () => null,
      executeCommand: async () => ({ kind: "handled" as const }),
      run: targetRunMock,
      dispose: () => undefined,
    } as unknown as MockAgent;
    const holderRun = deferred<MockAgentResult>();
    let manager!: TestSessionExecutionManager;
    ({ manager } = createManager(
      { [targetId]: targetAgent },
      {
        childRun: holderRun.promise,
        onContinuationAdmissionReleased: async () => {
          await manager.reconcileDurableSession({
            slug: "project",
            workspaceRoot,
            sessionId: targetId,
          });
        },
      },
    ));
    const holder = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "capacity-holder",
      toolName: "delegate",
      request: delegationRequest({
        agent_type: "explore",
        title: "Capacity holder",
        background: true,
      }),
      parentAbort: undefined,
    });

    targetStore.getState().append(testExecutionStart("execution-target"));
    const targetStartedAt = targetStore.getState().executions[0]!.startedAt;
    const targetBatch = blockedToolBatch("target-ready");
    targetStore.setState({
      toolBatches: [{
        ...targetBatch,
        executionId: "execution-target",
        agentName: "explore",
        calls: targetBatch.calls.map((call) => ({
          ...call,
          state: "queued" as const,
          blocker: undefined,
          checkpointAt: targetStartedAt + 1,
        })),
      }],
    });
    targetStore.getState().append(testExecutionSuspended(
      "execution-target",
      {
        kind: "hitl",
        toolBatchId: targetBatch.batchId,
        blockerIds: ["target-ready"],
      },
      {
        runEndedAt: targetStartedAt + 1,
        runSettlement: {
          key: `run:${targetId}:execution-target:0`,
          goalInstanceId: null,
        },
      },
    ));
    targetStore.getState().append({
      type: "execution-suspension-updated",
      executionId: "execution-target",
      suspension: {
        kind: "resume_pending",
        toolBatchId: targetBatch.batchId,
        readyAt: targetStartedAt + 1,
      },
    });

    expect(await manager.reconcileDurableSession({
      slug: "project",
      workspaceRoot,
      sessionId: targetId,
    })).toBeUndefined();
    expect(targetRunMock).not.toHaveBeenCalled();

    holderRun.resolve({ text: "slot released", steps: 1 });
    await holder.result;
    await targetStarted.promise;

    expect(targetRunMock).toHaveBeenCalledTimes(1);
    expect(targetStore.getState().executions[0]).toMatchObject({
      id: "execution-target",
      status: "running",
      runs: [{ ordinal: 0 }, { ordinal: 1 }],
    });

    const activeTarget = manager.getExecution(workspaceRoot, targetId);
    targetRun.resolve({ text: "resumed automatically", steps: 1 });
    await activeTarget!.promise;
  });


  test("checked execution forwards maxSteps to agent.run", async () => {
    const sessionId = crypto.randomUUID();
    const agent = new MockAgent(sessionId, Promise.resolve({ text: "done", steps: 1 }));
    const { manager } = createManager({ [sessionId]: agent });

    const execution = await manager.startCheckedExecution({ slug: "project", workspaceRoot, sessionId, input: { kind: "direct", text: "work" }, maxSteps: 1 });
    await execution.promise;

    expect(agent.runMock).toHaveBeenCalledWith(expect.objectContaining({ maxSteps: 1 }));
  });

  test("checked execution forwards extraTools to agent.run", async () => {
    const sessionId = crypto.randomUUID();
    const agent = new MockAgent(sessionId, Promise.resolve({ text: "done", steps: 1 }));
    const { manager } = createManager({ [sessionId]: agent });

    const execution = await manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId,
      input: { kind: "direct", text: "work" },
      extraTools: ["github_get_pull_request"],
    });
    await execution.promise;

    expect(agent.runMock).toHaveBeenCalledWith(expect.objectContaining({ extraTools: ["github_get_pull_request"] }));
  });

  test("checked execution uses the persisted Session agent identity", async () => {
    const sessionId = crypto.randomUUID();
    const agent = new MockAgent(sessionId, Promise.resolve({ text: "done", steps: 1 }));
    const { manager, sessionAgentManager } = createManager({ [sessionId]: agent });

    const execution = await manager.startCheckedExecution({ slug: "project", workspaceRoot, sessionId, input: { kind: "direct", text: "work" } });
    await execution.promise;

    expect(execution.agentName).toBe("lead");
    expect(sessionAgentManager.getOrCreate).toHaveBeenCalledWith(workspaceRoot, sessionId);
  });

  test("atomically rejects duplicate starts while agent creation is pending", async () => {
    const sessionId = crypto.randomUUID();
    storeManager.create(sessionId, workspaceRoot, { agentName: "lead" });
    const sessionAgentManager = createFakeManager({});
    const pendingManager = new SessionExecutionManager({
      sessionAgentManager: {
        ...sessionAgentManager,
        getOrCreate: mock(async () => await new Promise<Agent>(() => undefined)),
      } as unknown as SessionAgentManager,
      modelRuntime: makeModelRuntime(),
      modelSelectionResolver: new ModelSelectionResolver(),
      ...storeCallbacks(storeManager),
      listSessionFamilyToolBatchHitlIds: async () => [],
      cancelSessionToolBatch: async () => undefined,
      applyChildDependencyOutcome: async () => undefined,
      onSessionInputMutationReleased: async () => undefined,
      onContinuationAdmissionReleased: async () => undefined,
      resolveGoalInstanceId: async () => null,
      onExecutionSettlement: async () => undefined,
      sessionInputService: new SessionInputService(storeManager),
      trackSession: mock(() => undefined),
      untrackSession: mock(() => undefined),
      executionScopeValidator: allowExecutionScope,
      logger: silentLogger,
    });

    await pendingManager.startCheckedExecution({ slug: "project", workspaceRoot, sessionId, input: { kind: "direct", text: "one" } });

    await expect(pendingManager.startCheckedExecution({ slug: "project", workspaceRoot, sessionId, input: { kind: "direct", text: "two" } })).rejects.toThrow(SessionFamilyActiveError);
  });

  test("family stop cancels execution without fabricating a query-loop tool result", async () => {
    const run = deferred<MockAgentResult>();
    const sessionId = crypto.randomUUID();
    const agent = new MockAgent(sessionId, run.promise, workspaceRoot);
    const { manager } = createManager({ [sessionId]: agent });

    const execution = await manager.startCheckedExecution({ slug: "project", workspaceRoot, sessionId, input: { kind: "direct", text: "work" } });
    await Promise.resolve();
    agent.store.getState().append({ type: "tool-input-start", toolCallId: "late-tool", toolName: "bash" });
    agent.store.getState().append({ type: "tool-call", toolCallId: "late-tool", toolName: "bash", input: {} });
    const stopping = manager.stopSessionFamily(workspaceRoot, sessionId);
    run.resolve({ text: "done", steps: 1 });
    await execution.promise;
    await stopping;
    const state = agent.store.getState();
    expect(state.executions).toHaveLength(1);
    expect(state.executions[0]?.status).toBe("cancelled");
    const tool = state.messages.flatMap((message) => message.parts).find((part) => part.type === "tool");
    expect(tool).toMatchObject({ type: "tool", state: "running", toolCallId: "late-tool" });
  });

  test("family stop is isolated by workspace root for identical session ids", async () => {
    const sessionId = crypto.randomUUID();
    const otherWorkspaceRoot = join(tmpdir(), "archcode-session-execution-manager-other-workspace", crypto.randomUUID());
    await mkdir(otherWorkspaceRoot, { recursive: true });
    const runA = deferred<MockAgentResult>();
    const runB = deferred<MockAgentResult>();
    const agentA = new MockAgent(sessionId, runA.promise, workspaceRoot);
    const agentB = new MockAgent(sessionId, runB.promise, otherWorkspaceRoot);
    const { manager } = createManager({ [sessionId]: agentA });
    const sessionAgentManager = createFakeManager({ [sessionId]: agentB });
    const managerB = new SessionExecutionManager({
      sessionAgentManager,
      modelRuntime: makeModelRuntime(),
      modelSelectionResolver: new ModelSelectionResolver(),
      ...storeCallbacks(storeManager),
      listSessionFamilyToolBatchHitlIds: async () => [],
      cancelSessionToolBatch: async () => undefined,
      applyChildDependencyOutcome: async () => undefined,
      onSessionInputMutationReleased: async () => undefined,
      onContinuationAdmissionReleased: async () => undefined,
      resolveGoalInstanceId: async () => null,
      onExecutionSettlement: async () => undefined,
      sessionInputService: new SessionInputService(storeManager),
      trackSession: mock(() => undefined),
      untrackSession: mock(() => undefined),
      executionScopeValidator: allowExecutionScope,
      logger: silentLogger,
    });
    const executionA = await manager.startCheckedExecution({ slug: "project-a", workspaceRoot, sessionId, input: { kind: "direct", text: "a" } });
    const executionB = await managerB.startCheckedExecution({ slug: "project-b", workspaceRoot: otherWorkspaceRoot, sessionId, input: { kind: "direct", text: "b" } });

    const stopping = manager.stopSessionFamily(workspaceRoot, sessionId);
    runA.resolve({ text: "done", steps: 1 });
    await executionA.promise;
    await stopping;

    expect(executionA.abortController.signal.aborted).toBe(true);
    expect(executionB.abortController.signal.aborted).toBe(false);
    runB.resolve({ text: "done", steps: 1 });
    await executionB.promise;
    await rm(otherWorkspaceRoot, { recursive: true, force: true });
  });

  test("stopSessionFamily cancels running executions and waits for quiescence", async () => {
    const sessionId = crypto.randomUUID();
    const agent = new MockAgent(sessionId, new Promise(() => undefined));
    const { manager } = createManager({ [sessionId]: agent });

    const execution = await manager.startCheckedExecution({ slug: "project", workspaceRoot, sessionId, input: { kind: "direct", text: "stop" } });
    const stopping = manager.stopSessionFamily(workspaceRoot, sessionId);
    await execution.promise;
    await stopping;
    expect(execution.abortController.signal.aborted).toBe(true);
    expect(manager.getSessionFamilyActivity(workspaceRoot, sessionId)).toBe("idle");

    const secondSessionId = crypto.randomUUID();
    const agentTwo = new MockAgent(secondSessionId, new Promise(() => undefined));
    const second = createManager({ [secondSessionId]: agentTwo });
    const secondExecution = await second.manager.startCheckedExecution({ slug: "project", workspaceRoot, sessionId: secondSessionId, input: { kind: "direct", text: "stop" } });
    await second.manager.stopSessionFamily(workspaceRoot, secondSessionId);
    await secondExecution.promise;
    expect(secondExecution.abortController.signal.aborted).toBe(true);
  });

  test("stopSessionFamily force-terminalizes a hung agent that ignores abort", async () => {
    const sessionId = crypto.randomUUID();
    const goalInstanceId = crypto.randomUUID();
    const settlements: Parameters<NonNullable<FakeManagerOptions["onExecutionSettlement"]>>[0][] = [];
    const firstRunEntered = deferred<void>();
    class HungAgent implements Agent {
      readonly store;
      readonly cwd: string;
      readonly disposeMock = mock(() => undefined);
      #runCount = 0;
      readonly runMock = mock(async (_options?: AgentRunOptions): Promise<AgentResult> => {
        this.#runCount += 1;
        if (this.#runCount === 1) {
          firstRunEntered.resolve(undefined);
          await new Promise<never>(() => undefined);
          return { outcome: "terminal", text: "never", steps: 1, status: "completed" };
        }
        return { outcome: "terminal", text: "next", steps: 1, status: "completed" };
      });
      constructor(sessionId: string, workspaceRoot: string) {
        this.store = createTestSession(storeManager, sessionId, workspaceRoot, { agentName: "lead" });
        this.cwd = this.store.getState().cwd;
      }
      classifyCommand(): AgentCommand | null { return null; }
      async executeCommand(
        _command: AgentCommand,
        _binding: ExecutionModelBinding,
      ): Promise<AgentCommandResult> {
        return { kind: "handled" };
      }
      run(_binding: ExecutionModelBinding, options?: AgentRunOptions): Promise<AgentResult> {
        return this.runMock(options);
      }
      dispose(): void { this.disposeMock(); }
    }
    const hung = new HungAgent(sessionId, workspaceRoot);
    const cancelSessionToolBatch = mock(async (id: string, root: string) => {
      const archivedAt = new Date().toISOString();
      hung.store.setState((state) => ({
        toolBatches: state.toolBatches.map((batch) => ({ ...batch, archivedAt, updatedAt: archivedAt })),
      }));
      await storeManager.flushSession(id, root);
    });
    const { manager } = createManager({ [sessionId]: hung as unknown as MockAgent }, {
      sessionFamilyStopTimeoutMs: 50,
      cancelSessionToolBatch,
      flushSessionStore: (id, root) => storeManager.flushSession(id, root),
      resolveGoalInstanceId: async () => goalInstanceId,
      onExecutionSettlement: async (input) => { settlements.push(input); },
    });

    const execution = await manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId,
      input: { kind: "direct", text: "hang" },
    });
    await execution.started;
    await firstRunEntered.promise;
    hung.store.setState({
      goal: {
        instanceId: goalInstanceId,
        generation: 1,
        objective: "Finish the work",
        status: "active",
        usage: { tokens: createEmptySessionStats().usage, executionTimeMs: 0, executionCount: 0 },
        settlementReceipts: [],
        createdAt: 1,
        activatedAt: 1,
        updatedAt: 1,
      },
      toolBatches: [{
        ...blockedToolBatch("force-terminalize"),
        executionId: execution.executionId,
      }],
    });

    await manager.stopSessionFamily(workspaceRoot, sessionId);
    expect(execution.abortController.signal.aborted).toBe(true);
    expect(manager.getSessionFamilyActivity(workspaceRoot, sessionId)).toBe("idle");
    expect(manager.getExecution(workspaceRoot, sessionId)).toBeUndefined();
    expect(hung.store.getState().executions.at(-1)).toMatchObject({
      status: "cancelled",
    });
    expect(hung.store.getState().isRunning).toBe(false);
    expect(cancelSessionToolBatch).toHaveBeenCalledWith(sessionId, workspaceRoot, "Session family cancelled");
    expect(hung.store.getState().toolBatches[0]?.archivedAt).toEqual(expect.any(String));
    expect((await storeManager.getSessionFile(workspaceRoot, sessionId)).toolBatches[0]?.archivedAt)
      .toEqual(expect.any(String));
    expect(settlements.flatMap((entry) => entry.settlements)).toEqual([
      expect.objectContaining({ kind: "run", goalInstanceId }),
      expect.objectContaining({ kind: "terminal", goalInstanceId, terminalStatus: "cancelled" }),
    ]);

    const next = await manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId,
      input: { kind: "direct", text: "next" },
    });
    await next.promise;
    expect(next.executionId).not.toBe(execution.executionId);
  });

  test("stopSessionFamily force-terminalizes a hung child and frees its concurrency slot", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
    const { manager } = createManager({}, {
      sessionFamilyStopTimeoutMs: 50,
      factory: makeFactoryWithChildPolicy({ maxConcurrent: 1 }),
      childAgentFactory: (input) => ({
        store: input.store,
        classifyCommand: mock(() => null),
        executeCommand: mock(async (): Promise<AgentCommandResult> => ({ kind: "handled" })),
        run: mock(async (): Promise<AgentResult> => {
          await new Promise<never>(() => undefined);
          return { outcome: "terminal", text: "never", steps: 1, status: "completed" };
        }),
        dispose: mock(() => undefined),
      }) as unknown as MockAgent,
    });

    const child = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "hung-child-force",
      toolName: "delegate",
      request: delegationRequest({
        agent_type: "explore",
        title: "Hung child",
        objective: "never finish",
        skills: [],
        background: true,
      }),
    });

    expect(manager.getSessionFamilyActivity(workspaceRoot, parentId)).toBe("running");
    expect(parentStore.getState().childSessionLinks.at(-1)).toMatchObject({
      childSessionId: child.sessionId,
      status: "running",
    });

    await expect(manager.stopSessionFamily(workspaceRoot, parentId)).resolves.toBeUndefined();
    expect(manager.getSessionFamilyActivity(workspaceRoot, parentId)).toBe("idle");
    expect(manager.getExecution(workspaceRoot, child.sessionId)).toBeUndefined();
    expect(parentStore.getState().childSessionLinks.at(-1)).toMatchObject({
      childSessionId: child.sessionId,
      status: "cancelled",
    });
    expect(isTerminalChildSessionStatus(parentStore.getState().childSessionLinks.at(-1)!.status)).toBe(true);

    const nextChild = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "after-force-delegate",
      toolName: "delegate",
      request: delegationRequest({
        agent_type: "explore",
        title: "After force",
        objective: "should fit under maxConcurrent 1",
        skills: [],
        background: false,
      }),
    });
    expect(nextChild.sessionId).not.toBe(child.sessionId);
    nextChild.abort();
    await nextChild.result.catch(() => undefined);
  });

  test("stopSessionFamily force-settles a hung session command completion", async () => {
    const sessionId = crypto.randomUUID();
    storeManager.create(sessionId, workspaceRoot, { agentName: "lead" });
    const { manager } = createManager({}, { sessionFamilyStopTimeoutMs: 50 });

    const commandStarted = deferred<void>();
    let commandSignal: AbortSignal | undefined;
    let commandError: unknown;
    const commandRun = manager.runSessionCommand({
      workspaceRoot,
      sessionId,
      clientRequestId: "hung-command",
      requestedModelSelection: TEST_REQUESTED_MODEL_SELECTION,
    }, async (_binding, abort) => {
      commandSignal = abort;
      commandStarted.resolve(undefined);
      await new Promise<never>(() => undefined);
      return "never";
    }).then(
      (result) => {
        commandError = new Error(`expected command rejection, got ${JSON.stringify(result)}`);
      },
      (error: unknown) => {
        commandError = error;
      },
    );

    await commandStarted.promise;
    expect(manager.getSessionFamilyActivity(workspaceRoot, sessionId)).toBe("running");

    await expect(manager.stopSessionFamily(workspaceRoot, sessionId)).resolves.toBeUndefined();
    expect(manager.getSessionFamilyActivity(workspaceRoot, sessionId)).toBe("idle");
    expect(commandSignal?.aborted).toBe(true);
    await commandRun;
    expect(commandError).toBeTruthy();
    expect(String((commandError as { name?: unknown }).name ?? "")).toBe("AbortError");
    expect(String((commandError as { message?: unknown }).message ?? "")).toMatch(/Session family cancelled|cancelled|aborted/i);
  });


  test("family stop generation blocks every new owner and drains an already pending child launch", async () => {
    const rootId = crypto.randomUUID();
    const rootStore = storeManager.create(rootId, workspaceRoot, { agentName: "lead" });
    const skillResolution = deferred<readonly []>();
    const skillResolutionStarted = deferred<void>();
    const factory = makeFactory({
      resolveDelegatedSkillNames: mock(async () => {
        skillResolutionStarted.resolve(undefined);
        return await skillResolution.promise;
      }),
    });
    const { manager } = createManager({}, { factory, sessionFamilyStopTimeoutMs: 100 });
    const pendingChild = manager.startChildExecution(workspaceRoot, {
      parentStore: rootStore,
      parentSessionId: rootId,
      parentToolCallId: "pending-before-stop",
      toolName: "delegate",
      request: delegationRequest({ agent_type: "explore", title: "Delegated child", objective: "resolve slowly", skills: [], background: false }),
    });
    await skillResolutionStarted.promise;
    expect(manager.getSessionFamilyActivity(workspaceRoot, rootId)).toBe("running");
    expect(manager.listSessionFamilyActivities()).toEqual([
      { workspaceRoot, rootSessionId: rootId, activity: "running" },
    ]);

    const stop = manager.acquireSessionFamilyStop({ workspaceRoot, rootSessionId: rootId });
    expect(manager.getSessionFamilyActivity(workspaceRoot, rootId)).toBe("stopping");
    let stopped = false;
    const stopping = stop.stopAndWait().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    await expect(manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId: rootId,
      input: { kind: "direct", text: "must not start" },
    })).rejects.toThrow(SessionFamilyStopInProgressError);
    expect(() => manager.acquireSessionCwdTransition(workspaceRoot, rootId)).toThrow(SessionFamilyStopInProgressError);
    await expect(manager.startChildExecution(workspaceRoot, {
      parentStore: rootStore,
      parentSessionId: rootId,
      parentToolCallId: "new-after-stop",
      toolName: "delegate",
      request: delegationRequest({ agent_type: "explore", title: "Delegated child", objective: "must not launch", skills: [], background: false }),
    })).rejects.toThrow(SessionFamilyStopInProgressError);

    skillResolution.resolve([]);
    await expect(pendingChild).rejects.toThrow(SessionFamilyStopInProgressError);
    await stopping;
    expect(stopped).toBe(true);
    stop.release();
    expect(manager.getSessionFamilyActivity(workspaceRoot, rootId)).toBe("idle");
  });

  test("abortAll cancels every active execution", async () => {
    const firstSessionId = crypto.randomUUID();
    const secondSessionId = crypto.randomUUID();
    const firstAgent = new MockAgent(firstSessionId, new Promise(() => undefined));
    const secondAgent = new MockAgent(secondSessionId, new Promise(() => undefined));
    const { manager } = createManager({ [firstSessionId]: firstAgent, [secondSessionId]: secondAgent });
    const first = await manager.startCheckedExecution({ slug: "project", workspaceRoot, sessionId: firstSessionId, input: { kind: "direct", text: "one" } });
    const second = await manager.startCheckedExecution({ slug: "project", workspaceRoot, sessionId: secondSessionId, input: { kind: "direct", text: "two" } });

    await manager.abortAll();

    expect(first.abortController.signal.aborted).toBe(true);
    expect(second.abortController.signal.aborted).toBe(true);
    expect(manager.getSessionFamilyActivity(workspaceRoot, firstSessionId)).toBe("idle");
    expect(manager.getSessionFamilyActivity(workspaceRoot, secondSessionId)).toBe("idle");
  });

  test("closes all new Runtime admission when restart maintenance claims an idle manager", async () => {
    const sessionId = crypto.randomUUID();
    storeManager.create(sessionId, workspaceRoot, { agentName: "lead" });
    const agent = new MockAgent(
      sessionId,
      Promise.resolve({ text: "must not run", steps: 1 }),
    );
    const { manager } = createManager({ [sessionId]: agent });

    expect(manager.closeAdmissionIfIdle()).toEqual({ ready: true });

    await expect(manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId,
      input: { kind: "direct", text: "must stay closed" },
    })).rejects.toBeInstanceOf(SessionExecutionManagerShuttingDownError);
    expect(agent.runMock).not.toHaveBeenCalled();
    expect(() => manager.acquireSessionFamilyStop({
      workspaceRoot,
      rootSessionId: sessionId,
    })).toThrow(SessionExecutionManagerShuttingDownError);
    expect(() => manager.acquireWorkspaceClose(workspaceRoot))
      .toThrow(SessionExecutionManagerShuttingDownError);
    expect(() => manager.acquireSessionCwdTransition(workspaceRoot, sessionId))
      .toThrow(SessionExecutionManagerShuttingDownError);
    await expect(manager.deleteSession(workspaceRoot, sessionId))
      .rejects.toBeInstanceOf(SessionExecutionManagerShuttingDownError);
    await expect(manager.runRuntimeMutation(
      workspaceRoot,
      async () => undefined,
    )).rejects.toBeInstanceOf(SessionExecutionManagerShuttingDownError);
  });

  test("keeps restart admission open while an internal Runtime mutation drains", async () => {
    const release = deferred<void>();
    const { manager } = createManager({});
    const mutation = manager.runRuntimeMutation(
      workspaceRoot,
      () => release.promise,
    );

    expect(manager.closeAdmissionIfIdle()).toEqual({
      ready: false,
      activeFamilyCount: 1,
    });
    release.resolve(undefined);
    await mutation;
    await manager.runRuntimeMutation(workspaceRoot, async () => undefined);
  });

  test("leaves Runtime admission open when restart maintenance finds active work", async () => {
    const sessionId = crypto.randomUUID();
    const firstRun = deferred<MockAgentResult>();
    const agent = new MockAgent(sessionId, firstRun.promise);
    const { manager } = createManager({ [sessionId]: agent });
    const first = await manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId,
      input: { kind: "direct", text: "finish before restart" },
    });
    await first.started;

    expect(manager.closeAdmissionIfIdle()).toEqual({
      ready: false,
      activeFamilyCount: 1,
    });

    firstRun.resolve({ text: "finished", steps: 1 });
    await first.promise;
    const next = await manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId,
      input: { kind: "direct", text: "admission remains open" },
    });
    await next.promise;
    expect(agent.runMock).toHaveBeenCalledTimes(2);
  });

  test("shutdown closes admission and drains a pending checked start before cancelling active executions", async () => {
    const activeSessionId = crypto.randomUUID();
    const pendingSessionId = crypto.randomUUID();
    const activeAgent = new MockAgent(activeSessionId, new Promise(() => undefined));
    const pendingAgent = new MockAgent(pendingSessionId, Promise.resolve({ text: "must not run", steps: 1 }));
    const loadStarted = deferred<void>();
    const releaseLoad = deferred<StoreApi<SessionStoreState>>();
    const { manager } = createManager({
      [activeSessionId]: activeAgent,
      [pendingSessionId]: pendingAgent,
    }, {
      loadSessionStore: async (sessionId, root) => {
        if (sessionId !== pendingSessionId) return await storeManager.getOrLoad(sessionId, root);
        loadStarted.resolve(undefined);
        return await releaseLoad.promise;
      },
    });
    const active = await manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId: activeSessionId,
      input: { kind: "direct", text: "run until shutdown" },
    });
    await activeAgent.runStarted.promise;
    const pendingStart = manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId: pendingSessionId,
      input: { kind: "direct", text: "must not start" },
    });
    void pendingStart.catch(() => undefined);
    await loadStarted.promise;

    let shutdownSettled = false;
    const shutdown = manager.shutdown().then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    expect(active.abortController.signal.aborted).toBe(false);

    releaseLoad.resolve(pendingAgent.store);
    await expect(pendingStart).rejects.toBeInstanceOf(SessionExecutionManagerShuttingDownError);
    await shutdown;

    expect(active.abortController.signal.aborted).toBe(true);
    expect(pendingAgent.runMock).not.toHaveBeenCalled();
    await expect(manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId: pendingSessionId,
      input: { kind: "direct", text: "still closed" },
    })).rejects.toBeInstanceOf(SessionExecutionManagerShuttingDownError);
  });

  test("startChildExecution validates through factory and runs a child session", async () => {
    const parentId = crypto.randomUUID();
    const worktreeCwd = `${workspaceRoot}.worktrees/child-inheritance`;
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead", cwd: worktreeCwd });
    const factory = makeFactory();
    const { manager, sessionAgentManager } = createManager({}, {
      factory,
      listSessionFamilyToolBatchHitlIds: async () => [],
    });
    const familyChanges: string[] = [];
    manager.subscribeSessionRuntimeChanges((change) => {
      familyChanges.push(`${change.rootSessionId}:${change.activity}`);
    });

    const handle = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "tool-call",
      toolName: "delegate",
      request: delegationRequest({ agent_type: "explore", title: "Delegated child", objective: "inspect", skills: [], background: false }),
      parentAbort: undefined,
    });

    await handle.result;

    expect(sessionAgentManager.createChildAgent).toHaveBeenCalled();
    expect(handle.store.getState().parentSessionId).toBe(parentId);
    expect(handle.store.getState().cwd).toBe(worktreeCwd);
    expect(handle.store.getState().agentName).toBe("explore");
    expect(parentStore.getState().events
      .filter((event) => event.payload.type === "tool-child-session-link")
      .map((event) => (event.payload as { link: ToolChildSessionLink }).link.status)).toEqual(["running", "completed"]);
    expect(parentStore.getState().childSessionLinks.at(-1)).toMatchObject({
      parentSessionId: parentId,
      parentToolCallId: "tool-call",
      toolName: "delegate",
      childSessionId: handle.sessionId,
      childAgentName: "explore",
      childProfile: "fast",
      childSkillNames: [],
      depth: 1,
      background: false,
      status: "completed",
    });
    expect(familyChanges).toEqual([
      `${parentId}:running`,
      `${parentId}:idle`,
    ]);
  });

  test("running-link write failure prevents child run and releases reserved slot", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
    parentStore.setState({
      append: mock(() => { throw new Error("link write failed"); }),
    } as Partial<SessionStoreState>);
    const factory = makeFactory();
    let childRunStarted = false;
    const { manager, sessionAgentManager } = createManager({}, {
      factory,
      childRunStarted: () => { childRunStarted = true; },
    });

    await expect(manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "tool-call",
      toolName: "delegate",
      request: delegationRequest({ agent_type: "explore", title: "Delegated child", objective: "inspect", skills: [], background: false }),
      parentAbort: undefined,
    })).rejects.toThrow("link write failed");

    expect(sessionAgentManager.createChildAgent).toHaveBeenCalledTimes(1);
    expect(childRunStarted).toBe(false);
    const createChildAgentCalls = (sessionAgentManager.createChildAgent as unknown as {
      mock: { calls: Array<[{ sessionId: string }]> };
    }).mock.calls;
    const failedChildId = createChildAgentCalls[0]![0].sessionId;
    expect(sessionAgentManager.releaseAgent).toHaveBeenCalledWith(workspaceRoot, failedChildId);
    expect(sessionAgentManager.get(workspaceRoot, failedChildId)).toBeUndefined();
  });

  test("depth limit is checked before child session creation", async () => {
    const rootId = crypto.randomUUID();
    const middleId = crypto.randomUUID();
    const parentId = crypto.randomUUID();
    storeManager.create(rootId, workspaceRoot, { agentName: "lead" });
    storeManager.create(middleId, workspaceRoot, {
      rootSessionId: rootId,
      parentSessionId: rootId,
      agentName: "lead",
      title: "Middle child",
    });
    const parentStore = storeManager.create(parentId, workspaceRoot, {
      rootSessionId: rootId,
      parentSessionId: middleId,
      agentName: "lead",
      title: "Deep parent",
    });
    const factory = makeFactory();
    const { manager, sessionAgentManager } = createManager({}, { factory });

    await expect(manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "too-deep",
      toolName: "delegate",
      request: delegationRequest({ agent_type: "explore", title: "Delegated child", objective: "inspect", skills: [], background: false }),
      parentAbort: undefined,
    })).rejects.toThrow(DepthLimitError);

    expect(sessionAgentManager.createChildAgent).not.toHaveBeenCalled();
    expect(parentStore.getState().childSessionLinks).toEqual([]);
  });

  test("Todo Discussion create derives maxDepth 2 from the authoritative binding", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
    const { manager, sessionAgentManager } = createManager({}, {
      factory: makeFactoryWithChildPolicy({ maxDepth: 3 }),
      isDiscussionSession: async (_workspaceRoot, sessionId) => sessionId === parentId,
      resolveSessionDepth: async (_workspaceRoot, sessionId) => sessionId === parentId ? 2 : 3,
    });

    await expect(manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "discussion-depth",
      toolName: "delegate",
      request: delegationRequest({
        agent_type: "explore",
        title: "Discussion evidence",
        objective: "Inspect local evidence for this Todo Discussion.",
        skills: [],
        background: false,
      }),
    })).rejects.toBeInstanceOf(DepthLimitError);

    expect(sessionAgentManager.createChildAgent).not.toHaveBeenCalled();
  });

  test("startChildExecution appends link and canonical prompt before model execution", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
    const factory = makeFactory();
    let linkStatusesAtRunStart: string[] = [];
    let promptsAtRunStart: string[] = [];
    let childCanonicalMessage: string | undefined;
    const { manager } = createManager({}, {
      factory,
      childCanonicalMessage: (message) => { childCanonicalMessage = message; },
      childRunStarted: () => {
        linkStatusesAtRunStart = parentStore.getState().events
          .filter((event) => event.payload.type === "tool-child-session-link")
          .map((event) => (event.payload as { link: ToolChildSessionLink }).link.status);
        const childSessionId = parentStore.getState().childSessionLinks.at(-1)?.childSessionId;
        const childStore = childSessionId === undefined ? undefined : storeManager.get(childSessionId, workspaceRoot);
        promptsAtRunStart = childStore === undefined ? [] : getUserMessageTexts(childStore.getState());
      },
    });

    const handle = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "tool-call",
      toolName: "delegate",
      request: delegationRequest({ agent_type: "explore", title: "Delegated child", objective: "inspect", skills: [], background: false }),
      parentAbort: undefined,
    });
    await handle.result;

    expect(linkStatusesAtRunStart).toEqual(["running"]);
    expect(promptsAtRunStart).toEqual(["inspect"]);
    expect(childCanonicalMessage).toBe("inspect");
  });

  test("startChildExecution persists child identity before exposing its parent link or running it", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
    const flush = deferred<void>();
    const flushStarted = deferred<void>();
    let flushedChildSessionId: string | undefined;
    let promptsAtFlush: string[] = [];
    let childRunStarted = false;
    const { manager, sessionAgentManager } = createManager({}, {
      factory: makeFactory(),
      flushSessionStore: async (sessionId) => {
        flushedChildSessionId = sessionId;
        flushStarted.resolve(undefined);
        const childStore = storeManager.get(sessionId, workspaceRoot);
        promptsAtFlush = childStore === undefined ? [] : getUserMessageTexts(childStore.getState());
        await flush.promise;
      },
      childRunStarted: () => { childRunStarted = true; },
    });

    const pending = manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "durable-child",
      toolName: "delegate",
      request: delegationRequest({ agent_type: "explore", title: "Delegated child", objective: "inspect", skills: [], background: false }),
      parentAbort: undefined,
    });
    await flushStarted.promise;

    expect(promptsAtFlush).toEqual([]);
    expect(parentStore.getState().childSessionLinks).toEqual([]);
    expect(sessionAgentManager.createChildAgent).not.toHaveBeenCalled();
    expect(childRunStarted).toBe(false);

    flush.resolve(undefined);
    const handle = await pending;
    await handle.result;

    expect(handle.sessionId).toBe(flushedChildSessionId!);
    expect(parentStore.getState().childSessionLinks.at(-1)).toMatchObject({
      childSessionId: handle.sessionId,
      status: "completed",
    });
    expect(childRunStarted).toBe(true);
  });

  test("sync child execution exposes live parent link and canonical prompt before resolving", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
    const childRun = deferred<MockAgentResult>();
    const childCanonicalReady = deferred<void>();
    let linkWhileRunning: ToolChildSessionLink | undefined;
    let resultResolved = false;
    let childCanonicalMessage: string | undefined;
    const { manager } = createManager({}, {
      factory: makeFactory(),
      childRun: childRun.promise,
      childCanonicalMessage: (message) => {
        childCanonicalMessage = message;
        childCanonicalReady.resolve(undefined);
      },
      childRunStarted: () => {
        linkWhileRunning = parentStore.getState().childSessionLinks.at(-1);
      },
    });

    const handle = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "sync-tool-call",
      toolName: "delegate",
      request: delegationRequest({ agent_type: "explore", title: "Delegated child", objective: "inspect", skills: [], background: false }),
      parentAbort: undefined,
    });
    handle.result.then(() => { resultResolved = true; });
    await childCanonicalReady.promise;

    expect(resultResolved).toBe(false);
    expect(linkWhileRunning).toMatchObject({
      parentSessionId: parentId,
      parentToolCallId: "sync-tool-call",
      childSessionId: handle.sessionId,
      status: "running",
      background: false,
    });
    expect(childCanonicalMessage).toBe("inspect");
    expect(getUserMessageTexts(handle.store.getState())).toEqual(["inspect"]);
    expect(handle.store.getState().messages.some((message) => message.role === "assistant")).toBe(false);

    childRun.resolve({ text: "live child done", steps: 1 });
    const result = await handle.result;

    expect(result).toMatchObject({
      executionStatus: "completed",
      output: "live child done",
    });
    expect(resultResolved).toBe(true);
    expect(parentStore.getState().childSessionLinks.at(-1)).toMatchObject({
      childSessionId: handle.sessionId,
      status: "completed",
    });
  });

  test("child HITL pause remains non-terminal, then family Stop converges its link once", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
    const { manager } = createManager({}, {
      factory: makeFactory(),
      childRun: Promise.resolve({
        outcome: "suspended",
        text: "waiting",
        steps: 1,
        suspension: {
          kind: "hitl",
          toolBatchId: "child-batch",
          blockerIds: ["child-hitl"],
        },
      }),
    });

    const handle = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "hitl-child",
      toolName: "delegate",
      request: delegationRequest({ agent_type: "explore", title: "Delegated child", objective: "wait for approval", skills: [], background: true }),
      parentAbort: undefined,
    });
    await handle.result;

    expect(parentStore.getState().childSessionLinks.at(-1)).toMatchObject({
      childSessionId: handle.sessionId,
      status: "waiting_for_human",
    });
    expect(parentStore.getState().reminders).toEqual([]);

    await manager.stopSessionFamily(workspaceRoot, parentId);

    expect(handle.store.getState().executions.at(-1)).toMatchObject({
      id: handle.executionId,
      status: "cancelled",
    });
    expect(parentStore.getState().childSessionLinks.at(-1)).toMatchObject({
      childSessionId: handle.sessionId,
      childExecutionId: handle.executionId,
      status: "cancelled",
    });
    expect(parentStore.getState().reminders.filter((reminder) =>
      reminder.source.type === "subagent_cancelled" && reminder.sessionId === handle.sessionId
    )).toHaveLength(1);
  });



  test("startChildExecution maps failure and a triggered deadline to terminal link statuses", async () => {
    const failedParentId = crypto.randomUUID();
    const failedParentStore = storeManager.create(failedParentId, workspaceRoot, { agentName: "lead" });
    const failedRun = Promise.reject(new Error("child exploded"));
    // The child snapshot durability barrier adds an async boundary before run().
    void failedRun.catch(() => undefined);
    const failed = createManager({}, { factory: makeFactory(), childRun: failedRun });

    const failedHandle = await failed.manager.startChildExecution(workspaceRoot, {
      parentStore: failedParentStore,
      parentSessionId: failedParentId,
      parentToolCallId: "failed-call",
      toolName: "delegate",
      request: delegationRequest({ agent_type: "explore", title: "Delegated child", objective: "inspect", skills: [], background: false }),
      parentAbort: undefined,
    });
    await failedHandle.result;
    expect(failedParentStore.getState().childSessionLinks.at(-1)).toMatchObject({ status: "failed", error: "child exploded" });

    const timedParentId = crypto.randomUUID();
    const timedParentStore = storeManager.create(timedParentId, workspaceRoot, { agentName: "lead" });
    const timed = createManager({}, {
      factory: makeFactory({
        getDefinition: mock((name: string) => {
          const base = makeFactory().getDefinition(name);
          if (name === "lead") return { ...base, childPolicy: { ...base.childPolicy!, timeoutMs: 60_000 } };
          return base;
        }),
      }),
      childRun: new Promise<AgentResult>(() => undefined),
    });

    const timedHandle = await timed.manager.startChildExecution(workspaceRoot, {
      parentStore: timedParentStore,
      parentSessionId: timedParentId,
      parentToolCallId: "timed-call",
      toolName: "delegate",
      request: delegationRequest({ agent_type: "explore", title: "Delegated child", objective: "inspect", skills: [], background: false }),
      parentAbort: undefined,
    });
    const initialDelay = timed.deadlineScheduler.scheduledDelays().at(-1)!;
    expect(initialDelay).toBeGreaterThan(0);
    expect(initialDelay).toBeLessThanOrEqual(60_000);
    timed.deadlineScheduler.fireScheduled();
    expect(await timedHandle.result).toMatchObject({
      outcome: "terminal",
      executionStatus: "timed_out",
    });
    expect(timedParentStore.getState().childSessionLinks.at(-1)).toMatchObject({ status: "timed_out" });
  });

  test("startChildExecution enforces delegate targets and child concurrency", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
    const factory = makeFactory();
    const childRun = new Promise<AgentResult>(() => undefined);
    const { manager } = createManager({}, { factory, childRun });

    await expect(manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "bad-target",
      toolName: "delegate",
      request: delegationRequest({ agent_type: "build", title: "Delegated child", objective: "inspect", skills: [], background: false }),
      parentAbort: undefined,
    })).rejects.toThrow(DelegateTargetNotAllowedError);

    const first = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "first",
      toolName: "delegate",
      request: delegationRequest({ agent_type: "explore", title: "Delegated child", objective: "inspect", skills: [], background: true }),
      parentAbort: undefined,
    });

    await expect(manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "second",
      toolName: "delegate",
      request: delegationRequest({ agent_type: "explore", title: "Delegated child", objective: "inspect", skills: [], background: true }),
      parentAbort: undefined,
    })).rejects.toThrow(ConcurrentLimitError);
    first.abort();
    await first.result;
  });

  test("two legal Build children can be running concurrently", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
    const childRun = new Promise<AgentResult>(() => undefined);
    const { manager } = createManager({}, { factory: makeBuildFactory(), childRun });

    const first = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "build-first",
      toolName: "delegate",
      request: delegationRequest({ agent_type: "build", title: "First Build", objective: "Implement first change", background: true }),
      parentAbort: undefined,
    });
    const second = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "build-second",
      toolName: "delegate",
      request: delegationRequest({ agent_type: "build", title: "Second Build", objective: "Implement second change", background: true }),
      parentAbort: undefined,
    });

    expect(parentStore.getState().childSessionLinks
      .filter((link) => link.childAgentName === "build")
      .map((link) => ({ call: link.parentToolCallId, status: link.status })))
      .toEqual([
        { call: "build-first", status: "running" },
        { call: "build-second", status: "running" },
      ]);

    first.abort();
    second.abort();
    await Promise.all([first.result, second.result]);
  });

  test("child abort race marks link cancelling then cancelled and releases slot", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
    const childRun = new Promise<AgentResult>(() => undefined);
    const { manager, sessionAgentManager } = createManager({}, { factory: makeFactory(), childRun });

    const first = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "first",
      toolName: "delegate",
      request: delegationRequest({ agent_type: "explore", title: "Delegated child", objective: "inspect", skills: [], background: true }),
      parentAbort: undefined,
    });

    first.abort();
    await first.result;
    expect(parentStore.getState().events
      .filter((event) => event.payload.type === "tool-child-session-link")
      .map((event) => (event.payload as { link: ToolChildSessionLink }).link.status)).toContain("cancelling");
    expect(parentStore.getState().childSessionLinks.at(-1)).toMatchObject({ status: "cancelled" });
  });

  test("root delete removes root file and descendant directory", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const grandchildId = crypto.randomUUID();
    await writeSessionFile({
      sessionId: rootId,
      projectTodo: { todoId: crypto.randomUUID(), entry: "work" },
    });
    await writeSessionFile({ sessionId: childId, rootSessionId: rootId, parentSessionId: rootId });
    await writeSessionFile({ sessionId: grandchildId, rootSessionId: rootId, parentSessionId: childId });
    const { manager, sessionAgentManager, untrackSession } = createManager({});

    await manager.deleteSession(workspaceRoot, rootId);

    expect(await Bun.file(getSessionDir(workspaceRoot, rootId)).exists()).toBe(false);
    expect(sessionAgentManager.dispose).toHaveBeenCalledTimes(3);
    expect(untrackSession).toHaveBeenCalledTimes(3);
  });

  test("deletion generation blocks execution, child launch, and cwd transition during preflight", async () => {
    const rootId = crypto.randomUUID();
    const rootStore = storeManager.create(rootId, workspaceRoot, { agentName: "lead" });
    await storeManager.flushSession(rootId, workspaceRoot);
    const preflightEntered = deferred<void>();
    const releasePreflight = deferred<void>();
    const { manager } = createManager({}, {
      factory: makeFactory(),
      deletionLifecycle: {
        prepareForDeletion: async () => {
          preflightEntered.resolve(undefined);
          await releasePreflight.promise;
        },
      },
    });

    const deletion = manager.deleteSession(workspaceRoot, rootId);
    await preflightEntered.promise;

    await expect(manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId: rootId,
      input: { kind: "direct", text: "race deletion" },
    })).rejects.toThrow(SessionDeleteInProgressError);
    await expect(manager.startChildExecution(workspaceRoot, {
      parentStore: rootStore,
      parentSessionId: rootId,
      parentToolCallId: "delete-race-child",
      toolName: "delegate",
      request: delegationRequest({ agent_type: "explore", title: "Delegated child", objective: "race deletion", skills: [], background: false }),
    })).rejects.toThrow(SessionDeleteInProgressError);
    expect(() => manager.acquireSessionCwdTransition(workspaceRoot, rootId)).toThrow(SessionDeleteInProgressError);
    await expect(manager.runSessionInputMutation({
      workspaceRoot,
      rootSessionId: rootId,
    }, async () => undefined)).rejects.toThrow(SessionDeleteInProgressError);

    releasePreflight.resolve(undefined);
    await deletion;
  });

  test("input mutation admission blocks deletion and remains visible to workspace close", async () => {
    const rootId = crypto.randomUUID();
    storeManager.create(rootId, workspaceRoot, { agentName: "lead" });
    await storeManager.flushSession(rootId, workspaceRoot);
    const mutationEntered = deferred<void>();
    const releaseMutation = deferred<void>();
    const { manager } = createManager({});

    const mutation = manager.runSessionInputMutation({
      workspaceRoot,
      rootSessionId: rootId,
    }, async () => {
      mutationEntered.resolve(undefined);
      await releaseMutation.promise;
    });
    await mutationEntered.promise;

    expect(manager.getSessionFamilyActivity(workspaceRoot, rootId)).toBe("idle");
    expect(manager.listPendingSessionInputMutations(workspaceRoot)).toEqual([{ rootSessionId: rootId }]);
    await expect(manager.deleteSession(workspaceRoot, rootId)).rejects.toMatchObject({
      name: "SessionDeleteConflictError",
      sessionIds: [rootId],
    });

    const closeLease = manager.acquireWorkspaceClose(workspaceRoot);
    await expect(manager.runSessionInputMutation({
      workspaceRoot,
      rootSessionId: crypto.randomUUID(),
    }, async () => undefined)).rejects.toBeInstanceOf(SessionWorkspaceClosingError);
    closeLease.release();

    releaseMutation.resolve(undefined);
    await mutation;
    expect(manager.listPendingSessionInputMutations(workspaceRoot)).toEqual([]);
  });

  test("family control and input mutation have one linearization point", async () => {
    const rootId = crypto.randomUUID();
    storeManager.create(rootId, workspaceRoot, { agentName: "lead" });
    await storeManager.flushSession(rootId, workspaceRoot);
    const controlEntered = deferred<void>();
    const releaseControl = deferred<void>();
    const inputEntered = deferred<void>();
    const { manager } = createManager({});

    const control = manager.tryRunSessionFamilyControl({ workspaceRoot, rootSessionId: rootId }, async () => {
      controlEntered.resolve(undefined);
      await releaseControl.promise;
      return "settled";
    });
    await controlEntered.promise;
    expect(manager.getSessionFamilyActivity(workspaceRoot, rootId)).toBe("running");

    const input = manager.runSessionInputMutation({ workspaceRoot, rootSessionId: rootId }, async () => {
      inputEntered.resolve(undefined);
    });
    await Promise.resolve();
    expect(manager.listPendingSessionInputMutations(workspaceRoot)).toEqual([]);

    releaseControl.resolve(undefined);
    await expect(control).resolves.toEqual({ kind: "executed", result: "settled" });
    await inputEntered.promise;
    await input;
    expect(manager.listPendingSessionInputMutations(workspaceRoot)).toEqual([]);
    expect(manager.getSessionFamilyActivity(workspaceRoot, rootId)).toBe("idle");
  });

  test("delete performs lifecycle preparation after an in-flight execution quiesces", async () => {
    const rootId = crypto.randomUUID();
    const store = storeManager.create(rootId, workspaceRoot, { agentName: "lead" });
    await storeManager.flushSession(rootId, workspaceRoot);
    const runEntered = deferred<void>();
    let ownerCreatedDuringAbort = false;
    const agent: Agent = {
      store,
      cwd: store.getState().cwd,
      classifyCommand: mock((_input: string) => null),
      executeCommand: mock(async (_command: AgentCommand): Promise<AgentCommandResult> => ({ kind: "handled" })),
      run: mock(async (_binding: ExecutionModelBinding, options?: AgentRunOptions) => {
        runEntered.resolve(undefined);
        const signal = options?.abort;
        return await new Promise<AgentResult>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            ownerCreatedDuringAbort = true;
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      }),
      dispose: mock(() => undefined),
    };
    let preparationCount = 0;
    const { manager } = createManager({ [rootId]: agent as MockAgent }, {
      deletionLifecycle: {
        prepareForDeletion: async () => {
          preparationCount += 1;
          if (ownerCreatedDuringAbort) {
            throw new Error("Deletion preparation failed");
          }
        },
      },
    });
    await manager.startCheckedExecution({ slug: "project", workspaceRoot, sessionId: rootId, input: { kind: "direct", text: "create owner while stopping" } });
    await runEntered.promise;

    await expect(manager.deleteSession(workspaceRoot, rootId)).rejects.toMatchObject({
      message: "Deletion preparation failed",
    });

    expect(preparationCount).toBe(1);
    expect(await Bun.file(getSessionPath(workspaceRoot, rootId)).exists()).toBe(true);
  });

  test("child subtree delete removes descendants and preserves siblings", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const grandchildId = crypto.randomUUID();
    const siblingId = crypto.randomUUID();
    await writeSessionFile({ sessionId: rootId });
    await writeSessionFile({ sessionId: childId, rootSessionId: rootId, parentSessionId: rootId });
    await writeSessionFile({ sessionId: grandchildId, rootSessionId: rootId, parentSessionId: childId });
    await writeSessionFile({ sessionId: siblingId, rootSessionId: rootId, parentSessionId: rootId });
    const { manager } = createManager({});

    await manager.deleteSession(workspaceRoot, childId);

    expect(await Bun.file(getSessionPath(workspaceRoot, rootId)).exists()).toBe(true);
    expect(await Bun.file(getSessionPath(workspaceRoot, childId)).exists()).toBe(false);
    expect(await Bun.file(getSessionPath(workspaceRoot, grandchildId)).exists()).toBe(false);
    expect(await Bun.file(getSessionPath(workspaceRoot, siblingId)).exists()).toBe(true);
  });

  test("child subtree delete removes descendant IDs from the root index", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const grandchildId = crypto.randomUUID();
    const manager = new SessionStoreManager({ logger: silentLogger });
    await writeSessionFile({ sessionId: rootId });
    await writeSessionFile({ sessionId: childId, rootSessionId: rootId, parentSessionId: rootId });
    await writeSessionFile({ sessionId: grandchildId, rootSessionId: rootId, parentSessionId: childId });
    await manager.resolveRootSessionId(grandchildId, workspaceRoot);
    const { manager: executionManager } = createManager({}, { storeManager: manager });

    await executionManager.deleteSession(workspaceRoot, childId);

    await expect(manager.resolveRootSessionId(childId, workspaceRoot)).rejects.toThrow(`Session file not found for "${childId}"`);
    await expect(manager.resolveRootSessionId(grandchildId, workspaceRoot)).rejects.toThrow(`Session file not found for "${grandchildId}"`);
  });

  test("restart regression: child subtree and root cascade deletes resolve persisted tree from cold manager", async () => {
    const firstRootId = crypto.randomUUID();
    const firstChildId = crypto.randomUUID();
    const firstGrandchildId = crypto.randomUUID();
    const firstSiblingId = crypto.randomUUID();
    await writeSessionFile({ sessionId: firstRootId, title: "first-root" });
    await writeSessionFile({ sessionId: firstChildId, rootSessionId: firstRootId, parentSessionId: firstRootId, title: "first-child" });
    await writeSessionFile({ sessionId: firstGrandchildId, rootSessionId: firstRootId, parentSessionId: firstChildId, title: "first-grandchild" });
    await writeSessionFile({ sessionId: firstSiblingId, rootSessionId: firstRootId, parentSessionId: firstRootId, title: "first-sibling" });
    const coldChildStoreManager = new SessionStoreManager({ logger: silentLogger });
    const { manager: childDeleteManager, sessionAgentManager: childAgentManager, untrackSession: untrackChildSession } = createManager({}, { storeManager: coldChildStoreManager });

    await childDeleteManager.deleteSession(workspaceRoot, firstChildId);

    expect(await Bun.file(getSessionPath(workspaceRoot, firstRootId)).exists()).toBe(true);
    expect(await Bun.file(getSessionPath(workspaceRoot, firstChildId)).exists()).toBe(false);
    expect(await Bun.file(getSessionPath(workspaceRoot, firstGrandchildId)).exists()).toBe(false);
    expect(await Bun.file(getSessionPath(workspaceRoot, firstSiblingId)).exists()).toBe(true);
    expect(childAgentManager.dispose).toHaveBeenCalledTimes(2);
    expect(untrackChildSession).toHaveBeenCalledTimes(2);

    const secondRootId = crypto.randomUUID();
    const secondChildId = crypto.randomUUID();
    const secondGrandchildId = crypto.randomUUID();
    await writeSessionFile({ sessionId: secondRootId, title: "second-root" });
    await writeSessionFile({ sessionId: secondChildId, rootSessionId: secondRootId, parentSessionId: secondRootId, title: "second-child" });
    await writeSessionFile({ sessionId: secondGrandchildId, rootSessionId: secondRootId, parentSessionId: secondChildId, title: "second-grandchild" });
    const coldRootStoreManager = new SessionStoreManager({ logger: silentLogger });
    const { manager: rootDeleteManager, sessionAgentManager: rootAgentManager, untrackSession: untrackRootSession } = createManager({}, { storeManager: coldRootStoreManager });

    await rootDeleteManager.deleteSession(workspaceRoot, secondRootId);

    expect(await Bun.file(getSessionDir(workspaceRoot, secondRootId)).exists()).toBe(false);
    expect(rootAgentManager.dispose).toHaveBeenCalledTimes(3);
    expect(untrackRootSession).toHaveBeenCalledTimes(3);
  });

  test("restart reconciliation terminalizes an unknown running Execution without replay", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const now = Date.now();
    await writeSessionFile({
      sessionId: rootId,
      executions: [testExecutionRecord("execution-running", "running")],
      childSessionLinks: [{
        parentSessionId: rootId,
        parentToolCallId: "tool-child",
        toolName: "delegate",
        childSessionId: childId,
        childExecutionId: "execution-child",
        childAgentName: "explore",
      childProfile: "fast",
      childSkillNames: [],
        title: "Delegated child",
        depth: 1,
        background: true,
        status: "cancelling",
        createdAt: now - 900,
      }],
    });
    const restarted = new SessionStoreManager({ logger: silentLogger });

    const { manager } = createManager({}, { storeManager: restarted });
    await manager.reconcileDurableSession({
      slug: "project",
      workspaceRoot,
      sessionId: rootId,
    });
    const store = await restarted.getOrLoad(rootId, workspaceRoot);
    const file = await restarted.getSessionFile(workspaceRoot, rootId);

    expect(store.getState().executions.at(-1)).toMatchObject({
      id: "execution-running",
      status: "interrupted",
      error: "Execution lost its live model/tool continuation and requires manual inspection",
    });
    expect(store.getState().childSessionLinks.at(-1)).toMatchObject({ status: "cancelling" });
    expect(file.executions.at(-1)?.status).toBe("interrupted");
    expect(file.childSessionLinks.at(-1)?.status).toBe("cancelling");
  });

  test("restart reconciliation archives an orphaned active Tool Batch before terminalizing its Execution", async () => {
    const rootId = crypto.randomUUID();
    const runningCheckpointAt = Date.now();
    const now = new Date(runningCheckpointAt).toISOString();
    const batch: SessionToolBatch = {
      batchId: "batch-orphaned",
      executionId: "execution-orphaned",
      runOrdinal: 0,
      step: 0,
      agentName: "lead",
      allowedTools: ["effect_tool"],
      agentSkills: [],
      partitions: [{ type: "serial", callIds: ["effect-1"] }],
      calls: [{
        ordinal: 0,
        partitionIndex: 0,
        toolCallId: "effect-1",
        toolName: "effect_tool",
        input: {},
        traits: { readOnly: false, destructive: false, concurrencySafe: false },
        state: "running",
        attempt: 1,
        checkpointAt: runningCheckpointAt,
      }],
      createdAt: now,
      updatedAt: now,
    };
    await writeSessionFile({
      sessionId: rootId,
      executions: [testExecutionRecord("execution-orphaned", "running")],
      steps: [{
        id: "step-orphaned",
        step: batch.step,
        executionId: batch.executionId,
        runOrdinal: batch.runOrdinal,
        startedAt: runningCheckpointAt,
      }],
      toolBatches: [batch],
    });
    const restarted = new SessionStoreManager({ logger: silentLogger });
    const restartedStore = await restarted.getOrLoad(rootId, workspaceRoot);
    const agent: Agent = {
      store: restartedStore,
      cwd: workspaceRoot,
      classifyCommand: () => null,
      executeCommand: async () => ({ kind: "handled" }),
      run: async () => ({ outcome: "terminal", text: "next", steps: 1, status: "completed" }),
      dispose: () => undefined,
    };
    const cancelSessionToolBatch = mock(async (sessionId: string, root: string) => {
      const archivedAt = new Date().toISOString();
      await restarted.updateToolBatches(sessionId, root, (batches) => batches.map((candidate) => ({
        ...candidate,
        archivedAt,
        updatedAt: archivedAt,
      })));
    });
    const { manager } = createManager({ [rootId]: agent as unknown as MockAgent }, {
      storeManager: restarted,
      cancelSessionToolBatch,
    });

    await manager.reconcileDurableSession({
      slug: "project",
      workspaceRoot,
      sessionId: rootId,
    });

    expect(cancelSessionToolBatch).toHaveBeenCalledWith(
      rootId,
      workspaceRoot,
      "Execution lost its live tool continuation and requires manual inspection",
    );
    const reconciled = await restarted.getSessionFile(workspaceRoot, rootId);
    expect(reconciled.toolBatches[0]?.archivedAt).toEqual(expect.any(String));
    expect(reconciled.executions[0]?.runs[0]).toMatchObject({ endedAt: runningCheckpointAt });

    const next = await manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId: rootId,
      input: { kind: "direct", text: "continue after inspection" },
    });
    await next.promise;
    expect((await restarted.getSessionFile(workspaceRoot, rootId)).executions).toHaveLength(2);
  });

  test("restart reconciliation archives an active Tool Batch left by a terminal Execution", async () => {
    const rootId = crypto.randomUUID();
    const executionId = "execution-terminal-with-active-batch";
    const terminal = testExecutionRecord(executionId, "failed");
    if (terminal.status === "running" || terminal.status === "suspended") {
      throw new Error("Expected terminal Execution fixture");
    }
    const batch = {
      ...blockedToolBatch("terminal-with-active-batch"),
      executionId,
    };
    await writeSessionFile({
      sessionId: rootId,
      executions: [{
        ...terminal,
        runs: terminal.runs.map((run) => ({
          ...run,
          settlement: { key: `run:${rootId}:${executionId}:${run.ordinal}`, goalInstanceId: null },
        })),
        terminalSettlement: { key: `terminal:${rootId}:${executionId}`, goalInstanceId: null },
      }],
      steps: [{
        id: "step-terminal-with-active-batch",
        step: batch.step,
        executionId,
        runOrdinal: batch.runOrdinal,
        startedAt: 1,
        completedAt: 1,
      }],
      toolBatches: [batch],
    });
    const restarted = new SessionStoreManager({ logger: silentLogger });
    const restartedStore = await restarted.getOrLoad(rootId, workspaceRoot);
    const agent: Agent = {
      store: restartedStore,
      cwd: workspaceRoot,
      classifyCommand: () => null,
      executeCommand: async () => ({ kind: "handled" }),
      run: async () => ({ outcome: "terminal", text: "next", steps: 1, status: "completed" }),
      dispose: () => undefined,
    };
    const cancelSessionToolBatch = mock(async (sessionId: string, root: string) => {
      const archivedAt = new Date().toISOString();
      await restarted.updateToolBatches(sessionId, root, (batches) => batches.map((candidate) => ({
        ...candidate,
        archivedAt,
        updatedAt: archivedAt,
      })));
    });
    const { manager } = createManager({ [rootId]: agent as unknown as MockAgent }, {
      storeManager: restarted,
      cancelSessionToolBatch,
    });

    await manager.reconcileDurableSession({
      slug: "project",
      workspaceRoot,
      sessionId: rootId,
    });

    expect(cancelSessionToolBatch).toHaveBeenCalledWith(
      rootId,
      workspaceRoot,
      "Terminal Session cannot retain an active Tool Batch",
    );
    expect(typeof (await restarted.getSessionFile(workspaceRoot, rootId)).toolBatches[0]?.archivedAt)
      .toBe("string");

    const next = await manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId: rootId,
      input: { kind: "direct", text: "continue after cold repair" },
    });
    await next.promise;
    expect((await restarted.getSessionFile(workspaceRoot, rootId)).executions).toHaveLength(2);
  });

  test("restart trusts terminal call checkpoint after a batch-result crash without trusting repaired metadata", async () => {
    const rootId = crypto.randomUUID();
    const executionId = "execution-steer-recovery";
    const restarted = new SessionStoreManager({ logger: silentLogger });
    const store = restarted.create(rootId, workspaceRoot, { agentName: "lead" });
    const inputs = new SessionInputService(restarted);
    store.getState().append(testExecutionStart(executionId));
    const recoveryBinding = store.getState().executions[0]!.runs[0]!.binding;
    const recoveryAudit = {
      requested: TEST_REQUESTED_MODEL_SELECTION,
      actual: recoveryBinding.selection,
    };
    await inputs.beginDirectExecution({
      sessionId: rootId,
      workspaceRoot,
      executionId,
      runOrdinal: 0,
      text: "Initial",
      requestedModelSelection: TEST_REQUESTED_MODEL_SELECTION,
      modelAudit: recoveryAudit,
      binding: recoveryBinding,
      origin: "user_message",
    });
    store.getState().append({ type: "step-start", step: 0 });
    store.getState().append({ type: "step-end", step: 0, finishReason: "tool-calls" });
    const accepted = await inputs.acceptMessage({
      sessionId: rootId,
      workspaceRoot,
      text: "Steer",
      clientRequestId: crypto.randomUUID(),
      source: "user",
      requestedModelSelection: TEST_REQUESTED_MODEL_SELECTION,
    });
    await inputs.claimSteer({
      sessionId: rootId,
      workspaceRoot,
      messageId: accepted.messageId,
      expectedRevision: 0,
      expectedExecutionId: executionId,
      runOrdinal: 0,
      modelAudit: recoveryAudit,
    });
    store.getState().append({
      type: "tool-call",
      toolCallId: "prior-work",
      toolName: "file_read",
      input: { path: "README.md" },
    });
    const result = {
      isError: false,
      output: {
        preview: "done",
        completeness: "complete" as const,
        observed: { bytes: 4, lines: 1 },
        canonical: { bytes: 4, lines: 1 },
        stored: { bytes: 4, lines: 1 },
        omitted: { bytes: 0, lines: 0 },
        recovery: { kind: "none" as const },
      },
    };
    const durableTool = store.getState().messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool" && part.toolCallId === "prior-work");
    if (durableTool?.type !== "tool" || !("startedAt" in durableTool)) {
      throw new Error("Expected running durable tool work");
    }
    await Bun.sleep(2);
    const settledAt = Math.max(Date.now(), durableTool.startedAt);
    const repairedAt = settledAt + 30_000;
    const blockedCall = {
      ...blockedToolBatch("repaired-hitl").calls[0]!,
      ordinal: 1,
      partitionIndex: 1,
      checkpointAt: settledAt,
    };
    const blocked = {
      ...blockedToolBatch("repaired-hitl"),
      executionId,
      updatedAt: new Date(repairedAt).toISOString(),
      partitions: [
        { type: "serial" as const, callIds: ["prior-work"] },
        { type: "serial" as const, callIds: ["tool-repaired-hitl"] },
      ],
      calls: [
        {
          ordinal: 0,
          partitionIndex: 0,
          toolCallId: "prior-work",
          toolName: "file_read",
          input: { path: "README.md" },
          traits: { readOnly: true, destructive: false, concurrencySafe: true },
          state: "completed" as const,
          attempt: 1,
          checkpointAt: settledAt,
          result,
        },
        blockedCall,
      ],
    };
    await restarted.updateToolBatches(rootId, workspaceRoot, () => [blocked]);
    let committedAt: number | undefined;
    const port = inputServicePort(inputs);
    const { manager } = createManager({}, {
      storeManager: restarted,
      sessionInputService: {
        ...port,
        commitSteers: async (input) => {
          committedAt = input.committedAt;
          return await inputs.commitSteers(input);
        },
      },
    });

    await manager.reconcileDurableSession({
      slug: "project",
      workspaceRoot,
      sessionId: rootId,
    });

    expect(committedAt).toBe(settledAt);
    const recovered = await restarted.getSessionFile(workspaceRoot, rootId);
    expect(recovered.messages.map((message) => message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""))).toEqual(["Initial", "", "Steer"]);
    expect(recovered.messages.at(-1)?.completedAt).toBe(settledAt);
    expect(recovered.executions[0]).toMatchObject({
      id: executionId,
      status: "suspended",
      runs: [{ endedAt: settledAt }],
    });
    const recoveredPriorTool = recovered.messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool" && part.toolCallId === "prior-work");
    expect(recoveredPriorTool).toMatchObject({ type: "tool", state: "running" });
    expect(settledAt).toBeLessThan(repairedAt);
  });

  test("delete preserves files when a manually triggered abort deadline finds a stuck execution", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    await writeSessionFile({ sessionId: rootId });
    await writeSessionFile({ sessionId: childId, rootSessionId: rootId, parentSessionId: rootId });
    const runEntered = deferred<void>();
    const childAgent = {
      store: storeManager.create(childId, workspaceRoot, {
        rootSessionId: rootId,
        parentSessionId: rootId,
        agentName: "explore",
      }),
      cwd: workspaceRoot,
      classifyCommand: mock((_input: string) => null),
      executeCommand: mock(async (_command: AgentCommand): Promise<AgentCommandResult> => ({ kind: "handled" })),
      run: mock(async (): Promise<AgentResult> => {
        runEntered.resolve(undefined);
        return await new Promise<AgentResult>(() => undefined);
      }),
      dispose: mock(() => undefined),
    } as unknown as MockAgent;
    const harness = createManager({ [childId]: childAgent });
    const execution = await harness.manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId: childId,
      input: { kind: "direct", text: "child" },
    });
    await runEntered.promise;

    const deleting = harness.manager.deleteSession(workspaceRoot, childId);
    await harness.deadlineScheduler.whenScheduled();
    harness.deadlineScheduler.fireScheduled();

    await expect(deleting).rejects.toMatchObject({
      name: "SessionDeleteConflictError",
      sessionIds: [childId],
    });
    expect(await Bun.file(getSessionPath(workspaceRoot, childId)).exists()).toBe(true);
    expect(harness.sessionAgentManager.dispose).not.toHaveBeenCalled();
    expect(execution.abortController.signal.aborted).toBe(true);
  });

  test("SessionStoreManager.delete removes only the deleted session from workspace root index", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const siblingId = crypto.randomUUID();
    await writeSessionFile({ sessionId: rootId });
    await writeSessionFile({ sessionId: childId, rootSessionId: rootId, parentSessionId: rootId });
    await writeSessionFile({ sessionId: siblingId, rootSessionId: rootId, parentSessionId: rootId });
    await storeManager.resolveRootSessionId(childId, workspaceRoot);
    await storeManager.resolveRootSessionId(siblingId, workspaceRoot);

    storeManager.delete(childId, workspaceRoot);
    await rm(getSessionPath(workspaceRoot, siblingId));

    expect(await storeManager.resolveRootSessionId(siblingId, workspaceRoot)).toBe(rootId);
  });

  test("resumeChildExecution on completed session appends new messages and links the resume tool call", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
    const factory = makeFactory();
    const { manager } = createManager({}, { factory });

    const first = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "initial-tool-call",
      toolName: "delegate",
      request: delegationRequest({ agent_type: "explore", title: "Delegated child", objective: "first round", skills: [], background: false }),
      parentAbort: undefined,
    });
    await first.result;
    const childSessionId = first.sessionId;
    const childStore = first.store;
    const messagesAfterFirst = childStore.getState().messages.length;
    const linksAfterFirst = parentStore.getState().childSessionLinks.length;

    const resumed = await manager.resumeChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "resume-tool-call",
      toolName: "resume_session",
      sessionId: childSessionId,
      instruction: "second round",
      background: false,
      parentAbort: undefined,
    });
    await resumed.result;

    expect(resumed.sessionId).toBe(childSessionId);
    expect(resumed.store).toBe(childStore);
    expect(childStore.getState().messages.length).toBeGreaterThan(messagesAfterFirst);
    expect(parentStore.getState().childSessionLinks.length).toBe(linksAfterFirst + 1);
    expect(parentStore.getState().childSessionLinks.find((link) => link.parentToolCallId === "initial-tool-call")).toMatchObject({
      childSessionId,
      parentToolCallId: "initial-tool-call",
      status: "completed",
    });
    expect(parentStore.getState().childSessionLinks.find((link) => link.parentToolCallId === "resume-tool-call")).toMatchObject({
      childSessionId,
      parentToolCallId: "resume-tool-call",
      status: "completed",
    });
  });

  test("blocks cwd transitions for active descendants and never resumes an old child across checkouts", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
    const childRun = deferred<MockAgentResult>();
    const childStarted = deferred<void>();
    let childRunCount = 0;
    const { manager } = createManager({}, {
      factory: makeFactory(),
      childRun: childRun.promise,
      childRunStarted: () => {
        childRunCount += 1;
        childStarted.resolve(undefined);
      },
    });

    const child = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "background-child",
      toolName: "delegate",
      request: delegationRequest({ agent_type: "explore", title: "Delegated child", objective: "keep working in the original checkout", skills: [], background: true }),
      parentAbort: undefined,
    });
    await childStarted.promise;

    expect(() => manager.acquireSessionCwdTransition(workspaceRoot, parentId))
      .toThrow(SessionCwdTransitionConflictError);
    try {
      manager.acquireSessionCwdTransition(workspaceRoot, parentId);
    } catch (error) {
      expect(error).toMatchObject({
        name: "SessionCwdTransitionConflictError",
        sessionId: parentId,
        activeDescendantSessionIds: [child.sessionId],
      });
    }
    expect(parentStore.getState().cwd).toBe(workspaceRoot);
    expect(child.store.getState().cwd).toBe(workspaceRoot);

    childRun.resolve({ text: "original checkout work complete", steps: 1 });
    await child.result;
    const releaseTransition = manager.acquireSessionCwdTransition(workspaceRoot, parentId);
    releaseTransition();

    const nextCwd = join(workspaceRoot, ".worktrees", "next");
    parentStore.getState().setCwd(nextCwd);
    const childMessagesBeforeResume = child.store.getState().messages.length;

    await expect(manager.resumeChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "resume-old-child",
      toolName: "resume_session",
      sessionId: child.sessionId,
      instruction: "write in the new checkout",
      background: false,
      parentAbort: undefined,
    })).rejects.toThrow(ChildSessionCwdMismatchError);

    expect(childRunCount).toBe(1);
    expect(child.store.getState().messages).toHaveLength(childMessagesBeforeResume);
    expect(manager.getExecution(workspaceRoot, child.sessionId)).toBeUndefined();
  });

  test("serializes child launches and resumes against the full cwd transition lease", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
    const skillResolution = deferred<readonly []>();
    const skillResolutionEntered = deferred<void>();
    let childRunCount = 0;
    const factory = makeFactory({
      resolveDelegatedSkillNames: mock(async () => {
        skillResolutionEntered.resolve(undefined);
        return await skillResolution.promise;
      }),
    });
    const { manager } = createManager({}, {
      factory,
      childRunStarted: () => { childRunCount += 1; },
    });

    const pendingStart = manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "pending-child-launch",
      toolName: "delegate",
      request: delegationRequest({ agent_type: "explore", title: "Delegated child", objective: "launch while skills resolve", skills: [], background: false }),
      parentAbort: undefined,
    });
    await skillResolutionEntered.promise;

    expect(() => manager.acquireSessionCwdTransition(workspaceRoot, parentId))
      .toThrow(SessionCwdTransitionConflictError);

    skillResolution.resolve([]);
    const child = await pendingStart;
    await child.result;
    expect(childRunCount).toBe(1);

    const releaseTransition = manager.acquireSessionCwdTransition(workspaceRoot, parentId);
    try {
      await expect(manager.startChildExecution(workspaceRoot, {
        parentStore,
        parentSessionId: parentId,
        parentToolCallId: "start-during-transition",
        toolName: "delegate",
        request: delegationRequest({ agent_type: "explore", title: "Delegated child", objective: "must not start", skills: [], background: false }),
        parentAbort: undefined,
      })).rejects.toThrow(SessionCwdTransitionInProgressError);

      await expect(manager.resumeChildExecution(workspaceRoot, {
        parentStore,
        parentSessionId: parentId,
        parentToolCallId: "resume-during-transition",
        toolName: "resume_session",
        sessionId: child.sessionId,
        instruction: "must not resume",
        background: false,
        parentAbort: undefined,
      })).rejects.toThrow(SessionCwdTransitionInProgressError);
      expect(childRunCount).toBe(1);
      expect(manager.getExecution(workspaceRoot, child.sessionId)).toBeUndefined();
    } finally {
      releaseTransition();
    }

    const resumed = await manager.resumeChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "resume-after-transition",
      toolName: "resume_session",
      sessionId: child.sessionId,
      instruction: "resume after lease release",
      background: false,
      parentAbort: undefined,
    });
    await resumed.result;
    expect(childRunCount).toBe(2);
  });

  test("idle cwd transition leases reject an active root and block new root executions", async () => {
    const sessionId = crypto.randomUUID();
    const run = deferred<MockAgentResult>();
    const agent = new MockAgent(sessionId, run.promise, workspaceRoot);
    const { manager } = createManager({ [sessionId]: agent });
    const execution = await manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId,
      input: { kind: "direct", text: "finish the loop run" },
    });

    expect(() => manager.acquireIdleSessionCwdTransition(workspaceRoot, sessionId))
      .toThrow(SessionCwdTransitionConflictError);

    run.resolve({ text: "done", steps: 1 });
    await execution.promise;
    const releaseTransition = manager.acquireIdleSessionCwdTransition(workspaceRoot, sessionId);
    try {
      await expect(manager.startCheckedExecution({
        slug: "project",
        workspaceRoot,
        sessionId,
        input: { kind: "direct", text: "must wait for cleanup" },
      })).rejects.toThrow(SessionCwdTransitionInProgressError);
    } finally {
      releaseTransition();
    }

    const afterCleanup = await manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId,
      input: { kind: "direct", text: "cleanup finished" },
    });
    await afterCleanup.promise;
    expect(manager.getSessionFamilyActivity(workspaceRoot, sessionId)).toBe("idle");
  });

  test("idle cwd transition leases reject an active root command", async () => {
    const sessionId = crypto.randomUUID();
    const commandGate = deferred<void>();
    storeManager.create(sessionId, workspaceRoot, { agentName: "lead" });
    const { manager } = createManager({});
    const command = manager.runSessionCommand({
      workspaceRoot,
      sessionId,
      clientRequestId: "command-during-cwd-transition",
      requestedModelSelection: TEST_REQUESTED_MODEL_SELECTION,
    }, async (_binding, signal) => {
      await withAbort(commandGate.promise, signal);
    });

    expect(() => manager.acquireIdleSessionCwdTransition(workspaceRoot, sessionId))
      .toThrow(SessionCwdTransitionConflictError);

    commandGate.resolve(undefined);
    await command;
    const release = manager.acquireIdleSessionCwdTransition(workspaceRoot, sessionId);
    release();
  });

  test("family cwd transition aggregation releases earlier roots when a later root is busy", async () => {
    const firstRoot = "00000000-0000-4000-8000-000000000001";
    const activeRoot = "00000000-0000-4000-8000-000000000002";
    const firstAgent = new MockAgent(firstRoot, Promise.resolve({ text: "idle", steps: 1 }), workspaceRoot);
    const activeRun = deferred<MockAgentResult>();
    const activeAgent = new MockAgent(activeRoot, activeRun.promise, workspaceRoot);
    const { manager } = createManager({ [firstRoot]: firstAgent, [activeRoot]: activeAgent });
    const execution = await manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId: activeRoot,
      input: { kind: "direct", text: "keep the second family busy" },
    });

    expect(() => manager.acquireIdleSessionFamilyCwdTransitions(
      workspaceRoot,
      [activeRoot, firstRoot, firstRoot],
    )).toThrow(SessionCwdTransitionConflictError);

    const releaseFirst = manager.acquireIdleSessionCwdTransition(workspaceRoot, firstRoot);
    releaseFirst();
    activeRun.resolve({ text: "done", steps: 1 });
    await execution.promise;

    const releaseFamilies = manager.acquireIdleSessionFamilyCwdTransitions(workspaceRoot, [activeRoot, firstRoot]);
    expect(() => manager.acquireIdleSessionCwdTransition(workspaceRoot, firstRoot))
      .toThrow(SessionCwdTransitionInProgressError);
    releaseFamilies();
    const releaseAfter = manager.acquireIdleSessionCwdTransition(workspaceRoot, firstRoot);
    releaseAfter();
  });












  test("cold-loads child and root before rejecting a direct message with stale child cwd", async () => {
    const coldRoot = join(workspaceRoot, "cold-next-worktree");
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    await writeSessionFile({ sessionId: rootId, cwd: coldRoot });
    await writeSessionFile({
      sessionId: childId,
      rootSessionId: rootId,
      parentSessionId: rootId,
      cwd: workspaceRoot,
    });
    const coldStores = new SessionStoreManager({ logger: silentLogger });
    const { manager } = createManager({}, { storeManager: coldStores, factory: makeFactory() });

    await expect(manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId: childId,
      input: { kind: "direct", text: "do not run in the stale checkout" },
    })).rejects.toMatchObject({
      name: "ChildSessionCwdMismatchError",
      sessionId: childId,
      parentSessionId: rootId,
      expectedCwd: coldRoot,
      actualCwd: workspaceRoot,
    });

    expect(coldStores.get(childId, workspaceRoot)).toBeDefined();
    expect(coldStores.get(rootId, workspaceRoot)).toBeDefined();
    expect(manager.getSessionFamilyActivity(workspaceRoot, rootId)).toBe("idle");
  });

  test("revalidates current parent delegation authority for direct, Queue, and Tool Batch child activation", async () => {
    const baseFactory = makeFactory();
    const deniedFactory = makeFactory({
      getDefinition: mock((name: string) => {
        const definition = baseFactory.getDefinition(name);
        return name === "lead"
          ? { ...definition, tools: { ...definition.tools, delegateTargets: [] } }
          : definition;
      }),
    });
    const cases: Array<{
      name: string;
      input: StartSessionExecutionInput["input"];
      origin: StartSessionExecutionInput["origin"];
    }> = [
      { name: "direct", input: { kind: "direct", text: "continue" }, origin: "user_message" },
      { name: "queue", input: { kind: "queue" }, origin: "user_message" },
    ];

    for (const activation of cases) {
      const rootId = crypto.randomUUID();
      const childId = crypto.randomUUID();
      storeManager.create(rootId, workspaceRoot, { agentName: "lead" });
      const childStore = storeManager.create(childId, workspaceRoot, {
        rootSessionId: rootId,
        parentSessionId: rootId,
        agentName: "explore",
        title: activation.name,
      });
      const { manager, sessionAgentManager } = createManager({}, { factory: deniedFactory });

      await expect(manager.startCheckedExecution({
        slug: "project",
        workspaceRoot,
        sessionId: childId,
        input: activation.input,
        origin: activation.origin,
      })).rejects.toBeInstanceOf(DelegateTargetNotAllowedError);
      expect(sessionAgentManager.getOrCreate).not.toHaveBeenCalled();
      expect(childStore.getState().executions).toHaveLength(0);
    }
  });

  test("releases only a newly activated child Agent when post-activation start validation fails", async () => {
    for (const warm of [false, true]) {
      const rootId = crypto.randomUUID();
      const childId = crypto.randomUUID();
      storeManager.create(rootId, workspaceRoot, { agentName: "lead" });
      const childStore = storeManager.create(childId, workspaceRoot, {
        rootSessionId: rootId,
        parentSessionId: rootId,
        agentName: "explore",
        title: warm ? "warm" : "cold",
      });
      const childAgent = new MockAgent(childId, Promise.resolve({ text: "must not run", steps: 1 }), workspaceRoot);
      childAgent.store.setState(childStore.getState());
      const agents = warm ? { [childId]: childAgent } : {};
      const { manager, sessionAgentManager } = createManager(agents, {
        factory: makeFactory(),
        ...(warm ? {} : { getAgent: () => childAgent }),
      });
      const originalGetOrCreate = sessionAgentManager.getOrCreate.bind(sessionAgentManager);
      sessionAgentManager.getOrCreate = mock(async (root, sessionId) => {
        const agent = await originalGetOrCreate(root, sessionId);
        agent.store.setState({
          toolBatches: [{ ...blockedToolBatch(warm ? "warm-race" : "cold-race"), agentName: "explore" }],
        });
        return agent;
      });

      const execution = await manager.startCheckedExecution({
        slug: "project",
        workspaceRoot,
        sessionId: childId,
        input: { kind: "direct", text: "race activation" },
        origin: "user_message",
      });
      await execution.promise;

      expect(childStore.getState().executions.at(-1)).toMatchObject({ status: "failed" });
      expect(childAgent.runMock).not.toHaveBeenCalled();
      if (warm) {
        expect(sessionAgentManager.releaseAgent).not.toHaveBeenCalled();
        expect(sessionAgentManager.get(workspaceRoot, childId)).toBe(childAgent);
        expect(childAgent.disposeMock).not.toHaveBeenCalled();
      } else {
        expect(sessionAgentManager.releaseAgent).toHaveBeenCalledWith(workspaceRoot, childId);
        expect(sessionAgentManager.get(workspaceRoot, childId)).toBeUndefined();
        expect(childAgent.disposeMock).toHaveBeenCalledTimes(1);
      }
    }
  });

  test("cold-loads a Session and rejects messages while its durable tool batch remains blocked", async () => {
    const sessionId = crypto.randomUUID();
    await writeSessionFile({
      sessionId,
      executions: [testExecutionRecord("execution-hitl-pending", "running")],
      steps: [{
        id: "step-hitl-pending",
        step: 0,
        executionId: "execution-hitl-pending",
        runOrdinal: 0,
        startedAt: Date.now(),
      }],
      toolBatches: [blockedToolBatch("hitl-pending")],
    });
    const coldStores = new SessionStoreManager({ logger: silentLogger });
    const { manager } = createManager({}, { storeManager: coldStores });

    await expect(manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId,
      input: { kind: "direct", text: "must wait for the HITL response" },
    })).rejects.toMatchObject({
      name: "SessionToolBatchActiveError",
      sessionId,
      hitlIds: ["hitl-pending"],
    });
    expect(manager.getSessionFamilyActivity(workspaceRoot, sessionId)).toBe("idle");
  });

  test("fails closed when Session cwd changes during asynchronous scope validation", async () => {
    const sessionId = crypto.randomUUID();
    const store = storeManager.create(sessionId, workspaceRoot, { agentName: "lead" });
    const validationStarted = deferred<void>();
    const allowValidation = deferred<void>();
    const { manager } = createManager({}, {
      executionScopeValidator: {
        validate: async () => {
          validationStarted.resolve();
          await allowValidation.promise;
        },
      },
    });

    const pending = manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId,
      input: { kind: "direct", text: "continue" },
    });
    await validationStarted.promise;
    store.getState().setCwd(join(workspaceRoot, "changed-during-validation"));
    allowValidation.resolve();

    await expect(pending).rejects.toMatchObject({
      name: "SessionExecutionScopeConflictError",
      code: "SESSION_EXECUTION_SCOPE_CHANGED",
      sessionId,
    });
    expect(manager.getSessionFamilyActivity(workspaceRoot, sessionId)).toBe("idle");
  });

  test("exposes an async checked-start claim before project close can observe a false idle workspace", async () => {
    const sessionId = crypto.randomUUID();
    storeManager.create(sessionId, workspaceRoot, { agentName: "lead" });
    const validationStarted = deferred<void>();
    const allowValidation = deferred<void>();
    const { manager } = createManager({}, {
      executionScopeValidator: {
        validate: async () => {
          validationStarted.resolve();
          await allowValidation.promise;
        },
      },
    });
    const pending = manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId,
      input: { kind: "direct", text: "continue" },
    });
    await validationStarted.promise;

    expect(manager.listPendingCheckedStarts(workspaceRoot)).toEqual([{ sessionId }]);
    const closeLease = manager.acquireWorkspaceClose(workspaceRoot);
    await expect(manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId: crypto.randomUUID(),
      input: { kind: "direct", text: "must not start while closing" },
    })).rejects.toBeInstanceOf(SessionWorkspaceClosingError);
    closeLease.release();
    allowValidation.resolve();
    await (await pending).promise;

    expect(manager.listPendingCheckedStarts(workspaceRoot)).toEqual([]);
  });

  test("fails closed when any persisted owner identity changes during scope validation", async () => {
    const sessionId = crypto.randomUUID();
    const store = storeManager.create(sessionId, workspaceRoot, { agentName: "lead" });
    const validationStarted = deferred<void>();
    const allowValidation = deferred<void>();
    const { manager } = createManager({}, {
      executionScopeValidator: {
        validate: async () => {
          validationStarted.resolve();
          await allowValidation.promise;
        },
      },
    });

    const pending = manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId,
      input: { kind: "direct", text: "continue" },
    });
    await validationStarted.promise;
    store.setState({
      rootSessionId: "different-root",
      parentSessionId: "different-parent",
    });
    allowValidation.resolve();

    await expect(pending).rejects.toMatchObject({
      name: "SessionExecutionScopeConflictError",
      code: "SESSION_EXECUTION_SCOPE_CHANGED",
      sessionId,
      details: {
        changedFields: ["rootSessionId", "parentSessionId"],
      },
    });
    expect(manager.getSessionFamilyActivity(workspaceRoot, sessionId)).toBe("idle");
  });


  test("re-checks the synchronous cwd-transition guard after cold root loading", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    await storeManager.createSessionFile(workspaceRoot, { agentName: "lead" }, rootId);
    const rootStore = await storeManager.getOrLoad(rootId, workspaceRoot);
    await storeManager.createSessionFile(workspaceRoot, {
      rootSessionId: rootId,
      parentSessionId: rootId,
      agentName: "explore",
    }, childId);
    const rootLoad = deferred<typeof rootStore>();
    const rootLoadEntered = deferred<void>();
    const callbacks = storeCallbacks(storeManager);
    const manager = new SessionExecutionManager({
      sessionAgentManager: createFakeManager({}, { factory: makeFactory() }),
      modelRuntime: makeModelRuntime(),
      modelSelectionResolver: new ModelSelectionResolver(),
      ...callbacks,
      cancelSessionToolBatch: async () => undefined,
      applyChildDependencyOutcome: async () => undefined,
      onSessionInputMutationReleased: async () => undefined,
      onContinuationAdmissionReleased: async () => undefined,
      resolveGoalInstanceId: async () => null,
      onExecutionSettlement: async () => undefined,
      sessionInputService: new SessionInputService(storeManager),
      loadSessionStore: async (sessionId, root) => {
        if (sessionId === rootId) {
          rootLoadEntered.resolve(undefined);
          return await rootLoad.promise;
        }
        return await storeManager.getOrLoad(sessionId, root);
      },
      trackSession: () => undefined,
      untrackSession: () => undefined,
      executionScopeValidator: allowExecutionScope,
      logger: silentLogger,
    });

    const pendingMessage = manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId: childId,
      input: { kind: "direct", text: "race with cwd transition" },
    });
    await rootLoadEntered.promise;
    const releaseTransition = manager.acquireSessionCwdTransition(workspaceRoot, rootId);
    rootLoad.resolve(rootStore);

    await expect(pendingMessage).rejects.toThrow(SessionCwdTransitionInProgressError);
    expect(manager.getExecution(workspaceRoot, childId)).toBeUndefined();
    releaseTransition();
  });

  test("resumeChildExecution exposes a running link for the current resume tool call", async () => {
    const parentId = crypto.randomUUID();
    const childSessionId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
    const childStore = storeManager.create(childSessionId, workspaceRoot, {
      rootSessionId: parentId,
      parentSessionId: parentId,
      agentName: "explore",
      title: "Resume child",
    });
    parentStore.getState().append({
      type: "tool-child-session-link",
      link: {
        parentSessionId: parentId,
        parentToolCallId: "initial-tool-call",
        toolName: "delegate",
        childSessionId,
        childExecutionId: "initial-child-execution",
        childAgentName: "explore",
      childProfile: "fast",
      childSkillNames: [],
        title: "Resume child",
        depth: 1,
        background: false,
        status: "completed",
        createdAt: 1,
        startedAt: 1,
        endedAt: 2,
        durationMs: 1,
      },
    });
    const factory = makeFactory();
    const resumedRun = deferred<MockAgentResult>();
    const childAgent = new MockAgent(childSessionId, resumedRun.promise, workspaceRoot);
    childStore.setState({ append: childAgent.store.getState().append });
    childAgent.store.setState({
      rootSessionId: parentId,
      parentSessionId: parentId,
      agentName: "explore",
      title: "Resume child",
    });
    const { manager } = createManager({ [childSessionId]: childAgent }, { factory });

    const resumed = await manager.resumeChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "resume-tool-call",
      toolName: "resume_session",
      sessionId: childSessionId,
      instruction: "second round",
      background: false,
      parentAbort: undefined,
    });

    const runningLink = parentStore.getState().childSessionLinks.find((link) => link.parentToolCallId === "resume-tool-call");
    expect(runningLink).toMatchObject({
      childSessionId,
      parentToolCallId: "resume-tool-call",
      status: "running",
    });
    expect(runningLink?.startedAt).toBe(childAgent.store.getState().executions.at(-1)?.startedAt);
    expect(runningLink?.endedAt).toBeUndefined();
    expect(runningLink?.durationMs).toEqual(expect.any(Number));
    expect(runningLink?.durationUpdatedAt).toEqual(expect.any(Number));

    resumedRun.resolve({
      text: "waiting for approval",
      steps: 1,
      outcome: "suspended",
      suspension: {
        kind: "hitl",
        toolBatchId: "resume-hitl-batch",
        blockerIds: ["resume-hitl"],
      },
    });
    await resumed.result;
    const waitingLink = parentStore.getState().childSessionLinks.find((link) => link.parentToolCallId === "resume-tool-call");
    expect(waitingLink).toMatchObject({
      childSessionId,
      parentToolCallId: "resume-tool-call",
      status: "waiting_for_human",
    });
    expect(waitingLink?.startedAt).toBe(runningLink?.startedAt);
    expect(waitingLink?.endedAt).toBeUndefined();
    expect(waitingLink?.durationMs).toBeGreaterThanOrEqual(runningLink?.durationMs ?? 0);
    expect(waitingLink?.durationUpdatedAt).toEqual(expect.any(Number));
  });

  test("resumeChildExecution uses the canonical child title instead of a stale link title", async () => {
    const parentId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
    const childStore = storeManager.create(childId, workspaceRoot, {
      rootSessionId: parentId,
      parentSessionId: parentId,
      agentName: "explore",
      title: "Canonical title",
    });
    parentStore.getState().append({
      type: "tool-child-session-link",
      link: { ...makeChildLink(parentId, childId, "explore"), title: "Stale link title", status: "completed" },
    });
    const childAgent = new MockAgent(childId, Promise.resolve({ text: "done", steps: 1 }), workspaceRoot);
    childAgent.store.setState(childStore.getState());
    const { manager } = createManager({ [childId]: childAgent }, { factory: makeFactory() });

    const resumed = await manager.resumeChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "canonical-title-resume",
      toolName: "resume_session",
      sessionId: childId,
      instruction: "resume",
    background: false,
    });
    await resumed.result;

    expect(parentStore.getState().childSessionLinks.find((link) => link.parentToolCallId === "canonical-title-resume"))
      .toMatchObject({ title: "Canonical title", status: "completed" });
  });

  test("resumeChildExecution rejects a child without a canonical title", async () => {
    const parentId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
    storeManager.create(childId, workspaceRoot, {
      rootSessionId: parentId,
      parentSessionId: parentId,
      agentName: "explore",
    });
    const { manager } = createManager({}, { factory: makeFactory() });

    await expect(manager.resumeChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "missing-title-resume",
      toolName: "resume_session",
      sessionId: childId,
      instruction: "resume",
    background: false,
    })).rejects.toThrow(`Child Session "${childId}" has no canonical title`);
    expect(parentStore.getState().childSessionLinks).toEqual([]);
  });

  test("resumeChildExecution rejects Skills that drift from the durable delegation request", async () => {
    const parentId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
    const childStore = storeManager.create(childId, workspaceRoot, {
      rootSessionId: parentId,
      parentSessionId: parentId,
      agentName: "explore",
      title: "Delegated child",
      activeSkillNames: [],
      delegationRequest: delegationRequest({
        agent_type: "explore",
        title: "Delegated child",
        skills: [],
      }),
    });
    childStore.setState({ activeSkillNames: ["codemap"] });
    const { manager } = createManager({}, { factory: makeFactory() });

    await expect(manager.resumeChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "drifted-skills-resume",
      toolName: "resume_session",
      sessionId: childId,
      instruction: "resume",
      background: false,
    })).rejects.toThrow("active Skills do not match its durable delegation request");
    expect(parentStore.getState().childSessionLinks).toEqual([]);
  });

  test("resumeChildExecution rejects mutable child model selection instead of overriding its Profile", async () => {
    const parentId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
    const childStore = storeManager.create(childId, workspaceRoot, {
      rootSessionId: parentId,
      parentSessionId: parentId,
      agentName: "explore",
      title: "Delegated child",
      activeSkillNames: [],
      delegationRequest: delegationRequest({
        agent_type: "explore",
        title: "Delegated child",
        skills: [],
      }),
    });
    childStore.setState({
      modelSelection: { revision: 1, override: { model: "test:other" } },
    });
    const { manager } = createManager({}, { factory: makeFactory() });

    await expect(manager.resumeChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "child-model-override",
      toolName: "resume_session",
      sessionId: childId,
      instruction: "resume",
      background: false,
    })).rejects.toMatchObject({
      name: "SessionModelSelectionNotAllowedError",
      reason: "not_root_lead",
    });
    expect(parentStore.getState().childSessionLinks).toEqual([]);
  });

  test("resumeChildExecution rejects a child whose canonical root differs from its parent", async () => {
    const parentId = crypto.randomUUID();
    const foreignRootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
    storeManager.create(childId, workspaceRoot, {
      rootSessionId: foreignRootId,
      parentSessionId: parentId,
      agentName: "explore",
      title: "Corrupted child",
    });
    const { manager } = createManager({}, { factory: makeFactory() });

    await expect(manager.resumeChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "foreign-root-resume",
      toolName: "resume_session",
      sessionId: childId,
      instruction: "resume",
    background: false,
    })).rejects.toThrow(`belongs to root "${foreignRootId}", not "${parentId}"`);
    expect(parentStore.getState().childSessionLinks).toEqual([]);
  });

  test("resumeChildExecution re-enforces canonical maxDepth", async () => {
    const rootId = crypto.randomUUID();
    const middleId = crypto.randomUUID();
    const parentId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    storeManager.create(rootId, workspaceRoot, { agentName: "lead" });
    storeManager.create(middleId, workspaceRoot, {
      rootSessionId: rootId,
      parentSessionId: rootId,
      agentName: "lead",
      title: "Middle",
    });
    const parentStore = storeManager.create(parentId, workspaceRoot, {
      rootSessionId: rootId,
      parentSessionId: middleId,
      agentName: "lead",
      title: "Deep parent",
    });
    storeManager.create(childId, workspaceRoot, {
      rootSessionId: rootId,
      parentSessionId: parentId,
      agentName: "explore",
      title: "Too deep child",
    });
    const { manager } = createManager({}, { factory: makeFactory() });

    await expect(manager.resumeChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "too-deep-resume",
      toolName: "resume_session",
      sessionId: childId,
      instruction: "resume",
    background: false,
    })).rejects.toThrow(DepthLimitError);
  });

  test("Todo Discussion resume derives maxDepth 2 from the authoritative binding", async () => {
    const parentId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
    storeManager.create(childId, workspaceRoot, {
      rootSessionId: parentId,
      parentSessionId: parentId,
      agentName: "explore",
      title: "Discussion evidence",
      activeSkillNames: [],
      delegationRequest: delegationRequest({
        agent_type: "explore",
        title: "Discussion evidence",
        objective: "Inspect local evidence for this Todo Discussion.",
        skills: [],
      }),
    });
    const { manager } = createManager({}, {
      factory: makeFactoryWithChildPolicy({ maxDepth: 3 }),
      isDiscussionSession: async (_workspaceRoot, sessionId) => sessionId === parentId,
      resolveSessionDepth: async (_workspaceRoot, sessionId) => sessionId === parentId ? 2 : 3,
    });

    await expect(manager.resumeChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "discussion-depth-resume",
      toolName: "resume_session",
      sessionId: childId,
      instruction: "resume",
      background: false,
    })).rejects.toBeInstanceOf(DepthLimitError);
    expect(parentStore.getState().childSessionLinks).toEqual([]);
  });

  test("resumeChildExecution re-enforces maxConcurrent", async () => {
    const parentId = crypto.randomUUID();
    const firstChildId = crypto.randomUUID();
    const secondChildId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
    const firstStore = storeManager.create(firstChildId, workspaceRoot, {
      rootSessionId: parentId,
      parentSessionId: parentId,
      agentName: "explore",
      title: "First child",
    });
    const secondStore = storeManager.create(secondChildId, workspaceRoot, {
      rootSessionId: parentId,
      parentSessionId: parentId,
      agentName: "explore",
      title: "Second child",
    });
    const firstRun = deferred<MockAgentResult>();
    const firstAgent = new MockAgent(firstChildId, firstRun.promise, workspaceRoot);
    firstAgent.store.setState(firstStore.getState());
    const secondAgent = new MockAgent(secondChildId, Promise.resolve({ text: "must not run", steps: 1 }), workspaceRoot);
    secondAgent.store.setState(secondStore.getState());
    const { manager } = createManager({ [firstChildId]: firstAgent, [secondChildId]: secondAgent }, { factory: makeFactory() });

    const first = await manager.resumeChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "first-resume",
      toolName: "resume_session",
      sessionId: firstChildId,
      instruction: "resume",
    background: false,
    });
    await expect(manager.resumeChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "second-resume",
      toolName: "resume_session",
      sessionId: secondChildId,
      instruction: "resume",
    background: false,
    })).rejects.toThrow(ConcurrentLimitError);
    firstRun.resolve({ text: "done", steps: 1 });
    await first.result;
  });

  test("resumeChildExecution reapplies deadline and abortCascade policies", async () => {
    const parentId = crypto.randomUUID();
    const timedChildId = crypto.randomUUID();
    const uncascadedChildId = crypto.randomUUID();
    const cascadedChildId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
    const timedStore = storeManager.create(timedChildId, workspaceRoot, {
      rootSessionId: parentId, parentSessionId: parentId, agentName: "explore", title: "Timed child",
    });
    const uncascadedStore = storeManager.create(uncascadedChildId, workspaceRoot, {
      rootSessionId: parentId, parentSessionId: parentId, agentName: "explore", title: "Uncascaded child",
    });
    const cascadedStore = storeManager.create(cascadedChildId, workspaceRoot, {
      rootSessionId: parentId, parentSessionId: parentId, agentName: "explore", title: "Cascaded child",
    });
    const timedAgent = new MockAgent(timedChildId, new Promise(() => undefined), workspaceRoot);
    timedAgent.store.setState(timedStore.getState());
    const timedManager = createManager({ [timedChildId]: timedAgent }, {
      factory: makeFactoryWithChildPolicy({ timeoutMs: 60_000 }),
    });
    const timed = await timedManager.manager.resumeChildExecution(workspaceRoot, {
      parentStore, parentSessionId: parentId, parentToolCallId: "timed-resume", toolName: "resume_session",
      sessionId: timedChildId, instruction: "resume", background: false,
    });
    timedManager.deadlineScheduler.fireScheduled();
    expect(await timed.result).toMatchObject({
      outcome: "terminal",
      executionStatus: "timed_out",
    });

    const uncascadedRun = deferred<MockAgentResult>();
    const uncascadedAgent = new MockAgent(uncascadedChildId, uncascadedRun.promise, workspaceRoot);
    uncascadedAgent.store.setState(uncascadedStore.getState());
    const uncascadedManager = createManager({ [uncascadedChildId]: uncascadedAgent }, {
      factory: makeFactoryWithChildPolicy({ abortCascade: false }),
    }).manager;
    const parentAbort = new AbortController();
    const uncascaded = await uncascadedManager.resumeChildExecution(workspaceRoot, {
      parentStore, parentSessionId: parentId, parentToolCallId: "uncascaded-resume", toolName: "resume_session",
      sessionId: uncascadedChildId, instruction: "resume", background: false, parentAbort: parentAbort.signal,
    });
    parentAbort.abort();
    expect(uncascadedManager.getExecution(workspaceRoot, uncascadedChildId)?.abortController.signal.aborted).toBe(false);
    uncascadedRun.resolve({ text: "done", steps: 1 });
    await uncascaded.result;

    const cascadedAgent = new MockAgent(cascadedChildId, new Promise(() => undefined), workspaceRoot);
    cascadedAgent.store.setState(cascadedStore.getState());
    const cascadedManager = createManager({ [cascadedChildId]: cascadedAgent }, {
      factory: makeFactoryWithChildPolicy({ abortCascade: true }),
    }).manager;
    const cascadingAbort = new AbortController();
    const cascaded = await cascadedManager.resumeChildExecution(workspaceRoot, {
      parentStore, parentSessionId: parentId, parentToolCallId: "cascaded-resume", toolName: "resume_session",
      sessionId: cascadedChildId, instruction: "resume", background: false, parentAbort: cascadingAbort.signal,
    });
    cascadingAbort.abort();
    expect(await cascaded.result).toMatchObject({
      outcome: "terminal",
      executionStatus: "cancelled",
    });
  });

  test("resumeChildExecution supports background links and terminal reminders", async () => {
    const parentId = crypto.randomUUID();
    const childSessionId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
    const childStore = storeManager.create(childSessionId, workspaceRoot, {
      rootSessionId: parentId,
      parentSessionId: parentId,
      agentName: "explore",
      title: "Resume child",
    });
    parentStore.getState().append({
      type: "tool-child-session-link",
      link: {
        parentSessionId: parentId,
        parentToolCallId: "initial-tool-call",
        toolName: "delegate",
        childSessionId,
        childExecutionId: "initial-child-execution",
        childAgentName: "explore",
      childProfile: "fast",
      childSkillNames: [],
        title: "Resume child",
        depth: 1,
        background: false,
        status: "completed",
        createdAt: 1,
        startedAt: 1,
        endedAt: 2,
        durationMs: 1,
      },
    });
    const factory = makeFactory();
    const resumedRun = deferred<MockAgentResult>();
    const childAgent = new MockAgent(childSessionId, resumedRun.promise, workspaceRoot);
    childStore.setState({ append: childAgent.store.getState().append });
    childAgent.store.setState({
      rootSessionId: parentId,
      parentSessionId: parentId,
      agentName: "explore",
      title: "Resume child",
    });
    const { manager } = createManager({ [childSessionId]: childAgent }, { factory });

    const resumed = await manager.resumeChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "resume-background-tool-call",
      toolName: "resume_session",
      sessionId: childSessionId,
      instruction: "second round",
      background: true,
      parentAbort: undefined,
    });

    expect(parentStore.getState().childSessionLinks.find((link) => link.parentToolCallId === "resume-background-tool-call")).toMatchObject({
      childSessionId,
      parentToolCallId: "resume-background-tool-call",
      background: true,
      status: "running",
    });

    resumedRun.resolve({ text: "resumed done", steps: 1 });
    await resumed.result;

    expect(parentStore.getState().childSessionLinks.find((link) => link.parentToolCallId === "resume-background-tool-call")).toMatchObject({
      childSessionId,
      parentToolCallId: "resume-background-tool-call",
      background: true,
      status: "completed",
    });
    expect(parentStore.getState().reminders.at(-1)).toMatchObject({
      source: { type: "subagent_completed", sessionId: childSessionId },
      sessionId: childSessionId,
      terminalState: "completed",
    });
  });

  test("resumeChildExecution on running session throws AgentRunningError", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
    const childRun = deferred<MockAgentResult>();
    const { manager } = createManager({}, { factory: makeFactory(), childRun: childRun.promise });

    const first = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "running-tool-call",
      toolName: "delegate",
      request: delegationRequest({ agent_type: "explore", title: "Delegated child", objective: "first round", skills: [], background: false }),
      parentAbort: undefined,
    });

    await expect(manager.resumeChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "running-tool-call",
      toolName: "resume_session",
      sessionId: first.sessionId,
      instruction: "second round",
      background: false,
      parentAbort: undefined,
    })).rejects.toThrow(AgentRunningError);

    first.abort();
    childRun.resolve({ text: "done", steps: 1 });
    await first.result;
  });

  test("resumeChildExecution rejects a child with an unresolved durable HITL blocker", async () => {
    const parentId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
    const childStore = storeManager.create(childId, workspaceRoot, {
      rootSessionId: parentId,
      parentSessionId: parentId,
      agentName: "explore",
    });
    childStore.setState({ toolBatches: [blockedToolBatch("hitl-child-pending")] });
    const { manager } = createManager({}, { factory: makeFactory() });
    const linksBefore = parentStore.getState().childSessionLinks.length;

    await expect(manager.resumeChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "resume-blocked-child",
      toolName: "resume_session",
      sessionId: childId,
      instruction: "must wait for HITL",
      background: false,
      parentAbort: undefined,
    })).rejects.toThrow(SessionToolBatchActiveError);

    expect(parentStore.getState().childSessionLinks).toHaveLength(linksBefore);
    expect(manager.getExecution(workspaceRoot, childId)).toBeUndefined();
  });

  test("resumeChildExecution on non-existent session throws ChildSessionNotFoundError", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
    const { manager } = createManager({}, { factory: makeFactory() });

    await expect(manager.resumeChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "missing-tool-call",
      toolName: "resume_session",
      sessionId: crypto.randomUUID(),
      instruction: "resume",
      background: false,
      parentAbort: undefined,
    })).rejects.toThrow(ChildSessionNotFoundError);
  });

  test("resumeChildExecution with wrong parent throws ChildSessionParentMismatchError", async () => {
    const parentId = crypto.randomUUID();
    const otherParentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
    const otherParentStore = storeManager.create(otherParentId, workspaceRoot, { agentName: "lead" });
    const { manager } = createManager({}, { factory: makeFactory() });

    const first = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "parent-tool-call",
      toolName: "delegate",
      request: delegationRequest({ agent_type: "explore", title: "Delegated child", objective: "first round", skills: [], background: false }),
      parentAbort: undefined,
    });
    await first.result;

    await expect(manager.resumeChildExecution(workspaceRoot, {
      parentStore: otherParentStore,
      parentSessionId: otherParentId,
      parentToolCallId: "parent-tool-call",
      toolName: "resume_session",
      sessionId: first.sessionId,
      instruction: "second round",
      background: false,
      parentAbort: undefined,
    })).rejects.toThrow(ChildSessionParentMismatchError);
  });

  test("cancelChildSession on running descendant aborts, marks link cancelled, appends reminder", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
    const childRun = deferred<MockAgentResult>();
    const { manager } = createManager({}, { factory: makeFactory(), childRun: childRun.promise });

    const child = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "cancel-tool-call",
      toolName: "delegate",
      request: delegationRequest({ agent_type: "explore", title: "Delegated child", objective: "running", skills: [], background: true }),
      parentAbort: undefined,
    });

    expect(manager.cancelChildSession(workspaceRoot, parentId, child.sessionId)).toBe(true);
    childRun.resolve({ text: "done", steps: 1 });
    await child.result;

    expect(parentStore.getState().childSessionLinks.at(-1)).toMatchObject({
      childSessionId: child.sessionId,
      status: "cancelled",
    });
    const reminders = parentStore.getState().reminders;
    expect(reminders.some((reminder) => reminder.source.type === "subagent_cancelled" && reminder.sessionId === child.sessionId)).toBe(true);
  });

  test("cancelChildSession on non-descendant throws ChildSessionNotDescendantError", async () => {
    const parentId = crypto.randomUUID();
    const strangerId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
    storeManager.create(strangerId, workspaceRoot, { agentName: "lead" });
    const { manager } = createManager({}, { factory: makeFactory() });

    expect(() => manager.cancelChildSession(workspaceRoot, parentId, strangerId)).toThrow(ChildSessionNotDescendantError);
  });

  test("cancelChildSession on non-running session returns false", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "lead" });
    const { manager } = createManager({}, { factory: makeFactory() });

    const child = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "completed-tool-call",
      toolName: "delegate",
      request: delegationRequest({ agent_type: "explore", title: "Delegated child", objective: "done", skills: [], background: false }),
      parentAbort: undefined,
    });
    await child.result;

    expect(manager.cancelChildSession(workspaceRoot, parentId, child.sessionId)).toBe(false);
  });
});
