import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createEmptySessionStats } from "@specra/protocol";
import { silentLogger } from "../../logger";
import { SessionStoreManager } from "../../store/session-store-manager";
import { sessionFileInternals } from "../../store/helpers";
import { __setSessionsDirForTest } from "../../store/sessions-dir";
import type { ToolExecutionContext } from "../types";
import { BackgroundOutputInputSchema, executeBackgroundOutput } from "./background-output";
import { createTestProjectContext } from "../test-project-context";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "background-output");
const workspaceRoot = join(TMP_DIR, "workspace");

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(workspaceRoot, { recursive: true });
  __setSessionsDirForTest(() => join(TMP_DIR, "sessions"));
});

afterEach(async () => {
  __setSessionsDirForTest(undefined);
  await rm(TMP_DIR, { recursive: true, force: true });
});

afterAll(async () => {
  __setSessionsDirForTest(undefined);
  await rm(TMP_DIR, { recursive: true, force: true });
});

function makeContext(parentId = `background-parent-${crypto.randomUUID()}`): ToolExecutionContext {
  const localManager = new SessionStoreManager({ logger: silentLogger });
  return {
    store: localManager.create(parentId, workspaceRoot),
    storeManager: localManager,
    toolName: "background_output",
    toolCallId: "background-output-call",
    input: {},
    step: 0,
    abort: new AbortController().signal,
    startedAt: 0,
    allowedTools: new Set(["background_output"]),
    workspaceRoot,
    projectContext: createTestProjectContext(workspaceRoot),
  };
}

function linkChild(ctx: ToolExecutionContext, childId = `background-child-${crypto.randomUUID()}`) {
  const childStore = ctx.storeManager.create(childId, workspaceRoot);
  ctx.store.getState().linkChildSession(childStore.getState().sessionId);
  return childStore;
}

function appendAssistantText(ctx: ToolExecutionContext, text: string): void {
  ctx.store.getState().append({ type: "run-start", runId: crypto.randomUUID() });
  ctx.store.getState().append({ type: "text-start" });
  ctx.store.getState().append({ type: "text-delta", text });
  ctx.store.getState().append({ type: "text-end" });
  ctx.store.getState().append({ type: "run-end", status: "completed" });
}

describe("BackgroundOutputInputSchema", () => {
  it("accepts canonical parameters and applies defaults", () => {
    const result = BackgroundOutputInputSchema.parse({ session_id: "child-1" });

    expect(result).toEqual({
      session_id: "child-1",
      block: false,
      timeout_ms: 60_000,
      full_session: false,
      message_limit: 20,
      include_tool_results: false,
      include_reasoning: false,
    });

    expect(BackgroundOutputInputSchema.parse({
      session_id: "child-1",
      block: true,
      timeout_ms: 600_000,
      full_session: true,
      message_limit: 100,
      since_message_id: "message-1",
      include_tool_results: true,
      include_reasoning: true,
    })).toMatchObject({ block: true, full_session: true, since_message_id: "message-1" });
  });

  it("rejects old aliases and values above caps", () => {
    for (const alias of ["task_id", "bg_id", "background_task_id", "timeout", "include_thinking"]) {
      expect(BackgroundOutputInputSchema.safeParse({ session_id: "child-1", [alias]: true }).success).toBe(false);
    }

    expect(BackgroundOutputInputSchema.safeParse({ session_id: "child-1", timeout_ms: 600_001 }).success).toBe(false);
    expect(BackgroundOutputInputSchema.safeParse({ session_id: "child-1", message_limit: 101 }).success).toBe(false);
  });
});

