import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ModelMessage, streamText as aiStreamText } from "ai";
import type { StoreApi } from "zustand";
import { z } from "zod";
import type { ModelInfo } from "../../provider/model";
import { SkillService } from "../../skills";
import { CommandRegistry } from "../../commands/registry";
import { createSkillCommand } from "../../commands/skill";
import { storeManager } from "../../store/store";
import type { Reminder, ExecutionEndEvent, SessionEventPayload, SessionStoreState, StoredMessage, StoredTodo } from "../../store/types";
import { createRegistry, defineTool } from "../../tools/index";
import { REDACTION_MARKER } from "../../tools/index";
import { createTestProjectContext } from "../../tools/test-project-context";
import type { AskUserCallback, PermissionErrorCode, ToolExecutionContext } from "../../tools/index";
import type { ToolRegistry } from "../../tools/registry";
import { silentLogger } from "../../logger";
import { createMockLogger } from "../../logger.test-helper";
import { createAutoInjectReminderHook } from "./hooks/auto-inject-reminder";
import { __setStreamTextForTest, maybeHandleCommand, runQueryLoop } from "./loop";
import type { BeforeModelBuildContext } from "./loop-hooks";
import { DOOM_LOOP_MESSAGE, type QueryLoopOptions } from "./types";
import { MissingProjectContextError } from "../errors";

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
};

const dummyModelInfo = {
  model: dummyModel,
  displayName: "Mock Model",
  limit: { context: 1000, output: 100 },
  modalities: { input: ["text"], output: ["text"] },
  providerId: "mock-provider",
  modelId: "mock-model",
  qualifiedId: "mock-provider:mock-model",
} as unknown as ModelInfo;

