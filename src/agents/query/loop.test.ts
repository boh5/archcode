import { describe, expect, test, mock } from "bun:test";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { tool } from "ai";
import { randomUUID } from "node:crypto";
import { runQueryLoop, __setStreamTextForTest } from "./loop";
import { createSessionStore } from "../../store/store";
import type { QueryLoopOptions } from "./types";

interface MockRound {
  finishReason: string;
  text?: string;
  toolCalls?: Array<{
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
  }>;
}

function setupMockStreamText(rounds: MockRound[]) {
  let roundIndex = 0;

  const fn = mock((_opts: Record<string, unknown>) => {
    const round = rounds[roundIndex++];
    if (!round) throw new Error("No more mock rounds");

    const chunks: Array<Record<string, unknown>> = [];
    if (round.text) {
      chunks.push({ type: "text-delta", text: round.text });
    }
    if (round.toolCalls) {
      for (const tc of round.toolCalls) {
        chunks.push({
          type: "tool-call",
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.input,
        });
      }
    }

    const responseMessages: ModelMessage[] = [];
    {
      const content: Array<Record<string, unknown>> = [];
      if (round.text) content.push({ type: "text", text: round.text });
      if (round.toolCalls) {
        for (const tc of round.toolCalls) {
          content.push({
            type: "tool-call",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: tc.input,
          });
        }
      }
      responseMessages.push({
        role: "assistant",
        content,
      } as unknown as ModelMessage);
    }

    return {
      fullStream: (async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      })(),
      response: Promise.resolve({ messages: responseMessages }),
      finishReason: round.finishReason,
      text: round.text ?? "",
      toolCalls:
        round.toolCalls?.map((tc) => ({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.input,
        })) ?? [],
    };
  });

  __setStreamTextForTest(fn as unknown as typeof import("ai").streamText);
  return fn;
}

const DUMMY_MODEL = { modelId: "mock", provider: "mock" } as unknown as import("@ai-sdk/provider").LanguageModelV3;

function makeOptions(overrides: Partial<QueryLoopOptions> = {}): QueryLoopOptions {
  return {
    model: DUMMY_MODEL,
    tools: {},
    toolExecutors: {},
    store: createSessionStore(randomUUID()),
    ...overrides,
  };
}