describe("background_output tool", () => {
  it("returns latest assistant text and session status from a known child store", async () => {
    const ctx = makeContext();
    const childStore = linkChild(ctx);
    const child = { ...ctx, store: childStore };
    appendAssistantText(child, "first");
    appendAssistantText(child, "latest");

    const result = await executeBackgroundOutput({
      session_id: childStore.getState().sessionId,
      block: false,
      timeout_ms: 60_000,
      full_session: false,
      message_limit: 20,
      include_tool_results: false,
      include_reasoning: false,
    }, ctx);

    expect(result).toContain(`# Background session ${childStore.getState().sessionId}`);
    expect(result).toContain("Status: completed");
    expect(result).toContain("latest");
    expect(result).not.toContain("first");
  });

  it("returns partial/latest text and running guidance while child is running", async () => {
    const ctx = makeContext();
    const childStore = linkChild(ctx);
    childStore.getState().append({ type: "run-start", runId: "run-1" });
    childStore.getState().append({ type: "text-start" });
    childStore.getState().append({ type: "text-delta", text: "partial" });

    const result = await executeBackgroundOutput({
      session_id: childStore.getState().sessionId,
      block: false,
      timeout_ms: 60_000,
      full_session: false,
      message_limit: 20,
      include_tool_results: false,
      include_reasoning: false,
    }, ctx);

    expect(result).toContain("Status: running");
    expect(result).toContain("partial");
    expect(result).toContain("Sub-agent is still running.");
  });

  it("rejects unrelated sessions and grandchildren", async () => {
    const ctx = makeContext();
    const unrelated = ctx.storeManager.create(`unrelated-${crypto.randomUUID()}`, workspaceRoot);
    const childStore = linkChild(ctx);
    const grandchild = ctx.storeManager.create(`grandchild-${crypto.randomUUID()}`, workspaceRoot);
    childStore.getState().linkChildSession(grandchild.getState().sessionId);

    for (const sessionId of [unrelated.getState().sessionId, grandchild.getState().sessionId]) {
      const result = await executeBackgroundOutput({
        session_id: sessionId,
        block: false,
        timeout_ms: 60_000,
        full_session: false,
        message_limit: 20,
        include_tool_results: false,
        include_reasoning: false,
      }, ctx);

      expect(typeof result).toBe("object");
      expect((result as { isError: boolean }).isError).toBe(true);
      expect((result as { output: string }).output).toContain(`Unknown child session_id: ${sessionId}`);
    }
  });

  it("keeps nested delegation stats isolated and only permits direct child reads", async () => {
    const ctx = makeContext();
    const childStore = linkChild(ctx);
    const grandchild = ctx.storeManager.create(`grandchild-${crypto.randomUUID()}`, workspaceRoot);
    childStore.getState().linkChildSession(grandchild.getState().sessionId);

    childStore.getState().append({ type: "run-start", runId: "child-run" });
    childStore.getState().append({ type: "tool-call", toolCallId: "child-tool", toolName: "read", input: {} });
    childStore.getState().append({ type: "tool-result", toolCallId: "child-tool", toolName: "read", output: "ok", isError: false });
    childStore.getState().append({ type: "run-end", status: "completed" });
    grandchild.getState().append({ type: "run-start", runId: "grandchild-run" });
    grandchild.getState().append({ type: "tool-call", toolCallId: "grandchild-tool", toolName: "bash", input: "false" });
    grandchild.getState().append({ type: "tool-result", toolCallId: "grandchild-tool", toolName: "bash", output: "failed", isError: true });
    grandchild.getState().append({ type: "run-end", status: "failed" });

    expect(childStore.getState().stats.tools).toEqual({ calls: 1, completed: 1, failed: 0 });
    expect(grandchild.getState().stats.tools).toEqual({ calls: 1, completed: 0, failed: 1 });

    const childResult = await executeBackgroundOutput({
      session_id: childStore.getState().sessionId,
      block: false,
      timeout_ms: 60_000,
      full_session: false,
      message_limit: 20,
      include_tool_results: false,
      include_reasoning: false,
    }, ctx);
    expect(childResult).toContain(`# Background session ${childStore.getState().sessionId}`);

    const grandchildResult = await executeBackgroundOutput({
      session_id: grandchild.getState().sessionId,
      block: false,
      timeout_ms: 60_000,
      full_session: false,
      message_limit: 20,
      include_tool_results: false,
      include_reasoning: false,
    }, ctx);
    expect(typeof grandchildResult).toBe("object");
    expect((grandchildResult as { isError: boolean }).isError).toBe(true);
    expect((grandchildResult as { output: string }).output).toContain(`Unknown child session_id: ${grandchild.getState().sessionId}`);
  });

  it("waits with block=true until the child stops", async () => {
    const ctx = makeContext();
    const childStore = linkChild(ctx);
    childStore.getState().append({ type: "run-start", runId: "run-1" });
    childStore.getState().append({ type: "text-start" });
    childStore.getState().append({ type: "text-delta", text: "done after wait" });

    const resultPromise = executeBackgroundOutput({
      session_id: childStore.getState().sessionId,
      block: true,
      timeout_ms: 1_000,
      full_session: false,
      message_limit: 20,
      include_tool_results: false,
      include_reasoning: false,
    }, ctx);

    setTimeout(() => childStore.getState().append({ type: "run-end", status: "completed" }), 5);
    const result = await resultPromise;

    expect(result).toContain("Status: completed");
    expect(result).toContain("done after wait");
    expect(result).not.toContain("Timed out waiting");
  });

  it("returns current output plus timeout note when block=true times out", async () => {
    const ctx = makeContext();
    const childStore = linkChild(ctx);
    childStore.getState().append({ type: "run-start", runId: "run-1" });
    childStore.getState().append({ type: "text-start" });
    childStore.getState().append({ type: "text-delta", text: "still working" });

    const result = await executeBackgroundOutput({
      session_id: childStore.getState().sessionId,
      block: true,
      timeout_ms: 1,
      full_session: false,
      message_limit: 20,
      include_tool_results: false,
      include_reasoning: false,
    }, ctx);

    expect(result).toContain("Status: running");
    expect(result).toContain("still working");
    expect(result).toContain("Timed out waiting for the sub-agent.");
  });

  it("renders full-session messages in stored order with exclusive cursor and limit", async () => {
    const ctx = makeContext();
    const childStore = linkChild(ctx);
    childStore.getState().append({ type: "user-message", content: "question one" });
    const firstMessageId = childStore.getState().messages[0]!.id;
    appendAssistantText({ ...ctx, store: childStore }, "answer one");
    childStore.getState().append({ type: "user-message", content: "question two" });
    childStore.getState().append({ type: "user-message", content: "question three" });

    const result = await executeBackgroundOutput({
      session_id: childStore.getState().sessionId,
      block: false,
      timeout_ms: 60_000,
      full_session: true,
      message_limit: 2,
      since_message_id: firstMessageId,
      include_tool_results: false,
      include_reasoning: false,
    }, ctx);

    expect(result).not.toContain("question one");
    expect(result).toContain("## assistant");
    expect(result).toContain("answer one");
    expect(result).toContain("## user");
    expect(result).toContain("question two");
    expect(result).not.toContain("question three");
  });

  it("omits tool result payloads and reasoning by default", async () => {
    const ctx = makeContext();
    const childStore = linkChild(ctx);
    childStore.getState().append({ type: "run-start", runId: "run-1" });
    childStore.getState().append({ type: "reasoning-start" });
    childStore.getState().append({ type: "reasoning-delta", text: "private chain" });
    childStore.getState().append({ type: "reasoning-end" });
    childStore.getState().append({ type: "tool-call", toolCallId: "call-1", toolName: "grep", input: { pattern: "x" } });
    childStore.getState().append({ type: "tool-result", toolCallId: "call-1", toolName: "grep", output: "secret payload", isError: false });
    childStore.getState().append({ type: "run-end", status: "completed" });

    const result = await executeBackgroundOutput({
      session_id: childStore.getState().sessionId,
      block: false,
      timeout_ms: 60_000,
      full_session: true,
      message_limit: 20,
      include_tool_results: false,
      include_reasoning: false,
    }, ctx);

    expect(result).toContain("- Tool call: grep [completed]");
    expect(result).not.toContain("secret payload");
    expect(result).not.toContain("private chain");
  });

  it("includes capped tool result and reasoning output when requested", async () => {
    const ctx = makeContext();
    const childStore = linkChild(ctx);
    childStore.getState().append({ type: "run-start", runId: "run-1" });
    childStore.getState().append({ type: "reasoning-start" });
    childStore.getState().append({ type: "reasoning-delta", text: `${"r".repeat(1_100)}reasoning-tail` });
    childStore.getState().append({ type: "reasoning-end" });
    childStore.getState().append({ type: "tool-call", toolCallId: "call-1", toolName: "bash", input: { command: "x" } });
    childStore.getState().append({ type: "tool-result", toolCallId: "call-1", toolName: "bash", output: `${"t".repeat(2_100)}tool-tail`, isError: false });
    childStore.getState().append({ type: "run-end", status: "completed" });

    const result = await executeBackgroundOutput({
      session_id: childStore.getState().sessionId,
      block: false,
      timeout_ms: 60_000,
      full_session: true,
      message_limit: 20,
      include_tool_results: true,
      include_reasoning: true,
    }, ctx);

    expect(result).toContain("### Reasoning");
    expect(result).toContain("[part truncated]");
    expect(result).toContain("```text");
    expect(result).not.toContain("reasoning-tail");
    expect(result).not.toContain("tool-tail");
  });

  it("loads a direct child session from disk when it is not in memory", async () => {
    const ctx = makeContext();
    const childId = `disk-child-${crypto.randomUUID()}`;
    ctx.store.getState().linkChildSession(childId);

    await sessionFileInternals.saveSessionTranscript({
      sessionId: childId,
      createdAt: Date.now(),
      title: null,
      messages: [
        {
          id: "disk-message-1",
          role: "assistant",
          createdAt: Date.now(),
          completedAt: Date.now(),
          parts: [{ type: "text", id: "disk-part-1", text: "loaded from disk", createdAt: Date.now(), completedAt: Date.now() }],
        },
      ],
      steps: [],
      stats: {
        ...createEmptySessionStats(),
        tools: { calls: 1, completed: 1, failed: 0 },
      },
      runs: [{ id: "run-1", startedAt: Date.now(), status: "completed", endedAt: Date.now() }],
      todos: [],
      reminders: [],
    }, workspaceRoot);

    expect(ctx.storeManager.get(childId, workspaceRoot)).toBeUndefined();

    const result = await executeBackgroundOutput({
      session_id: childId,
      block: false,
      timeout_ms: 60_000,
      full_session: false,
      message_limit: 20,
      include_tool_results: false,
      include_reasoning: false,
    }, ctx);

    expect(result).toContain("loaded from disk");
    const loaded = ctx.storeManager.get(childId, workspaceRoot);
    expect(loaded).toBeDefined();
    expect(loaded!.getState().stats.tools).toEqual({ calls: 1, completed: 1, failed: 0 });
    expect(loaded!.getState().runCount).toBe(1);
  });
});
