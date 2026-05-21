import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { StoreApi } from "zustand";
import { AgentRunningError } from "@specra/agent-core";
import type { Agent, AgentResult, AgentRunOptions } from "@specra/agent-core";
import type { CommandResult } from "@specra/agent-core";
import type { SpecraRuntime } from "@specra/agent-core";
import { loadSessionTranscript } from "@specra/agent-core";
import { createSessionStore } from "@specra/agent-core";
import type { SessionStoreState } from "@specra/agent-core";
import type { ToolConfirmationCallback } from "@specra/agent-core";
import { AgentRunner } from "./agent-runner";
import { GlobalEventBus } from "./events/global-event-bus";
import { __getSessionEventBridgeCountForTest, __resetSessionEventBridgesForTest, __setGlobalEventBusForTest } from "./events/session-event-bridge";
import { PermissionService } from "./permission-service";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "agent-runner");

const createScopedSessionStore = createSessionStore as unknown as typeof createSessionStore & ((sessionId: string, workspaceRoot: string) => ReturnType<typeof createSessionStore>);
interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

type RunMock = ReturnType<typeof mock<(message: string, options?: AgentRunOptions | AbortSignal) => Promise<AgentResult>>>;

function abortJob(runner: AgentRunner, workspaceRoot: string, sessionId: string): boolean {
  return (runner.abort as unknown as (workspaceRoot: string, sessionId: string) => boolean)(workspaceRoot, sessionId);
}

function isJobRunning(runner: AgentRunner, workspaceRoot: string, sessionId: string): boolean {
  return (runner.isRunning as unknown as (workspaceRoot: string, sessionId: string) => boolean)(workspaceRoot, sessionId);
}

async function dispatchRunnerCommand(
  runner: AgentRunner,
  workspaceRoot: string,
  sessionId: string,
  name: string,
  args?: string,
): Promise<CommandResult | null> {
  return await (runner.dispatchCommand as unknown as (
    workspaceRoot: string,
    sessionId: string,
    name: string,
    args?: string,
  ) => Promise<CommandResult | null>)(workspaceRoot, sessionId, name, args);
}

class MockAgent implements Agent {
  readonly store: StoreApi<SessionStoreState>;
  readonly runMock: RunMock;

  constructor(sessionId: string, result: Promise<AgentResult>, workspaceRoot: string = tempRoot) {
    this.store = createScopedSessionStore(sessionId, workspaceRoot);
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

function deferred<T>(): Deferred<T> {
  let resolveValue: (value: T) => void = () => undefined;
  let rejectValue: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });

  return { promise, resolve: resolveValue, reject: rejectValue };
}

function createMockAgent(sessionId: string, result: Promise<AgentResult>, workspaceRoot: string = tempRoot): MockAgent {
  return new MockAgent(sessionId, result, workspaceRoot);
}

function createRuntime(agent: Agent): SpecraRuntime {
  const sessionId = agent.store.getState().sessionId;
  const runningSessions = new Set<string>();
  let runningAgent: Agent | undefined;
  return {
    sessionAgentManager: {
      get: (_workspaceRoot: string, requestedSessionId: string) => {
        const isRunning = runningSessions.has(requestedSessionId);
        if (!isRunning || runningAgent === undefined) return undefined;

        const activeAgent = runningAgent;
        runningAgent = undefined;
        return activeAgent;
      },
      getOrCreate: async () => agent,
      dispose: () => undefined,
      disposeAll: () => undefined,
      getByWorkspace: () => [],
      isTombstoned: () => false,
      acquireSlot: () => undefined,
      releaseSlot: (_workspaceRoot: string, requestedSessionId: string) => {
        runningSessions.delete(requestedSessionId);
        runningAgent = undefined;
      },
      abortAndDispose: async () => undefined,
    },
    mcpManager: undefined,
    toolRegistry: undefined,
    providerRegistry: undefined,
    warnings: [],
    projectRegistry: undefined,
    contextResolver: undefined,
    agentFor: async (_workspaceRoot: string, requestedSessionId: string) => {
      if (requestedSessionId === sessionId) {
        runningSessions.add(requestedSessionId);
        runningAgent = agent;
      }
      return agent;
    },
    dispatchCommand: async (_workspaceRoot: string, requestedSessionId: string, name: string, args?: string) => {
      const isRunning = runningSessions.has(requestedSessionId);
      if (!isRunning || runningAgent === undefined) return null;

      const dispatchable = runningAgent as Agent & { dispatchCommand?: (name: string, args?: string) => Promise<CommandResult> };
      return await dispatchable.dispatchCommand?.(name, args) ?? null;
    },
  } as unknown as SpecraRuntime;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return await promise;
  }

  signal.throwIfAborted();
  return await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    }),
  ]);
}

