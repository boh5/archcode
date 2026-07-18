import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createEmptySessionStats } from "@archcode/protocol";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { Agent, AgentCommand, AgentCommandResult, AgentResult, AgentRunOptions } from "../agents/types";
import { ConfiguredAgent } from "../agents/configured-agent";
import { engineerAgentDefinition } from "../agents/definitions";
import { ProviderRegistry } from "../provider";
import { ModelInfo } from "../provider/model";
import { SkillService } from "../skills";
import { createTestProjectContextResolver } from "../agents/test-project-context-resolver";
import { createRegistry } from "../tools";
import { setLlmAdapterForTest } from "../llm/adapter";
import { AgentRunningError, ConcurrentLimitError, DelegateTargetNotAllowedError, DepthLimitError, ChildSessionNotFoundError, ChildSessionParentMismatchError, ChildSessionNotDescendantError, ChildSessionCwdMismatchError, SessionCwdTransitionConflictError, SessionCwdTransitionInProgressError, SessionToolBatchActiveError } from "../agents/errors";
import type { SessionAgentManager } from "../agents/session-agent-manager";
import { NotRootSessionError, SessionDeleteConflictError, SessionFileNotFoundError } from "../store/errors";
import { SessionDeleteInProgressError, SessionDeleteOwnerConflictError } from "./session-deletion";
import { SessionFamilyActiveError, SessionFamilyIdentityUnavailableError, SessionFamilyStopConflictError, SessionFamilyStopInProgressError } from "./session-family-control";
import type { SessionFile } from "../store/helpers";
import { SessionStoreManager } from "../store/session-store-manager";
import { getSessionDir, getSessionPath } from "../store/sessions-dir";
import { SessionExecutionManager, SessionSteerUnavailableError } from "./session-execution-manager";
import { SessionExecutionScopeConflictError } from "./session-execution-scope-validator";
import { SessionWorkspaceClosingError } from "./session-workspace-control";
import { silentLogger } from "../logger";
import type { SessionStoreState, SessionToolBatch, ToolChildSessionLink } from "../store/types";
import type { AgentFactory } from "../agents/factory";
import type { AgentDefinition } from "../agents/factory-types";
import { createEmptyCompressionState } from "../compression";
import type { SessionGoalDelegationContext } from "./session-goal-delegation-context";
import { SessionInputConflictError, SessionInputService } from "../session-input/service";
import type { ArchCodeConfig, ModelConfig } from "../config";
import type { ExecutionModelBinding } from "../models";
import { ModelRuntime, ModelRuntimeSnapshot, ModelSelectionResolver } from "../models";

const testRoot = join(
  import.meta.dir,
  "__test_tmp__",
  `session-execution-manager-${crypto.randomUUID()}`,
);
let workspaceRoot = join(testRoot, "bootstrap");
let defaultAgentWorkspaceRoot = workspaceRoot;
const storeManager = new SessionStoreManager({ logger: silentLogger });
const TEST_REQUESTED_MODEL_SELECTION = {
  mode: "agent_default" as const,
  selection: { model: "test:model" },
};
const TEST_BINDING_SUMMARY = {
  selection: { model: "test:model" }, providerId: "test", modelId: "model",
  providerDisplayName: "Test Provider", modelDisplayName: "Test Model",
  resolution: "agent_default" as const, modelRuntimeRevision: "test-runtime-1",
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

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for execution state");
    await Bun.sleep(1);
  }
}

function getUserMessageTexts(state: SessionStoreState): string[] {
  return state.messages
    .filter((message) => message.role === "user")
    .map((message) => message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""));
}

type MockAgentResult = Partial<AgentResult> & Pick<AgentResult, "text" | "steps">;

class MockAgent implements Agent {
  readonly store;
  readonly cwd: string;
  readonly runBindings: ExecutionModelBinding[] = [];
  readonly runMock = mock(async (options: AgentRunOptions = {}): Promise<AgentResult> => {
    const signal = options.abort;
    const result = await withAbort(this.result, signal);
    this.store.getState().append({ type: "text-start" });
    this.store.getState().append({ type: "text-delta", text: result.text });
    this.store.getState().append({ type: "text-end" });
    return { ...result, status: result.status ?? "completed" };
  });

  constructor(
    readonly sessionId: string,
    readonly result: Promise<MockAgentResult>,
    readonly workspaceRoot: string = defaultAgentWorkspaceRoot,
    sessionStores: SessionStoreManager = storeManager,
  ) {
    this.store = sessionStores.create(sessionId, workspaceRoot, { agentName: "engineer" });
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
    return this.runMock(options);
  }

  dispose(): void {}
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
  goalDelegationAdmission?: ConstructorParameters<typeof SessionExecutionManager>[0]["goalDelegationAdmission"];
  deletionLifecycle?: ConstructorParameters<typeof SessionExecutionManager>[0]["deletionLifecycle"];
  flushSessionStore?: ConstructorParameters<typeof SessionExecutionManager>[0]["flushSessionStore"];
  listSessionFamilyToolBatchHitlIds?: ConstructorParameters<typeof SessionExecutionManager>[0]["listSessionFamilyToolBatchHitlIds"];
  sessionInputService?: ConstructorParameters<typeof SessionExecutionManager>[0]["sessionInputService"];
  sessionFamilyStopTimeoutMs?: number;
  modelRuntime?: ModelRuntime;
}

const allowExecutionScope = { validate: async () => undefined };

type SessionExecutionManagerConfigForTest = ConstructorParameters<typeof SessionExecutionManager>[0];

function storeCallbacks(manager: SessionStoreManager): Pick<
  SessionExecutionManagerConfigForTest,
  "createSessionStore" | "flushSessionStore" | "getSessionStore" | "loadSessionStore" | "deleteSessionStore" | "resolveRootSessionId" | "resolveSessionDepth" | "buildSessionTree" | "listSessionFamilyToolBatchHitlIds"
> {
  return {
    createSessionStore: (sessionId, root, createOptions) => manager.create(sessionId, root, createOptions),
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
  };
}

function createFakeManager(agents: Record<string, MockAgent>, options: FakeManagerOptions = {}): SessionAgentManager {
  return {
    getOrCreate: mock(async (_root: string, sessionId: string) => options.getAgent?.(sessionId) ?? agents[sessionId]!),
    get: mock((_root: string, sessionId: string) => agents[sessionId]),
    getFactory: mock(() => options.factory),
    createChildAgent: mock((input: { workspaceRoot: string; sessionId: string; store: MockAgent["store"] }) => {
      const childAgent = {
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
          return { ...result, status: result.status ?? "completed" };
        }),
        dispose: mock(() => undefined),
      } as unknown as MockAgent;
      agents[input.sessionId] = childAgent;
      return childAgent;
    }),
    dispose: mock(() => undefined),
    releaseAgent: mock((_root: string, sessionId: string) => options.onReleaseAgent?.(sessionId)),
  } as unknown as SessionAgentManager;
}

