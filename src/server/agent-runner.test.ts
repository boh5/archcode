import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { StoreApi } from "zustand";
import { AgentRunningError } from "../agents/errors";
import type { Agent, AgentResult, AgentRunOptions } from "../agents/types";
import type { SpecraRuntime } from "../main";
import { loadSessionTranscript } from "../store/helpers";
import { createSessionStore } from "../store/store";
import type { SessionStoreState } from "../store/types";
import type { ToolConfirmationCallback } from "../tools";
import { AgentRunner } from "./agent-runner";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "agent-runner");

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

type RunMock = ReturnType<typeof mock<(message: string, options?: AgentRunOptions | AbortSignal) => Promise<AgentResult>>>;

class MockAgent implements Agent {
  readonly store: StoreApi<SessionStoreState>;
  readonly runMock: RunMock;

  constructor(sessionId: string, result: Promise<AgentResult>) {
    this.store = createSessionStore(sessionId);
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

function createMockAgent(sessionId: string, result: Promise<AgentResult>): MockAgent {
  return new MockAgent(sessionId, result);
}

function createRuntime(agent: Agent): SpecraRuntime {
  return {
    agent: undefined,
    mcpManager: undefined,
    toolRegistry: undefined,
    providerRegistry: undefined,
    warnings: [],
    projectRegistry: undefined,
    contextResolver: undefined,
    agentFor: async () => agent,
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
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(tempRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("submit starts a job and returns RunningJob with jobId", async () => {
    const run = deferred<AgentResult>();
    const agent = createMockAgent("session-start", run.promise);
    const runner = new AgentRunner(createRuntime(agent));

    const job = runner.submit("session-start", tempRoot, "Hello");

    expect(job.sessionId).toBe("session-start");
    expect(typeof job.jobId).toBe("string");
    expect(job.abortController.signal.aborted).toBe(false);
    await flushMicrotasks();
    expect(agent.runMock).toHaveBeenCalledWith("Hello", { abort: job.abortController.signal });
  });

  test("submit for same sessionId twice throws AgentRunningError", () => {
    const run = deferred<AgentResult>();
    const agent = createMockAgent("session-duplicate", run.promise);
    const runner = new AgentRunner(createRuntime(agent));

    runner.submit("session-duplicate", tempRoot, "First");

    expect(() => runner.submit("session-duplicate", tempRoot, "Second")).toThrow(AgentRunningError);
  });

  test("isRunning returns true while running and false after completion", async () => {
    const run = deferred<AgentResult>();
    const agent = createMockAgent("session-running", run.promise);
    const runner = new AgentRunner(createRuntime(agent));

    const job = runner.submit("session-running", tempRoot, "Hello");
    expect(runner.isRunning("session-running")).toBe(true);

    run.resolve({ text: "Done", steps: 1 });
    await job.promise;

    expect(runner.isRunning("session-running")).toBe(false);
  });

  test("abort cancels the job and isRunning becomes false", async () => {
    const agent = createMockAgent("session-abort", new Promise(() => undefined));
    const runner = new AgentRunner(createRuntime(agent));

    const job = runner.submit("session-abort", tempRoot, "Stop me");
    const aborted = runner.abort("session-abort");
    await job.promise;

    expect(aborted).toBe(true);
    expect(job.abortController.signal.aborted).toBe(true);
    expect(runner.isRunning("session-abort")).toBe(false);
  });

  test("after agent.run completes, session transcript is saved", async () => {
    const workspaceRoot = join(tempRoot, "workspace-save");
    await mkdir(workspaceRoot, { recursive: true });
    const agent = createMockAgent("session-save", Promise.resolve({ text: "Saved", steps: 1 }));
    agent.store.getState().append({ type: "user-message", content: "persist me" });
    const runner = new AgentRunner(createRuntime(agent));

    const job = runner.submit("session-save", workspaceRoot, "persist me");
    await job.promise;
    await flushMicrotasks();

    const saved = await loadSessionTranscript("session-save", workspaceRoot);
    expect(saved.getState().messages).toHaveLength(1);
  });
});
