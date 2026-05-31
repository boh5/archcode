import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createEmptySessionStats } from "@specra/protocol";
import type { Agent, AgentResult, AgentRunOptions } from "../agents/types";
import { AgentRunningError, ConcurrentLimitError, ConcurrentSessionLimitError, DelegateTargetNotAllowedError, DepthLimitError } from "../agents/errors";
import type { SessionAgentManager } from "../agents/session-agent-manager";
import type { CommandResult } from "../commands/types";
import type { AskUserResponse } from "../deferred";
import { SessionDeleteConflictError } from "../store/errors";
import type { SessionFile } from "../store/helpers";
import { SessionStoreManager } from "../store/session-store-manager";
import { getRootSessionDir, getRootSessionPath, getSessionPath } from "../store/sessions-dir";
import type { AskUserRequest, ToolConfirmationRequest, ToolConfirmationResult } from "../tools/types";
import { SessionExecutionManager } from "./session-execution-manager";
import { silentLogger } from "../logger";
import type { SessionStoreState, ToolChildSessionLink } from "../store/types";
import type { AgentFactory } from "../agents/factory";
import type { AgentDefinition } from "../agents/factory-types";

const workspaceRoot = join(import.meta.dir, "__test_tmp__", "session-execution-manager-workspace");
const storeManager = new SessionStoreManager({ logger: silentLogger });

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

class MockAgent implements Agent {
  readonly store;
  readonly runMock = mock(async (_message: string, options?: AgentRunOptions | AbortSignal): Promise<AgentResult> => {
    const signal = options instanceof AbortSignal ? options : options?.abort;
    const result = await withAbort(this.result, signal);
    this.store.getState().append({ type: "text-start" });
    this.store.getState().append({ type: "text-delta", text: result.text });
    this.store.getState().append({ type: "text-end" });
    return result;
  });
  dispatchCommandMock?: (name: string, args?: string) => Promise<CommandResult>;

  constructor(
    readonly sessionId: string,
    readonly result: Promise<AgentResult>,
    readonly workspaceRoot: string = "/workspace",
  ) {
    this.store = storeManager.create(sessionId, workspaceRoot);
  }

  run(userMessage: string, abort?: AbortSignal): Promise<AgentResult>;
  run(userMessage: string, options?: AgentRunOptions): Promise<AgentResult>;
  run(userMessage: string, options?: AgentRunOptions | AbortSignal): Promise<AgentResult> {
    return this.runMock(userMessage, options);
  }

