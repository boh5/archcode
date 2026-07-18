import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpManager } from "./mcp";
import { setLlmAdapterForTest } from "./llm";
import { silentLogger } from "./logger";
import { ServerConfigService, resolveServerConfigPath } from "./config";
import { ProjectRegistry } from "./projects/registry";
import { createRuntime, type AgentRuntime } from "./runtime";
import { RuntimeSessionDispatchGateway } from "./automations/runtime-session-gateway";
import type { AutomationSchedulerTimer, AutomationSchedulerTimerHandle } from "./automations/scheduler";
import { SessionStoreManager } from "./store/session-store-manager";
import { ProjectTodoStateManager, activationExecutionId, discussionExecutionId } from "./todos";

const roots: string[] = [];
const START = Date.parse("2026-07-13T00:00:00.000Z");
let generatedTitlePrompts: string[] = [];

beforeEach(() => {
  generatedTitlePrompts = [];
  setLlmAdapterForTest({
    streamText: mock(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "Automation accepted." };
      })(),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({ totalTokens: 1 }),
      text: Promise.resolve("Automation accepted."),
      toolCalls: Promise.resolve([]),
    })) as never,
    generateText: mock(async (input: { prompt?: string }) => {
      generatedTitlePrompts.push(input.prompt ?? "");
      return { text: "Generated title" };
    }) as never,
  });
});

afterEach(() => {
  setLlmAdapterForTest(undefined);
});

