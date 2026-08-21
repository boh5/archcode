import { describe, expect, mock, test } from "bun:test";
import { storeManager } from "../../store/store";
import type { SendMessageToChild } from "../../delegation/types";
import { createTestProjectContext } from "../test-project-context";
import { expectTextDraft } from "../test-results";
import type { ToolExecutionContext } from "../types";
import {
  executeSendMessage,
  SendMessageInputSchema,
  sendMessageTool,
} from "./send-message";
import { createBuiltinToolDescriptors } from "./index";

const WORKSPACE_ROOT = import.meta.dir;

function context(sendMessageToChild?: SendMessageToChild): ToolExecutionContext {
  const store = storeManager.create(crypto.randomUUID(), WORKSPACE_ROOT, {
    source: { kind: "direct" },
    agentName: "lead",
  });
  return {
    store,
    storeManager,
    toolName: "send_message",
    toolCallId: "send-call",
    input: {},
    step: 3,
    executionId: "parent-execution",
    runOrdinal: 2,
    toolBatchId: "parent-batch",
    abort: new AbortController().signal,
    startedAt: 0,
    allowedTools: new Set(["send_message"]),
    cwd: WORKSPACE_ROOT,
    projectContext: createTestProjectContext(WORKSPACE_ROOT),
    ...(sendMessageToChild === undefined ? {} : { sendMessageToChild }),
  } as ToolExecutionContext;
}

describe("send_message tool", () => {
  test("exposes one strict steer or queue contract", () => {
    expect(SendMessageInputSchema.safeParse({
      session_id: "child",
      expected_execution_id: "execution",
      message: "continue",
      delivery: "steer",
    }).success).toBe(true);
    expect(SendMessageInputSchema.safeParse({
      session_id: "child",
      expected_execution_id: "execution",
      message: "continue",
      delivery: "queue",
      extra: true,
    }).success).toBe(false);
    expect(sendMessageTool.traits).toEqual({
      readOnly: false,
      destructive: false,
      concurrencySafe: true,
    });
    expect(createBuiltinToolDescriptors()).toContain(sendMessageTool);
  });

  test("forwards exact parent execution provenance and a deterministic receipt id", async () => {
    const send = mock(async (_workspaceRoot: string, request: Parameters<SendMessageToChild>[1]) => ({
      sessionId: request.sessionId,
      executionId: request.expectedExecutionId,
      messageId: "message-1",
      delivery: "steered" as const,
    }));
    const ctx = context(send);
    const result = await executeSendMessage({
      session_id: "child",
      expected_execution_id: "child-execution",
      message: "check the new evidence",
      delivery: "steer",
    }, ctx);

    expect(result.isError).toBe(false);
    expect(JSON.parse(expectTextDraft(result))).toEqual({
      session_id: "child",
      execution_id: "child-execution",
      message_id: "message-1",
      delivery: "steered",
    });
    expect(send).toHaveBeenCalledWith(WORKSPACE_ROOT, expect.objectContaining({
      parentStore: ctx.store,
      parentSessionId: ctx.store.getState().sessionId,
      parentAgentName: "lead",
      parentExecutionId: "parent-execution",
      parentRunOrdinal: 2,
      parentToolBatchId: "parent-batch",
      parentToolCallId: "send-call",
      clientRequestId: `send_message:${ctx.store.getState().sessionId}:parent-execution:2:parent-batch:send-call`,
    }));
  });

  test("fails closed when Runtime wiring is absent", async () => {
    const result = await executeSendMessage({
      session_id: "child",
      expected_execution_id: "child-execution",
      message: "queue this",
      delivery: "queue",
    }, context());
    expect(result.isError).toBe(true);
    expect(expectTextDraft(result)).toContain("not available");
  });
});
