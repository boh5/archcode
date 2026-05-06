import { describe, expect, mock, test } from "bun:test";
import type { LanguageModelV3 } from "@ai-sdk/provider";
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

    return {
      fullStream: (async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      })(),
      finishReason: Promise.resolve(round.finishReason),
      text: Promise.resolve(round.text ?? ""),
      toolCalls: Promise.resolve([]),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
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

  test("wires store through runQueryLoop so messages are appended", async () => {
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

    const messages = store.getState().messages;
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    const userTextPart = userMsg!.parts.find((p) => p.type === "text");
    expect(userTextPart).toBeDefined();
    expect(userTextPart!.text).toBe("Hi App");

    const assistantMsg = messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    const assistantTextPart = assistantMsg!.parts.find((p) => p.type === "text");
    expect(assistantTextPart).toBeDefined();
    expect(assistantTextPart!.text).toBe("Hello from App smoke test");
  });

  test("runQueryLoop throwing records error in store steps", async () => {
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

    const steps = store.getState().steps;
    const errorStep = steps.find((s) => s.error !== undefined);
    expect(errorStep).toBeDefined();
    expect(errorStep!.error).toContain("stream exploded");
  });
});