const testToolSchema = z.object({ message: z.string().optional() }).strict();
const testSkillService = new SkillService({ builtinSkills: {} });

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
  const isDestructive = name === "destructiveTool";
  return defineTool({
    name,
    description: `Mock tool: ${name}`,
    inputSchema: testToolSchema,
    traits: {
      readOnly: !isDestructive,
      destructive: isDestructive,
      concurrencySafe: !isDestructive,
    },
    ...(isDestructive ? { permissions: [async () => ({ outcome: "allow" })] } : {}),
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
  return storeManager.create(crypto.randomUUID());
}

function captureEvents(store: StoreApi<SessionStoreState>): SessionEventPayload[] {
  const events: SessionEventPayload[] = [];
  const append = store.getState().append;
  store.setState({
    append: (event) => {
      events.push(event);
      append(event);
    },
  });
  return events;
}

function pendingTodo(id = "todo-1"): StoredTodo {
  return { id, content: `Task ${id}`, status: "pending" };
}

function autoInjectReminder(id = "reminder-1", createdAt = Date.now()): Reminder {
  return {
    id,
    source: { type: "todo_step_reminder", pendingTodos: [pendingTodo()] },
    delivery: "auto_inject",
    content: `Reminder ${id}`,
    createdAt,
    consumedAt: null,
  };
}

function makeOptions(overrides: Partial<QueryLoopOptions> = {}): QueryLoopOptions {
  const workspaceRoot = import.meta.dir;
  return { modelInfo: dummyModelInfo,
  logger: silentLogger,
  toolRegistry: createRegistry(),
  store: createStore(),
  allowedTools: [],
  agentSkills: [],
  skillService: testSkillService,
  storeManager,
  projectContext: createTestProjectContext(workspaceRoot),
  workspaceRoot, ...overrides,  };
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

function streamCallOptions(fn: ReturnType<typeof createMockStreamText>, callIndex: number): Parameters<typeof aiStreamText>[0] {
  const args = fn.mock.calls[callIndex]?.[0];
  if (!args) throw new Error("Expected streamText options");
  return args;
}

beforeEach(() => {
  createMockStreamText([{ text: "default" }]);
});

describe("runQueryLoop store-source-of-truth behavior", () => {
  function toolErrorMessage(store: ReturnType<typeof createStore>, index = 0): string {
    const part = assistantMessages(store)[0].parts[index];
    if (!("errorMessage" in part)) throw new Error("Expected error tool part");
    return String(part.errorMessage);
  }

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
    expect(store.getState().currentExecutionId).toBeUndefined();
  });

  test("sets running flags during streamText after execution-start and step-start", async () => {
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

  test("redacts tool-call input before storing and projecting while execution receives raw input", async () => {
    const store = createStore();
    const rawSecret = "sk_test_1234567890abcdef";
    let executedInput: unknown;
    createMockStreamText([
      {
        finishReason: "tool-calls",
        chunks: [
          { type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: { message: `token=${rawSecret}` } },
        ],
      },
      { text: "Done" },
    ]);

    await runQueryLoop(
      makeOptions({
        store,
        toolRegistry: createTestRegistry(async (input) => {
          executedInput = input;
          return "ok";
        }),
        allowedTools: ["echo"],
      }),
      "Hi",
    );

    expect(executedInput).toEqual({ message: `token=${rawSecret}` });
    const serializedStore = JSON.stringify(store.getState().messages);
    expect(serializedStore).toContain(REDACTION_MARKER);
    expect(serializedStore).not.toContain(rawSecret);
    expect(JSON.stringify(store.getState().toModelMessages())).toContain(REDACTION_MARKER);
    expect(JSON.stringify(store.getState().toModelMessages())).not.toContain(rawSecret);
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

  test("destructive tool records attempt before executor side effects", async () => {
    const store = createStore();
    const events = captureEvents(store);
    const executor = mock(async () => {
      expect(events.some((event) => event.type === "tool-attempt" && event.toolCallId === "tc-1")).toBe(true);
      return "mutated";
    });
    createMockStreamText([
      {
        finishReason: "tool-calls",
        chunks: [{ type: "tool-call", toolCallId: "tc-1", toolName: "destructiveTool", input: {} }],
      },
      { text: "Done" },
    ]);

    await runQueryLoop(
      makeOptions({
        store,
        toolRegistry: createPermissionBranchRegistry(async () => executor()),
        allowedTools: ["destructiveTool"],
      }),
      "Mutate",
    );

    expect(executor).toHaveBeenCalledTimes(1);
    const attempt = events.find((event) => event.type === "tool-attempt");
    expect(attempt).toMatchObject({
      type: "tool-attempt",
      toolCallId: "tc-1",
      toolName: "destructiveTool",
      destructive: true,
    });
    if (!attempt || attempt.type !== "tool-attempt") throw new Error("Expected tool-attempt event");
    expect(typeof attempt.attemptId).toBe("string");
    expect(typeof attempt.timestamp).toBe("number");
  });

  test("read-only tool does not record attempt", async () => {
    const store = createStore();
    const events = captureEvents(store);
    createMockStreamText([
      {
        finishReason: "tool-calls",
        chunks: [{ type: "tool-call", toolCallId: "tc-read", toolName: "echo", input: {} }],
      },
      { text: "Done" },
    ]);

    await runQueryLoop(
      makeOptions({ store, toolRegistry: createTestRegistry(), allowedTools: ["echo"] }),
      "Read",
    );

    expect(events.some((event) => event.type === "tool-attempt")).toBe(false);
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

    const errorMessage = toolErrorMessage(store);
    expect(assistantMessages(store)[0].parts[0]).toMatchObject({
      state: "error",
    });
    expect(errorMessage).toContain('"code":"TOOL_UNKNOWN"');
    expect(errorMessage).toContain('Tool \\"missing\\" is not registered');
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

    const errorMessage = toolErrorMessage(store);
    expect(assistantMessages(store)[0].parts[0]).toMatchObject({
      state: "error",
      toolName: "missingTool",
    });
    expect(errorMessage).toContain('"code":"TOOL_UNKNOWN"');
    expect(errorMessage).toContain('Tool \\"missingTool\\" is not registered');
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
    const errorMessage = toolErrorMessage(store);
    expect(assistantMessages(store)[0].parts[0]).toMatchObject({
      state: "error",
      toolName: "destructiveTool",
    });
    expect(errorMessage).toContain('"code":"TOOL_NOT_ALLOWED"');
    expect(errorMessage).toContain('Tool \\"destructiveTool\\" is not allowed');
  });

  test("permission branch errors store stable messages and skip executor", async () => {
    const cases: Array<{
      code: PermissionErrorCode;
      message: string;
      toolName: "safeTool" | "destructiveTool" | "sensitiveReadTool";
    }> = [
      { code: "TOOL_PERMISSION_DENIED", message: "permission denied sensitive read", toolName: "sensitiveReadTool" },
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
        descriptor.permissions = [async () => ({ outcome: "deny", reason: testCase.message })];
      } else {
        descriptor.permissions = [async () => ({ outcome: "ask", reason: testCase.message })];
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
      const errorMessage = toolErrorMessage(store);
      expect(assistantMessages(store)[0].parts[0]).toMatchObject({
        state: "error",
        toolName: testCase.toolName,
      });
      expect(errorMessage).toContain(`"code":"${testCase.code}"`);
      expect(errorMessage).toContain(testCase.message);
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

    const errorMessage = toolErrorMessage(store);
    expect(assistantMessages(store)[0].parts[0]).toMatchObject({
      state: "error",
    });
    expect(errorMessage).toContain('"code":"TOOL_EXECUTION_FAILED"');
    expect(errorMessage).toContain("boom");
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

  test("third consecutive identical normalized tool call appends doom error and skips execution", async () => {
    const store = createStore();
    const executedInputs: unknown[] = [];
    const registry = createRegistry([
      defineTool({
        name: "echo",
        description: "Canonical input test tool",
        inputSchema: z.object({
          a: z.number(),
          b: z.number(),
          omitted: z.undefined().optional(),
        }).strict(),
        traits: { readOnly: true, destructive: false, concurrencySafe: true },
        execute: async (input) => {
          executedInputs.push(input);
          return "ok";
        },
      }),
    ]);
    createMockStreamText([
      { finishReason: "tool-calls", chunks: [{ type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: { b: 2, a: 1 } }] },
      { finishReason: "tool-calls", chunks: [{ type: "tool-call", toolCallId: "tc-2", toolName: "echo", input: { a: 1, b: 2, omitted: undefined } }] },
      { finishReason: "tool-calls", chunks: [{ type: "tool-call", toolCallId: "tc-3", toolName: "echo", input: { b: 2, a: 1 } }] },
      { text: "Done" },
    ]);

    await runQueryLoop(
      makeOptions({
        store,
        toolRegistry: registry,
        allowedTools: ["echo"],
      }),
      "Hi",
    );

    expect(executedInputs).toEqual([{ b: 2, a: 1 }, { a: 1, b: 2, omitted: undefined }]);
    expect(assistantMessages(store).flatMap((message) => message.parts).filter((part) => part.type === "tool")).toEqual([
      expect.objectContaining({ toolCallId: "tc-1", state: "completed", output: "ok" }),
      expect.objectContaining({ toolCallId: "tc-2", state: "completed", output: "ok" }),
      expect.objectContaining({
        toolCallId: "tc-3",
        toolName: "echo",
        state: "error",
        errorMessage: DOOM_LOOP_MESSAGE,
      }),
    ]);
  });

  test("different inputs, tool names, and non-consecutive repeats do not trigger doom", async () => {
    const store = createStore();
    const executedCalls: string[] = [];
    const variedInputSchema = z.object({ value: z.unknown().optional() }).strict();
    const registry = createRegistry([
      defineTool({
        name: "echo",
        description: "Varied input test tool",
        inputSchema: variedInputSchema,
        traits: { readOnly: true, destructive: false, concurrencySafe: true },
        execute: async (input) => { executedCalls.push(`echo:${JSON.stringify(input.value)}`); return "echo ok"; },
      }),
      defineTool({
        name: "second",
        description: "Second varied input test tool",
        inputSchema: variedInputSchema,
        traits: { readOnly: true, destructive: false, concurrencySafe: true },
        execute: async (input) => { executedCalls.push(`second:${JSON.stringify(input.value)}`); return "second ok"; },
      }),
    ]);
    createMockStreamText([
      { finishReason: "tool-calls", chunks: [{ type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: { value: ["same", 1] } }] },
      { finishReason: "tool-calls", chunks: [{ type: "tool-call", toolCallId: "tc-2", toolName: "echo", input: { value: [1, "same"] } }] },
      { finishReason: "tool-calls", chunks: [{ type: "tool-call", toolCallId: "tc-3", toolName: "echo", input: { value: ["same", 1] } }] },
      { finishReason: "tool-calls", chunks: [{ type: "tool-call", toolCallId: "tc-4", toolName: "second", input: { value: ["same", 1] } }] },
      { finishReason: "tool-calls", chunks: [{ type: "tool-call", toolCallId: "tc-5", toolName: "echo", input: { value: ["same", 1] } }] },
      { text: "Done" },
    ]);

    await runQueryLoop(
      makeOptions({ store, toolRegistry: registry, allowedTools: ["echo", "second"] }),
      "Hi",
    );

    expect(executedCalls).toEqual([
      'echo:["same",1]',
      'echo:[1,"same"]',
      'echo:["same",1]',
      'second:["same",1]',
      'echo:["same",1]',
    ]);
    expect(JSON.stringify(store.getState().messages)).not.toContain(DOOM_LOOP_MESSAGE);
  });

  test("two identical calls followed by different input resets doom tracker", async () => {
    const store = createStore();
    const executedInputs: unknown[] = [];
    createMockStreamText([
      { finishReason: "tool-calls", chunks: [{ type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: { message: "repeat" } }] },
      { finishReason: "tool-calls", chunks: [{ type: "tool-call", toolCallId: "tc-2", toolName: "echo", input: { message: "repeat" } }] },
      { finishReason: "tool-calls", chunks: [{ type: "tool-call", toolCallId: "tc-3", toolName: "echo", input: { message: "reset" } }] },
      { finishReason: "tool-calls", chunks: [{ type: "tool-call", toolCallId: "tc-4", toolName: "echo", input: { message: "repeat" } }] },
      { text: "Done" },
    ]);

    await runQueryLoop(
      makeOptions({
        store,
        toolRegistry: createTestRegistry(async (input) => { executedInputs.push(input); return "ok"; }),
        allowedTools: ["echo"],
      }),
      "Hi",
    );

    expect(executedInputs).toEqual([
      { message: "repeat" },
      { message: "repeat" },
      { message: "reset" },
      { message: "repeat" },
    ]);
    expect(JSON.stringify(store.getState().messages)).not.toContain(DOOM_LOOP_MESSAGE);
  });

  test("three identical calls inside one assistant response doom only the third before partition execution", async () => {
    const store = createStore();
    const executedIds: string[] = [];
    const registry = createTestRegistry(async (_input, ctx) => {
      executedIds.push(ctx.toolCallId);
      return `ok ${ctx.toolCallId}`;
    });
    const executeSpy = mock(registry.execute.bind(registry));
    registry.execute = executeSpy;
    createMockStreamText([
      {
        finishReason: "tool-calls",
        chunks: [
          { type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: { message: "same" } },
          { type: "tool-call", toolCallId: "tc-2", toolName: "echo", input: { message: "same" } },
          { type: "tool-call", toolCallId: "tc-3", toolName: "echo", input: { message: "same" } },
        ],
      },
      { text: "Done" },
    ]);

    const workspaceRoot = import.meta.dir;
    await runQueryLoop(makeOptions({ store, toolRegistry: registry, allowedTools: ["echo"], workspaceRoot }), "Hi");

    expect(executedIds).toEqual(["tc-1", "tc-2"]);
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(assistantMessages(store)[0].parts).toEqual([
      expect.objectContaining({ toolCallId: "tc-1", state: "completed", output: "ok tc-1" }),
      expect.objectContaining({ toolCallId: "tc-2", state: "completed", output: "ok tc-2" }),
      expect.objectContaining({ toolCallId: "tc-3", state: "error", errorMessage: DOOM_LOOP_MESSAGE }),
    ]);
  });

  test("doom tracker is scoped to a single runQueryLoop invocation", async () => {
    const store = createStore();
    const executedIds: string[] = [];
    const registry = createTestRegistry(async (_input, ctx) => {
      executedIds.push(ctx.toolCallId);
      return "ok";
    });
    createMockStreamText([
      { finishReason: "tool-calls", chunks: [{ type: "tool-call", toolCallId: "run1-tc-1", toolName: "echo", input: { message: "same" } }] },
      { finishReason: "tool-calls", chunks: [{ type: "tool-call", toolCallId: "run1-tc-2", toolName: "echo", input: { message: "same" } }] },
      { text: "First done" },
      { finishReason: "tool-calls", chunks: [{ type: "tool-call", toolCallId: "run2-tc-1", toolName: "echo", input: { message: "same" } }] },
      { text: "Second done" },
    ]);

    await runQueryLoop(makeOptions({ store, toolRegistry: registry, allowedTools: ["echo"] }), "First");
    await runQueryLoop(makeOptions({ store, toolRegistry: registry, allowedTools: ["echo"] }), "Second");

    expect(executedIds).toEqual(["run1-tc-1", "run1-tc-2", "run2-tc-1"]);
    expect(JSON.stringify(store.getState().messages)).not.toContain(DOOM_LOOP_MESSAGE);
  });

  test("maxSteps emits loop-error but execution-end completed", async () => {
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

  describe("query loop hooks", () => {
    test("beforeModelCall auto-inject hook adds reminder once then consumes it", async () => {
      const store = createStore();
      store.getState().append({ type: "reminder", reminder: autoInjectReminder("auto-once") });
      const streamFn = createMockStreamText([{ text: "First" }, { text: "Second" }]);

      await runQueryLoop(
        makeOptions({ store, hooks: { beforeModelCall: [createAutoInjectReminderHook()] } }),
        "First question",
      );
      await runQueryLoop(
        makeOptions({ store, hooks: { beforeModelCall: [createAutoInjectReminderHook()] } }),
        "Second question",
      );

      expect(JSON.stringify(streamCallMessages(streamFn, 0))).toContain("Reminder auto-once");
      expect(JSON.stringify(streamCallMessages(streamFn, 1))).not.toContain("Reminder auto-once");
      expect(store.getState().reminders[0].consumedAt).toEqual(expect.any(Number));
    });

    test("hooks execute in registration order", async () => {
      const store = createStore();
      const order: string[] = [];
      createMockStreamText([{ text: "ok" }]);

      await runQueryLoop(
        makeOptions({
          store,
          hooks: {
            beforeModelCall: [async () => { order.push("before-1"); }, async () => { order.push("before-2"); }],
            afterStepEnd: [async () => { order.push("step-1"); }, async () => { order.push("step-2"); }],
            afterLoopEnd: [async () => { order.push("loop-1"); }, async () => { order.push("loop-2"); }],
          },
        }),
        "Hi",
      );

      expect(order).toEqual(["before-1", "before-2", "step-1", "step-2", "loop-1", "loop-2"]);
    });

    test("hook errors are logged and the loop continues", async () => {
      const store = createStore();
      const logger = createMockLogger();
      createMockStreamText([{ text: "Still works" }]);

      const result = await runQueryLoop(
        makeOptions({
          store,
          logger,
          agentName: "test-agent",
          hooks: {
            beforeModelCall: [
              async () => { throw new Error("before failed"); },
              async ({ messages }) => { messages.push({ role: "user", content: "after error" }); },
            ],
          },
        }),
        "Hi",
      );

      expect(result).toEqual({ text: "Still works", steps: 0 });
      expect(logger.warn).toHaveBeenCalledWith("query.loop.hook.failed", {
        error: expect.any(Error),
        context: { sessionId: store.getState().sessionId, agentName: "test-agent" },
        meta: { phase: "beforeModelCall" },
      });
      expect(store.getState().isRunning).toBe(false);
    });

    test("hooks receive correct context", async () => {
      const store = createStore();
      const abortController = new AbortController();
      const contexts: unknown[] = [];
      createMockStreamText([{ text: "ok" }]);

      await runQueryLoop(
        makeOptions({
          store,
          abort: abortController.signal,
          hooks: {
            beforeModelCall: [async (ctx) => { contexts.push(ctx); }],
            afterStepEnd: [async (ctx) => { contexts.push(ctx); }],
            afterLoopEnd: [async (ctx) => { contexts.push(ctx); }],
          },
        }),
        "Hi",
      );

      expect(contexts).toHaveLength(3);
      for (const context of contexts as Array<{ store: unknown; modelInfo: unknown; abort: unknown; logger: unknown }>) {
        expect(context.store).toBe(store);
        expect(context.modelInfo).toBe(dummyModelInfo);
        expect(context.abort).toBe(abortController.signal);
        expect(context.logger).toBe(silentLogger);
      }
      expect("messages" in (contexts[0] as Record<string, unknown>)).toBe(true);
      expect("messages" in (contexts[1] as Record<string, unknown>)).toBe(false);
      expect("messages" in (contexts[2] as Record<string, unknown>)).toBe(false);
    });

    test("ExecutionEndEvent uses max_steps status when step limit is reached", async () => {
      const store = createStore();
      const events = captureEvents(store);
      createMockStreamText([
        { finishReason: "tool-calls", chunks: [{ type: "tool-call", toolCallId: "tc-limit", toolName: "echo", input: {} }] },
      ]);

      await runQueryLoop(
        makeOptions({ store, maxSteps: 1, toolRegistry: createTestRegistry(), allowedTools: ["echo"] }),
        "Hi",
      );

      const runEnd = events.find((event): event is ExecutionEndEvent => event.type === "execution-end");
      expect(runEnd?.status).toBe("max_steps");
    });

    test("beforeModelCall receives mutable messages for the current model call only", async () => {
      const store = createStore();
      const streamFn = createMockStreamText([{ text: "ok" }]);

      await runQueryLoop(
        makeOptions({
          store,
          hooks: {
            beforeModelCall: [
              async ({ messages }) => {
                messages.push({ role: "user", content: "ephemeral reminder" });
              },
            ],
          },
        }),
        "Hi",
      );

      expect(streamCallMessages(streamFn, 0)).toEqual([
        { role: "user", content: "Hi" },
        { role: "user", content: "ephemeral reminder" },
      ]);
      expect(store.getState().messages).toHaveLength(2);
      expect(JSON.stringify(store.getState().messages)).not.toContain("ephemeral reminder");
    });

    test("afterStepEnd sees store changes from the completed step", async () => {
      const store = createStore();
      let stepSnapshot: unknown;
      createMockStreamText([{ text: "Answer", finishReason: "length", usage: { totalTokens: 42 } }]);

      await runQueryLoop(
        makeOptions({
          store,
          hooks: {
            afterStepEnd: [async ({ store: ctxStore }) => { stepSnapshot = ctxStore.getState().steps.at(-1); }],
          },
        }),
        "Hi",
      );

      expect(stepSnapshot).toMatchObject({
        step: 0,
        finishReason: "length",
        usage: { totalTokens: 42 },
        completedAt: expect.any(Number),
      });
    });

    test("afterLoopEnd fires from finally on failure", async () => {
      const store = createStore();
      const statuses: Array<unknown> = [];
      __setStreamTextForTest(mock(() => { throw new Error("model failed"); }) as unknown as typeof aiStreamText);

      const result = await runQueryLoop(
        makeOptions({
          store,
          hooks: {
            afterLoopEnd: [async ({ store: ctxStore }) => { statuses.push(ctxStore.getState().isRunning); }],
          },
        }),
        "Hi",
      );

      expect(result).toEqual({ text: "", steps: 0 });
      expect(statuses).toEqual([false]);
      expect(store.getState().steps.at(-1)).toMatchObject({ step: 0, error: "model failed" });
    });

    test("beforeModelBuild hook is called before toModelMessages", async () => {
      const store = createStore();
      const callOrder: string[] = [];
      createMockStreamText([{ text: "ok" }]);

      await runQueryLoop(
        makeOptions({
          store,
          hooks: {
            beforeModelBuild: [async () => { callOrder.push("beforeModelBuild"); }],
            beforeModelCall: [async () => { callOrder.push("beforeModelCall"); }],
          },
        }),
        "Hi",
      );

      expect(callOrder).toEqual(["beforeModelBuild", "beforeModelCall"]);
    });

    test("beforeModelBuild can modify store state and changes are reflected in projected messages", async () => {
      const store = createStore();
      store.getState().append({ type: "user-message", content: "original" });
      store.getState().append({ type: "execution-end", status: "completed" });

      const streamFn = createMockStreamText([{ text: "ok" }]);

      await runQueryLoop(
        makeOptions({
          store,
          hooks: {
            beforeModelBuild: [
              async ({ store: ctxStore }) => {
                for (const msg of ctxStore.getState().messages) {
                  msg.compacted = true;
                }
                ctxStore.getState().append({
                  type: "compact",
                  summary: "Previous conversation summarized",
                  tailStartId: "synthetic-id",
                });
              },
            ],
          },
        }),
        "New question",
      );

      const projectedMessages = streamCallMessages(streamFn, 0);
      const userContents = projectedMessages
        .filter((m): m is Extract<ModelMessage, { role: "user" }> => m.role === "user")
        .map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content));
      expect(userContents).not.toContain("original");
    });

    test("hook execution order: beforeModelBuild → toModelMessages → beforeModelCall → streamText", async () => {
      const store = createStore();
      const order: string[] = [];
      const streamFn = createMockStreamText([{ text: "ok" }]);

      await runQueryLoop(
        makeOptions({
          store,
          hooks: {
            beforeModelBuild: [async () => { order.push("beforeModelBuild"); }],
            beforeModelCall: [async ({ messages }) => {
              order.push(`beforeModelCall(messages=${messages.length})`);
            }],
          },
        }),
        "Hi",
      );

      expect(streamFn).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["beforeModelBuild", "beforeModelCall(messages=1)"]);
    });

    test("beforeModelBuild receives systemPrompt from options", async () => {
      const store = createStore();
      const receivedSystemPrompt: (string | undefined)[] = [];
      createMockStreamText([{ text: "ok" }]);

      await runQueryLoop(
        makeOptions({
          store,
          systemPrompt: "You are a helpful assistant",
          hooks: {
            beforeModelBuild: [async (ctx) => { receivedSystemPrompt.push(ctx.systemPrompt); }],
          },
        }),
        "Hi",
      );

      expect(receivedSystemPrompt).toEqual(["You are a helpful assistant"]);
    });

    test("beforeModelBuild receives undefined systemPrompt when not provided", async () => {
      const store = createStore();
      const receivedSystemPrompt: (string | undefined)[] = [];
      createMockStreamText([{ text: "ok" }]);

      await runQueryLoop(
        makeOptions({
          store,
          hooks: {
            beforeModelBuild: [async (ctx) => { receivedSystemPrompt.push(ctx.systemPrompt); }],
          },
        }),
        "Hi",
      );

      expect(receivedSystemPrompt).toEqual([undefined]);
    });

    test("hooks receive modelOptions in every loop context", async () => {
      const store = createStore();
      const abortController = new AbortController();
      const modelOptions: QueryLoopOptions["modelOptions"] = { temperature: 0.2, maxOutputTokens: 1024 };
      const contexts: BeforeModelBuildContext[] = [];
      createMockStreamText([{ text: "ok" }]);

      await runQueryLoop(
        makeOptions({
          store,
          abort: abortController.signal,
          modelOptions,
          hooks: {
            beforeModelBuild: [async (ctx) => { contexts.push(ctx); }],
            beforeModelCall: [async (ctx) => { contexts.push(ctx); }],
            afterStepEnd: [async (ctx) => { contexts.push(ctx); }],
            afterLoopEnd: [async (ctx) => { contexts.push(ctx); }],
          },
        }),
        "Hi",
      );

      expect(contexts).toHaveLength(4);
      expect(contexts[0].store).toBe(store);
      expect(contexts[0].modelInfo).toBe(dummyModelInfo);
      expect(contexts.map((ctx) => ctx.modelOptions)).toEqual([
        modelOptions,
        modelOptions,
        modelOptions,
        modelOptions,
      ]);
      expect(contexts[0].abort).toBe(abortController.signal);
      expect("messages" in contexts[0]).toBe(false);
    });

    test("beforeModelBuild hooks execute in registration order", async () => {
      const store = createStore();
      const order: string[] = [];
      createMockStreamText([{ text: "ok" }]);

      await runQueryLoop(
        makeOptions({
          store,
          hooks: {
            beforeModelBuild: [
              async () => { order.push("build-1"); },
              async () => { order.push("build-2"); },
            ],
            beforeModelCall: [async () => { order.push("call-1"); }],
          },
        }),
        "Hi",
      );

      expect(order).toEqual(["build-1", "build-2", "call-1"]);
    });

    test("beforeModelBuild hook errors are logged and loop continues", async () => {
      const store = createStore();
      const logger = createMockLogger();
      createMockStreamText([{ text: "Still works" }]);

      const result = await runQueryLoop(
        makeOptions({
          store,
          logger,
          hooks: {
            beforeModelBuild: [async () => { throw new Error("build hook failed"); }],
          },
        }),
        "Hi",
      );

      expect(result).toEqual({ text: "Still works", steps: 0 });
      expect(logger.warn).toHaveBeenCalledWith("query.loop.hook.failed", {
        error: expect.any(Error),
        context: { sessionId: store.getState().sessionId, agentName: undefined },
        meta: { phase: "beforeModelBuild" },
      });
      expect(store.getState().isRunning).toBe(false);
    });

    test("AbortError hook failures propagate without warning logs", async () => {
      const logger = createMockLogger();
      createMockStreamText([{ text: "ok" }]);

      await expect(runQueryLoop(
        makeOptions({
          logger,
          hooks: {
            afterLoopEnd: [async () => { throw new DOMException("cancelled", "AbortError"); }],
          },
        }),
        "Hi",
      )).rejects.toMatchObject({ name: "AbortError" });

      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  test("streamText throw emits failed execution-end state", async () => {
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

  test("passes configured model call options to streamText without variant", async () => {
    const streamFn = createMockStreamText([{ text: "ok" }]);
    const providerOptions = { openai: { reasoningEffort: "low" } };

    await runQueryLoop(
      makeOptions({
        modelOptions: {
          temperature: 0.2,
          topP: 0.8,
          maxOutputTokens: 2048,
          providerOptions,
          variant: "fast",
        } as unknown as QueryLoopOptions["modelOptions"],
      }),
      "Hi",
    );

    const options = streamCallOptions(streamFn, 0) as Record<string, unknown>;
    expect(options.temperature).toBe(0.2);
    expect(options.topP).toBe(0.8);
    expect(options.maxOutputTokens).toBe(2048);
    expect(options.providerOptions).toBe(providerOptions);
    expect(options).not.toHaveProperty("variant");
  });

  test("passes all whitelisted model call options exactly to streamText", async () => {
    const streamFn = createMockStreamText([{ text: "ok" }]);
    const providerOptions = { provider: { mode: "strict" } };

    await runQueryLoop(
      makeOptions({
        modelOptions: {
          maxOutputTokens: 512,
          temperature: 0.4,
          topP: 0.6,
          topK: 32,
          presencePenalty: -0.1,
          frequencyPenalty: 0.2,
          stopSequences: ["STOP"],
          seed: 99,
          maxRetries: 4,
          timeout: 10_000,
          providerOptions,
          variant: "never-forward",
        } as unknown as QueryLoopOptions["modelOptions"],
      }),
      "Hi",
    );

    const options = streamCallOptions(streamFn, 0) as Record<string, unknown>;
    const pickedOptions = {
      maxOutputTokens: options.maxOutputTokens,
      temperature: options.temperature,
      topP: options.topP,
      topK: options.topK,
      presencePenalty: options.presencePenalty,
      frequencyPenalty: options.frequencyPenalty,
      stopSequences: options.stopSequences,
      seed: options.seed,
      maxRetries: options.maxRetries,
      timeout: options.timeout,
      providerOptions: options.providerOptions,
    };
    expect(pickedOptions).toEqual({
      maxOutputTokens: 512,
      temperature: 0.4,
      topP: 0.6,
      topK: 32,
      presencePenalty: -0.1,
      frequencyPenalty: 0.2,
      stopSequences: ["STOP"],
      seed: 99,
      maxRetries: 4,
      timeout: 10_000,
      providerOptions,
    });
    expect(options).not.toHaveProperty("variant");
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

    const workspaceRoot = import.meta.dir;
    await runQueryLoop(
      makeOptions({ store, toolRegistry: registry, allowedTools: ["echo"], workspaceRoot }),
      "Hi",
    );

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
      workspaceRoot,
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

  test("returns MissingProjectContextError when tool execution lacks workspaceRoot", async () => {
    const store = createStore();
    const projectContext = createTestProjectContext("/canonical/workspace");
    Object.defineProperty(projectContext.project, "workspaceRoot", {
      configurable: true,
      value: undefined,
    });
    createMockStreamText([
      {
        finishReason: "tool-calls",
        chunks: [{ type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: {} }],
      },
    ]);

    await runQueryLoop(
      makeOptions({
        store,
        toolRegistry: createTestRegistry(),
        allowedTools: ["echo"],
        projectContext,
        workspaceRoot: undefined,
      }),
      "Hi",
    );

    expect(store.getState().steps[0]).toMatchObject({
      error: new MissingProjectContextError("Query loop requires options.workspaceRoot before executing tools").message,
    });
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

  test("passes askUser callback to tool execution context", async () => {
    const askUser = mock(async () => ({ answers: [["yes"]] }) as { answers: string[][] }) as AskUserCallback;
    let contextAskUser: ToolExecutionContext["askUser"];
    const registry = createTestRegistry(async (_, ctx) => {
      contextAskUser = ctx.askUser;
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
      makeOptions({ toolRegistry: registry, allowedTools: ["echo"], askUser }),
      "Hi",
    );

    expect(contextAskUser).toBe(askUser);
  });

  test("askUser is undefined in context when not provided", async () => {
    let contextAskUser: ToolExecutionContext["askUser"];
    const registry = createTestRegistry(async (_, ctx) => {
      contextAskUser = ctx.askUser;
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
      makeOptions({ toolRegistry: registry, allowedTools: ["echo"] }),
      "Hi",
    );

    expect(contextAskUser).toBeUndefined();
  });

  test("redacts ToolConfirmationRequest input before callback observes it", async () => {
    const rawSecret = "sk_test_1234567890abcdef";
    const registry = createTestRegistry(async () => "ok");
    const tool = registry.get("echo");
    if (!tool) throw new Error("Expected echo tool");
    tool.permissions = [async () => ({ outcome: "ask", reason: `confirm token=${rawSecret}` })];
    const confirmPermission = mock(async (request) => {
      expect(JSON.stringify(request)).toContain(REDACTION_MARKER);
      expect(JSON.stringify(request)).not.toContain(rawSecret);
      return "approve" as const;
    });
    createMockStreamText([
      {
        finishReason: "tool-calls",
        chunks: [{ type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: { message: `token=${rawSecret}` } }],
      },
      { text: "Done" },
    ]);

    await runQueryLoop(
      makeOptions({ toolRegistry: registry, allowedTools: ["echo"], confirmPermission }),
      "Hi",
    );

    expect(confirmPermission).toHaveBeenCalledTimes(1);
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
      expect.objectContaining({ state: "error", errorMessage: expect.stringContaining("boom") }),
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
    askTool.permissions = [async () => {
      events.push("perm:askTool");
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

    // With parallel execution, openTool (no permissions) runs while askTool awaits
    // confirmation, so openTool executes before askTool.
    expect(events).toEqual([
      "perm:askTool",
      "execute:openTool",
      "confirm:askTool",
      "execute:askTool",
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
    sensitiveReadTool.permissions = [async () => {
      events.push("ask:sensitiveReadTool");
      return { outcome: "ask", reason: "confirm sensitive read" };
    }];
    destructiveTool.permissions = [async () => {
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

    // With parallel execution of concurrencySafe tools (safeTool
    // and sensitiveReadTool), sensitiveReadTool's permission fires during the
    // synchronous phase before safeTool's execute microtask. Confirm/execute
    // ordering within each tool remains intact. destructiveTool is serial.
    expect(events).toEqual([
      "ask:sensitiveReadTool",
      "execute:safeTool",
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

  test("tool result stores output and isError with registry meta", async () => {
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
    if (toolPart.type === "tool" && toolPart.state === "completed") {
      expect(toolPart.meta).toEqual({ secret: "do not store" });
    }
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

describe("runQueryLoop slash commands", () => {
  test("maybeHandleCommand returns rewritten user message for command continuation", async () => {
    const store = createStore();
    const commandRegistry = new CommandRegistry();
    commandRegistry.register({
      name: "skill",
      description: "Skill continuation",
      handler: mock(async () => ({
        success: true,
        message: "Activating skill",
        continueAsMessage: "Use Skill continuation",
      })),
    });

    const result = await maybeHandleCommand(
      makeOptions({ store, commandRegistry }),
      "/skill use git-master commit changes",
      new AbortController().signal,
    );

    expect(result).toEqual({ handled: false, userMessage: "Use Skill continuation" });
    expect(store.getState().messages[0]!.parts[0]).toMatchObject({
      type: "system-notice",
      notice: "Activating skill",
    });
  });

  test("maybeHandleCommand rewrites real /skill use command to require skill_read", async () => {
    const store = createStore();
    const commandRegistry = new CommandRegistry();
    const skillService = new SkillService({
      builtinSkills: {
        "git-master": "---\nname: git-master\ndescription: Git operations expertise\nwhen_to_use: Use for git operations.\n---\n\nFull git body",
      },
    });
    commandRegistry.register(createSkillCommand(skillService, import.meta.dir, "orchestrator", ["git-master"]));

    const result = await maybeHandleCommand(
      makeOptions({ store, commandRegistry, skillService, agentName: "orchestrator", agentSkills: ["git-master"] }),
      "/skill use git-master do something",
      new AbortController().signal,
    );

    expect(result.handled).toBe(false);
    expect(result.userMessage).toContain("skill_read");
    expect(result.userMessage).toContain('{"name":"git-master"}');
    expect(result.userMessage).toContain("do something");
  });

  test("command continuation is appended as user message and sent to model", async () => {
    const streamFn = createMockStreamText([{ text: "continued answer" }]);
    const store = createStore();
    const commandRegistry = new CommandRegistry();
    commandRegistry.register({
      name: "skill",
      description: "Skill continuation",
      handler: mock(async () => ({
        success: true,
        message: "Activating skill",
        continueAsMessage: "Use Skill git-master now",
      })),
    });

    const result = await runQueryLoop(makeOptions({ store, commandRegistry }), "/skill use git-master");

    expect(result).toEqual({ text: "continued answer", steps: 0 });
    expect(streamCallMessages(streamFn, 0)).toEqual([
      { role: "user", content: "Use Skill git-master now" },
    ]);
    expect(store.getState().messages[0]!.parts[0]).toMatchObject({
      type: "system-notice",
      notice: "Activating skill",
    });
    expect(store.getState().messages[1]!.parts[0]).toMatchObject({
      type: "text",
      text: "Use Skill git-master now",
    });
  });

  test("real /skill use continuation is appended through query loop and sent to model", async () => {
    const streamFn = createMockStreamText([{ text: "continued answer" }]);
    const store = createStore();
    const commandRegistry = new CommandRegistry();
    const skillService = new SkillService({
      builtinSkills: {
        "git-master": "---\nname: git-master\ndescription: Git operations expertise\nwhen_to_use: Use for git operations.\n---\n\nFull git body",
      },
    });
    commandRegistry.register(createSkillCommand(skillService, import.meta.dir, "orchestrator", ["git-master"]));

    const result = await runQueryLoop(
      makeOptions({ store, commandRegistry, skillService, agentName: "orchestrator", agentSkills: ["git-master"] }),
      "/skill use git-master do something",
    );

    expect(result).toEqual({ text: "continued answer", steps: 0 });
    expect(streamCallMessages(streamFn, 0)).toEqual([
      {
        role: "user",
        content: expect.stringContaining("skill_read"),
      },
    ]);
    expect(streamCallMessages(streamFn, 0)[0]!.content).toContain("do something");
  });

  test("exact /compact handles command, stores system notice, and skips model call", async () => {
    const streamFn = createMockStreamText([{ text: "should not run" }]);
    const store = createStore();
    const commandRegistry = new CommandRegistry();
    commandRegistry.register({
      name: "compact",
      description: "Compact context",
      handler: mock(async () => ({ success: true, message: "Context compacted" })),
    });

    const result = await runQueryLoop(makeOptions({ store, commandRegistry }), "/compact");

    expect(result).toEqual({ text: "", steps: 0 });
    expect(streamFn).not.toHaveBeenCalled();
    expect(store.getState().messages).toHaveLength(1);
    expect(store.getState().messages[0]!.parts[0]).toMatchObject({
      type: "system-notice",
      notice: "Context compacted",
    });
    expect(store.getState().toModelMessages()).toEqual([]);
  });

  test("/compact with trailing whitespace still triggers command", async () => {
    const store = createStore();
    const handler = mock(async () => ({ success: true, message: "trimmed compact" }));
    const commandRegistry = new CommandRegistry();
    commandRegistry.register({ name: "compact", description: "Compact context", handler });

    await runQueryLoop(makeOptions({ store, commandRegistry }), "/compact  ");

    expect(handler).toHaveBeenCalledTimes(1);
    expect(store.getState().messages[0]!.parts[0]).toMatchObject({
      type: "system-notice",
      notice: "trimmed compact",
    });
  });

  test("/compact with args is normal user input and is sent to model", async () => {
    const streamFn = createMockStreamText([{ text: "normal answer" }]);
    const store = createStore();
    const handler = mock(async () => ({ success: true, message: "should not run" }));
    const commandRegistry = new CommandRegistry();
    commandRegistry.register({ name: "compact", description: "Compact context", handler });

    const result = await runQueryLoop(makeOptions({ store, commandRegistry }), "/compact now");

    expect(result).toEqual({ text: "normal answer", steps: 0 });
    expect(handler).not.toHaveBeenCalled();
    expect(streamCallMessages(streamFn, 0)).toEqual([{ role: "user", content: "/compact now" }]);
  });

  test("unknown slash command stores system notice and skips model call", async () => {
    const streamFn = createMockStreamText([{ text: "should not run" }]);
    const store = createStore();
    const commandRegistry = new CommandRegistry();

    const result = await runQueryLoop(makeOptions({ store, commandRegistry }), "/unknown");

    expect(result).toEqual({ text: "", steps: 0 });
    expect(streamFn).not.toHaveBeenCalled();
    expect(store.getState().messages[0]!.parts[0]).toMatchObject({
      type: "system-notice",
      notice: "Unknown command: /unknown",
    });
    expect(store.getState().toModelMessages()).toEqual([]);
  });
});

describe("runQueryLoop abort handling", () => {
  test("abort before loop starts emits aborted execution-end", async () => {
    const abortController = new AbortController();
    abortController.abort();
    const store = createStore();
    const events = captureEvents(store);
    createMockStreamText([{ text: "should not appear" }]);

    const result = await runQueryLoop(makeOptions({ store, abort: abortController.signal }), "Hi");

    expect(result.steps).toBe(0);
    const runEnd = events.find((event): event is ExecutionEndEvent => event.type === "execution-end");
    expect(runEnd?.status).toBe("aborted");
  });

  test("abort during stream breaks out and emits aborted execution-end", async () => {
    const abortController = new AbortController();
    const store = createStore();
    const events = captureEvents(store);
    createMockStreamText([{ text: "partial" }]);

    setTimeout(() => abortController.abort(), 0);

    const result = await runQueryLoop(makeOptions({ store, abort: abortController.signal }), "Hi");

    expect(result.steps).toBeLessThanOrEqual(1);
    const runEnd = events.find((event): event is ExecutionEndEvent => event.type === "execution-end");
    expect(runEnd).toBeDefined();
  });

  test("abort after tool calls emits Aborted result for remaining tools", async () => {
    const abortController = new AbortController();
    const store = createStore();
    const events = captureEvents(store);
    const registry = createTestRegistry(async () => "ok");
    createMockStreamText([
      {
        finishReason: "tool-calls",
        chunks: [
          { type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: {} },
          { type: "tool-call", toolCallId: "tc-2", toolName: "echo", input: {} },
        ],
      },
      { text: "done" },
    ]);

    abortController.abort();

    const result = await runQueryLoop(
      makeOptions({ store, toolRegistry: registry, allowedTools: ["echo"], abort: abortController.signal }),
      "Hi",
    );

    expect(result.steps).toBeLessThanOrEqual(1);
    const runEnd = events.find((event): event is ExecutionEndEvent => event.type === "execution-end");
    expect(runEnd?.status).toBe("aborted");
  });

  test("abort between stream end and tool execution emits aborted execution-end", async () => {
    const abortController = new AbortController();
    const store = createStore();
    const events = captureEvents(store);
    const registry = createTestRegistry(async () => "ok");
    createMockStreamText([
      {
        finishReason: "tool-calls",
        chunks: [{ type: "tool-call", toolCallId: "tc-1", toolName: "echo", input: {} }],
      },
      { text: "after" },
    ]);

    abortController.abort();

    await runQueryLoop(
      makeOptions({ store, toolRegistry: registry, allowedTools: ["echo"], abort: abortController.signal }),
      "Hi",
    );

    const runEnd = events.find((event): event is ExecutionEndEvent => event.type === "execution-end");
    expect(runEnd?.status).toBe("aborted");
  });
});

describe("runQueryLoop tool-input-resolved event", () => {
  beforeEach(() => {
    __setStreamTextForTest(undefined as unknown as typeof aiStreamText);
  });

  const defaultsToolSchema = z.object({
    name: z.string(),
    enabled: z.boolean().default(false),
    count: z.number().int().default(10),
  }).strict();

  function createDefaultToolRegistry(): ToolRegistry {
    return createRegistry([
      defineTool({
        name: "with_defaults",
        description: "Tool with defaults",
        inputSchema: defaultsToolSchema,
        traits: { readOnly: true, destructive: false, concurrencySafe: true },
        execute: async () => "ok",
      }),
    ]);
  }

  test("emits tool-input-resolved event with Zod defaults filled in", async () => {
    const store = createStore();
    const events = captureEvents(store);
    createMockStreamText([
      {
        finishReason: "tool-calls",
        chunks: [
          { type: "tool-call", toolCallId: "tc-1", toolName: "with_defaults", input: { name: "test" } },
        ],
      },
      { text: "Done" },
    ]);

    await runQueryLoop(
      makeOptions({ store, toolRegistry: createDefaultToolRegistry(), allowedTools: ["with_defaults"] }),
      "Hi",
    );

    const resolvedEvent = events.find(
      (e): e is Extract<SessionEventPayload, { type: "tool-input-resolved" }> => e.type === "tool-input-resolved",
    );
    expect(resolvedEvent).toBeDefined();
    expect(resolvedEvent!.toolCallId).toBe("tc-1");
    expect(resolvedEvent!.toolName).toBe("with_defaults");
    const input = resolvedEvent!.input as Record<string, unknown>;
    expect(input.name).toBe("test");
    expect(input.enabled).toBe(false);
    expect(input.count).toBe(10);
  });

  test("tool part input is updated with resolved defaults after tool-input-resolved", async () => {
    const store = createStore();
    createMockStreamText([
      {
        finishReason: "tool-calls",
        chunks: [
          { type: "tool-input-start", id: "tc-1", toolName: "with_defaults" },
          { type: "tool-call", toolCallId: "tc-1", toolName: "with_defaults", input: { name: "test" } },
        ],
      },
      { text: "Done" },
    ]);

    await runQueryLoop(
      makeOptions({ store, toolRegistry: createDefaultToolRegistry(), allowedTools: ["with_defaults"] }),
      "Hi",
    );

    const msg = assistantMessages(store)[0];
    const toolPart = msg.parts.find((p): p is Extract<typeof p, { type: "tool"; state: "running" }> => p.type === "tool" && "input" in p);
    expect(toolPart).toBeDefined();
    expect((toolPart!.input as Record<string, unknown>)).toMatchObject({
      name: "test",
      enabled: false,
      count: 10,
    });
  });

  test("tool-input-resolved is emitted even when LLM sends all fields explicitly", async () => {
    const store = createStore();
    const events = captureEvents(store);
    createMockStreamText([
      {
        finishReason: "tool-calls",
        chunks: [
          { type: "tool-call", toolCallId: "tc-1", toolName: "with_defaults", input: { name: "explicit", enabled: true, count: 42 } },
        ],
      },
      { text: "Done" },
    ]);

    await runQueryLoop(
      makeOptions({ store, toolRegistry: createDefaultToolRegistry(), allowedTools: ["with_defaults"] }),
      "Hi",
    );

    const resolvedEvent = events.find(
      (e): e is Extract<SessionEventPayload, { type: "tool-input-resolved" }> => e.type === "tool-input-resolved",
    );
    expect(resolvedEvent).toBeDefined();
    const input = resolvedEvent!.input as Record<string, unknown>;
    expect(input.name).toBe("explicit");
    expect(input.enabled).toBe(true);
    expect(input.count).toBe(42);
  });
});