describe("runQueryLoop", () => {
  const baseTool = tool({
    description: "A test tool",
    inputSchema: z.object({ message: z.string() }),
  });

  test("returns text directly when LLM responds without tool calls", async () => {
    const streamFn = setupMockStreamText([
      { finishReason: "stop", text: "Hello from LLM" },
    ]);

    const result = await runQueryLoop(makeOptions(), "Hi");

    expect(result.text).toBe("Hello from LLM");
    expect(result.steps).toBe(0);
    expect(streamFn).toHaveBeenCalledTimes(1);
  });

  test("executes tool and feeds result back to LLM", async () => {
    const executor = mock(async (input: unknown) => {
      return `echo: ${(input as { message: string }).message}`;
    });

    const streamFn = setupMockStreamText([
      {
        finishReason: "tool-calls",
        text: "Let me check that.",
        toolCalls: [
          { toolCallId: "tc-1", toolName: "echo", input: { message: "hello" } },
        ],
      },
      { finishReason: "stop", text: "Done" },
    ]);

    const result = await runQueryLoop(
      makeOptions({
        tools: { echo: baseTool },
        toolExecutors: { echo: executor },
      }),
      "Say hello",
    );

    expect(result.text).toBe("Done");
    expect(result.steps).toBe(1);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledWith({ message: "hello" });
    expect(streamFn).toHaveBeenCalledTimes(2);
  });

  test("handles multiple tool calls in a single round", async () => {
    const executorA = mock(async (input: unknown) => `A: ${(input as { message: string }).message}`);
    const executorB = mock(async (input: unknown) => `B: ${(input as { message: string }).message}`);

    const streamFn = setupMockStreamText([
      {
        finishReason: "tool-calls",
        toolCalls: [
          { toolCallId: "tc-1", toolName: "toolA", input: { message: "a" } },
          { toolCallId: "tc-2", toolName: "toolB", input: { message: "b" } },
        ],
      },
      { finishReason: "stop", text: "All done" },
    ]);

    const result = await runQueryLoop(
      makeOptions({
        tools: { toolA: baseTool, toolB: baseTool },
        toolExecutors: { toolA: executorA, toolB: executorB },
      }),
      "test",
    );

    expect(result.text).toBe("All done");
    expect(result.steps).toBe(1);
    expect(executorA).toHaveBeenCalledTimes(1);
    expect(executorB).toHaveBeenCalledTimes(1);
  });

  test("handles multi-step tool call loops", async () => {
    const executor = mock(async (input: unknown) => `step: ${(input as { message: string }).message}`);

    const streamFn = setupMockStreamText([
      {
        finishReason: "tool-calls",
        toolCalls: [
          { toolCallId: "tc-1", toolName: "echo", input: { message: "first" } },
        ],
      },
      {
        finishReason: "tool-calls",
        toolCalls: [
          { toolCallId: "tc-2", toolName: "echo", input: { message: "second" } },
        ],
      },
      { finishReason: "stop", text: "Final answer" },
    ]);

    const result = await runQueryLoop(
      makeOptions({
        tools: { echo: baseTool },
        toolExecutors: { echo: executor },
      }),
      "Multi-step test",
    );

    expect(result.text).toBe("Final answer");
    expect(result.steps).toBe(2);
    expect(executor).toHaveBeenCalledTimes(2);
    expect(streamFn).toHaveBeenCalledTimes(3);
  });

  test("respects maxSteps and stops early", async () => {
    const executor = mock(async () => "result");

    const rounds: MockRound[] = [];
    for (let i = 0; i < 100; i++) {
      rounds.push({
        finishReason: "tool-calls",
        toolCalls: [
          { toolCallId: `tc-${i}`, toolName: "echo", input: { message: "loop" } },
        ],
      });
    }

    setupMockStreamText(rounds);

    const result = await runQueryLoop(
      makeOptions({
        tools: { echo: baseTool },
        toolExecutors: { echo: executor },
        maxSteps: 3,
      }),
      "test",
    );

    expect(result.steps).toBe(3);
  });

  test("accumulates message history correctly", async () => {
    const executor = mock(async (input: unknown) => `result: ${(input as { message: string }).message}`);

    setupMockStreamText([
      {
        finishReason: "tool-calls",
        text: "Calling tool",
        toolCalls: [
          { toolCallId: "tc-1", toolName: "echo", input: { message: "ping" } },
        ],
      },
      { finishReason: "stop", text: "Done" },
    ]);

    const result = await runQueryLoop(
      makeOptions({
        tools: { echo: baseTool },
        toolExecutors: { echo: executor },
      }),
      "test",
    );

    expect(result.messages[0].role).toBe("user");
    expect(result.messages.length).toBeGreaterThanOrEqual(3);
  });

  test("passes system prompt via streamText options", async () => {
    const streamFn = setupMockStreamText([
      { finishReason: "stop", text: "ok" },
    ]);

    await runQueryLoop(
      makeOptions({ systemPrompt: "You are a helpful assistant." }),
      "test",
    );

    expect(streamFn).toHaveBeenCalledTimes(1);
    const callArgs = streamFn.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.system).toBe("You are a helpful assistant.");
  });

  test("works with no tools defined", async () => {
    setupMockStreamText([
      { finishReason: "stop", text: "No tools needed" },
    ]);

    const result = await runQueryLoop(makeOptions(), "Simple question");

    expect(result.text).toBe("No tools needed");
    expect(result.steps).toBe(0);
  });

  test("passes user message as first message in history", async () => {
    const streamFn = setupMockStreamText([
      { finishReason: "stop", text: "ok" },
    ]);

    await runQueryLoop(makeOptions(), "Hello world");

    const callArgs = streamFn.mock.calls[0][0] as Record<string, unknown>;
    const messages = callArgs.messages as ModelMessage[];
    expect(messages[0]).toEqual({ role: "user", content: "Hello world" });
  });

  test("records text-delta events in store", async () => {
    setupMockStreamText([
      { finishReason: "stop", text: "Hello" },
    ]);

    const store = createSessionStore(randomUUID());
    await runQueryLoop(makeOptions({ store }), "test");

    const events = store.getState().events;
    const textDeltas = events.filter((e) => e.type === "text-delta");
    expect(textDeltas.length).toBeGreaterThan(0);
    expect(textDeltas.some((e) => e.type === "text-delta" && e.text.includes("Hello"))).toBe(true);
  });

  test("records user-message event in store", async () => {
    setupMockStreamText([
      { finishReason: "stop", text: "ok" },
    ]);

    const store = createSessionStore(randomUUID());
    await runQueryLoop(makeOptions({ store }), "My question");

    const events = store.getState().events;
    const userMsg = events.find((e) => e.type === "user-message");
    expect(userMsg).toBeDefined();
    if (userMsg && userMsg.type === "user-message") {
      expect(userMsg.content).toBe("My question");
    }
  });

  test("records tool-call and tool-result events in store", async () => {
    const executor = mock(async () => "file contents");

    setupMockStreamText([
      {
        finishReason: "tool-calls",
        toolCalls: [
          { toolCallId: "tc-1", toolName: "read", input: { path: "a.ts" } },
        ],
      },
      { finishReason: "stop", text: "Done" },
    ]);

    const store = createSessionStore(randomUUID());
    await runQueryLoop(
      makeOptions({
        tools: { read: baseTool },
        toolExecutors: { read: executor },
        store,
      }),
      "read file",
    );

    const events = store.getState().events;
    const toolCall = events.find((e) => e.type === "tool-call");
    const toolResult = events.find((e) => e.type === "tool-result");
    expect(toolCall).toBeDefined();
    expect(toolResult).toBeDefined();
    if (toolCall && toolCall.type === "tool-call") {
      expect(toolCall.toolCallId).toBe("tc-1");
      expect(toolCall.toolName).toBe("read");
    }
    if (toolResult && toolResult.type === "tool-result") {
      expect(toolResult.toolCallId).toBe("tc-1");
      expect(toolResult.output).toBe("file contents");
      expect(toolResult.isError).toBe(false);
    }
  });

  test("records tool-result event with isError=true when executor is missing", async () => {
    setupMockStreamText([
      {
        finishReason: "tool-calls",
        toolCalls: [
          { toolCallId: "tc-1", toolName: "missing", input: {} },
        ],
      },
      { finishReason: "stop", text: "ok" },
    ]);

    const store = createSessionStore(randomUUID());
    await runQueryLoop(
      makeOptions({
        tools: { missing: baseTool },
        toolExecutors: {},
        store,
      }),
      "test",
    );

    const events = store.getState().events;
    const toolResult = events.find((e) => e.type === "tool-result");
    expect(toolResult).toBeDefined();
    if (toolResult && toolResult.type === "tool-result") {
      expect(toolResult.toolName).toBe("missing");
      expect(toolResult.isError).toBe(true);
      expect(toolResult.output).toContain("No executor");
    }
  });

  test("records tool-result event with isError=true when executor throws", async () => {
    const executor = mock(async () => {
      throw new Error("disk full");
    });

    setupMockStreamText([
      {
        finishReason: "tool-calls",
        toolCalls: [
          { toolCallId: "tc-1", toolName: "write", input: {} },
        ],
      },
      { finishReason: "stop", text: "ok" },
    ]);

    const store = createSessionStore(randomUUID());
    await runQueryLoop(
      makeOptions({
        tools: { write: baseTool },
        toolExecutors: { write: executor },
        store,
      }),
      "test",
    );

    const events = store.getState().events;
    const toolResult = events.find((e) => e.type === "tool-result");
    expect(toolResult).toBeDefined();
    if (toolResult && toolResult.type === "tool-result") {
      expect(toolResult.isError).toBe(true);
      expect(toolResult.output).toContain("disk full");
    }
  });

  test("records loop-error event when streamText throws", async () => {
    const fn = mock(() => {
      throw new Error("model unavailable");
    });
    __setStreamTextForTest(fn as unknown as typeof import("ai").streamText);

    const store = createSessionStore(randomUUID());
    await runQueryLoop(makeOptions({ store }), "test");

    const events = store.getState().events;
    const loopError = events.find((e) => e.type === "loop-error");
    expect(loopError).toBeDefined();
    if (loopError && loopError.type === "loop-error") {
      expect(loopError.error).toContain("model unavailable");
    }
  });
});
