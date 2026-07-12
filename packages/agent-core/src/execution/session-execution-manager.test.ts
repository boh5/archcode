import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createEmptySessionStats } from "@archcode/protocol";
import type { Agent, AgentResult, AgentRunOptions } from "../agents/types";
import { AgentRunningError, ConcurrentLimitError, ConcurrentSessionLimitError, DelegateTargetNotAllowedError, DepthLimitError, ChildSessionNotFoundError, ChildSessionAgentMismatchError, ChildSessionParentMismatchError, ChildSessionNotDescendantError, ChildSessionCwdMismatchError, ChildSessionLoopScopeMismatchError, SessionCwdTransitionConflictError, SessionCwdTransitionInProgressError, SessionHitlBlockedError, SessionHitlCancelOnlyLeaseError, SessionHitlResumeConflictError, SessionHitlResumeInProgressError, SessionHitlResumeLeaseExpiredError } from "../agents/errors";
import type { SessionAgentManager } from "../agents/session-agent-manager";
import type { SlashCommandResult } from "../commands/types";
import { NotRootSessionError, SessionDeleteConflictError } from "../store/errors";
import { SessionDeleteInProgressError, SessionDeleteOwnerConflictError } from "./session-deletion";
import { SessionFamilyActiveError, SessionFamilyIdentityUnavailableError, SessionFamilyStopConflictError, SessionFamilyStopInProgressError } from "./session-family-control";
import type { SessionFile } from "../store/helpers";
import { SessionStoreManager } from "../store/session-store-manager";
import { getSessionDir, getSessionPath } from "../store/sessions-dir";
import { SessionExecutionManager } from "./session-execution-manager";
import { SessionExecutionScopeConflictError } from "./session-execution-scope-validator";
import { SessionWorkspaceClosingError } from "./session-workspace-control";
import { silentLogger } from "../logger";
import type { SessionStoreState, ToolChildSessionLink } from "../store/types";
import type { AgentFactory } from "../agents/factory";
import type { AgentDefinition } from "../agents/factory-types";
import type { ToolExecutionOrigin } from "../tools/types";
import { createEmptyCompressionState } from "../compression";

