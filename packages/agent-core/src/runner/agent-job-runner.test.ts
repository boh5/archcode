import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createEmptySessionStats } from "@specra/protocol";
import type { Agent, AgentResult, AgentRunOptions } from "../agents/types";
import { AgentRunningError, ConcurrentSessionLimitError } from "../agents/errors";
import type { SessionAgentManager } from "../agents/session-agent-manager";
import type { CommandResult } from "../commands/types";
import type { AskUserResponse } from "../deferred";
import { SessionDeleteConflictError } from "../store/errors";
import type { SessionFile } from "../store/helpers";
import { SessionStoreManager } from "../store/session-store-manager";
import { getRootSessionDir, getRootSessionPath, getSessionPath } from "../store/sessions-dir";
import type { AskUserRequest, ToolConfirmationRequest, ToolConfirmationResult } from "../tools/types";
import { AgentJobRunner } from "./agent-job-runner";
import { silentLogger } from "../logger";

const workspaceRoot = join(import.meta.dir, "__test_tmp__", "agent-job-runner-workspace");
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
    return await withAbort(this.result, signal);
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
    dispose: mock(() => undefined),
  } as unknown as SessionAgentManager;
}

function createRunner(agents: Record<string, MockAgent>, options: FakeManagerOptions = {}) {
  const sessionAgentManager = createFakeManager(agents, options);
  const runnerStoreManager = options.storeManager ?? storeManager;
  const cleanupDeferredSession = mock(() => undefined);
  const requestPermission = mock(async (_root: string, _sessionId: string, _request: ToolConfirmationRequest): Promise<ToolConfirmationResult> => "approve_once");
  const requestQuestion = mock(async (_root: string, _sessionId: string, _request: AskUserRequest): Promise<AskUserResponse> => ({ answers: [] }));
  const trackSession = mock(() => undefined);
  const untrackSession = mock(() => undefined);
  const runner = new AgentJobRunner({
    sessionAgentManager,
    storeManager: runnerStoreManager,
    requestPermission,
    requestQuestion,
    cleanupDeferredSession,
    trackSession,
    untrackSession,
    logger: silentLogger,
  });
  return { runner, sessionAgentManager, cleanupDeferredSession, requestPermission, requestQuestion, trackSession, untrackSession };
}

