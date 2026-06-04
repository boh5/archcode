import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ModelMessage } from "ai";
import { z } from "zod";
import type { ModelInfo } from "../../provider/model";
import { SkillService } from "../../skills";
import { silentLogger } from "../../logger";
import { createSessionStore, storeManager } from "../../store/store";
import type { SessionEventPayload, SessionStoreState, StoredMessage } from "../../store/types";
import { createRegistry, defineTool } from "../../tools";
import type { ToolExecutionContext } from "../../tools";
import { createTestProjectContext } from "../../tools/test-project-context";
import { setLlmAdapterForTest } from "../../llm";
import type { QueryLoopOptions } from "./types";
import { runQueryLoop } from "./loop";

type StreamTextFn = typeof import("ai").streamText;

type MockChunk =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-input-start"; id: string; toolName: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown };

interface MockRound {
  chunks?: MockChunk[];
  text?: string;
  finishReason?: string;
  usage?: unknown;
  toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  throwBeforeOutput?: Error;
  fullStreamError?: Error;
  fullStreamFactory?: () => AsyncIterable<MockChunk>;
}

const retryableEof = (message = "stream EOF", retryAfterMs?: number) => retryAfterMs === undefined
  ? new Error(message)
  : Object.assign(new Error(message), { retryAfterMs });

const dummyModelInfo = {
  model: { modelId: "mock-model", provider: "mock-provider" },
  displayName: "Mock Model",
  limit: { context: 1000, output: 100 },
  modalities: { input: ["text"], output: ["text"] },
  providerId: "mock-provider",
  modelId: "mock-model",
  qualifiedId: "mock-provider:mock-model",
} as unknown as ModelInfo;

const testSkillService = new SkillService({ builtinSkills: {} });
const inputSchema = z.object({ message: z.string().optional() }).strict();

function createStore() {
  return createSessionStore(crypto.randomUUID());
}

function makeOptions(overrides: Partial<QueryLoopOptions> = {}): QueryLoopOptions {
  const workspaceRoot = import.meta.dir;
  return {
    modelInfo: dummyModelInfo,
    logger: silentLogger,
    toolRegistry: createRegistry([]),
    store: createStore(),
    allowedTools: [],
    agentSkills: [],
    skillService: testSkillService,
    storeManager,
    projectContext: createTestProjectContext(workspaceRoot),
    workspaceRoot,
    ...overrides,
  };
}

