import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { ModelMessage, streamText as aiStreamText } from "ai";
import { randomUUID } from "node:crypto";
import type { StoreApi } from "zustand";
import { z } from "zod";
import { createSessionStore } from "../../store/store";
import type { SessionStoreState, StoredMessage } from "../../store/types";
import { createRegistry, defineTool } from "../../tools/index";
import type { PermissionErrorCode, ToolExecutionContext } from "../../tools/index";
import type { ToolRegistry } from "../../tools/registry";
import { __setStreamTextForTest, runQueryLoop } from "./loop";
import type { QueryLoopOptions } from "./types";

type MockChunk =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-input-start"; id: string; toolName: string }
  | { type: "tool-input-delta"; toolCallId: string; delta: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "start-step" }
  | { type: "finish-step" }
  | { type: "start" }
  | { type: "finish" }
  | { type: "abort" }
  | { type: "error"; error: unknown };

interface MockToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

interface MockRound {
  chunks?: MockChunk[];
  finishReason?: string | Promise<string>;
  usage?: unknown | Promise<unknown>;
  text?: string | Promise<string>;
  toolCalls?: MockToolCall[] | Promise<MockToolCall[]>;
  fullStreamError?: Error;
}

const dummyModel = {
  modelId: "mock-model",
  provider: "mock-provider",
} as unknown as LanguageModelV3;

const testToolSchema = z.object({ message: z.string().optional() }).strict();

function createTestTool(
  name = "echo",
  execute: (input: z.infer<typeof testToolSchema>, ctx: ToolExecutionContext) => string | Promise<string> = async () => "ok",
) {
  return defineTool({
    name,
    description: "Test tool",
    inputSchema: testToolSchema,
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    execute,
  });
}

function createTestRegistry(
  execute: (input: z.infer<typeof testToolSchema>, ctx: ToolExecutionContext) => string | Promise<string> = async () => "ok",
  name = "echo",
): ToolRegistry {
  return createRegistry([createTestTool(name, execute)]);
}

function createNamedTool(
  name: string,
  execute: (input: z.infer<typeof testToolSchema>, ctx: ToolExecutionContext) => string | Promise<string> = async () => `${name} ok`,
) {
  return defineTool({
    name,
    description: `Mock tool: ${name}`,
    inputSchema: testToolSchema,
    traits: {
      readOnly: name !== "destructiveTool",
      destructive: name === "destructiveTool",
      concurrencySafe: name !== "destructiveTool",
    },
    execute,
  });
}

function createPermissionBranchRegistry(
  execute: (name: string, input: z.infer<typeof testToolSchema>, ctx: ToolExecutionContext) => string | Promise<string> = async (name) => `${name} ok`,
): ToolRegistry {
  return createRegistry([
    createNamedTool("safeTool", (input, ctx) => execute("safeTool", input, ctx)),
    createNamedTool("destructiveTool", (input, ctx) => execute("destructiveTool", input, ctx)),
    createNamedTool("sensitiveReadTool", (input, ctx) => execute("sensitiveReadTool", input, ctx)),
  ]);
}

function createStore(): StoreApi<SessionStoreState> {
  return createSessionStore(randomUUID());
}

function makeOptions(overrides: Partial<QueryLoopOptions> = {}): QueryLoopOptions {
  return {
    model: dummyModel,
    toolRegistry: createRegistry(),
    store: createStore(),
    allowedTools: [],
    ...overrides,
  };
}

function createMockStreamText(rounds: MockRound[]) {
  let index = 0;

  const fn = mock((_: Parameters<typeof aiStreamText>[0]) => {
    const round = rounds[index++];
    if (!round) throw new Error("No more mock rounds");

    const chunks = round.chunks ?? textToChunks(round.text);

    return {
      fullStream: (async function* () {
        if (round.fullStreamError) throw round.fullStreamError;
        for (const chunk of chunks) {
          yield chunk;
        }
      })(),
      finishReason: Promise.resolve(round.finishReason ?? "stop"),
      usage: Promise.resolve(round.usage ?? { totalTokens: 1 }),
      text: Promise.resolve(round.text ?? collectText(chunks)),
      toolCalls: Promise.resolve(round.toolCalls ?? collectToolCalls(chunks)),
    };
  });

  __setStreamTextForTest(fn as unknown as typeof aiStreamText);
  return fn;
}

function textToChunks(text: MockRound["text"]): MockChunk[] {
  return typeof text === "string" && text.length > 0
    ? [{ type: "text-delta", text }]
    : [];
}

function collectText(chunks: MockChunk[]): string {
  return chunks
    .filter((chunk): chunk is Extract<MockChunk, { type: "text-delta" }> =>
      chunk.type === "text-delta",
    )
    .map((chunk) => chunk.text)
    .join("");
}

