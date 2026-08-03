import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  GlobalSessionEventEnvelope,
  GlobalSSEResourceChangedEvent,
} from "@archcode/protocol";

import type { McpManager } from "./mcp";
import { setLlmAdapterForTest } from "./llm";
import { silentLogger } from "./logger";
import { ServerConfigService, resolveServerConfigPath } from "./config";
import { ProjectRegistry } from "./projects/registry";
import { createRuntime, type AgentRuntime } from "./runtime";
import { RuntimeSessionDispatchGateway } from "./automations/runtime-session-gateway";
import type { AutomationSchedulerTimer, AutomationSchedulerTimerHandle } from "./automations/scheduler";
import { SessionStoreManager } from "./store/session-store-manager";

const roots: string[] = [];
const START = Date.parse("2026-07-13T00:00:00.000Z");
let generatedTitlePrompts: string[] = [];
const activeRuntimes = new Set<AgentRuntime>();

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

afterEach(async () => {
  await Promise.all([...activeRuntimes].map(async (runtime) => await runtime.shutdown()));
  activeRuntimes.clear();
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
    await stores.createSessionFile(workspaceRoot, { agentName: "lead", source: { kind: "direct" } }, sessionId);
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
      runRuntimeMutation: async (_workspaceRoot, operation) => (
        await operation()
      ),
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
  test("persists Todo identity and resolves current references in Automation invocation Sessions", async () => {
    const fixture = await runtimeFixture();
    const todos = (await fixture.runtime.contextResolver.resolve(fixture.workspaceRoot)).todos;
    let todo = await todos.createTodo({ content: "Use current Automation references" });
    const firstAttachmentId = crypto.randomUUID();
    todo = (await todos.uploadAttachment({
      todoId: todo.id,
      attachmentId: firstAttachmentId,
      expectedRevision: todo.revision,
      name: "first-reference.txt",
      sizeBytes: 1,
      mediaType: "text/plain",
      body: new Response(Uint8Array.of(1)).body,
    })).todo;
    const todoId = todo.id;
    const source = await fixture.runtime.createSession(fixture.workspaceRoot, {
      agentName: "lead",
      source: { kind: "todo", todoId, entry: "automation" },
    });
    const automation = await fixture.runtime.createAutomation(fixture.workspaceRoot, {
      name: "Todo automation",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Check the project", location: "project" },
      sourceSessionId: source.sessionId,
    });

    expect(automation.origin).toEqual({ kind: "todo", todoId, sessionId: source.sessionId });
    const modelCalls: string[] = [];
    let firstModelStarted!: () => void;
    let secondModelStarted!: () => void;
    let thirdModelStarted!: () => void;
    let releaseFirstModel!: () => void;
    let releaseSecondModel!: () => void;
    let releaseThirdModel!: () => void;
    const firstModelStartedPromise = new Promise<void>((resolve) => { firstModelStarted = resolve; });
    const secondModelStartedPromise = new Promise<void>((resolve) => { secondModelStarted = resolve; });
    const thirdModelStartedPromise = new Promise<void>((resolve) => { thirdModelStarted = resolve; });
    const releaseFirstModelPromise = new Promise<void>((resolve) => { releaseFirstModel = resolve; });
    const releaseSecondModelPromise = new Promise<void>((resolve) => { releaseSecondModel = resolve; });
    const releaseThirdModelPromise = new Promise<void>((resolve) => { releaseThirdModel = resolve; });
    setLlmAdapterForTest({
      streamText: mock((input: unknown) => {
        const callIndex = modelCalls.push(JSON.stringify((input as { messages: unknown }).messages)) - 1;
        if (callIndex === 0) firstModelStarted();
        if (callIndex === 1) secondModelStarted();
        if (callIndex === 2) thirdModelStarted();
        return {
          fullStream: (async function* () {
            if (callIndex === 0) await releaseFirstModelPromise;
            if (callIndex === 1) await releaseSecondModelPromise;
            if (callIndex === 2) await releaseThirdModelPromise;
          })(),
          finishReason: Promise.resolve("stop"),
          usage: Promise.resolve({ totalTokens: 1 }),
          text: Promise.resolve(""),
          toolCalls: Promise.resolve([]),
        };
      }) as never,
      generateText: mock(async () => ({ text: "Generated title" })) as never,
    });
    const invocation = await fixture.runtime.runAutomationNow(fixture.workspaceRoot, automation.id);
    await firstModelStartedPromise;
    const invocationSession = await fixture.runtime.getSessionFile(
      fixture.workspaceRoot,
      invocation.sessionId!,
    );
    expect(invocationSession.source).toEqual({
      kind: "automation",
      automationId: automation.id,
      invocationId: invocation.id,
      todoId,
    });
    expect(modelCalls[0]).toContain(firstAttachmentId);

    const firstEvents = sessionEventProbe(fixture.runtime);
    releaseFirstModel();
    await firstEvents.waitFor((event) => event.sessionId === invocationSession.sessionId
      && event.payload.type === "execution-end"
      && event.payload.terminalStatus === "completed");
    firstEvents.dispose();

    todo = await todos.removeAttachment({
      todoId,
      attachmentId: firstAttachmentId,
      expectedRevision: todo.revision,
    });
    const secondAttachmentId = crypto.randomUUID();
    todo = (await todos.uploadAttachment({
      todoId,
      attachmentId: secondAttachmentId,
      expectedRevision: todo.revision,
      name: "second-reference.txt",
      sizeBytes: 1,
      mediaType: "text/plain",
      body: new Response(Uint8Array.of(2)).body,
    })).todo;

    const secondInvocation = await fixture.runtime.runAutomationNow(
      fixture.workspaceRoot,
      automation.id,
    );
    await secondModelStartedPromise;
    const secondInvocationSession = await fixture.runtime.getSessionFile(
      fixture.workspaceRoot,
      secondInvocation.sessionId!,
    );
    expect(secondInvocationSession.sessionId).not.toBe(invocationSession.sessionId);
    expect(secondInvocationSession.source).toEqual({
      kind: "automation",
      automationId: automation.id,
      invocationId: secondInvocation.id,
      todoId,
    });
    expect(modelCalls[1]).not.toContain(firstAttachmentId);
    expect(modelCalls[1]).toContain(secondAttachmentId);

    const secondEvents = sessionEventProbe(fixture.runtime);
    releaseSecondModel();
    await secondEvents.waitFor((event) => event.sessionId === secondInvocationSession.sessionId
      && event.payload.type === "execution-end"
      && event.payload.terminalStatus === "completed");
    secondEvents.dispose();

    const chained = await fixture.runtime.createAutomation(fixture.workspaceRoot, {
      name: "Chained Todo automation",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Continue", location: "project" },
      sourceSessionId: secondInvocationSession.sessionId,
    });
    expect(chained.origin).toEqual({
      kind: "todo",
      todoId,
      sessionId: secondInvocationSession.sessionId,
    });
    const continueAutomation = await fixture.runtime.createAutomation(fixture.workspaceRoot, {
      name: "Continue existing invocation",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: {
        kind: "send_message",
        sessionId: secondInvocationSession.sessionId,
        message: "Read the references again",
      },
      sourceSessionId: source.sessionId,
    });

    await fixture.runtime.deleteAutomation(fixture.workspaceRoot, automation.id);
    todo = await todos.removeAttachment({
      todoId,
      attachmentId: secondAttachmentId,
      expectedRevision: todo.revision,
    });
    const thirdAttachmentId = crypto.randomUUID();
    todo = (await todos.uploadAttachment({
      todoId,
      attachmentId: thirdAttachmentId,
      expectedRevision: todo.revision,
      name: "third-reference.txt",
      sizeBytes: 1,
      mediaType: "text/plain",
      body: new Response(Uint8Array.of(3)).body,
    })).todo;
    await fixture.runtime.runAutomationNow(fixture.workspaceRoot, continueAutomation.id);
    await thirdModelStartedPromise;
    const events = sessionEventProbe(fixture.runtime);
    releaseThirdModel();
    await events.waitFor((event) => event.sessionId === secondInvocationSession.sessionId
      && event.payload.type === "execution-end"
      && event.payload.terminalStatus === "completed");
    events.dispose();
    expect(modelCalls[2]).not.toContain(secondAttachmentId);
    expect(modelCalls[2]).toContain(thirdAttachmentId);
  });

  test("creates a normal Lead Session with the preallocated dispatch identities", async () => {
    const fixture = await runtimeFixture();
    const automation = await fixture.runtime.createAutomation(fixture.workspaceRoot, {
      name: "check project",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Check the project", location: "project" },
      sourceSessionId: fixture.sourceSessionId,
    });

    const invocation = await fixture.runtime.runAutomationNow(fixture.workspaceRoot, automation.id);

    expect(invocation.status).toBe("dispatched");
    expect(invocation.sessionId).toBeString();
    const session = await fixture.runtime.getSessionFile(fixture.workspaceRoot, invocation.sessionId!);
    expect(session).toMatchObject({
      sessionId: invocation.sessionId,
      rootSessionId: invocation.sessionId,
      cwd: fixture.workspaceRoot,
      agentName: "lead",
      source: {
        kind: "automation",
        automationId: automation.id,
        invocationId: invocation.id,
        todoId: null,
      },
    });
  });

  test("routes send_message through the ordinary checked Session message entry point", async () => {
    const fixture = await runtimeFixture();
    const session = await fixture.runtime.createSession(fixture.workspaceRoot, { agentName: "lead", source: { kind: "direct" } });
    const automation = await fixture.runtime.createAutomation(fixture.workspaceRoot, {
      name: "continue session",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "send_message", sessionId: session.sessionId, message: "/skill use git-master Review this." },
      sourceSessionId: fixture.sourceSessionId,
    });

    const events = sessionEventProbe(fixture.runtime);
    const invocation = await fixture.runtime.runAutomationNow(fixture.workspaceRoot, automation.id);

    expect(invocation.status).toBe("dispatched");
    expect(invocation.sessionId).toBe(session.sessionId);
    await events.waitFor((event) => event.sessionId === session.sessionId
      && event.payload.type === "session.messages_committed"
      && event.payload.messages.some((message) => message.clientRequestId === invocation.id));
    events.dispose();
  });

  test("uses the Invocation id as the Automation message client request identity", async () => {
    const fixture = await runtimeFixture();
    const automation = await fixture.runtime.createAutomation(fixture.workspaceRoot, {
      name: "server events",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Report status", location: "project" },
      sourceSessionId: fixture.sourceSessionId,
    });
    const events = sessionEventProbe(fixture.runtime);
    const invocation = await fixture.runtime.runAutomationNow(fixture.workspaceRoot, automation.id);

    expect(invocation.status).toBe("dispatched");
    await events.waitFor((event) => event.sessionId === invocation.sessionId
      && event.payload.type === "session.messages_committed"
      && event.payload.messages.some((message) => message.clientRequestId === invocation.id));
    events.dispose();
    const session = await fixture.runtime.getSessionFile(fixture.workspaceRoot, invocation.sessionId!);
    expect(session.inputRequestReceipts).toContainEqual(expect.objectContaining({
      clientRequestId: invocation.id,
      status: "canonical",
    }));
  });

  test("rejects worktree actions on non-Git projects during create and update", async () => {
    const fixture = await runtimeFixture();

    await expect(fixture.runtime.createAutomation(fixture.workspaceRoot, {
      name: "isolated check",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Check", location: "worktree" },
      sourceSessionId: fixture.sourceSessionId,
    })).rejects.toMatchObject({ name: "WorktreeServiceError" });

    const projectAutomation = await fixture.runtime.createAutomation(fixture.workspaceRoot, {
      name: "project check",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Check", location: "project" },
      sourceSessionId: fixture.sourceSessionId,
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
      sourceSessionId: fixture.sourceSessionId,
    });
    const second = await fixture.runtime.createAutomation(fixture.secondWorkspaceRoot!, {
      name: "second",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: { kind: "start_session", message: "Second", location: "project" },
      sourceSessionId: fixture.secondSourceSessionId!,
    });

    await fixture.runtime.startAutomationScheduler(fixture.workspaceRoot);
    const firstInvocationChanged = nextAutomationResourceChange(fixture.runtime, first.id);
    await fixture.timer.advanceTo(START + 30_000);
    await firstInvocationChanged;
    expect(await fixture.runtime.listAutomationInvocations(fixture.secondWorkspaceRoot!, second.id)).toEqual([]);
    const [firstInvocation] = await fixture.runtime.listAutomationInvocations(fixture.workspaceRoot, first.id);
    if (firstInvocation === undefined) throw new Error("First scheduler did not materialize an Invocation");

    await fixture.runtime.startAutomationSchedulers();
    const secondInvocationChanged = nextAutomationResourceChange(fixture.runtime, second.id);
    await fixture.timer.advanceTo(START + 60_000);
    await secondInvocationChanged;
    expect(await fixture.runtime.listAutomationInvocations(fixture.secondWorkspaceRoot!, second.id))
      .toHaveLength(1);
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
      sourceSessionId: fixture.sourceSessionId,
    });
    await fixture.runtime.updateAutomation(fixture.workspaceRoot, automation.id, { name: "renamed" });
    await fixture.runtime.runAutomationNow(fixture.workspaceRoot, automation.id);
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

  test("requires an ordinary root Lead Session in the same project as creation source", async () => {
    const fixture = await runtimeFixture({ secondProject: true });
    const stores = new SessionStoreManager({ logger: silentLogger });
    const child = await stores.createSessionFile(fixture.workspaceRoot, {
      agentName: "explore",
      rootSessionId: fixture.sourceSessionId,
      parentSessionId: fixture.sourceSessionId,
      activeSkillNames: [],
      delegationRequest: {
        agent_type: "explore",
        profile: "fast",
        title: "Invalid child source",
        objective: "Remain ineligible as an Automation creation source.",
        skills: [],
        background: false,
      },
    });
    const discussion = await stores.createSessionFile(fixture.workspaceRoot, {
      agentName: "discussion",
      source: { kind: "todo", todoId: crypto.randomUUID(), entry: "discussion" },
    });
    const missingSessionId = crypto.randomUUID();
    const input = {
      name: "invalid source",
      trigger: { kind: "interval" as const, everyMs: 30_000 },
      action: { kind: "start_session" as const, message: "Check", location: "project" as const },
    };

    await expect(fixture.runtime.createAutomation(fixture.workspaceRoot, {
      ...input,
      sourceSessionId: missingSessionId,
    })).rejects.toMatchObject({ name: "ResourceCreationSourceError", sessionId: missingSessionId });

    await expect(fixture.runtime.createAutomation(fixture.workspaceRoot, {
      ...input,
      sourceSessionId: fixture.secondSourceSessionId!,
    })).rejects.toMatchObject({ name: "ResourceCreationSourceError", sessionId: fixture.secondSourceSessionId });

    for (const source of [child, discussion]) {
      await expect(fixture.runtime.createAutomation(fixture.workspaceRoot, {
        ...input,
        sourceSessionId: source.sessionId,
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
      sourceSessionId: fixture.sourceSessionId,
    });

    await fixture.runtime.deleteSession(fixture.workspaceRoot, fixture.sourceSessionId);

    expect(await fixture.runtime.readAutomation(fixture.workspaceRoot, automation.id))
      .toMatchObject({ origin: { kind: "session", sessionId: fixture.sourceSessionId } });
  });

  test("blocks deletion of an Automation target and publishes deletion after unlinking", async () => {
    const fixture = await runtimeFixture();
    const target = await fixture.runtime.createSession(fixture.workspaceRoot, {
      agentName: "lead",
      source: { kind: "direct" },
    });
    const automation = await fixture.runtime.createAutomation(fixture.workspaceRoot, {
      name: "Continue target",
      trigger: { kind: "interval", everyMs: 30_000 },
      action: {
        kind: "send_message",
        sessionId: target.sessionId,
        message: "Continue",
      },
      sourceSessionId: fixture.sourceSessionId,
    });
    const changes: GlobalSSEResourceChangedEvent[] = [];
    const unsubscribe = fixture.runtime.subscribeResourceChanges?.((event) => {
      changes.push(event);
    });

    await expect(
      fixture.runtime.deleteSession(fixture.workspaceRoot, target.sessionId),
    ).rejects.toMatchObject({
      name: "SessionAutomationReferenceConflictError",
      sessionId: target.sessionId,
      automations: [{ id: automation.id, name: automation.name }],
    });
    await expect(
      fixture.runtime.getSessionFile(fixture.workspaceRoot, target.sessionId),
    ).resolves.toMatchObject({ sessionId: target.sessionId });

    await fixture.runtime.deleteAutomation(fixture.workspaceRoot, automation.id);
    await fixture.runtime.deleteSession(fixture.workspaceRoot, target.sessionId);

    expect(changes).toContainEqual({
      resourceType: "session",
      resourceId: target.sessionId,
      type: "resource.changed",
      projectSlug: expect.any(String),
      createdAt: expect.any(Number),
    });
    unsubscribe?.();
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
  const configService = new ServerConfigService({ homeDir: root });
  const activationResult = await configService.activateForStartup();
  if (activationResult.status !== "ready") throw new Error(`Expected ready config, received ${activationResult.status}`);
  const runtime = await createRuntime({
    configService,
    activation: activationResult.activation,
    projectRegistryHomeDir: root,
    mcpManagerFactory: () => mcpManager(),
    automationSchedulerClock: clock,
    automationSchedulerTimer: timer,
  });
  activeRuntimes.add(runtime);
  const sourceSession = await runtime.createSession(workspaceRoot, { agentName: "lead", source: { kind: "direct" } });
  const secondSourceSession = secondWorkspaceRoot === undefined
    ? undefined
    : await runtime.createSession(secondWorkspaceRoot, { agentName: "lead", source: { kind: "direct" } });
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
    profiles: {
      principal: { model: "local:test" },
      deep: { model: "local:test" },
      fast: { model: "local:test" },
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

function sessionEventProbe(runtime: AgentRuntime): {
  waitFor(predicate: (event: GlobalSessionEventEnvelope) => boolean): Promise<GlobalSessionEventEnvelope>;
  dispose(): void;
} {
  const events: GlobalSessionEventEnvelope[] = [];
  const waiters = new Set<{
    predicate: (event: GlobalSessionEventEnvelope) => boolean;
    resolve: (event: GlobalSessionEventEnvelope) => void;
  }>();
  const dispose = runtime.subscribeSessionEvents((event) => {
    events.push(event);
    for (const waiter of waiters) {
      if (!waiter.predicate(event)) continue;
      waiters.delete(waiter);
      waiter.resolve(event);
    }
  });
  return {
    waitFor(predicate) {
      const existing = events.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve) => {
        waiters.add({ predicate, resolve });
      });
    },
    dispose,
  };
}

function nextAutomationResourceChange(runtime: AgentRuntime, automationId: string): Promise<void> {
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    unsubscribe = runtime.subscribeResourceChanges?.((event) => {
      if (event.resourceType !== "automation" || event.resourceId !== automationId) return;
      unsubscribe();
      resolve();
    }) ?? (() => {});
  });
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