function captureEvents(store: ReturnType<typeof createStore>): SessionEventPayload[] {
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

function createMockStreamText(rounds: MockRound[]) {
  let index = 0;
  const fn = mock((opts: Parameters<StreamTextFn>[0]) => {
    void opts;
    const round = rounds[index++];
    if (!round) throw new Error("No more mock rounds");
    if (round.throwBeforeOutput) throw round.throwBeforeOutput;
    const chunks = round.chunks ?? (round.text ? [{ type: "text-delta" as const, text: round.text }] : []);

    return {
      fullStream: round.fullStreamFactory?.() ?? (async function* () {
        for (const chunk of chunks) yield chunk;
        if (round.fullStreamError) throw round.fullStreamError;
      })(),
      finishReason: Promise.resolve(round.finishReason ?? "stop"),
      usage: Promise.resolve(round.usage ?? { totalTokens: 1 }),
      text: Promise.resolve(round.text ?? collectText(chunks)),
      toolCalls: Promise.resolve(round.toolCalls ?? collectToolCalls(chunks)),
      toolResults: Promise.resolve([]),
    };
  });
  setLlmAdapterForTest({ streamText: fn as unknown as StreamTextFn });
  return fn;
}

function collectText(chunks: MockChunk[]): string {
  return chunks.filter((chunk): chunk is Extract<MockChunk, { type: "text-delta" }> => chunk.type === "text-delta").map((chunk) => chunk.text).join("");
}

function collectToolCalls(chunks: MockChunk[]) {
  return chunks.filter((chunk): chunk is Extract<MockChunk, { type: "tool-call" }> => chunk.type === "tool-call").map((chunk) => ({
    toolCallId: chunk.toolCallId,
    toolName: chunk.toolName,
    input: chunk.input,
  }));
}

function assistantMessages(store: ReturnType<typeof createStore>): StoredMessage[] {
  return store.getState().messages.filter((message) => message.role === "assistant");
}

function streamMessages(fn: ReturnType<typeof createMockStreamText>, callIndex: number): ModelMessage[] {
  const args = fn.mock.calls[callIndex]?.[0];
  if (!args || !("messages" in args)) throw new Error("Expected streamText messages");
  return args.messages as ModelMessage[];
}

function textParts(store: ReturnType<typeof createStore>) {
  return assistantMessages(store).flatMap((message) => message.parts).filter((part) => part.type === "text");
}

beforeEach(() => {
  setLlmAdapterForTest(undefined);
});

describe("query loop LLM stream recovery", () => {
  test("streamText throws before output retries internally and succeeds without chat-visible notice", async () => {
    const store = createStore();
    const events = captureEvents(store);
    const streamFn = createMockStreamText([
      { throwBeforeOutput: retryableEof("socket closed before response") },
      { text: "Recovered answer" },
    ]);

    const result = await runQueryLoop(makeOptions({ store }), "Hi");

    expect(result.text).toBe("Recovered answer");
    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.type === "llm-retry")).toEqual([
      expect.objectContaining({ scope: "short", visibility: "internal", profile: "zero-output-short", attempt: 1 }),
    ]);
    expect(JSON.stringify(store.getState().messages)).not.toContain("recovery-notice");
  });

  test("first-chunk EOF escalates after bounded zero-output retry and avoids duplicate assistant content", async () => {
    const store = createStore();
    const events = captureEvents(store);
    const streamFn = createMockStreamText([
      { fullStreamError: retryableEof("eof-1") },
      { fullStreamError: retryableEof("eof-2") },
      { fullStreamError: retryableEof("eof-3") },
      { fullStreamError: retryableEof("eof-4") },
      { text: "single final" },
    ]);

    const result = await runQueryLoop(makeOptions({ store }), "Recover zero output");

    expect(result.text).toBe("single final");
    expect(streamFn).toHaveBeenCalledTimes(5);
    expect(events.filter((event) => event.type === "llm-retry" && event.visibility === "internal")).toHaveLength(3);
    expect(events).toContainEqual(expect.objectContaining({ type: "llm-retry", scope: "session", visibility: "session", profile: "zero-output-session", attempt: 1 }));
    expect(events).toContainEqual(expect.objectContaining({ type: "llm-recovery", scope: "session", visibility: "session", profile: "zero-output-session" }));
    expect(textParts(store).map((part) => part.text)).toEqual(["single final"]);
  });

  test("mid-text EOF preserves interrupted partial, excludes it from next prompt, and emits recovery UI event", async () => {
    const store = createStore();
    const events = captureEvents(store);
    const streamFn = createMockStreamText([
      { chunks: [{ type: "text-delta", text: "PARTIAL_SHOULD_NOT_REPLAY" }], fullStreamError: retryableEof("EOF truncated body", 0.001) },
      { text: "Recovered continuation" },
    ]);

    await runQueryLoop(makeOptions({ store }), "Question");

    const texts = textParts(store);
    expect(texts[0]).toMatchObject({ text: "PARTIAL_SHOULD_NOT_REPLAY", meta: { interrupted: true, discardedFromContext: true } });
    expect(texts[1]).toMatchObject({ text: "Recovered continuation" });
    expect(JSON.stringify(streamMessages(streamFn, 1))).not.toContain("PARTIAL_SHOULD_NOT_REPLAY");
    expect(JSON.stringify(streamMessages(streamFn, 1))).toContain("previous assistant response was interrupted");
    expect(events).toContainEqual(expect.objectContaining({ type: "llm-retry", visibility: "session", profile: "partial-output-recovery" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "llm-recovery", visibility: "session", profile: "partial-output-recovery" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "text-delta", text: "Recovered continuation" }));
  });

  test("tool-input-start without tool-call before EOF is not executed and transcript is legalized", async () => {
    const store = createStore();
    const executor = mock(async () => "should not run");
    const registry = createRegistry([
      defineTool({
        name: "echo",
        description: "Echo",
        inputSchema,
        traits: { readOnly: true, destructive: false, concurrencySafe: true },
        execute: executor,
      }),
    ]);
    createMockStreamText([
      { chunks: [{ type: "tool-input-start", id: "tc-pending", toolName: "echo" }], fullStreamError: retryableEof("tool input only", 0.001) },
      { text: "Recovered" },
    ]);

    await runQueryLoop(makeOptions({ store, toolRegistry: registry, allowedTools: ["echo"] }), "Use tool");

    expect(executor).not.toHaveBeenCalled();
    const tool = assistantMessages(store).flatMap((message) => message.parts).find((part) => part.type === "tool");
    expect(tool).toMatchObject({ type: "tool", state: "error", errorMessage: "Execution ended before tool result" });
    expect(store.getState().toModelMessages()).toEqual([
      { role: "user", content: "Use tool" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "tc-pending", toolName: "echo", input: undefined }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "tc-pending", toolName: "echo", output: { type: "error-text", value: "Execution ended before tool result" } }] },
    ]);
  });

  test("effectful tool attempt without result becomes unknown-result warning and is not replayed", async () => {
    const store = createStore();
    const executor = mock(async (_input: z.infer<typeof inputSchema>, ctx: ToolExecutionContext) => {
      store.getState().append({ type: "execution-end", status: "interrupted" });
      ctx.abort.dispatchEvent(new Event("abort"));
      return "late result ignored";
    });
    const abort = new AbortController();
    const registry = createRegistry([
      defineTool({
        name: "writeThing",
        description: "Effectful write",
        inputSchema,
        traits: { readOnly: false, destructive: false, concurrencySafe: true },
        execute: executor,
      }),
    ]);
    createMockStreamText([
      { finishReason: "tool-calls", chunks: [{ type: "tool-call", toolCallId: "tc-effect", toolName: "writeThing", input: {} }] },
    ]);

    await runQueryLoop(makeOptions({ store, toolRegistry: registry, allowedTools: ["writeThing"], abort: abort.signal }), "Mutate");

    expect(executor).toHaveBeenCalledTimes(1);
    const tool = assistantMessages(store).flatMap((message) => message.parts).find((part) => part.type === "tool");
    expect(tool).toMatchObject({ type: "tool", state: "error", meta: { unknownResult: true } });
    expect(JSON.stringify(store.getState().toModelMessages())).toContain("Tool execution result unknown");
  });

  test("completed tool result is preserved when later EOF triggers recovery", async () => {
    const store = createStore();
    const registry = createRegistry([
      defineTool({
        name: "writeThing",
        description: "Effectful write",
        inputSchema,
        traits: { readOnly: false, destructive: false, concurrencySafe: true },
        execute: async () => "written once",
      }),
    ]);
    createMockStreamText([
      { finishReason: "tool-calls", chunks: [{ type: "tool-call", toolCallId: "tc-done", toolName: "writeThing", input: {} }] },
      { chunks: [{ type: "text-delta", text: "partial after tool" }], fullStreamError: retryableEof("later eof", 0.001) },
      { text: "Recovered final" },
    ]);

    await runQueryLoop(makeOptions({ store, toolRegistry: registry, allowedTools: ["writeThing"] }), "Mutate then answer");

    const tool = assistantMessages(store).flatMap((message) => message.parts).find((part) => part.type === "tool");
    expect(tool).toMatchObject({ type: "tool", state: "completed", output: "written once" });
    if (tool?.type === "tool" && tool.state === "completed") expect(tool.meta?.unknownResult).toBeUndefined();
  });

  test("abort during session retry backoff cancels quickly", async () => {
    const store = createStore();
    const abort = new AbortController();
    const events = captureEvents(store);
    createMockStreamText([
      { fullStreamError: retryableEof("eof-1") },
      { fullStreamError: retryableEof("eof-2") },
      { fullStreamError: retryableEof("eof-3") },
      { fullStreamError: retryableEof("eof-4") },
    ]);

    const started = Date.now();
    const run = runQueryLoop(makeOptions({ store, abort: abort.signal }), "Abort backoff");
    while (!events.some((event) => event.type === "llm-retry" && event.scope === "session")) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    abort.abort();
    await run;

    expect(Date.now() - started).toBeLessThan(1500);
    expect(store.getState().executions.at(-1)?.status).toBe("aborted");
    expect(events).toContainEqual(expect.objectContaining({
      type: "llm-recovery-failed",
      scope: "session",
      visibility: "session",
      errorKind: "abort",
      message: expect.stringContaining("Recovery failed:"),
    }));
  });

  test("continuous session retry is uncapped while delay is capped and next retry time is emitted", async () => {
    const store = createStore();
    const events = captureEvents(store);
    const rounds: MockRound[] = Array.from({ length: 9 }, (_, index) => ({ fullStreamError: Object.assign(retryableEof(`eof-${index}`), { retryAfterMs: 0.001 }) }));
    rounds.push({ text: "eventually recovered" });
    createMockStreamText(rounds);

    await runQueryLoop(makeOptions({ store }), "Long outage");

    const sessionRetries = events.filter((event) => event.type === "llm-retry" && event.scope === "session");
    expect(sessionRetries).toHaveLength(6);
    expect(sessionRetries.map((event) => event.type === "llm-retry" ? event.attempt : 0)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const event of sessionRetries) {
      expect(event.type).toBe("llm-retry");
      expect((event as Extract<SessionEventPayload, { type: "llm-retry" }>).nextRetryAt).toBeGreaterThan(Date.now() - 1_000);
    }
  });

  test("todo continuation hooks do not advance during recovery attempts and run after recovered completion", async () => {
    const store = createStore();
    const afterStepEnd = mock(async ({ store: ctxStore }: { store: { getState: () => SessionStoreState } }) => {
      ctxStore.getState().append({ type: "reminder", reminder: {
        id: "after-step-reminder",
        source: { type: "todo_step_reminder", pendingTodos: [] },
        delivery: "auto_inject",
        content: "after step",
        createdAt: Date.now(),
        consumedAt: null,
      } });
    });
    const afterLoopEnd = mock(async () => {});
    createMockStreamText([
      { fullStreamError: retryableEof("eof-1") },
      { fullStreamError: retryableEof("eof-2") },
      { chunks: [{ type: "text-delta", text: "partial" }], fullStreamError: retryableEof("partial eof", 0.001) },
      { text: "Recovered" },
    ]);

    await runQueryLoop(makeOptions({ store, hooks: { afterStepEnd: [afterStepEnd], afterLoopEnd: [afterLoopEnd] } }), "Todo recovery");

    expect(afterStepEnd).toHaveBeenCalledTimes(1);
    expect(afterLoopEnd).toHaveBeenCalledTimes(1);
    expect(store.getState().reminders.map((reminder) => reminder.id)).toEqual(["after-step-reminder"]);
  });
});