function makeFactory(overrides: Partial<AgentFactory> = {}): AgentFactory {
  const parentDefinition: AgentDefinition = {
    name: "engineer",
    displayName: "Engineer",
    promptProfileId: "default",
    tools: { tools: ["delegate"], delegateTargets: ["explore"] },
    hooks: { autoCompact: false, autoInjectReminder: false, todoStepReminder: false, todoQueryLoopContinuation: false, memoryExtraction: false, memoryConsolidation: false, titleGeneration: "disabled" },
    childPolicy: { maxDepth: 2, maxConcurrent: 1, timeoutMs: 0, abortCascade: true, terminalReminders: true },
    includeMemoryInPrompt: false,
    skills: [],
  };
  const childDefinition: AgentDefinition = { ...parentDefinition, name: "explore", tools: { tools: [] }, childPolicy: undefined };
  return {
    createRootAgent: mock(() => { throw new Error("unused"); }),
    createAgent: mock(() => { throw new Error("unused"); }),
    getDefinition: mock((name: string) => {
      if (name === "engineer") return parentDefinition;
      if (name === "explore") return childDefinition;
      throw new Error(`Unknown agent definition: ${name}`);
    }),
    listAgentNames: mock(() => ["engineer", "explore"]),
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
      return name === "engineer"
        ? { ...definition, childPolicy: { ...definition.childPolicy!, ...policy } }
        : definition;
    }),
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
    agents: {
      engineer: { ...agent }, goal_lead: { ...agent }, plan: { ...agent }, build: { ...agent },
      reviewer: { ...agent }, explore: { ...agent }, librarian: { ...agent }, shaper: { ...agent },
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
  const manager = new SessionExecutionManager({
    sessionAgentManager,
    modelRuntime,
    modelSelectionResolver: new ModelSelectionResolver(),
    ...storeCallbacks(executionStoreManager),
    flushSessionStore: options.flushSessionStore ?? (async () => undefined),
    ...(options.listSessionFamilyToolBatchHitlIds === undefined ? {} : {
      listSessionFamilyToolBatchHitlIds: options.listSessionFamilyToolBatchHitlIds,
    }),
    trackSession,
    untrackSession,
    executionScopeValidator: options.executionScopeValidator ?? allowExecutionScope,
    sessionInputService: options.sessionInputService ?? new SessionInputService(executionStoreManager),
    ...(options.goalDelegationAdmission === undefined ? {} : { goalDelegationAdmission: options.goalDelegationAdmission }),
    ...(options.deletionLifecycle === undefined ? {} : { deletionLifecycle: options.deletionLifecycle }),
    ...(options.sessionFamilyStopTimeoutMs === undefined ? {} : { sessionFamilyStopTimeoutMs: options.sessionFamilyStopTimeoutMs }),
    logger: silentLogger,
  });
  return { manager, sessionAgentManager, trackSession, untrackSession };
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

function goalDelegationContext(
  goalId: string,
  overrides: Partial<SessionGoalDelegationContext> = {},
): SessionGoalDelegationContext {
  return {
    goalId,
    objective: "Ship Goal-scoped work",
    acceptanceCriteria: "Delegated work uses the current Goal state",
    status: "running",
    attempt: 1,
    reviewGeneration: 0,
    lastFailureSummary: null,
    ...overrides,
  };
}

function admitGoal(context: SessionGoalDelegationContext): NonNullable<FakeManagerOptions["goalDelegationAdmission"]> {
  return { run: async (_input, action) => await action(context) };
}

async function writeSessionFile(input: {
  sessionId: string;
  rootSessionId?: string;
  parentSessionId?: string;
  cwd?: string;
  title?: string;
  executions?: SessionFile["executions"];
  childSessionLinks?: SessionFile["childSessionLinks"];
  toolBatches?: SessionFile["toolBatches"];
  goalId?: string;
}): Promise<void> {
  const rootSessionId = input.rootSessionId ?? input.sessionId;
  const file: SessionFile = {
    sessionId: input.sessionId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    cwd: input.cwd ?? workspaceRoot,
    agentName: input.parentSessionId === undefined ? "engineer" : "explore",
    activeSkillNames: [],
    modelSelection: { revision: 0 },
    title: input.title ?? null,
    messages: [],
    pendingMessages: [],
    inputRequestReceipts: [],
    steps: [],
    stats: createEmptySessionStats(),
    executions: input.executions ?? [],
    compression: createEmptyCompressionState(),
    todos: [],
    reminders: [],
    childSessionLinks: input.childSessionLinks ?? [],
    toolBatches: input.toolBatches ?? [],
    rootSessionId,
    ...(input.goalId === undefined ? {} : { goalId: input.goalId }),
    ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
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
    step: 0,
    agentName: "engineer",
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
    childAgentName,
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
    await rm(testRoot, { recursive: true, force: true });
  });

  test("fixes one binding at claim and commits only the same-actual-selection Queue prefix", async () => {
    const rootId = crypto.randomUUID();
    const rootAgent = new MockAgent(rootId, Promise.resolve({ text: "done", steps: 1 }), workspaceRoot);
    const { manager } = createManager({ [rootId]: rootAgent });
    const service = new SessionInputService(storeManager);
    const defaultRequest = { mode: "agent_default" as const, selection: { model: "test:model" } };
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
    expect(state.executions[0]?.binding.selection).toEqual({ model: "test:model" });
    expect(state.executions[0]?.origin).toBe("user_message");
    expect(rootAgent.runBindings[0]?.summary).toEqual(state.executions[0]?.binding);
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
            mode: model === "model" ? "agent_default" : "session_override",
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
    expect(grouped.store.getState().executions.map((execution) => execution.binding.selection.model))
      .toEqual(["test:model", "test:other"]);
    expect(grouped.store.getState().messages.filter((message) => message.role === "user").map((message) => message.executionId))
      .toEqual([
        grouped.store.getState().executions[0]!.id,
        grouped.store.getState().executions[0]!.id,
        grouped.store.getState().executions[1]!.id,
      ]);

    const alternating = await runSequence(["model", "other", "model"]);
    expect(alternating.store.getState().executions.map((execution) => execution.binding.selection.model))
      .toEqual(["test:model", "test:other", "test:model"]);
  });

  test("coalesces distinct invalid requests onto the current default with per-message audits", async () => {
    const rootId = crypto.randomUUID();
    const rootAgent = new MockAgent(rootId, Promise.resolve({ text: "done", steps: 1 }), workspaceRoot);
    const modelRuntime = makeModelRuntime(false, "test:model", "runtime-z");
    const { manager } = createManager({ [rootId]: rootAgent }, { modelRuntime });
    const service = new SessionInputService(storeManager);
    const requests = [
      { mode: "agent_default" as const, selection: { model: "removed:x" } },
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
    expect(state.executions[0]!.binding).toMatchObject({
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
    expect(execution.binding.summary.resolution).toBe("agent_default");
    expect(rootAgent.store.getState().executions[0]?.origin).toBe("user_message");
    expect(rootAgent.store.getState().messages[0]?.modelAudit?.requested).toEqual({
      mode: "agent_default",
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
    storeManager.create(rootId, workspaceRoot, { agentName: "engineer" });
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

  test("Stop aborts an active command, barriers old Queue, and writes no unrelated execution fact", async () => {
    const rootId = crypto.randomUUID();
    const store = storeManager.create(rootId, workspaceRoot, { agentName: "engineer" });
    const rootAgent = new MockAgent(rootId, Promise.resolve({ text: "queued result", steps: 1 }), workspaceRoot);
    const { manager } = createManager({ [rootId]: rootAgent });
    const service = new SessionInputService(storeManager);
    let commandSignal: AbortSignal | undefined;
    const command = manager.runSessionCommand({
      workspaceRoot,
      sessionId: rootId,
      clientRequestId: "command-stop",
      requestedModelSelection: TEST_REQUESTED_MODEL_SELECTION,
    }, async (_binding, signal) => {
      commandSignal = signal;
      await withAbort(new Promise<never>(() => undefined), signal);
    });
    const commandOutcome = command.then(
      () => ({ kind: "resolved" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    await waitFor(() => commandSignal !== undefined);
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
    storeManager.create(rootId, workspaceRoot, { agentName: "engineer" });
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
    const rootStore = storeManager.create(rootId, workspaceRoot, { agentName: "engineer" });
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
    storeManager.create(rootId, workspaceRoot, { agentName: "engineer" });
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
    storeManager.create(rootId, workspaceRoot, { agentName: "engineer" });
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
    expect(execution.agentName).toBe("engineer");
    expect(execution.origin).toBe("user_message");
    expect(typeof execution.executionToken).toBe("symbol");
    expect(manager.getSessionFamilyActivity(workspaceRoot, sessionId)).toBe("running");
    await expect(manager.startCheckedExecution({ slug: "project", workspaceRoot, sessionId, input: { kind: "direct", text: "again" } })).rejects.toThrow(SessionFamilyActiveError);
    await waitFor(() => agent.runMock.mock.calls.length === 1);
    expect(agent.runMock).toHaveBeenCalledWith(expect.objectContaining({ abort: execution.abortController.signal }));
    expect(getUserMessageTexts(agent.store.getState())).toEqual(["hello"]);
    const options = agent.runMock.mock.calls[0]?.[0];
    if (!options) throw new Error("Expected AgentRunOptions");
    expect("maxSteps" in options).toBe(false);
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
    const store = storeManager.create(sessionId, workspaceRoot, { agentName: "engineer" });
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
        return { text: "done", steps: 1, status: "completed" };
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
    const store = storeManager.create(sessionId, workspaceRoot, { agentName: "engineer" });
    const enteredRun = deferred<void>();
    const releaseHitlBoundary = deferred<void>();
    let invocation = 0;
    let resumedUserMessages: string[] = [];
    const agent: Agent = {
      store,
      cwd: workspaceRoot,
      classifyCommand: () => null,
      executeCommand: async () => ({ kind: "handled" }),
      run: async () => {
        invocation += 1;
        if (invocation > 1) {
          resumedUserMessages = getUserMessageTexts(store.getState());
          return { text: "resumed", steps: 1, status: "completed" };
        }
        enteredRun.resolve(undefined);
        await releaseHitlBoundary.promise;
        store.setState({ toolBatches: [blockedToolBatch("steer-before-hitl")] });
        return { text: "waiting", steps: 1, status: "waiting_for_human" };
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
      status: "waiting_for_human",
    });

    const resumed = await manager.startSessionToolBatchExecution({
      slug: "project",
      workspaceRoot,
      sessionId,
    });
    await resumed.promise;

    expect(resumed.executionId).not.toBe(execution.executionId);
    expect(resumedUserMessages).toEqual(["A", "B"]);
  });

  test("Stop still rolls back a HITL-boundary Steer before its durable commit", async () => {
    const sessionId = crypto.randomUUID();
    const store = storeManager.create(sessionId, workspaceRoot, { agentName: "engineer" });
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
      run: async () => {
        enteredRun.resolve(undefined);
        await releaseHitlBoundary.promise;
        store.setState({ toolBatches: [blockedToolBatch("stopped-steer-before-hitl")] });
        return { text: "waiting", steps: 1, status: "waiting_for_human" };
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
    const store = storeManager.create(sessionId, workspaceRoot, { agentName: "engineer" });
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
        return { text: "done", steps: 1, status: "completed" };
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

  test("preserves the managed Goal claim execution origin", async () => {
    const run = deferred<MockAgentResult>();
    const sessionId = crypto.randomUUID();
    const agent = new MockAgent(sessionId, run.promise);
    const { manager } = createManager({ [sessionId]: agent });

    const execution = await manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId,
      input: { kind: "direct", text: "continue goal" },
      origin: "goal_claim",
    });

    expect(execution.origin).toBe("goal_claim");
    run.resolve({ text: "done", steps: 1 });
    await execution.promise;
  });

  test("a Goal claim yields when Queue input arrives during async validation", async () => {
    const sessionId = crypto.randomUUID();
    const agent = new MockAgent(sessionId, Promise.resolve({ text: "must not run", steps: 1 }));
    const validationEntered = deferred<void>();
    const releaseValidation = deferred<void>();
    const { manager } = createManager({ [sessionId]: agent }, {
      executionScopeValidator: {
        validate: async () => {
          validationEntered.resolve(undefined);
          await releaseValidation.promise;
        },
      },
    });
    const inputs = new SessionInputService(storeManager);
    const starting = manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId,
      input: { kind: "direct", text: "continue goal" },
      origin: "goal_claim",
    });
    await validationEntered.promise;
    await inputs.acceptMessage({
      sessionId,
      workspaceRoot,
      text: "user wins",
      clientRequestId: crypto.randomUUID(),
      source: "user",
      requestedModelSelection: TEST_REQUESTED_MODEL_SELECTION,
    });
    releaseValidation.resolve(undefined);

    await expect(starting).rejects.toMatchObject({
      name: "SessionInputConflictError",
      reason: "state",
    });
    expect(agent.runMock).toHaveBeenCalledTimes(0);
  });

  test("keeps Todo query-loop continuations inside one durable execution", async () => {
    const sessionId = crypto.randomUUID();
    const store = storeManager.create(sessionId, workspaceRoot, { agentName: "engineer" });
    store.setState({
      todos: [{ id: "todo-1", content: "finish the task", status: "pending" }],
    });

    const definition = {
      ...engineerAgentDefinition,
      tools: { tools: [] },
      skills: [],
      hooks: {
        ...engineerAgentDefinition.hooks,
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
      toolRegistry: createRegistry([]),
      skillService: new SkillService({ builtinSkills: {} }),
      storeManager,
      store,
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
        { type: "execution-start", executionId: execution.executionId, binding: execution.binding.summary, origin: "user_message" },
        { type: "execution-end", status: "completed" },
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
    const statuses: AgentResult["status"][] = [
      "completed", "max_steps", "failed", "aborted", "cancelled", "timed_out", "interrupted", "waiting_for_human",
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

  test("HITL ends one execution and tool_batch resumes with a new execution id", async () => {
    const sessionId = crypto.randomUUID();
    const store = storeManager.create(sessionId, workspaceRoot, { agentName: "engineer" });
    const modelRuntime = makeModelRuntime(true, "test:model", "runtime-before-hitl");
    const bindings: ExecutionModelBinding[] = [];
    let invocation = 0;
    const agent = {
      store,
      cwd: workspaceRoot,
      classifyCommand: mock((_input: string) => null),
      executeCommand: mock(async (_command: AgentCommand): Promise<AgentCommandResult> => ({ kind: "handled" })),
      run: mock(async (binding: ExecutionModelBinding): Promise<AgentResult> => {
        bindings.push(binding);
        invocation += 1;
        if (invocation === 1) {
          store.setState({ toolBatches: [blockedToolBatch("resume-after-hitl")] });
          return { text: "waiting", steps: 1, status: "waiting_for_human" };
        }
        return { text: "resumed", steps: 1, status: "completed" };
      }),
      dispose: mock(() => undefined),
    } as Agent;
    const { manager } = createManager({ [sessionId]: agent as MockAgent }, { modelRuntime });

    const waiting = await manager.startCheckedExecution({
      slug: "project", workspaceRoot, sessionId, input: { kind: "direct", text: "ask" },
    });
    await waiting.promise;
    modelRuntime.publish(makeModelRuntime(true, "test:other", "runtime-after-hitl").current);
    const resumed = await manager.startSessionToolBatchExecution({
      slug: "project", workspaceRoot, sessionId,
    });
    await resumed.promise;

    expect(waiting.executionId).not.toBe(resumed.executionId);
    expect(store.getState().executions.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: waiting.executionId, status: "waiting_for_human" },
      { id: resumed.executionId, status: "completed" },
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

    expect(execution.agentName).toBe("engineer");
    expect(sessionAgentManager.getOrCreate).toHaveBeenCalledWith(workspaceRoot, sessionId);
  });

  test("atomically rejects duplicate starts while agent creation is pending", async () => {
    const sessionId = crypto.randomUUID();
    storeManager.create(sessionId, workspaceRoot, { agentName: "engineer" });
    const sessionAgentManager = createFakeManager({});
    const pendingManager = new SessionExecutionManager({
      sessionAgentManager: {
        ...sessionAgentManager,
        getOrCreate: mock(async () => await new Promise<Agent>(() => undefined)),
      } as unknown as SessionAgentManager,
      modelRuntime: makeModelRuntime(),
      modelSelectionResolver: new ModelSelectionResolver(),
      ...storeCallbacks(storeManager),
      sessionInputService: new SessionInputService(storeManager),
      trackSession: mock(() => undefined),
      untrackSession: mock(() => undefined),
      executionScopeValidator: allowExecutionScope,
      logger: silentLogger,
    });

    await pendingManager.startCheckedExecution({ slug: "project", workspaceRoot, sessionId, input: { kind: "direct", text: "one" } });

    await expect(pendingManager.startCheckedExecution({ slug: "project", workspaceRoot, sessionId, input: { kind: "direct", text: "two" } })).rejects.toThrow(SessionFamilyActiveError);
  });

  test("family stop cancels execution and ignores late tool result after current execution is settled", async () => {
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
    agent.store.getState().append({ type: "tool-result", toolCallId: "late-tool", toolName: "bash", output: "late", isError: false });

    const state = agent.store.getState();
    expect(state.executions).toHaveLength(1);
    expect(state.executions[0]?.status).toBe("cancelled");
    const tool = state.messages.flatMap((message) => message.parts).find((part) => part.type === "tool");
    expect(tool).toMatchObject({ type: "tool", state: "error", errorMessage: "Execution ended before tool result" });
  });

  test("session runs do not inject legacy deferred permission or question callbacks", async () => {
    const run = deferred<MockAgentResult>();
    const sessionId = crypto.randomUUID();
    let runOptions: AgentRunOptions | undefined;
    const agent = {
      store: storeManager.create(sessionId, workspaceRoot, { agentName: "engineer" }),
      classifyCommand: mock((_input: string) => null),
      executeCommand: mock(async (_command: AgentCommand): Promise<AgentCommandResult> => ({ kind: "handled" })),
      run: mock(async (options?: AgentRunOptions): Promise<AgentResult> => {
        runOptions = options;
        const result = await withAbort(run.promise, options?.abort);
        return { ...result, status: result.status ?? "completed" };
      }),
      dispose: mock(() => undefined),
    } as unknown as MockAgent;
    const { manager } = createManager({ [sessionId]: agent });

    const execution = await manager.startCheckedExecution({ slug: "project", workspaceRoot, sessionId, input: { kind: "direct", text: "work" } });
    await waitFor(() => runOptions !== undefined);
    if (!runOptions) throw new Error("Expected AgentRunOptions");
    expect(runOptions.confirmPermission).toBeUndefined();
    expect(runOptions.askUser).toBeUndefined();
    const stopping = manager.stopSessionFamily(workspaceRoot, sessionId);
    run.resolve({ text: "done", steps: 1 });
    await execution.promise;
    await stopping;

    expect(agent.store.getState().executions.at(-1)?.status).toBe("cancelled");
  });

  test("family stop is isolated by workspace root for identical session ids", async () => {
    const sessionId = crypto.randomUUID();
    const otherWorkspaceRoot = join(import.meta.dir, "__test_tmp__", "session-execution-manager-other-workspace", crypto.randomUUID());
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


  test("family stop generation blocks every new owner and drains an already pending child launch", async () => {
    const rootId = crypto.randomUUID();
    const rootStore = storeManager.create(rootId, workspaceRoot, { agentName: "engineer" });
    const skillResolution = deferred<readonly []>();
    let resolvingSkills = false;
    const factory = makeFactory({
      resolveDelegatedSkillNames: mock(async () => {
        resolvingSkills = true;
        return await skillResolution.promise;
      }),
    });
    const { manager } = createManager({}, { factory, sessionFamilyStopTimeoutMs: 100 });
    const pendingChild = manager.startChildExecution(workspaceRoot, {
      parentStore: rootStore,
      parentSessionId: rootId,
      parentToolCallId: "pending-before-stop",
      toolName: "delegate",
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "resolve slowly",
      skills: [],
    });
    await waitFor(() => resolvingSkills);
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
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "must not launch",
      skills: [],
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

  test("checked execution omits legacy permission and question service callbacks", async () => {
    const sessionId = crypto.randomUUID();
    const agent = new MockAgent(sessionId, Promise.resolve({ text: "done", steps: 1 }));
    const { manager } = createManager({ [sessionId]: agent });

    const execution = await manager.startCheckedExecution({ slug: "project", workspaceRoot, sessionId, input: { kind: "direct", text: "work" } });
    await execution.promise;
    const options = agent.runMock.mock.calls[0]?.[0];
    if (!options) throw new Error("Expected AgentRunOptions");
    expect(options.confirmPermission).toBeUndefined();
    expect(options.askUser).toBeUndefined();
  });

  test("startChildExecution validates through factory and runs a child session", async () => {
    const parentId = crypto.randomUUID();
    const goalId = crypto.randomUUID();
    const worktreeCwd = `${workspaceRoot}.worktrees/child-inheritance`;
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer", goalId, cwd: worktreeCwd });
    const factory = makeFactory();
    const { manager, sessionAgentManager } = createManager({}, {
      factory,
      listSessionFamilyToolBatchHitlIds: async () => [],
      goalDelegationAdmission: admitGoal(goalDelegationContext(goalId)),
    });

    const handle = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "tool-call",
      toolName: "delegate",
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "inspect",
      skills: [],
      description: "Inspect files",
      background: false,
      parentAbort: undefined,
    });

    await handle.result;

    expect(sessionAgentManager.createChildAgent).toHaveBeenCalled();
    expect(handle.store.getState().parentSessionId).toBe(parentId);
    expect(handle.store.getState().goalId).toBe(goalId);
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
      description: "Inspect files",
      depth: 1,
      background: false,
      status: "completed",
    });
  });

  test("startChildExecution prepends the admitted Goal snapshot to the delegated prompt", async () => {
    const parentId = crypto.randomUUID();
    const goalId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer", goalId });
    const context = goalDelegationContext(goalId, { reviewGeneration: 3 });
    const { manager } = createManager({}, {
      factory: makeFactory(),
      goalDelegationAdmission: admitGoal(context),
      listSessionFamilyToolBatchHitlIds: async () => [],
    });

    const child = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "goal-delegate",
      toolName: "delegate",
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "Inspect the implementation",
      skills: [],
    });
    await child.result;

    const [message] = getUserMessageTexts(child.store.getState());
    expect(message).toStartWith("<goal-delegation-context>\n");
    expect(message).toContain(`"goalId": "${goalId}"`);
    expect(message).toContain('"reviewGeneration": 3');
    expect(message).toEndWith("</goal-delegation-context>\n\nInspect the implementation");
    expect(getUserMessageTexts(child.store.getState())).toHaveLength(1);
  });

  test("startChildExecution leaves ordinary non-Goal delegation prompts unchanged", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
    const admissionRun = mock(async () => { throw new Error("ordinary delegation must bypass Goal admission"); });
    const { manager } = createManager({}, {
      factory: makeFactory(),
      goalDelegationAdmission: { run: admissionRun },
    });

    const child = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "ordinary-delegate",
      toolName: "delegate",
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "Keep this prompt byte-for-byte",
      skills: [],
    });
    await child.result;

    expect(admissionRun).not.toHaveBeenCalled();
    expect(getUserMessageTexts(child.store.getState())).toEqual(["Keep this prompt byte-for-byte"]);
  });

  test("Goal delegation fails closed when runtime admission provides no snapshot", async () => {
    const parentId = crypto.randomUUID();
    const goalId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer", goalId });
    let childRunStarted = false;
    const { manager } = createManager({}, {
      factory: makeFactory(),
      listSessionFamilyToolBatchHitlIds: async () => [],
      childRunStarted: () => { childRunStarted = true; },
    });

    await expect(manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "missing-goal-admission",
      toolName: "delegate",
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "Must not run without Goal context",
      skills: [],
    })).rejects.toThrow(`Goal ${goalId} delegation requires its latest admitted snapshot`);
    expect(childRunStarted).toBe(false);
  });

  test("blocks new Goal child execution while any sibling has durable HITL", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, {
      agentName: "engineer",
      goalId: crypto.randomUUID(),
    });
    const { manager, sessionAgentManager } = createManager({}, {
      factory: makeFactory(),
      listSessionFamilyToolBatchHitlIds: async () => ["sibling-hitl"],
    });

    await expect(manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "blocked-delegate",
      toolName: "delegate",
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "must not start",
      skills: [],
      background: false,
      parentAbort: undefined,
    })).rejects.toMatchObject({ name: "SessionToolBatchActiveError", hitlIds: ["sibling-hitl"] });
    expect(sessionAgentManager.createChildAgent).not.toHaveBeenCalled();
  });

  test("rechecks Goal family HITL immediately before a new child starts", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, {
      agentName: "engineer",
      goalId: crypto.randomUUID(),
    });
    let checks = 0;
    const { manager } = createManager({}, {
      factory: makeFactory(),
      listSessionFamilyToolBatchHitlIds: async () => (++checks === 1 ? [] : ["raced-hitl"]),
    });

    await expect(manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "raced-delegate",
      toolName: "delegate",
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "must not start",
      skills: [],
      background: false,
      parentAbort: undefined,
    })).rejects.toMatchObject({ name: "SessionToolBatchActiveError", hitlIds: ["raced-hitl"] });
    expect(parentStore.getState().childSessionLinks).toEqual([]);
  });

  test("applies Goal phase admission to both new delegation and stale child resume", async () => {
    const goalId = crypto.randomUUID();
    const parentSessionId = crypto.randomUUID();
    const parentStore = storeManager.create(parentSessionId, workspaceRoot, {
      agentName: "engineer",
      goalId,
      sessionRole: "main",
    });
    const resumableChildId = crypto.randomUUID();
    storeManager.create(resumableChildId, workspaceRoot, {
      rootSessionId: parentSessionId,
      parentSessionId,
      agentName: "explore",
      goalId,
      title: "Delegated child",
    });
    const denied = new Error("phase denied");
    const run = mock(async () => { throw denied; });
    const { manager } = createManager({}, {
      factory: makeFactory(),
      goalDelegationAdmission: { run },
    });
    const base = {
      parentStore,
      parentSessionId,
      parentToolCallId: "call-1",
      toolName: "delegate",
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "inspect",
    } as const;

    await expect(manager.startChildExecution(workspaceRoot, { ...base, skills: [] })).rejects.toBe(denied);
    await expect(manager.resumeChildExecution(workspaceRoot, { ...base, sessionId: resumableChildId })).rejects.toBe(denied);
    expect(run).toHaveBeenCalledTimes(2);
  });

  test("legacy active workflow child prompt is omitted during Goal migration", async () => {
    const parentId = crypto.randomUUID();
    const goalId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer", goalId });
    const factory = makeFactory({
      getDefinition: mock((name: string) => {
        const base = makeFactory().getDefinition(name);
        if (name === "explore") return { ...base, tools: { tools: ["file_read"] } };
        return base;
      }),
    });
    const { manager } = createManager({}, {
      factory,
      goalDelegationAdmission: admitGoal(goalDelegationContext(goalId)),
      listSessionFamilyToolBatchHitlIds: async () => [],
    });

    const handle = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "tool-call",
      toolName: "delegate",
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "inspect files",
      skills: [],
      background: false,
      parentAbort: undefined,
    });
    await handle.result;

    const [childPrompt] = getUserMessageTexts(handle.store.getState());
    expect(childPrompt).toEndWith("</goal-delegation-context>\n\ninspect files");
    expect(handle.store.getState().goalId).toBe(goalId);
    expect(childPrompt).not.toContain("## Active Workflow");
  });

  test("active workflow child prompt is omitted for agents without workflow tools", async () => {
    const parentId = crypto.randomUUID();
    const goalId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer", goalId });
    const { manager } = createManager({}, {
      factory: makeFactory(),
      goalDelegationAdmission: admitGoal(goalDelegationContext(goalId)),
      listSessionFamilyToolBatchHitlIds: async () => [],
    });

    const handle = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "tool-call",
      toolName: "delegate",
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "inspect without workflow tools",
      skills: [],
      background: false,
      parentAbort: undefined,
    });
    await handle.result;

    const [childPrompt] = getUserMessageTexts(handle.store.getState());
    expect(childPrompt).toEndWith("</goal-delegation-context>\n\ninspect without workflow tools");
    expect(handle.store.getState().goalId).toBe(goalId);
    expect(childPrompt).not.toContain("## Active Workflow");
    expect(childPrompt).not.toContain("Omitted Workflow");
  });

  test("goal id is inherited for deeper delegate paths without legacy active workflow prompt", async () => {
    const rootSessionId = crypto.randomUUID();
    const parentId = crypto.randomUUID();
    const goalId = crypto.randomUUID();
    storeManager.create(rootSessionId, workspaceRoot, {
      agentName: "engineer",
      goalId,
    });
    const parentStore = storeManager.create(parentId, workspaceRoot, {
      rootSessionId,
      parentSessionId: rootSessionId,
      agentName: "explore",
      goalId,
    });
    const parentDefinition: AgentDefinition = {
      name: "explore",
      displayName: "Explore",
      promptProfileId: "explore",
      tools: { tools: ["delegate", "file_read"], delegateTargets: ["explore"] },
      hooks: { autoCompact: false, autoInjectReminder: false, todoStepReminder: false, todoQueryLoopContinuation: false, memoryExtraction: false, memoryConsolidation: false, titleGeneration: "disabled" },
      childPolicy: { maxDepth: 2, maxConcurrent: 1, timeoutMs: 0, abortCascade: true, terminalReminders: true },
      includeMemoryInPrompt: false,
      skills: [],
    };
    const targetDefinition: AgentDefinition = {
      ...parentDefinition,
      tools: { tools: ["file_read"] },
      childPolicy: undefined,
    };
    const factory = makeFactory({
      getDefinition: mock((name: string) => {
        if (name === "explore") return parentDefinition;
        throw new Error(`Unknown agent definition: ${name}`);
      }),
      resolveAllowedTools: mock((definition: AgentDefinition, depth: number): string[] => {
        if (definition === parentDefinition && depth >= 2) return [...targetDefinition.tools.tools];
        return [...definition.tools.tools];
      }),
      getDelegateTargetsFor: mock(() => ["explore"]),
    });
    const { manager } = createManager({}, {
      factory,
      goalDelegationAdmission: admitGoal(goalDelegationContext(goalId)),
      listSessionFamilyToolBatchHitlIds: async () => [],
    });

    const handle = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "grandchild-call",
      toolName: "delegate",
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "grandchild inspect",
      skills: [],
      background: false,
      parentAbort: undefined,
    });
    await handle.result;

    const [childPrompt] = getUserMessageTexts(handle.store.getState());
    expect(handle.store.getState().goalId).toBe(goalId);
    expect(childPrompt).toEndWith("</goal-delegation-context>\n\ngrandchild inspect");
    expect(childPrompt).not.toContain("## Active Workflow");
  });

  test("running-link write failure prevents child run and releases reserved slot", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
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
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "inspect",
      skills: [],
      background: false,
      parentAbort: undefined,
    })).rejects.toThrow("link write failed");

    expect(sessionAgentManager.createChildAgent).toHaveBeenCalledTimes(1);
    expect(childRunStarted).toBe(false);
  });

  test("depth limit is checked before child session creation", async () => {
    const rootId = crypto.randomUUID();
    const middleId = crypto.randomUUID();
    const parentId = crypto.randomUUID();
    storeManager.create(rootId, workspaceRoot, { agentName: "engineer" });
    storeManager.create(middleId, workspaceRoot, {
      rootSessionId: rootId,
      parentSessionId: rootId,
      agentName: "engineer",
      title: "Middle child",
    });
    const parentStore = storeManager.create(parentId, workspaceRoot, {
      rootSessionId: rootId,
      parentSessionId: middleId,
      agentName: "engineer",
      title: "Deep parent",
    });
    const factory = makeFactory();
    const { manager, sessionAgentManager } = createManager({}, { factory });

    await expect(manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "too-deep",
      toolName: "delegate",
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "inspect",
      skills: [],
      background: false,
      parentAbort: undefined,
    })).rejects.toThrow(DepthLimitError);

    expect(sessionAgentManager.createChildAgent).not.toHaveBeenCalled();
    expect(parentStore.getState().childSessionLinks).toEqual([]);
  });

  test("startChildExecution appends link and canonical prompt before model execution", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
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
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "inspect",
      skills: [],
      background: false,
      parentAbort: undefined,
    });
    await handle.result;

    expect(linkStatusesAtRunStart).toEqual(["running"]);
    expect(promptsAtRunStart).toEqual(["inspect"]);
    expect(childCanonicalMessage).toBe("inspect");
  });

  test("startChildExecution persists child identity before exposing its parent link or running it", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
    const flush = deferred<void>();
    let flushedChildSessionId: string | undefined;
    let promptsAtFlush: string[] = [];
    let childRunStarted = false;
    const { manager, sessionAgentManager } = createManager({}, {
      factory: makeFactory(),
      flushSessionStore: async (sessionId) => {
        flushedChildSessionId = sessionId;
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
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "inspect",
      skills: [],
      background: false,
      parentAbort: undefined,
    });
    await waitFor(() => flushedChildSessionId !== undefined);

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
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
    const childRun = deferred<MockAgentResult>();
    let linkWhileRunning: ToolChildSessionLink | undefined;
    let resultResolved = false;
    let childCanonicalMessage: string | undefined;
    const { manager } = createManager({}, {
      factory: makeFactory(),
      childRun: childRun.promise,
      childCanonicalMessage: (message) => { childCanonicalMessage = message; },
      childRunStarted: () => {
        linkWhileRunning = parentStore.getState().childSessionLinks.at(-1);
      },
    });

    const handle = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "sync-tool-call",
      toolName: "delegate",
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "inspect",
      skills: [],
      background: false,
      parentAbort: undefined,
    });
    handle.result.then(() => { resultResolved = true; });
    await Promise.resolve();

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

    expect(result).toEqual({ text: "live child done", steps: 0, status: "completed" });
    expect(resultResolved).toBe(true);
    expect(parentStore.getState().childSessionLinks.at(-1)).toMatchObject({
      childSessionId: handle.sessionId,
      status: "completed",
    });
  });

  test("child HITL pause remains non-terminal and emits no failed reminder", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
    let childSessionId = "";
    const { manager } = createManager({}, {
      factory: makeFactory(),
      childRunStarted: () => {
        childSessionId = parentStore.getState().childSessionLinks.at(-1)?.childSessionId ?? "";
        const childStore = storeManager.get(childSessionId, workspaceRoot);
        childStore?.getState().append({
          type: "execution-end",
          status: "waiting_for_human",
        });
      },
    });

    const handle = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "hitl-child",
      toolName: "delegate",
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "wait for approval",
      skills: [],
      background: true,
      parentAbort: undefined,
    });
    await handle.result;

    expect(childSessionId).toBe(handle.sessionId);
    expect(parentStore.getState().childSessionLinks.at(-1)).toMatchObject({
      childSessionId,
      status: "waiting_for_human",
    });
    expect(parentStore.getState().reminders).toEqual([]);
  });



  test("startChildExecution marks failed and timed-out children with terminal link statuses", async () => {
    const failedParentId = crypto.randomUUID();
    const failedParentStore = storeManager.create(failedParentId, workspaceRoot, { agentName: "engineer" });
    const failedRun = Promise.reject(new Error("child exploded"));
    // The child snapshot durability barrier adds an async boundary before run().
    void failedRun.catch(() => undefined);
    const failed = createManager({}, { factory: makeFactory(), childRun: failedRun });

    const failedHandle = await failed.manager.startChildExecution(workspaceRoot, {
      parentStore: failedParentStore,
      parentSessionId: failedParentId,
      parentToolCallId: "failed-call",
      toolName: "delegate",
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "inspect",
      skills: [],
      background: false,
      parentAbort: undefined,
    });
    await failedHandle.result;
    expect(failedParentStore.getState().childSessionLinks.at(-1)).toMatchObject({ status: "failed", error: "child exploded" });

    const timedParentId = crypto.randomUUID();
    const timedParentStore = storeManager.create(timedParentId, workspaceRoot, { agentName: "engineer" });
    const timed = createManager({}, {
      factory: makeFactory({
        getDefinition: mock((name: string) => {
          const base = makeFactory().getDefinition(name);
          if (name === "engineer") return { ...base, childPolicy: { ...base.childPolicy!, timeoutMs: 1 } };
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
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "inspect",
      skills: [],
      background: false,
      parentAbort: undefined,
    });
    await timedHandle.result;
    expect(timedParentStore.getState().childSessionLinks.at(-1)).toMatchObject({ status: "timed_out" });
  });

  test("startChildExecution enforces delegate targets and child concurrency", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
    const factory = makeFactory();
    const childRun = new Promise<AgentResult>(() => undefined);
    const { manager } = createManager({}, { factory, childRun });

    await expect(manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "bad-target",
      toolName: "delegate",
      targetAgentName: "writer",
      title: "Delegated child",
      prompt: "inspect",
      skills: [],
      background: false,
      parentAbort: undefined,
    })).rejects.toThrow(DelegateTargetNotAllowedError);

    const first = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "first",
      toolName: "delegate",
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "inspect",
      skills: [],
      background: true,
      parentAbort: undefined,
    });

    await expect(manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "second",
      toolName: "delegate",
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "inspect",
      skills: [],
      background: true,
      parentAbort: undefined,
    })).rejects.toThrow(ConcurrentLimitError);
    first.abort();
    await first.result;
  });

  test("child abort race marks link cancelling then cancelled and releases slot", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
    const childRun = new Promise<AgentResult>(() => undefined);
    const { manager, sessionAgentManager } = createManager({}, { factory: makeFactory(), childRun });

    const first = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "first",
      toolName: "delegate",
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "inspect",
      skills: [],
      background: true,
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
    await writeSessionFile({ sessionId: rootId });
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
    const rootStore = storeManager.create(rootId, workspaceRoot, { agentName: "engineer" });
    await storeManager.flushSession(rootId, workspaceRoot);
    const preflightEntered = deferred<void>();
    const releasePreflight = deferred<void>();
    const { manager } = createManager({}, {
      factory: makeFactory(),
      deletionLifecycle: {
        assertDeletable: async () => {
          preflightEntered.resolve(undefined);
          await releasePreflight.promise;
        },
        prepareForDeletion: async () => undefined,
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
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "race deletion",
      skills: [],
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
    storeManager.create(rootId, workspaceRoot, { agentName: "engineer" });
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

  test("delete performs lifecycle preparation after an in-flight execution quiesces", async () => {
    const rootId = crypto.randomUUID();
    const store = storeManager.create(rootId, workspaceRoot, { agentName: "engineer" });
    await storeManager.flushSession(rootId, workspaceRoot);
    let runStarted = false;
    let ownerCreatedDuringAbort = false;
    const agent: Agent = {
      store,
      cwd: store.getState().cwd,
      classifyCommand: mock((_input: string) => null),
      executeCommand: mock(async (_command: AgentCommand): Promise<AgentCommandResult> => ({ kind: "handled" })),
      run: mock(async (_binding: ExecutionModelBinding, options?: AgentRunOptions) => {
        runStarted = true;
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
    let preflightCount = 0;
    let preparationCount = 0;
    const { manager } = createManager({ [rootId]: agent as MockAgent }, {
      deletionLifecycle: {
        assertDeletable: async () => {
          preflightCount += 1;
        },
        prepareForDeletion: async () => {
          preparationCount += 1;
          if (ownerCreatedDuringAbort) {
            throw new SessionDeleteOwnerConflictError([{
              sessionId: rootId,
              ownerType: "goal",
              ownerId: rootId,
            }]);
          }
        },
      },
    });
    await manager.startCheckedExecution({ slug: "project", workspaceRoot, sessionId: rootId, input: { kind: "direct", text: "create owner while stopping" } });
    await waitFor(() => runStarted);

    await expect(manager.deleteSession(workspaceRoot, rootId)).rejects.toMatchObject({
      name: "SessionDeleteOwnerConflictError",
      sessionIds: [rootId],
    });

    expect(preflightCount).toBe(1);
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

  test("restart reconciliation marks persisted active executions and links interrupted", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const now = Date.now();
    await writeSessionFile({
      sessionId: rootId,
      executions: [{ id: "execution-running", startedAt: now - 1000, status: "running", binding: TEST_BINDING_SUMMARY, origin: "user_message" }],
      childSessionLinks: [{
        parentSessionId: rootId,
        parentToolCallId: "tool-child",
        toolName: "delegate",
        childSessionId: childId,
        childAgentName: "explore",
        title: "Delegated child",
        depth: 1,
        background: true,
        status: "cancelling",
        createdAt: now - 900,
      }],
    });
    const restarted = new SessionStoreManager({ logger: silentLogger });

    const store = await restarted.getOrLoad(rootId, workspaceRoot);
    const file = await restarted.getSessionFile(workspaceRoot, rootId);

    expect(store.getState().executions.at(-1)).toMatchObject({ status: "interrupted", error: "Execution interrupted by restart" });
    expect(store.getState().childSessionLinks.at(-1)).toMatchObject({ status: "interrupted", error: "Child execution interrupted by restart" });
    expect(file.executions.at(-1)?.status).toBe("interrupted");
    expect(file.childSessionLinks.at(-1)?.status).toBe("interrupted");
  });

  test("abort timeout throws SessionDeleteConflictError and preserves target files", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    await writeSessionFile({ sessionId: rootId });
    await writeSessionFile({ sessionId: childId, rootSessionId: rootId, parentSessionId: rootId });
    const childRun = mock(async (): Promise<AgentResult> => await new Promise(() => undefined));
    const childAgent = {
      store: storeManager.create(childId, workspaceRoot, {
        rootSessionId: rootId,
        parentSessionId: rootId, agentName: "engineer"
      }),
      cwd: workspaceRoot,
      classifyCommand: mock((_input: string) => null),
      executeCommand: mock(async (_command: AgentCommand): Promise<AgentCommandResult> => ({ kind: "handled" })),
      run: childRun,
      dispose: mock(() => undefined),
    } as unknown as MockAgent;
    const { manager, sessionAgentManager } = createManager({ [childId]: childAgent });
    const execution = await manager.startCheckedExecution({ slug: "project", workspaceRoot, sessionId: childId, input: { kind: "direct", text: "child" } });
    await waitFor(() => childRun.mock.calls.length === 1);
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], timeout?: number, ...args: unknown[]) => {
      if (timeout === 10000 && typeof handler === "function") {
        queueMicrotask(() => (handler as (...values: unknown[]) => void)(...args));
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return originalSetTimeout(handler, timeout, ...(args as []));
    }) as typeof setTimeout;

    try {
      let caught: unknown;
      try {
        await manager.deleteSession(workspaceRoot, childId);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SessionDeleteConflictError);
      expect(caught).toMatchObject({ name: "SessionDeleteConflictError", sessionIds: [childId] });
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    expect(await Bun.file(getSessionPath(workspaceRoot, childId)).exists()).toBe(true);
    expect(sessionAgentManager.dispose).not.toHaveBeenCalled();
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
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
    const factory = makeFactory();
    const { manager } = createManager({}, { factory });

    const first = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "initial-tool-call",
      toolName: "delegate",
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "first round",
      skills: [],
      background: false,
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
      toolName: "delegate",
      sessionId: childSessionId,
      prompt: "second round",
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

  test("resumeChildExecution prepends the newly admitted Goal snapshot", async () => {
    const parentId = crypto.randomUUID();
    const goalId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer", goalId });
    await storeManager.flushSession(parentId, workspaceRoot);
    let context = goalDelegationContext(goalId, { reviewGeneration: 1 });
    const messages: string[] = [];
    const { manager } = createManager({}, {
      factory: makeFactory(),
      goalDelegationAdmission: {
        run: async (_input, action) => await action(context),
      },
      listSessionFamilyToolBatchHitlIds: async () => [],
      childCanonicalMessage: (value) => { messages.push(value); },
    });

    const first = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "initial-goal-delegate",
      toolName: "delegate",
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "Initial work",
      skills: [],
    });
    await first.result;

    context = goalDelegationContext(goalId, {
      attempt: 2,
      reviewGeneration: 2,
      lastFailureSummary: "Reviewer requested another assertion",
    });
    const resumed = await manager.resumeChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "resume-goal-delegate",
      toolName: "delegate",
      sessionId: first.sessionId,
      prompt: "Address the review",
    });
    await resumed.result;

    expect(messages).toHaveLength(2);
    expect(messages[1]).toContain('"attempt": 2');
    expect(messages[1]).toContain('"reviewGeneration": 2');
    expect(messages[1]).toContain('"lastFailureSummary": "Reviewer requested another assertion"');
    expect(messages[1]).toEndWith("</goal-delegation-context>\n\nAddress the review");
  });

  test("blocks cwd transitions for active descendants and never resumes an old child across checkouts", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
    const childRun = deferred<MockAgentResult>();
    let childRunCount = 0;
    const { manager } = createManager({}, {
      factory: makeFactory(),
      childRun: childRun.promise,
      childRunStarted: () => { childRunCount += 1; },
    });

    const child = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "background-child",
      toolName: "delegate",
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "keep working in the original checkout",
      skills: [],
      background: true,
      parentAbort: undefined,
    });
    await waitFor(() => childRunCount === 1);

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
      toolName: "delegate",
      sessionId: child.sessionId,
      prompt: "write in the new checkout",
      parentAbort: undefined,
    })).rejects.toThrow(ChildSessionCwdMismatchError);

    expect(childRunCount).toBe(1);
    expect(child.store.getState().messages).toHaveLength(childMessagesBeforeResume);
    expect(manager.getExecution(workspaceRoot, child.sessionId)).toBeUndefined();
  });

  test("serializes child launches and resumes against the full cwd transition lease", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
    const skillResolution = deferred<readonly []>();
    let skillResolutionStarted = 0;
    let childRunCount = 0;
    const factory = makeFactory({
      resolveDelegatedSkillNames: mock(async () => {
        skillResolutionStarted += 1;
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
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "launch while skills resolve",
      skills: [],
      background: false,
      parentAbort: undefined,
    });
    await waitFor(() => skillResolutionStarted === 1);

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
        targetAgentName: "explore",
      title: "Delegated child",
        prompt: "must not start",
        skills: [],
        background: false,
        parentAbort: undefined,
      })).rejects.toThrow(SessionCwdTransitionInProgressError);

      await expect(manager.resumeChildExecution(workspaceRoot, {
        parentStore,
        parentSessionId: parentId,
        parentToolCallId: "resume-during-transition",
        toolName: "delegate",
        sessionId: child.sessionId,
        prompt: "must not resume",
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
      toolName: "delegate",
      sessionId: child.sessionId,
      prompt: "resume after lease release",
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
    storeManager.create(sessionId, workspaceRoot, { agentName: "engineer" });
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

  test("cold-loads a Session and rejects messages while its durable tool batch remains blocked", async () => {
    const sessionId = crypto.randomUUID();
    await writeSessionFile({ sessionId, toolBatches: [blockedToolBatch("hitl-pending")] });
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

  test("checked Goal start rejects a blocked sibling tool batch at the final family barrier", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const siblingHitlId = crypto.randomUUID();
    await writeSessionFile({ sessionId: rootId, goalId: crypto.randomUUID() });
    await writeSessionFile({
      sessionId: childId,
      rootSessionId: rootId,
      parentSessionId: rootId,
      toolBatches: [blockedToolBatch(siblingHitlId)],
    });
    const coldStores = new SessionStoreManager({ logger: silentLogger });
    const { manager } = createManager({}, { storeManager: coldStores });

    await expect(manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId: rootId,
      input: { kind: "direct", text: "must not bypass child HITL" },
    })).rejects.toMatchObject({
      name: "SessionToolBatchActiveError",
      sessionId: rootId,
      hitlIds: [siblingHitlId],
    });
    expect(manager.getSessionFamilyActivity(workspaceRoot, rootId)).toBe("idle");
  });

  test("fails closed when Session cwd changes during asynchronous scope validation", async () => {
    const sessionId = crypto.randomUUID();
    const store = storeManager.create(sessionId, workspaceRoot, { agentName: "engineer" });
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
    storeManager.create(sessionId, workspaceRoot, { agentName: "engineer" });
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
    const store = storeManager.create(sessionId, workspaceRoot, { agentName: "engineer" });
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
      goalId: crypto.randomUUID(),
      rootSessionId: "different-root",
      parentSessionId: "different-parent",
      sessionRole: "build",
    });
    allowValidation.resolve();

    await expect(pending).rejects.toMatchObject({
      name: "SessionExecutionScopeConflictError",
      code: "SESSION_EXECUTION_SCOPE_CHANGED",
      sessionId,
      details: {
        changedFields: ["goalId", "rootSessionId", "parentSessionId", "sessionRole"],
      },
    });
    expect(manager.getSessionFamilyActivity(workspaceRoot, sessionId)).toBe("idle");
  });


  test("re-checks the synchronous cwd-transition guard after cold root loading", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const rootStore = storeManager.create(rootId, workspaceRoot, { agentName: "engineer" });
    storeManager.create(childId, workspaceRoot, {
      rootSessionId: rootId,
      parentSessionId: rootId,
      agentName: "explore",
    });
    const rootLoad = deferred<typeof rootStore>();
    let rootLoadStarted = false;
    const callbacks = storeCallbacks(storeManager);
    const manager = new SessionExecutionManager({
      sessionAgentManager: createFakeManager({}, { factory: makeFactory() }),
      modelRuntime: makeModelRuntime(),
      modelSelectionResolver: new ModelSelectionResolver(),
      ...callbacks,
      sessionInputService: new SessionInputService(storeManager),
      loadSessionStore: async (sessionId, root) => {
        if (sessionId === rootId) {
          rootLoadStarted = true;
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
    await waitFor(() => rootLoadStarted);
    const releaseTransition = manager.acquireSessionCwdTransition(workspaceRoot, rootId);
    rootLoad.resolve(rootStore);

    await expect(pendingMessage).rejects.toThrow(SessionCwdTransitionInProgressError);
    expect(manager.getExecution(workspaceRoot, childId)).toBeUndefined();
    releaseTransition();
  });

  test("resumeChildExecution exposes a running link for the current resume tool call", async () => {
    const parentId = crypto.randomUUID();
    const childSessionId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
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
        childAgentName: "explore",
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
      toolName: "delegate",
      sessionId: childSessionId,
      prompt: "second round",
      parentAbort: undefined,
    });

    const runningLink = parentStore.getState().childSessionLinks.find((link) => link.parentToolCallId === "resume-tool-call");
    expect(runningLink).toMatchObject({
      childSessionId,
      parentToolCallId: "resume-tool-call",
      status: "running",
    });
    expect(runningLink?.endedAt).toBeUndefined();
    expect(runningLink?.durationMs).toBeUndefined();

    resumedRun.resolve({ text: "resumed done", steps: 1 });
    await resumed.result;
    expect(parentStore.getState().childSessionLinks.find((link) => link.parentToolCallId === "resume-tool-call")).toMatchObject({
      childSessionId,
      parentToolCallId: "resume-tool-call",
      status: "completed",
    });
  });

  test("resumeChildExecution uses the canonical child title instead of a stale link title", async () => {
    const parentId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
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
      toolName: "delegate",
      sessionId: childId,
      prompt: "resume",
    });
    await resumed.result;

    expect(parentStore.getState().childSessionLinks.find((link) => link.parentToolCallId === "canonical-title-resume"))
      .toMatchObject({ title: "Canonical title", status: "completed" });
  });

  test("resumeChildExecution rejects a child without a canonical title", async () => {
    const parentId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
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
      toolName: "delegate",
      sessionId: childId,
      prompt: "resume",
    })).rejects.toThrow(`Child Session "${childId}" has no canonical title`);
    expect(parentStore.getState().childSessionLinks).toEqual([]);
  });

  test("resumeChildExecution rejects a child whose canonical root differs from its parent", async () => {
    const parentId = crypto.randomUUID();
    const foreignRootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
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
      toolName: "delegate",
      sessionId: childId,
      prompt: "resume",
    })).rejects.toThrow(`belongs to root "${foreignRootId}", not "${parentId}"`);
    expect(parentStore.getState().childSessionLinks).toEqual([]);
  });

  test("resumeChildExecution re-enforces canonical maxDepth", async () => {
    const rootId = crypto.randomUUID();
    const middleId = crypto.randomUUID();
    const parentId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    storeManager.create(rootId, workspaceRoot, { agentName: "engineer" });
    storeManager.create(middleId, workspaceRoot, {
      rootSessionId: rootId,
      parentSessionId: rootId,
      agentName: "engineer",
      title: "Middle",
    });
    const parentStore = storeManager.create(parentId, workspaceRoot, {
      rootSessionId: rootId,
      parentSessionId: middleId,
      agentName: "engineer",
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
      toolName: "delegate",
      sessionId: childId,
      prompt: "resume",
    })).rejects.toThrow(DepthLimitError);
  });

  test("resumeChildExecution re-enforces maxConcurrent", async () => {
    const parentId = crypto.randomUUID();
    const firstChildId = crypto.randomUUID();
    const secondChildId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
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
      toolName: "delegate",
      sessionId: firstChildId,
      prompt: "resume",
    });
    await expect(manager.resumeChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "second-resume",
      toolName: "delegate",
      sessionId: secondChildId,
      prompt: "resume",
    })).rejects.toThrow(ConcurrentLimitError);
    firstRun.resolve({ text: "done", steps: 1 });
    await first.result;
  });

  test("resumeChildExecution reapplies timeout and abortCascade policy", async () => {
    const parentId = crypto.randomUUID();
    const timedChildId = crypto.randomUUID();
    const uncascadedChildId = crypto.randomUUID();
    const cascadedChildId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
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
      factory: makeFactoryWithChildPolicy({ timeoutMs: 1 }),
    }).manager;
    const timed = await timedManager.resumeChildExecution(workspaceRoot, {
      parentStore, parentSessionId: parentId, parentToolCallId: "timed-resume", toolName: "delegate",
      sessionId: timedChildId, prompt: "resume",
    });
    expect((await timed.result).status).toBe("timed_out");

    const uncascadedRun = deferred<MockAgentResult>();
    const uncascadedAgent = new MockAgent(uncascadedChildId, uncascadedRun.promise, workspaceRoot);
    uncascadedAgent.store.setState(uncascadedStore.getState());
    const uncascadedManager = createManager({ [uncascadedChildId]: uncascadedAgent }, {
      factory: makeFactoryWithChildPolicy({ abortCascade: false }),
    }).manager;
    const parentAbort = new AbortController();
    const uncascaded = await uncascadedManager.resumeChildExecution(workspaceRoot, {
      parentStore, parentSessionId: parentId, parentToolCallId: "uncascaded-resume", toolName: "delegate",
      sessionId: uncascadedChildId, prompt: "resume", parentAbort: parentAbort.signal,
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
      parentStore, parentSessionId: parentId, parentToolCallId: "cascaded-resume", toolName: "delegate",
      sessionId: cascadedChildId, prompt: "resume", parentAbort: cascadingAbort.signal,
    });
    cascadingAbort.abort();
    expect((await cascaded.result).status).toBe("cancelled");
  });

  test("rechecks Goal family HITL immediately before a child resume starts", async () => {
    const parentId = crypto.randomUUID();
    const childSessionId = crypto.randomUUID();
    const goalId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer", goalId });
    const childStore = storeManager.create(childSessionId, workspaceRoot, {
      rootSessionId: parentId,
      parentSessionId: parentId,
      agentName: "explore",
      goalId,
      title: "Delegated child",
    });
    parentStore.getState().append({
      type: "tool-child-session-link",
      link: {
        parentSessionId: parentId,
        parentToolCallId: "initial-call",
        toolName: "delegate",
        childSessionId,
        childAgentName: "explore",
        title: "Delegated child",
        depth: 1,
        background: false,
        status: "completed",
        createdAt: 1,
      },
    });
    await storeManager.flushSession(parentId, workspaceRoot);
    await storeManager.flushSession(childSessionId, workspaceRoot);
    const childAgent = new MockAgent(childSessionId, Promise.resolve({ text: "must not run", steps: 1 }), workspaceRoot);
    childAgent.store.setState(childStore.getState());
    let checks = 0;
    const { manager } = createManager({ [childSessionId]: childAgent }, {
      factory: makeFactory(),
      executionScopeValidator: allowExecutionScope,
      listSessionFamilyToolBatchHitlIds: async () => (++checks === 1 ? [] : ["raced-resume-hitl"]),
    });

    await expect(manager.resumeChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "resume-call",
      toolName: "delegate",
      sessionId: childSessionId,
      prompt: "must not resume",
      parentAbort: undefined,
    })).rejects.toMatchObject({ name: "SessionToolBatchActiveError", hitlIds: ["raced-resume-hitl"] });
    expect(parentStore.getState().childSessionLinks.at(-1)).toMatchObject({ status: "completed" });
    expect(childAgent.runMock).not.toHaveBeenCalled();
  });

  test("resumeChildExecution supports background links and terminal reminders", async () => {
    const parentId = crypto.randomUUID();
    const childSessionId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
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
        childAgentName: "explore",
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
      toolName: "delegate",
      sessionId: childSessionId,
      prompt: "second round",
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
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
    const childRun = deferred<MockAgentResult>();
    const { manager } = createManager({}, { factory: makeFactory(), childRun: childRun.promise });

    const first = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "running-tool-call",
      toolName: "delegate",
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "first round",
      skills: [],
      background: false,
      parentAbort: undefined,
    });

    await expect(manager.resumeChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "running-tool-call",
      toolName: "delegate",
      sessionId: first.sessionId,
      prompt: "second round",
      parentAbort: undefined,
    })).rejects.toThrow(AgentRunningError);

    first.abort();
    childRun.resolve({ text: "done", steps: 1 });
    await first.result;
  });

  test("resumeChildExecution rejects a child with an unresolved durable HITL blocker", async () => {
    const parentId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
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
      toolName: "delegate",
      sessionId: childId,
      prompt: "must wait for HITL",
      parentAbort: undefined,
    })).rejects.toThrow(SessionToolBatchActiveError);

    expect(parentStore.getState().childSessionLinks).toHaveLength(linksBefore);
    expect(manager.getExecution(workspaceRoot, childId)).toBeUndefined();
  });

  test("resumeChildExecution on non-existent session throws ChildSessionNotFoundError", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
    const { manager } = createManager({}, { factory: makeFactory() });

    await expect(manager.resumeChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "missing-tool-call",
      toolName: "delegate",
      sessionId: crypto.randomUUID(),
      prompt: "resume",
      parentAbort: undefined,
    })).rejects.toThrow(ChildSessionNotFoundError);
  });

  test("resumeChildExecution with wrong parent throws ChildSessionParentMismatchError", async () => {
    const parentId = crypto.randomUUID();
    const otherParentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
    const otherParentStore = storeManager.create(otherParentId, workspaceRoot, { agentName: "engineer" });
    const { manager } = createManager({}, { factory: makeFactory() });

    const first = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "parent-tool-call",
      toolName: "delegate",
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "first round",
      skills: [],
      background: false,
      parentAbort: undefined,
    });
    await first.result;

    await expect(manager.resumeChildExecution(workspaceRoot, {
      parentStore: otherParentStore,
      parentSessionId: otherParentId,
      parentToolCallId: "parent-tool-call",
      toolName: "delegate",
      sessionId: first.sessionId,
      prompt: "second round",
      parentAbort: undefined,
    })).rejects.toThrow(ChildSessionParentMismatchError);
  });

  test("cancelChildSession on running descendant aborts, marks link cancelled, appends reminder", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
    const childRun = deferred<MockAgentResult>();
    const { manager } = createManager({}, { factory: makeFactory(), childRun: childRun.promise });

    const child = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "cancel-tool-call",
      toolName: "delegate",
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "running",
      skills: [],
      background: true,
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
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
    storeManager.create(strangerId, workspaceRoot, { agentName: "engineer" });
    const { manager } = createManager({}, { factory: makeFactory() });

    expect(() => manager.cancelChildSession(workspaceRoot, parentId, strangerId)).toThrow(ChildSessionNotDescendantError);
  });

  test("cancelChildSession on non-running session returns false", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
    const { manager } = createManager({}, { factory: makeFactory() });

    const child = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "completed-tool-call",
      toolName: "delegate",
      targetAgentName: "explore",
      title: "Delegated child",
      prompt: "done",
      skills: [],
      background: false,
      parentAbort: undefined,
    });
    await child.result;

    expect(manager.cancelChildSession(workspaceRoot, parentId, child.sessionId)).toBe(false);
  });
});
