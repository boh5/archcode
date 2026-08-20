import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  GlobalSessionEventEnvelope,
  GlobalSSESessionRuntimeChangedEvent,
  RequestedModelSelection,
  ServerConfigUpdate,
} from "@archcode/protocol";
import type { ResolvedMcpConfig } from "./config/mcp";
import { createTestMcpRuntime, type TestMcpRuntime } from "./testing/test-mcp-runtime";
import { REDACTION_MARKER } from "./security";
import {
  createRuntime as createProductionRuntime,
  type AgentRuntime,
  type AgentRuntimeOptions,
} from "./runtime";
import { SessionStoreManager } from "./store/session-store-manager";
import { SessionInputService } from "./session-input/service";
import { EMPTY_SESSION_ATTACHMENT_RESOLVER } from "./session-input/test-helpers";
import type { SessionToolBatch } from "./store/types";
import { createInMemoryLogger, silentLogger } from "./logger";
import { ServerConfigService, resolveServerConfigPath } from "./config";
import { ProjectRegistry } from "./projects/registry";
import { setLlmAdapterForTest } from "./llm";
import { getLspClientPool } from "./lsp/client-pool";
import { SessionGoalService } from "./session-goal";
import { testExecutionEnd, testExecutionStart, testExecutionSuspended } from "./testing/test-execution-fixtures";
import { getAttachmentContentPath } from "./attachments";
import { getSessionPath } from "./store/sessions-dir";
import { NotRootSessionError, SessionFamilySnapshotConflictError } from "./store/errors";
import { SessionSteerUnavailableError } from "./execution/session-execution-manager";

const tmpRoots: string[] = [];
const requestedModelSelection: RequestedModelSelection = {
  mode: "profile_default",
  selection: { model: "local:test-model" },
};
afterAll(() => { for (const root of tmpRoots) rmSync(root, { recursive: true, force: true }); });
afterEach(() => setLlmAdapterForTest(undefined));

function makeProviderConfig() {
  return { local: { npm: "@ai-sdk/openai-compatible", name: "Local LLM", options: { baseURL: "http://localhost:8090/v1", apiKey: "test-key" }, models: { "test-model": { name: "Test Model", limit: { context: 128000, output: 8192 }, modalities: { input: ["text"], output: ["text"] } } } } };
}
async function makeTempRoot(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "archcode-main-")); tmpRoots.push(root); return root; }
async function writeConfig(config: Record<string, unknown>): Promise<ServerConfigService> { const root = await makeTempRoot(); const path = resolveServerConfigPath(root); await mkdir(join(root, ".archcode"), { recursive: true }); await Bun.write(path, JSON.stringify(config)); return new ServerConfigService({ homeDir: root }); }
function makeConfig(mcp?: Record<string, unknown>): Record<string, unknown> {
  const config = { provider: makeProviderConfig(), profiles: Object.fromEntries(["principal", "deep", "fast"].map((name) => [name, { model: "local:test-model" }])) };
  return mcp === undefined ? config : { ...config, mcp };
}
function makeFakeMcpRuntime(): TestMcpRuntime {
  return createTestMcpRuntime();
}
type RuntimeTestOptions = Omit<AgentRuntimeOptions, "activation" | "projectRegistry"> & {
  projectRegistry?: ProjectRegistry;
};
async function createRuntime(options: RuntimeTestOptions) {
  const result = await options.configService.activateForStartup();
  if (result.status !== "ready") throw new Error(`Expected ready config, received ${result.status}`);
  const runtimeStorageHomeDir = options.runtimeStorageHomeDir ?? await makeTempRoot();
  return createProductionRuntime({
    ...options,
    activation: result.activation,
    projectRegistry: options.projectRegistry
      ?? new ProjectRegistry({ homeDir: runtimeStorageHomeDir, logger: silentLogger }),
    runtimeStorageHomeDir,
  });
}
function nextSessionEvent(
  runtime: AgentRuntime,
  projectSlug: string,
  sessionId: string,
  predicate: (event: GlobalSessionEventEnvelope) => boolean,
): Promise<GlobalSessionEventEnvelope> {
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    unsubscribe = runtime.subscribeSessionEvents((event) => {
      if (event.slug !== projectSlug || event.sessionId !== sessionId || !predicate(event)) return;
      unsubscribe();
      resolve(event);
    });
  });
}

function nextFamilyActivity(
  runtime: AgentRuntime,
  projectSlug: string,
  rootSessionId: string,
  activity: GlobalSSESessionRuntimeChangedEvent["activity"],
): Promise<GlobalSSESessionRuntimeChangedEvent> {
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    unsubscribe = runtime.subscribeSessionRuntimeChanges((event) => {
      if (event.projectSlug !== projectSlug
        || event.rootSessionId !== rootSessionId
        || event.activity !== activity) return;
      unsubscribe();
      resolve(event);
    });
  });
}

function seedToolBatchAnchor(
  store: Awaited<ReturnType<SessionStoreManager["getOrLoad"]>>,
  input: Omit<SessionToolBatch, "stepId" | "assistantMessageId">,
): SessionToolBatch {
  const stepId = crypto.randomUUID();
  store.getState().append({ type: "step-start", stepId, step: input.step });
  for (const call of input.calls) {
    store.getState().append({
      type: "tool-call",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.input,
    });
  }
  store.getState().append({
    type: "step-end",
    stepId,
    step: input.step,
    finishReason: "tool-calls",
  });
  const assistantMessageId = store.getState().messages.find(
    (message) => message.role === "assistant" && message.stepId === stepId,
  )!.id;
  return { ...input, stepId, assistantMessageId };
}

function createGoalActivationStream(
  objective = "Complete the requested migration and verify every relevant test passes.",
): unknown {
  const input = { objective };
  return {
    fullStream: (async function* () {
      yield { type: "tool-input-start", id: "create-goal", toolName: "create_goal" };
      yield { type: "tool-call", toolCallId: "create-goal", toolName: "create_goal", input };
    })(),
    finishReason: Promise.resolve("tool-calls"),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
    text: Promise.resolve("I will keep working until it is verified."),
    toolCalls: Promise.resolve([{ toolCallId: "create-goal", toolName: "create_goal", input }]),
  };
}

