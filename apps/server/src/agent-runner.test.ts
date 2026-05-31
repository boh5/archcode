import { describe, expect, mock, test } from "bun:test";
import type { GlobalSSEEvent } from "@specra/protocol";
import type { ActiveSessionExecution, CommandResult, SpecraRuntime } from "@specra/agent-core";
import { AgentRunner } from "./agent-runner";
import { globalEventBus } from "./events/global-event-bus";

function makeExecution(sessionId = "session-one", workspaceRoot = "/workspace"): ActiveSessionExecution {
  return {
    sessionId,
    workspaceRoot,
    agentName: "orchestrator",
    origin: "user_message",
    abortController: new AbortController(),
    promise: Promise.resolve(),
    executionToken: Symbol("test-execution"),
    startedAt: Date.now(),
  };
}

function makeRuntime(overrides: Partial<SpecraRuntime> = {}): SpecraRuntime {
  return {
    mcpManager: undefined,
    toolRegistry: undefined,
    providerRegistry: undefined,
    skillService: undefined,
    warnings: [],
    projectRegistry: undefined,
    contextResolver: undefined,
    createSession: mock(async () => ({ sessionId: "session", title: null, createdAt: Date.now(), messages: [], steps: [], todos: [], reminders: [] })),
    getSessionFile: mock(async () => ({ sessionId: "session", title: null, createdAt: Date.now(), messages: [], steps: [], todos: [], reminders: [] })),
    listSessions: mock(async () => []),
    startSessionExecution: mock(() => makeExecution()),
    abortSessionExecution: mock(() => true),
    abortSessionExecutionAndWait: mock(async () => undefined),
    abortAllSessionExecutions: mock(async () => undefined),
    isSessionExecutionRunning: mock(() => false),
    getSessionExecution: mock(() => undefined),
    subscribeSessionEvents: mock(() => () => undefined),
    deleteSession: mock(async () => undefined),
    disposeSessionAgent: mock(() => undefined),
    disposeAllSessionAgents: mock(() => undefined),
    isSessionTombstoned: mock(() => false),
    dispatchCommand: mock(async () => null),
    requestPermission: mock(async () => "timeout"),
    respondPermission: mock(() => false),
    requestQuestion: mock(async () => ({ isError: true, reason: "Cancelled" })),
    respondQuestion: mock(() => false),
    cleanupDeferredSession: mock(() => undefined),
    notifyRuntimeShutdown: mock(() => undefined),
    ...overrides,
  } as unknown as SpecraRuntime;
}

describe("AgentRunner adapter", () => {
  test("submit subscribes through runtime, forwards global events, and unsubscribes after settle", async () => {
    let onEvent: ((event: GlobalSSEEvent) => void) | undefined;
    const unsubscribe = mock(() => undefined);
    const runtime = makeRuntime({
      subscribeSessionEvents: mock((input) => {
        onEvent = input.onEvent;
        return unsubscribe;
      }),
      startSessionExecution: mock(() => makeExecution("session-one", "/workspace")),
    });
    const received: GlobalSSEEvent[] = [];
    const unsubscribeBus = globalEventBus.subscribe((event) => received.push(event));
    const runner = new AgentRunner(runtime);

    const execution = runner.start({ slug: "project", workspaceRoot: "/workspace", sessionId: "session-one", userMessage: "hi" });
    onEvent?.({ type: "shutdown", reason: "test" });
    await execution.promise;
    await Promise.resolve();
    unsubscribeBus();

    expect(runtime.subscribeSessionEvents).toHaveBeenCalledWith({
      slug: "project",
      workspaceRoot: "/workspace",
      sessionId: "session-one",
      onEvent: expect.any(Function),
    });
    expect(runtime.startSessionExecution).toHaveBeenCalledWith({ slug: "project", workspaceRoot: "/workspace", sessionId: "session-one", userMessage: "hi" });
    expect(received).toEqual([{ type: "shutdown", reason: "test" }]);
    expect(unsubscribe).toHaveBeenCalled();
  });

  test("submit unsubscribes when runtime rejects submission", () => {
    const unsubscribe = mock(() => undefined);
    const runtime = makeRuntime({
      subscribeSessionEvents: mock(() => unsubscribe),
      startSessionExecution: mock(() => {
        throw new Error("boom");
      }),
    });
    const runner = new AgentRunner(runtime);

    expect(() => runner.start({ slug: "project", workspaceRoot: "/workspace", sessionId: "session", userMessage: "hi" })).toThrow("boom");
    expect(unsubscribe).toHaveBeenCalled();
  });

  test("delegates lifecycle and command calls to runtime", async () => {
    const commandResult: CommandResult = { success: true, message: "ok" };
    const runtime = makeRuntime({
      abortSessionExecution: mock(() => true),
      abortSessionExecutionAndWait: mock(async () => undefined),
      abortAllSessionExecutions: mock(async () => undefined),
      isSessionExecutionRunning: mock(() => true),
      getSessionExecution: mock(() => makeExecution("session", "/workspace")),
      cleanupDeferredSession: mock(() => undefined),
      dispatchCommand: mock(async () => commandResult),
    });
    const runner = new AgentRunner(runtime);

    expect(runner.abort("/workspace", "session")).toBe(true);
    await runner.abortAndWait("/workspace", "session");
    await runner.abortAll();
    expect(runner.isRunning("/workspace", "session")).toBe(true);
    expect(runner.getExecution("/workspace", "session")?.sessionId).toBe("session");
    runner.cleanupSession("/workspace", "session");
    await expect(runner.dispatchCommand("/workspace", "session", "compact", "now")).resolves.toEqual(commandResult);
  });
});
