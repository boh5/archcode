import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { ModelMessage, StreamTextResult, ToolSet } from "ai";
import { z } from "zod/v4";

import { applySessionToolBatchResponse } from "../../execution/session-tool-batch-scheduler";
import { HitlBoundaryCodec } from "../../hitl/boundary-codec";
import { setLlmAdapterForTest } from "../../llm/adapter";
import { silentLogger } from "../../logger";
import type { ExecutionModelBinding } from "../../models";
import { SkillService } from "../../skills";
import { SessionStoreManager } from "../../store/session-store-manager";
import { ToolOutputArtifactStore } from "../../tool-output/artifact-store";
import { ToolOutputFinalizer } from "../../tool-output/finalizer";
import type { ToolOutputAccessService } from "../../tool-output/access-service";
import { askUserTool } from "../../tools/builtins/ask-user";
import { defineTool } from "../../tools/define-tool";
import { ToolRegistry } from "../../tools/registry";
import { createTextToolResult } from "../../tools/results";
import { SecretRedactionPolicy } from "../../security";
import { createTestProjectContext } from "../../tools/test-project-context";
import { deferTestApprovalReviewer } from "../../tools/test-approval-reviewer";
import type { ToolExecutionContext } from "../../tools/types";
import { runQueryLoop } from "./loop";
import { DOOM_LOOP_MESSAGE, type QueryLoopOptions } from "./types";
import { createTestModelInfo, testExecutionMemoryPolicy } from "../../testing/test-execution-fixtures";
import { SessionGoalService } from "../../session-goal";
import type { SessionToolBatch } from "../../store/types";
import type { AttachmentDescriptor } from "@archcode/protocol";
import {
  getAttachmentContentPath,
  ProjectAttachmentStorage,
  SessionAttachmentModelProjector,
  SessionAttachmentService,
  type AttachmentModelProjector,
} from "../../attachments";
import { ModelInfo } from "../../provider";

const ROOT = join("/tmp", "archcode-query-loop", crypto.randomUUID());
const skillService = new SkillService({ builtinSkills: {} });
const dummyModelInfo = createTestModelInfo({
  model: { modelId: "mock", provider: "mock" } as never,
  displayName: "Mock",
  limit: { context: 100_000, output: 10_000 },
  providerId: "mock",
  modelId: "mock",
});
const dummyBinding: ExecutionModelBinding = {
  modelInfo: dummyModelInfo,
  options: undefined,
  summary: {
    selection: { model: dummyModelInfo.qualifiedId },
    providerId: dummyModelInfo.providerId,
    modelId: dummyModelInfo.modelId,
    providerDisplayName: dummyModelInfo.providerDisplayName,
    modelDisplayName: dummyModelInfo.displayName,
    resolution: "profile_default",
    modelRuntimeRevision: "test-revision",
  },
};
const noAttachmentProjector: AttachmentModelProjector = {
  async project() {},
};

function bindingWithInputModalities(
  input: Array<"text" | "image">,
): ExecutionModelBinding {
  const modelInfo = new ModelInfo({
    model: { modelId: "mock", provider: "mock" } as never,
    config: {
      name: "Mock",
      limit: { context: 100_000, output: 10_000 },
      modalities: { input, output: ["text"] },
    },
    providerId: "mock",
    modelId: "mock",
  });
  return {
    modelInfo,
    options: undefined,
    summary: {
      selection: { model: modelInfo.qualifiedId },
      providerId: modelInfo.providerId,
      modelId: modelInfo.modelId,
      providerDisplayName: modelInfo.providerDisplayName,
      modelDisplayName: modelInfo.displayName,
      resolution: "profile_default",
      modelRuntimeRevision: "test-revision",
    },
  };
}