async function writeSessionFile(input: {
  sessionId: string;
  rootSessionId?: string;
  parentSessionId?: string;
  title?: string;
}): Promise<void> {
  const rootSessionId = input.rootSessionId ?? input.sessionId;
  const file: SessionFile = {
    sessionId: input.sessionId,
    createdAt: Date.now(),
    title: input.title ?? null,
    messages: [],
    steps: [],
    stats: createEmptySessionStats(),
    executions: [],
    todos: [],
    reminders: [],
    childSessionLinks: [],
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

describe("AgentJobRunner", () => {
  beforeEach(async () => {
    storeManager.clearAll();
    await rm(workspaceRoot, { recursive: true, force: true });
    await mkdir(workspaceRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  test("submit starts a job and rejects duplicate same-session submits", async () => {
    const run = deferred<AgentResult>();
    const agent = new MockAgent("session-start", run.promise);
    const { runner } = createRunner({ "session-start": agent });

    const job = runner.submit({ slug: "project", workspaceRoot, sessionId: "session-start", userMessage: "hello" });

    expect(job.sessionId).toBe("session-start");
    expect(runner.isRunning(workspaceRoot, "session-start")).toBe(true);
    expect(() => runner.submit({ slug: "project", workspaceRoot, sessionId: "session-start", userMessage: "again" })).toThrow(AgentRunningError);
    await Promise.resolve();
    expect(agent.runMock).toHaveBeenCalledWith("hello", expect.objectContaining({ abort: job.abortController.signal }));
    run.resolve({ text: "done", steps: 1 });
    await job.promise;
    expect(runner.isRunning(workspaceRoot, "session-start")).toBe(false);
  });

  test("enforces concurrent session limit with ConcurrentSessionLimitError", () => {
    const agentOne = new MockAgent("one", new Promise(() => undefined));
    const agentTwo = new MockAgent("two", new Promise(() => undefined));
    const { runner } = createRunner({ one: agentOne, two: agentTwo }, { maxConcurrentSessions: 1 });

    runner.submit({ slug: "project", workspaceRoot, sessionId: "one", userMessage: "one" });

    expect(() => runner.submit({ slug: "project", workspaceRoot, sessionId: "two", userMessage: "two" })).toThrow(ConcurrentSessionLimitError);
  });

  test("abort and abortAndWait cancel running jobs", async () => {
    const agent = new MockAgent("abort", new Promise(() => undefined));
    const { runner } = createRunner({ abort: agent });

    const job = runner.submit({ slug: "project", workspaceRoot, sessionId: "abort", userMessage: "stop" });
    expect(runner.abort(workspaceRoot, "abort")).toBe(true);
    await job.promise;
    expect(job.abortController.signal.aborted).toBe(true);
    expect(runner.isRunning(workspaceRoot, "abort")).toBe(false);

    const agentTwo = new MockAgent("abort-wait", new Promise(() => undefined));
    const second = createRunner({ "abort-wait": agentTwo });
    const secondJob = second.runner.submit({ slug: "project", workspaceRoot, sessionId: "abort-wait", userMessage: "stop" });
    await second.runner.abortAndWait(workspaceRoot, "abort-wait");
    await secondJob.promise;
    expect(secondJob.abortController.signal.aborted).toBe(true);
  });

  test("bridges run options to core permission and question services", async () => {
    const agent = new MockAgent("callbacks", Promise.resolve({ text: "done", steps: 1 }));
    const { runner, requestPermission, requestQuestion } = createRunner({ callbacks: agent });

    const job = runner.submit({ slug: "project", workspaceRoot, sessionId: "callbacks", userMessage: "work" });
    await job.promise;
    const options = agent.runMock.mock.calls[0]?.[1];
    if (!options || options instanceof AbortSignal) throw new Error("Expected AgentRunOptions");
    await options.confirmPermission?.({ toolName: "bash", toolCallId: "call", input: {}, description: "confirm" });
    await options.askUser?.({ toolName: "ask_user", toolCallId: "ask", questions: [] });

    expect(requestPermission).toHaveBeenCalled();
    expect(requestQuestion).toHaveBeenCalled();
  });

  test("subscribes session events without exposing stores", async () => {
    const run = deferred<AgentResult>();
    const agent = new MockAgent("events", run.promise);
    const { runner } = createRunner({ events: agent });
    const received: unknown[] = [];
    const unsubscribe = runner.subscribe({ slug: "project", workspaceRoot, sessionId: "events", onEvent: (event) => received.push(event) });

    const job = runner.submit({ slug: "project", workspaceRoot, sessionId: "events", userMessage: "work" });
    await Promise.resolve();
    agent.store.getState().append({ type: "system-notice", message: "hello" });

    expect(received).toMatchObject([{ type: "event", slug: "project", sessionId: "events", kind: "system-notice" }]);
    unsubscribe();
    run.resolve({ text: "done", steps: 1 });
    await job.promise;
  });

  test("subscribes child session events when the child store attaches after subscription", async () => {
    const child = new MockAgent("child-events", Promise.resolve({ text: "done", steps: 1 }));
    const { runner } = createRunner({ "child-events": child });
    const received: unknown[] = [];

    const unsubscribe = runner.subscribe({ slug: "project", workspaceRoot, sessionId: "child-events", onEvent: (event) => received.push(event) });
    const job = runner.submit({ slug: "project", workspaceRoot, sessionId: "child-events", userMessage: "work" });
    await Promise.resolve();
    child.store.getState().append({ type: "system-notice", message: "child" });

    expect(received).toMatchObject([{ type: "event", slug: "project", sessionId: "child-events", kind: "system-notice" }]);
    unsubscribe();
    await job.promise;
  });

  test("root delete removes root file and descendant directory", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const grandchildId = crypto.randomUUID();
    await writeSessionFile({ sessionId: rootId });
    await writeSessionFile({ sessionId: childId, rootSessionId: rootId, parentSessionId: rootId });
    await writeSessionFile({ sessionId: grandchildId, rootSessionId: rootId, parentSessionId: childId });
    const { runner, sessionAgentManager, untrackSession } = createRunner({});

    await runner.deleteSession(workspaceRoot, rootId);

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
    const { runner } = createRunner({});

    await runner.deleteSession(workspaceRoot, childId);

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
    const { runner } = createRunner({}, { storeManager: manager });

    await runner.deleteSession(workspaceRoot, childId);

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
    const { runner: childDeleteRunner, sessionAgentManager: childAgentManager, untrackSession: untrackChildSession } = createRunner({}, { storeManager: coldChildStoreManager });

    await childDeleteRunner.deleteSession(workspaceRoot, firstChildId);

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
    const { runner: rootDeleteRunner, sessionAgentManager: rootAgentManager, untrackSession: untrackRootSession } = createRunner({}, { storeManager: coldRootStoreManager });

    await rootDeleteRunner.deleteSession(workspaceRoot, secondRootId);

    expect(await Bun.file(getRootSessionPath(workspaceRoot, secondRootId)).exists()).toBe(false);
    expect(await Bun.file(getRootSessionDir(workspaceRoot, secondRootId)).exists()).toBe(false);
    expect(rootAgentManager.dispose).toHaveBeenCalledTimes(3);
    expect(untrackRootSession).toHaveBeenCalledTimes(3);
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
    const { runner } = createRunner({ [childId]: childAgent, [grandchildId]: grandchildAgent, [siblingId]: siblingAgent });
    const childJob = runner.submit({ slug: "project", workspaceRoot, sessionId: childId, userMessage: "child" });
    const grandchildJob = runner.submit({ slug: "project", workspaceRoot, sessionId: grandchildId, userMessage: "grandchild" });
    const siblingJob = runner.submit({ slug: "project", workspaceRoot, sessionId: siblingId, userMessage: "sibling" });

    await runner.deleteSession(workspaceRoot, childId);
    await Promise.all([childJob.promise, grandchildJob.promise]);

    expect(childJob.abortController.signal.aborted).toBe(true);
    expect(grandchildJob.abortController.signal.aborted).toBe(true);
    expect(siblingJob.abortController.signal.aborted).toBe(false);
    expect(runner.isRunning(workspaceRoot, childId)).toBe(false);
    expect(runner.isRunning(workspaceRoot, grandchildId)).toBe(false);
    expect(runner.isRunning(workspaceRoot, siblingId)).toBe(true);
    runner.abort(workspaceRoot, siblingId);
    await siblingJob.promise;
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
    const { runner, sessionAgentManager } = createRunner({ [childId]: childAgent });
    const job = runner.submit({ slug: "project", workspaceRoot, sessionId: childId, userMessage: "child" });
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
        await runner.deleteSession(workspaceRoot, childId);
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
    expect(job.abortController.signal.aborted).toBe(true);
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