describe("AgentRunner", () => {
  beforeEach(async () => {
    __resetSessionEventBridgesForTest();
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(tempRoot, { recursive: true });
  });

  afterAll(async () => {
    __resetSessionEventBridgesForTest();
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("submit starts a job and returns RunningJob with jobId", async () => {
    const run = deferred<AgentResult>();
    const agent = createMockAgent("session-start", run.promise);
    const runner = new AgentRunner(createRuntime(agent));

    const job = runner.submit({ slug: "project-start", sessionId: "session-start", workspaceRoot: tempRoot, userMessage: "Hello" });

    expect(job.sessionId).toBe("session-start");
    expect(job.workspaceRoot).toBe(tempRoot);
    expect(typeof job.jobId).toBe("string");
    expect(job.abortController.signal.aborted).toBe(false);
    await flushMicrotasks();
    expect(agent.runMock).toHaveBeenCalledWith("Hello", { abort: job.abortController.signal });
  });

  test("submit injects confirmPermission callback when PermissionService is provided", async () => {
    const agent = createMockAgent("session-permission", Promise.resolve({ text: "Done", steps: 1 }));
    const permissionService = new PermissionService();
    const runner = new AgentRunner(createRuntime(agent), permissionService);

    const job = runner.submit({ slug: "project-permission", sessionId: "session-permission", workspaceRoot: tempRoot, userMessage: "Needs permission" });
    await job.promise;
    await flushMicrotasks();

    const [_message, options] = agent.runMock.mock.calls[0];
    if (!options || options instanceof AbortSignal) {
      throw new Error("Expected AgentRunOptions");
    }

    expect(typeof options.confirmPermission).toBe("function");
    const promise = options.confirmPermission?.({
      toolName: "bash",
      toolCallId: "call-1",
      input: {},
      description: "Confirm",
    });
    const permissionEvent = agent.store.getState().events.find((event) => event.kind === "permission.request");
    const permissionId = permissionEvent?.payload.type === "permission.request"
      ? permissionEvent.payload.permissionId
      : undefined;

    if (permissionId === undefined) {
      throw new Error("Expected permission request event");
    }
    expect(permissionService.respond(permissionId, "deny")).toBe(true);
    await expect(promise).resolves.toBe("deny");
  });

  test("submit for same sessionId twice throws AgentRunningError", () => {
    const run = deferred<AgentResult>();
    const agent = createMockAgent("session-duplicate", run.promise);
    const runner = new AgentRunner(createRuntime(agent));

    runner.submit({ slug: "project-duplicate", sessionId: "session-duplicate", workspaceRoot: tempRoot, userMessage: "First" });

    expect(() => runner.submit({ slug: "project-duplicate", sessionId: "session-duplicate", workspaceRoot: tempRoot, userMessage: "Second" })).toThrow(AgentRunningError);
  });

  test("isRunning returns true while running and false after completion", async () => {
    const run = deferred<AgentResult>();
    const agent = createMockAgent("session-running", run.promise);
    const runner = new AgentRunner(createRuntime(agent));

    const job = runner.submit({ slug: "project-running", sessionId: "session-running", workspaceRoot: tempRoot, userMessage: "Hello" });
    expect(isJobRunning(runner, tempRoot, "session-running")).toBe(true);

    run.resolve({ text: "Done", steps: 1 });
    await job.promise;

    expect(isJobRunning(runner, tempRoot, "session-running")).toBe(false);
  });

  test("abort cancels the job and isRunning becomes false", async () => {
    const agent = createMockAgent("session-abort", new Promise(() => undefined));
    const runner = new AgentRunner(createRuntime(agent));

    const job = runner.submit({ slug: "project-abort", sessionId: "session-abort", workspaceRoot: tempRoot, userMessage: "Stop me" });
    const aborted = abortJob(runner, tempRoot, "session-abort");
    await job.promise;

    expect(aborted).toBe(true);
    expect(job.abortController.signal.aborted).toBe(true);
    expect(isJobRunning(runner, tempRoot, "session-abort")).toBe(false);
  });

  test("after agent.run completes, session transcript is saved", async () => {
    const workspaceRoot = join(tempRoot, "workspace-save");
    await mkdir(workspaceRoot, { recursive: true });
    const agent = createMockAgent("session-save", Promise.resolve({ text: "Saved", steps: 1 }), workspaceRoot);
    agent.store.getState().append({ type: "user-message", content: "persist me" });
    const runner = new AgentRunner(createRuntime(agent));

    const job = runner.submit({ slug: "project-save", sessionId: "session-save", workspaceRoot, userMessage: "persist me" });
    await job.promise;
    await flushMicrotasks();

    const saved = await loadSessionTranscript("session-save", workspaceRoot);
    expect(saved.getState().messages).toHaveLength(1);
  });

  test("does not save transcript when session is tombstoned before job settles", async () => {
    const workspaceRoot = join(tempRoot, "workspace-tombstone");
    await mkdir(workspaceRoot, { recursive: true });
    const run = deferred<AgentResult>();
    const agent = createMockAgent("session-tombstone", run.promise, workspaceRoot);
    agent.store.getState().append({ type: "user-message", content: "do not resurrect" });
    let tombstoned = false;
    const runtime = createRuntime(agent);
    runtime.sessionAgentManager.isTombstoned = () => tombstoned;
    const runner = new AgentRunner(runtime);

    const job = runner.submit({ slug: "project-tombstone", sessionId: "session-tombstone", workspaceRoot, userMessage: "delete me" });
    await flushMicrotasks();
    tombstoned = true;
    run.resolve({ text: "Done", steps: 1 });
    await job.promise;

    await expect(loadSessionTranscript("session-tombstone", workspaceRoot)).rejects.toThrow();
  });

  test("acquires and releases per-workspace session slots", async () => {
    const run = deferred<AgentResult>();
    const agent = createMockAgent("session-slot", run.promise);
    const runtime = createRuntime(agent);
    const acquired: string[] = [];
    const released: string[] = [];
    runtime.sessionAgentManager.acquireSlot = (_workspaceRoot: string, sessionId: string) => acquired.push(sessionId);
    runtime.sessionAgentManager.releaseSlot = (_workspaceRoot: string, sessionId: string) => released.push(sessionId);
    const runner = new AgentRunner(runtime);

    const job = runner.submit({ slug: "project-slot", sessionId: "session-slot", workspaceRoot: tempRoot, userMessage: "Hello" });
    expect(acquired).toEqual(["session-slot"]);

    run.resolve({ text: "Done", steps: 1 });
    await job.promise;

    expect(released).toEqual(["session-slot"]);
  });

  test("dispatchCommand returns null without running configured agent and delegates while running", async () => {
    const run = deferred<AgentResult>();
    const commandResult: CommandResult = { success: true, message: "dispatched" };
    const dispatchCommand = mock(async (_name: string, _args?: string) => commandResult);
    const agent = createMockAgent("session-command", run.promise) as MockAgent & { dispatchCommand: typeof dispatchCommand };
    agent.dispatchCommand = dispatchCommand;
    const runner = new AgentRunner(createRuntime(agent));

    const missingResult = await dispatchRunnerCommand(runner, tempRoot, "missing", "compact");
    expect(missingResult).toBeNull();

    const job = runner.submit({ slug: "project-command", sessionId: "session-command", workspaceRoot: tempRoot, userMessage: "Hello" });
    await flushMicrotasks();

    const runningResult = await dispatchRunnerCommand(runner, tempRoot, "session-command", "compact", "now");
    expect(runningResult).toEqual(commandResult);
    expect(dispatchCommand).toHaveBeenCalledWith("compact", "now");

    run.resolve({ text: "Done", steps: 1 });
    await job.promise;
    const completedResult = await dispatchRunnerCommand(runner, tempRoot, "session-command", "compact");
    expect(completedResult).toBeNull();
  });

  test("submit registers active agent store with the global session event bridge", async () => {
    const bus = new GlobalEventBus();
    const received: unknown[] = [];
    __setGlobalEventBusForTest(bus);
    bus.subscribe((event) => received.push(event));
    const run = deferred<AgentResult>();
    const agent = createMockAgent("session-bridge", run.promise);
    const runner = new AgentRunner(createRuntime(agent));

    const job = runner.submit({ slug: "project-bridge", sessionId: "session-bridge", workspaceRoot: tempRoot, userMessage: "Hello" });
    await flushMicrotasks();
    agent.store.getState().append({ type: "system-notice", message: "bridged" });

    expect(received).toMatchObject([
      { type: "event", slug: "project-bridge", sessionId: "session-bridge", eventId: 0, kind: "system-notice" },
    ]);

    run.resolve({ text: "Done", steps: 1 });
    await job.promise;
  });

  test("unregisters the session event bridge after a job settles", async () => {
    const bus = new GlobalEventBus();
    const received: unknown[] = [];
    __setGlobalEventBusForTest(bus);
    bus.subscribe((event) => received.push(event));
    const agent = createMockAgent("session-bridge-cleanup", Promise.resolve({ text: "Done", steps: 1 }));
    const runner = new AgentRunner(createRuntime(agent));

    const job = runner.submit({
      slug: "project-bridge-cleanup",
      sessionId: "session-bridge-cleanup",
      workspaceRoot: tempRoot,
      userMessage: "Hello",
    });
    await flushMicrotasks();
    expect(__getSessionEventBridgeCountForTest()).toBe(1);

    await job.promise;
    expect(__getSessionEventBridgeCountForTest()).toBe(0);

    agent.store.getState().append({ type: "system-notice", message: "after cleanup" });
    expect(received).toEqual([]);
  });
});