afterAll(async () => {
  await Promise.all(roots.map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("RuntimeSessionDispatchGateway", () => {
  test("dispatches through message acceptance with the caller's client request identity", async () => {
    const workspaceRoot = await tempDir("archcode-automation-gateway-");
    const sessionId = crypto.randomUUID();
    const stores = new SessionStoreManager({ logger: silentLogger });
    await stores.createSessionFile(workspaceRoot, { agentName: "engineer" }, sessionId);
    const accepted: unknown[] = [];

    const gateway = new RuntimeSessionDispatchGateway({
      sessionStoreManager: stores,
      sessionRuntime: {
        acceptSessionMessage: async (input) => {
          accepted.push(input);
          return { clientRequestId: input.clientRequestId, messageId: crypto.randomUUID() };
        },
      },
      resolveProject: async () => ({ slug: "project-a", workspaceRoot }),
    });

    const clientRequestId = crypto.randomUUID();
    await gateway.dispatch({
      kind: "send_message",
      workspaceRoot,
      projectSlug: "project-a",
      sessionId,
      clientRequestId,
      message: "Run the automation",
    });

    expect(accepted).toEqual([{
      slug: "project-a",
      workspaceRoot,
      sessionId,
      text: "Run the automation",
      clientRequestId,
      source: "automation",
    }]);
  });
});

describe("AgentRuntime Automation wiring", () => {
  test("routes Goal activation through its typed execution path", async () => {
    const fixture = await runtimeFixture();
    const context = await fixture.runtime.contextResolver.resolve(fixture.workspaceRoot);

    const goal = await context.goalLifecycle.create({
      projectSlug: "automation-one",
      createdFromSessionId: fixture.sourceSessionId,
      objective: "Verify managed Goal activation.",
      acceptanceCriteria: "The Goal start is forwarded with its existing claim.",
    });

    await waitFor(async () => {
      const session = await fixture.runtime.getSessionFile(fixture.workspaceRoot, goal.mainSessionId);
      return session.executions.some((execution) => execution.id === `goal-initial:${goal.id}`);
    });
    await fixture.runtime.abortAllSessionExecutions();
  });

  test("publishes every Goal commit and schedules Goal title generation only on creation", async () => {
    const fixture = await runtimeFixture();
    const events: unknown[] = [];
    const unsubscribe = fixture.runtime.subscribeResourceChanges?.((event) => { events.push(event); });
    const context = await fixture.runtime.contextResolver.resolve(fixture.workspaceRoot);

    const goal = await context.goalLifecycle.create({
      projectSlug: "automation-one",
      createdFromSessionId: fixture.sourceSessionId,
      objective: "Prove runtime Goal commit notifications.",
      acceptanceCriteria: "Creation and every later commit publish one resource event.",
    });
    await waitFor(async () => (await context.goalState.read(goal.id)).title !== null);
    const goalTitlePromptsAfterCreation = generatedTitlePrompts.filter((prompt) => prompt.includes("concise Goal title"));
    expect(goalTitlePromptsAfterCreation).toHaveLength(1);

    await context.goalLifecycle.beginReview(goal.id);
    await Bun.sleep(10);
    unsubscribe?.();

    const goalEvents = events.filter((event) => (
      event !== null
      && typeof event === "object"
      && "resourceType" in event
      && event.resourceType === "goal"
      && "resourceId" in event
      && event.resourceId === goal.id
    ));
    expect(goalEvents).toHaveLength(3);
    expect(goalEvents.every((event) => !(event && typeof event === "object" && "reason" in event))).toBe(true);
    expect(generatedTitlePrompts.filter((prompt) => prompt.includes("concise Goal title"))).toHaveLength(1);
    await fixture.runtime.abortAllSessionExecutions();
  });

  test("creates a normal Engineer Session with the preallocated dispatch identities", async () => {
    const fixture = await runtimeFixture();
    const automation = await fixture.runtime.createAutomation(fixture.workspaceRoot, {
      name: "check project",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Check the project", location: "project" },
      createdFromSessionId: fixture.sourceSessionId,
    });

    const invocation = await fixture.runtime.runAutomationNow(fixture.workspaceRoot, automation.id);

    expect(invocation.status).toBe("dispatched");
    expect(invocation.sessionId).toBeString();
    const session = await fixture.runtime.getSessionFile(fixture.workspaceRoot, invocation.sessionId!);
    expect(session).toMatchObject({
      sessionId: invocation.sessionId,
      rootSessionId: invocation.sessionId,
      cwd: fixture.workspaceRoot,
      agentName: "engineer",
    });
    await waitForInvocationExecution(fixture.runtime, fixture.workspaceRoot, invocation);
  });

  test("routes send_message through the ordinary checked Session message entry point", async () => {
    const fixture = await runtimeFixture();
    const session = await fixture.runtime.createSession(fixture.workspaceRoot, { agentName: "engineer" });
    const automation = await fixture.runtime.createAutomation(fixture.workspaceRoot, {
      name: "continue session",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "send_message", sessionId: session.sessionId, message: "/skill use git-master Review this." },
      createdFromSessionId: fixture.sourceSessionId,
    });

    const invocation = await fixture.runtime.runAutomationNow(fixture.workspaceRoot, automation.id);

    expect(invocation.status).toBe("dispatched");
    expect(invocation.sessionId).toBe(session.sessionId);
    await waitForInvocationExecution(fixture.runtime, fixture.workspaceRoot, invocation);
  });

  test("uses the Invocation id as the Automation message client request identity", async () => {
    const fixture = await runtimeFixture();
    const automation = await fixture.runtime.createAutomation(fixture.workspaceRoot, {
      name: "server events",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Report status", location: "project" },
      createdFromSessionId: fixture.sourceSessionId,
    });
    const invocation = await fixture.runtime.runAutomationNow(fixture.workspaceRoot, automation.id);

    expect(invocation.status).toBe("dispatched");
    await waitForInvocationExecution(fixture.runtime, fixture.workspaceRoot, invocation);
    const session = await fixture.runtime.getSessionFile(fixture.workspaceRoot, invocation.sessionId!);
    expect(session.inputRequestReceipts).toContainEqual(expect.objectContaining({
      clientRequestId: invocation.id,
      status: "canonical",
    }));
  });

  test("routes Project Todo starts through typed execution paths and binds exact resources", async () => {
    const fixture = await runtimeFixture();
    const context = await fixture.runtime.contextResolver.resolve(fixture.workspaceRoot);

    const idea = await context.todos.createTodo({ title: "Shape through server events" });
    const discussed = await context.todos.discussTodo(idea.id, idea.revision);
    const discussionSession = await fixture.runtime.getSessionFile(fixture.workspaceRoot, discussed.discussionSessionId!);
    expect(discussionSession.agentName).toBe("shaper");
    expect(discussionSession.executions).toContainEqual(expect.objectContaining({
      id: discussionExecutionId(idea.id),
    }));
    await waitFor(() => fixture.runtime.getSessionFamilyActivity(fixture.workspaceRoot, discussed.discussionSessionId!) === "idle");

    const automationIdea = await context.todos.createTodo({ title: "Automate exact resource binding" });
    const ready = await context.todos.updateTodo(automationIdea.id, {
      expectedRevision: automationIdea.revision,
      patch: { status: "ready" },
    });
    const active = await context.todos.activateTodo(ready.id, {
      expectedRevision: ready.revision,
      kind: "automation",
    });
    const activationSession = await fixture.runtime.getSessionFile(fixture.workspaceRoot, active.activation!.sourceSessionId);
    expect(activationSession.executions).toContainEqual(expect.objectContaining({
      id: activationExecutionId(active.id),
    }));

    const automation = await fixture.runtime.createAutomation(fixture.workspaceRoot, {
      name: "Todo provenance",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Check", location: "project" },
      createdFromSessionId: active.activation!.sourceSessionId,
    });
    expect((await context.todos.readTodo(active.id)).activation?.resourceId).toBe(automation.id);
    await fixture.runtime.abortAllSessionExecutions();
  });

  test("recovers durable Project Todo checkpoints through its typed execution path", async () => {
    let todoId = "";
    let discussionSessionId = "";
    const fixture = await runtimeFixture({
      beforeRuntime: async ({ workspaceRoot }) => {
        const state = new ProjectTodoStateManager(workspaceRoot);
        const todo = await state.createTodo({ title: "Recover after restart" });
        discussionSessionId = crypto.randomUUID();
        todoId = todo.id;
        await state.checkpointDiscussion(todo.id, todo.revision, discussionSessionId);
      },
    });

    await fixture.runtime.recoverProjectTodos();
    await waitFor(async () => {
      const session = await fixture.runtime.getSessionFile(fixture.workspaceRoot, discussionSessionId);
      return session.executions.some((execution) => (
        execution.id === discussionExecutionId(todoId) && execution.status !== "running"
      ));
    });

    await fixture.runtime.recoverProjectTodos();
    const recovered = await fixture.runtime.getSessionFile(fixture.workspaceRoot, discussionSessionId);
    expect(recovered.executions.filter((execution) => execution.id === discussionExecutionId(todoId))).toHaveLength(1);
  });

  test("rejects worktree actions on non-Git projects during create and update", async () => {
    const fixture = await runtimeFixture();

    await expect(fixture.runtime.createAutomation(fixture.workspaceRoot, {
      name: "isolated check",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Check", location: "worktree" },
      createdFromSessionId: fixture.sourceSessionId,
    })).rejects.toMatchObject({ name: "WorktreeServiceError" });

    const projectAutomation = await fixture.runtime.createAutomation(fixture.workspaceRoot, {
      name: "project check",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Check", location: "project" },
      createdFromSessionId: fixture.sourceSessionId,
    });
    await expect(fixture.runtime.updateAutomation(fixture.workspaceRoot, projectAutomation.id, {
      action: { kind: "start_session", message: "Check", location: "worktree" },
    })).rejects.toMatchObject({ name: "WorktreeServiceError" });
    expect((await fixture.runtime.readAutomation(fixture.workspaceRoot, projectAutomation.id)).action)
      .toEqual({ kind: "start_session", message: "Check", location: "project" });
  });

  test("starts one project scheduler narrowly and all registered schedulers at boot", async () => {
    const fixture = await runtimeFixture({ secondProject: true });
    const first = await fixture.runtime.createAutomation(fixture.workspaceRoot, {
      name: "first",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "First", location: "project" },
      createdFromSessionId: fixture.sourceSessionId,
    });
    const second = await fixture.runtime.createAutomation(fixture.secondWorkspaceRoot!, {
      name: "second",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Second", location: "project" },
      createdFromSessionId: fixture.secondSourceSessionId!,
    });

    await fixture.runtime.startAutomationScheduler(fixture.workspaceRoot);
    await fixture.timer.advanceTo(START + 30_000);
    await waitFor(async () => (await fixture.runtime.listAutomationInvocations(fixture.workspaceRoot, first.id)).length === 1);
    expect(await fixture.runtime.listAutomationInvocations(fixture.secondWorkspaceRoot!, second.id)).toEqual([]);
    const [firstInvocation] = await fixture.runtime.listAutomationInvocations(fixture.workspaceRoot, first.id);
    if (firstInvocation === undefined) throw new Error("First scheduler did not materialize an Invocation");
    await waitForInvocationExecution(fixture.runtime, fixture.workspaceRoot, firstInvocation);

    await fixture.runtime.startAutomationSchedulers();
    await fixture.timer.advanceTo(START + 60_000);
    await waitFor(async () => (await fixture.runtime.listAutomationInvocations(fixture.secondWorkspaceRoot!, second.id)).length === 1);
    const invocations = [
      ...await fixture.runtime.listAutomationInvocations(fixture.workspaceRoot, first.id),
      ...await fixture.runtime.listAutomationInvocations(fixture.secondWorkspaceRoot!, second.id),
    ].filter((invocation) => invocation.id !== firstInvocation.id);
    await Promise.all(invocations.map(async (invocation) => {
      const workspaceRoot = invocation.automationId === first.id
        ? fixture.workspaceRoot
        : fixture.secondWorkspaceRoot!;
      await waitForInvocationExecution(fixture.runtime, workspaceRoot, invocation);
    }));
    await fixture.runtime.stopAutomationSchedulers();
  });

  test("publishes Automation resource changes for CRUD and Invocation updates", async () => {
    const fixture = await runtimeFixture();
    const events: unknown[] = [];
    const unsubscribe = fixture.runtime.subscribeResourceChanges?.((event) => { events.push(event); });
    const automation = await fixture.runtime.createAutomation(fixture.workspaceRoot, {
      name: "notifications",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Notify", location: "project" },
      createdFromSessionId: fixture.sourceSessionId,
    });
    await fixture.runtime.updateAutomation(fixture.workspaceRoot, automation.id, { name: "renamed" });
    const invocation = await fixture.runtime.runAutomationNow(fixture.workspaceRoot, automation.id);
    await waitForInvocationExecution(fixture.runtime, fixture.workspaceRoot, invocation);
    await fixture.runtime.deleteAutomation(fixture.workspaceRoot, automation.id);
    unsubscribe?.();

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceType: "automation", resourceId: automation.id }),
      expect.objectContaining({ resourceType: "automation", resourceId: automation.id }),
      expect.objectContaining({ resourceType: "automation", resourceId: automation.id }),
      expect.objectContaining({ resourceType: "automation", resourceId: automation.id }),
    ]));
    expect(events.every((event) => !(event && typeof event === "object" && "reason" in event))).toBe(true);
  });

  test("requires an ordinary root Engineer Session in the same project as creation source", async () => {
    const fixture = await runtimeFixture({ secondProject: true });
    const stores = new SessionStoreManager({ logger: silentLogger });
    const child = await stores.createSessionFile(fixture.workspaceRoot, {
      agentName: "explore",
      rootSessionId: fixture.sourceSessionId,
      parentSessionId: fixture.sourceSessionId,
    });
    const goalBound = await stores.createSessionFile(fixture.workspaceRoot, {
      agentName: "goal_lead",
      goalId: crypto.randomUUID(),
      sessionRole: "main",
    });
    const wrongAgent = await stores.createSessionFile(fixture.workspaceRoot, {
      agentName: "plan",
    });
    const missingSessionId = crypto.randomUUID();
    const input = {
      name: "invalid source",
      trigger: { kind: "interval" as const, everyMs: 30_000 },
      action: { kind: "start_session" as const, message: "Check", location: "project" as const },
    };

    await expect(fixture.runtime.createAutomation(fixture.workspaceRoot, {
      ...input,
      createdFromSessionId: missingSessionId,
    })).rejects.toMatchObject({ name: "ResourceCreationSourceError", sessionId: missingSessionId });

    await expect(fixture.runtime.createAutomation(fixture.workspaceRoot, {
      ...input,
      createdFromSessionId: fixture.secondSourceSessionId!,
    })).rejects.toMatchObject({ name: "ResourceCreationSourceError", sessionId: fixture.secondSourceSessionId });

    for (const source of [child, goalBound, wrongAgent]) {
      await expect(fixture.runtime.createAutomation(fixture.workspaceRoot, {
        ...input,
        createdFromSessionId: source.sessionId,
      })).rejects.toMatchObject({ name: "ResourceCreationSourceError", sessionId: source.sessionId });
    }

    expect(await fixture.runtime.listAutomations(fixture.workspaceRoot)).toEqual([]);
  });

  test("keeps Automation provenance after the source Session is deleted", async () => {
    const fixture = await runtimeFixture();
    const automation = await fixture.runtime.createAutomation(fixture.workspaceRoot, {
      name: "durable provenance",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Check", location: "project" },
      createdFromSessionId: fixture.sourceSessionId,
    });

    await fixture.runtime.deleteSession(fixture.workspaceRoot, fixture.sourceSessionId);

    expect(await fixture.runtime.readAutomation(fixture.workspaceRoot, automation.id))
      .toMatchObject({ createdFromSessionId: fixture.sourceSessionId });
  });
});