  async dispatchCommand(name: string, args?: string): Promise<CommandResult> {
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
  requestPermission?: SessionExecutionManagerConfigForTest["requestPermission"];
  requestQuestion?: SessionExecutionManagerConfigForTest["requestQuestion"];
  cleanupDeferredSession?: () => void;
}

type SessionExecutionManagerConfigForTest = ConstructorParameters<typeof SessionExecutionManager>[0];

function storeCallbacks(manager: SessionStoreManager): Pick<
  SessionExecutionManagerConfigForTest,
  "createSessionStore" | "getSessionStore" | "deleteSessionStore" | "resolveRootSessionId" | "buildSessionTree"
> {
  return {
    createSessionStore: (sessionId, root, createOptions) => manager.create(sessionId, root, createOptions),
    getSessionStore: (sessionId, root) => manager.get(sessionId, root),
    deleteSessionStore: (sessionId, root, deleteOptions) => manager.delete(sessionId, root, deleteOptions),
    resolveRootSessionId: (sessionId, root) => manager.resolveRootSessionId(sessionId, root),
    buildSessionTree: (root, rootSessionId) => manager.buildSessionTree(root, rootSessionId),
  };
}

function createFakeManager(agents: Record<string, MockAgent>, options: FakeManagerOptions = {}): SessionAgentManager {
  const activeByWorkspace = new Map<string, Set<string>>();
  const max = options.maxConcurrentSessions ?? 4;
  return {
    getOrCreate: mock(async (_root: string, sessionId: string) => agents[sessionId]!),
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
        run: mock(async (_message: string, runOptions?: AgentRunOptions | AbortSignal): Promise<AgentResult> => {
          const signal = runOptions instanceof AbortSignal ? runOptions : runOptions?.abort;
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
  } as unknown as SessionAgentManager;
}

function makeFactory(overrides: Partial<AgentFactory> = {}): AgentFactory {
  const parentDefinition: AgentDefinition = {
    name: "orchestrator",
    promptProfileId: "default",
    tools: { tools: ["delegate"], delegateTargets: ["explore"] },
    hooks: { autoCompact: false, autoInjectReminder: false, todoContinuation: false, transcriptSave: false, memoryExtraction: false, memoryConsolidation: false, titleGeneration: "disabled" },
    childPolicy: { maxDepth: 2, maxConcurrent: 1, timeoutMs: 0, abortCascade: true, terminalReminders: true },
    includeMemoryInPrompt: false,
    skills: [],
  };
  const childDefinition: AgentDefinition = { ...parentDefinition, name: "explore", tools: { tools: [] }, childPolicy: undefined };
  return {
    createRootAgent: mock(() => { throw new Error("unused"); }),
    createAgent: mock(() => { throw new Error("unused"); }),
    getDefinition: mock((name: string) => {
      if (name === "orchestrator") return parentDefinition;
      if (name === "explore") return childDefinition;
      throw new Error(`Unknown agent definition: ${name}`);
    }),
    listAgentNames: mock(() => ["orchestrator", "explore"]),
    resolveAllowedTools: mock((definition: AgentDefinition) => definition.tools.tools),
    getDelegateTargetsFor: mock((definition: AgentDefinition) => definition.tools.delegateTargets ?? []),
    resolveDelegatedSkills: mock(async () => []),
    ...overrides,
  } as AgentFactory;
}

function createManager(agents: Record<string, MockAgent>, options: FakeManagerOptions = {}) {
  const sessionAgentManager = createFakeManager(agents, options);
  const executionStoreManager = options.storeManager ?? storeManager;
  const cleanupDeferredSession = mock(options.cleanupDeferredSession ?? (() => undefined));
  const requestPermission = mock(options.requestPermission ?? (async (_root: string, _sessionId: string, _request: ToolConfirmationRequest): Promise<ToolConfirmationResult> => "approve_once"));
  const requestQuestion = mock(options.requestQuestion ?? (async (_root: string, _sessionId: string, _request: AskUserRequest): Promise<AskUserResponse> => ({ answers: [] })));
  const trackSession = mock(() => undefined);
  const untrackSession = mock(() => undefined);
  const manager = new SessionExecutionManager({
    sessionAgentManager,
    ...storeCallbacks(executionStoreManager),
    requestPermission,
    requestQuestion,
    cleanupDeferredSession,
    trackSession,
    untrackSession,
    logger: silentLogger,
  });
  return { manager, sessionAgentManager, cleanupDeferredSession, requestPermission, requestQuestion, trackSession, untrackSession };
}

async function writeSessionFile(input: {
  sessionId: string;
  rootSessionId?: string;
  parentSessionId?: string;
  title?: string;
  executions?: SessionFile["executions"];
  childSessionLinks?: SessionFile["childSessionLinks"];
}): Promise<void> {
  const rootSessionId = input.rootSessionId ?? input.sessionId;
  const file: SessionFile = {
    sessionId: input.sessionId,
    createdAt: Date.now(),
    agentName: input.parentSessionId === undefined ? "orchestrator" : "explore",
    title: input.title ?? null,
    messages: [],
    steps: [],
    stats: createEmptySessionStats(),
    executions: input.executions ?? [],
    todos: [],
    reminders: [],
    childSessionLinks: input.childSessionLinks ?? [],
    rootSessionId,
    ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
  };
  if (input.sessionId !== rootSessionId) {
    await mkdir(getRootSessionDir(workspaceRoot, rootSessionId), { recursive: true });
  } else {
    await mkdir(join(workspaceRoot, ".specra", "sessions"), { recursive: true });
  }
  await Bun.write(getSessionPath(workspaceRoot, rootSessionId, input.sessionId), JSON.stringify(file, null, 2));
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

  test("startExecution starts an execution and rejects duplicate same-session starts", async () => {
    const run = deferred<AgentResult>();
    const agent = new MockAgent("session-start", run.promise);
    const { manager } = createManager({ "session-start": agent });

    const execution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: "session-start", userMessage: "hello" });

    expect(execution.sessionId).toBe("session-start");
    expect(execution.agentName).toBe("orchestrator");
    expect(execution.origin).toBe("user_message");
    expect(typeof execution.executionToken).toBe("symbol");
    expect(manager.isRunning(workspaceRoot, "session-start")).toBe(true);
    expect(() => manager.startExecution({ slug: "project", workspaceRoot, sessionId: "session-start", userMessage: "again" })).toThrow(AgentRunningError);
    await Promise.resolve();
    expect(agent.runMock).toHaveBeenCalledWith("hello", expect.objectContaining({ abort: execution.abortController.signal }));
    run.resolve({ text: "done", steps: 1 });
    await execution.promise;
    expect(manager.isRunning(workspaceRoot, "session-start")).toBe(false);
  });

  test("enforces concurrent session limit with ConcurrentSessionLimitError", () => {
    const agentOne = new MockAgent("one", new Promise(() => undefined));
    const agentTwo = new MockAgent("two", new Promise(() => undefined));
    const { manager } = createManager({ one: agentOne, two: agentTwo }, { maxConcurrentSessions: 1 });

    manager.startExecution({ slug: "project", workspaceRoot, sessionId: "one", userMessage: "one" });

    expect(() => manager.startExecution({ slug: "project", workspaceRoot, sessionId: "two", userMessage: "two" })).toThrow(ConcurrentSessionLimitError);
  });

  test("atomically rejects duplicate starts while agent creation is pending", () => {
    const sessionAgentManager = createFakeManager({});
    const pendingManager = new SessionExecutionManager({
      sessionAgentManager: {
        ...sessionAgentManager,
        getOrCreate: mock(async () => await new Promise<Agent>(() => undefined)),
      } as unknown as SessionAgentManager,
      ...storeCallbacks(storeManager),
      requestPermission: mock(async (): Promise<ToolConfirmationResult> => "approve_once"),
      requestQuestion: mock(async (): Promise<AskUserResponse> => ({ answers: [] })),
      cleanupDeferredSession: mock(() => undefined),
      trackSession: mock(() => undefined),
      untrackSession: mock(() => undefined),
      logger: silentLogger,
    });

    pendingManager.startExecution({ slug: "project", workspaceRoot, sessionId: "pending-create", userMessage: "one" });

    expect(() => pendingManager.startExecution({ slug: "project", workspaceRoot, sessionId: "pending-create", userMessage: "two" })).toThrow(AgentRunningError);
  });

  test("abort cancels execution and ignores late tool result after current execution is settled", async () => {
    const run = deferred<AgentResult>();
    const agent = new MockAgent("stale", run.promise, workspaceRoot);
    const { manager } = createManager({ stale: agent });

    const execution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: "stale", userMessage: "work" });
    await Promise.resolve();
    agent.store.getState().append({ type: "tool-input-start", toolCallId: "late-tool", toolName: "bash" });
    agent.store.getState().append({ type: "tool-call", toolCallId: "late-tool", toolName: "bash", input: {} });
    expect(manager.abort(workspaceRoot, "stale")).toBe(true);
    run.resolve({ text: "done", steps: 1 });
    await execution.promise;
    agent.store.getState().append({ type: "tool-result", toolCallId: "late-tool", toolName: "bash", output: "late", isError: false });

    const state = agent.store.getState();
    expect(state.executions).toHaveLength(1);
    expect(state.executions[0]?.status).toBe("cancelled");
    const tool = state.messages.flatMap((message) => message.parts).find((part) => part.type === "tool");
    expect(tool).toMatchObject({ type: "tool", state: "error", errorMessage: "Execution ended before tool result" });
  });

  test("permission and question requests are cleaned up on cancel", async () => {
    const permission = deferred<ToolConfirmationResult>();
    const question = deferred<AskUserResponse>();
    const agent = {
      store: storeManager.create("deferred-cancel", workspaceRoot),
      run: mock(async (_message: string, options?: AgentRunOptions | AbortSignal): Promise<AgentResult> => {
        if (!options || options instanceof AbortSignal) throw new Error("expected run options");
        await Promise.all([
          options.confirmPermission?.({ toolName: "bash", toolCallId: "perm", input: {}, description: "confirm" }),
          options.askUser?.({ toolName: "ask_user", toolCallId: "ask", questions: [] }),
        ]);
        return { text: "done", steps: 1 };
      }),
      dispose: mock(() => undefined),
    } as unknown as MockAgent;
    const cleanupDeferredSession = mock(() => {
      permission.resolve("timeout");
      question.resolve({ isError: true, reason: "Cancelled" });
    });
    const { manager } = createManager({ "deferred-cancel": agent }, {
      cleanupDeferredSession,
      requestPermission: async (_root, _sessionId, _request, abortSignal) => {
        abortSignal?.addEventListener("abort", () => permission.resolve("timeout"), { once: true });
        return await permission.promise;
      },
      requestQuestion: async () => await question.promise,
    });

    const execution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: "deferred-cancel", userMessage: "work" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.abort(workspaceRoot, "deferred-cancel")).toBe(true);
    await execution.promise;

    expect(cleanupDeferredSession).toHaveBeenCalledWith(workspaceRoot, "deferred-cancel");
    expect(agent.store.getState().executions.at(-1)?.status).toBe("cancelled");
  });

  test("abort cascades to active descendant sessions", async () => {
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
    const childExecution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: childId, userMessage: "child", origin: "tool_call", agentName: "explore" });
    const grandchildExecution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: grandchildId, userMessage: "grandchild", origin: "tool_call", agentName: "explore" });
    const siblingExecution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: siblingId, userMessage: "sibling", origin: "tool_call", agentName: "explore" });
    await Promise.resolve();

    expect(manager.abort(workspaceRoot, childId)).toBe(true);
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

  test("abort is isolated by workspace root for identical session ids", async () => {
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
      requestPermission: mock(async (): Promise<ToolConfirmationResult> => "approve_once"),
      requestQuestion: mock(async (): Promise<AskUserResponse> => ({ answers: [] })),
      cleanupDeferredSession: mock(() => undefined),
      trackSession: mock(() => undefined),
      untrackSession: mock(() => undefined),
      logger: silentLogger,
    });
    const executionA = manager.startExecution({ slug: "project-a", workspaceRoot, sessionId: "same-session", userMessage: "a" });
    const executionB = managerB.startExecution({ slug: "project-b", workspaceRoot: otherWorkspaceRoot, sessionId: "same-session", userMessage: "b" });

    expect(manager.abort(workspaceRoot, "same-session")).toBe(true);
    runA.resolve({ text: "done", steps: 1 });
    await executionA.promise;

    expect(executionA.abortController.signal.aborted).toBe(true);
    expect(executionB.abortController.signal.aborted).toBe(false);
    runB.resolve({ text: "done", steps: 1 });
    await executionB.promise;
    await rm(otherWorkspaceRoot, { recursive: true, force: true });
  });

  test("abort and abortAndWait cancel running executions", async () => {
    const agent = new MockAgent("abort", new Promise(() => undefined));
    const { manager } = createManager({ abort: agent });

    const execution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: "abort", userMessage: "stop" });
    expect(manager.abort(workspaceRoot, "abort")).toBe(true);
    await execution.promise;
    expect(execution.abortController.signal.aborted).toBe(true);
    expect(manager.isRunning(workspaceRoot, "abort")).toBe(false);

    const agentTwo = new MockAgent("abort-wait", new Promise(() => undefined));
    const second = createManager({ "abort-wait": agentTwo });
    const secondExecution = second.manager.startExecution({ slug: "project", workspaceRoot, sessionId: "abort-wait", userMessage: "stop" });
    await second.manager.abortAndWait(workspaceRoot, "abort-wait");
    await secondExecution.promise;
    expect(secondExecution.abortController.signal.aborted).toBe(true);
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
    expect(manager.isRunning(workspaceRoot, "abort-all-one")).toBe(false);
    expect(manager.isRunning(workspaceRoot, "abort-all-two")).toBe(false);
  });

  test("bridges run options to core permission and question services", async () => {
    const agent = new MockAgent("callbacks", Promise.resolve({ text: "done", steps: 1 }));
    const { manager, requestPermission, requestQuestion } = createManager({ callbacks: agent });

    const execution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: "callbacks", userMessage: "work" });
    await execution.promise;
    const options = agent.runMock.mock.calls[0]?.[1];
    if (!options || options instanceof AbortSignal) throw new Error("Expected AgentRunOptions");
    await options.confirmPermission?.({ toolName: "bash", toolCallId: "call", input: {}, description: "confirm" });
    await options.askUser?.({ toolName: "ask_user", toolCallId: "ask", questions: [] });

    expect(requestPermission).toHaveBeenCalled();
    expect(requestQuestion).toHaveBeenCalled();
  });

  test("startChildExecution validates through factory and runs a child session", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "orchestrator" });
    const factory = makeFactory();
    const { manager, sessionAgentManager } = createManager({}, { factory });

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

  test("link write failure prevents child creation/start and releases reserved slot", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "orchestrator" });
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
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "orchestrator" });
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
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "orchestrator" });
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

  test("sync child execution exposes live parent link and bridged child events before resolving", async () => {
    const parentId = crypto.randomUUID();
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "orchestrator" });
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

  test("startChildExecution marks failed and timed-out children with terminal link statuses", async () => {
    const failedParentId = crypto.randomUUID();
    const failedParentStore = storeManager.create(failedParentId, workspaceRoot, { agentName: "orchestrator" });
    const failedRun = Promise.reject(new Error("child exploded"));
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
    const timedParentStore = storeManager.create(timedParentId, workspaceRoot, { agentName: "orchestrator" });
    const timed = createManager({}, {
      factory: makeFactory({
        getDefinition: mock((name: string) => {
          const base = makeFactory().getDefinition(name);
          if (name === "orchestrator") return { ...base, childPolicy: { ...base.childPolicy!, timeoutMs: 1 } };
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
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "orchestrator" });
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
    const parentStore = storeManager.create(parentId, workspaceRoot, { agentName: "orchestrator" });
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

    expect(await Bun.file(getRootSessionPath(workspaceRoot, rootId)).exists()).toBe(false);
    expect(await Bun.file(getRootSessionDir(workspaceRoot, rootId)).exists()).toBe(false);
    expect(sessionAgentManager.dispose).toHaveBeenCalledTimes(3);
    expect(untrackSession).toHaveBeenCalledTimes(3);
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

    expect(await Bun.file(getRootSessionPath(workspaceRoot, rootId)).exists()).toBe(true);
    expect(await Bun.file(getSessionPath(workspaceRoot, rootId, childId)).exists()).toBe(false);
    expect(await Bun.file(getSessionPath(workspaceRoot, rootId, grandchildId)).exists()).toBe(false);
    expect(await Bun.file(getSessionPath(workspaceRoot, rootId, siblingId)).exists()).toBe(true);
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

    expect(await Bun.file(getRootSessionPath(workspaceRoot, firstRootId)).exists()).toBe(true);
    expect(await Bun.file(getSessionPath(workspaceRoot, firstRootId, firstChildId)).exists()).toBe(false);
    expect(await Bun.file(getSessionPath(workspaceRoot, firstRootId, firstGrandchildId)).exists()).toBe(false);
    expect(await Bun.file(getSessionPath(workspaceRoot, firstRootId, firstSiblingId)).exists()).toBe(true);
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

    expect(await Bun.file(getRootSessionPath(workspaceRoot, secondRootId)).exists()).toBe(false);
    expect(await Bun.file(getRootSessionDir(workspaceRoot, secondRootId)).exists()).toBe(false);
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
    const childAgent = new MockAgent(childId, new Promise(() => undefined));
    const grandchildAgent = new MockAgent(grandchildId, new Promise(() => undefined));
    const siblingAgent = new MockAgent(siblingId, new Promise(() => undefined));
    const { manager } = createManager({ [childId]: childAgent, [grandchildId]: grandchildAgent, [siblingId]: siblingAgent });
    const childExecution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: childId, userMessage: "child" });
    const grandchildExecution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: grandchildId, userMessage: "grandchild" });
    const siblingExecution = manager.startExecution({ slug: "project", workspaceRoot, sessionId: siblingId, userMessage: "sibling" });

    await manager.deleteSession(workspaceRoot, childId);
    await Promise.all([childExecution.promise, grandchildExecution.promise]);

    expect(childExecution.abortController.signal.aborted).toBe(true);
    expect(grandchildExecution.abortController.signal.aborted).toBe(true);
    expect(siblingExecution.abortController.signal.aborted).toBe(false);
    expect(manager.isRunning(workspaceRoot, childId)).toBe(false);
    expect(manager.isRunning(workspaceRoot, grandchildId)).toBe(false);
    expect(manager.isRunning(workspaceRoot, siblingId)).toBe(true);
    manager.abort(workspaceRoot, siblingId);
    await siblingExecution.promise;
  });

  test("abort timeout throws SessionDeleteConflictError and preserves target files", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    await writeSessionFile({ sessionId: rootId });
    await writeSessionFile({ sessionId: childId, rootSessionId: rootId, parentSessionId: rootId });
    const childAgent = {
      store: storeManager.create(childId),
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

    expect(await Bun.file(getSessionPath(workspaceRoot, rootId, childId)).exists()).toBe(true);
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
    await rm(getSessionPath(workspaceRoot, rootId, siblingId));

    expect(await storeManager.resolveRootSessionId(siblingId, workspaceRoot)).toBe(rootId);
  });
});