function collectToolCalls(chunks: MockChunk[]): MockToolCall[] {
  return chunks
    .filter((chunk): chunk is Extract<MockChunk, { type: "tool-call" }> =>
      chunk.type === "tool-call",
    )
    .map((chunk) => ({
      toolCallId: chunk.toolCallId,
      toolName: chunk.toolName,
      input: chunk.input,
    }));
}

function assistantMessages(store: StoreApi<SessionStoreState>): StoredMessage[] {
  return store.getState().messages.filter((message) => message.role === "assistant");
}

function lastAssistant(store: StoreApi<SessionStoreState>): StoredMessage {
  const messages = assistantMessages(store);
  const message = messages.at(-1);
  if (!message) throw new Error("Expected assistant message");
  return message;
}

function streamCallMessages(fn: ReturnType<typeof createMockStreamText>, callIndex: number): ModelMessage[] {
  const args = fn.mock.calls[callIndex]?.[0];
  if (!args || !("messages" in args)) throw new Error("Expected streamText messages");
  return args.messages as ModelMessage[];
}

beforeEach(() => {
  createMockStreamText([{ text: "default" }]);
});

describe("runQueryLoop store-source-of-truth behavior", () => {
  test("returns only text and steps in result shape", async () => {
    createMockStreamText([{ text: "Hello" }]);

    const result = await runQueryLoop(makeOptions(), "Hi");

    expect(result).toEqual({ text: "Hello", steps: 0 });
    expect("messages" in result).toBe(false);
  });

  test("emits run lifecycle into store and ends not running", async () => {
    const store = createStore();
    createMockStreamText([{ text: "ok" }]);

    await runQueryLoop(makeOptions({ store }), "Question");

    expect(store.getState().isRunning).toBe(false);
    expect(store.getState().isStreamingModel).toBe(false);
    expect(store.getState().currentRunId).toBeUndefined();
  });

  test("sets running flags during streamText after run-start and step-start", async () => {
    const store = createStore();
    const snapshots: Array<Pick<SessionStoreState, "isRunning" | "isStreamingModel">> = [];
    const fn = mock((_: Parameters<typeof aiStreamText>[0]) => {
      snapshots.push({
        isRunning: store.getState().isRunning,
        isStreamingModel: store.getState().isStreamingModel,
      });
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", text: "ok" };
        })(),
        finishReason: Promise.resolve("stop"),
        usage: Promise.resolve({ totalTokens: 1 }),
        text: Promise.resolve("ok"),
        toolCalls: Promise.resolve([]),
      };
    });
    __setStreamTextForTest(fn as unknown as typeof aiStreamText);

    await runQueryLoop(makeOptions({ store }), "Question");

    expect(snapshots).toEqual([{ isRunning: true, isStreamingModel: true }]);
  });

  test("records user and assistant messages in store", async () => {
    const store = createStore();
    createMockStreamText([{ text: "Answer" }]);

    await runQueryLoop(makeOptions({ store }), "Question");

    expect(store.getState().messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(store.getState().messages[0].parts[0]).toMatchObject({
      type: "text",
      text: "Question",
    });
  });

  test("streamText receives store projection after user message", async () => {
    const streamFn = createMockStreamText([{ text: "ok" }]);

    await runQueryLoop(makeOptions(), "Hello world");

    expect(streamCallMessages(streamFn, 0)).toEqual([
      { role: "user", content: "Hello world" },
    ]);
  });

  test("second step receives projected assistant tool history from store", async () => {
    const streamFn = createMockStreamText([
      {
        text: "Calling",
        finishReason: "tool-calls",
        chunks: [
          { type: "text-delta", text: "Calling" },
          { type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: { message: "ping" } },
        ],
      },
      { text: "Done" },
    ]);

    await runQueryLoop(
      makeOptions({
        toolRegistry: createTestRegistry(async () => "pong"),
        allowedTools: ["echo"],
      }),
      "Use tool",
    );

    expect(streamCallMessages(streamFn, 1)).toEqual([
      { role: "user", content: "Use tool" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Calling" },
          { type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: { message: "ping" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-1",
            toolName: "echo",
            output: { type: "text", value: "pong" },
          },
        ],
      },
    ]);
  });

  test("second run sees first run history in projection", async () => {
    const store = createStore();
    const streamFn = createMockStreamText([{ text: "First answer" }, { text: "Second answer" }]);

    await runQueryLoop(makeOptions({ store }), "First question");
    await runQueryLoop(makeOptions({ store }), "Second question");

    expect(streamCallMessages(streamFn, 1)).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: [{ type: "text", text: "First answer" }] },
      { role: "user", content: "Second question" },
    ]);
  });

  test("text streaming creates text part with concatenated final text", async () => {
    const store = createStore();
    createMockStreamText([
      { chunks: [{ type: "text-delta", text: "Hel" }, { type: "text-delta", text: "lo" }] },
    ]);

    await runQueryLoop(makeOptions({ store }), "Hi");

    expect(lastAssistant(store).parts).toEqual([
      expect.objectContaining({ type: "text", text: "Hello", completedAt: expect.any(Number) }),
    ]);
  });

  test("single text delta implicitly starts and ends text stream", async () => {
    const store = createStore();
    createMockStreamText([{ chunks: [{ type: "text-delta", text: "Only" }] }]);

    await runQueryLoop(makeOptions({ store }), "Hi");

    expect(store.getState().streamingText).toBeUndefined();
    expect(lastAssistant(store).parts[0]).toMatchObject({ type: "text", text: "Only" });
  });

  test("reasoning streaming creates completed reasoning part", async () => {
    const store = createStore();
    createMockStreamText([
      { chunks: [{ type: "reasoning-delta", text: "Think " }, { type: "reasoning-delta", text: "carefully" }] },
    ]);

    await runQueryLoop(makeOptions({ store }), "Hi");
    expect(lastAssistant(store).parts).toEqual([
      expect.objectContaining({ type: "reasoning", text: "Think carefully", completedAt: expect.any(Number) }),
    ]);
  });

  test("reasoning and text parts preserve stream order", async () => {
    const store = createStore();
    createMockStreamText([
      {
        chunks: [
          { type: "reasoning-delta", text: "Thought" },
          { type: "text-delta", text: "Answer" },
        ],
      },
    ]);

    await runQueryLoop(makeOptions({ store }), "Hi");
    expect(lastAssistant(store).parts.map((part) => part.type)).toEqual(["reasoning", "text"]);
  });

  test("tool-input-start and tool-call create running tool part", async () => {
    const store = createStore();
    createMockStreamText([
      {
        finishReason: "tool-calls",
        chunks: [
          { type: "tool-input-start", id: "tc-1", toolName: "echo" },
          { type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: { message: "hi" } },
        ],
      },
      { text: "Done" },
    ]);

    await runQueryLoop(
      makeOptions({ store, toolRegistry: createTestRegistry(), allowedTools: ["echo"] }),
      "Hi",
    );

    expect(assistantMessages(store)[0].parts[0]).toMatchObject({
      type: "tool",
      state: "completed",
      toolCallId: "tc-1",
      toolName: "echo",
      input: { message: "hi" },
      output: "ok",
    });
  });

  test("tool-call without tool-input-start still creates tool part", async () => {
    const store = createStore();
    createMockStreamText([
      {
        finishReason: "tool-calls",
        chunks: [{ type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: { message: "hi" } }],
      },
      { text: "Done" },
    ]);

    await runQueryLoop(
      makeOptions({ store, toolRegistry: createTestRegistry(), allowedTools: ["echo"] }),
      "Hi",
    );

    expect(assistantMessages(store)[0].parts[0]).toMatchObject({ type: "tool", state: "completed" });
  });

  test("tool-input-delta chunks are ignored but do not break streaming", async () => {
    const store = createStore();
    createMockStreamText([
      {
        finishReason: "tool-calls",
        chunks: [
          { type: "tool-input-start", id: "tc-1", toolName: "echo" },
          { type: "tool-input-delta", toolCallId: "tc-1", delta: "{}" },
          { type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: {} },
        ],
      },
      { text: "Done" },
    ]);

    await runQueryLoop(
      makeOptions({ store, toolRegistry: createTestRegistry(), allowedTools: ["echo"] }),
      "Hi",
    );

    expect(assistantMessages(store)[0].parts[0]).toMatchObject({ type: "tool", state: "completed" });
  });

  test("successful tool execution stores completed result", async () => {
    const store = createStore();
    const seenInputs: unknown[] = [];
    const executor = async (input: z.infer<typeof testToolSchema>) => {
      seenInputs.push(input);
      return "success output";
    };
    createMockStreamText([
      {
        finishReason: "tool-calls",
        chunks: [{ type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: { message: "x" } }],
      },
      { text: "Done" },
    ]);

    await runQueryLoop(
      makeOptions({ store, toolRegistry: createTestRegistry(executor), allowedTools: ["echo"] }),
      "Hi",
    );

    expect(seenInputs).toEqual([{ message: "x" }]);
    expect(assistantMessages(store)[0].parts[0]).toMatchObject({
      state: "completed",
      output: "success output",
    });
  });

  test("missing tool descriptor stores error result", async () => {
    const store = createStore();
    createMockStreamText([
      {
        finishReason: "tool-calls",
        chunks: [{ type: "tool-call", toolCallId: "tc-1", toolName: "missing", input: {} }],
      },
      { text: "Done" },
    ]);

    await runQueryLoop(makeOptions({ store }), "Hi");

    expect(assistantMessages(store)[0].parts[0]).toMatchObject({
      state: "error",
      errorMessage: 'Tool "missing" is not registered',
    });
  });

  test("missingTool stores TOOL_UNKNOWN even when allowedTools includes it", async () => {
    const store = createStore();
    createMockStreamText([
      {
        finishReason: "tool-calls",
        chunks: [{ type: "tool-call", toolCallId: "tc-missing", toolName: "missingTool", input: {} }],
      },
      { text: "Done" },
    ]);

    await runQueryLoop(
      makeOptions({ store, toolRegistry: createPermissionBranchRegistry(), allowedTools: ["missingTool"] }),
      "Use missing tool",
    );

    expect(assistantMessages(store)[0].parts[0]).toMatchObject({
      state: "error",
      toolName: "missingTool",
      errorMessage: 'Tool "missingTool" is not registered',
    });
  });

  test("destructiveTool registered but not allowed stores TOOL_NOT_ALLOWED and skips executor", async () => {
    const store = createStore();
    const executor = mock(async (_input: z.infer<typeof testToolSchema>, _ctx: ToolExecutionContext) => "should not run");
    createMockStreamText([
      {
        finishReason: "tool-calls",
        chunks: [{ type: "tool-call", toolCallId: "tc-denied", toolName: "destructiveTool", input: {} }],
      },
      { text: "Done" },
    ]);

    await runQueryLoop(
      makeOptions({
        store,
        toolRegistry: createPermissionBranchRegistry(async (_name, input, ctx) => executor(input, ctx)),
        allowedTools: ["safeTool"],
      }),
      "Use destructive tool",
    );

    expect(executor).not.toHaveBeenCalled();
    expect(assistantMessages(store)[0].parts[0]).toMatchObject({
      state: "error",
      toolName: "destructiveTool",
      errorMessage: 'Tool "destructiveTool" is not allowed for this execution context',
    });
  });

  test("permission branch errors store stable messages and skip executor", async () => {
    const cases: Array<{
      code: PermissionErrorCode;
      message: string;
      toolName: "safeTool" | "destructiveTool" | "sensitiveReadTool";
    }> = [
      { code: "TOOL_PERMISSION_DENIED", message: "guard denied sensitive read", toolName: "sensitiveReadTool" },
      { code: "TOOL_PERMISSION_CONFIRMATION_DENIED", message: "user denied destructive tool", toolName: "destructiveTool" },
      { code: "TOOL_PERMISSION_CONFIRMATION_TIMEOUT", message: "confirmation timed out", toolName: "destructiveTool" },
      { code: "TOOL_PERMISSION_CONFIRMATION_UNAVAILABLE", message: "confirmation unavailable", toolName: "sensitiveReadTool" },
      { code: "TOOL_PERMISSION_CONFIRMATION_FAILED", message: "confirmation callback failed", toolName: "sensitiveReadTool" },
      { code: "TOOL_PREPARE_INPUT_FAILED", message: "prepare input failed", toolName: "safeTool" },
    ];

    for (const testCase of cases) {
      const store = createStore();
      const executor = mock(async (_input: z.infer<typeof testToolSchema>, _ctx: ToolExecutionContext) => "should not run");
      const registry = createPermissionBranchRegistry(async (_name, input, ctx) => executor(input, ctx));
      const descriptor = registry.get(testCase.toolName);
      if (!descriptor) throw new Error(`Expected ${testCase.toolName}`);
      let confirmPermission: QueryLoopOptions["confirmPermission"] | undefined;

      if (testCase.code === "TOOL_PREPARE_INPUT_FAILED") {
        descriptor.prepareInput = async () => { throw new Error(testCase.message); };
      } else if (testCase.code === "TOOL_PERMISSION_DENIED") {
        descriptor.guards = [async () => ({ outcome: "deny", reason: testCase.message })];
      } else {
        descriptor.guards = [async () => ({ outcome: "ask", reason: testCase.message })];
        if (testCase.code === "TOOL_PERMISSION_CONFIRMATION_DENIED") {
          confirmPermission = async () => "deny";
        } else if (testCase.code === "TOOL_PERMISSION_CONFIRMATION_TIMEOUT") {
          confirmPermission = async () => "timeout";
        } else if (testCase.code === "TOOL_PERMISSION_CONFIRMATION_FAILED") {
          confirmPermission = async () => { throw new Error(testCase.message); };
        }
      }
      createMockStreamText([
        {
          finishReason: "tool-calls",
          chunks: [{ type: "tool-call", toolCallId: `tc-${testCase.code}`, toolName: testCase.toolName, input: {} }],
        },
        { text: "Done" },
      ]);

      await runQueryLoop(
        makeOptions({
          store,
          toolRegistry: registry,
          allowedTools: [testCase.toolName],
          ...(confirmPermission ? { confirmPermission } : {}),
        }),
        `Use ${testCase.toolName}`,
      );

      expect(executor).not.toHaveBeenCalled();
      expect(assistantMessages(store)[0].parts[0]).toMatchObject({
        state: "error",
        toolName: testCase.toolName,
        errorMessage: testCase.message,
      });
    }
  });

  test("throwing registry tool stores error message", async () => {
    const store = createStore();
    createMockStreamText([
      {
        finishReason: "tool-calls",
        chunks: [{ type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: {} }],
      },
      { text: "Done" },
    ]);

    await runQueryLoop(
      makeOptions({
        store,
        toolRegistry: createTestRegistry(async () => { throw new Error("boom"); }),
        allowedTools: ["echo"],
      }),
      "Hi",
    );

    expect(assistantMessages(store)[0].parts[0]).toMatchObject({
      state: "error",
      errorMessage: "boom",
    });
  });

  test("non tool-calls finish reason stops loop", async () => {
    const streamFn = createMockStreamText([{ finishReason: "stop", text: "Done" }, { text: "unused" }]);

    const result = await runQueryLoop(makeOptions(), "Hi");

    expect(result.steps).toBe(0);
    expect(streamFn).toHaveBeenCalledTimes(1);
  });

  test("tool-calls finish reason continues loop and increments steps", async () => {
    const streamFn = createMockStreamText([
      {
        finishReason: "tool-calls",
        chunks: [{ type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: {} }],
      },
      { finishReason: "stop", text: "Final" },
    ]);

    const result = await runQueryLoop(
      makeOptions({ toolRegistry: createTestRegistry(), allowedTools: ["echo"] }),
      "Hi",
    );

    expect(result).toEqual({ text: "Final", steps: 1 });
    expect(streamFn).toHaveBeenCalledTimes(2);
  });

  test("multiple tool-call steps continue until stop", async () => {
    createMockStreamText([
      { finishReason: "tool-calls", chunks: [{ type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: {} }] },
      { finishReason: "tool-calls", chunks: [{ type: "tool-call", toolCallId: "tc-2", toolName: "echo", input: {} }] },
      { finishReason: "stop", text: "Final" },
    ]);

    const result = await runQueryLoop(
      makeOptions({ toolRegistry: createTestRegistry(), allowedTools: ["echo"] }),
      "Hi",
    );

    expect(result.steps).toBe(2);
    expect(result.text).toBe("Final");
  });

  test("maxSteps emits loop-error but run-end completed", async () => {
    const store = createStore();
    createMockStreamText([
      { finishReason: "tool-calls", chunks: [{ type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: {} }] },
      { finishReason: "tool-calls", chunks: [{ type: "tool-call", toolCallId: "tc-2", toolName: "echo", input: {} }] },
    ]);

    const result = await runQueryLoop(
      makeOptions({ store, maxSteps: 2, toolRegistry: createTestRegistry(), allowedTools: ["echo"] }),
      "Hi",
    );

    expect(result.steps).toBe(2);
    expect(store.getState().isRunning).toBe(false);
    expect(store.getState().steps.at(-1)).toMatchObject({
      step: 2,
      error: "Max steps (2) reached",
    });
  });

  test("streamText throw emits failed run-end state", async () => {
    const store = createStore();
    const fn = mock(() => {
      throw new Error("model unavailable");
    });
    __setStreamTextForTest(fn as unknown as typeof aiStreamText);

    const result = await runQueryLoop(makeOptions({ store }), "Hi");

    expect(result).toEqual({ text: "", steps: 0 });
    expect(store.getState().isRunning).toBe(false);
    expect(store.getState().steps.at(-1)).toMatchObject({ step: 0, error: "model unavailable" });
  });

  test("fullStream error is caught and recorded", async () => {
    const store = createStore();
    createMockStreamText([{ fullStreamError: new Error("stream broke") }]);

    await runQueryLoop(makeOptions({ store }), "Hi");

    expect(store.getState().steps[0]).toMatchObject({ step: 0, error: "stream broke" });
  });

  test("usage rejection is caught and recorded", async () => {
    const store = createStore();
    createMockStreamText([
      {
        text: "partial",
        usage: Promise.reject(new Error("usage failed")),
      },
    ]);

    const result = await runQueryLoop(makeOptions({ store }), "Hi");

    expect(result.text).toBe("");
    expect(store.getState().steps[0]).toMatchObject({ step: 0, error: "usage failed" });
  });

  test("passes systemPrompt to streamText", async () => {
    const streamFn = createMockStreamText([{ text: "ok" }]);

    await runQueryLoop(makeOptions({ systemPrompt: "Be helpful" }), "Hi");

    expect(streamFn.mock.calls[0][0]).toMatchObject({ system: "Be helpful" });
  });

  test("omits system option when systemPrompt is empty", async () => {
    const streamFn = createMockStreamText([{ text: "ok" }]);

    await runQueryLoop(makeOptions(), "Hi");
    expect("system" in streamFn.mock.calls[0][0]).toBe(false);
  });

  test("omits tools when registry resolves empty tool set", async () => {
    const noToolsFn = createMockStreamText([{ text: "ok" }]);
    await runQueryLoop(makeOptions(), "Hi");
    expect("tools" in noToolsFn.mock.calls[0][0]).toBe(false);
  });

  test("passes AI tool descriptions without execute when registry resolves tools", async () => {
    const withToolsFn = createMockStreamText([{ text: "ok" }]);
    await runQueryLoop(
      makeOptions({ toolRegistry: createTestRegistry(), allowedTools: ["echo"] }),
      "Hi",
    );

    const tools = withToolsFn.mock.calls[0][0].tools as Record<string, unknown>;
    expect(tools).toEqual({
      echo: {
        description: "Test tool",
        inputSchema: testToolSchema,
      },
    });
    expect("execute" in (tools.echo as Record<string, unknown>)).toBe(false);
  });

  test("excludes disallowed registered tools from streamText tools schema", async () => {
    const streamFn = createMockStreamText([{ text: "ok" }]);
    await runQueryLoop(
      makeOptions({ toolRegistry: createPermissionBranchRegistry(), allowedTools: ["safeTool"] }),
      "Hi",
    );

    const tools = streamFn.mock.calls[0][0].tools as Record<string, unknown>;
    expect(Object.keys(tools)).toEqual(["safeTool"]);
    expect(tools.safeTool).toBeDefined();
    expect(tools.destructiveTool).toBeUndefined();
    expect(tools.sensitiveReadTool).toBeUndefined();
    expect("execute" in (tools.safeTool as Record<string, unknown>)).toBe(false);
  });

  test("registry execute receives tool calls and step context", async () => {
    const store = createStore();
    const contexts: ToolExecutionContext[] = [];
    const registry = createTestRegistry(async (_, ctx) => {
      contexts.push(ctx);
      return "registry output";
    });
    const executeSpy = mock(registry.execute.bind(registry));
    registry.execute = executeSpy;
    createMockStreamText([
      {
        finishReason: "tool-calls",
        chunks: [{ type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: { message: "x" } }],
      },
      { text: "Done" },
    ]);

    await runQueryLoop(makeOptions({ store, toolRegistry: registry, allowedTools: ["echo"] }), "Hi");

    expect(executeSpy.mock.calls[0][0]).toEqual({
      toolCallId: "tc-1",
      toolName: "echo",
      input: { message: "x" },
    });
    expect(contexts[0]).toMatchObject({
      store,
      toolName: "echo",
      toolCallId: "tc-1",
      input: { message: "x" },
      step: 0,
      workspaceRoot: process.cwd(),
    });
    expect([...contexts[0]!.allowedTools]).toEqual(["echo"]);
    expect(assistantMessages(store)[0].parts[0]).toMatchObject({
      state: "completed",
      output: "registry output",
    });
  });

  test("passes allowedTools set to each tool execution context", async () => {
    const contexts: ToolExecutionContext[] = [];
    const registry = createRegistry([
      createTestTool("first", async (_, ctx) => { contexts.push(ctx); return "one"; }),
      createTestTool("second", async (_, ctx) => { contexts.push(ctx); return "two"; }),
    ]);
    createMockStreamText([
      {
        finishReason: "tool-calls",
        chunks: [
          { type: "tool-call", toolCallId: "tc-1", toolName: "first", input: {} },
          { type: "tool-call", toolCallId: "tc-2", toolName: "second", input: {} },
        ],
      },
      { text: "Done" },
    ]);

    await runQueryLoop(
      makeOptions({ toolRegistry: registry, allowedTools: ["first", "second"] }),
      "Hi",
    );

    expect(contexts).toHaveLength(2);
    expect(contexts.map((ctx) => [...ctx.allowedTools])).toEqual([
      ["first", "second"],
      ["first", "second"],
    ]);
    expect(contexts[0]!.allowedTools).toBeInstanceOf(Set);
    expect(contexts[0]!.allowedTools).not.toBe(contexts[1]!.allowedTools);
  });

  test("normalizes duplicate allowedTools names as a set in tool execution context", async () => {
    const contexts: ToolExecutionContext[] = [];
    const registry = createRegistry([
      createTestTool("safeTool", async (_, ctx) => {
        contexts.push(ctx);
        return "safe";
      }),
    ]);
    createMockStreamText([
      {
        finishReason: "tool-calls",
        chunks: [{ type: "tool-call", toolCallId: "tc-safe", toolName: "safeTool", input: {} }],
      },
      { text: "Done" },
    ]);

    await runQueryLoop(
      makeOptions({ toolRegistry: registry, allowedTools: ["safeTool", "safeTool", "safeTool"] }),
      "Use safe tool",
    );

    expect(contexts).toHaveLength(1);
    expect([...contexts[0]!.allowedTools]).toEqual(["safeTool"]);
    expect(assistantMessages(contexts[0]!.store)[0].parts[0]).toMatchObject({
      state: "completed",
      output: "safe",
    });
  });

  test("keeps unknown allowedTools names in execution set while omitting them from AI tools", async () => {
    const contexts: ToolExecutionContext[] = [];
    const streamFn = createMockStreamText([
      {
        finishReason: "tool-calls",
        chunks: [{ type: "tool-call", toolCallId: "tc-safe", toolName: "safeTool", input: {} }],
      },
      { text: "Done" },
    ]);
    const registry = createRegistry([
      createTestTool("safeTool", async (_, ctx) => {
        contexts.push(ctx);
        return "safe";
      }),
    ]);

    await runQueryLoop(
      makeOptions({ toolRegistry: registry, allowedTools: ["safeTool", "missingTool"] }),
      "Use safe tool",
    );

    expect(Object.keys(streamFn.mock.calls[0][0].tools as Record<string, unknown>)).toEqual(["safeTool"]);
    expect([...contexts[0]!.allowedTools]).toEqual(["safeTool", "missingTool"]);
  });

  test("passes provided workspaceRoot to tool execution context", async () => {
    let contextWorkspaceRoot: string | undefined;
    const registry = createTestRegistry(async (_, ctx) => {
      contextWorkspaceRoot = ctx.workspaceRoot;
      return "ok";
    });
    createMockStreamText([
      {
        finishReason: "tool-calls",
        chunks: [{ type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: {} }],
      },
      { text: "Done" },
    ]);

    await runQueryLoop(
      makeOptions({
        toolRegistry: registry,
        allowedTools: ["echo"],
        workspaceRoot: "/canonical/workspace",
      }),
      "Hi",
    );

    expect(contextWorkspaceRoot).toBe("/canonical/workspace");
  });

  test("passes confirmPermission callback to tool execution context", async () => {
    const confirmPermission = mock(async () => "approve" as const);
    let contextConfirmPermission: ToolExecutionContext["confirmPermission"];
    const registry = createTestRegistry(async (_, ctx) => {
      contextConfirmPermission = ctx.confirmPermission;
      return "ok";
    });
    createMockStreamText([
      {
        finishReason: "tool-calls",
        chunks: [{ type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: {} }],
      },
      { text: "Done" },
    ]);

    await runQueryLoop(
      makeOptions({ toolRegistry: registry, allowedTools: ["echo"], confirmPermission }),
      "Hi",
    );

    expect(contextConfirmPermission).toBe(confirmPermission);
  });

  test("tool execution error does not skip remaining tool calls in same step", async () => {
    const store = createStore();
    const registry = createRegistry([
      createTestTool("fail", async () => { throw new Error("boom"); }),
      createTestTool("echo", async () => "ok after failure"),
    ]);
    const executeSpy = mock(registry.execute.bind(registry));
    registry.execute = executeSpy;
    createMockStreamText([
      {
        finishReason: "tool-calls",
        chunks: [
          { type: "tool-call", toolCallId: "tc-1", toolName: "fail", input: {} },
          { type: "tool-call", toolCallId: "tc-2", toolName: "echo", input: {} },
        ],
      },
      { text: "Done" },
    ]);

    await runQueryLoop(
      makeOptions({ store, toolRegistry: registry, allowedTools: ["fail", "echo"] }),
      "Hi",
    );

    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(assistantMessages(store)[0].parts).toEqual([
      expect.objectContaining({ state: "error", errorMessage: "boom" }),
      expect.objectContaining({ state: "completed", output: "ok after failure" }),
    ]);
  });

  test("sequential multi-tool calls with one ask only confirms the guarded tool", async () => {
    const store = createStore();
    const events: string[] = [];
    const registry = createRegistry([
      createNamedTool("askTool", async () => {
        events.push("execute:askTool");
        return "asked output";
      }),
      createNamedTool("openTool", async () => {
        events.push("execute:openTool");
        return "open output";
      }),
    ]);
    const askTool = registry.get("askTool");
    if (!askTool) throw new Error("Expected askTool");
    askTool.guards = [async () => {
      events.push("guard:askTool");
      return { outcome: "ask", reason: "confirm ask tool" };
    }];
    const confirmPermission = mock(async (request) => {
      events.push(`confirm:${request.toolName}`);
      return "approve" as const;
    });
    createMockStreamText([
      {
        finishReason: "tool-calls",
        chunks: [
          { type: "tool-call", toolCallId: "tc-ask", toolName: "askTool", input: {} },
          { type: "tool-call", toolCallId: "tc-open", toolName: "openTool", input: {} },
        ],
      },
      { text: "Done" },
    ]);

    await runQueryLoop(
      makeOptions({
        store,
        toolRegistry: registry,
        allowedTools: ["askTool", "openTool"],
        confirmPermission,
      }),
      "Use tools",
    );

    expect(events).toEqual([
      "guard:askTool",
      "confirm:askTool",
      "execute:askTool",
      "execute:openTool",
    ]);
    expect(confirmPermission).toHaveBeenCalledTimes(1);
    expect(assistantMessages(store)[0].parts).toEqual([
      expect.objectContaining({ state: "completed", toolName: "askTool", output: "asked output" }),
      expect.objectContaining({ state: "completed", toolName: "openTool", output: "open output" }),
    ]);
  });

  test("multi-tool-call response runs sequentially and pauses/resumes around permission asks", async () => {
    const store = createStore();
    const events: string[] = [];
    const registry = createPermissionBranchRegistry(async (name) => {
      events.push(`execute:${name}`);
      return `${name} output`;
    });
    const sensitiveReadTool = registry.get("sensitiveReadTool");
    const destructiveTool = registry.get("destructiveTool");
    if (!sensitiveReadTool || !destructiveTool) throw new Error("Expected mock tools");
    sensitiveReadTool.guards = [async () => {
      events.push("ask:sensitiveReadTool");
      return { outcome: "ask", reason: "confirm sensitive read" };
    }];
    destructiveTool.guards = [async () => {
      events.push("ask:destructiveTool");
      return { outcome: "ask", reason: "confirm destructive tool" };
    }];
    const confirmPermission = mock(async (request) => {
      events.push(`confirm-start:${request.toolName}`);
      await Promise.resolve();
      events.push(`confirm-end:${request.toolName}`);
      return "approve" as const;
    });
    createMockStreamText([
      {
        finishReason: "tool-calls",
        chunks: [
          { type: "tool-call", toolCallId: "tc-safe", toolName: "safeTool", input: {} },
          { type: "tool-call", toolCallId: "tc-sensitive", toolName: "sensitiveReadTool", input: {} },
          { type: "tool-call", toolCallId: "tc-destructive", toolName: "destructiveTool", input: {} },
        ],
      },
      { text: "Done" },
    ]);

    await runQueryLoop(
      makeOptions({
        store,
        toolRegistry: registry,
        allowedTools: ["safeTool", "sensitiveReadTool", "destructiveTool"],
        confirmPermission,
      }),
      "Use tools",
    );

    expect(events).toEqual([
      "execute:safeTool",
      "ask:sensitiveReadTool",
      "confirm-start:sensitiveReadTool",
      "confirm-end:sensitiveReadTool",
      "execute:sensitiveReadTool",
      "ask:destructiveTool",
      "confirm-start:destructiveTool",
      "confirm-end:destructiveTool",
      "execute:destructiveTool",
    ]);
    expect(confirmPermission).toHaveBeenCalledTimes(2);
    expect(assistantMessages(store)[0].parts).toEqual([
      expect.objectContaining({ state: "completed", toolName: "safeTool", output: "safeTool output" }),
      expect.objectContaining({ state: "completed", toolName: "sensitiveReadTool", output: "sensitiveReadTool output" }),
      expect.objectContaining({ state: "completed", toolName: "destructiveTool", output: "destructiveTool output" }),
    ]);
  });

  test("abort signal identity reaches streamText and tool context", async () => {
    const abort = new AbortController().signal;
    let contextAbort: AbortSignal | undefined;
    const registry = createTestRegistry(async (_, ctx) => {
      contextAbort = ctx.abort;
      return "ok";
    });
    const streamFn = createMockStreamText([
      {
        finishReason: "tool-calls",
        chunks: [{ type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: {} }],
      },
      { text: "Done" },
    ]);

    await runQueryLoop(
      makeOptions({ toolRegistry: registry, allowedTools: ["echo"], abort }),
      "Hi",
    );

    expect(streamFn.mock.calls[0][0].abortSignal === abort).toBe(true);
    expect(contextAbort === abort).toBe(true);
  });

  test("tool result stores output and isError without registry meta", async () => {
    const store = createStore();
    const registry = createTestRegistry(async () => "ignored");
    registry.globalHooks.after.push(() => ({
      output: "with metadata",
      isError: false,
      meta: { secret: "do not store" },
    }));
    createMockStreamText([
      {
        finishReason: "tool-calls",
        chunks: [{ type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: {} }],
      },
      { text: "Done" },
    ]);

    await runQueryLoop(makeOptions({ store, toolRegistry: registry, allowedTools: ["echo"] }), "Hi");

    const toolPart = assistantMessages(store)[0].parts[0];
    expect(toolPart).toMatchObject({ state: "completed", output: "with metadata" });
    expect("meta" in (toolPart as unknown as Record<string, unknown>)).toBe(false);
  });

  test("step-end stores finish reason and usage", async () => {
    const store = createStore();
    createMockStreamText([{ text: "ok", finishReason: "length", usage: { totalTokens: 42 } }]);

    await runQueryLoop(makeOptions({ store }), "Hi");
    expect(store.getState().steps[0]).toMatchObject({
      step: 0,
      finishReason: "length",
      usage: { totalTokens: 42 },
      completedAt: expect.any(Number),
    });
  });

  test("preserves __setStreamTextForTest mock pattern", async () => {
    const fn = mock((_: Parameters<typeof aiStreamText>[0]) => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "custom" };
      })(),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve(undefined),
      text: Promise.resolve("custom"),
      toolCalls: Promise.resolve([]),
    }));
    __setStreamTextForTest(fn as unknown as typeof aiStreamText);

    const result = await runQueryLoop(makeOptions(), "Hi");

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("custom");
  });
});