const workspaceRoot = join(import.meta.dir, "__test_tmp__", "session-execution-manager-workspace");
const defaultAgentWorkspaceRoot = workspaceRoot;
const storeManager = new SessionStoreManager({ logger: silentLogger });
const LOOP_ORIGIN: ToolExecutionOrigin = {
  kind: "loop",
  loopId: "loop-child-origin",
  runId: "run-child-origin",
  trigger: "manual",
  approvalPolicy: "interactive",
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

function reserveActivatedHitlResume(
  manager: SessionExecutionManager,
  sessionId: string,
  rootSessionId = sessionId,
  options?: Parameters<SessionExecutionManager["reserveSessionHitlResume"]>[3],
) {
  const lease = manager.reserveSessionHitlResume(workspaceRoot, sessionId, rootSessionId, options);
  lease.activate();
  return lease;
}

class MockAgent implements Agent {
  readonly store;
  readonly cwd: string;
  readonly runMock = mock(async (_message: string, options?: AgentRunOptions | AbortSignal): Promise<AgentResult> => {
    const signal = options instanceof AbortSignal ? options : options?.abort;
    const result = await withAbort(this.result, signal);
    this.store.getState().append({ type: "text-start" });
    this.store.getState().append({ type: "text-delta", text: result.text });
    this.store.getState().append({ type: "text-end" });
    return result;
  });
  dispatchCommandMock?: (name: string, args?: string) => Promise<SlashCommandResult>;

  constructor(
    readonly sessionId: string,
    readonly result: Promise<AgentResult>,
    readonly workspaceRoot: string = defaultAgentWorkspaceRoot,
  ) {
    this.store = storeManager.create(sessionId, workspaceRoot, { agentName: "engineer" });
    this.cwd = this.store.getState().cwd;
  }

  run(userMessage: string, abort?: AbortSignal): Promise<AgentResult>;
  run(userMessage: string, options?: AgentRunOptions): Promise<AgentResult>;
  run(userMessage: string, options?: AgentRunOptions | AbortSignal): Promise<AgentResult> {
    return this.runMock(userMessage, options);
  }

  async dispatchCommand(name: string, args?: string): Promise<SlashCommandResult> {
    if (!this.dispatchCommandMock) return { success: false, message: "missing" };
    return await this.dispatchCommandMock(name, args);
  }

  dispose(): void {}
}

interface FakeManagerOptions {
  maxConcurrentSessions?: number;
  storeManager?: SessionStoreManager;
  factory?: AgentFactory;
  childRun?: Promise<AgentResult>;
  childRunStarted?: () => void;
  childRunMessage?: (message: string) => void;
  childRunOptions?: (options: AgentRunOptions | AbortSignal | undefined) => void;
  getAgent?: (sessionId: string) => Agent;
  onReleaseAgent?: (sessionId: string) => void;
  executionScopeValidator?: ConstructorParameters<typeof SessionExecutionManager>[0]["executionScopeValidator"];
  goalDelegationAdmission?: ConstructorParameters<typeof SessionExecutionManager>[0]["goalDelegationAdmission"];
  deletionPreflight?: ConstructorParameters<typeof SessionExecutionManager>[0]["deletionPreflight"];
  flushSessionStore?: ConstructorParameters<typeof SessionExecutionManager>[0]["flushSessionStore"];
  listSessionFamilyBlockedHitlIds?: ConstructorParameters<typeof SessionExecutionManager>[0]["listSessionFamilyBlockedHitlIds"];
  sessionFamilyStopTimeoutMs?: number;
}

const allowExecutionScope = { validate: async () => undefined };

type SessionExecutionManagerConfigForTest = ConstructorParameters<typeof SessionExecutionManager>[0];

function storeCallbacks(manager: SessionStoreManager): Pick<
  SessionExecutionManagerConfigForTest,
  "createSessionStore" | "flushSessionStore" | "getSessionStore" | "loadSessionStore" | "deleteSessionStore" | "resolveRootSessionId" | "buildSessionTree" | "listSessionFamilyBlockedHitlIds"
> {
  return {
    createSessionStore: (sessionId, root, createOptions) => manager.create(sessionId, root, createOptions),
    flushSessionStore: (sessionId, root) => manager.flushSession(sessionId, root),
    getSessionStore: (sessionId, root) => manager.get(sessionId, root),
    loadSessionStore: (sessionId, root) => manager.getOrLoad(sessionId, root),
    deleteSessionStore: (sessionId, root, deleteOptions) => manager.delete(sessionId, root, deleteOptions),
    resolveRootSessionId: (sessionId, root) => manager.resolveRootSessionId(sessionId, root),
    buildSessionTree: (root, rootSessionId) => manager.buildSessionTree(root, rootSessionId),
    listSessionFamilyBlockedHitlIds: (root, rootSessionId) => manager.listSessionFamilyBlockedHitlIds(root, rootSessionId),
  };
}

function createFakeManager(agents: Record<string, MockAgent>, options: FakeManagerOptions = {}): SessionAgentManager {
  const activeByWorkspace = new Map<string, Set<string>>();
  const max = options.maxConcurrentSessions ?? 4;
  return {
    getOrCreate: mock(async (_root: string, sessionId: string) => options.getAgent?.(sessionId) ?? agents[sessionId]!),
    get: mock((_root: string, sessionId: string) => agents[sessionId]),
    dispatchCommand: mock(async (_root: string, sessionId: string, name: string, args?: string) => {
      const agent = agents[sessionId];
      return await agent?.dispatchCommand(name, args) ?? null;
    }),
    acquireSlot: mock((root: string, sessionId: string) => {
      const active = activeByWorkspace.get(root) ?? new Set<string>();
      if (!active.has(sessionId) && active.size >= max) {
        throw new ConcurrentSessionLimitError(root, active.size, max);
      }
      active.add(sessionId);
      activeByWorkspace.set(root, active);
    }),
    releaseSlot: mock((root: string, sessionId: string) => {
      const active = activeByWorkspace.get(root);
      active?.delete(sessionId);
    }),
    getFactory: mock(() => options.factory),
    createChildAgent: mock((input: { workspaceRoot: string; sessionId: string; store: MockAgent["store"] }) => {
      const childAgent = {
        store: input.store,
        run: mock(async (message: string, runOptions?: AgentRunOptions | AbortSignal): Promise<AgentResult> => {
          const signal = runOptions instanceof AbortSignal ? runOptions : runOptions?.abort;
          options.childRunMessage?.(message);
          options.childRunOptions?.(runOptions);
          options.childRunStarted?.();
          signal?.throwIfAborted();
          const result = options.childRun
            ? await withAbort(options.childRun, signal)
            : { text: "child result", steps: 1 };
          input.store.getState().append({ type: "text-start" });
          input.store.getState().append({ type: "text-delta", text: result.text });
          input.store.getState().append({ type: "text-end" });
          return result;
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
    hooks: { autoCompact: false, autoInjectReminder: false, todoStepReminder: false, todoQueryLoopContinuation: false, transcriptSave: false, memoryExtraction: false, memoryConsolidation: false, titleGeneration: "disabled" },
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
    resolveDelegatedSkills: mock(async () => []),
    ...overrides,
  } as AgentFactory;
}

function createManager(agents: Record<string, MockAgent>, options: FakeManagerOptions = {}) {
  const sessionAgentManager = createFakeManager(agents, options);
  const executionStoreManager = options.storeManager ?? storeManager;
  const trackSession = mock(() => undefined);
  const untrackSession = mock(() => undefined);
  const manager = new SessionExecutionManager({
    sessionAgentManager,
    ...storeCallbacks(executionStoreManager),
    ...(options.flushSessionStore === undefined ? {} : { flushSessionStore: options.flushSessionStore }),
    ...(options.listSessionFamilyBlockedHitlIds === undefined ? {} : {
      listSessionFamilyBlockedHitlIds: options.listSessionFamilyBlockedHitlIds,
    }),
    trackSession,
    untrackSession,
    executionScopeValidator: options.executionScopeValidator ?? allowExecutionScope,
    ...(options.goalDelegationAdmission === undefined ? {} : { goalDelegationAdmission: options.goalDelegationAdmission }),
    ...(options.deletionPreflight === undefined ? {} : { deletionPreflight: options.deletionPreflight }),
    ...(options.sessionFamilyStopTimeoutMs === undefined ? {} : { sessionFamilyStopTimeoutMs: options.sessionFamilyStopTimeoutMs }),
    logger: silentLogger,
  });
  return { manager, sessionAgentManager, trackSession, untrackSession };
}

async function writeSessionFile(input: {
  sessionId: string;
  rootSessionId?: string;
  parentSessionId?: string;
  cwd?: string;
  title?: string;
  executions?: SessionFile["executions"];
  childSessionLinks?: SessionFile["childSessionLinks"];
  blockedByHitlIds?: SessionFile["blockedByHitlIds"];
  goalId?: string;
}): Promise<void> {
  const rootSessionId = input.rootSessionId ?? input.sessionId;
  const file: SessionFile = {
    schemaVersion: 1,
    sessionId: input.sessionId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    cwd: input.cwd ?? workspaceRoot,
    agentName: input.parentSessionId === undefined ? "engineer" : "explore",
    modelInfo: null,
    title: input.title ?? null,
    messages: [],
    steps: [],
    stats: createEmptySessionStats(),
    executions: input.executions ?? [],
    compression: createEmptyCompressionState(),
    todos: [],
    reminders: [],
    childSessionLinks: input.childSessionLinks ?? [],
    rootSessionId,
    ...(input.goalId === undefined ? {} : { goalId: input.goalId }),
    ...(input.blockedByHitlIds === undefined ? {} : { blockedByHitlIds: input.blockedByHitlIds }),
    ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
  };
  await mkdir(getSessionDir(workspaceRoot, input.sessionId), { recursive: true });
  await Bun.write(getSessionPath(workspaceRoot, input.sessionId), JSON.stringify(file, null, 2));
}

function makeChildLink(parentSessionId: string, childSessionId: string, childAgentName: string): ToolChildSessionLink {
  return {
    parentSessionId,
    parentToolCallId: `tool-${childSessionId}`,
    toolName: "delegate",
    childSessionId,
    childAgentName,
    depth: 1,
    background: true,
    status: "running",
    createdAt: Date.now(),
  };
}

describe("SessionExecutionManager", () => {
  beforeEach(async () => {
    storeManager.clearAll();
    await rm(workspaceRoot, { recursive: true, force: true });
    await mkdir(workspaceRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  test("projects root-family activity from live ownership and publishes only transitions", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const rootRun = deferred<AgentResult>();
    const childRun = deferred<AgentResult>();
    storeManager.create(rootId, workspaceRoot, { agentName: "engineer" });
    storeManager.create(childId, workspaceRoot, {
      rootSessionId: rootId,
      parentSessionId: rootId,
      agentName: "explore",
    });
    const rootAgent = new MockAgent(rootId, rootRun.promise, workspaceRoot);
    const childAgent = new MockAgent(childId, childRun.promise, workspaceRoot);
    const { manager } = createManager({ [rootId]: rootAgent, [childId]: childAgent });
    const changes: Array<{ rootSessionId: string; activity: string }> = [];
    const unsubscribe = manager.subscribeSessionRuntimeChanges((change) => {
      changes.push({ rootSessionId: change.rootSessionId, activity: change.activity });
    });

    expect(manager.getSessionFamilyActivity(workspaceRoot, rootId)).toBe("idle");
    const rootExecution = manager.startExecution({
      slug: "project",
      workspaceRoot,
      sessionId: rootId,
      userMessage: "root",
    });
    const childExecution = manager.startExecution({
      slug: "project",
      workspaceRoot,
      sessionId: childId,
      userMessage: "child",
      origin: "tool_call",
    });
    expect(rootExecution.rootSessionId).toBe(rootId);
    expect(childExecution.rootSessionId).toBe(rootId);
    expect(manager.getSessionFamilyActivity(workspaceRoot, rootId)).toBe("running");

    rootRun.resolve({ text: "root done", steps: 1 });
    await rootExecution.promise;
    expect(manager.getSessionFamilyActivity(workspaceRoot, rootId)).toBe("running");
    expect(manager.listSessionFamilyActivities()).toEqual([
      { workspaceRoot, rootSessionId: rootId, activity: "running" },
    ]);

    childRun.resolve({ text: "child done", steps: 1 });
    await childExecution.promise;
    expect(manager.getSessionFamilyActivity(workspaceRoot, rootId)).toBe("idle");
    expect(manager.listSessionFamilyActivities()).toEqual([]);
    expect(changes).toEqual([
      { rootSessionId: rootId, activity: "running" },
      { rootSessionId: rootId, activity: "idle" },
    ]);
    unsubscribe();
  });

  test("strong family stop exposes stopping until every descendant releases ownership", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const childRun = deferred<AgentResult>();
    storeManager.create(rootId, workspaceRoot, { agentName: "engineer" });
    storeManager.create(childId, workspaceRoot, {
      rootSessionId: rootId,
      parentSessionId: rootId,
      agentName: "explore",
    });
    const childAgent = new MockAgent(childId, childRun.promise, workspaceRoot);
    const { manager } = createManager({ [childId]: childAgent });
    const activities: string[] = [];
    manager.subscribeSessionRuntimeChanges((change) => activities.push(change.activity));
    const childExecution = manager.startExecution({
      slug: "project",
      workspaceRoot,
      sessionId: childId,
      userMessage: "child",
      origin: "tool_call",
    });

    const stopping = manager.stopSessionFamily(workspaceRoot, rootId);
    expect(manager.getSessionFamilyActivity(workspaceRoot, rootId)).toBe("stopping");
    expect(childExecution.abortController.signal.aborted).toBe(true);
    await stopping;

    expect(manager.getSessionFamilyActivity(workspaceRoot, rootId)).toBe("idle");
    expect(activities).toEqual(["running", "stopping", "idle"]);
  });

  test("rejects a new root user message while a descendant owns the family", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const childRun = deferred<AgentResult>();
    const rootStore = storeManager.create(rootId, workspaceRoot, { agentName: "engineer" });
    storeManager.create(childId, workspaceRoot, {
      rootSessionId: rootId,
      parentSessionId: rootId,
      agentName: "explore",
    });
    const rootAgent = new MockAgent(rootId, Promise.resolve({ text: "must not run", steps: 1 }), workspaceRoot);
    const childAgent = new MockAgent(childId, childRun.promise, workspaceRoot);
    const { manager } = createManager({ [rootId]: rootAgent, [childId]: childAgent });
    const childExecution = manager.startExecution({
      slug: "project",
      workspaceRoot,
      sessionId: childId,
      userMessage: "child",
      origin: "tool_call",
    });

    await expect(manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId: rootId,
      userMessage: "new root message",
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
    const siblingRun = deferred<AgentResult>();
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
    const siblingExecution = manager.startExecution({
      slug: "project",
      workspaceRoot,
      sessionId: siblingId,
      userMessage: "sibling",
      origin: "tool_call",
    });

    await expect(manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId: childId,
      userMessage: "direct child message",
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

  test("fails closed when execution identity has not been loaded", () => {
    const { manager } = createManager({});

    expect(() => manager.startExecution({
      slug: "project",
      workspaceRoot,
      sessionId: "unloaded-session",
      userMessage: "must not guess family identity",
    })).toThrow(SessionFamilyIdentityUnavailableError);
  });

  test("startExecution starts an execution and rejects duplicate same-session starts", async () => {
    const run = deferred<AgentResult>();
    const agent = new MockAgent("session-start", run.promise);
    const { manager } = createManager({ "session-start": agent });

    const execution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: "session-start", userMessage: "hello" });

    expect(execution.sessionId).toBe("session-start");
    expect(execution.agentName).toBe("engineer");
    expect(execution.origin).toBe("user_message");
    expect(typeof execution.executionToken).toBe("symbol");
    expect(manager.getSessionFamilyActivity(workspaceRoot, "session-start")).toBe("running");
    expect(() => manager.startExecution({ slug: "project", workspaceRoot, sessionId: "session-start", userMessage: "again" })).toThrow(AgentRunningError);
    await Promise.resolve();
    expect(agent.runMock).toHaveBeenCalledWith("hello", expect.objectContaining({ abort: execution.abortController.signal }));
    const options = agent.runMock.mock.calls[0]?.[1];
    if (!options || options instanceof AbortSignal) throw new Error("Expected AgentRunOptions");
    expect("maxSteps" in options).toBe(false);
    run.resolve({ text: "done", steps: 1 });
    await execution.promise;
    expect(manager.getSessionFamilyActivity(workspaceRoot, "session-start")).toBe("idle");
  });

  test("durably flushes a caller-owned execution start before running the agent", async () => {
    const sessionId = "durable-execution-start";
    const flush = deferred<void>();
    const agent = new MockAgent(sessionId, Promise.resolve({ text: "done", steps: 1 }));
    const flushedSessionIds: string[] = [];
    const { manager } = createManager({ [sessionId]: agent }, {
      flushSessionStore: async (flushedSessionId) => {
        flushedSessionIds.push(flushedSessionId);
        await flush.promise;
      },
    });

    const execution = manager.startExecution({
      slug: "project",
      workspaceRoot,
      sessionId,
      userMessage: "continue durable Loop turn",
      executionId: "loop-attempt-1",
    });
    await waitFor(() => flushedSessionIds.length > 0);

    expect(flushedSessionIds).toEqual([sessionId]);
    expect(agent.store.getState().events.some((event) => (
      event.kind === "execution-start"
      && (event.payload as { executionId?: string }).executionId === "loop-attempt-1"
    ))).toBe(true);
    expect(agent.runMock).not.toHaveBeenCalled();

    flush.resolve(undefined);
    await execution.promise;

    expect(agent.runMock).toHaveBeenCalledTimes(1);
  });

  test("does not run the agent when a caller-owned execution start cannot be flushed", async () => {
    const sessionId = "failed-durable-execution-start";
    const agent = new MockAgent(sessionId, Promise.resolve({ text: "must not run", steps: 1 }));
    const { manager } = createManager({ [sessionId]: agent }, {
      flushSessionStore: async () => {
        throw new Error("durable execution-start flush failed");
      },
    });

    const execution = manager.startExecution({
      slug: "project",
      workspaceRoot,
      sessionId,
      userMessage: "continue durable Loop turn",
      executionId: "loop-attempt-2",
    });
    await execution.promise;

    expect(agent.runMock).not.toHaveBeenCalled();
    expect(agent.store.getState().isRunning).toBe(false);
    expect(agent.store.getState().events.at(-1)).toMatchObject({
      kind: "execution-end",
      payload: { status: "failed", error: "durable execution-start flush failed" },
    });
  });

  test("rebuilds the Agent and continues the same Session after cwd changes", async () => {
    const sessionId = "cwd-transition-session";
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

    const execution = manager.startExecution({ slug: "project", workspaceRoot, sessionId, userMessage: "switch and continue" });
    await execution.promise;

    expect(first.runMock).toHaveBeenCalledWith("switch and continue", expect.anything());
    expect(sessionAgentManager.releaseAgent).toHaveBeenCalledWith(workspaceRoot, sessionId);
    expect(second.runMock).toHaveBeenCalledWith("", expect.anything());
  });

  test("startExecution forwards maxSteps to agent.run", async () => {
    const agent = new MockAgent("limited-session", Promise.resolve({ text: "done", steps: 1 }));
    const { manager } = createManager({ "limited-session": agent });

    const execution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: "limited-session", userMessage: "work", maxSteps: 1 });
    await execution.promise;

    expect(agent.runMock).toHaveBeenCalledWith("work", expect.objectContaining({ maxSteps: 1 }));
  });

  test("startExecution forwards loop origin to agent.run options", async () => {
    const agent = new MockAgent("loop-origin-session", Promise.resolve({ text: "done", steps: 1 }));
    const { manager } = createManager({ "loop-origin-session": agent });
    const origin = {
      kind: "loop" as const,
      loopId: crypto.randomUUID(),
      runId: "run-1",
      trigger: "manual" as const,
      approvalPolicy: "interactive" as const,
    };

    const execution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: "loop-origin-session", userMessage: "work", origin });
    await execution.promise;

    expect(execution.origin).toBe("user_message");
    expect(agent.runMock).toHaveBeenCalledWith("work", expect.objectContaining({ origin }));
  });

  test("startExecution forwards extraTools to agent.run", async () => {
    const agent = new MockAgent("extra-tools-session", Promise.resolve({ text: "done", steps: 1 }));
    const { manager } = createManager({ "extra-tools-session": agent });

    const execution = manager.startExecution({
      slug: "project",
      workspaceRoot,
      sessionId: "extra-tools-session",
      userMessage: "work",
      extraTools: ["github_get_pull_request"],
    });
    await execution.promise;

    expect(agent.runMock).toHaveBeenCalledWith("work", expect.objectContaining({ extraTools: ["github_get_pull_request"] }));
  });

  test("startExecution uses the persisted Session agent identity", async () => {
    const agent = new MockAgent("engineer-session", Promise.resolve({ text: "done", steps: 1 }));
    const { manager, sessionAgentManager } = createManager({ "engineer-session": agent });

    const execution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: "engineer-session", userMessage: "work" });
    await execution.promise;

    expect(execution.agentName).toBe("engineer");
    expect(sessionAgentManager.getOrCreate).toHaveBeenCalledWith(workspaceRoot, "engineer-session");
  });

  test("enforces concurrent session limit with ConcurrentSessionLimitError", () => {
    const agentOne = new MockAgent("one", new Promise(() => undefined));
    const agentTwo = new MockAgent("two", new Promise(() => undefined));
    const { manager } = createManager({ one: agentOne, two: agentTwo }, { maxConcurrentSessions: 1 });

    manager.startExecution({ slug: "project", workspaceRoot, sessionId: "one", userMessage: "one" });

    expect(() => manager.startExecution({ slug: "project", workspaceRoot, sessionId: "two", userMessage: "two" })).toThrow(ConcurrentSessionLimitError);
  });

  test("atomically rejects duplicate starts while agent creation is pending", () => {
    storeManager.create("pending-create", workspaceRoot, { agentName: "engineer" });
    const sessionAgentManager = createFakeManager({});
    const pendingManager = new SessionExecutionManager({
      sessionAgentManager: {
        ...sessionAgentManager,
        getOrCreate: mock(async () => await new Promise<Agent>(() => undefined)),
      } as unknown as SessionAgentManager,
      ...storeCallbacks(storeManager),
      trackSession: mock(() => undefined),
      untrackSession: mock(() => undefined),
      executionScopeValidator: allowExecutionScope,
      logger: silentLogger,
    });

    pendingManager.startExecution({ slug: "project", workspaceRoot, sessionId: "pending-create", userMessage: "one" });

    expect(() => pendingManager.startExecution({ slug: "project", workspaceRoot, sessionId: "pending-create", userMessage: "two" })).toThrow(AgentRunningError);
  });

  test("family stop cancels execution and ignores late tool result after current execution is settled", async () => {
    const run = deferred<AgentResult>();
    const agent = new MockAgent("stale", run.promise, workspaceRoot);
    const { manager } = createManager({ stale: agent });

    const execution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: "stale", userMessage: "work" });
    await Promise.resolve();
    agent.store.getState().append({ type: "tool-input-start", toolCallId: "late-tool", toolName: "bash" });
    agent.store.getState().append({ type: "tool-call", toolCallId: "late-tool", toolName: "bash", input: {} });
    const stopping = manager.stopSessionFamily(workspaceRoot, "stale");
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
    const run = deferred<AgentResult>();
    let runOptions: AgentRunOptions | AbortSignal | undefined;
    const agent = {
      store: storeManager.create("deferred-cancel", workspaceRoot, { agentName: "engineer" }),
      run: mock(async (_message: string, options?: AgentRunOptions | AbortSignal): Promise<AgentResult> => {
        runOptions = options;
        return await withAbort(run.promise, options instanceof AbortSignal ? options : options?.abort);
      }),
      dispose: mock(() => undefined),
    } as unknown as MockAgent;
    const { manager } = createManager({ "deferred-cancel": agent });

    const execution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: "deferred-cancel", userMessage: "work" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!runOptions || runOptions instanceof AbortSignal) throw new Error("Expected AgentRunOptions");
    expect(runOptions.confirmPermission).toBeUndefined();
    expect(runOptions.askUser).toBeUndefined();
    const stopping = manager.stopSessionFamily(workspaceRoot, "deferred-cancel");
    run.resolve({ text: "done", steps: 1 });
    await execution.promise;
    await stopping;

    expect(agent.store.getState().executions.at(-1)?.status).toBe("cancelled");
  });

  test("cancelChildSession cascades to active descendant sessions", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const grandchildId = crypto.randomUUID();
    const siblingId = crypto.randomUUID();
    storeManager.create(childId, workspaceRoot, { rootSessionId: rootId, parentSessionId: rootId, agentName: "explore" });
    storeManager.create(grandchildId, workspaceRoot, { rootSessionId: rootId, parentSessionId: childId, agentName: "explore" });
    storeManager.create(siblingId, workspaceRoot, { rootSessionId: rootId, parentSessionId: rootId, agentName: "explore" });
    const rootRun = deferred<AgentResult>();
    const siblingRun = deferred<AgentResult>();
    const rootAgent = new MockAgent(rootId, rootRun.promise);
    const childRun = deferred<AgentResult>();
    const grandchildRun = deferred<AgentResult>();
    const childAgent = new MockAgent(childId, childRun.promise);
    const grandchildAgent = new MockAgent(grandchildId, grandchildRun.promise);
    const siblingAgent = new MockAgent(siblingId, siblingRun.promise);
    rootAgent.store.getState().append({
      type: "tool-child-session-link",
      link: makeChildLink(rootId, childId, "explore"),
    });
    rootAgent.store.getState().append({
      type: "tool-child-session-link",
      link: makeChildLink(rootId, siblingId, "explore"),
    });
    childAgent.store.getState().append({
      type: "tool-child-session-link",
      link: makeChildLink(childId, grandchildId, "explore"),
    });
    const { manager } = createManager({ [rootId]: rootAgent, [childId]: childAgent, [grandchildId]: grandchildAgent, [siblingId]: siblingAgent });
    const rootExecution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: rootId, userMessage: "root" });
    const childExecution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: childId, userMessage: "child", origin: "tool_call" });
    const grandchildExecution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: grandchildId, userMessage: "grandchild", origin: "tool_call" });
    const siblingExecution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: siblingId, userMessage: "sibling", origin: "tool_call" });
    await Promise.resolve();

    expect(manager.cancelChildSession(workspaceRoot, rootId, childId)).toBe(true);
    childRun.resolve({ text: "done", steps: 1 });
    grandchildRun.resolve({ text: "done", steps: 1 });
    await Promise.all([childExecution.promise, grandchildExecution.promise]);

    expect(rootExecution.abortController.signal.aborted).toBe(false);
    expect(childExecution.abortController.signal.aborted).toBe(true);
    expect(grandchildExecution.abortController.signal.aborted).toBe(true);
    expect(siblingExecution.abortController.signal.aborted).toBe(false);
    rootRun.resolve({ text: "done", steps: 1 });
    siblingRun.resolve({ text: "done", steps: 1 });
    await Promise.all([rootExecution.promise, siblingExecution.promise]);
  });

  test("execution-control stop cancels active descendants after goal_manage self-cancel", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const childRun = deferred<AgentResult>();
    const rootAgent = new MockAgent(rootId, Promise.resolve({
      text: "Goal cancelled",
      steps: 1,
      executionControl: { action: "stop_session_family", reason: "goal_cancelled" },
    }), workspaceRoot);
    const childAgent = new MockAgent(childId, childRun.promise, workspaceRoot);
    rootAgent.store.setState({ rootSessionId: rootId });
    childAgent.store.setState({ rootSessionId: rootId, parentSessionId: rootId });
    const { manager } = createManager({ [rootId]: rootAgent, [childId]: childAgent });
    const childExecution = manager.startExecution({
      slug: "project",
      workspaceRoot,
      sessionId: childId,
      userMessage: "child work",
      origin: "tool_call",
    });

    const rootExecution = manager.startExecution({
      slug: "project",
      workspaceRoot,
      sessionId: rootId,
      userMessage: "cancel Goal",
    });
    await rootExecution.promise;

    expect(childExecution.abortController.signal.aborted).toBe(true);
    childRun.resolve({ text: "late", steps: 1 });
    await childExecution.promise;
  });

  test("execution-control stop owns the family until an already pending child launch drains", async () => {
    const rootId = crypto.randomUUID();
    const rootRun = deferred<AgentResult>();
    const skillResolution = deferred<readonly []>();
    let resolvingSkills = false;
    const rootAgent = new MockAgent(rootId, rootRun.promise, workspaceRoot);
    const factory = makeFactory({
      resolveDelegatedSkills: mock(async () => {
        resolvingSkills = true;
        return await skillResolution.promise;
      }),
    });
    const { manager } = createManager({ [rootId]: rootAgent }, { factory });
    const activities: string[] = [];
    manager.subscribeSessionRuntimeChanges((change) => activities.push(change.activity));

    const pendingChild = manager.startChildExecution(workspaceRoot, {
      parentStore: rootAgent.store,
      parentSessionId: rootId,
      parentToolCallId: "pending-before-self-stop",
      toolName: "delegate",
      targetAgentName: "explore",
      prompt: "resolve slowly",
      skills: [],
    });
    await waitFor(() => resolvingSkills);
    const rootExecution = manager.startExecution({
      slug: "project",
      workspaceRoot,
      sessionId: rootId,
      userMessage: "cancel Goal",
    });

    rootRun.resolve({
      text: "Goal cancelled",
      steps: 1,
      executionControl: { action: "stop_session_family", reason: "goal_cancelled" },
    });
    await waitFor(() => manager.getSessionFamilyActivity(workspaceRoot, rootId) === "stopping");
    let rootSettled = false;
    void rootExecution.promise.then(() => { rootSettled = true; });
    await Promise.resolve();
    expect(rootSettled).toBe(false);

    skillResolution.resolve([]);
    await expect(pendingChild).rejects.toThrow(SessionFamilyStopInProgressError);
    await rootExecution.promise;

    expect(manager.getSessionFamilyActivity(workspaceRoot, rootId)).toBe("idle");
    expect(activities).toEqual(["running", "stopping", "idle"]);
  });

  test("child execution-control stop retains stopping until its aborted ancestor actually drains", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const rootResult = deferred<AgentResult>();
    let rootStarted = false;
    const rootStore = storeManager.create(rootId, workspaceRoot, { agentName: "engineer" });
    const rootAgent = {
      store: rootStore,
      cwd: workspaceRoot,
      run: mock(async () => {
        rootStarted = true;
        // Deliberately ignores abort to expose the ancestor-drain handoff race.
        return await rootResult.promise;
      }),
      dispose: mock(() => undefined),
    } as Agent;
    const childAgent = new MockAgent(childId, Promise.resolve({
      text: "cancel family",
      steps: 1,
      executionControl: { action: "stop_session_family", reason: "goal_cancelled" },
    }), workspaceRoot);
    childAgent.store.setState({
      rootSessionId: rootId,
      parentSessionId: rootId,
    });
    const { manager } = createManager({
      [rootId]: rootAgent as MockAgent,
      [childId]: childAgent,
    });
    const activities: string[] = [];
    manager.subscribeSessionRuntimeChanges((change) => activities.push(change.activity));

    const rootExecution = manager.startExecution({
      slug: "project",
      workspaceRoot,
      sessionId: rootId,
      userMessage: "wait for child",
    });
    await waitFor(() => rootStarted);
    const childExecution = manager.startExecution({
      slug: "project",
      workspaceRoot,
      sessionId: childId,
      userMessage: "cancel from child",
      origin: "tool_call",
    });

    await childExecution.promise;
    expect(rootExecution.abortController.signal.aborted).toBe(true);
    expect(manager.getExecution(workspaceRoot, rootId)).toBeDefined();
    expect(manager.getSessionFamilyActivity(workspaceRoot, rootId)).toBe("stopping");

    rootResult.resolve({ text: "late ancestor completion", steps: 1 });
    await rootExecution.promise;
    await waitFor(() => manager.getSessionFamilyActivity(workspaceRoot, rootId) === "idle");
    expect(activities).toEqual(["running", "stopping", "idle"]);
  });

  test("family stop is isolated by workspace root for identical session ids", async () => {
    const otherWorkspaceRoot = join(import.meta.dir, "__test_tmp__", "session-execution-manager-other-workspace");
    await mkdir(otherWorkspaceRoot, { recursive: true });
    const runA = deferred<AgentResult>();
    const runB = deferred<AgentResult>();
    const agentA = new MockAgent("same-session", runA.promise, workspaceRoot);
    const agentB = new MockAgent("same-session", runB.promise, otherWorkspaceRoot);
    const { manager } = createManager({ "same-session": agentA });
    const sessionAgentManager = createFakeManager({ "same-session": agentB });
    const managerB = new SessionExecutionManager({
      sessionAgentManager,
      ...storeCallbacks(storeManager),
      trackSession: mock(() => undefined),
      untrackSession: mock(() => undefined),
      executionScopeValidator: allowExecutionScope,
      logger: silentLogger,
    });
    const executionA = manager.startExecution({ slug: "project-a", workspaceRoot, sessionId: "same-session", userMessage: "a" });
    const executionB = managerB.startExecution({ slug: "project-b", workspaceRoot: otherWorkspaceRoot, sessionId: "same-session", userMessage: "b" });

    const stopping = manager.stopSessionFamily(workspaceRoot, "same-session");
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
    const agent = new MockAgent("abort", new Promise(() => undefined));
    const { manager } = createManager({ abort: agent });

    const execution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: "abort", userMessage: "stop" });
    const stopping = manager.stopSessionFamily(workspaceRoot, "abort");
    await execution.promise;
    await stopping;
    expect(execution.abortController.signal.aborted).toBe(true);
    expect(manager.getSessionFamilyActivity(workspaceRoot, "abort")).toBe("idle");

    const agentTwo = new MockAgent("abort-wait", new Promise(() => undefined));
    const second = createManager({ "abort-wait": agentTwo });
    const secondExecution = second.manager.startExecution({ slug: "project", workspaceRoot, sessionId: "abort-wait", userMessage: "stop" });
    await second.manager.stopSessionFamily(workspaceRoot, "abort-wait");
    await secondExecution.promise;
    expect(secondExecution.abortController.signal.aborted).toBe(true);
  });

  test("stopSessionFamily reports a stuck HITL resume instead of silently timing out", async () => {
    const rootId = crypto.randomUUID();
    storeManager.create(rootId, workspaceRoot, { agentName: "engineer" });
    const { manager } = createManager({}, { sessionFamilyStopTimeoutMs: 5 });
    const resume = reserveActivatedHitlResume(manager, rootId);

    let captured: unknown;
    try {
      await manager.stopSessionFamily(workspaceRoot, rootId);
    } catch (error) {
      captured = error;
    }

    expect(resume.abortSignal.aborted).toBe(true);
    expect(captured).toBeInstanceOf(SessionFamilyStopConflictError);
    expect(captured).toMatchObject({ rootSessionId: rootId, stuckSessionIds: [rootId] });
    resume.release();
  });

  test("family stop generation blocks every new owner and drains an already pending child launch", async () => {
    const rootId = crypto.randomUUID();
    const rootStore = storeManager.create(rootId, workspaceRoot, { agentName: "engineer" });
    const skillResolution = deferred<readonly []>();
    let resolvingSkills = false;
    const factory = makeFactory({
      resolveDelegatedSkills: mock(async () => {
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
    expect(() => manager.startExecution({
      slug: "project",
      workspaceRoot,
      sessionId: rootId,
      userMessage: "must not start",
    })).toThrow(SessionFamilyStopInProgressError);
    expect(() => manager.reserveSessionHitlResume(workspaceRoot, rootId, rootId)).toThrow(SessionFamilyStopInProgressError);
    expect(() => manager.acquireSessionCwdTransition(workspaceRoot, rootId)).toThrow(SessionFamilyStopInProgressError);
    await expect(manager.startChildExecution(workspaceRoot, {
      parentStore: rootStore,
      parentSessionId: rootId,
      parentToolCallId: "new-after-stop",
      toolName: "delegate",
      targetAgentName: "explore",
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

  test("root self-stop still waits for a stuck child while child self-stop defers only its ancestor", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const siblingId = crypto.randomUUID();
    storeManager.create(rootId, workspaceRoot, { agentName: "engineer" });
    storeManager.create(childId, workspaceRoot, {
      rootSessionId: rootId,
      parentSessionId: rootId,
      agentName: "explore",
    });
    storeManager.create(siblingId, workspaceRoot, {
      rootSessionId: rootId,
      parentSessionId: rootId,
      agentName: "explore",
    });

    const never = new Promise<AgentResult>(() => undefined);
    const started = new Set<string>();
    const uncooperative = (sessionId: string): Agent => ({
      store: storeManager.get(sessionId, workspaceRoot)!,
      cwd: workspaceRoot,
      run: mock(async () => {
        started.add(sessionId);
        return await never;
      }),
      dispose: mock(() => undefined),
    });
    const rootAgent = uncooperative(rootId);
    const siblingAgent = uncooperative(siblingId);
    const { manager } = createManager({ [rootId]: rootAgent as MockAgent, [siblingId]: siblingAgent as MockAgent }, {
      sessionFamilyStopTimeoutMs: 5,
    });
    manager.startExecution({ slug: "project", workspaceRoot, sessionId: rootId, userMessage: "ancestor" });
    manager.startExecution({ slug: "project", workspaceRoot, sessionId: siblingId, userMessage: "sibling" });
    await waitFor(() => started.has(rootId) && started.has(siblingId));

    const rootStop = manager.acquireSessionFamilyStop({
      workspaceRoot,
      rootSessionId: rootId,
      exemptSessionId: rootId,
    });
    await expect(rootStop.stopAndWait()).rejects.toMatchObject({
      name: "SessionFamilyStopConflictError",
      stuckSessionIds: [siblingId],
    });
    rootStop.release();

    const childStop = manager.acquireSessionFamilyStop({
      workspaceRoot,
      rootSessionId: rootId,
      exemptSessionId: childId,
    });
    await expect(childStop.stopAndWait()).rejects.toMatchObject({
      name: "SessionFamilyStopConflictError",
      stuckSessionIds: [siblingId],
    });
    childStop.release();
  });

  test("abortAll cancels every active execution", async () => {
    const firstAgent = new MockAgent("abort-all-one", new Promise(() => undefined));
    const secondAgent = new MockAgent("abort-all-two", new Promise(() => undefined));
    const { manager } = createManager({ "abort-all-one": firstAgent, "abort-all-two": secondAgent });
    const first = manager.startExecution({ slug: "project", workspaceRoot, sessionId: "abort-all-one", userMessage: "one" });
    const second = manager.startExecution({ slug: "project", workspaceRoot, sessionId: "abort-all-two", userMessage: "two" });

    await manager.abortAll();

    expect(first.abortController.signal.aborted).toBe(true);
    expect(second.abortController.signal.aborted).toBe(true);
    expect(manager.getSessionFamilyActivity(workspaceRoot, "abort-all-one")).toBe("idle");
    expect(manager.getSessionFamilyActivity(workspaceRoot, "abort-all-two")).toBe("idle");
  });

  test("startExecution omits legacy permission and question service callbacks", async () => {
    const agent = new MockAgent("callbacks", Promise.resolve({ text: "done", steps: 1 }));
    const { manager } = createManager({ callbacks: agent });

    const execution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: "callbacks", userMessage: "work" });
    await execution.promise;
    const options = agent.runMock.mock.calls[0]?.[1];
    if (!options || options instanceof AbortSignal) throw new Error("Expected AgentRunOptions");
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
      listSessionFamilyBlockedHitlIds: async () => [],
    });

    const handle = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "tool-call",
      toolName: "delegate",
      targetAgentName: "explore",
      prompt: "inspect",
      skills: [],
      description: "Inspect files",
      background: false,
      currentDepth: 0,
      parentAbort: undefined,
    });

    await handle.result;

    expect(sessionAgentManager.createChildAgent).toHaveBeenCalled();
    expect(handle.store.getState().parentSessionId).toBe(parentId);
    expect(handle.store.getState().goalId).toBe(goalId);
    expect(handle.store.getState().cwd).toBe(worktreeCwd);
    expect(handle.store.getState().agentName).toBe("explore");
    expect(parentStore.getState().events
      .filter((event) => event.kind === "tool-child-session-link")
      .map((event) => (event.payload as { link: ToolChildSessionLink }).link.status)).toEqual(["linked", "running", "completed"]);
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

  test("blocks new Goal child execution while any sibling has durable HITL", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, {
      agentName: "engineer",
      goalId: crypto.randomUUID(),
    });
    const { manager, sessionAgentManager } = createManager({}, {
      factory: makeFactory(),
      listSessionFamilyBlockedHitlIds: async () => ["sibling-hitl"],
    });

    await expect(manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "blocked-delegate",
      toolName: "delegate",
      targetAgentName: "explore",
      prompt: "must not start",
      skills: [],
      background: false,
      currentDepth: 0,
      parentAbort: undefined,
    })).rejects.toMatchObject({ name: "SessionHitlBlockedError", hitlIds: ["sibling-hitl"] });
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
      listSessionFamilyBlockedHitlIds: async () => (++checks === 1 ? [] : ["raced-hitl"]),
    });

    await expect(manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "raced-delegate",
      toolName: "delegate",
      targetAgentName: "explore",
      prompt: "must not start",
      skills: [],
      background: false,
      currentDepth: 0,
      parentAbort: undefined,
    })).rejects.toMatchObject({ name: "SessionHitlBlockedError", hitlIds: ["raced-hitl"] });
    expect(parentStore.getState().childSessionLinks.at(-1)).toMatchObject({ status: "failed" });
  });

  test("applies Goal phase admission to both new delegation and stale child resume", async () => {
    const goalId = crypto.randomUUID();
    const parentSessionId = crypto.randomUUID();
    const parentStore = storeManager.create(parentSessionId, workspaceRoot, {
      agentName: "engineer",
      goalId,
      sessionRole: "main",
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
      prompt: "inspect",
    } as const;

    await expect(manager.startChildExecution(workspaceRoot, { ...base, skills: [] })).rejects.toBe(denied);
    await expect(manager.resumeChildExecution(workspaceRoot, { ...base, sessionId: crypto.randomUUID() })).rejects.toBe(denied);
    expect(run).toHaveBeenCalledTimes(2);
  });

  test("startChildExecution preserves Loop origin so child tool guards execute in the same run scope", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, {
      agentName: "engineer",
      loopId: LOOP_ORIGIN.loopId,
    });
    let childOrigin: ToolExecutionOrigin | undefined;
    const loopGuard = mock((origin: ToolExecutionOrigin | undefined) => {
      if (origin?.kind !== "loop" || origin.loopId !== LOOP_ORIGIN.loopId) {
        throw new Error("Loop child guard lost its execution origin");
      }
    });
    const { manager } = createManager({}, {
      factory: makeFactory(),
      childRunOptions: (options) => {
        childOrigin = options instanceof AbortSignal ? undefined : options?.origin;
        loopGuard(childOrigin);
      },
    });

    const handle = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "loop-delegate-call",
      toolName: "delegate",
      targetAgentName: "explore",
      prompt: "inspect under Loop guardrails",
      skills: [],
      background: false,
      currentDepth: 0,
      parentAbort: undefined,
      origin: LOOP_ORIGIN,
    });
    await handle.result;

    expect(handle.store.getState().loopId).toBe(LOOP_ORIGIN.loopId);
    expect(childOrigin).toEqual(LOOP_ORIGIN);
    expect(loopGuard).toHaveBeenCalledTimes(1);
  });

  test("startChildExecution rejects Loop origin that does not match its parent Session", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, {
      agentName: "engineer",
      loopId: "loop-parent",
    });
    const { manager } = createManager({}, { factory: makeFactory() });

    await expect(manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "loop-delegate-call",
      toolName: "delegate",
      targetAgentName: "explore",
      prompt: "inspect",
      skills: [],
      background: false,
      currentDepth: 0,
      parentAbort: undefined,
      origin: { ...LOOP_ORIGIN, loopId: "loop-other" },
    })).rejects.toThrow(ChildSessionLoopScopeMismatchError);

    await expect(manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "loop-delegate-call-without-origin",
      toolName: "delegate",
      targetAgentName: "explore",
      prompt: "inspect",
      skills: [],
      background: false,
      currentDepth: 0,
      parentAbort: undefined,
    })).rejects.toThrow(ChildSessionLoopScopeMismatchError);
  });

  test("legacy active workflow child prompt is omitted during Goal migration", async () => {
    const parentId = crypto.randomUUID();
    const goalId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer", goalId });
    let childPrompt = "";
    const factory = makeFactory({
      getDefinition: mock((name: string) => {
        const base = makeFactory().getDefinition(name);
        if (name === "explore") return { ...base, tools: { tools: ["file_read"] } };
        return base;
      }),
    });
    const { manager } = createManager({}, {
      factory,
      listSessionFamilyBlockedHitlIds: async () => [],
      childRunMessage: (message) => {
        childPrompt = message;
      },
    });

    const handle = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "tool-call",
      toolName: "delegate",
      targetAgentName: "explore",
      prompt: "inspect files",
      skills: [],
      background: false,
      currentDepth: 0,
      parentAbort: undefined,
    });
    await handle.result;

    expect(childPrompt).toBe("inspect files");
    expect(handle.store.getState().goalId).toBe(goalId);
    expect(childPrompt).not.toContain("## Active Workflow");
  });

  test("active workflow child prompt is omitted for agents without workflow tools", async () => {
    const parentId = crypto.randomUUID();
    const goalId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer", goalId });
    let childPrompt = "";
    const { manager } = createManager({}, {
      factory: makeFactory(),
      listSessionFamilyBlockedHitlIds: async () => [],
      childRunMessage: (message) => {
        childPrompt = message;
      },
    });

    const handle = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "tool-call",
      toolName: "delegate",
      targetAgentName: "explore",
      prompt: "inspect without workflow tools",
      skills: [],
      background: false,
      currentDepth: 0,
      parentAbort: undefined,
    });
    await handle.result;

    expect(childPrompt).toBe("inspect without workflow tools");
    expect(handle.store.getState().goalId).toBe(goalId);
    expect(childPrompt).not.toContain("## Active Workflow");
    expect(childPrompt).not.toContain("Omitted Workflow");
  });

  test("goal id is inherited for deeper delegate paths without legacy active workflow prompt", async () => {
    const rootSessionId = crypto.randomUUID();
    const parentId = crypto.randomUUID();
    const goalId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, {
      rootSessionId,
      parentSessionId: rootSessionId,
      agentName: "explore",
      goalId,
    });
    let childPrompt = "";
    const parentDefinition: AgentDefinition = {
      name: "explore",
      displayName: "Explore",
      promptProfileId: "explore",
      tools: { tools: ["delegate", "file_read"], delegateTargets: ["explore"] },
      hooks: { autoCompact: false, autoInjectReminder: false, todoStepReminder: false, todoQueryLoopContinuation: false, transcriptSave: false, memoryExtraction: false, memoryConsolidation: false, titleGeneration: "disabled" },
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
      listSessionFamilyBlockedHitlIds: async () => [],
      childRunMessage: (message) => {
        childPrompt = message;
      },
    });

    const handle = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "grandchild-call",
      toolName: "delegate",
      targetAgentName: "explore",
      prompt: "grandchild inspect",
      skills: [],
      background: false,
      currentDepth: 1,
      parentAbort: undefined,
    });
    await handle.result;

    expect(handle.store.getState().goalId).toBe(goalId);
    expect(childPrompt).toBe("grandchild inspect");
    expect(childPrompt).not.toContain("## Active Workflow");
  });

  test("link write failure prevents child creation/start and releases reserved slot", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
    parentStore.setState({
      append: mock(() => { throw new Error("link write failed"); }),
    } as Partial<SessionStoreState>);
    const factory = makeFactory();
    const { manager, sessionAgentManager } = createManager({}, { factory, maxConcurrentSessions: 1 });

    await expect(manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "tool-call",
      toolName: "delegate",
      targetAgentName: "explore",
      prompt: "inspect",
      skills: [],
      background: false,
      currentDepth: 0,
      parentAbort: undefined,
    })).rejects.toThrow("link write failed");

    expect(sessionAgentManager.createChildAgent).not.toHaveBeenCalled();
    expect(() => sessionAgentManager.acquireSlot(workspaceRoot, "after-failure")).not.toThrow();
    sessionAgentManager.releaseSlot(workspaceRoot, "after-failure");
  });

  test("depth limit is checked before child session creation", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
    const factory = makeFactory();
    const { manager, sessionAgentManager } = createManager({}, { factory });

    await expect(manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "too-deep",
      toolName: "delegate",
      targetAgentName: "explore",
      prompt: "inspect",
      skills: [],
      background: false,
      currentDepth: 2,
      parentAbort: undefined,
    })).rejects.toThrow(DepthLimitError);

    expect(sessionAgentManager.createChildAgent).not.toHaveBeenCalled();
    expect(parentStore.getState().childSessionLinks).toEqual([]);
  });

  test("startChildExecution appends link before child run and bridges child store before model execution", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
    const factory = makeFactory();
    const received: unknown[] = [];
    let linkStatusesAtRunStart: string[] = [];
    const { manager } = createManager({}, {
      factory,
      childRunStarted: () => {
        linkStatusesAtRunStart = parentStore.getState().events
          .filter((event) => event.kind === "tool-child-session-link")
          .map((event) => (event.payload as { link: ToolChildSessionLink }).link.status);
      },
    });

    const handle = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "tool-call",
      toolName: "delegate",
      targetAgentName: "explore",
      prompt: "inspect",
      skills: [],
      background: false,
      currentDepth: 0,
      parentAbort: undefined,
    });
    const unsubscribe = manager.subscribe({ slug: "project", workspaceRoot, sessionId: handle.sessionId, onEvent: (event) => received.push(event) });
    await handle.result;
    unsubscribe();

    expect(linkStatusesAtRunStart).toEqual(["linked", "running"]);
    expect(received.some((event) => "kind" in (event as { kind?: unknown }) && (event as { kind: unknown }).kind === "execution-start")).toBe(true);
    expect(received.some((event) => "kind" in (event as { kind?: unknown }) && (event as { kind: unknown }).kind === "text-delta")).toBe(true);
  });

  test("startChildExecution persists the child identity before exposing its parent link or running it", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
    const flush = deferred<void>();
    let flushedChildSessionId: string | undefined;
    let childRunStarted = false;
    const { manager, sessionAgentManager } = createManager({}, {
      factory: makeFactory(),
      flushSessionStore: async (sessionId) => {
        flushedChildSessionId = sessionId;
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
      prompt: "inspect",
      skills: [],
      background: false,
      currentDepth: 0,
      parentAbort: undefined,
    });
    await waitFor(() => flushedChildSessionId !== undefined);

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

  test("sync child execution exposes live parent link and bridged child events before resolving", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
    const childRun = deferred<AgentResult>();
    const received: unknown[] = [];
    let childSessionId = "";
    let linkWhileRunning: ToolChildSessionLink | undefined;
    let resultResolved = false;
    const { manager } = createManager({}, {
      factory: makeFactory(),
      childRun: childRun.promise,
      childRunStarted: () => {
        linkWhileRunning = parentStore.getState().childSessionLinks.at(-1);
        childSessionId = linkWhileRunning?.childSessionId ?? "";
        if (childSessionId.length > 0) {
          manager.subscribe({ slug: "project", workspaceRoot, sessionId: childSessionId, onEvent: (event) => received.push(event) });
        }
      },
    });

    const handle = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "sync-tool-call",
      toolName: "delegate",
      targetAgentName: "explore",
      prompt: "inspect",
      skills: [],
      background: false,
      currentDepth: 0,
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
    expect(received.some((event) => "kind" in (event as { kind?: unknown }) && (event as { kind: unknown }).kind === "execution-start")).toBe(true);

    childRun.resolve({ text: "live child done", steps: 1 });
    const result = await handle.result;

    expect(result).toEqual({ text: "live child done", steps: 0 });
    expect(resultResolved).toBe(true);
    expect(parentStore.getState().childSessionLinks.at(-1)).toMatchObject({
      childSessionId: handle.sessionId,
      status: "completed",
    });
    expect(received.some((event) => "kind" in (event as { kind?: unknown }) && (event as { kind: unknown }).kind === "text-delta")).toBe(true);
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
          blockedByHitlIds: ["permission-1"],
        });
      },
    });

    const handle = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "hitl-child",
      toolName: "delegate",
      targetAgentName: "explore",
      prompt: "wait for approval",
      skills: [],
      background: true,
      currentDepth: 0,
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

  test("keeps an idle root SSE subscription live for late child-link and HITL continuation updates", async () => {
    const parentId = crypto.randomUUID();
    const parentRun = deferred<AgentResult>();
    const childRun = deferred<AgentResult>();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
    const parentAgent = new MockAgent(parentId, parentRun.promise, workspaceRoot);
    let childSessionId = "";
    const { manager } = createManager({ [parentId]: parentAgent }, {
      factory: makeFactory(),
      childRun: childRun.promise,
      childRunStarted: () => {
        childSessionId = parentStore.getState().childSessionLinks.at(-1)?.childSessionId ?? "";
      },
    });
    const received: Array<{ kind?: string; payload?: { link?: ToolChildSessionLink } }> = [];
    const unsubscribe = manager.subscribe({
      slug: "project",
      workspaceRoot,
      sessionId: parentId,
      onEvent: (event) => received.push(event as { kind?: string; payload?: { link?: ToolChildSessionLink } }),
    });
    const parentExecution = manager.startExecution({
      slug: "project",
      workspaceRoot,
      sessionId: parentId,
      userMessage: "launch child",
    });
    const childHandle = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "late-hitl-child",
      toolName: "delegate",
      targetAgentName: "explore",
      prompt: "wait for approval",
      skills: [],
      background: true,
      currentDepth: 0,
      parentAbort: undefined,
    });
    await waitFor(() => childSessionId === childHandle.sessionId);

    parentRun.resolve({ text: "child started", steps: 1 });
    await parentExecution.promise;
    const childStore = storeManager.get(childSessionId, workspaceRoot);
    if (childStore === undefined) throw new Error("Expected child store");
    childStore.getState().append({
      type: "execution-end",
      status: "waiting_for_human",
      blockedByHitlIds: ["permission-1"],
    });
    childRun.resolve({ text: "", steps: 1 });
    await childHandle.result;
    await manager.updateChildSessionLinkForHitl(workspaceRoot, childSessionId, "running");
    await manager.updateChildSessionLinkForHitl(workspaceRoot, childSessionId, "completed");

    expect(received
      .filter((event) => event.kind === "tool-child-session-link")
      .map((event) => event.payload?.link?.status)).toEqual([
        "linked",
        "running",
        "waiting_for_human",
        "running",
        "completed",
      ]);
    unsubscribe();
  });

  test("updates the same cold-loaded parent link through child HITL continuation", async () => {
    const parentId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
    storeManager.create(childId, workspaceRoot, {
      rootSessionId: parentId,
      parentSessionId: parentId,
      agentName: "explore",
    });
    parentStore.getState().append({
      type: "tool-child-session-link",
      link: {
        ...makeChildLink(parentId, childId, "explore"),
        parentToolCallId: "cold-hitl-child",
        status: "waiting_for_human",
        endedAt: Date.now(),
        durationMs: 10,
      },
    });
    await Promise.all([
      storeManager.flushSession(parentId, workspaceRoot),
      storeManager.flushSession(childId, workspaceRoot),
    ]);
    storeManager.clearAll();

    const { manager } = createManager({}, { factory: makeFactory() });
    await manager.updateChildSessionLinkForHitl(workspaceRoot, childId, "running");
    let coldParent = await storeManager.getOrLoad(parentId, workspaceRoot);
    expect(coldParent.getState().childSessionLinks).toEqual([
      expect.objectContaining({
        parentToolCallId: "cold-hitl-child",
        childSessionId: childId,
        status: "running",
      }),
    ]);
    expect(coldParent.getState().childSessionLinks[0]).not.toHaveProperty("endedAt");
    expect(coldParent.getState().childSessionLinks[0]).not.toHaveProperty("durationMs");

    await manager.updateChildSessionLinkForHitl(workspaceRoot, childId, "completed");
    coldParent = await storeManager.getOrLoad(parentId, workspaceRoot);
    expect(coldParent.getState().childSessionLinks).toEqual([
      expect.objectContaining({
        parentToolCallId: "cold-hitl-child",
        childSessionId: childId,
        status: "completed",
        endedAt: expect.any(Number),
      }),
    ]);
    expect(coldParent.getState().reminders).toEqual([
      expect.objectContaining({
        sessionId: childId,
        terminalState: "completed",
        source: { type: "subagent_completed", sessionId: childId },
      }),
    ]);

    await expect(manager.updateChildSessionLinkForHitl(workspaceRoot, parentId, "running")).resolves.toBeUndefined();
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
      prompt: "inspect",
      skills: [],
      background: false,
      currentDepth: 0,
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
      prompt: "inspect",
      skills: [],
      background: false,
      currentDepth: 0,
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
      prompt: "inspect",
      skills: [],
      background: false,
      currentDepth: 0,
      parentAbort: undefined,
    })).rejects.toThrow(DelegateTargetNotAllowedError);

    const first = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "first",
      toolName: "delegate",
      targetAgentName: "explore",
      prompt: "inspect",
      skills: [],
      background: true,
      currentDepth: 0,
      parentAbort: undefined,
    });

    await expect(manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "second",
      toolName: "delegate",
      targetAgentName: "explore",
      prompt: "inspect",
      skills: [],
      background: true,
      currentDepth: 0,
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
      prompt: "inspect",
      skills: [],
      background: true,
      currentDepth: 0,
      parentAbort: undefined,
    });

    first.abort();
    await first.result;
    expect(parentStore.getState().events
      .filter((event) => event.kind === "tool-child-session-link")
      .map((event) => (event.payload as { link: ToolChildSessionLink }).link.status)).toContain("cancelling");
    expect(parentStore.getState().childSessionLinks.at(-1)).toMatchObject({ status: "cancelled" });
    expect(() => sessionAgentManager.acquireSlot(workspaceRoot, "after-cancel")).not.toThrow();
    sessionAgentManager.releaseSlot(workspaceRoot, "after-cancel");
  });

  test("dispatchCommand only dispatches for active executions", async () => {
    const run = deferred<AgentResult>();
    const agent = new MockAgent("commands", run.promise);
    agent.dispatchCommandMock = mock(async (name, args) => ({ success: true, message: `${name}:${args}` }));
    const { manager } = createManager({ commands: agent });

    await expect(manager.dispatchCommand(workspaceRoot, "commands", "compact", "now")).resolves.toBeNull();
    const execution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: "commands", userMessage: "work" });
    await expect(manager.dispatchCommand(workspaceRoot, "commands", "compact", "now")).resolves.toEqual({ success: true, message: "compact:now" });
    run.resolve({ text: "done", steps: 1 });
    await execution.promise;
  });

  test("subscribes session events without exposing stores", async () => {
    const run = deferred<AgentResult>();
    const agent = new MockAgent("events", run.promise);
    const { manager } = createManager({ events: agent });
    const received: unknown[] = [];
    const unsubscribe = manager.subscribe({ slug: "project", workspaceRoot, sessionId: "events", onEvent: (event) => received.push(event) });

    const execution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: "events", userMessage: "work" });
    await Promise.resolve();
    agent.store.getState().append({ type: "system-notice", message: "hello" });

    expect(received.filter((event) => "kind" in (event as { kind?: unknown }) && (event as { kind: unknown }).kind === "system-notice")).toMatchObject([{ type: "event", slug: "project", sessionId: "events", kind: "system-notice" }]);
    unsubscribe();
    run.resolve({ text: "done", steps: 1 });
    await execution.promise;
  });

  test("subscribes child session events when the child store attaches after subscription", async () => {
    const child = new MockAgent("child-events", Promise.resolve({ text: "done", steps: 1 }));
    const { manager } = createManager({ "child-events": child });
    const received: unknown[] = [];

    const unsubscribe = manager.subscribe({ slug: "project", workspaceRoot, sessionId: "child-events", onEvent: (event) => received.push(event) });
    const execution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: "child-events", userMessage: "work" });
    await Promise.resolve();
    child.store.getState().append({ type: "system-notice", message: "child" });

    expect(received.filter((event) => "kind" in (event as { kind?: unknown }) && (event as { kind: unknown }).kind === "system-notice")).toMatchObject([{ type: "event", slug: "project", sessionId: "child-events", kind: "system-notice" }]);
    unsubscribe();
    await execution.promise;
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

  test("deletion generation blocks execution, child launch, HITL resume, and cwd transition during preflight", async () => {
    const rootId = crypto.randomUUID();
    const rootStore = storeManager.create(rootId, workspaceRoot, { agentName: "engineer" });
    await storeManager.flushSession(rootId, workspaceRoot);
    const preflightEntered = deferred<void>();
    const releasePreflight = deferred<void>();
    const { manager } = createManager({}, {
      factory: makeFactory(),
      deletionPreflight: {
        assertDeletable: async () => {
          preflightEntered.resolve(undefined);
          await releasePreflight.promise;
        },
      },
    });

    const deletion = manager.deleteSession(workspaceRoot, rootId);
    await preflightEntered.promise;

    expect(() => manager.startExecution({
      slug: "project",
      workspaceRoot,
      sessionId: rootId,
      userMessage: "race deletion",
    })).toThrow(SessionDeleteInProgressError);
    await expect(manager.startChildExecution(workspaceRoot, {
      parentStore: rootStore,
      parentSessionId: rootId,
      parentToolCallId: "delete-race-child",
      toolName: "delegate",
      targetAgentName: "explore",
      prompt: "race deletion",
      skills: [],
    })).rejects.toThrow(SessionDeleteInProgressError);
    expect(() => manager.reserveSessionHitlResume(workspaceRoot, rootId, rootId)).toThrow(SessionDeleteInProgressError);
    expect(() => manager.acquireSessionCwdTransition(workspaceRoot, rootId)).toThrow(SessionDeleteInProgressError);

    releasePreflight.resolve(undefined);
    await deletion;
  });

  test("delete performs a final owner preflight after an in-flight execution quiesces", async () => {
    const rootId = crypto.randomUUID();
    const store = storeManager.create(rootId, workspaceRoot, { agentName: "engineer" });
    await storeManager.flushSession(rootId, workspaceRoot);
    let runStarted = false;
    let ownerCreatedDuringAbort = false;
    const agent: Agent = {
      store,
      cwd: store.getState().cwd,
      run: mock(async (_message: string, options?: AgentRunOptions | AbortSignal) => {
        runStarted = true;
        const signal = options instanceof AbortSignal ? options : options?.abort;
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
    const { manager } = createManager({ [rootId]: agent as MockAgent }, {
      deletionPreflight: {
        assertDeletable: async () => {
          preflightCount += 1;
          if (ownerCreatedDuringAbort) {
            throw new SessionDeleteOwnerConflictError([{
              sessionId: rootId,
              ownerType: "session_hitl_checkpoint",
              ownerId: rootId,
            }]);
          }
        },
      },
    });
    manager.startExecution({ slug: "project", workspaceRoot, sessionId: rootId, userMessage: "create owner while stopping" });
    await waitFor(() => runStarted);

    await expect(manager.deleteSession(workspaceRoot, rootId)).rejects.toMatchObject({
      name: "SessionDeleteOwnerConflictError",
      sessionIds: [rootId],
    });

    expect(preflightCount).toBe(2);
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
      executions: [{ id: "execution-running", startedAt: now - 1000, status: "running" }],
      childSessionLinks: [{
        parentSessionId: rootId,
        parentToolCallId: "tool-child",
        toolName: "delegate",
        childSessionId: childId,
        childAgentName: "explore",
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

  test("running subtree delete aborts every running subtree session before removal", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const grandchildId = crypto.randomUUID();
    const siblingId = crypto.randomUUID();
    await writeSessionFile({ sessionId: rootId });
    await writeSessionFile({ sessionId: childId, rootSessionId: rootId, parentSessionId: rootId });
    await writeSessionFile({ sessionId: grandchildId, rootSessionId: rootId, parentSessionId: childId });
    await writeSessionFile({ sessionId: siblingId, rootSessionId: rootId, parentSessionId: rootId });
    await Promise.all([
      storeManager.getOrLoad(rootId, workspaceRoot),
      storeManager.getOrLoad(childId, workspaceRoot),
      storeManager.getOrLoad(grandchildId, workspaceRoot),
      storeManager.getOrLoad(siblingId, workspaceRoot),
    ]);
    const childAgent = new MockAgent(childId, new Promise(() => undefined));
    const grandchildAgent = new MockAgent(grandchildId, new Promise(() => undefined));
    const siblingAgent = new MockAgent(siblingId, new Promise(() => undefined));
    childAgent.store.setState({ rootSessionId: rootId, parentSessionId: rootId });
    grandchildAgent.store.setState({ rootSessionId: rootId, parentSessionId: childId });
    siblingAgent.store.setState({ rootSessionId: rootId, parentSessionId: rootId });
    const { manager } = createManager({ [childId]: childAgent, [grandchildId]: grandchildAgent, [siblingId]: siblingAgent });
    const childExecution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: childId, userMessage: "child" });
    const grandchildExecution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: grandchildId, userMessage: "grandchild" });
    const siblingExecution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: siblingId, userMessage: "sibling" });

    await manager.deleteSession(workspaceRoot, childId);
    await Promise.all([childExecution.promise, grandchildExecution.promise]);

    expect(childExecution.abortController.signal.aborted).toBe(true);
    expect(grandchildExecution.abortController.signal.aborted).toBe(true);
    expect(siblingExecution.abortController.signal.aborted).toBe(false);
    expect(manager.getExecution(workspaceRoot, childId)).toBeUndefined();
    expect(manager.getExecution(workspaceRoot, grandchildId)).toBeUndefined();
    expect(manager.getExecution(workspaceRoot, siblingId)).toBeDefined();
    const stopping = manager.stopSessionFamily(workspaceRoot, rootId);
    await siblingExecution.promise;
    await stopping;
  });

  test("abort timeout throws SessionDeleteConflictError and preserves target files", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    await writeSessionFile({ sessionId: rootId });
    await writeSessionFile({ sessionId: childId, rootSessionId: rootId, parentSessionId: rootId });
    const childAgent = {
      store: storeManager.create(childId, workspaceRoot, {
        rootSessionId: rootId,
        parentSessionId: rootId, agentName: "engineer"
      }),
      cwd: workspaceRoot,
      run: mock(async (): Promise<AgentResult> => await new Promise(() => undefined)),
      dispose: mock(() => undefined),
    } as unknown as MockAgent;
    const { manager, sessionAgentManager } = createManager({ [childId]: childAgent });
    const execution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: childId, userMessage: "child" });
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
      prompt: "first round",
      skills: [],
      background: false,
      currentDepth: 0,
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
      targetAgentName: "explore",
      prompt: "second round",
      currentDepth: 0,
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
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
    const childRun = deferred<AgentResult>();
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
      prompt: "keep working in the original checkout",
      skills: [],
      background: true,
      currentDepth: 0,
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
      targetAgentName: "explore",
      prompt: "write in the new checkout",
      currentDepth: 0,
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
      resolveDelegatedSkills: mock(async () => {
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
      prompt: "launch while skills resolve",
      skills: [],
      background: false,
      currentDepth: 0,
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
        prompt: "must not start",
        skills: [],
        background: false,
        currentDepth: 0,
        parentAbort: undefined,
      })).rejects.toThrow(SessionCwdTransitionInProgressError);

      await expect(manager.resumeChildExecution(workspaceRoot, {
        parentStore,
        parentSessionId: parentId,
        parentToolCallId: "resume-during-transition",
        toolName: "delegate",
        sessionId: child.sessionId,
        targetAgentName: "explore",
        prompt: "must not resume",
        currentDepth: 0,
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
      targetAgentName: "explore",
      prompt: "resume after lease release",
      currentDepth: 0,
      parentAbort: undefined,
    });
    await resumed.result;
    expect(childRunCount).toBe(2);
  });

  test("idle cwd transition leases reject an active root and block new root executions", async () => {
    const sessionId = crypto.randomUUID();
    const run = deferred<AgentResult>();
    const agent = new MockAgent(sessionId, run.promise, workspaceRoot);
    const { manager } = createManager({ [sessionId]: agent });
    const execution = manager.startExecution({
      slug: "project",
      workspaceRoot,
      sessionId,
      userMessage: "finish the loop run",
    });

    expect(() => manager.acquireIdleSessionCwdTransition(workspaceRoot, sessionId))
      .toThrow(SessionCwdTransitionConflictError);

    run.resolve({ text: "done", steps: 1 });
    await execution.promise;
    const releaseTransition = manager.acquireIdleSessionCwdTransition(workspaceRoot, sessionId);
    try {
      expect(() => manager.startExecution({
        slug: "project",
        workspaceRoot,
        sessionId,
        userMessage: "must wait for cleanup",
      })).toThrow(SessionCwdTransitionInProgressError);
    } finally {
      releaseTransition();
    }

    const afterCleanup = manager.startExecution({
      slug: "project",
      workspaceRoot,
      sessionId,
      userMessage: "cleanup finished",
    });
    await afterCleanup.promise;
    expect(manager.getSessionFamilyActivity(workspaceRoot, sessionId)).toBe("idle");
  });

  test("family cwd transition aggregation releases earlier roots when a later root is busy", async () => {
    const firstRoot = "00000000-0000-4000-8000-000000000001";
    const activeRoot = "00000000-0000-4000-8000-000000000002";
    const firstAgent = new MockAgent(firstRoot, Promise.resolve({ text: "idle", steps: 1 }), workspaceRoot);
    const activeRun = deferred<AgentResult>();
    const activeAgent = new MockAgent(activeRoot, activeRun.promise, workspaceRoot);
    const { manager } = createManager({ [firstRoot]: firstAgent, [activeRoot]: activeAgent });
    const execution = manager.startExecution({
      slug: "project",
      workspaceRoot,
      sessionId: activeRoot,
      userMessage: "keep the second family busy",
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

  test("family cwd transition aggregation treats an active HITL generation as busy", () => {
    const firstRoot = "00000000-0000-4000-8000-000000000011";
    const hitlRoot = "00000000-0000-4000-8000-000000000012";
    storeManager.create(firstRoot, workspaceRoot, { agentName: "engineer" });
    storeManager.create(hitlRoot, workspaceRoot, { agentName: "engineer" });
    const { manager } = createManager({}, { factory: makeFactory() });
    const hitlLease = reserveActivatedHitlResume(manager, hitlRoot);

    expect(() => manager.acquireIdleSessionFamilyCwdTransitions(workspaceRoot, [hitlRoot, firstRoot]))
      .toThrow(SessionHitlResumeInProgressError);
    const releaseFirst = manager.acquireIdleSessionCwdTransition(workspaceRoot, firstRoot);
    releaseFirst();

    hitlLease.release();
    const releaseFamilies = manager.acquireIdleSessionFamilyCwdTransitions(workspaceRoot, [hitlRoot, firstRoot]);
    releaseFamilies();
  });

  test("holds an exclusive HITL resume generation across nested cwd transitions and continuation", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const rootStore = storeManager.create(rootId, workspaceRoot, { agentName: "engineer" });
    const childStore = storeManager.create(childId, workspaceRoot, {
      rootSessionId: rootId,
      parentSessionId: rootId,
      agentName: "explore",
    });
    const { manager } = createManager({}, { factory: makeFactory() });

    const lease = reserveActivatedHitlResume(manager, rootId);
    expect(manager.getSessionFamilyActivity(workspaceRoot, rootId)).toBe("running");
    expect(() => manager.startExecution({
      slug: "project",
      workspaceRoot,
      sessionId: rootId,
      userMessage: "must wait",
    })).toThrow(SessionHitlResumeInProgressError);
    await expect(manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId: childId,
      userMessage: "child must wait",
    })).rejects.toThrow(SessionFamilyActiveError);
    await expect(manager.startChildExecution(workspaceRoot, {
      parentStore: rootStore,
      parentSessionId: rootId,
      parentToolCallId: "delegate-during-resume",
      toolName: "delegate",
      targetAgentName: "explore",
      prompt: "must not launch",
      skills: [],
      currentDepth: 0,
      parentAbort: undefined,
    })).rejects.toThrow(SessionHitlResumeInProgressError);
    await expect(manager.resumeChildExecution(workspaceRoot, {
      parentStore: rootStore,
      parentSessionId: rootId,
      parentToolCallId: "resume-during-hitl",
      toolName: "delegate",
      sessionId: childId,
      targetAgentName: "explore",
      prompt: "must not resume",
      currentDepth: 0,
      parentAbort: undefined,
    })).rejects.toThrow(SessionHitlResumeInProgressError);

    expect(() => manager.acquireSessionCwdTransition(workspaceRoot, rootId))
      .toThrow(SessionHitlResumeInProgressError);
    const releaseNestedTransition = lease.acquireSessionCwdTransition(workspaceRoot, rootId);
    expect(() => lease.acquireSessionCwdTransition(workspaceRoot, rootId))
      .toThrow(SessionCwdTransitionInProgressError);
    releaseNestedTransition();

    const aborted = manager.stopSessionFamily(workspaceRoot, rootId);
    expect(lease.abortSignal.aborted).toBe(true);
    let abortWaitSettled = false;
    void aborted.then(() => { abortWaitSettled = true; });
    await Promise.resolve();
    expect(abortWaitSettled).toBe(false);
    lease.release();
    await aborted;
    expect(manager.getSessionFamilyActivity(workspaceRoot, rootId)).toBe("idle");
    expect(childStore.getState().cwd).toBe(rootStore.getState().cwd);
    const releaseTransition = manager.acquireSessionCwdTransition(workspaceRoot, rootId);
    releaseTransition();
  });

  test("a child-owned HITL resume exclusively owns its root family in both directions", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const siblingId = crypto.randomUUID();
    const rootStore = storeManager.create(rootId, workspaceRoot, { agentName: "engineer" });
    storeManager.create(childId, workspaceRoot, {
      rootSessionId: rootId,
      parentSessionId: rootId,
      agentName: "explore",
    });
    storeManager.create(siblingId, workspaceRoot, {
      rootSessionId: rootId,
      parentSessionId: rootId,
      agentName: "explore",
    });
    const { manager } = createManager({}, { factory: makeFactory() });

    const lease = reserveActivatedHitlResume(manager, childId, rootId);
    expect(manager.getSessionFamilyActivity(workspaceRoot, rootId)).toBe("running");
    expect(manager.getExecution(workspaceRoot, childId)).toBeUndefined();
    expect(manager.getExecution(workspaceRoot, siblingId)).toBeUndefined();
    expect(await manager.dispatchCommand(workspaceRoot, rootId, "compact")).toBeNull();
    expect(() => manager.startExecution({
      slug: "project",
      workspaceRoot,
      sessionId: rootId,
      userMessage: "root must wait",
    })).toThrow(SessionHitlResumeInProgressError);
    expect(() => manager.startExecution({
      slug: "project",
      workspaceRoot,
      sessionId: siblingId,
      userMessage: "sibling must wait",
    })).toThrow(SessionHitlResumeInProgressError);
    expect(() => manager.acquireSessionCwdTransition(workspaceRoot, rootId))
      .toThrow(SessionHitlResumeInProgressError);
    await expect(manager.startChildExecution(workspaceRoot, {
      parentStore: rootStore,
      parentSessionId: rootId,
      parentToolCallId: "delegate-during-child-resume",
      toolName: "delegate",
      targetAgentName: "explore",
      prompt: "must not launch",
      skills: [],
      currentDepth: 0,
      parentAbort: undefined,
    })).rejects.toThrow(SessionHitlResumeInProgressError);

    const stopping = manager.stopSessionFamily(workspaceRoot, rootId);
    expect(lease.abortSignal.aborted).toBe(true);
    expect(manager.getSessionFamilyActivity(workspaceRoot, rootId)).toBe("stopping");
    lease.release();
    await stopping;
    expect(manager.getSessionFamilyActivity(workspaceRoot, rootId)).toBe("idle");
  });

  test("rejects HITL ownership while a related execution, transition, or child launch owns the family", async () => {
    const rootId = crypto.randomUUID();
    const rootStore = storeManager.create(rootId, workspaceRoot, { agentName: "engineer" });
    const rootRun = deferred<AgentResult>();
    const rootAgent = new MockAgent(rootId, rootRun.promise, workspaceRoot);
    const skillResolution = deferred<readonly []>();
    let skillResolutionStarted = false;
    const factory = makeFactory({
      resolveDelegatedSkills: mock(async () => {
        skillResolutionStarted = true;
        return await skillResolution.promise;
      }),
    });
    const { manager } = createManager({ [rootId]: rootAgent }, { factory });

    const execution = manager.startExecution({
      slug: "project",
      workspaceRoot,
      sessionId: rootId,
      userMessage: "active",
    });
    expect(() => manager.reserveSessionHitlResume(workspaceRoot, rootId, rootId))
      .toThrow(SessionHitlResumeConflictError);
    rootRun.resolve({ text: "done", steps: 1 });
    await execution.promise;

    const releaseTransition = manager.acquireSessionCwdTransition(workspaceRoot, rootId);
    expect(() => manager.reserveSessionHitlResume(workspaceRoot, rootId, rootId))
      .toThrow(SessionCwdTransitionInProgressError);
    releaseTransition();

    const pendingChild = manager.startChildExecution(workspaceRoot, {
      parentStore: rootStore,
      parentSessionId: rootId,
      parentToolCallId: "pending-child-before-hitl",
      toolName: "delegate",
      targetAgentName: "explore",
      prompt: "resolve skills slowly",
      skills: [],
      currentDepth: 0,
      parentAbort: undefined,
    });
    await waitFor(() => skillResolutionStarted);
    expect(() => manager.reserveSessionHitlResume(workspaceRoot, rootId, rootId))
      .toThrow(SessionHitlResumeConflictError);
    skillResolution.resolve([]);
    const child = await pendingChild;
    await child.result;
  });

  test("rejects a child HITL resume after its root moved to another cwd", () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const nextCwd = join(workspaceRoot, ".worktrees", "next");
    storeManager.create(rootId, workspaceRoot, { agentName: "engineer", cwd: nextCwd });
    storeManager.create(childId, workspaceRoot, {
      rootSessionId: rootId,
      parentSessionId: rootId,
      agentName: "explore",
      cwd: workspaceRoot,
    });
    const { manager } = createManager({});

    const staleLease = manager.reserveSessionHitlResume(workspaceRoot, childId, rootId);
    expect(() => staleLease.activate()).toThrow(ChildSessionCwdMismatchError);
    staleLease.release();
    expect(manager.getSessionFamilyActivity(workspaceRoot, rootId)).toBe("idle");
  });

  test("a cancel-only HITL resume lease cannot acquire a cwd transition", () => {
    const rootId = crypto.randomUUID();
    storeManager.create(rootId, workspaceRoot, { agentName: "engineer" });
    const { manager } = createManager({});

    const lease = reserveActivatedHitlResume(manager, rootId, rootId, { mode: "cancel_only" });
    expect(() => lease.acquireSessionCwdTransition(workspaceRoot, rootId))
      .toThrow(SessionHitlCancelOnlyLeaseError);
    expect(() => manager.acquireSessionCwdTransition(workspaceRoot, rootId))
      .toThrow(SessionHitlResumeInProgressError);

    lease.release();
    const releaseTransition = manager.acquireSessionCwdTransition(workspaceRoot, rootId);
    releaseTransition();
  });

  test("abortAll signals every HITL resume and waits for generation release", async () => {
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    storeManager.create(firstId, workspaceRoot, { agentName: "engineer" });
    storeManager.create(secondId, workspaceRoot, { agentName: "engineer" });
    const { manager } = createManager({});
    const first = reserveActivatedHitlResume(manager, firstId);
    const second = reserveActivatedHitlResume(manager, secondId);

    let settled = false;
    const abortAll = manager.abortAll().then(() => { settled = true; });
    await Promise.resolve();
    expect(first.abortSignal.aborted).toBe(true);
    expect(second.abortSignal.aborted).toBe(true);
    expect(settled).toBe(false);

    first.release();
    await Promise.resolve();
    expect(settled).toBe(false);
    second.release();
    await abortAll;
    expect(settled).toBe(true);
  });

  test("root deletion aborts and waits for a descendant HITL resume before removing the family", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    await writeSessionFile({ sessionId: rootId });
    await writeSessionFile({ sessionId: childId, rootSessionId: rootId, parentSessionId: rootId });
    const coldStores = new SessionStoreManager({ logger: silentLogger });
    await coldStores.getOrLoad(rootId, workspaceRoot);
    await coldStores.getOrLoad(childId, workspaceRoot);
    const { manager } = createManager({}, { storeManager: coldStores });
    const lease = reserveActivatedHitlResume(manager, childId, rootId);

    let deleted = false;
    const deletion = manager.deleteSession(workspaceRoot, rootId).then(() => { deleted = true; });
    await waitFor(() => lease.abortSignal.aborted);
    expect(deleted).toBe(false);
    expect(await Bun.file(getSessionPath(workspaceRoot, rootId)).exists()).toBe(true);
    expect(await Bun.file(getSessionPath(workspaceRoot, childId)).exists()).toBe(true);

    lease.release();
    await deletion;
    expect(deleted).toBe(true);
    expect(await Bun.file(getSessionPath(workspaceRoot, rootId)).exists()).toBe(false);
    expect(await Bun.file(getSessionPath(workspaceRoot, childId)).exists()).toBe(false);
  });

  test("a stale HITL resume release cannot clear a newer generation", () => {
    const rootId = crypto.randomUUID();
    storeManager.create(rootId, workspaceRoot, { agentName: "engineer" });
    const { manager } = createManager({});

    const first = reserveActivatedHitlResume(manager, rootId);
    first.release();
    expect(() => first.acquireSessionCwdTransition(workspaceRoot, rootId))
      .toThrow(SessionHitlResumeLeaseExpiredError);
    const second = reserveActivatedHitlResume(manager, rootId);
    first.release();
    expect(() => first.acquireSessionCwdTransition(workspaceRoot, rootId))
      .toThrow(SessionHitlResumeLeaseExpiredError);

    expect(() => manager.startExecution({
      slug: "project",
      workspaceRoot,
      sessionId: rootId,
      userMessage: "new generation still owns the session",
    })).toThrow(SessionHitlResumeInProgressError);
    second.release();
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
      userMessage: "do not run in the stale checkout",
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

  test("cold-loads a Session and rejects messages while its durable HITL blocker remains", async () => {
    const sessionId = crypto.randomUUID();
    await writeSessionFile({ sessionId, blockedByHitlIds: ["hitl-pending"] });
    const coldStores = new SessionStoreManager({ logger: silentLogger });
    const { manager } = createManager({}, { storeManager: coldStores });

    await expect(manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId,
      userMessage: "must wait for the HITL response",
    })).rejects.toMatchObject({
      name: "SessionHitlBlockedError",
      sessionId,
      hitlIds: ["hitl-pending"],
    });
    expect(manager.getSessionFamilyActivity(workspaceRoot, sessionId)).toBe("idle");
  });

  test("checked Goal start rejects a durable sibling HITL at the final family barrier", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const siblingHitlId = crypto.randomUUID();
    await writeSessionFile({ sessionId: rootId, goalId: crypto.randomUUID() });
    await writeSessionFile({
      sessionId: childId,
      rootSessionId: rootId,
      parentSessionId: rootId,
      blockedByHitlIds: [siblingHitlId],
    });
    const coldStores = new SessionStoreManager({ logger: silentLogger });
    const { manager } = createManager({}, { storeManager: coldStores });

    await expect(manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId: rootId,
      userMessage: "must not bypass child HITL",
    })).rejects.toMatchObject({
      name: "SessionHitlBlockedError",
      sessionId: rootId,
      hitlIds: [siblingHitlId],
    });
    expect(manager.getSessionFamilyActivity(workspaceRoot, rootId)).toBe("idle");
  });

  test("validates persisted execution scope before claiming a user-message execution", async () => {
    const sessionId = crypto.randomUUID();
    const loopId = crypto.randomUUID();
    const origin = {
      kind: "loop" as const,
      loopId,
      runId: crypto.randomUUID(),
      trigger: "manual" as const,
      approvalPolicy: "interactive" as const,
    };
    storeManager.create(sessionId, workspaceRoot, { loopId, sessionRole: "main", agentName: "engineer" });
    const conflict = new SessionExecutionScopeConflictError(
      "SESSION_LOOP_EXECUTION_SCOPE_REQUIRED",
      sessionId,
      "scope rejected",
    );
    const validate = mock(async () => { throw conflict; });
    const { manager, sessionAgentManager } = createManager({}, {
      executionScopeValidator: { validate },
    });

    await expect(manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId,
      userMessage: "continue",
      origin,
    })).rejects.toBe(conflict);

    expect(validate).toHaveBeenCalledWith({
      projectRoot: workspaceRoot,
      subject: {
        sessionId,
        rootSessionId: sessionId,
        cwd: workspaceRoot,
        loopId,
        sessionRole: "main",
        agentName: "engineer",
      },
      entry: { kind: "user_message", origin },
    });
    expect(sessionAgentManager.getOrCreate).not.toHaveBeenCalled();
    expect(manager.getSessionFamilyActivity(workspaceRoot, sessionId)).toBe("idle");
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
      userMessage: "continue",
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
      userMessage: "continue",
    });
    await validationStarted.promise;

    expect(manager.listPendingCheckedStarts(workspaceRoot)).toEqual([{ sessionId }]);
    const closeLease = manager.acquireWorkspaceClose(workspaceRoot);
    await expect(manager.startCheckedExecution({
      slug: "project",
      workspaceRoot,
      sessionId: crypto.randomUUID(),
      userMessage: "must not start while closing",
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
      userMessage: "continue",
    });
    await validationStarted.promise;
    store.setState({
      goalId: crypto.randomUUID(),
      loopId: crypto.randomUUID(),
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
        changedFields: ["goalId", "loopId", "rootSessionId", "parentSessionId", "sessionRole"],
      },
    });
    expect(manager.getSessionFamilyActivity(workspaceRoot, sessionId)).toBe("idle");
  });

  test("re-checks the synchronous resume guard after async message preparation", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    storeManager.create(rootId, workspaceRoot, { agentName: "engineer" });
    storeManager.create(childId, workspaceRoot, {
      rootSessionId: rootId,
      parentSessionId: rootId,
      agentName: "explore",
    });
    const childLoad = deferred<ReturnType<SessionStoreManager["create"]>>();
    const callbacks = storeCallbacks(storeManager);
    const sessionAgentManager = createFakeManager({}, { factory: makeFactory() });
    const manager = new SessionExecutionManager({
      sessionAgentManager,
      ...callbacks,
      loadSessionStore: async (sessionId, root) => {
        if (sessionId === childId) return await childLoad.promise;
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
      userMessage: "race with durable resume",
    });
    const resumeLease = reserveActivatedHitlResume(manager, rootId);
    childLoad.resolve(storeManager.get(childId, workspaceRoot)!);

    await expect(pendingMessage).rejects.toThrow(SessionFamilyActiveError);
    expect(manager.getExecution(workspaceRoot, childId)).toBeUndefined();
    resumeLease.release();
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
      ...callbacks,
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
      userMessage: "race with cwd transition",
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
    const resumedRun = deferred<AgentResult>();
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
      targetAgentName: "explore",
      prompt: "second round",
      currentDepth: 0,
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
    });
    parentStore.getState().append({
      type: "tool-child-session-link",
      link: {
        parentSessionId: parentId,
        parentToolCallId: "initial-call",
        toolName: "delegate",
        childSessionId,
        childAgentName: "explore",
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
      listSessionFamilyBlockedHitlIds: async () => (++checks === 1 ? [] : ["raced-resume-hitl"]),
    });

    await expect(manager.resumeChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "resume-call",
      toolName: "delegate",
      sessionId: childSessionId,
      targetAgentName: "explore",
      prompt: "must not resume",
      currentDepth: 0,
      parentAbort: undefined,
    })).rejects.toMatchObject({ name: "SessionHitlBlockedError", hitlIds: ["raced-resume-hitl"] });
    expect(parentStore.getState().childSessionLinks.at(-1)).toMatchObject({ status: "completed" });
    expect(childAgent.runMock).not.toHaveBeenCalled();
  });

  test("resumeChildExecution preserves matching Loop origin for the continued child", async () => {
    const parentId = crypto.randomUUID();
    const childSessionId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, {
      agentName: "engineer",
      loopId: LOOP_ORIGIN.loopId,
    });
    const childStore = storeManager.create(childSessionId, workspaceRoot, {
      rootSessionId: parentId,
      parentSessionId: parentId,
      agentName: "explore",
      loopId: LOOP_ORIGIN.loopId,
    });
    const childAgent = new MockAgent(childSessionId, Promise.resolve({ text: "resumed", steps: 1 }), workspaceRoot);
    childAgent.store.setState({
      rootSessionId: parentId,
      parentSessionId: parentId,
      agentName: "explore",
      loopId: LOOP_ORIGIN.loopId,
      append: childStore.getState().append,
    });
    const { manager } = createManager({ [childSessionId]: childAgent }, { factory: makeFactory() });

    const resumed = await manager.resumeChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "loop-resume-call",
      toolName: "delegate",
      sessionId: childSessionId,
      targetAgentName: "explore",
      prompt: "continue under Loop guardrails",
      currentDepth: 0,
      parentAbort: undefined,
      origin: LOOP_ORIGIN,
    });
    await resumed.result;

    const runOptions = childAgent.runMock.mock.calls[0]?.[1];
    if (!runOptions || runOptions instanceof AbortSignal) throw new Error("Expected AgentRunOptions");
    expect(runOptions.origin).toEqual(LOOP_ORIGIN);
  });

  test("resumeChildExecution rejects parent and child Sessions from different Loops", async () => {
    const parentId = crypto.randomUUID();
    const childSessionId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, {
      agentName: "engineer",
      loopId: LOOP_ORIGIN.loopId,
    });
    storeManager.create(childSessionId, workspaceRoot, {
      rootSessionId: parentId,
      parentSessionId: parentId,
      agentName: "explore",
      loopId: "loop-other",
    });
    const { manager } = createManager({}, { factory: makeFactory() });

    await expect(manager.resumeChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "loop-resume-call",
      toolName: "delegate",
      sessionId: childSessionId,
      targetAgentName: "explore",
      prompt: "continue",
      currentDepth: 0,
      parentAbort: undefined,
      origin: LOOP_ORIGIN,
    })).rejects.toThrow(ChildSessionLoopScopeMismatchError);

    const matchingChildId = crypto.randomUUID();
    storeManager.create(matchingChildId, workspaceRoot, {
      rootSessionId: parentId,
      parentSessionId: parentId,
      agentName: "explore",
      loopId: LOOP_ORIGIN.loopId,
    });
    await expect(manager.resumeChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "loop-resume-call-without-origin",
      toolName: "delegate",
      sessionId: matchingChildId,
      targetAgentName: "explore",
      prompt: "continue",
      currentDepth: 0,
      parentAbort: undefined,
    })).rejects.toThrow(ChildSessionLoopScopeMismatchError);
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
    const resumedRun = deferred<AgentResult>();
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
      targetAgentName: "explore",
      prompt: "second round",
      background: true,
      currentDepth: 0,
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
    const childRun = deferred<AgentResult>();
    const { manager } = createManager({}, { factory: makeFactory(), childRun: childRun.promise });

    const first = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "running-tool-call",
      toolName: "delegate",
      targetAgentName: "explore",
      prompt: "first round",
      skills: [],
      background: false,
      currentDepth: 0,
      parentAbort: undefined,
    });

    await expect(manager.resumeChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "running-tool-call",
      toolName: "delegate",
      sessionId: first.sessionId,
      targetAgentName: "explore",
      prompt: "second round",
      currentDepth: 0,
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
    childStore.setState({ blockedByHitlIds: ["hitl-child-pending"] });
    const { manager } = createManager({}, { factory: makeFactory() });
    const linksBefore = parentStore.getState().childSessionLinks.length;

    await expect(manager.resumeChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "resume-blocked-child",
      toolName: "delegate",
      sessionId: childId,
      targetAgentName: "explore",
      prompt: "must wait for HITL",
      currentDepth: 0,
      parentAbort: undefined,
    })).rejects.toThrow(SessionHitlBlockedError);

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
      sessionId: "nonexistent-session-id",
      targetAgentName: "explore",
      prompt: "resume",
      currentDepth: 0,
      parentAbort: undefined,
    })).rejects.toThrow(ChildSessionNotFoundError);
  });

  test("resumeChildExecution with mismatched agent name throws ChildSessionAgentMismatchError", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
    const { manager } = createManager({}, { factory: makeFactory() });

    const first = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "mismatch-tool-call",
      toolName: "delegate",
      targetAgentName: "explore",
      prompt: "first round",
      skills: [],
      background: false,
      currentDepth: 0,
      parentAbort: undefined,
    });
    await first.result;

    await expect(manager.resumeChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "mismatch-tool-call",
      toolName: "delegate",
      sessionId: first.sessionId,
      targetAgentName: "engineer",
      prompt: "second round",
      currentDepth: 0,
      parentAbort: undefined,
    })).rejects.toThrow(ChildSessionAgentMismatchError);
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
      prompt: "first round",
      skills: [],
      background: false,
      currentDepth: 0,
      parentAbort: undefined,
    });
    await first.result;

    await expect(manager.resumeChildExecution(workspaceRoot, {
      parentStore: otherParentStore,
      parentSessionId: otherParentId,
      parentToolCallId: "parent-tool-call",
      toolName: "delegate",
      sessionId: first.sessionId,
      targetAgentName: "explore",
      prompt: "second round",
      currentDepth: 0,
      parentAbort: undefined,
    })).rejects.toThrow(ChildSessionParentMismatchError);
  });

  test("cancelChildSession on running descendant aborts, marks link cancelled, appends reminder", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "engineer" });
    const childRun = deferred<AgentResult>();
    const { manager } = createManager({}, { factory: makeFactory(), childRun: childRun.promise });

    const child = await manager.startChildExecution(workspaceRoot, {
      parentStore,
      parentSessionId: parentId,
      parentToolCallId: "cancel-tool-call",
      toolName: "delegate",
      targetAgentName: "explore",
      prompt: "running",
      skills: [],
      background: true,
      currentDepth: 0,
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

  test("cancelChildSession cascades to grandchildren", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const grandchildId = crypto.randomUUID();
    const rootStore = storeManager.create(rootId, workspaceRoot, { agentName: "engineer" });
    const childStore = storeManager.create(childId, workspaceRoot, { rootSessionId: rootId, parentSessionId: rootId, agentName: "explore" });
    const grandchildStore = storeManager.create(grandchildId, workspaceRoot, { rootSessionId: rootId, parentSessionId: childId, agentName: "explore" });
    rootStore.getState().append({ type: "tool-child-session-link", link: makeChildLink(rootId, childId, "explore") });
    childStore.getState().append({ type: "tool-child-session-link", link: makeChildLink(childId, grandchildId, "explore") });
    const childRun = deferred<AgentResult>();
    const grandchildRun = deferred<AgentResult>();
    const childAgent = new MockAgent(childId, childRun.promise);
    const grandchildAgent = new MockAgent(grandchildId, grandchildRun.promise);
    const { manager } = createManager({ [childId]: childAgent, [grandchildId]: grandchildAgent });
    const childExecution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: childId, userMessage: "child", origin: "tool_call" });
    const grandchildExecution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: grandchildId, userMessage: "grandchild", origin: "tool_call" });
    await Promise.resolve();

    expect(manager.cancelChildSession(workspaceRoot, rootId, childId)).toBe(true);
    childRun.resolve({ text: "done", steps: 1 });
    grandchildRun.resolve({ text: "done", steps: 1 });
    await Promise.all([childExecution.promise, grandchildExecution.promise]);

    expect(childExecution.abortController.signal.aborted).toBe(true);
    expect(grandchildExecution.abortController.signal.aborted).toBe(true);
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
      prompt: "done",
      skills: [],
      background: false,
      currentDepth: 0,
      parentAbort: undefined,
    });
    await child.result;

    expect(manager.cancelChildSession(workspaceRoot, parentId, child.sessionId)).toBe(false);
  });
});