function createAbortableStream(abortSignal: AbortSignal): unknown {
  return {
    fullStream: (async function* () {
      if (!abortSignal.aborted) {
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    })(),
    finishReason: Promise.resolve("stop"),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
    text: Promise.resolve(""),
    toolCalls: Promise.resolve([]),
  };
}

function createStoppedStream(): unknown {
  return {
    fullStream: (async function* () {})(),
    finishReason: Promise.resolve("stop"),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
    text: Promise.resolve(""),
    toolCalls: Promise.resolve([]),
  };
}

function createAskUserStream(toolCallId: string): unknown {
  const input = {
    questions: [{
      question: "Continue?",
      header: "Continue",
      options: [{ label: "Yes", description: "Continue" }],
    }],
  };
  return {
    fullStream: (async function* () {
      yield { type: "tool-input-start", id: toolCallId, toolName: "ask_user" };
      yield { type: "tool-call", toolCallId, toolName: "ask_user", input };
    })(),
    finishReason: Promise.resolve("tool-calls"),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
    text: Promise.resolve(""),
    toolCalls: Promise.resolve([{ toolCallId, toolName: "ask_user", input }]),
  };
}

function createBackgroundDelegateStream(toolCallId: string): unknown {
  const input = {
    agent_type: "explore",
    profile: "fast",
    title: "Held child",
    objective: "Wait until the test releases this child",
    skills: [],
    background: true,
  };
  return {
    fullStream: (async function* () {
      yield { type: "tool-input-start", id: toolCallId, toolName: "delegate" };
      yield { type: "tool-call", toolCallId, toolName: "delegate", input };
    })(),
    finishReason: Promise.resolve("tool-calls"),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
    text: Promise.resolve(""),
    toolCalls: Promise.resolve([{ toolCallId, toolName: "delegate", input }]),
  };
}

describe("createRuntime", () => {
  test("constructs runtime without booting server concerns", async () => { const runtime = await createRuntime({ configService: await writeConfig(makeConfig({ servers: {} })), mcpRuntimeFactory: () => makeFakeMcpRuntime() }); expect(runtime.toolRegistry).toBeDefined(); expect(runtime.acceptSessionMessage).toBeDefined(); });
  test("consumes an explicit activation without rereading disk", async () => {
    const passwordHash = "$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA";
    const config = { ...makeConfig({ servers: {} }), auth: { passwordHash } };
    const configService = await writeConfig(config);
    const result = await configService.activateForStartup();
    if (result.status !== "ready") throw new Error(`Expected ready config, received ${result.status}`);
    await rm(configService.configPath);
    const runtimeStorageHomeDir = await makeTempRoot();
    const runtime = await createProductionRuntime({
      configService,
      activation: result.activation,
      projectRegistry: new ProjectRegistry({ homeDir: runtimeStorageHomeDir, logger: silentLogger }),
      runtimeStorageHomeDir,
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    expect(runtime.toolRegistry).toBeDefined();
  });
  test("injects the runtime log safety boundary into the default LSP pool", async () => {
    const literal = "runtime-secret-literal-123456";
    const workspaceRoot = "/private/tmp/archcode-runtime-log-workspace";
    const { logger, entries } = createInMemoryLogger();
    await createRuntime({
      logger,
      externalSecretLiterals: [literal],
      configService: await writeConfig(makeConfig({ servers: {} })),
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });

    await expect(getLspClientPool().acquire(
      { workspaceRoot, serverId: literal },
      { command: "unused" },
    )).rejects.toThrow("Unknown LSP server");

    const entry = entries.find((candidate) => candidate.event === "lsp.pool.acquire.failed");
    expect(entry).toMatchObject({
      event: "lsp.pool.acquire.failed",
      context: { serverId: REDACTION_MARKER },
      meta: { error: { name: "LspInstallerError", code: "RUNTIME_LOG_FAILURE" } },
    });
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(literal);
    expect(serialized).not.toContain(workspaceRoot);
  });
  test("accepts ordinary root Session messages through the durable queue boundary", async () => {
    const workspaceRoot = await makeTempRoot();
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig({ servers: {} })),
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    const project = await runtime.projectRegistry.add({ workspaceRoot, name: "Queued input" });
    const session = await runtime.createSession(workspaceRoot, { agentName: "lead", source: { kind: "direct" }, title: "Queued input" });
    expect(session).toMatchObject({
      executionCount: 0,
      isRunning: false,
      isStreamingModel: false,
    });
    expect(session.nextModelSelection).toMatchObject({
      requested: requestedModelSelection,
      resolved: {
        selection: requestedModelSelection.selection,
        modelDisplayName: "Test Model",
        resolution: "profile_default",
      },
    });
    const clientRequestId = crypto.randomUUID();
    installTestLlmAdapter();
    try {
      const familyIdle = nextFamilyActivity(runtime, project.slug, session.sessionId, "idle");
      const accepted = await runtime.acceptSessionMessage({
        slug: project.slug,
        workspaceRoot,
        sessionId: session.sessionId,
        text: "Inspect the project",
        attachmentIds: [],
        clientRequestId,
        source: "user",
        requestedModelSelection,
      });
      expect(accepted).toMatchObject({ clientRequestId });
      expect(["pending", "canonical"]).toContain(accepted.status);
      await familyIdle;
      expect((await runtime.getSessionFile(workspaceRoot, session.sessionId)).inputRequestReceipts)
        .toContainEqual(expect.objectContaining({ clientRequestId, status: "canonical" }));
    } finally {
      await runtime.abortAllSessionExecutions();
      setLlmAdapterForTest(undefined);
    }
  });
  test("terminalizes a Tool Batch when HITL creation fails and admits the next Execution", async () => {
    const workspaceRoot = await makeTempRoot();
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig({ servers: {} })),
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    const project = await runtime.projectRegistry.add({ workspaceRoot, name: "HITL create failure" });
    const session = await runtime.createSession(workspaceRoot, { agentName: "lead", source: { kind: "direct" } });
    const context = await runtime.contextResolver.resolve(workspaceRoot);
    const originalCreate = context.hitl.create.bind(context.hitl);
    let createAttempts = 0;
    context.hitl.create = mock(async (input) => {
      createAttempts += 1;
      if (createAttempts === 1) throw new Error("transient HITL create failure");
      return await originalCreate(input);
    });
    let streams = 0;
    setLlmAdapterForTest({
      streamText: mock(() => {
        streams += 1;
        return streams === 1 ? createAskUserStream("question-create-failure") : createStoppedStream();
      }) as never,
      generateText: mock(async () => ({ text: "", toolCalls: [] })) as never,
    });

    const failed = nextSessionEvent(
      runtime,
      project.slug,
      session.sessionId,
      (event) => event.payload.type === "execution-end" && event.payload.terminalStatus === "failed",
    );
    await runtime.acceptSessionMessage({
      slug: project.slug,
      workspaceRoot,
      sessionId: session.sessionId,
      text: "Ask before continuing",
      attachmentIds: [],
      clientRequestId: crypto.randomUUID(),
      source: "user",
      requestedModelSelection,
    });
    await failed;

    const afterFailure = await runtime.getSessionFile(workspaceRoot, session.sessionId);
    expect(createAttempts).toBe(2);
    expect(afterFailure.executions.at(-1)?.status).toBe("failed");
    expect(typeof afterFailure.toolBatches.at(-1)?.archivedAt).toBe("string");
    expect(afterFailure.toolBatches.at(-1)?.calls[0]).toMatchObject({
      toolCallId: "question-create-failure",
      state: "failed",
      result: { isError: true },
    });

    const completed = nextSessionEvent(
      runtime,
      project.slug,
      session.sessionId,
      (event) => event.payload.type === "execution-end" && event.payload.terminalStatus === "completed",
    );
    await runtime.acceptSessionMessage({
      slug: project.slug,
      workspaceRoot,
      sessionId: session.sessionId,
      text: "Continue after the failed question",
      attachmentIds: [],
      clientRequestId: crypto.randomUUID(),
      source: "user",
      requestedModelSelection,
    });
    await completed;
    const recovered = await runtime.getSessionFile(workspaceRoot, session.sessionId);
    expect(recovered.executions).toHaveLength(2);
    expect(recovered.executions.at(-1)?.status).toBe("completed");
    await runtime.shutdown();
  });
  test("retries the same queued input after release reconciliation fails once", async () => {
    const workspaceRoot = await makeTempRoot();
    const { logger, entries } = createInMemoryLogger();
    const runtime = await createRuntime({
      logger,
      configService: await writeConfig(makeConfig({ servers: {} })),
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    const project = await runtime.projectRegistry.add({ workspaceRoot, name: "Input release retry" });
    const session = await runtime.createSession(workspaceRoot, { agentName: "lead", source: { kind: "direct" } });
    const originalResolve = runtime.contextResolver.resolve.bind(runtime.contextResolver);
    let resolveAttempts = 0;
    runtime.contextResolver.resolve = async (root) => {
      resolveAttempts += 1;
      if (resolveAttempts === 1) throw new Error("transient input release failure");
      return await originalResolve(root);
    };
    installTestLlmAdapter();
    const executionCompleted = nextSessionEvent(
      runtime,
      project.slug,
      session.sessionId,
      (event) => event.payload.type === "execution-end" && event.payload.terminalStatus === "completed",
    );
    const clientRequestId = crypto.randomUUID();

    await runtime.acceptSessionMessage({
      slug: project.slug,
      workspaceRoot,
      sessionId: session.sessionId,
      text: "Run after retry",
      attachmentIds: [],
      clientRequestId,
      source: "automation",
      requestedModelSelection,
    });
    await executionCompleted;

    const recovered = await runtime.getSessionFile(workspaceRoot, session.sessionId);
    expect(resolveAttempts).toBeGreaterThanOrEqual(2);
    expect(recovered.executions).toHaveLength(1);
    expect(recovered.inputRequestReceipts).toContainEqual(expect.objectContaining({
      clientRequestId,
      status: "canonical",
    }));
    expect(entries.some((entry) => entry.event === "project.runtime.reconcile_failed")).toBe(true);
    await runtime.shutdown();
  });
  test("retries durable queued work after child-slot release reconciliation fails once", async () => {
    const workspaceRoot = await makeTempRoot();
    const { logger, entries } = createInMemoryLogger();
    const runtime = await createRuntime({
      logger,
      configService: await writeConfig(makeConfig({ servers: {} })),
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    const project = await runtime.projectRegistry.add({ workspaceRoot, name: "Child release retry" });
    const parent = await runtime.createSession(workspaceRoot, { agentName: "lead", source: { kind: "direct" } });
    let resolveChildStarted!: () => void;
    const childStarted = new Promise<void>((resolve) => { resolveChildStarted = resolve; });
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });
    let delegateIssued = false;
    setLlmAdapterForTest({
      streamText: mock((options: { tools?: Record<string, unknown> }) => {
        const isRoot = options.tools?.create_goal !== undefined;
        if (isRoot && !delegateIssued) {
          delegateIssued = true;
          return createBackgroundDelegateStream("delegate-held-child");
        }
        if (!isRoot) {
          resolveChildStarted();
          return {
            fullStream: (async function* () { await childGate; })(),
            finishReason: Promise.resolve("stop"),
            usage: Promise.resolve({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
            text: Promise.resolve(""),
            toolCalls: Promise.resolve([]),
          };
        }
        return createStoppedStream();
      }) as never,
      generateText: mock(async () => ({ text: "", toolCalls: [] })) as never,
    });
    await runtime.acceptSessionMessage({
      slug: project.slug,
      workspaceRoot,
      sessionId: parent.sessionId,
      text: "Start a background child",
      attachmentIds: [],
      clientRequestId: crypto.randomUUID(),
      source: "user",
      requestedModelSelection,
    });
    await childStarted;

    const queuedSessionId = crypto.randomUUID();
    const externalStoreManager = new SessionStoreManager({ logger: silentLogger });
    externalStoreManager.create(queuedSessionId, workspaceRoot, { agentName: "lead", source: { kind: "direct" } });
    await externalStoreManager.flushSession(queuedSessionId, workspaceRoot);
    const queuedClientRequestId = crypto.randomUUID();
    await new SessionInputService(externalStoreManager, EMPTY_SESSION_ATTACHMENT_RESOLVER).acceptMessage({
      sessionId: queuedSessionId,
      workspaceRoot,
      text: "Continue from the child-slot retry",
      attachmentIds: [],
      clientRequestId: queuedClientRequestId,
      source: "automation",
      requestedModelSelection,
    });
    const originalResolve = runtime.contextResolver.resolve.bind(runtime.contextResolver);
    let resolveAttempts = 0;
    runtime.contextResolver.resolve = async (root) => {
      resolveAttempts += 1;
      if (resolveAttempts === 1) throw new Error("transient child release failure");
      return await originalResolve(root);
    };
    const queuedCompleted = nextSessionEvent(
      runtime,
      project.slug,
      queuedSessionId,
      (event) => event.payload.type === "execution-end" && event.payload.terminalStatus === "completed",
    );

    releaseChild();
    await queuedCompleted;

    const recovered = await runtime.getSessionFile(workspaceRoot, queuedSessionId);
    expect(resolveAttempts).toBeGreaterThanOrEqual(2);
    expect(recovered.executions).toHaveLength(1);
    expect(recovered.inputRequestReceipts).toContainEqual(expect.objectContaining({
      clientRequestId: queuedClientRequestId,
      status: "canonical",
    }));
    expect(entries.some((entry) => entry.event === "project.runtime.reconcile_failed")).toBe(true);
    await runtime.shutdown();
  });
  test("persists the upload media-type domain through message commit and restart", async () => {
    const workspaceRoot = await makeTempRoot();
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig({ servers: {} })),
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    const project = await runtime.projectRegistry.add({
      workspaceRoot,
      name: "Attachment media type persistence",
    });
    const session = await runtime.createSession(workspaceRoot, { agentName: "lead", source: { kind: "direct" } });
    const attachmentId = crypto.randomUUID();
    const upload = await runtime.uploadSessionAttachment({
      workspaceRoot,
      rootSessionId: session.sessionId,
      attachmentId,
      name: "extended-token.bin",
      mediaType: "application/x~foo",
      sizeBytes: 0,
      body: null,
    });
    expect(upload.descriptor.mediaType).toBe("application/x~foo");

    installTestLlmAdapter();
    try {
      const familyIdle = nextFamilyActivity(runtime, project.slug, session.sessionId, "idle");
      await runtime.acceptSessionMessage({
        slug: project.slug,
        workspaceRoot,
        sessionId: session.sessionId,
        text: "",
        attachmentIds: [attachmentId],
        clientRequestId: crypto.randomUUID(),
        source: "user",
        requestedModelSelection,
      });
      await familyIdle;
    } finally {
      await runtime.abortAllSessionExecutions();
      await runtime.shutdown();
      setLlmAdapterForTest(undefined);
    }

    const restartedManager = new SessionStoreManager({ logger: silentLogger });
    const restarted = await restartedManager.getOrLoad(session.sessionId, workspaceRoot);
    expect(restarted.getState().messages).toContainEqual(expect.objectContaining({
      role: "user",
      parts: expect.arrayContaining([expect.objectContaining({
        type: "attachment",
        attachment: expect.objectContaining({
          id: attachmentId,
          mediaType: "application/x~foo",
        }),
      })]),
    }));
  });
  test("accepts attachment input through a formal Todo Discussion root", async () => {
    const workspaceRoot = await makeTempRoot();
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig({ servers: {} })),
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    const project = await runtime.projectRegistry.add({
      workspaceRoot,
      name: "Todo Discussion attachments",
    });
    const context = await runtime.contextResolver.resolve(workspaceRoot);
    const todo = await context.todos.createTodo({
      content: "Discuss attachment evidence\n\nConfirm the attachment before work starts.",
    });

    installTestLlmAdapter();
    try {
      const started = await context.todos.createSession(todo.id, {
        expectedRevision: todo.revision,
        entry: "discussion",
      });
      const discussion = await runtime.getSessionFile(workspaceRoot, started.sessionId);
      await nextFamilyActivity(runtime, project.slug, discussion.sessionId, "idle");
      const attachmentId = crypto.randomUUID();
      await runtime.uploadSessionAttachment({
        workspaceRoot,
        rootSessionId: discussion.sessionId,
        attachmentId,
        name: "discussion.txt",
        mediaType: "text/plain",
        sizeBytes: 0,
        body: null,
      });

      const familyIdle = nextFamilyActivity(
        runtime,
        project.slug,
        discussion.sessionId,
        "idle",
      );
      await runtime.acceptSessionMessage({
        slug: project.slug,
        workspaceRoot,
        sessionId: discussion.sessionId,
        text: "",
        attachmentIds: [attachmentId],
        clientRequestId: crypto.randomUUID(),
        source: "user",
        requestedModelSelection,
      });
      await familyIdle;

      const stored = await runtime.getSessionFile(workspaceRoot, discussion.sessionId);
      expect(stored).toMatchObject({
        sessionId: discussion.sessionId,
        rootSessionId: discussion.sessionId,
        agentName: "discussion",
        source: { kind: "todo", todoId: todo.id, entry: "discussion" },
      });
      expect(stored.messages).toContainEqual(expect.objectContaining({
        role: "user",
        parts: expect.arrayContaining([expect.objectContaining({
          type: "attachment",
          attachment: expect.objectContaining({ id: attachmentId }),
        })]),
      }));
    } finally {
      await runtime.abortAllSessionExecutions();
      await runtime.shutdown();
      setLlmAdapterForTest(undefined);
    }
  });
  test("uses the preallocated Todo Discussion Session identity through the Runtime adapter", async () => {
    const workspaceRoot = await makeTempRoot();
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig({ servers: {} })),
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    const project = await runtime.projectRegistry.add({
      workspaceRoot,
      name: "Idempotent Todo Discussion",
    });
    const context = await runtime.contextResolver.resolve(workspaceRoot);
    const request = {
      clientRequestId: crypto.randomUUID(),
      content: "Discuss through the Runtime adapter",
    };

    installTestLlmAdapter();
    try {
      const created = await context.todos.startDiscussion(request);
      const familyIdle = nextFamilyActivity(
        runtime,
        project.slug,
        created.session.sessionId,
        "idle",
      );
      if (runtime.getSessionFamilyActivity(workspaceRoot, created.session.sessionId) !== "idle") {
        await familyIdle;
      }
      const replay = await context.todos.startDiscussion(request);
      const stored = await runtime.getSessionFile(workspaceRoot, created.session.sessionId);

      expect(replay.todo.id).toBe(created.todo.id);
      expect(replay.session.sessionId).toBe(created.session.sessionId);
      expect(stored).toMatchObject({
        sessionId: created.session.sessionId,
        rootSessionId: created.session.sessionId,
        agentName: "discussion",
        source: {
          kind: "todo",
          todoId: created.todo.id,
          entry: "discussion",
        },
      });
      expect((await runtime.listSessions(workspaceRoot)).filter(
        (session) => session.source?.kind === "todo"
          && session.source.todoId === created.todo.id
          && session.source.entry === "discussion",
      )).toHaveLength(1);
      expect(project.slug).toBe(context.project.slug);
    } finally {
      await runtime.abortAllSessionExecutions();
      await runtime.shutdown();
    }
  });
  test("retries a transient durable conflict when projecting the shared Agent Tree", async () => {
    const workspaceRoot = await makeTempRoot();
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig({ servers: {} })),
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    const project = await runtime.projectRegistry.add({ workspaceRoot, name: "Agent tree conflict retry" });
    const session = await runtime.createSession(workspaceRoot, {
      agentName: "lead",
      source: { kind: "direct" },
      title: "Agent tree conflict retry",
    });
    const originalCapture = SessionStoreManager.prototype.captureSessionFamilySnapshot;
    let captureAttempts = 0;
    SessionStoreManager.prototype.captureSessionFamilySnapshot = async function (...args) {
      captureAttempts += 1;
      if (captureAttempts === 1) {
        throw new SessionFamilySnapshotConflictError(session.sessionId, "revision-1", "revision-2");
      }
      return await originalCapture.apply(this, args);
    };

    try {
      const tree = await runtime.listSessionTree(workspaceRoot, session.sessionId);
      expect(tree.root.session.sessionId).toBe(session.sessionId);
      expect(captureAttempts).toBe(2);
      expect(project.workspaceRoot).toBe(workspaceRoot);
    } finally {
      SessionStoreManager.prototype.captureSessionFamilySnapshot = originalCapture;
      await runtime.abortAllSessionExecutions();
      await runtime.shutdown();
    }
  });

  test("keeps the external pending-message Steer entry root-only", async () => {
    const workspaceRoot = await makeTempRoot();
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig({ servers: {} })),
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    await runtime.projectRegistry.add({ workspaceRoot, name: "Root-only Steer" });
    const root = await runtime.createSession(workspaceRoot, {
      agentName: "lead",
      source: { kind: "direct" },
      title: "Root-only Steer",
    });
    const childSessionId = crypto.randomUUID();
    const externalStoreManager = new SessionStoreManager({ logger: silentLogger });
    externalStoreManager.create(childSessionId, workspaceRoot, {
      rootSessionId: root.sessionId,
      parentSessionId: root.sessionId,
      agentName: "explore",
      title: "Child must reject external Steer",
      delegationRequest: {
        agent_type: "explore",
        profile: "fast",
        title: "Child must reject external Steer",
        objective: "Remain inaccessible to the external root-only Steer entry.",
        skills: [],
        background: true,
      },
    });
    await externalStoreManager.flushSession(childSessionId, workspaceRoot);

    try {
      await expect(runtime.steerPendingSessionMessage({
        workspaceRoot,
        sessionId: childSessionId,
        messageId: "child-message",
        expectedRevision: 0,
        expectedExecutionId: "child-execution",
      })).rejects.toBeInstanceOf(NotRootSessionError);
      await expect(runtime.steerPendingSessionMessage({
        workspaceRoot,
        sessionId: root.sessionId,
        messageId: "root-message",
        expectedRevision: 0,
        expectedExecutionId: "root-execution",
      })).rejects.toBeInstanceOf(SessionSteerUnavailableError);
    } finally {
      await runtime.abortAllSessionExecutions();
      await runtime.shutdown();
    }
  });

  test("integrates Analyst and Build results through the ordinary Lead delegation path", async () => {
    const workspaceRoot = await makeTempRoot();
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig({ servers: {} })),
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    const project = await runtime.projectRegistry.add({ workspaceRoot, name: "Lead collaboration" });
    const session = await runtime.createSession(workspaceRoot, { agentName: "lead", source: { kind: "direct" }, title: "Lead collaboration" });
    expect(session.source).toEqual({ kind: "direct" });
    const overriddenModel = await runtime.patchSessionModelSelection({
      workspaceRoot,
      sessionId: session.sessionId,
      expectedRevision: 0,
      requestedModelSelection: {
        mode: "session_override",
        selection: { model: "local:test-model" },
      },
    });
    expect(overriddenModel.modelSelection).toEqual({
      revision: 1,
      override: { model: "local:test-model" },
    });
    expect(overriddenModel.nextModelSelection).toMatchObject({
      requested: { mode: "session_override" },
      resolved: { resolution: "session_override" },
    });
    const clearedModel = await runtime.patchSessionModelSelection({
      workspaceRoot,
      sessionId: session.sessionId,
      expectedRevision: 1,
      requestedModelSelection,
    });
    expect(clearedModel.modelSelection).toEqual({ revision: 2 });
    expect(clearedModel.nextModelSelection).toMatchObject({
      requested: { mode: "profile_default" },
      resolved: { resolution: "profile_default" },
    });
    let rootCalls = 0;
    let integratedMessages = "";
    const seenToolSets: string[][] = [];
    const textStream = (text: string) => ({
      fullStream: (async function* () {
        yield { type: "text-start", id: "output" };
        yield { type: "text-delta", id: "output", text };
        yield { type: "text-end", id: "output" };
      })(),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({ totalTokens: 1 }),
      text: Promise.resolve(text),
      toolCalls: Promise.resolve([]),
    });
    const delegations = [
      {
        toolCallId: "delegate-analysis",
        toolName: "delegate",
        input: {
          agent_type: "analyst",
          profile: "deep",
          title: "Analyze the change",
          objective: "Identify the architecture risks and required evidence.",
          skills: ["analyze-work"],
          background: false,
        },
      },
      {
        toolCallId: "delegate-build",
        toolName: "delegate",
        input: {
          agent_type: "build",
          profile: "deep",
          title: "Implement the change",
          objective: "Implement the bounded change and report verification.",
          skills: ["safe-refactor"],
          background: false,
        },
      },
    ] as const;
    setLlmAdapterForTest({
      streamText: mock((options: { tools?: Record<string, unknown>; messages?: unknown[] }) => {
        const tools = Object.keys(options.tools ?? {});
        seenToolSets.push(tools);
        if (tools.includes("create_goal")) {
          rootCalls += 1;
          if (rootCalls === 1) {
            return {
              fullStream: (async function* () {
                for (const call of delegations) yield { type: "tool-call", ...call };
              })(),
              finishReason: Promise.resolve("tool-calls"),
              usage: Promise.resolve({ totalTokens: 1 }),
              text: Promise.resolve(""),
              toolCalls: Promise.resolve([...delegations]),
            } as never;
          }
          integratedMessages = JSON.stringify(options.messages ?? []);
          return textStream("Integrated the Analyst and Build results.") as never;
        }
        if (tools.includes("file_write")) return textStream("Build verification complete.") as never;
        return textStream("Analysis evidence complete.") as never;
      }) as never,
      generateText: mock(async () => ({ text: "Lead collaboration", toolCalls: [] })) as never,
    });

    try {
      const clientRequestId = crypto.randomUUID();
      const familyIdle = nextFamilyActivity(runtime, project.slug, session.sessionId, "idle");
      await runtime.acceptSessionMessage({
        slug: project.slug,
        workspaceRoot,
        sessionId: session.sessionId,
        text: "Analyze and implement the requested change.",
        attachmentIds: [],
        clientRequestId,
        source: "user",
        requestedModelSelection,
      });
      await familyIdle;

      const tree = await runtime.listSessionTree(workspaceRoot, session.sessionId);
      expect(seenToolSets).toContainEqual(expect.arrayContaining(["create_goal", "delegate"]));
      expect(integratedMessages).toContain("Analysis evidence complete.");
      expect(integratedMessages).toContain("Build verification complete.");
      expect(tree.diagnostics).toEqual([]);
      expect(tree.root.children.map(({ session: child }) => ({
        agentName: child.agentName,
        profile: child.profile,
        skills: child.activeSkillNames,
        title: child.title,
      }))).toEqual([
        { agentName: "analyst", profile: "deep", skills: ["analyze-work"], title: "Analyze the change" },
        { agentName: "build", profile: "deep", skills: ["safe-refactor"], title: "Implement the change" },
      ]);
      for (const child of tree.root.children) {
        expect((await runtime.getSessionFile(workspaceRoot, child.session.sessionId)).executions.at(-1)?.status)
          .toBe("completed");
      }
      expect((await runtime.getSessionFile(workspaceRoot, session.sessionId)).executions.at(-1)?.status)
        .toBe("completed");
    } finally {
      await runtime.abortAllSessionExecutions();
      await runtime.shutdown();
    }
  });
  test("does not execute a handled command twice when the same request is retried", async () => {
    const workspaceRoot = await makeTempRoot();
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig({ servers: {} })),
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    const project = await runtime.projectRegistry.add({ workspaceRoot, name: "Command retry" });
    const session = await runtime.createSession(workspaceRoot, { agentName: "lead", source: { kind: "direct" } });
    const clientRequestId = crypto.randomUUID();
    const input = {
      slug: project.slug,
      workspaceRoot,
      sessionId: session.sessionId,
      text: "/unknown-command",
      attachmentIds: [],
      clientRequestId,
      source: "user" as const,
      requestedModelSelection,
    };

    await expect(runtime.acceptSessionMessage(input)).resolves.toEqual({ clientRequestId, status: "command" });
    await expect(runtime.acceptSessionMessage(input)).resolves.toEqual({ clientRequestId, status: "command" });

    const file = await runtime.getSessionFile(workspaceRoot, session.sessionId);
    expect(file.inputRequestReceipts).toEqual([
      expect.objectContaining({ kind: "command", clientRequestId, status: "completed" }),
    ]);
    expect(file.messages.flatMap((message) => message.role === "user" ? message.parts : [])
      .filter((part) => part.type === "system-notice" && part.notice.includes("Unknown command")))
      .toHaveLength(1);
  });
  test("coalesces concurrent retries before the command receipt is durable", async () => {
    const workspaceRoot = await makeTempRoot();
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig({ servers: {} })),
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    const project = await runtime.projectRegistry.add({ workspaceRoot, name: "Concurrent command retry" });
    const session = await runtime.createSession(workspaceRoot, { agentName: "lead", source: { kind: "direct" } });
    const clientRequestId = crypto.randomUUID();
    const input = {
      slug: project.slug,
      workspaceRoot,
      sessionId: session.sessionId,
      text: "/unknown-command",
      attachmentIds: [],
      clientRequestId,
      source: "user" as const,
      requestedModelSelection,
    };

    await expect(Promise.all([
      runtime.acceptSessionMessage(input),
      runtime.acceptSessionMessage(input),
    ])).resolves.toEqual([
      { clientRequestId, status: "command" },
      { clientRequestId, status: "command" },
    ]);

    const file = await runtime.getSessionFile(workspaceRoot, session.sessionId);
    expect(file.inputRequestReceipts).toEqual([
      expect.objectContaining({ kind: "command", clientRequestId, status: "completed" }),
    ]);
    expect(file.messages.flatMap((message) => message.role === "user" ? message.parts : [])
      .filter((part) => part.type === "system-notice" && part.notice.includes("Unknown command")))
      .toHaveLength(1);
  });

  test("rejects slash commands with attachments before command side effects", async () => {
    const workspaceRoot = await makeTempRoot();
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig({ servers: {} })),
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    const project = await runtime.projectRegistry.add({ workspaceRoot, name: "Command attachments" });
    const session = await runtime.createSession(workspaceRoot, { agentName: "lead", source: { kind: "direct" } });
    await expect(runtime.acceptSessionMessage({
      slug: project.slug,
      workspaceRoot,
      sessionId: session.sessionId,
      text: "/unknown-command",
      attachmentIds: [crypto.randomUUID()],
      clientRequestId: crypto.randomUUID(),
      source: "user",
      requestedModelSelection,
    })).rejects.toMatchObject({
      name: "SessionInputConflictError",
      reason: "state",
    });
    expect((await runtime.getSessionFile(workspaceRoot, session.sessionId)).inputRequestReceipts)
      .toEqual([]);
  });
  test("publishes provider and model settings to the live runtime", async () => {
    const configService = await writeConfig(makeConfig({ servers: {} }));
    const runtime = await createRuntime({
      configService,
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    const snapshot = await runtime.configService.getSnapshot();
    const update = structuredClone(snapshot.config) as unknown as ServerConfigUpdate;
    update.provider.local.options.apiKey = { action: "preserve" };
    update.provider.local.models["new-model"] = {
      name: "New",
      limit: { context: 128000, output: 8192 },
      modalities: { input: ["text"], output: ["text"] },
    };

    const saved = await runtime.configService.save({
      expectedRevision: snapshot.revision,
      config: update,
    });

    expect(saved.restartRequiredSections).toEqual([]);
    expect(saved.modelRuntimeRevision).toBe(runtime.modelRuntime.current.revision);
    expect(saved.modelRuntimeRevision).not.toBe(snapshot.modelRuntimeRevision);
    expect(runtime.modelRuntime.current.tryResolveSelection({ model: "local:new-model" }))
      .toBeDefined();
  });
  test("applies the resolved MCP config through the live runtime facade", async () => {
    let applied: ResolvedMcpConfig | undefined;
    const mcpRuntime = createTestMcpRuntime({
      apply: async (config) => { applied = config; },
      statuses: { servers: { docs: { state: "connecting", startedAt: 1 } } },
      inventory: { servers: { docs: [] } },
    });
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig()),
      mcpRuntimeFactory: () => mcpRuntime,
    });
    await Promise.resolve();
    expect(applied).toEqual({ disabledBuiltins: [], servers: {} });
    expect(runtime.getMcpServerStatus()).toEqual({
      servers: { docs: { state: "connecting", startedAt: 1 } },
    });
    expect(runtime.getMcpServerInventory()).toEqual({ servers: { docs: [] } });
  });
  test("exposes project registry and shared context resolver", async () => { const runtime = await createRuntime({ configService: await writeConfig(makeConfig()), mcpRuntimeFactory: () => makeFakeMcpRuntime() }); expect(runtime.projectRegistry).toBeDefined(); expect(runtime.contextResolver).toBeDefined(); });
  test("emits runtime snapshot without idle families", async () => { const workspaceRoot = await makeTempRoot(); const runtime = await createRuntime({ configService: await writeConfig(makeConfig()), mcpRuntimeFactory: () => makeFakeMcpRuntime() }); const project = await runtime.projectRegistry.add({ workspaceRoot, name: "Runtime snapshot" }); const session = await runtime.createSession(workspaceRoot, { agentName: "lead", source: { kind: "direct" } }); const changes: GlobalSSESessionRuntimeChangedEvent[] = []; const unsubscribe = runtime.subscribeSessionRuntimeChanges((event) => changes.push(event)); const events = await runtime.listSessionRuntimeEvents(); expect(events[0]).toMatchObject({ type: "session.runtime.snapshot", projectSlugs: [project.slug], families: [] }); await expect(runtime.stopSessionFamily(workspaceRoot, session.sessionId)).resolves.toBeUndefined(); expect(changes.map(({ activity }) => activity)).toEqual(["stopping", "idle"]); unsubscribe(); });

  test("startup continuation recovery preserves persisted Session recency and content", async () => {
    const workspaceRoot = await makeTempRoot();
    const registryHome = await makeTempRoot();
    const configService = await writeConfig(makeConfig());
    const runtime1 = await createRuntime({
      configService,
      runtimeStorageHomeDir: registryHome,
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    await runtime1.projectRegistry.add({ workspaceRoot, name: "Stable recency" });
    const sessions = await Promise.all(
      ["oldest", "middle", "newest"].map((title) =>
        runtime1.createSession(workspaceRoot, { agentName: "lead", source: { kind: "direct" }, title })),
    );
    await runtime1.shutdown();

    const snapshots = await Promise.all(sessions.map(async (session, index) => {
      const path = join(
        workspaceRoot,
        ".archcode",
        "runtime",
        "sessions",
        session.sessionId,
        "session.json",
      );
      const persisted = await Bun.file(path).json() as Record<string, unknown>;
      persisted.createdAt = (index + 1) * 1_000;
      persisted.updatedAt = (index + 1) * 1_000;
      const content = `${JSON.stringify(persisted, null, 2)}\n`;
      await Bun.write(path, content);
      return { path, content, sessionId: session.sessionId };
    }));

    const runtime2 = await createRuntime({
      configService,
      runtimeStorageHomeDir: registryHome,
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    await runtime2.recoverSessionContinuations();

    expect((await runtime2.listSessions(workspaceRoot)).map((session) => session.sessionId))
      .toEqual([...snapshots].reverse().map(({ sessionId }) => sessionId));
    for (const snapshot of snapshots) {
      expect(await Bun.file(snapshot.path).text()).toBe(snapshot.content);
    }
    await runtime2.shutdown();
  });


  test("redacts HITL delivery failures before logs and durable delivery metadata", async () => {
    const secret = "hitl-delivery-secret-123456";
    const workspaceRoot = await makeTempRoot();
    const { logger, entries } = createInMemoryLogger();
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig()),
      externalSecretLiterals: [secret],
      logger,
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    const project = await runtime.projectRegistry.add({ workspaceRoot, name: "HITL delivery failure" });
    const session = await runtime.createSession(workspaceRoot, { agentName: "lead", source: { kind: "direct" } });
    const context = await runtime.contextResolver.resolve(workspaceRoot);
    const record = (await context.hitl.create({
      hitlId: secret,
      requestKey: `tool:${"a".repeat(64)}`,
      owner: { type: "session", id: session.sessionId },
      source: { type: "tool_permission", toolCallId: "missing-call", toolName: "bash" },
      displayPayload: { title: "Approve Bash", redacted: true },
      persistentApprovalEligible: false,
    })).record;

    const response = await runtime.respondToHitl({
      slug: project.slug,
      workspaceRoot,
      hitlId: record.hitlId,
      response: { type: "permission_decision", decision: "approve_once" },
    });
    expect(response.status).toBe("answered");
    const failed = (await context.hitl.list()).find(({ hitlId }) => hitlId === record.hitlId);
    expect(failed?.delivery?.error).toContain(REDACTION_MARKER);
    expect(failed?.delivery?.error).not.toContain(secret);
    expect(new TextEncoder().encode(failed?.delivery?.error ?? "").byteLength).toBeLessThanOrEqual(2 * 1024);

    const deliveryLogs = entries.filter(({ event }) => event === "hitl.delivery.failed");
    expect(deliveryLogs).toHaveLength(3);
    const serialized = JSON.stringify(deliveryLogs);
    expect(serialized).toContain(REDACTION_MARKER);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("stack");
    expect(deliveryLogs.every((entry) => entry.error === undefined)).toBe(true);
    expect(deliveryLogs.every((entry) => typeof entry.meta?.failure === "object")).toBe(true);
  });

  test("waits for the exact live run boundary when HITL is answered before suspension persists", async () => {
    const workspaceRoot = await makeTempRoot();
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig()),
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    const project = await runtime.projectRegistry.add({ workspaceRoot, name: "Fast HITL answer" });
    const session = await runtime.createSession(workspaceRoot, { agentName: "lead", source: { kind: "direct" } });
    const context = await runtime.contextResolver.resolve(workspaceRoot);
    const originalCreate = context.hitl.create.bind(context.hitl);
    let responsePromise: ReturnType<AgentRuntime["respondToHitl"]> | undefined;
    let markResponseStarted!: () => void;
    const responseStarted = new Promise<void>((resolve) => {
      markResponseStarted = resolve;
    });
    context.hitl.create = async (...args: Parameters<typeof originalCreate>) => {
      const created = await originalCreate(...args);
      responsePromise = runtime.respondToHitl({
        slug: project.slug,
        workspaceRoot,
        hitlId: created.record.hitlId,
        response: { type: "question_answer", answers: ["Yes"] },
      });
      markResponseStarted();
      return created;
    };

    let streams = 0;
    setLlmAdapterForTest({
      streamText: mock(() => {
        streams += 1;
        return streams === 1 ? createAskUserStream("fast-question") : createStoppedStream();
      }) as never,
      generateText: mock(async () => ({ text: "", toolCalls: [] })) as never,
    });
    const lifecycle: GlobalSessionEventEnvelope[] = [];
    const unsubscribe = runtime.subscribeSessionEvents((event) => {
      if (event.slug === project.slug && event.sessionId === session.sessionId) lifecycle.push(event);
    });
    const completed = nextSessionEvent(
      runtime,
      project.slug,
      session.sessionId,
      (event) => event.payload.type === "execution-end",
    );

    await runtime.acceptSessionMessage({
      slug: project.slug,
      workspaceRoot,
      sessionId: session.sessionId,
      text: "Ask before continuing.",
      attachmentIds: [],
      clientRequestId: crypto.randomUUID(),
      source: "user",
      requestedModelSelection,
    });
    await responseStarted;
    expect((await responsePromise!).status).toBe("resolved");
    await completed;
    unsubscribe();

    const file = await runtime.getSessionFile(workspaceRoot, session.sessionId);
    expect(file.executions).toHaveLength(1);
    expect(file.executions[0]).toMatchObject({
      status: "completed",
      runs: [{ ordinal: 0 }, { ordinal: 1 }],
    });
    const executionId = file.executions[0]!.id;
    const lifecycleTypes = lifecycle
      .filter((event) => "executionId" in event.payload && event.payload.executionId === executionId)
      .map((event) => event.payload.type);
    expect(lifecycleTypes).toEqual(expect.arrayContaining([
      "execution-start",
      "execution-suspended",
      "execution-resumed",
      "execution-end",
    ]));
    expect(lifecycleTypes.indexOf("execution-suspended"))
      .toBeLessThan(lifecycleTypes.indexOf("execution-resumed"));
    const suspension = lifecycle.find((event) =>
      event.payload.type === "execution-suspended" && event.payload.executionId === executionId
    );
    expect(suspension?.payload).toMatchObject({
      type: "execution-suspended",
      suspension: {
        kind: "hitl",
      },
    });
    if (suspension?.payload.type !== "execution-suspended" || suspension.payload.suspension.kind !== "hitl") {
      throw new Error("Expected a persisted HITL suspension");
    }
    expect(suspension.payload.suspension.blockerIds).toHaveLength(1);
    expect(typeof suspension.payload.suspension.blockerIds[0]).toBe("string");
    const call = file.toolBatches[0]?.calls[0];
    expect(call).toMatchObject({
      toolCallId: "fast-question",
      state: "completed",
    });
    expect(typeof call?.blocker?.hitlId).toBe("string");
    expect(typeof call?.blocker?.responseAppliedAt).toBe("string");
    expect(file.executions.some((execution) => execution.status === "interrupted")).toBe(false);
    await runtime.shutdown();
  });

  test("rejects startup recovery when any registered project cannot reconcile", async () => {
    const healthyWorkspaceRoot = await makeTempRoot();
    const failedWorkspaceRoot = await makeTempRoot();
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig()),
      runtimeStorageHomeDir: await makeTempRoot(),
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    await runtime.projectRegistry.add({ workspaceRoot: healthyWorkspaceRoot, name: "Healthy project" });
    await runtime.createSession(healthyWorkspaceRoot, { agentName: "lead", source: { kind: "direct" } });
    await runtime.projectRegistry.add({ workspaceRoot: failedWorkspaceRoot, name: "Failed project" });
    const failedSession = await runtime.createSession(failedWorkspaceRoot, { agentName: "lead", source: { kind: "direct" } });
    const context = await runtime.contextResolver.resolve(failedWorkspaceRoot);
    const request = context.hitl.codec.createAskUserRequest({
      toolCallId: "missing-startup-call",
      displayPayload: {
        title: "Continue",
        summary: "Continue?",
        questions: [{ question: "Continue?", header: "Continue", custom: true }],
        redacted: true,
      },
    });
    const record = (await context.hitl.create({
      requestKey: context.hitl.codec.createToolRequestKey({
        sessionId: failedSession.sessionId,
        toolCallId: "missing-startup-call",
        toolName: "ask_user",
        request,
      }),
      owner: { type: "session", id: failedSession.sessionId },
      source: request.source,
      displayPayload: request.displayPayload,
    })).record;
    await context.hitl.respond(record.hitlId, {
      type: "question_answer",
      answers: ["Yes"],
    });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await context.hitl.resolve(record.hitlId, { type: "dispatching" });
      await context.hitl.resolve(record.hitlId, {
        type: "delivery_failed",
        error: `failed-${attempt}`,
        retryAt: new Date().toISOString(),
      });
    }

    await expect(runtime.recoverSessionContinuations())
      .rejects.toThrow(`Answered HITL ${record.hitlId} exhausted delivery attempts`);
    await runtime.shutdown();
  });

  test("recovers one persisted active Session Goal through the public Runtime boundary", async () => {
    const workspaceRoot = await makeTempRoot();
    const registryHome = await makeTempRoot();
    let firstRuntimeStreams = 0;
    setLlmAdapterForTest({
      streamText: mock(() => {
        firstRuntimeStreams += 1;
        return firstRuntimeStreams === 1
          ? createGoalActivationStream("Keep working through the authentication migration until every test passes.")
          : createStoppedStream();
      }) as never,
      generateText: mock(async () => ({
        text: "",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
      })) as never,
    });
    const runtime1 = await createRuntime({
      configService: await writeConfig(makeConfig()),
      runtimeStorageHomeDir: registryHome,
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    const project = await runtime1.projectRegistry.add({ workspaceRoot, name: "Goal restart" });
    const session = await runtime1.createSession(workspaceRoot, { agentName: "lead", source: { kind: "direct" } });

    const goalCreated = nextSessionEvent(
      runtime1,
      project.slug,
      session.sessionId,
      (event) => event.payload.type === "session.goal_changed" && event.payload.action === "created",
    );
    await runtime1.acceptSessionMessage({
      slug: project.slug,
      workspaceRoot,
      sessionId: session.sessionId,
      text: "Keep working through the authentication migration until every test passes.",
      attachmentIds: [],
      clientRequestId: crypto.randomUUID(),
      source: "user",
      requestedModelSelection,
    });
    await goalCreated;
    // Persist a quiescent Goal before disposing Runtime 1. This prevents its
    // ordinary idle listener from starting a new turn during shutdown, while
    // still proving that activation itself came through create_goal execution.
    await runtime1.stopSessionFamily(workspaceRoot, session.sessionId);
    await runtime1.shutdown();
    const restartGoals = new SessionGoalService(new SessionStoreManager({ logger: silentLogger }));
    await restartGoals.resume({ workspaceRoot, sessionId: session.sessionId, authority: { kind: "user_control" } });

    let recoveredContinuations = 0;
    let markRecoveredStarted!: () => void;
    const recoveredStarted = new Promise<void>((resolve) => {
      markRecoveredStarted = resolve;
    });
    setLlmAdapterForTest({
      streamText: mock((options: { abortSignal: AbortSignal }) => {
        recoveredContinuations += 1;
        markRecoveredStarted();
        return createAbortableStream(options.abortSignal);
      }) as never,
      generateText: mock(async () => ({
        text: "",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
      })) as never,
    });
    const runtime2 = await createRuntime({
      configService: await writeConfig(makeConfig()),
      runtimeStorageHomeDir: registryHome,
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });

    await runtime2.recoverSessionContinuations();
    await recoveredStarted;
    expect(recoveredContinuations).toBe(1);
    expect(runtime2.getSessionFamilyActivity(workspaceRoot, session.sessionId)).toBe("running");
    await runtime2.updateSessionGoalControl({ workspaceRoot, sessionId: session.sessionId, action: "pause" });
    await runtime2.shutdown();
  });

  test("blocks Goal clear for an unapplied descendant settlement, then clears after it is applied", async () => {
    const workspaceRoot = await makeTempRoot();
    const rootSessionId = crypto.randomUUID();
    const childSessionId = crypto.randomUUID();
    const childExecutionId = crypto.randomUUID();
    const seed = new SessionStoreManager({ logger: silentLogger });
    await seed.createSessionFile(workspaceRoot, { agentName: "lead", source: { kind: "direct" } }, rootSessionId);
    const seedGoals = new SessionGoalService(seed);
    const goal = await seedGoals.create({
      workspaceRoot,
      sessionId: rootSessionId,
      authority: { kind: "user_control" },
      objective: "Keep the descendant settlement accountable.",
    });
    await seed.createSessionFile(workspaceRoot, {
      agentName: "explore",
      rootSessionId,
      parentSessionId: rootSessionId,
      delegationRequest: {
        agent_type: "explore",
        profile: "fast",
        title: "Descendant",
        objective: "Inspect the scope.",
        skills: [],
        background: false,
      },
    }, childSessionId);
    const childStore = seed.get(childSessionId, workspaceRoot)!;
    childStore.getState().append(testExecutionStart(childExecutionId));
    const childRun = childStore.getState().executions[0]!.runs[0]!;
    const runEndedAt = Math.max(Date.now(), childRun.startedAt);
    const settlementKey = `run:${childSessionId}:${childExecutionId}:0`;
    childStore.getState().append(testExecutionEnd(childExecutionId, "completed", {
      endedAt: runEndedAt,
      runEndedAt,
      runSettlement: { key: settlementKey, goalInstanceId: goal.instanceId },
      terminalSettlement: { key: `terminal:${childSessionId}:${childExecutionId}`, goalInstanceId: null },
    }));
    await seed.flushSession(childSessionId, workspaceRoot);

    const runtime1 = await createRuntime({
      configService: await writeConfig(makeConfig()),
      runtimeStorageHomeDir: await makeTempRoot(),
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    await expect(runtime1.updateSessionGoalControl({
      workspaceRoot,
      sessionId: rootSessionId,
      action: "clear",
    })).rejects.toMatchObject({ code: "PENDING_SETTLEMENTS" });
    await runtime1.shutdown();

    await seed.markExecutionSettlementApplied(childSessionId, workspaceRoot, {
      executionId: childExecutionId,
      runOrdinal: 0,
      expectedKey: settlementKey,
    });
    const runtime2 = await createRuntime({
      configService: await writeConfig(makeConfig()),
      runtimeStorageHomeDir: await makeTempRoot(),
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    const cleared = await runtime2.updateSessionGoalControl({
      workspaceRoot,
      sessionId: rootSessionId,
      action: "clear",
    });
    expect(cleared.goal).toBeUndefined();
    await runtime2.shutdown();
  });

  test("continues an active Goal after a completed root Execution without a workflow state machine", async () => {
    const workspaceRoot = await makeTempRoot();
    const registryHome = await makeTempRoot();
    let streams = 0;
    let markContinuationStarted!: () => void;
    const continuationStarted = new Promise<void>((resolve) => {
      markContinuationStarted = resolve;
    });
    setLlmAdapterForTest({
      streamText: mock((options: { abortSignal: AbortSignal }) => {
        streams += 1;
        if (streams === 1) return createGoalActivationStream("Keep working until the migration is complete.");
        if (streams === 2) return createStoppedStream();
        markContinuationStarted();
        return createAbortableStream(options.abortSignal);
      }) as never,
      generateText: mock(async () => ({ text: "", toolCalls: [] })) as never,
    });
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig()),
      runtimeStorageHomeDir: registryHome,
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    const project = await runtime.projectRegistry.add({ workspaceRoot, name: "Goal continuation" });
    const session = await runtime.createSession(workspaceRoot, { agentName: "lead", source: { kind: "direct" } });

    await runtime.acceptSessionMessage({
      slug: project.slug,
      workspaceRoot,
      sessionId: session.sessionId,
      text: "Keep working until the migration is complete.",
      attachmentIds: [],
      clientRequestId: crypto.randomUUID(),
      source: "user",
      requestedModelSelection,
    });

    await continuationStarted;
    expect(streams).toBe(3);
    expect(runtime.getSessionFamilyActivity(workspaceRoot, session.sessionId)).toBe("running");
    const file = await runtime.getSessionFile(workspaceRoot, session.sessionId);
    expect(file.goal?.status).toBe("active");
    expect(file.executions.at(-1)?.origin).toBe("goal_continuation");

    await runtime.updateSessionGoalControl({ workspaceRoot, sessionId: session.sessionId, action: "pause" });
    await runtime.abortAllSessionExecutions();
    await runtime.shutdown();
  });

  test("does not retry an active Goal after a failed root Execution", async () => {
    const workspaceRoot = await makeTempRoot();
    const registryHome = await makeTempRoot();
    let streams = 0;
    setLlmAdapterForTest({
      streamText: mock(() => {
        streams += 1;
        if (streams === 1) return createGoalActivationStream("Keep working until the migration is complete.");
        throw Object.assign(new Error("provider failed after Goal activation"), { status: 400 });
      }) as never,
      generateText: mock(async () => ({ text: "", toolCalls: [] })) as never,
    });
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig()),
      runtimeStorageHomeDir: registryHome,
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    const project = await runtime.projectRegistry.add({ workspaceRoot, name: "Goal failure" });
    const session = await runtime.createSession(workspaceRoot, { agentName: "lead", source: { kind: "direct" } });

    const executionFailed = nextSessionEvent(
      runtime,
      project.slug,
      session.sessionId,
      (event) => event.payload.type === "execution-end" && event.payload.terminalStatus === "failed",
    );
    const familyIdle = nextFamilyActivity(runtime, project.slug, session.sessionId, "idle");
    await runtime.acceptSessionMessage({
      slug: project.slug,
      workspaceRoot,
      sessionId: session.sessionId,
      text: "Keep working until the migration is complete.",
      attachmentIds: [],
      clientRequestId: crypto.randomUUID(),
      source: "user",
      requestedModelSelection,
    });

    await executionFailed;
    await familyIdle;
    const before = await runtime.getSessionFile(workspaceRoot, session.sessionId);
    expect(before.goal?.status).toBe("active");
    const after = await runtime.getSessionFile(workspaceRoot, session.sessionId);
    expect(after.executions).toHaveLength(before.executions.length);
    expect(runtime.getSessionFamilyActivity(workspaceRoot, session.sessionId)).toBe("idle");

    await runtime.updateSessionGoalControl({ workspaceRoot, sessionId: session.sessionId, action: "pause" });
    await runtime.shutdown();
  });

  test("repairs a missing HITL link before applying its answered startup delivery", async () => {
    const workspaceRoot = await makeTempRoot();
    const registryHome = await makeTempRoot();
    const runtime1 = await createRuntime({
      configService: await writeConfig(makeConfig()),
      runtimeStorageHomeDir: registryHome,
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    const project = await runtime1.projectRegistry.add({ workspaceRoot, name: "Repair answered HITL" });
    const session = await runtime1.createSession(workspaceRoot, { agentName: "lead", source: { kind: "direct" } });
    const context = await runtime1.contextResolver.resolve(workspaceRoot);
    const questionInput = {
      questions: [{
        question: "Continue?",
        header: "Continue",
        options: [{ label: "Yes", description: "Continue" }],
      }],
    };
    const request = context.hitl.codec.createAskUserRequest({
      toolCallId: "repair-question",
      displayPayload: {
        title: "Continue",
        summary: "Continue?",
        questions: [{
          question: "Continue?",
          header: "Continue",
          options: [{ label: "Yes", description: "Continue" }],
          custom: true,
        }],
        redacted: true,
      },
    });
    const requestKey = context.hitl.codec.createToolRequestKey({
      sessionId: session.sessionId,
      toolCallId: "repair-question",
      toolName: "ask_user",
      request,
    });
    const answered = (await context.hitl.create({
      requestKey,
      owner: { type: "session", id: session.sessionId },
      source: request.source,
      displayPayload: request.displayPayload,
    })).record;
    await context.hitl.respond(answered.hitlId, {
      type: "question_answer",
      answers: ["Yes"],
    });
    await runtime1.shutdown();

    const executionId = "execution-repair-answered-hitl";
    const now = new Date().toISOString();
    const batchInput: Omit<SessionToolBatch, "stepId" | "assistantMessageId"> = {
      batchId: "batch-repair-answered-hitl",
      executionId,
      step: 0,
      runOrdinal: 0,
      agentName: "lead",
      allowedTools: ["ask_user"],
      agentSkills: [],
      partitions: [{ type: "serial", callIds: ["repair-question"] }],
      calls: [{
        ordinal: 0,
        partitionIndex: 0,
        toolCallId: "repair-question",
        toolName: "ask_user",
        input: questionInput,
        traits: { readOnly: true, destructive: false, concurrencySafe: false },
        state: "blocked",
        attempt: 1,
        checkpointAt: Date.parse(now),
        blocker: {
          requestKey,
          source: request.source,
          displayPayload: request.displayPayload,
        },
      }],
      createdAt: now,
      updatedAt: now,
    };
    const seedStoreManager = new SessionStoreManager({ logger: silentLogger });
    const seedStore = await seedStoreManager.getOrLoad(session.sessionId, workspaceRoot);
    seedStore.getState().append(testExecutionStart(executionId));
    const batch = seedToolBatchAnchor(seedStore, batchInput);
    const durableTool = seedStore.getState().messages
      .flatMap((message) => message.role === "assistant" ? message.parts : [])
      .find((part) => part.type === "tool" && part.toolCallId === "repair-question");
    if (durableTool?.type !== "tool" || durableTool.state !== "running") {
      throw new Error("Expected durable tool checkpoint");
    }
    const durableToolStartedAt = durableTool.startedAt;
    const blockedCheckpointAt = Math.max(Date.now(), durableToolStartedAt);
    await seedStoreManager.updateToolBatches(session.sessionId, workspaceRoot, () => [{
      ...batch,
      calls: batch.calls.map((call) => ({ ...call, checkpointAt: blockedCheckpointAt })),
    }]);

    const runtime2 = await createRuntime({
      configService: await writeConfig(makeConfig()),
      runtimeStorageHomeDir: registryHome,
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    installTestLlmAdapter();
    const lifecycle: GlobalSessionEventEnvelope[] = [];
    const unsubscribe = runtime2.subscribeSessionEvents((event) => {
      if (event.slug === project.slug && event.sessionId === session.sessionId) lifecycle.push(event);
    });
    const completed = nextSessionEvent(
      runtime2,
      project.slug,
      session.sessionId,
      (event) => event.payload.type === "execution-end" && event.payload.executionId === executionId,
    );

    await runtime2.recoverSessionContinuations();
    await completed;
    unsubscribe();

    const file = await runtime2.getSessionFile(workspaceRoot, session.sessionId);
    expect(file.executions).toHaveLength(1);
    expect(file.executions[0]).toMatchObject({
      id: executionId,
      status: "completed",
      runs: [{ ordinal: 0 }, { ordinal: 1 }],
    });
    const recoveredFirstRun = file.executions[0]!.runs[0]!;
    expect(recoveredFirstRun).toHaveProperty("endedAt");
    if ("endedAt" in recoveredFirstRun) {
      expect(recoveredFirstRun.endedAt).toBe(blockedCheckpointAt);
    }
    const lifecycleTypes = lifecycle
      .filter((event) => "executionId" in event.payload && event.payload.executionId === executionId)
      .map((event) => event.payload.type);
    expect(lifecycleTypes.indexOf("execution-suspended")).toBeGreaterThanOrEqual(0);
    expect(lifecycleTypes.indexOf("execution-suspended"))
      .toBeLessThan(lifecycleTypes.indexOf("execution-resumed"));
    expect(file.toolBatches[0]?.calls[0]).toMatchObject({
      state: "completed",
      blocker: {
        hitlId: answered.hitlId,
      },
    });
    expect(typeof file.toolBatches[0]?.calls[0]?.blocker?.responseAppliedAt).toBe("string");
    expect((await (await runtime2.contextResolver.resolve(workspaceRoot)).hitl.list())
      .find((record) => record.hitlId === answered.hitlId)?.status).toBe("resolved");
    expect(file.executions.some((execution) => execution.status === "interrupted")).toBe(false);
    await runtime2.shutdown();
  });

  test("reconciles parallel answered HITL before resuming their one logical Execution", async () => {
    const workspaceRoot = await makeTempRoot();
    const registryHome = await makeTempRoot();
    const runtime1 = await createRuntime({
      configService: await writeConfig(makeConfig()),
      runtimeStorageHomeDir: registryHome,
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    const project = await runtime1.projectRegistry.add({ workspaceRoot, name: "HITL restart" });
    const session = await runtime1.createSession(workspaceRoot, { agentName: "lead", source: { kind: "direct" } });
    const context = await runtime1.contextResolver.resolve(workspaceRoot);
    const questionInput = {
      questions: [{
        question: "Continue?",
        header: "Continue",
        options: [{ label: "Yes", description: "Continue" }],
      }],
    };
    const questionDisplay = {
      title: "Continue",
      summary: "Continue?",
      questions: [{
        question: "Continue?",
        header: "Continue",
        options: [{ label: "Yes", description: "Continue" }],
        custom: true,
      }],
      redacted: true as const,
    };
    const firstRequest = context.hitl.codec.createAskUserRequest({ toolCallId: "question-1", displayPayload: questionDisplay });
    const first = (await context.hitl.create({
      requestKey: context.hitl.codec.createToolRequestKey({
        sessionId: session.sessionId,
        toolCallId: "question-1",
        toolName: "ask_user",
        request: firstRequest,
      }),
      owner: { type: "session", id: session.sessionId },
      source: firstRequest.source,
      displayPayload: firstRequest.displayPayload,
    })).record;
    const secondRequest = context.hitl.codec.createAskUserRequest({ toolCallId: "question-2", displayPayload: questionDisplay });
    const second = (await context.hitl.create({
      requestKey: context.hitl.codec.createToolRequestKey({
        sessionId: session.sessionId,
        toolCallId: "question-2",
        toolName: "ask_user",
        request: secondRequest,
      }),
      owner: { type: "session", id: session.sessionId },
      source: secondRequest.source,
      displayPayload: secondRequest.displayPayload,
    })).record;
    const now = new Date().toISOString();
    const batchInput: Omit<SessionToolBatch, "stepId" | "assistantMessageId"> = {
      batchId: "batch-1",
      executionId: "execution-1",
      step: 0,
      runOrdinal: 0,
      agentName: "lead",
      allowedTools: ["ask_user"],
      agentSkills: [],
      partitions: [{ type: "parallel", callIds: ["question-1", "question-2"] }],
      calls: [first, second].map((record, ordinal) => ({
        ordinal,
        partitionIndex: 0,
        toolCallId: record.source.type === "ask_user" ? record.source.toolCallId : "unreachable",
        toolName: "ask_user",
        input: questionInput,
        traits: { readOnly: true, destructive: false, concurrencySafe: true },
        state: "blocked" as const,
        attempt: 1,
        checkpointAt: Date.parse(now),
        blocker: {
          requestKey: record.requestKey,
          hitlId: record.hitlId,
          source: record.source as Extract<typeof record.source, { type: "ask_user" }>,
          displayPayload: record.displayPayload,
        },
      })),
      createdAt: now,
      updatedAt: now,
    };
    const seedStoreManager = new SessionStoreManager({ logger: silentLogger });
    const seedStore = await seedStoreManager.getOrLoad(session.sessionId, workspaceRoot);
    seedStore.getState().append(testExecutionStart(batchInput.executionId));
    const batch = seedToolBatchAnchor(seedStore, batchInput);
    const firstSuspendedAt = Date.now();
    seedStore.getState().append(testExecutionSuspended(batch.executionId, {
      kind: "hitl",
      toolBatchId: batch.batchId,
      blockerIds: [first.hitlId, second.hitlId].sort(),
    }, {
      runEndedAt: firstSuspendedAt,
      runSettlement: { key: `run:${session.sessionId}:${batch.executionId}:0`, goalInstanceId: null },
    }));
    await seedStoreManager.updateToolBatches(session.sessionId, workspaceRoot, () => [batch]);
    await context.hitl.respond(first.hitlId, { type: "question_answer", answers: ["Yes"] });

    const runtime2 = await createRuntime({
      configService: await writeConfig(makeConfig()),
      runtimeStorageHomeDir: registryHome,
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    expect((await runtime2.getSessionFile(workspaceRoot, session.sessionId)).toolBatches[0]?.calls[0]?.state).toBe("blocked");
    expect((await (await runtime2.contextResolver.resolve(workspaceRoot)).hitl.list()).find((record) => record.hitlId === first.hitlId)?.status).toBe("answered");
    installTestLlmAdapter();
    await runtime2.recoverSessionContinuations();

    const partiallyRecovered = await runtime2.getSessionFile(workspaceRoot, session.sessionId);
    const partiallyRecoveredCalls = partiallyRecovered.toolBatches[0]?.calls;
    expect(partiallyRecoveredCalls?.[0]).toMatchObject({
      toolCallId: "question-1",
      state: "queued",
      blocker: { hitlId: first.hitlId },
    });
    expect(typeof partiallyRecoveredCalls?.[0]?.blocker?.responseAppliedAt).toBe("string");
    expect(partiallyRecoveredCalls?.[0]?.result).toBeUndefined();
    expect(partiallyRecoveredCalls?.[1]).toMatchObject({
      toolCallId: "question-2",
      state: "blocked",
      blocker: { hitlId: second.hitlId },
    });
    expect((await (await runtime2.contextResolver.resolve(workspaceRoot)).hitl.list()).find((record) => record.hitlId === first.hitlId)?.status).toBe("resolved");

    const executionCompleted = nextSessionEvent(
      runtime2,
      project.slug,
      session.sessionId,
      (event) => (
        event.payload.type === "execution-end"
        && event.payload.executionId === batch.executionId
      ),
    );
    await runtime2.respondToHitl({
      slug: project.slug,
      workspaceRoot,
      hitlId: second.hitlId,
      response: { type: "question_answer", answers: ["Yes"] },
    });
    await executionCompleted;

    const recovered = await runtime2.getSessionFile(workspaceRoot, session.sessionId);
    expect(recovered.executions).toHaveLength(1);
    expect(recovered.toolBatches[0]?.calls[0]).toMatchObject({
      toolCallId: "question-1",
      state: "completed",
    });
    expect(recovered.toolBatches[0]?.calls[0]?.result?.output.preview).toContain("Yes");
    expect(recovered.toolBatches[0]?.calls[1]).toMatchObject({
      toolCallId: "question-2",
      state: "completed",
    });
    await runtime2.abortAllSessionExecutions();
  });

  test("applies an in-flight HITL answer before Stop uniquely cancels its suspended Execution", async () => {
    const workspaceRoot = await makeTempRoot();
    const registryHome = await makeTempRoot();
    const runtime1 = await createRuntime({
      configService: await writeConfig(makeConfig()),
      runtimeStorageHomeDir: registryHome,
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    const project = await runtime1.projectRegistry.add({ workspaceRoot, name: "HITL answer and Stop" });
    const session = await runtime1.createSession(workspaceRoot, { agentName: "lead", source: { kind: "direct" } });
    const context1 = await runtime1.contextResolver.resolve(workspaceRoot);
    const input = {
      questions: [{
        question: "Continue?",
        header: "Continue",
        options: [{ label: "Yes", description: "Continue" }],
      }],
    };
    const request = context1.hitl.codec.createAskUserRequest({
      toolCallId: "stop-race-question",
      displayPayload: {
        title: "Continue",
        summary: "Continue?",
        questions: [{
          question: "Continue?",
          header: "Continue",
          options: [{ label: "Yes", description: "Continue" }],
          custom: true,
        }],
        redacted: true,
      },
    });
    const record = (await context1.hitl.create({
      requestKey: context1.hitl.codec.createToolRequestKey({
        sessionId: session.sessionId,
        toolCallId: "stop-race-question",
        toolName: "ask_user",
        request,
      }),
      owner: { type: "session", id: session.sessionId },
      source: request.source,
      displayPayload: request.displayPayload,
    })).record;
    await runtime1.shutdown();

    const executionId = "execution-hitl-stop-race";
    const now = new Date().toISOString();
    const batchInput: Omit<SessionToolBatch, "stepId" | "assistantMessageId"> = {
      batchId: "batch-hitl-stop-race",
      executionId,
      step: 0,
      runOrdinal: 0,
      agentName: "lead",
      allowedTools: ["ask_user"],
      agentSkills: [],
      partitions: [{ type: "serial", callIds: ["stop-race-question"] }],
      calls: [{
        ordinal: 0,
        partitionIndex: 0,
        toolCallId: "stop-race-question",
        toolName: "ask_user",
        input,
        traits: { readOnly: true, destructive: false, concurrencySafe: false },
        state: "blocked",
        attempt: 1,
        checkpointAt: Date.parse(now),
        blocker: {
          requestKey: record.requestKey,
          hitlId: record.hitlId,
          source: request.source,
          displayPayload: request.displayPayload,
        },
      }],
      createdAt: now,
      updatedAt: now,
    };
    const seedStoreManager = new SessionStoreManager({ logger: silentLogger });
    const seedStore = await seedStoreManager.getOrLoad(session.sessionId, workspaceRoot);
    seedStore.getState().append(testExecutionStart(executionId));
    const batch = seedToolBatchAnchor(seedStore, batchInput);
    const suspendedAt = Date.now();
    seedStore.getState().append(testExecutionSuspended(executionId, {
      kind: "hitl",
      toolBatchId: batch.batchId,
      blockerIds: [record.hitlId],
    }, {
      runEndedAt: suspendedAt,
      runSettlement: { key: `run:${session.sessionId}:${executionId}:0`, goalInstanceId: null },
    }));
    await seedStoreManager.updateToolBatches(session.sessionId, workspaceRoot, () => [batch]);

    const runtime2 = await createRuntime({
      configService: await writeConfig(makeConfig()),
      runtimeStorageHomeDir: registryHome,
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    const context2 = await runtime2.contextResolver.resolve(workspaceRoot);
    const originalResolve = context2.hitl.resolve.bind(context2.hitl);
    let markDispatching!: () => void;
    const dispatching = new Promise<void>((resolve) => {
      markDispatching = resolve;
    });
    let releaseDispatch!: () => void;
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    context2.hitl.resolve = async (...args: Parameters<typeof originalResolve>) => {
      const resolved = await originalResolve(...args);
      if (args[1].type === "dispatching") {
        markDispatching();
        await dispatchGate;
      }
      return resolved;
    };

    const answer = runtime2.respondToHitl({
      slug: project.slug,
      workspaceRoot,
      hitlId: record.hitlId,
      response: { type: "question_answer", answers: ["Yes"] },
    });
    await dispatching;
    const stop = runtime2.stopSessionFamily(workspaceRoot, session.sessionId);
    releaseDispatch();
    const [answered] = await Promise.all([answer, stop]);

    expect(answered.status).toBe("resolved");
    expect(answered.view.allowedActions).toEqual([]);
    const file = await runtime2.getSessionFile(workspaceRoot, session.sessionId);
    expect(file.executions).toHaveLength(1);
    expect(file.executions[0]).toMatchObject({
      id: executionId,
      status: "cancelled",
      runs: [{ ordinal: 0 }],
    });
    expect(file.toolBatches[0]).toMatchObject({
      batchId: batch.batchId,
    });
    expect(typeof file.toolBatches[0]?.archivedAt).toBe("string");
    const settled = (await context2.hitl.list()).find(({ hitlId }) => hitlId === record.hitlId);
    expect(settled?.status).toBe("resolved");
    expect(settled?.delivery).toBeUndefined();
    await runtime2.shutdown();
  });

  test("coalesces concurrent identical HITL responses into one delivery", async () => {
    const workspaceRoot = await makeTempRoot();
    const registryHome = await makeTempRoot();
    const runtime1 = await createRuntime({
      configService: await writeConfig(makeConfig()),
      runtimeStorageHomeDir: registryHome,
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    const project = await runtime1.projectRegistry.add({ workspaceRoot, name: "Concurrent HITL" });
    const session = await runtime1.createSession(workspaceRoot, { agentName: "lead", source: { kind: "direct" } });
    const context1 = await runtime1.contextResolver.resolve(workspaceRoot);
    const concurrentDisplay = {
      title: "Continue",
      summary: "Continue?",
      questions: [{ question: "Continue?", header: "Continue", options: [], custom: true }],
      redacted: true as const,
    };
    const concurrentRequest = context1.hitl.codec.createAskUserRequest({
      toolCallId: "question-concurrent",
      displayPayload: concurrentDisplay,
    });
    const record = (await context1.hitl.create({
      requestKey: context1.hitl.codec.createToolRequestKey({
        sessionId: session.sessionId,
        toolCallId: "question-concurrent",
        toolName: "ask_user",
        request: concurrentRequest,
      }),
      owner: { type: "session", id: session.sessionId },
      source: concurrentRequest.source,
      displayPayload: concurrentRequest.displayPayload,
    })).record;
    const now = new Date().toISOString();
    const batchInput: Omit<SessionToolBatch, "stepId" | "assistantMessageId"> = {
      batchId: "batch-concurrent",
      executionId: "execution-concurrent",
      step: 0,
      runOrdinal: 0,
      agentName: "lead",
      allowedTools: ["ask_user"],
      agentSkills: [],
      partitions: [{ type: "serial", callIds: ["question-concurrent"] }],
      calls: [{
        ordinal: 0,
        partitionIndex: 0,
        toolCallId: "question-concurrent",
        toolName: "ask_user",
        input: { questions: [{ question: "Continue?", header: "Continue", custom: true }] },
        traits: { readOnly: true, destructive: false, concurrencySafe: false },
        state: "blocked",
        attempt: 1,
        checkpointAt: Date.parse(now),
        blocker: {
          requestKey: record.requestKey,
          hitlId: record.hitlId,
          source: { type: "ask_user", toolCallId: "question-concurrent" },
          displayPayload: record.displayPayload,
        },
      }],
      createdAt: now,
      updatedAt: now,
    };
    const seedStoreManager = new SessionStoreManager({ logger: silentLogger });
    const seedStore = await seedStoreManager.getOrLoad(session.sessionId, workspaceRoot);
    seedStore.getState().append(testExecutionStart(batchInput.executionId));
    const batch = seedToolBatchAnchor(seedStore, batchInput);
    const concurrentSuspendedAt = Date.now();
    seedStore.getState().append(testExecutionSuspended(batch.executionId, {
      kind: "hitl",
      toolBatchId: batch.batchId,
      blockerIds: [record.hitlId],
    }, {
      runEndedAt: concurrentSuspendedAt,
      runSettlement: { key: `run:${session.sessionId}:${batch.executionId}:0`, goalInstanceId: null },
    }));
    await seedStoreManager.updateToolBatches(session.sessionId, workspaceRoot, () => [batch]);

    const runtime2 = await createRuntime({
      configService: await writeConfig(makeConfig()),
      runtimeStorageHomeDir: registryHome,
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    installTestLlmAdapter();
    const responses = await Promise.all(Array.from({ length: 4 }, () => runtime2.respondToHitl({
      slug: project.slug,
      workspaceRoot,
      hitlId: record.hitlId,
      response: { type: "question_answer", answers: ["Yes"] },
    })));

    expect(responses.map(({ status }) => status)).toEqual(["resolved", "resolved", "resolved", "resolved"]);
    const context2 = await runtime2.contextResolver.resolve(workspaceRoot);
    const resolved = (await context2.hitl.list()).find(({ hitlId }) => hitlId === record.hitlId);
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.delivery).toBeUndefined();
    await runtime2.abortAllSessionExecutions();
  });

  test("root deletion waits for upload completion and removes its attachment directory", async () => {
    const workspaceRoot = await makeTempRoot();
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig()),
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    await runtime.projectRegistry.add({ workspaceRoot, name: "Attachment deletion" });
    const session = await runtime.createSession(workspaceRoot, { agentName: "lead", source: { kind: "direct" } });
    const attachmentId = crypto.randomUUID();
    let releaseBody!: () => void;
    let bodyRead!: () => void;
    const bodyReadPromise = new Promise<void>((resolve) => {
      bodyRead = resolve;
    });
    const releaseBodyPromise = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const upload = runtime.uploadSessionAttachment({
      workspaceRoot,
      rootSessionId: session.sessionId,
      attachmentId,
      name: "pending.bin",
      sizeBytes: 1,
      body: new ReadableStream<Uint8Array>({
        async pull(controller) {
          bodyRead();
          await releaseBodyPromise;
          controller.enqueue(Uint8Array.of(1));
          controller.close();
        },
      }),
    });
    await bodyReadPromise;

    let deleted = false;
    const deletion = runtime.deleteSession(workspaceRoot, session.sessionId).then(() => {
      deleted = true;
    });
    await Promise.resolve();
    expect(deleted).toBe(false);
    releaseBody();
    await upload;
    await deletion;

    expect(await Bun.file(
      getAttachmentContentPath(workspaceRoot, session.sessionId, attachmentId),
    ).exists()).toBe(false);
    await expect(runtime.getSessionFile(workspaceRoot, session.sessionId)).rejects.toThrow();
  });

  test("Session deletion and Todo lifecycle changes never delete Todo-owned references", async () => {
    const workspaceRoot = await makeTempRoot();
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig()),
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    await runtime.projectRegistry.add({ workspaceRoot, name: "Todo attachment retention" });
    const todos = (await runtime.contextResolver.resolve(workspaceRoot)).todos;
    let todo = await todos.createTodo({ content: "Retain the attached PRD" });
    const attachmentId = crypto.randomUUID();
    const bytes = new TextEncoder().encode("durable Todo reference");
    const uploaded = await todos.uploadAttachment({
      todoId: todo.id,
      attachmentId,
      expectedRevision: todo.revision,
      name: "prd.txt",
      sizeBytes: bytes.byteLength,
      mediaType: "text/plain",
      body: new Response(bytes).body,
    });
    todo = uploaded.todo;
    const session = await runtime.createSession(workspaceRoot, {
      agentName: "lead",
      source: { kind: "todo", todoId: todo.id, entry: "work" },
    });

    await runtime.deleteSession(workspaceRoot, session.sessionId);
    todo = await todos.updateTodo(todo.id, {
      expectedRevision: todo.revision,
      status: "rejected",
      rejectionReason: "Keep for later",
    });
    todo = await todos.updateTodo(todo.id, {
      expectedRevision: todo.revision,
      archived: true,
    });

    expect(todo.attachmentIds).toEqual([attachmentId]);
    const opened = await todos.openAttachment({ todoId: todo.id, attachmentId });
    expect(await Bun.file(opened.contentPath).text()).toBe("durable Todo reference");
  });

  test("projects the Todo attachment set current at each model boundary without Session snapshots", async () => {
    const workspaceRoot = await makeTempRoot();
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig({ servers: {} })),
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    const project = await runtime.projectRegistry.add({ workspaceRoot, name: "Live Todo references" });
    const todos = (await runtime.contextResolver.resolve(workspaceRoot)).todos;
    let todo = await todos.createTodo({ content: "Use current references" });
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    todo = (await todos.uploadAttachment({
      todoId: todo.id,
      attachmentId: firstId,
      expectedRevision: todo.revision,
      name: "first.txt",
      sizeBytes: 1,
      body: new Response(Uint8Array.of(1)).body,
    })).todo;
    const session = await runtime.createSession(workspaceRoot, {
      agentName: "lead",
      source: { kind: "todo", todoId: todo.id, entry: "work" },
    });
    const modelCalls: string[] = [];
    setLlmAdapterForTest({
      streamText: mock((input: unknown) => {
        modelCalls.push(JSON.stringify((input as { messages: unknown }).messages));
        return createStoppedStream();
      }) as never,
      generateText: mock(async () => ({ text: "Live Todo references", toolCalls: [] })) as never,
    });

    try {
      const run = async (text: string) => {
        const idle = nextFamilyActivity(runtime, project.slug, session.sessionId, "idle");
        await runtime.acceptSessionMessage({
          slug: project.slug,
          workspaceRoot,
          sessionId: session.sessionId,
          text,
          attachmentIds: [],
          clientRequestId: crypto.randomUUID(),
          source: "user",
          requestedModelSelection,
        });
        await idle;
      };

      await run("First boundary");
      todo = (await todos.uploadAttachment({
        todoId: todo.id,
        attachmentId: secondId,
        expectedRevision: todo.revision,
        name: "second.txt",
        sizeBytes: 1,
        body: new Response(Uint8Array.of(2)).body,
      })).todo;
      await run("Second boundary");
      todo = await todos.removeAttachment({
        todoId: todo.id,
        attachmentId: firstId,
        expectedRevision: todo.revision,
      });
      await run("Third boundary");

      expect(modelCalls).toHaveLength(3);
      expect(modelCalls[0]).toContain(firstId);
      expect(modelCalls[0]).not.toContain(secondId);
      expect(modelCalls[1]).toContain(firstId);
      expect(modelCalls[1]).toContain(secondId);
      expect(modelCalls[2]).not.toContain(firstId);
      expect(modelCalls[2]).toContain(secondId);
      const stored = await runtime.getSessionFile(workspaceRoot, session.sessionId);
      expect(stored.messages.some((message) =>
        message.parts.some((part) => part.type === "attachment")
      )).toBe(false);
      expect(await Bun.file(getAttachmentContentPath(
        workspaceRoot,
        session.sessionId,
        secondId,
      )).exists()).toBe(false);
    } finally {
      await runtime.abortAllSessionExecutions();
      await runtime.shutdown();
      setLlmAdapterForTest(undefined);
    }
  });

  test("projects the root Todo's current references into a delegated child model boundary", async () => {
    const workspaceRoot = await makeTempRoot();
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig({ servers: {} })),
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    const project = await runtime.projectRegistry.add({ workspaceRoot, name: "Child live Todo references" });
    const todos = (await runtime.contextResolver.resolve(workspaceRoot)).todos;
    let todo = await todos.createTodo({ content: "Delegate with current references" });
    const attachmentId = crypto.randomUUID();
    todo = (await todos.uploadAttachment({
      todoId: todo.id,
      attachmentId,
      expectedRevision: todo.revision,
      name: "child-brief.txt",
      sizeBytes: 1,
      body: new Response(Uint8Array.of(1)).body,
    })).todo;
    const session = await runtime.createSession(workspaceRoot, {
      agentName: "lead",
      source: { kind: "todo", todoId: todo.id, entry: "work" },
    });
    let rootCalls = 0;
    let childMessages = "";
    setLlmAdapterForTest({
      streamText: mock((input: { tools?: Record<string, unknown>; messages?: unknown[] }) => {
        if (input.tools?.create_goal !== undefined) {
          rootCalls += 1;
          return rootCalls === 1
            ? createBackgroundDelegateStream("delegate-live-references")
            : createStoppedStream();
        }
        childMessages = JSON.stringify(input.messages ?? []);
        return createStoppedStream();
      }) as never,
      generateText: mock(async () => ({ text: "Child live Todo references", toolCalls: [] })) as never,
    });

    try {
      const idle = nextFamilyActivity(runtime, project.slug, session.sessionId, "idle");
      await runtime.acceptSessionMessage({
        slug: project.slug,
        workspaceRoot,
        sessionId: session.sessionId,
        text: "Delegate inspection of the brief",
        attachmentIds: [],
        clientRequestId: crypto.randomUUID(),
        source: "user",
        requestedModelSelection,
      });
      await idle;

      expect(childMessages).toContain("Current Todo References (live user-provided data");
      expect(childMessages).toContain(attachmentId);
      const tree = await runtime.listSessionTree(workspaceRoot, session.sessionId);
      expect(tree.root.children).toHaveLength(1);
      expect(tree.root.children[0]!.session.rootSessionId).toBe(session.sessionId);
    } finally {
      await runtime.abortAllSessionExecutions();
      await runtime.shutdown();
      setLlmAdapterForTest(undefined);
    }
  });

  test("reprojects current Todo references after hard compact state is reloaded", async () => {
    const workspaceRoot = await makeTempRoot();
    const configHome = await makeTempRoot();
    const registryHome = await makeTempRoot();
    await mkdir(join(configHome, ".archcode"), { recursive: true });
    await Bun.write(resolveServerConfigPath(configHome), JSON.stringify(makeConfig({ servers: {} })));
    const runtimeOptions = {
      runtimeStorageHomeDir: registryHome,
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    } as const;
    const runtime1 = await createRuntime({
      ...runtimeOptions,
      configService: new ServerConfigService({ homeDir: configHome }),
    });
    const project = await runtime1.projectRegistry.add({ workspaceRoot, name: "Reloaded live Todo references" });
    const todos1 = (await runtime1.contextResolver.resolve(workspaceRoot)).todos;
    let todo = await todos1.createTodo({ content: "Keep references live after compact" });
    const firstId = crypto.randomUUID();
    todo = (await todos1.uploadAttachment({
      todoId: todo.id,
      attachmentId: firstId,
      expectedRevision: todo.revision,
      name: "before-compact.txt",
      sizeBytes: 1,
      body: new Response(Uint8Array.of(1)).body,
    })).todo;
    const session = await runtime1.createSession(workspaceRoot, {
      agentName: "lead",
      source: { kind: "todo", todoId: todo.id, entry: "work" },
    });

    setLlmAdapterForTest({
      streamText: mock(() => createStoppedStream()) as never,
      generateText: mock(async () => ({ text: "Reloaded live Todo references", toolCalls: [] })) as never,
    });
    const firstIdle = nextFamilyActivity(runtime1, project.slug, session.sessionId, "idle");
    await runtime1.acceptSessionMessage({
      slug: project.slug,
      workspaceRoot,
      sessionId: session.sessionId,
      text: "First boundary",
      attachmentIds: [],
      clientRequestId: crypto.randomUUID(),
      source: "user",
      requestedModelSelection,
    });
    await firstIdle;
    await runtime1.shutdown();

    const persisted = new SessionStoreManager({ logger: silentLogger });
    const persistedStore = await persisted.getOrLoad(session.sessionId, workspaceRoot);
    const tailStartId = persistedStore.getState().messages.at(-1)?.id;
    if (tailStartId === undefined) throw new Error("Expected a persisted message before compact");
    persistedStore.getState().append({
      type: "compact",
      summary: "Prior work was compacted before restart.",
      tailStartId,
    });
    await persisted.flushSession(session.sessionId, workspaceRoot);

    const runtime2 = await createRuntime({
      ...runtimeOptions,
      configService: new ServerConfigService({ homeDir: configHome }),
    });
    const todos2 = (await runtime2.contextResolver.resolve(workspaceRoot)).todos;
    todo = await todos2.removeAttachment({
      todoId: todo.id,
      attachmentId: firstId,
      expectedRevision: todo.revision,
    });
    const secondId = crypto.randomUUID();
    todo = (await todos2.uploadAttachment({
      todoId: todo.id,
      attachmentId: secondId,
      expectedRevision: todo.revision,
      name: "after-reload.txt",
      sizeBytes: 1,
      body: new Response(Uint8Array.of(2)).body,
    })).todo;
    let reloadedMessages = "";
    setLlmAdapterForTest({
      streamText: mock((input: { messages?: unknown[] }) => {
        reloadedMessages = JSON.stringify(input.messages ?? []);
        return createStoppedStream();
      }) as never,
      generateText: mock(async () => ({ text: "Reloaded live Todo references", toolCalls: [] })) as never,
    });

    try {
      const idle = nextFamilyActivity(runtime2, project.slug, session.sessionId, "idle");
      await runtime2.acceptSessionMessage({
        slug: project.slug,
        workspaceRoot,
        sessionId: session.sessionId,
        text: "Boundary after reload",
        attachmentIds: [],
        clientRequestId: crypto.randomUUID(),
        source: "user",
        requestedModelSelection,
      });
      await idle;

      expect(reloadedMessages).toContain("Prior work was compacted before restart.");
      expect(reloadedMessages).not.toContain(firstId);
      expect(reloadedMessages).toContain(secondId);
    } finally {
      await runtime2.abortAllSessionExecutions();
      await runtime2.shutdown();
      setLlmAdapterForTest(undefined);
    }
  });

  test("attachment cleanup failure warns once without changing successful root deletion", async () => {
    const workspaceRoot = await makeTempRoot();
    const { logger, entries } = createInMemoryLogger();
    const cleanup = mock(async () => {
      throw new Error(`cleanup failed at ${workspaceRoot}`);
    });
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig()),
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
      logger,
      attachmentRootRemover: cleanup,
    } as RuntimeTestOptions);
    await runtime.projectRegistry.add({ workspaceRoot, name: "Attachment cleanup warning" });
    const session = await runtime.createSession(workspaceRoot, { agentName: "lead", source: { kind: "direct" } });
    const attachmentId = crypto.randomUUID();
    await runtime.uploadSessionAttachment({
      workspaceRoot,
      rootSessionId: session.sessionId,
      attachmentId,
      name: "orphan.bin",
      sizeBytes: 0,
      body: null,
    });

    await expect(runtime.deleteSession(workspaceRoot, session.sessionId)).resolves.toBeUndefined();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(await Bun.file(
      getAttachmentContentPath(workspaceRoot, session.sessionId, attachmentId),
    ).exists()).toBe(true);
    const warnings = entries.filter(({ event }) => event === "session.attachments.cleanup_failed");
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings[0])).not.toContain(workspaceRoot);
  });

  test("child deletion neither takes the root attachment gate nor cleans root attachments", async () => {
    const workspaceRoot = await makeTempRoot();
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig()),
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    await runtime.projectRegistry.add({ workspaceRoot, name: "Attachment child deletion" });
    const root = await runtime.createSession(workspaceRoot, { agentName: "lead", source: { kind: "direct" } });
    const retainedId = crypto.randomUUID();
    await runtime.uploadSessionAttachment({
      workspaceRoot,
      rootSessionId: root.sessionId,
      attachmentId: retainedId,
      name: "retained.bin",
      sizeBytes: 0,
      body: null,
    });
    const childId = crypto.randomUUID();
    const seed = new SessionStoreManager({ logger: silentLogger });
    await seed.createSessionFile(workspaceRoot, {
      agentName: "explore",
      rootSessionId: root.sessionId,
      parentSessionId: root.sessionId,
      delegationRequest: {
        agent_type: "explore",
        profile: "fast",
        title: "Child",
        objective: "Inspect",
        skills: [],
        background: true,
      },
    }, childId);

    let releaseUpload!: () => void;
    let uploadRead!: () => void;
    const uploadReadPromise = new Promise<void>((resolve) => {
      uploadRead = resolve;
    });
    const releaseUploadPromise = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const upload = runtime.uploadSessionAttachment({
      workspaceRoot,
      rootSessionId: root.sessionId,
      attachmentId: crypto.randomUUID(),
      name: "blocked.bin",
      sizeBytes: 1,
      body: new ReadableStream<Uint8Array>({
        async pull(controller) {
          uploadRead();
          await releaseUploadPromise;
          controller.enqueue(Uint8Array.of(1));
          controller.close();
        },
      }),
    });
    await uploadReadPromise;
    const childDelete = runtime.deleteSession(workspaceRoot, childId);
    const outcome = await Promise.race([
      childDelete.then(() => "deleted" as const),
      Bun.sleep(200).then(() => "timeout" as const),
    ]);
    releaseUpload();
    await upload;
    expect(outcome).toBe("deleted");
    await childDelete;
    expect(await Bun.file(
      getAttachmentContentPath(workspaceRoot, root.sessionId, retainedId),
    ).exists()).toBe(true);
  });

  test("Session Manager deletion failure skips attachment cleanup and releases the gate", async () => {
    const workspaceRoot = await makeTempRoot();
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig()),
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
    });
    await runtime.projectRegistry.add({ workspaceRoot, name: "Attachment failed deletion" });
    const root = await runtime.createSession(workspaceRoot, { agentName: "lead", source: { kind: "direct" } });
    const attachmentId = crypto.randomUUID();
    await runtime.uploadSessionAttachment({
      workspaceRoot,
      rootSessionId: root.sessionId,
      attachmentId,
      name: "survives.bin",
      sizeBytes: 0,
      body: null,
    });
    const malformedChildId = crypto.randomUUID();
    const malformedPath = getSessionPath(workspaceRoot, malformedChildId);
    await mkdir(join(malformedPath, ".."), { recursive: true });
    await Bun.write(malformedPath, "{}");

    await expect(runtime.deleteSession(workspaceRoot, root.sessionId)).rejects.toThrow();
    expect(await Bun.file(
      getAttachmentContentPath(workspaceRoot, root.sessionId, attachmentId),
    ).exists()).toBe(true);
    await expect(runtime.uploadSessionAttachment({
      workspaceRoot,
      rootSessionId: root.sessionId,
      attachmentId: crypto.randomUUID(),
      name: "after-failure.bin",
      sizeBytes: 0,
      body: null,
    })).resolves.toMatchObject({ created: true });
  });

  test("delete-first ordering blocks a late upload until root revalidation rejects it", async () => {
    const workspaceRoot = await makeTempRoot();
    let cleanupStarted!: () => void;
    let releaseCleanup!: () => void;
    const cleanupStartedPromise = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    const releaseCleanupPromise = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const runtime = await createRuntime({
      configService: await writeConfig(makeConfig()),
      mcpRuntimeFactory: () => makeFakeMcpRuntime(),
      attachmentRootRemover: async (path: string) => {
        cleanupStarted();
        await releaseCleanupPromise;
        await rm(path, { recursive: true, force: true });
      },
    } as RuntimeTestOptions);
    await runtime.projectRegistry.add({ workspaceRoot, name: "Attachment delete first" });
    const root = await runtime.createSession(workspaceRoot, { agentName: "lead", source: { kind: "direct" } });
    await runtime.uploadSessionAttachment({
      workspaceRoot,
      rootSessionId: root.sessionId,
      attachmentId: crypto.randomUUID(),
      name: "existing.bin",
      sizeBytes: 0,
      body: null,
    });

    const deletion = runtime.deleteSession(workspaceRoot, root.sessionId);
    await cleanupStartedPromise;
    const lateId = crypto.randomUUID();
    let lateSettled = false;
    const late = runtime.uploadSessionAttachment({
      workspaceRoot,
      rootSessionId: root.sessionId,
      attachmentId: lateId,
      name: "late.bin",
      sizeBytes: 0,
      body: null,
    }).finally(() => {
      lateSettled = true;
    });
    await Promise.resolve();
    expect(lateSettled).toBe(false);
    releaseCleanup();
    await deletion;
    await expect(late).rejects.toThrow();
    expect(await Bun.file(
      getAttachmentContentPath(workspaceRoot, root.sessionId, lateId),
    ).exists()).toBe(false);
  });
});

function installTestLlmAdapter(): void {
  setLlmAdapterForTest({
    streamText: mock(() => ({
      fullStream: (async function* () {
        yield { type: "text-start", id: "output" };
        yield { type: "text-delta", id: "output", text: "Done." };
        yield { type: "text-end", id: "output" };
      })(),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({ totalTokens: 1 }),
      text: Promise.resolve("Done."),
      toolCalls: Promise.resolve([]),
    })) as never,
    generateText: mock(async () => ({ text: "Queued input" })) as never,
  });
}
