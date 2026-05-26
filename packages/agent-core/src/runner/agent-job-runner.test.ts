import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Agent, AgentResult, AgentRunOptions } from "../agents/types";
import { AgentRunningError, ConcurrentSessionLimitError } from "../agents/errors";
import type { SessionAgentManager } from "../agents/session-agent-manager";
import type { CommandResult } from "../commands/types";
import type { AskUserResponse } from "../deferred";
import { SessionStoreManager } from "../store/session-store-manager";
import type { AskUserRequest, ToolConfirmationRequest, ToolConfirmationResult } from "../tools/types";
import { AgentJobRunner } from "./agent-job-runner";

const workspaceRoot = join(import.meta.dir, "__test_tmp__", "agent-job-runner-workspace");
const storeManager = new SessionStoreManager();

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
  const cleanupDeferredSession = mock(() => undefined);
  const requestPermission = mock(async (_root: string, _sessionId: string, _request: ToolConfirmationRequest): Promise<ToolConfirmationResult> => "approve_once");
  const requestQuestion = mock(async (_root: string, _sessionId: string, _request: AskUserRequest): Promise<AskUserResponse> => ({ answers: [] }));
  const runner = new AgentJobRunner({
    sessionAgentManager: createFakeManager(agents, options),
    storeManager,
    requestPermission,
    requestQuestion,
    cleanupDeferredSession,
    trackSession: mock(() => undefined),
    untrackSession: mock(() => undefined),
  });
  return { runner, cleanupDeferredSession, requestPermission, requestQuestion };
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
});
