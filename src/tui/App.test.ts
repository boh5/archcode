import { describe, expect, mock, test } from "bun:test";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { randomUUID } from "node:crypto";
import { runQueryLoop, __setStreamTextForTest } from "../agents/query/loop";
import { createSessionStore } from "../store/store";
import { createRegistry } from "../tools/index";
import type { ToolConfirmationRequest } from "../tools/index";
import { shouldSubmit, createConfirmationCallback } from "./App";
import type { PendingConfirmation } from "./App";

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
        toolRegistry: createRegistry([]),
        allowedTools: [],
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
        toolRegistry: createRegistry([]),
        allowedTools: [],
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

describe("createConfirmationCallback", () => {
  test("stores pending request and resolves on approve", async () => {
    let pending: PendingConfirmation | null = null;
    const setPending = (p: PendingConfirmation | null) => {
      pending = p;
    };

    const callback = createConfirmationCallback(setPending);
    const request: ToolConfirmationRequest = {
      toolName: "bash",
      toolCallId: "tc-1",
      input: { command: "rm -rf /" },
      description: "Run destructive shell command",
    };

    const promise = callback(request);

    expect(pending).not.toBeNull();
    expect(pending!.request.toolName).toBe("bash");
    expect(pending!.request.description).toBe("Run destructive shell command");

    pending!.resolve("approve");

    const result = await promise;
    expect(result).toBe("approve");
  });

  test("stores pending request and resolves on deny", async () => {
    let pending: PendingConfirmation | null = null;
    const setPending = (p: PendingConfirmation | null) => {
      pending = p;
    };

    const callback = createConfirmationCallback(setPending);
    const request: ToolConfirmationRequest = {
      toolName: "write",
      toolCallId: "tc-2",
      input: { path: "/etc/hosts" },
      description: "Write to system file",
    };

    const promise = callback(request);

    expect(pending).not.toBeNull();
    expect(pending!.request.toolName).toBe("write");

    pending!.resolve("deny");

    const result = await promise;
    expect(result).toBe("deny");
  });

  test("clearing pending after resolve does not affect already-resolved promise", async () => {
    let pending: PendingConfirmation | null = null;
    const setPending = (p: PendingConfirmation | null) => {
      pending = p;
    };

    const callback = createConfirmationCallback(setPending);
    const promise = callback({
      toolName: "test",
      toolCallId: "tc-3",
      input: {},
      description: "test",
    });

    pending!.resolve("approve");
    setPending(null);

    const result = await promise;
    expect(result).toBe("approve");
  });

  test("only one pending request at a time", async () => {
    const pendingHistory: Array<PendingConfirmation | null> = [];
    const setPending = (p: PendingConfirmation | null) => {
      pendingHistory.push(p);
    };

    const callback = createConfirmationCallback(setPending);

    const promise1 = callback({
      toolName: "first",
      toolCallId: "tc-a",
      input: {},
      description: "first request",
    });

    pendingHistory[0]!.resolve("deny");

    await promise1;

    const promise2 = callback({
      toolName: "second",
      toolCallId: "tc-b",
      input: {},
      description: "second request",
    });

    pendingHistory[pendingHistory.length - 1]!.resolve("approve");
    const result2 = await promise2;
    expect(result2).toBe("approve");
  });
});
