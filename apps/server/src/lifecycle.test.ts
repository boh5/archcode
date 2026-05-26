import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { StoreApi } from "zustand";
import type { Agent, AgentResult, AgentRunOptions } from "@specra/agent-core";
import type { SpecraRuntime } from "@specra/agent-core";
import { SessionStoreManager } from "@specra/agent-core";
import type { SessionStoreState } from "@specra/agent-core";
import type { ToolConfirmationCallback } from "@specra/agent-core";
import { AgentRunner } from "./agent-runner";
import { globalEventBus } from "./events/global-event-bus";
import { __resetSessionEventBridgesForTest, registerSessionEventBridge } from "./events/session-event-bridge";
import { setupGracefulShutdown, type ShutdownSignal, type SignalProcess } from "./lifecycle";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "lifecycle");
const manager = new SessionStoreManager();

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

type RunMock = ReturnType<typeof mock<(message: string, options?: AgentRunOptions | AbortSignal) => Promise<AgentResult>>>;

function isJobRunning(runner: AgentRunner, workspaceRoot: string, sessionId: string): boolean {
  return (runner.isRunning as unknown as (workspaceRoot: string, sessionId: string) => boolean)(workspaceRoot, sessionId);
}

class MockAgent implements Agent {
  readonly store: StoreApi<SessionStoreState>;
  readonly runMock: RunMock;

  constructor(sessionId: string, result: Promise<AgentResult>, workspaceRoot: string = tempRoot) {
    this.store = manager.create(sessionId, workspaceRoot);
    this.runMock = mock(async (_message: string, options?: AgentRunOptions | AbortSignal) => {
      const signal = options instanceof AbortSignal ? options : options?.abort;
      return await withAbort(result, signal);
    });
  }

  run(
    userMessage: string,
    abort?: AbortSignal,
    confirmPermission?: ToolConfirmationCallback,
  ): Promise<AgentResult>;
  run(userMessage: string, options?: AgentRunOptions): Promise<AgentResult>;
  run(userMessage: string, options?: AgentRunOptions | AbortSignal): Promise<AgentResult> {
    return this.runMock(userMessage, options);
  }

  dispose(): void {}
}

class ExitError extends Error {
  readonly code: number | undefined;

  constructor(code: number | undefined) {
    super(`exit:${code}`);
    this.name = "ExitError";
    this.code = code;
  }
}

function deferred<T>(): Deferred<T> {
  let resolveValue: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolveValue = resolvePromise;
  });

  return { promise, resolve: resolveValue };
}

function createRuntime(agent: Agent): SpecraRuntime {
  const sessionId = agent.store.getState().sessionId;
  return {
    sessionAgentManager: {
      get: (_workspaceRoot: string, requestedSessionId: string) => (requestedSessionId === sessionId ? agent : undefined),
      getOrCreate: async () => agent,
      dispose: () => undefined,
      disposeAll: () => undefined,
      getByWorkspace: () => [],
      isTombstoned: () => false,
      acquireSlot: () => undefined,
      releaseSlot: () => undefined,
      abortAndDispose: async () => undefined,
    },
    storeManager: manager,
    mcpManager: undefined,
    toolRegistry: undefined,
    providerRegistry: undefined,
    warnings: [],
    projectRegistry: undefined,
    contextResolver: undefined,
    agentFor: async (_root: string, _sid: string) => agent,
  } as unknown as SpecraRuntime;
}