async function runtimeFixture(options: {
  secondProject?: boolean;
  beforeRuntime?: (input: { workspaceRoot: string; projectSlug: string }) => Promise<void>;
} = {}): Promise<{
  runtime: AgentRuntime;
  workspaceRoot: string;
  sourceSessionId: string;
  secondWorkspaceRoot?: string;
  secondSourceSessionId?: string;
  timer: FakeTimer;
}> {
  const root = await tempDir("archcode-runtime-automations-");
  const workspaceRoot = join(root, "workspace");
  const secondWorkspaceRoot = options.secondProject === true ? join(root, "workspace-two") : undefined;
  await mkdir(workspaceRoot, { recursive: true });
  if (secondWorkspaceRoot !== undefined) await mkdir(secondWorkspaceRoot, { recursive: true });
  const configPath = resolveServerConfigPath(root);
  await mkdir(join(root, ".archcode"), { recursive: true });
  await writeFile(configPath, JSON.stringify(config()));
  const registry = new ProjectRegistry({ homeDir: root, logger: silentLogger });
  const project = await registry.add({ workspaceRoot, name: "Automation One" });
  if (secondWorkspaceRoot !== undefined) await registry.add({ workspaceRoot: secondWorkspaceRoot, name: "Automation Two" });
  await options.beforeRuntime?.({ workspaceRoot, projectSlug: project.slug });
  const clock = new FakeClock(START);
  const timer = new FakeTimer(clock);
  const runtime = await createRuntime({
    configService: new ServerConfigService({ homeDir: root }),
    projectRegistryHomeDir: root,
    mcpManagerFactory: () => mcpManager(),
    automationSchedulerClock: clock,
    automationSchedulerTimer: timer,
  });
  const sourceSession = await runtime.createSession(workspaceRoot, { agentName: "engineer" });
  const secondSourceSession = secondWorkspaceRoot === undefined
    ? undefined
    : await runtime.createSession(secondWorkspaceRoot, { agentName: "engineer" });
  return {
    runtime,
    workspaceRoot,
    sourceSessionId: sourceSession.sessionId,
    ...(secondWorkspaceRoot === undefined ? {} : { secondWorkspaceRoot }),
    ...(secondSourceSession === undefined ? {} : { secondSourceSessionId: secondSourceSession.sessionId }),
    timer,
  };
}

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function config(): Record<string, unknown> {
  return {
    provider: {
      local: {
        npm: "@ai-sdk/openai-compatible",
        name: "Local",
        options: { baseURL: "http://localhost:8090/v1", apiKey: "test-secret" },
        models: {
          test: {
            name: "Test",
            limit: { context: 128_000, output: 8_192 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    },
    agents: {
      engineer: { model: "local:test" },
      goal_lead: { model: "local:test" },
      plan: { model: "local:test" },
      build: { model: "local:test" },
      reviewer: { model: "local:test" },
      explore: { model: "local:test" },
      librarian: { model: "local:test" },
      shaper: { model: "local:test" },
    },
    mcp: { servers: {} },
  };
}

function mcpManager(): McpManager {
  return {
    discover: mock(async () => ({ descriptors: [], warnings: [] })),
    closeAll: mock(async () => []),
    getStatus: mock(() => new Map()),
    onStatusChange: mock(() => () => {}),
    startBackgroundDiscovery: mock(() => {}),
  } as unknown as McpManager;
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for runtime state");
}

async function waitForInvocationExecution(
  runtime: AgentRuntime,
  workspaceRoot: string,
  invocation: { readonly id: string; readonly automationId: string; readonly sessionId?: string },
): Promise<void> {
  let dispatched = invocation;
  await waitFor(async () => {
    const current = (await runtime.listAutomationInvocations(workspaceRoot, invocation.automationId))
      .find((candidate) => candidate.id === invocation.id);
    if (current?.status === "failed") throw new Error(current.error ?? "Automation Invocation failed");
    if (current?.status !== "dispatched") return false;
    dispatched = current;
    return true;
  });
  if (dispatched.sessionId === undefined) throw new Error("Invocation did not allocate a Session");
  await waitFor(async () => {
    const session = await runtime.getSessionFile(workspaceRoot, dispatched.sessionId!);
    return session.inputRequestReceipts.some((receipt) => (
      receipt.clientRequestId === invocation.id && receipt.status === "canonical"
    ));
  });
  await waitFor(() => runtime.getSessionFamilyActivity(workspaceRoot, dispatched.sessionId!) === "idle");
}

class FakeClock {
  constructor(private value: number) {}

  now(): number {
    return this.value;
  }

  set(value: number): void {
    this.value = value;
  }
}

class FakeTimer implements AutomationSchedulerTimer {
  readonly #tasks = new Map<number, { dueAt: number; callback: () => void | Promise<void> }>();
  #nextId = 1;

  constructor(private readonly clock: FakeClock) {}

  schedule(delayMs: number, callback: () => void | Promise<void>): AutomationSchedulerTimerHandle {
    const id = this.#nextId++;
    this.#tasks.set(id, { dueAt: this.clock.now() + delayMs, callback });
    return { id };
  }

  cancel(handle: AutomationSchedulerTimerHandle): void {
    if (typeof handle.id === "number") this.#tasks.delete(handle.id);
  }

  async advanceTo(now: number): Promise<void> {
    while (true) {
      const next = [...this.#tasks.entries()]
        .filter(([, task]) => task.dueAt <= now)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
      if (next === undefined) break;
      this.#tasks.delete(next[0]);
      this.clock.set(next[1].dueAt);
      await next[1].callback();
      await Promise.resolve();
    }
    this.clock.set(now);
  }
}
