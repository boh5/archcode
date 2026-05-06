import { describe, expect, mock, test } from "bun:test";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import { randomUUID } from "node:crypto";
import { runQueryLoop, __setStreamTextForTest } from "../agents/query/loop";
import { createSessionStore } from "../store/store";
import { shouldSubmit } from "./App";

interface MockRound {
  finishReason: string;
  text?: string;
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

    const responseMessages: ModelMessage[] = [];
    if (round.text) {
      responseMessages.push({
        role: "assistant",
        content: [{ type: "text", text: round.text }],
      });
    }

    return {
      fullStream: (async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      })(),
      response: Promise.resolve({ messages: responseMessages }),
      finishReason: Promise.resolve(round.finishReason),
      text: Promise.resolve(round.text ?? ""),
      toolCalls: Promise.resolve([]),
    };
  });

  __setStreamTextForTest(fn as unknown as typeof import("ai").streamText);
  return fn;
}

const DUMMY_MODEL = { modelId: "mock", provider: "mock" } as unknown as LanguageModelV3;

describe("App orchestration", () => {
  test("shouldSubmit skips empty input", () => {
    expect(shouldSubmit("")).toBe(false);
  });

  test("shouldSubmit skips whitespace-only input", () => {
    expect(shouldSubmit("   \t\n  ")).toBe(false);
  });

  test("shouldSubmit accepts trimmed non-empty input", () => {
    expect(shouldSubmit("  hello  ")).toBe(true);
    expect(shouldSubmit("hello")).toBe(true);
  });

  test("wires store through runQueryLoop so events are appended", async () => {
    const streamFn = setupMockStreamText([
      { finishReason: "stop", text: "Hello from App smoke test" },
    ]);
    const store = createSessionStore(randomUUID());

    await runQueryLoop(
      {
        model: DUMMY_MODEL,
        tools: {},
        toolExecutors: {},
        store,
      },
      "Hi App",
    );

    expect(streamFn).toHaveBeenCalledTimes(1);
    expect(store.getState().events.map((event) => event.type)).toEqual([
      "user-message",
      "text-delta",
    ]);

    const userMessage = store.getState().events.find((event) => event.type === "user-message");
    const textDelta = store.getState().events.find((event) => event.type === "text-delta");

    expect(userMessage).toBeDefined();
    expect(textDelta).toBeDefined();
    if (userMessage?.type === "user-message") {
      expect(userMessage.content).toBe("Hi App");
    }
    if (textDelta?.type === "text-delta") {
      expect(textDelta.text).toBe("Hello from App smoke test");
    }
  });

  test("runQueryLoop throwing appends loop-error to store", async () => {
    const streamFn = mock((_opts: Record<string, unknown>) => {
      throw new Error("stream exploded");
    });

    __setStreamTextForTest(streamFn as unknown as typeof import("ai").streamText);
    const store = createSessionStore(randomUUID());

    await runQueryLoop(
      {
        model: DUMMY_MODEL,
        tools: {},
        toolExecutors: {},
        store,
      },
      "trigger error",
    );

    const errorEvent = store.getState().events.find((e) => e.type === "loop-error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === "loop-error") {
      expect(errorEvent.error).toBe("Error: stream exploded");
    }
  });
});
