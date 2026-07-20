import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { StreamTextResult, ToolSet } from "ai";
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
import type { ToolExecutionContext } from "../../tools/types";
import { runQueryLoop } from "./loop";
import { DOOM_LOOP_MESSAGE, type QueryLoopOptions } from "./types";
import { createTestModelInfo } from "../../testing/test-execution-fixtures";

const ROOT = join("/tmp", "archcode-query-loop-hard-cut", crypto.randomUUID());
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
    resolution: "agent_default",
    modelRuntimeRevision: "test-revision",
  },
};

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
  const store = storeManager.create(sessionId, workspaceRoot, { agentName: "engineer" });
  const projectContext = createTestProjectContext(workspaceRoot, storeManager);
  const redactionPolicy = new SecretRedactionPolicy([]);
  const artifactStore = new ToolOutputArtifactStore({ rootDir: join(workspaceRoot, "outputs") });
  await artifactStore.ready();
  const registry = new ToolRegistry({
    finalizer: new ToolOutputFinalizer({ artifactStore, redactionPolicy }),
    hitlCodec: new HitlBoundaryCodec(redactionPolicy),
    logger: silentLogger,
  });
  const toolOutputAccess: ToolOutputAccessService = {
    countRecoverable: async () => 0,
    async read() { return { outputRef: "unused" as never, completeness: "complete", records: [] }; },
    async search() { return { matches: [], searchCompleteness: "complete" }; },
  };
  const options: QueryLoopOptions = {
    binding: dummyBinding,
    logger: silentLogger,
    toolRegistry: registry,
    allowedTools: [],
    agentSkills: [],
    skillService,
    storeManager,
    cwd: workspaceRoot,
    projectContext,
    toolOutputAccess,
    store,
    agentName: "engineer",
  };
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
  return { workspaceRoot, sessionId, storeManager, store, registry, options, appendUser, toolOutputAccess };
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

describe("QueryLoop Tool Output Plane hard cut", () => {
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
      { finishReason: "stop", text: "done", chunks: [{ type: "text-delta", text: "done" } as StreamPart] },
    ]);

    expect(await runQueryLoop(harness.options)).toMatchObject({ status: "completed", text: "done" });
    expect(toolEvents(harness)[0]).toMatchObject({
      toolCallId: "call-1",
      result: { isError: false, output: { preview: "hello" } },
    });
  });

  test("terminal execution control completes without leaving a resumable Tool Batch", async () => {
    const harness = await createHarness();
    registerInline(
      harness,
      "finish_child",
      async () => createTextToolResult("submitted", {
        sidecar: {
          executionControl: { action: "complete_execution", reason: "child_result_submitted" },
        },
      }),
      { readOnly: false, destructive: false, concurrencySafe: false },
    );
    harness.appendUser("finish");
    let modelCalls = 0;
    installRounds([{
      finishReason: "tool-calls",
      toolCalls: [{ toolCallId: "finish-1", toolName: "finish_child", input: {} }],
    }], () => { modelCalls += 1; });

    expect(await runQueryLoop(harness.options)).toMatchObject({
      status: "completed",
      executionControl: { action: "complete_execution", reason: "child_result_submitted" },
    });
    expect(modelCalls).toBe(1);
    expect(harness.store.getState().toolBatches).toEqual([
      expect.objectContaining({ archivedAt: expect.any(String) }),
    ]);
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
    expect(await runQueryLoop(harness.options)).toMatchObject({ status: "waiting_for_human" });
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

  test("settles restart-orphaned tool parts through Registry before the next model call", async () => {
    const harness = await createHarness();
    harness.appendUser("recover");
    harness.store.getState().append({ type: "step-start", step: 0 });
    harness.store.getState().append({ type: "tool-call", toolCallId: "orphan-1", toolName: "missing_tool", input: {} });
    harness.store.getState().append({
      type: "tool-attempt",
      toolCallId: "orphan-1",
      toolName: "missing_tool",
      attemptId: crypto.randomUUID(),
      timestamp: Date.now(),
      destructive: false,
    });
    harness.store.getState().append({ type: "execution-end", status: "interrupted" });
    expect(toolEvents(harness)).toHaveLength(0);
    installRounds([{ finishReason: "stop", text: "recovered" }]);
    expect(await runQueryLoop(harness.options)).toMatchObject({ status: "completed" });
    expect(toolEvents(harness)[0]!.result).toMatchObject({
      isError: true,
      details: { unknownResult: true },
    });
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

    expect(order).toEqual(["steer", "build", "call", "step-end", "loop-end"]);
    expect(projected).toContain("steered");
  });

  test("projects streamed text and reasoning in their original order", async () => {
    const harness = await createHarness();
    harness.appendUser("stream");
    installRounds([{
      finishReason: "stop",
      text: "hello world",
      chunks: [
        { type: "reasoning-delta", text: "think" } as StreamPart,
        { type: "text-delta", text: "hello " } as StreamPart,
        { type: "reasoning-delta", text: " more" } as StreamPart,
        { type: "text-delta", text: "world" } as StreamPart,
      ],
    }]);

    expect(await runQueryLoop(harness.options)).toMatchObject({ status: "completed", text: "hello world" });
    expect(streamEvents(harness)).toEqual(expect.arrayContaining([
      "reasoning-start", "reasoning-delta", "text-start", "text-delta", "reasoning-end", "text-end",
    ]));
    const assistant = harness.store.getState().messages.at(-1)!;
    expect(assistant.parts.map((part) => part.type)).toEqual(["reasoning", "text"]);
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
        await Promise.race([
          secondStarted,
          new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("not parallel")), 100)),
        ]);
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
});