function bindingWithProviderSecrets(
  providerSecretValues: readonly string[],
): ExecutionModelBinding {
  const modelInfo = new ModelInfo({
    model: { modelId: "mock", provider: "mock" } as never,
    config: {
      name: "Mock",
      limit: { context: 100_000, output: 10_000 },
      modalities: { input: ["text"], output: ["text"] },
    },
    providerId: "mock",
    modelId: "mock",
    providerSecretValues,
  });
  return {
    modelInfo,
    options: undefined,
    summary: {
      selection: { model: modelInfo.qualifiedId },
      providerId: modelInfo.providerId,
      modelId: modelInfo.modelId,
      providerDisplayName: modelInfo.providerDisplayName,
      modelDisplayName: modelInfo.displayName,
      resolution: "profile_default",
      modelRuntimeRevision: "test-revision",
    },
  };
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

type StreamPart = StreamTextResult<ToolSet, never>["fullStream"] extends AsyncIterable<infer Part> ? Part : never;
interface Round {
  readonly chunks?: StreamPart[];
  readonly finishReason: string;
  readonly text?: string;
  readonly toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>;
}

beforeAll(async () => { await mkdir(ROOT, { recursive: true }); });
afterEach(() => { setLlmAdapterForTest(undefined); });
afterAll(async () => { await rm(ROOT, { recursive: true, force: true }); });

function installRounds(rounds: Round[], onCall?: (options: unknown) => void) {
  let index = 0;
  setLlmAdapterForTest({
    streamText: mock((options: unknown) => {
      onCall?.(options);
      const round = rounds[index++];
      if (round === undefined) throw new Error("No mock round remaining");
      return {
        fullStream: (async function* () { for (const chunk of round.chunks ?? []) yield chunk; })(),
        finishReason: Promise.resolve(round.finishReason),
        usage: Promise.resolve({ totalTokens: 1 }),
        text: Promise.resolve(round.text ?? ""),
        toolCalls: Promise.resolve(round.toolCalls ?? []),
      } as never;
    }),
  });
}

function streamEvents(harness: Awaited<ReturnType<typeof createHarness>>) {
  return harness.store.getState().events.map((event) => event.payload.type);
}

async function createHarness() {
  const workspaceRoot = join(ROOT, crypto.randomUUID());
  await mkdir(workspaceRoot, { recursive: true });
  const storeManager = new SessionStoreManager({ logger: silentLogger });
  const sessionId = crypto.randomUUID();
  const store = storeManager.create(sessionId, workspaceRoot, { source: { kind: "direct" }, agentName: "lead" });
  const projectContext = createTestProjectContext(workspaceRoot, storeManager);
  const redactionPolicy = new SecretRedactionPolicy([]);
  const artifactStore = new ToolOutputArtifactStore({ rootDir: join(workspaceRoot, "outputs") });
  await artifactStore.ready();
  const registry = new ToolRegistry({
    finalizer: new ToolOutputFinalizer({ artifactStore }),
    hitlCodec: new HitlBoundaryCodec(redactionPolicy),
    approvalReviewer: deferTestApprovalReviewer,
    logger: silentLogger,
  });
  const toolOutputAccess: ToolOutputAccessService = {
    countRecoverable: async () => 0,
    async read() { return { outputRef: "unused" as never, completeness: "complete", records: [] }; },
    async search() { return { matches: [], searchCompleteness: "complete" }; },
  };
  const options: QueryLoopOptions = {
    executionId: "test-execution",
    runOrdinal: 0,
    initialStep: 0,
    binding: dummyBinding,
    logger: silentLogger,
    toolRegistry: registry,
    allowedTools: [],
    agentSkills: [],
    skillService,
    storeManager,
    attachmentProjector: noAttachmentProjector,
    resolveAttachmentReadPaths: async () => new Set(),
    cwd: workspaceRoot,
    projectContext,
    toolOutputAccess,
    store,
    agentName: "lead",
  };
  store.getState().append({
    type: "execution-start",
    executionId: options.executionId,
    binding: dummyBinding.summary,
    memoryPolicy: testExecutionMemoryPolicy,
    origin: "tool_call",
    maxSteps: 50,
    executionSkills: [],
  });
  const appendUser = (text: string) => {
    const id = crypto.randomUUID();
    store.getState().append({
      type: "session.messages_committed",
      executionId: id,
      messages: [{
        id,
        role: "user",
        parts: [{ type: "text", id: `${id}:text`, text, createdAt: 1, completedAt: 1 }],
        createdAt: 1,
        completedAt: 1,
        executionId: id,
        clientRequestId: `request-${id}`,
      }],
    });
  };
  const appendAttachment = (attachment: AttachmentDescriptor) => {
    const id = crypto.randomUUID();
    store.getState().append({
      type: "session.messages_committed",
      executionId: id,
      messages: [{
        id,
        role: "user",
        parts: [{
          type: "attachment",
          id: `${id}:attachment`,
          attachment,
          createdAt: 1,
          completedAt: 1,
        }],
        createdAt: 1,
        completedAt: 1,
        executionId: id,
        clientRequestId: `request-${id}`,
      }],
    });
  };
  return {
    workspaceRoot,
    sessionId,
    storeManager,
    store,
    registry,
    options,
    appendUser,
    appendAttachment,
    toolOutputAccess,
  };
}

function registerInline(
  harness: Awaited<ReturnType<typeof createHarness>>,
  name: string,
  execute: (input: { value?: string }, context: ToolExecutionContext) => ReturnType<typeof createTextToolResult> | Promise<ReturnType<typeof createTextToolResult>>,
  traits = { readOnly: true, destructive: false, concurrencySafe: true },
) {
  harness.registry.register(defineTool({
    name,
    description: name,
    inputSchema: z.object({ value: z.string().optional() }).strict(),
    traits,
    outputPolicy: { kind: "inline", previewDirection: "head" },
    execute,
  }));
  harness.options.allowedTools = [...harness.options.allowedTools, name];
}

function toolEvents(harness: Awaited<ReturnType<typeof createHarness>>) {
  return harness.store.getState().events.flatMap((event) => event.payload.type === "tool-result" ? [event.payload] : []);
}

function stageQueuedBatch(
  harness: Awaited<ReturnType<typeof createHarness>>,
  toolName: string,
  allowedTools: string[],
  agentSkills: string[],
): void {
  const now = new Date().toISOString();
  const stepId = "recovered-step";
  harness.store.getState().append({
    type: "step-start",
    stepId,
    step: harness.options.initialStep,
  });
  harness.store.getState().append({
    type: "tool-call",
    toolCallId: "recovered-call",
    toolName,
    input: {},
  });
  harness.store.getState().append({
    type: "step-end",
    stepId,
    step: harness.options.initialStep,
    finishReason: "tool-calls",
  });
  const assistantMessageId = harness.store.getState().messages.find(
    (message) => message.role === "assistant" && message.stepId === stepId,
  )!.id;
  const batch: SessionToolBatch = {
    batchId: crypto.randomUUID(),
    executionId: harness.options.executionId,
    runOrdinal: harness.options.runOrdinal,
    step: harness.options.initialStep,
    stepId,
    assistantMessageId,
    agentName: "lead",
    allowedTools,
    agentSkills,
    partitions: [{ type: "serial", callIds: ["recovered-call"] }],
    calls: [{
      ordinal: 0,
      partitionIndex: 0,
      toolCallId: "recovered-call",
      toolName,
      input: {},
      traits: { readOnly: true, destructive: false, concurrencySafe: true },
      state: "queued",
      attempt: 0,
      checkpointAt: Date.now(),
    }],
    createdAt: now,
    updatedAt: now,
  };
  harness.store.setState({ toolBatches: [batch] });
}

describe("QueryLoop Tool Output Plane", () => {
  test("executes a model tool batch and appends nested finalized results", async () => {
    const harness = await createHarness();
    registerInline(harness, "echo", async (input) => createTextToolResult(input.value ?? "ok"));
    harness.appendUser("run");
    installRounds([
      {
        finishReason: "tool-calls",
        toolCalls: [{ toolCallId: "call-1", toolName: "echo", input: { value: "hello" } }],
        chunks: [{ type: "tool-call", toolCallId: "call-1", toolName: "echo", input: { value: "hello" } } as StreamPart],
      },
      {
        finishReason: "stop",
        text: "done",
        chunks: [
          { type: "text-start", id: "output" } as StreamPart,
          { type: "text-delta", id: "output", text: "done" } as StreamPart,
          { type: "text-end", id: "output" } as StreamPart,
        ],
      },
    ]);

    expect(await runQueryLoop(harness.options)).toMatchObject({ status: "completed", text: "done" });
    expect(toolEvents(harness)[0]).toMatchObject({
      toolCallId: "call-1",
      result: { isError: false, output: { preview: "hello" } },
    });
  });

  test("recovery intersects a durable batch capability snapshot before its first Registry execution", async () => {
    const harness = await createHarness();
    let observed: Pick<ToolExecutionContext, "allowedTools" | "agentSkills"> | undefined;
    registerInline(harness, "survives", async (_input, context) => {
      observed = { allowedTools: context.allowedTools, agentSkills: context.agentSkills };
      return createTextToolResult("recovered");
    });
    harness.options.allowedTools = ["survives", "new-tool"];
    harness.options.agentSkills = ["persisted-skill", "new-skill"];
    stageQueuedBatch(
      harness,
      "survives",
      ["survives", "removed-tool"],
      ["persisted-skill", "removed-skill"],
    );
    installRounds([{ finishReason: "stop", text: "done" }]);

    await runQueryLoop(harness.options);

    expect([...observed!.allowedTools]).toEqual(["survives"]);
    expect(observed!.agentSkills).toEqual(["persisted-skill"]);
    expect(toolEvents(harness)[0]).toMatchObject({
      toolCallId: "recovered-call",
      result: { isError: false },
    });
  });

  test("recovery rejects a durable queued call whose capability was revoked before its first Registry execution", async () => {
    const harness = await createHarness();
    const execute = mock(async () => createTextToolResult("must not run"));
    registerInline(harness, "revoked", execute);
    harness.options.allowedTools = ["current-tool"];
    harness.options.agentSkills = ["current-skill"];
    stageQueuedBatch(harness, "revoked", ["revoked"], ["persisted-skill"]);
    installRounds([{ finishReason: "stop", text: "done" }]);

    await runQueryLoop(harness.options);

    expect(execute).not.toHaveBeenCalled();
    expect(toolEvents(harness)[0]).toMatchObject({
      toolCallId: "recovered-call",
      result: { isError: true, details: { error: { code: "TOOL_NOT_ALLOWED" } } },
    });
  });

  test("completion boundary rejects a later effectful call in the same model batch", async () => {
    const harness = await createHarness();
    let writes = 0;
    registerInline(
      harness,
      "update_goal",
      async () => createTextToolResult("complete", { sidecar: { executionCompleted: true } }),
      { readOnly: false, destructive: false, concurrencySafe: false },
    );
    registerInline(
      harness,
      "file_edit",
      async () => { writes += 1; return createTextToolResult("wrote"); },
      { readOnly: false, destructive: false, concurrencySafe: false },
    );
    harness.appendUser("complete safely");
    installRounds([{ finishReason: "tool-calls", toolCalls: [
      { toolCallId: "complete-1", toolName: "update_goal", input: {} },
      { toolCallId: "write-2", toolName: "file_edit", input: {} },
    ] }]);

    expect(await runQueryLoop(harness.options)).toMatchObject({ status: "completed", steps: 1 });
    expect(writes).toBe(0);
    expect(toolEvents(harness).map((event) => event.result.isError)).toEqual([false, true]);
  });

  test("completion boundary ends the loop before a later model step can write", async () => {
    const harness = await createHarness();
    let writes = 0;
    let modelCalls = 0;
    registerInline(
      harness,
      "update_goal",
      async () => createTextToolResult("complete", { sidecar: { executionCompleted: true } }),
      { readOnly: false, destructive: false, concurrencySafe: false },
    );
    registerInline(
      harness,
      "file_edit",
      async () => { writes += 1; return createTextToolResult("wrote"); },
      { readOnly: false, destructive: false, concurrencySafe: false },
    );
    harness.appendUser("complete safely");
    installRounds([
      { finishReason: "tool-calls", toolCalls: [{ toolCallId: "complete-1", toolName: "update_goal", input: {} }] },
      { finishReason: "tool-calls", toolCalls: [{ toolCallId: "write-2", toolName: "file_edit", input: {} }] },
    ], () => { modelCalls += 1; });

    expect(await runQueryLoop(harness.options)).toMatchObject({ status: "completed", steps: 1 });
    expect(modelCalls).toBe(1);
    expect(writes).toBe(0);
  });

  test("injects the scope-bound output accessor without exposing authorization fields", async () => {
    const harness = await createHarness();
    let received: ToolExecutionContext["outputArtifacts"];
    registerInline(harness, "access", async (_input, context) => {
      received = context.outputArtifacts;
      return createTextToolResult("ok");
    });
    harness.appendUser("run");
    installRounds([
      { finishReason: "tool-calls", toolCalls: [{ toolCallId: "call-1", toolName: "access", input: {} }] },
      { finishReason: "stop", text: "done" },
    ]);
    await runQueryLoop(harness.options);
    expect(received).toBe(harness.toolOutputAccess);
    expect(Object.keys(received!)).toEqual(["countRecoverable", "read", "search"]);
  });

  test("resolves and injects the current attachment read paths for each tool execution", async () => {
    const harness = await createHarness();
    const allowedPath = join(harness.workspaceRoot, ".archcode", "runtime", "attachments", "sessions", "content");
    let resolutions = 0;
    let currentPaths: ReadonlySet<string> = new Set([allowedPath]);
    const received: ReadonlySet<string>[] = [];
    let firstStarted!: () => void;
    let releaseFirst!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
    const releaseFirstPromise = new Promise<void>((resolve) => { releaseFirst = resolve; });
    harness.options.resolveAttachmentReadPaths = async () => {
      resolutions += 1;
      return currentPaths;
    };
    registerInline(harness, "inspect_attachment_paths", async (_input, context) => {
      received.push(context.attachmentReadPaths ?? new Set());
      if (received.length === 1) {
        firstStarted();
        await releaseFirstPromise;
      }
      return createTextToolResult("ok");
    });
    harness.appendUser("inspect");
    installRounds([
      {
        finishReason: "tool-calls",
        toolCalls: [{ toolCallId: "inspect-1", toolName: "inspect_attachment_paths", input: {} }],
      },
      {
        finishReason: "tool-calls",
        toolCalls: [{ toolCallId: "inspect-2", toolName: "inspect_attachment_paths", input: {} }],
      },
      { finishReason: "stop", text: "done" },
    ]);

    const running = runQueryLoop(harness.options);
    await firstStartedPromise;
    currentPaths = new Set();
    releaseFirst();
    await running;

    expect(resolutions).toBe(2);
    expect(received).toEqual([new Set([allowedPath]), new Set()]);
  });

  test("keeps blocked ask_user at zero results and resumes only after the exact response", async () => {
    const harness = await createHarness();
    harness.registry.register(askUserTool);
    harness.options.allowedTools = ["ask_user"];
    harness.appendUser("ask");
    const call = {
      toolCallId: "ask-1",
      toolName: "ask_user",
      input: { questions: [{ question: "Continue?", header: "Continue", options: [], custom: true }] },
    };
    installRounds([{ finishReason: "tool-calls", toolCalls: [call] }]);
    expect(await runQueryLoop(harness.options)).toMatchObject({
      outcome: "suspended",
      suspension: { kind: "hitl" },
    });
    expect(toolEvents(harness)).toHaveLength(0);
    const blocker = harness.store.getState().toolBatches[0]!.calls[0]!.blocker!;

    await applySessionToolBatchResponse({
      registry: harness.registry,
      storeManager: harness.storeManager,
      workspaceRoot: harness.workspaceRoot,
      sessionId: harness.sessionId,
      hitlId: blocker.hitlId!,
      requestKey: blocker.requestKey,
      response: { type: "question_answer", answers: ["Yes"] },
    });
    installRounds([{ finishReason: "stop", text: "continued" }]);
    expect(await runQueryLoop(harness.options)).toMatchObject({ status: "completed", text: "continued" });
    expect(toolEvents(harness)).toHaveLength(1);
    expect(toolEvents(harness)[0]!.result.details?.presentations?.[0]).toMatchObject({ kind: "ask_user" });
  });

  test("settles doom-loop calls through Registry and retains strict result shape", async () => {
    const harness = await createHarness();
    let executions = 0;
    registerInline(harness, "echo", async () => { executions += 1; return createTextToolResult("ok"); });
    harness.appendUser("run");
    const calls = [1, 2, 3].map((index) => ({ toolCallId: `call-${index}`, toolName: "echo", input: { value: "same" } }));
    installRounds([
      { finishReason: "tool-calls", toolCalls: calls },
      { finishReason: "stop", text: "done" },
    ]);
    await runQueryLoop(harness.options);
    expect(executions).toBe(2);
    expect(toolEvents(harness)).toHaveLength(3);
    expect(toolEvents(harness).find((event) => event.toolCallId === "call-3")!.result).toMatchObject({
      isError: true,
      output: { preview: expect.stringContaining(DOOM_LOOP_MESSAGE) },
    });
  });

  test("drives cwd changes only from the runtime sidecar", async () => {
    const harness = await createHarness();
    registerInline(
      harness,
      "cwd",
      async () => createTextToolResult("changed", { sidecar: { sessionCwdChanged: true } }),
      { readOnly: false, destructive: false, concurrencySafe: false },
    );
    harness.appendUser("run");
    installRounds([{ finishReason: "tool-calls", toolCalls: [{ toolCallId: "cwd-1", toolName: "cwd", input: {} }] }]);
    expect(await runQueryLoop(harness.options)).toMatchObject({ status: "completed", cwdChanged: { previousCwd: harness.workspaceRoot } });
    expect(toolEvents(harness)[0]!.result).not.toHaveProperty("sidecar");
  });

  test("commits steers before projecting messages and runs hooks in lifecycle order", async () => {
    const harness = await createHarness();
    harness.appendUser("original");
    const order: string[] = [];
    let projected = "";
    harness.options.consumeSteers = async () => {
      order.push("steer");
      harness.appendUser("steered");
    };
    harness.options.prepareModelContext = async () => {
      order.push("prepare");
    };
    harness.options.hooks = {
      beforeModelBuild: [async () => { order.push("build"); }],
      beforeModelCall: [async ({ messages }) => {
        order.push("call");
        projected = JSON.stringify(messages);
      }],
      afterStepEnd: [async () => { order.push("step-end"); }],
      afterLoopEnd: [async () => { order.push("loop-end"); }],
    };
    installRounds([{ finishReason: "stop", text: "done" }]);

    await runQueryLoop(harness.options);

    expect(order).toEqual(["steer", "prepare", "build", "prepare", "call", "step-end", "loop-end"]);
    expect(projected).toContain("steered");
  });

  test("projects the same signed image from the frozen binding only when image input is declared", async () => {
    const pngBytes = Uint8Array.of(
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
    );

    for (const supportsImages of [true, false]) {
      const harness = await createHarness();
      const service = new SessionAttachmentService({
        storage: new ProjectAttachmentStorage(),
        validateRootSession: async () => {},
      });
      const uploaded = await service.upload({
        workspaceRoot: harness.workspaceRoot,
        rootSessionId: harness.store.getState().rootSessionId,
        attachmentId: crypto.randomUUID(),
        name: "diagram.png",
        sizeBytes: pngBytes.byteLength,
        mediaType: "application/octet-stream",
        body: byteStream(pngBytes),
      });
      harness.appendAttachment(uploaded.descriptor);
      harness.options.attachmentProjector = new SessionAttachmentModelProjector(service);
      harness.options.binding = bindingWithInputModalities(
        supportsImages ? ["text", "image"] : ["text"],
      );
      let call: { messages: ModelMessage[] } | undefined;
      installRounds(
        [{ finishReason: "stop", text: "done" }],
        (options) => { call = options as { messages: ModelMessage[] }; },
      );

      await runQueryLoop(harness.options);

      const serialized = JSON.stringify(call!.messages);
      expect(serialized).toContain(
        getAttachmentContentPath(
          harness.workspaceRoot,
          harness.store.getState().rootSessionId,
          uploaded.descriptor.id,
        ),
      );
      const parts = call!.messages.flatMap((message) =>
        message.role === "user" && typeof message.content !== "string"
          ? message.content
          : []
      );
      const imageParts = parts.filter((part) => part.type === "image");
      expect(imageParts).toHaveLength(supportsImages ? 1 : 0);
      if (supportsImages) {
        const imagePart = imageParts[0] as { image: Uint8Array; mediaType?: string };
        expect(Array.from(imagePart.image)).toEqual(Array.from(pngBytes));
        expect(imagePart.mediaType).toBe("image/png");
      }
    }
  });

  test("projects after beforeModelCall reordering and skips a marker removed by that hook", async () => {
    for (const hookAction of ["reorder", "remove"] as const) {
      const harness = await createHarness();
      const attachment: AttachmentDescriptor = {
        id: crypto.randomUUID(),
        name: "diagram.png",
        mediaType: "image/png",
        sizeBytes: 3,
        kind: "image",
      };
      harness.appendAttachment(attachment);
      const readVerified = mock(async () => ({
        descriptor: attachment,
        contentPath: getAttachmentContentPath(
          harness.workspaceRoot,
          harness.store.getState().rootSessionId,
          attachment.id,
        ),
        bytes: Uint8Array.of(1, 2, 3),
      }));
      harness.options.attachmentProjector = new SessionAttachmentModelProjector({
        resolveReadPath: async () => getAttachmentContentPath(
          harness.workspaceRoot,
          harness.store.getState().rootSessionId,
          attachment.id,
        ),
        readVerified,
      });
      harness.options.binding = bindingWithInputModalities(["text", "image"]);
      harness.options.hooks = {
        beforeModelCall: [async ({ messages }) => {
          const message = messages.find((candidate) =>
            candidate.role === "user" && typeof candidate.content !== "string"
          );
          if (message?.role !== "user" || typeof message.content === "string") {
            throw new Error("Expected attachment array content");
          }
          if (hookAction === "reorder") {
            message.content.unshift({ type: "text", text: "hook-prefix" });
          } else {
            message.content.splice(0);
          }
        }],
      };
      let call: { messages: ModelMessage[] } | undefined;
      installRounds(
        [{ finishReason: "stop", text: "done" }],
        (options) => { call = options as { messages: ModelMessage[] }; },
      );

      await runQueryLoop(harness.options);

      expect(readVerified).toHaveBeenCalledTimes(hookAction === "reorder" ? 1 : 0);
      const serialized = JSON.stringify(call!.messages);
      expect(serialized.includes('"type":"image"')).toBe(hookAction === "reorder");
      expect(serialized.includes("<path>")).toBe(hookAction === "reorder");
    }
  });

  test("does not call the provider when verified image content has drifted or become a symlink", async () => {
    for (const corruption of ["digest", "symlink"] as const) {
      const harness = await createHarness();
      const service = new SessionAttachmentService({
        storage: new ProjectAttachmentStorage(),
        validateRootSession: async () => {},
      });
      const bytes = Uint8Array.of(
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      );
      const uploaded = await service.upload({
        workspaceRoot: harness.workspaceRoot,
        rootSessionId: harness.store.getState().rootSessionId,
        attachmentId: crypto.randomUUID(),
        name: "diagram.png",
        sizeBytes: bytes.byteLength,
        body: byteStream(bytes),
      });
      harness.appendAttachment(uploaded.descriptor);
      harness.options.attachmentProjector = new SessionAttachmentModelProjector(service);
      harness.options.binding = bindingWithInputModalities(["text", "image"]);
      const contentPath = getAttachmentContentPath(
        harness.workspaceRoot,
        harness.store.getState().rootSessionId,
        uploaded.descriptor.id,
      );
      if (corruption === "digest") {
        await Bun.write(contentPath, Uint8Array.of(
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b,
        ));
      } else {
        const outside = join(harness.workspaceRoot, "outside-image");
        await Bun.write(outside, bytes);
        await rm(contentPath);
        await symlink(outside, contentPath);
      }
      let providerCalls = 0;
      installRounds(
        [{ finishReason: "stop", text: "must not run" }],
        () => { providerCalls += 1; },
      );

      const result = await runQueryLoop(harness.options);

      expect(result.outcome).toBe("terminal");
      if (result.outcome !== "terminal") throw new Error("Expected terminal attachment projection failure");
      expect(result.status).toBe("failed");
      expect(providerCalls).toBe(0);
    }
  });

  test("phase two materializes a Goal edit completed inside beforeModelBuild before projection", async () => {
    const harness = await createHarness();
    harness.appendUser("continue");
    const goalService = new SessionGoalService(harness.storeManager);
    const created = await goalService.create({
      workspaceRoot: harness.workspaceRoot,
      sessionId: harness.sessionId,
      authority: { kind: "user_control" },
      objective: "Objective before compact.",
    });
    harness.options.prepareModelContext = async () => {
      await goalService.materializeModelContextNotices({
        workspaceRoot: harness.workspaceRoot,
        sessionId: harness.sessionId,
      });
    };
    let edited = false;
    let projected = "";
    harness.options.hooks = {
      beforeModelBuild: [async () => {
        if (edited) return;
        edited = true;
        await goalService.edit({
          workspaceRoot: harness.workspaceRoot,
          sessionId: harness.sessionId,
          authority: { kind: "user_control" },
          expectedGeneration: created.generation,
          objective: "Objective edited while compact was blocked.",
        });
      }],
      beforeModelCall: [async ({ messages }) => {
        projected = JSON.stringify(messages);
      }],
    };
    installRounds([{ finishReason: "stop", text: "done" }]);

    await runQueryLoop(harness.options);

    expect(projected).toContain("Objective edited while compact was blocked.");
    expect(projected).toContain("<action>edited</action>");
  });

  test("a Goal edit inside a parallel tool batch waits for the next boundary and follows every complete tool pair", async () => {
    const harness = await createHarness();
    harness.appendUser("continue");
    const goalService = new SessionGoalService(harness.storeManager);
    const created = await goalService.create({
      workspaceRoot: harness.workspaceRoot,
      sessionId: harness.sessionId,
      authority: { kind: "user_control" },
      objective: "Objective before high-water.",
    });
    registerInline(harness, "edit_goal_fixture", async () => {
      await goalService.edit({
        workspaceRoot: harness.workspaceRoot,
        sessionId: harness.sessionId,
        authority: { kind: "user_control" },
        expectedGeneration: created.generation,
        objective: "Objective after phase-two high-water.",
      });
      return createTextToolResult("Goal edited");
    });
    registerInline(harness, "echo", async () => createTextToolResult("parallel tool complete"));
    harness.options.prepareModelContext = async () => {
      await goalService.materializeModelContextNotices({
        workspaceRoot: harness.workspaceRoot,
        sessionId: harness.sessionId,
      });
    };
    const calls: Array<{ messages: unknown[] }> = [];
    installRounds([
      {
        finishReason: "tool-calls",
        toolCalls: [
          { toolCallId: "call-edit", toolName: "edit_goal_fixture", input: {} },
          { toolCallId: "call-echo", toolName: "echo", input: {} },
        ],
        chunks: [
          { type: "tool-call", toolCallId: "call-edit", toolName: "edit_goal_fixture", input: {} } as StreamPart,
          { type: "tool-call", toolCallId: "call-echo", toolName: "echo", input: {} } as StreamPart,
        ],
      },
      { finishReason: "stop", text: "done" },
    ], (options) => {
      calls.push(options as { messages: unknown[] });
    });

    await runQueryLoop(harness.options);

    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[0]!.messages)).not.toContain("Objective after phase-two high-water.");
    const secondMessages = calls[1]!.messages as Array<{ role?: string; content?: unknown }>;
    const serialized = JSON.stringify(secondMessages);
    expect(serialized.split("Objective after phase-two high-water.")).toHaveLength(2);
    expect(serialized.split("<action>edited</action>")).toHaveLength(2);
    const toolResultIndex = secondMessages.findIndex((message) =>
      message.role === "tool"
      && JSON.stringify(message.content).includes("call-edit")
      && JSON.stringify(message.content).includes("call-echo")
    );
    const editedNoticeIndex = secondMessages.findIndex((message) =>
      typeof message.content === "string"
      && message.content.includes("Objective after phase-two high-water.")
    );
    expect(toolResultIndex).toBeGreaterThanOrEqual(0);
    expect(editedNoticeIndex).toBeGreaterThan(toolResultIndex);
  });

  test("fails closed before model execution and leaves no Step when context preparation fails", async () => {
    const harness = await createHarness();
    harness.appendUser("prepare");
    let modelCalls = 0;
    harness.options.prepareModelContext = async () => {
      throw new Error("goal notice persistence failed");
    };
    installRounds([{ finishReason: "stop", text: "must not run" }], () => {
      modelCalls += 1;
    });

    expect(await runQueryLoop(harness.options)).toMatchObject({
      status: "failed",
      error: "goal notice persistence failed",
    });
    expect(modelCalls).toBe(0);
    expect(harness.store.getState().steps).toHaveLength(0);
    expect(streamEvents(harness)).toContain("execution-error");
    expect(streamEvents(harness)).not.toContain("step-start");
    expect(streamEvents(harness)).not.toContain("step-end");
  });

  test("projects provider-addressed text and reasoning blocks in their original order", async () => {
    const harness = await createHarness();
    harness.appendUser("stream");
    installRounds([{
      finishReason: "stop",
      text: "hello world",
      chunks: [
        { type: "reasoning-start", id: "reasoning-a" } as StreamPart,
        { type: "reasoning-delta", id: "reasoning-a", text: "think" } as StreamPart,
        { type: "reasoning-end", id: "reasoning-a" } as StreamPart,
        { type: "text-start", id: "output-a" } as StreamPart,
        { type: "text-delta", id: "output-a", text: "hello world" } as StreamPart,
        { type: "text-end", id: "output-a" } as StreamPart,
        { type: "reasoning-start", id: "reasoning-b" } as StreamPart,
        { type: "reasoning-delta", id: "reasoning-b", text: "more" } as StreamPart,
        { type: "reasoning-end", id: "reasoning-b" } as StreamPart,
      ],
    }]);

    const result = await runQueryLoop(harness.options);
    expect(result).toMatchObject({ status: "completed", text: "hello world" });
    expect(result.finalOutputStepId).toBeString();
    expect(streamEvents(harness)).toEqual(expect.arrayContaining([
      "reasoning-start", "reasoning-delta", "text-start", "text-delta", "reasoning-end", "text-end",
    ]));
    const assistant = harness.store.getState().messages.at(-1)!;
    expect(assistant.parts.map((part) => part.type)).toEqual([
      "reasoning",
      "assistant-output",
      "reasoning",
    ]);
    expect(assistant.stepId).toBe(result.finalOutputStepId);
  });

  test("preserves block order when secret-prefix buffering delays visible reasoning text", async () => {
    const harness = await createHarness();
    harness.options.binding = bindingWithProviderSecrets(["secret"]);
    harness.appendUser("stream");
    installRounds([{
      finishReason: "stop",
      text: "comment",
      chunks: [
        { type: "reasoning-start", id: "reasoning" } as StreamPart,
        { type: "reasoning-delta", id: "reasoning", text: "s" } as StreamPart,
        { type: "text-start", id: "output" } as StreamPart,
        { type: "text-delta", id: "output", text: "comment" } as StreamPart,
        { type: "text-end", id: "output" } as StreamPart,
        { type: "reasoning-end", id: "reasoning" } as StreamPart,
      ],
    }]);

    expect(await runQueryLoop(harness.options)).toMatchObject({
      status: "completed",
      text: "comment",
    });
    const assistant = harness.store.getState().messages.find((message) => message.role === "assistant");
    expect(assistant?.parts.map((part) => part.type)).toEqual([
      "reasoning",
      "assistant-output",
    ]);
    expect(assistant?.parts.map((part) => "text" in part ? part.text : undefined)).toEqual([
      "s",
      "comment",
    ]);
  });

  test("retains an open provider block as discarded partial output when the stream fails", async () => {
    const harness = await createHarness();
    harness.appendUser("stream");
    const streamFailure = Object.assign(new Error("stream failed"), { statusCode: 400 });
    setLlmAdapterForTest({
      streamText: mock(() => ({
        fullStream: (async function* () {
          yield { type: "text-start", id: "output" } as StreamPart;
          yield { type: "text-delta", id: "output", text: "partial tail" } as StreamPart;
          throw streamFailure;
        })(),
        finishReason: Promise.resolve("error"),
        usage: Promise.resolve({ totalTokens: 1 }),
        text: Promise.resolve("partial tail"),
        toolCalls: Promise.resolve([]),
      }) as never),
    });

    expect(await runQueryLoop(harness.options)).toMatchObject({ status: "failed" });
    const assistant = harness.store.getState().messages.at(-1)!;
    const output = assistant.parts.find((part) => part.type === "assistant-output");
    expect(output).toMatchObject({
      text: "partial tail",
      meta: { interrupted: true, discardedFromContext: true },
    });
    expect(output?.completedAt).toBeNumber();
  });

  test("rejects provider deltas without an addressed open block", async () => {
    const harness = await createHarness();
    harness.appendUser("stream");
    installRounds([{
      finishReason: "stop",
      text: "must not become final",
      chunks: [{ type: "text-delta", id: "missing", text: "invalid" } as StreamPart],
    }]);

    const result = await runQueryLoop(harness.options);
    expect(result).toMatchObject({ status: "failed" });
    expect(result.finalOutputStepId).toBeUndefined();
    const assistant = harness.store.getState().messages.at(-1)!;
    expect(assistant.parts.some((part) => part.type === "assistant-output")).toBe(false);
    expect(assistant.parts.find((part) => part.type === "recovery-notice")?.id)
      .toBe(`recovery:session:${assistant.stepId}`);
  });

  test("rejects blank provider text and reasoning block ids before persistence", async () => {
    for (const type of ["text-start", "reasoning-start"] as const) {
      const harness = await createHarness();
      harness.appendUser("stream");
      installRounds([{
        finishReason: "stop",
        text: "must not become final",
        chunks: [{ type, id: " \t" } as StreamPart],
      }]);

      const result = await runQueryLoop(harness.options);
      expect(result).toMatchObject({ status: "failed" });
      expect(result.finalOutputStepId).toBeUndefined();
      const assistant = harness.store.getState().messages.at(-1)!;
      expect(assistant.parts.some((part) =>
        part.type === "assistant-output" || part.type === "reasoning"
      )).toBe(false);
    }
  });

  test("rejects secret-bearing provider block ids without leaking them to Store events", async () => {
    const secret = "provider-secret-block-id";
    for (const type of ["text-start", "reasoning-start"] as const) {
      const harness = await createHarness();
      harness.options.binding = bindingWithProviderSecrets([secret]);
      harness.appendUser("stream");
      installRounds([{
        finishReason: "stop",
        text: "must not become final",
        chunks: [{ type, id: `prefix-${secret}-suffix` } as StreamPart],
      }]);

      const result = await runQueryLoop(harness.options);
      expect(result).toMatchObject({ status: "failed" });
      expect(result.finalOutputStepId).toBeUndefined();
      const state = harness.store.getState();
      expect(JSON.stringify({ messages: state.messages, events: state.events })).not.toContain(secret);
    }
  });

  test("rejects a reused text block id after the original block ended", async () => {
    const harness = await createHarness();
    harness.appendUser("stream");
    installRounds([{
      finishReason: "stop",
      text: "must not become final",
      chunks: [
        { type: "text-start", id: "duplicate" } as StreamPart,
        { type: "text-delta", id: "duplicate", text: "first" } as StreamPart,
        { type: "text-end", id: "duplicate" } as StreamPart,
        { type: "text-start", id: "duplicate" } as StreamPart,
      ],
    }]);

    const result = await runQueryLoop(harness.options);

    expect(result).toMatchObject({ status: "failed" });
    expect(result.finalOutputStepId).toBeUndefined();
    const output = harness.store.getState().messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.parts)
      .find((part) => part.type === "assistant-output");
    expect(output).toMatchObject({
      text: "first",
      meta: { interrupted: true, discardedFromContext: true },
    });
  });

  test("rejects a reused reasoning block id after the original block ended", async () => {
    const harness = await createHarness();
    harness.appendUser("stream");
    installRounds([{
      finishReason: "stop",
      text: "",
      chunks: [
        { type: "reasoning-start", id: "duplicate" } as StreamPart,
        { type: "reasoning-delta", id: "duplicate", text: "first" } as StreamPart,
        { type: "reasoning-end", id: "duplicate" } as StreamPart,
        { type: "reasoning-start", id: "duplicate" } as StreamPart,
      ],
    }]);

    const result = await runQueryLoop(harness.options);

    expect(result).toMatchObject({ status: "failed" });
    const reasoning = harness.store.getState().messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.parts)
      .find((part) => part.type === "reasoning");
    expect(reasoning).toMatchObject({
      text: "first",
      meta: { interrupted: true, discardedFromContext: true },
    });
  });

  test("uses a fresh attempt id when retrying the same numeric step", async () => {
    const harness = await createHarness();
    harness.appendUser("stream");
    const retryable = Object.assign(new Error("temporary stream failure"), { statusCode: 503 });
    let call = 0;
    setLlmAdapterForTest({
      streamText: mock(() => {
        call += 1;
        if (call === 1) {
          return {
            fullStream: (async function* () {
              yield { type: "text-start", id: "output" } as StreamPart;
              yield { type: "text-delta", id: "output", text: "partial" } as StreamPart;
              throw retryable;
            })(),
            finishReason: Promise.resolve("error"),
            usage: Promise.resolve({ totalTokens: 1 }),
            text: Promise.resolve("partial"),
            toolCalls: Promise.resolve([]),
          } as never;
        }
        return {
          fullStream: (async function* () {
            yield { type: "text-start", id: "output" } as StreamPart;
            yield { type: "text-delta", id: "output", text: "done" } as StreamPart;
            yield { type: "text-end", id: "output" } as StreamPart;
          })(),
          finishReason: Promise.resolve("stop"),
          usage: Promise.resolve({ totalTokens: 1 }),
          text: Promise.resolve("done"),
          toolCalls: Promise.resolve([]),
        } as never;
      }),
    });

    const result = await runQueryLoop(harness.options, {
      now: () => 0,
      sleep: async () => {},
    });
    expect(result).toMatchObject({ status: "completed", text: "done" });
    const steps = harness.store.getState().steps;
    expect(steps).toHaveLength(2);
    expect(steps.map((step) => step.step)).toEqual([0, 0]);
    expect(new Set(steps.map((step) => step.id)).size).toBe(2);
    const attempts = harness.store.getState().messages.filter((message) => message.role === "assistant");
    const partial = attempts[0]?.parts.find((part) => part.type === "assistant-output");
    expect(partial?.meta).toMatchObject({
      interrupted: true,
      discardedFromContext: true,
    });
    expect(result.finalOutputStepId).toBe(steps[1]?.id);
  });

  test("keeps partial-output recovery numbering and backoff across fresh attempt ids", async () => {
    const harness = await createHarness();
    harness.appendUser("stream");
    const retryable = Object.assign(new Error("temporary stream failure"), { statusCode: 503 });
    const delays: number[] = [];
    let call = 0;
    setLlmAdapterForTest({
      streamText: mock(() => {
        call += 1;
        if (call <= 2) {
          return {
            fullStream: (async function* () {
              yield { type: "text-start", id: "output" } as StreamPart;
              yield { type: "text-delta", id: "output", text: `partial-${call}` } as StreamPart;
              throw retryable;
            })(),
            finishReason: Promise.resolve("error"),
            usage: Promise.resolve({ totalTokens: 1 }),
            text: Promise.resolve(`partial-${call}`),
            toolCalls: Promise.resolve([]),
          } as never;
        }
        return {
          fullStream: (async function* () {
            yield { type: "text-start", id: "output" } as StreamPart;
            yield { type: "text-delta", id: "output", text: "done" } as StreamPart;
            yield { type: "text-end", id: "output" } as StreamPart;
          })(),
          finishReason: Promise.resolve("stop"),
          usage: Promise.resolve({ totalTokens: 1 }),
          text: Promise.resolve("done"),
          toolCalls: Promise.resolve([]),
        } as never;
      }),
    });

    const result = await runQueryLoop(harness.options, {
      now: () => 0,
      sleep: async (delayMs) => { delays.push(delayMs); },
    });

    expect(result).toMatchObject({ status: "completed", text: "done" });
    expect(harness.store.getState().steps.map((step) => step.step)).toEqual([0, 0, 0]);
    expect(new Set(harness.store.getState().steps.map((step) => step.id)).size).toBe(3);
    const retries = harness.store.getState().events
      .map((event) => event.payload)
      .filter((event): event is Extract<typeof event, { type: "llm-retry" }> =>
        event.type === "llm-retry" && event.profile === "partial-output-recovery"
      );
    expect(retries.map((event) => event.attempt)).toEqual([1, 2]);
    expect(new Set(retries.map((event) => event.stepId)).size).toBe(1);
    expect(delays).toEqual([2_000, 4_000]);
    const recoveryNotices = harness.store.getState().messages.flatMap((message) =>
      message.parts.filter((part) => part.type === "recovery-notice")
    );
    expect(recoveryNotices).toEqual([
      expect.objectContaining({ status: "recovered", attempt: 2 }),
    ]);
  });

  test("settles a reused tool call on the recovered attempt without moving focus to the failed attempt", async () => {
    const harness = await createHarness();
    registerInline(harness, "read", ({ value }) => createTextToolResult(value ?? "new content"));
    harness.options.allowedTools = ["read"];
    harness.appendUser("stream");
    const retryable = Object.assign(new Error("temporary stream failure"), { statusCode: 503 });
    let call = 0;
    setLlmAdapterForTest({
      streamText: mock(() => {
        call += 1;
        if (call === 1) {
          return {
            fullStream: (async function* () {
              yield { type: "text-start", id: "output" } as StreamPart;
              yield { type: "text-delta", id: "output", text: "partial" } as StreamPart;
              yield {
                type: "tool-call",
                toolCallId: "call-reused",
                toolName: "read",
                input: { value: "old" },
              } as StreamPart;
              throw retryable;
            })(),
            finishReason: Promise.resolve("error"),
            usage: Promise.resolve({ totalTokens: 1 }),
            text: Promise.resolve("partial"),
            toolCalls: Promise.resolve([]),
          } as never;
        }
        if (call === 2) {
          return {
            fullStream: (async function* () {
              yield {
                type: "tool-call",
                toolCallId: "call-reused",
                toolName: "read",
                input: { value: "new" },
              } as StreamPart;
            })(),
            finishReason: Promise.resolve("tool-calls"),
            usage: Promise.resolve({ totalTokens: 1 }),
            text: Promise.resolve(""),
            toolCalls: Promise.resolve([{
              toolCallId: "call-reused",
              toolName: "read",
              input: { value: "new" },
            }]),
          } as never;
        }
        return {
          fullStream: (async function* () {
            yield { type: "text-start", id: "output" } as StreamPart;
            yield { type: "text-delta", id: "output", text: "done" } as StreamPart;
            yield { type: "text-end", id: "output" } as StreamPart;
          })(),
          finishReason: Promise.resolve("stop"),
          usage: Promise.resolve({ totalTokens: 1 }),
          text: Promise.resolve("done"),
          toolCalls: Promise.resolve([]),
        } as never;
      }),
    });

    const result = await runQueryLoop(harness.options, {
      now: () => 0,
      sleep: async () => {},
    });

    expect(result).toMatchObject({ status: "completed", text: "done" });
    const attempts = harness.store.getState().messages.filter((message) => message.role === "assistant");
    const failedTool = attempts[0]!.parts.find((part) =>
      part.type === "tool" && part.toolCallId === "call-reused"
    );
    const recoveredTool = attempts[1]!.parts.find((part) =>
      part.type === "tool" && part.toolCallId === "call-reused"
    );
    expect(failedTool).toMatchObject({ state: "interrupted", input: { value: "old" } });
    expect(recoveredTool).toMatchObject({
      state: "completed",
      input: { value: "new" },
      result: expect.objectContaining({ isError: false }),
    });
    expect(harness.store.getState().currentAssistantMessageId).toBe(attempts[2]!.id);
  });

  test("does not persist or count empty provider text and reasoning blocks", async () => {
    const harness = await createHarness();
    harness.appendUser("empty");
    installRounds([{
      finishReason: "stop",
      text: "",
      chunks: [
        { type: "reasoning-start", id: "reasoning-empty" } as StreamPart,
        { type: "reasoning-end", id: "reasoning-empty" } as StreamPart,
        { type: "text-start", id: "output-empty" } as StreamPart,
        { type: "text-end", id: "output-empty" } as StreamPart,
      ],
    }]);

    const result = await runQueryLoop(harness.options);

    expect(result).toMatchObject({ status: "completed", text: "" });
    expect(result.finalOutputStepId).toBeUndefined();
    const assistant = harness.store.getState().messages.find((message) => message.role === "assistant");
    expect(assistant?.parts).toEqual([]);
    expect(harness.store.getState().stats.messages.assistant).toBe(0);
  });

  test("settles unknown and disallowed model calls as strict errors without executing a tool", async () => {
    const harness = await createHarness();
    let executions = 0;
    harness.registry.register(defineTool({
      name: "private_tool",
      description: "private",
      inputSchema: z.object({}).strict(),
      traits: { readOnly: true, destructive: false, concurrencySafe: true },
      outputPolicy: { kind: "inline", previewDirection: "head" },
      execute: async () => { executions += 1; return createTextToolResult("not reached"); },
    }));
    harness.appendUser("run");
    installRounds([
      { finishReason: "tool-calls", toolCalls: [
        { toolCallId: "unknown", toolName: "absent", input: {} },
        { toolCallId: "denied", toolName: "private_tool", input: {} },
      ] },
      { finishReason: "stop", text: "done" },
    ]);

    await runQueryLoop(harness.options);
    expect(executions).toBe(0);
    expect(toolEvents(harness).map((event) => event.result.details?.error?.code)).toEqual([
      "TOOL_UNKNOWN", "TOOL_NOT_ALLOWED",
    ]);
    expect(toolEvents(harness).every((event) => event.result.output.preview.length <= 50 * 1024)).toBeTrue();
  });

  test("continues over multiple tool-call steps and stops at the configured maximum", async () => {
    const harness = await createHarness();
    registerInline(harness, "echo", async (input) => createTextToolResult(input.value ?? "ok"));
    harness.options.maxSteps = 2;
    harness.appendUser("run");
    installRounds([
      { finishReason: "tool-calls", toolCalls: [{ toolCallId: "one", toolName: "echo", input: { value: "one" } }] },
      { finishReason: "tool-calls", toolCalls: [{ toolCallId: "two", toolName: "echo", input: { value: "two" } }] },
    ]);

    expect(await runQueryLoop(harness.options)).toMatchObject({ status: "max_steps", steps: 2 });
    expect(toolEvents(harness).map((event) => event.result.output.preview)).toEqual(["one", "two"]);
    expect(streamEvents(harness)).toContain("execution-error");
  });

  test("emits resolved tool input with schema defaults before strict finalization", async () => {
    const harness = await createHarness();
    harness.registry.register(defineTool({
      name: "defaults",
      description: "defaults",
      inputSchema: z.object({ value: z.string().default("resolved") }).strict(),
      traits: { readOnly: true, destructive: false, concurrencySafe: true },
      outputPolicy: { kind: "inline", previewDirection: "head" },
      execute: async (input) => createTextToolResult(input.value),
    }));
    harness.options.allowedTools = ["defaults"];
    harness.appendUser("run");
    installRounds([
      { finishReason: "tool-calls", toolCalls: [{ toolCallId: "defaults-1", toolName: "defaults", input: {} }] },
      { finishReason: "stop", text: "done" },
    ]);

    await runQueryLoop(harness.options);
    const resolved = harness.store.getState().events.find((event) => event.payload.type === "tool-input-resolved");
    expect(resolved?.payload).toMatchObject({ type: "tool-input-resolved", input: { value: "resolved" } });
    expect(toolEvents(harness)[0]!.result.output.preview).toBe("resolved");
  });

  test("exposes only allowed registered tools to the model while retaining unknown execution denial", async () => {
    const harness = await createHarness();
    registerInline(harness, "visible", async () => createTextToolResult("visible"));
    harness.registry.register(defineTool({
      name: "hidden",
      description: "hidden",
      inputSchema: z.object({}).strict(),
      traits: { readOnly: true, destructive: false, concurrencySafe: true },
      outputPolicy: { kind: "inline", previewDirection: "head" },
      execute: async () => createTextToolResult("hidden"),
    }));
    harness.options.allowedTools = ["visible", "ghost"];
    harness.appendUser("run");
    let modelOptions: { tools?: Record<string, unknown> } | undefined;
    installRounds([{ finishReason: "stop", text: "done" }], (options) => { modelOptions = options as typeof modelOptions; });

    await runQueryLoop(harness.options);
    expect(Object.keys(modelOptions?.tools ?? {})).toEqual(["visible"]);
  });

  test("partitions concurrency-safe calls without delaying one behind the other", async () => {
    const harness = await createHarness();
    let releaseSecond: (() => void) | undefined;
    const secondStarted = new Promise<void>((resolve) => { releaseSecond = resolve; });
    harness.registry.register(defineTool({
      name: "first",
      description: "first",
      inputSchema: z.object({}).strict(),
      traits: { readOnly: true, destructive: false, concurrencySafe: true },
      outputPolicy: { kind: "inline", previewDirection: "head" },
      execute: async () => {
        await secondStarted;
        return createTextToolResult("first");
      },
    }));
    harness.registry.register(defineTool({
      name: "second",
      description: "second",
      inputSchema: z.object({}).strict(),
      traits: { readOnly: true, destructive: false, concurrencySafe: true },
      outputPolicy: { kind: "inline", previewDirection: "head" },
      execute: async () => { releaseSecond?.(); return createTextToolResult("second"); },
    }));
    harness.options.allowedTools = ["first", "second"];
    harness.appendUser("run");
    installRounds([
      { finishReason: "tool-calls", toolCalls: [
        { toolCallId: "first", toolName: "first", input: {} },
        { toolCallId: "second", toolName: "second", input: {} },
      ] },
      { finishReason: "stop", text: "done" },
    ]);

    await runQueryLoop(harness.options);
    expect(toolEvents(harness).map((event) => event.result.isError)).toEqual([false, false]);
    expect(toolEvents(harness).map((event) => event.result.output.preview).sort()).toEqual(["first", "second"]);
  });

  test("aborts before model execution and always runs terminal hooks", async () => {
    const harness = await createHarness();
    const controller = new AbortController();
    controller.abort(new DOMException("stopped", "AbortError"));
    const afterLoopEnd = mock(async () => {});
    harness.options.abort = controller.signal;
    harness.options.hooks = { afterLoopEnd: [afterLoopEnd] };
    harness.appendUser("run");

    expect(await runQueryLoop(harness.options)).toMatchObject({ status: "aborted" });
    expect(afterLoopEnd).toHaveBeenCalledTimes(1);
  });

  test("aborts a hung fullStream without waiting for the next chunk", async () => {
    const harness = await createHarness();
    const controller = new AbortController();
    let signalStreamBlocked!: () => void;
    const streamBlocked = new Promise<void>((resolve) => {
      signalStreamBlocked = resolve;
    });
    harness.options.abort = controller.signal;
    harness.appendUser("run");

    setLlmAdapterForTest({
      streamText: mock(() => ({
        fullStream: (async function* () {
          yield {
            type: "tool-input-start",
            id: "call-hung",
            toolName: "file_write",
          } as StreamPart;
          signalStreamBlocked();
          await new Promise<never>(() => undefined);
        })(),
        finishReason: new Promise<string>(() => undefined),
        usage: new Promise(() => undefined),
        text: new Promise<string>(() => undefined),
        toolCalls: new Promise(() => undefined),
      }) as never),
    });

    const running = runQueryLoop(harness.options);
    await streamBlocked;
    controller.abort(new DOMException("stopped", "AbortError"));

    await expect(running).resolves.toMatchObject({ status: "aborted" });
    expect(streamEvents(harness)).toContain("tool-input-start");
  });

  test("aborts hung finalize promises after the stream ends", async () => {
    const harness = await createHarness();
    const controller = new AbortController();
    let signalStreamEnded!: () => void;
    const streamEnded = new Promise<void>((resolve) => {
      signalStreamEnded = resolve;
    });
    harness.options.abort = controller.signal;
    harness.appendUser("run");

    setLlmAdapterForTest({
      streamText: mock(() => ({
        fullStream: (async function* () {
          yield { type: "text-start", id: "output" } as StreamPart;
          yield { type: "text-delta", id: "output", text: "partial" } as StreamPart;
          signalStreamEnded();
        })(),
        finishReason: new Promise<string>(() => undefined),
        usage: new Promise(() => undefined),
        text: new Promise<string>(() => undefined),
        toolCalls: new Promise(() => undefined),
      }) as never),
    });

    const running = runQueryLoop(harness.options);
    await streamEnded;
    controller.abort(new DOMException("stopped", "AbortError"));

    await expect(running).resolves.toMatchObject({ status: "aborted" });
    const output = harness.store.getState().messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.parts)
      .find((part) => part.type === "assistant-output");
    expect(output).toMatchObject({
      text: "partial",
      meta: { interrupted: true, discardedFromContext: true },
    });
    expect(output?.completedAt).toBeNumber();
  });
});
