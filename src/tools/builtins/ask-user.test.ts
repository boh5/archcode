import { describe, expect, test } from "bun:test";
import { askUserTool, AskUserInputSchema, executeAskUser } from "./ask-user";
import { createRegistry } from "../registry";
import type { AskUserCallback, ToolExecutionContext } from "../types";

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    store: {} as any,
    toolName: "ask_user",
    toolCallId: "call-1",
    input: {},
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(["ask_user"]),
    workspaceRoot: "/tmp/test",
    ...overrides,
  };
}

describe("askUserTool", () => {
  test("schema accepts valid input with question", () => {
    const result = AskUserInputSchema.safeParse({ question: "What is your name?" });
    expect(result.success).toBe(true);
  });

  test("schema rejects empty question", () => {
    const result = AskUserInputSchema.safeParse({ question: "" });
    expect(result.success).toBe(false);
  });

  test("schema rejects missing question", () => {
    const result = AskUserInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("schema rejects extra fields", () => {
    const result = AskUserInputSchema.safeParse({ question: "hi", extra: true });
    expect(result.success).toBe(false);
  });

  test("returns isError when askUser callback is missing", async () => {
    const ctx = makeCtx({ askUser: undefined });
    const result = await executeAskUser({ question: "Hello?" }, ctx);

    const parsed1 = JSON.parse(result.output);
    expect(parsed1.message).toBe("ask_user is not available");
    expect(parsed1.code).toBe("TOOL_CANCELLED");
    expect(result.isError).toBe(true);
  });

  test("returns user answer as tool result", async () => {
    const askUser: AskUserCallback = async () => ({ answer: "my answer" });
    const ctx = makeCtx({ askUser });
    const result = await executeAskUser({ question: "What is your name?" }, ctx);

    expect(result).toEqual({ output: "my answer", isError: false });
  });

  test("returns isError when user cancels", async () => {
    const askUser: AskUserCallback = async () => ({
      isError: true as const,
      reason: "Cancelled",
    });
    const ctx = makeCtx({ askUser });
    const result = await executeAskUser({ question: "Continue?" }, ctx);

    const parsed3 = JSON.parse(result.output);
    expect(parsed3.message).toBe("Cancelled");
    expect(parsed3.code).toBe("TOOL_CANCELLED");
    expect(result.isError).toBe(true);
  });

  test("returns isError with custom reason on duplicate pending", async () => {
    const askUser: AskUserCallback = async () => ({
      isError: true as const,
      reason: "Another question is already pending",
    });
    const ctx = makeCtx({ askUser });
    const result = await executeAskUser({ question: "Another?" }, ctx);

    const parsed4 = JSON.parse(result.output);
    expect(parsed4.message).toBe("Another question is already pending");
    expect(parsed4.code).toBe("TOOL_CANCELLED");
    expect(result.isError).toBe(true);
  });

  test("returns isError when AbortSignal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const askUser: AskUserCallback = async () => ({ answer: "should not reach" });
    const ctx = makeCtx({ askUser, abort: controller.signal });
    const result = await executeAskUser({ question: "Hello?" }, ctx);

    const parsed5 = JSON.parse(result.output);
    expect(parsed5.message).toBe("ask_user was aborted");
    expect(parsed5.code).toBe("TOOL_CANCELLED");
    expect(result.isError).toBe(true);
  });

  test("returns isError when AbortSignal aborts while askUser is pending", async () => {
    const controller = new AbortController();
    const askUser: AskUserCallback = () => new Promise(() => {});
    const ctx = makeCtx({ askUser, abort: controller.signal });

    const pending = executeAskUser({ question: "Still there?" }, ctx);
    controller.abort();

    const result = await pending;
    const parsed6 = JSON.parse(result.output);
    expect(parsed6.message).toBe("ask_user was aborted");
    expect(parsed6.code).toBe("TOOL_CANCELLED");
    expect(result.isError).toBe(true);
  });

  test("passes correct request to askUser callback", async () => {
    let capturedRequest: Parameters<AskUserCallback>[0] | undefined;
    const askUser: AskUserCallback = async (req) => {
      capturedRequest = req;
      return { answer: "yes" };
    };
    const ctx = makeCtx({ askUser, toolName: "ask_user", toolCallId: "call-42" });
    await executeAskUser({ question: "Proceed?" }, ctx);

    expect(capturedRequest!).toEqual({
      toolName: "ask_user",
      toolCallId: "call-42",
      question: "Proceed?",
    });
  });

  test("registry rejects schema-invalid input", async () => {
    const registry = createRegistry([askUserTool]);
    const ctx = makeCtx({ askUser: async () => ({ answer: "no" }) });
    const result = await registry.execute(
      { toolName: "ask_user", toolCallId: "call-1", input: {} },
      ctx,
    );

    expect(result.isError).toBe(true);
  });

  test("tool not allowed when not in allowedTools set", async () => {
    const registry = createRegistry([askUserTool]);
    const askUser: AskUserCallback = async () => ({ answer: "nope" });
    const ctx = makeCtx({ askUser, allowedTools: new Set(["other_tool"]) });
    const result = await registry.execute(
      { toolName: "ask_user", toolCallId: "call-1", input: { question: "Hello?" } },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("not allowed");
  });
});