function createProcess() {
  const handlers = new Map<ShutdownSignal, () => void>();
  const processRef: SignalProcess = {
    on: mock((signal: ShutdownSignal, handler: () => void) => {
      handlers.set(signal, handler);
    }),
    off: mock((signal: ShutdownSignal) => {
      handlers.delete(signal);
    }),
    exit: mock((code?: number): never => {
      throw new ExitError(code);
    }),
  };

  return { handlers, processRef };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
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

describe("server lifecycle", () => {
  beforeEach(async () => {
    manager.clearAll();
    __resetSessionEventBridgesForTest();
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(tempRoot, { recursive: true });
  });

  afterAll(async () => {
    __resetSessionEventBridgesForTest();
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("abortAll aborts all running jobs", async () => {
    const agentOne = new MockAgent("abort-all-one", new Promise(() => undefined));
    const agentTwo = new MockAgent("abort-all-two", new Promise(() => undefined));
    const runnerOne = new AgentRunner(createRuntime(agentOne));
    const runnerTwo = new AgentRunner(createRuntime(agentTwo));

    const jobOne = runnerOne.submit({ slug: "project-one", sessionId: "abort-all-one", workspaceRoot: tempRoot, userMessage: "one" });
    const jobTwo = runnerTwo.submit({ slug: "project-two", sessionId: "abort-all-two", workspaceRoot: tempRoot, userMessage: "two" });

    await runnerOne.abortAll();

    expect(jobOne.abortController.signal.aborted).toBe(true);
    expect(jobTwo.abortController.signal.aborted).toBe(true);
    expect(isJobRunning(runnerOne, tempRoot, "abort-all-one")).toBe(false);
    expect(isJobRunning(runnerTwo, tempRoot, "abort-all-two")).toBe(false);
  });

  test("setupGracefulShutdown registers signal handlers", () => {
    const { handlers, processRef } = createProcess();
    const server = { stop: mock(() => undefined) };
    const runner = new AgentRunner(createRuntime(new MockAgent("handlers", Promise.resolve({ text: "ok", steps: 1 }))));

    const handle = setupGracefulShutdown(server, runner, { process: processRef });

    expect(processRef.on).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(processRef.on).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(handlers.has("SIGINT")).toBe(true);
    expect(handlers.has("SIGTERM")).toBe(true);

    handle.dispose();
    expect(processRef.off).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(processRef.off).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
  });

  test("shutdown sequence pushes SSE shutdown, aborts, waits, stops, then exits", async () => {
    const order: string[] = [];
    const run = deferred<AgentResult>();
    const agent = new MockAgent("sequence-session", run.promise);
    const runner = new AgentRunner(createRuntime(agent));
    const globalEvents: unknown[] = [];
    const unsubscribeGlobalEvents = globalEventBus.subscribe((event) => globalEvents.push(event));
    const job = runner.submit({ slug: "sequence-project", sessionId: "sequence-session", workspaceRoot: tempRoot, userMessage: "work" });
    await flushMicrotasks();

    const server = { stop: mock(() => order.push("stop")) };
    const { handlers, processRef } = createProcess();
    const originalAbortAll = runner.abortAll.bind(runner);
    runner.abortAll = mock(async () => {
      order.push("abort");
      const done = originalAbortAll();
      order.push("wait");
      await done;
    });
    processRef.exit = mock((code?: number): never => {
      order.push(`exit:${code}`);
      throw new ExitError(code);
    });

    const handle = setupGracefulShutdown(server, runner, { process: processRef, log: () => undefined });
    expect(handlers.has("SIGTERM")).toBe(true);
    const shutdownPromise = expect(handle.shutdown("SIGTERM")).rejects.toMatchObject({
      name: "ExitError",
      code: 0,
    });
    await flushMicrotasks();
    run.resolve({ text: "done", steps: 1 });
    await shutdownPromise;
    await job.promise;
    unsubscribeGlobalEvents();

    expect(agent.store.getState().events.at(-1)?.payload).toEqual({ type: "shutdown", reason: "server_shutdown" });
    expect(globalEvents).toContainEqual({ type: "shutdown", reason: "server_shutdown" });
    expect(order).toEqual(["abort", "wait", "stop", "exit:0"]);
  });

  test("shutdown appends terminal events for every bridged active session before aborting", async () => {
    const order: string[] = [];
    const agentOne = new MockAgent("terminal-one", new Promise(() => undefined), resolve(tempRoot, "workspace-one"));
    const agentTwo = new MockAgent("terminal-two", new Promise(() => undefined), resolve(tempRoot, "workspace-two"));
    const coldAgent = new MockAgent("terminal-cold", new Promise(() => undefined), resolve(tempRoot, "workspace-cold"));
    registerSessionEventBridge({ slug: "one", workspaceRoot: resolve(tempRoot, "workspace-one"), sessionId: "terminal-one", store: agentOne.store });
    registerSessionEventBridge({ slug: "two", workspaceRoot: resolve(tempRoot, "workspace-two"), sessionId: "terminal-two", store: agentTwo.store });
    const runner = new AgentRunner(createRuntime(agentOne));
    runner.abortAll = mock(async () => {
      order.push("abort");
      expect(agentOne.store.getState().events.at(-1)?.payload).toEqual({ type: "shutdown", reason: "server_shutdown" });
      expect(agentTwo.store.getState().events.at(-1)?.payload).toEqual({ type: "shutdown", reason: "server_shutdown" });
      expect(coldAgent.store.getState().events).toHaveLength(0);
    });
    const server = { stop: mock(() => order.push("stop")) };
    const { processRef } = createProcess();
    processRef.exit = mock((code?: number): never => {
      order.push(`exit:${code}`);
      throw new ExitError(code);
    });

    const handle = setupGracefulShutdown(server, runner, { process: processRef, log: () => undefined });

    await expect(handle.shutdown("SIGTERM")).rejects.toMatchObject({ name: "ExitError", code: 0 });
    expect(order).toEqual(["abort", "stop", "exit:0"]);
    expect(agentOne.store.getState().events.filter((event) => event.payload.type === "shutdown")).toHaveLength(1);
    expect(agentTwo.store.getState().events.filter((event) => event.payload.type === "shutdown")).toHaveLength(1);
    expect(coldAgent.store.getState().events).toHaveLength(0);
  });

  test("shutdown exits with code 1 when running jobs exceed timeout", async () => {
    const server = { stop: mock(() => undefined) };
    const runner = new AgentRunner(createRuntime(new MockAgent("timeout", Promise.resolve({ text: "ok", steps: 1 }))));
    runner.abortAll = mock(async () => {
      await new Promise(() => undefined);
    });
    const { handlers, processRef } = createProcess();
    const error = mock((_message: string) => undefined);

    const handle = setupGracefulShutdown(server, runner, { process: processRef, timeoutMs: 1, log: () => undefined, error });
    expect(handlers.has("SIGINT")).toBe(true);

    await expect(handle.shutdown("SIGINT")).rejects.toMatchObject({
      name: "ExitError",
      code: 1,
    });
    expect(error).toHaveBeenCalledWith("Graceful shutdown timed out after 1ms");
    expect(server.stop).toHaveBeenCalled();
  });
});
