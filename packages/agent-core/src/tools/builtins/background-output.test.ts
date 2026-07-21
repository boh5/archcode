import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { silentLogger } from "../../logger";
import { SessionStoreManager } from "../../store/session-store-manager";
import { __setSessionsDirForTest } from "../../store/sessions-dir";
import { createTestProjectContext } from "../test-project-context";
import type { SessionStoreState, StoredMessage } from "../../store/types";
import type { ToolExecutionContext } from "../types";
import { BackgroundOutputInputSchema, executeBackgroundOutput } from "./background-output";
import { sourceDraftText } from "./source-page";
import { testExecutionStart } from "../../testing/test-execution-fixtures";

// Keep mutable fixtures out of the source worktree: constrained runners can mount it read-only.
const root = join("/tmp", "archcode-background-source", crypto.randomUUID());
const workspace = join(root, "workspace");

function context(): ToolExecutionContext {
  const manager = new SessionStoreManager({ logger: silentLogger });
  const id = crypto.randomUUID();
  return {
    store: manager.create(id, workspace, { agentName: "lead" }), storeManager: manager,
    toolName: "background_output", toolCallId: "call", input: {}, step: 1,
    abort: new AbortController().signal, startedAt: Date.now(), allowedTools: new Set(["background_output"]),
    cwd: workspace, projectContext: createTestProjectContext(workspace),
  };
}

function child(ctx: ToolExecutionContext) {
  const store = ctx.storeManager.create(crypto.randomUUID(), workspace, { agentName: "lead" });
  store.getState().setParentSessionId(ctx.store.getState().sessionId);
  store.setState({ rootSessionId: ctx.store.getState().rootSessionId });
  return store;
}

function appendUser(store: ReturnType<typeof child>, id: string, text: string): void {
  store.getState().append({
    type: "session.messages_committed",
    executionId: `execution-${id}`,
    messages: [{
      id, role: "user", createdAt: 1, completedAt: 1, executionId: `execution-${id}`,
      clientRequestId: `request-${id}`,
      parts: [{ type: "text", id: `${id}:text`, text, createdAt: 1, completedAt: 1 }],
    }],
  });
}

function setMessages(store: ReturnType<typeof child>, messages: StoredMessage[]): void {
  store.setState({ messages } as Partial<SessionStoreState>);
}

async function readAllPages(
  firstInput: ReturnType<typeof input>,
  ctx: ToolExecutionContext,
): Promise<{ pages: string[]; nextInputs: unknown[] }> {
  const pages: string[] = [];
  const nextInputs: unknown[] = [];
  let current = firstInput;
  for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
    const result = await executeBackgroundOutput(current, ctx);
    if (result.draft.kind !== "source") throw new Error("Expected source page");
    pages.push(result.draft.text);
    expect(new TextEncoder().encode(result.draft.text).byteLength).toBeLessThanOrEqual(50 * 1024);
    expect(result.draft.text.split("\n").length).toBeLessThanOrEqual(2_000);
    expect(result.draft.text).not.toContain("[output truncated]");
    if (result.draft.nextInput === undefined) return { pages, nextInputs };
    expect(BackgroundOutputInputSchema.safeParse(result.draft.nextInput).success).toBe(true);
    expect(JSON.stringify(result.draft.nextInput)).not.toBe(JSON.stringify(current));
    nextInputs.push(result.draft.nextInput);
    current = BackgroundOutputInputSchema.parse(result.draft.nextInput);
  }
  throw new Error("background_output pagination did not terminate");
}

function input(sessionId: string, overrides: Record<string, unknown> = {}) {
  return BackgroundOutputInputSchema.parse({ session_id: sessionId, ...overrides });
}

beforeEach(async () => {
  await rm(root, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  __setSessionsDirForTest(() => join(root, "sessions"));
});
afterEach(() => __setSessionsDirForTest(undefined));
afterAll(async () => { __setSessionsDirForTest(undefined); await rm(root, { recursive: true, force: true }); });

describe("background_output source pages", () => {
  test("returns latest output as a Raw SourcePageDraft", async () => {
    const ctx = context();
    const store = child(ctx);
    store.getState().append(testExecutionStart("run"));
    store.getState().append({ type: "text-start" });
    store.getState().append({ type: "text-delta", text: "latest" });
    store.getState().append({ type: "text-end" });
    store.getState().append({ type: "execution-end", status: "completed" });

    const result = await executeBackgroundOutput(input(store.getState().sessionId), ctx);
    expect(result.draft.kind).toBe("source");
    expect(sourceDraftText(result)).toContain("latest");
    expect(result.draft.kind === "source" && result.draft.nextInput).toBeUndefined();
  });

  test("pages through a huge latest assistant part at UTF-8 boundaries", async () => {
    const ctx = context();
    const store = child(ctx);
    store.getState().append(testExecutionStart("huge"));
    setMessages(store, [{
      id: "assistant-huge",
      role: "assistant",
      executionId: "huge",
      createdAt: 1,
      completedAt: 2,
      parts: [{
        type: "text",
        id: "text-huge",
        text: `HEAD_SENTINEL${"界".repeat(45_000)}TAIL_SENTINEL`,
        createdAt: 1,
        completedAt: 2,
      }],
    }]);
    store.getState().append({ type: "execution-end", status: "completed" });

    const { pages, nextInputs } = await readAllPages(input(store.getState().sessionId), ctx);
    expect(pages.length).toBeGreaterThan(2);
    expect(nextInputs.length).toBe(pages.length - 1);
    expect(pages[0]).toContain("HEAD_SENTINEL");
    expect(pages.at(-1)).toContain("TAIL_SENTINEL");
    expect(pages.join("")).not.toContain("�");
  });

  test("full_session cursor advances inside a huge part and across messages to a sentinel", async () => {
    const ctx = context();
    const store = child(ctx);
    appendUser(store, "m1", `FIRST_MESSAGE${"界".repeat(40_000)}FIRST_TAIL`);
    appendUser(store, "m2", "SECOND_MESSAGE_SENTINEL");

    const { pages } = await readAllPages(input(store.getState().sessionId, { full_session: true }), ctx);
    expect(pages.length).toBeGreaterThan(2);
    expect(pages.join("")).toContain("FIRST_TAIL");
    expect(pages.join("")).toContain("SECOND_MESSAGE_SENTINEL");
  });

  test("running Session pages explicitly declare non-frozen snapshot semantics", async () => {
    const ctx = context();
    const store = child(ctx);
    store.getState().append(testExecutionStart("running"));
    store.getState().append({ type: "text-start" });
    store.getState().append({ type: "text-delta", text: "still working" });

    const result = await executeBackgroundOutput(input(store.getState().sessionId), ctx);
    expect(sourceDraftText(result)).toContain("Snapshot: false (live Session)");
    expect(sourceDraftText(result)).toContain("not a final deliverable");
  });

  test("waiting Session output is explicitly non-final even though the execution is not running", async () => {
    const ctx = context();
    const store = child(ctx);
    store.getState().append(testExecutionStart("waiting"));
    store.getState().append({ type: "text-start" });
    store.getState().append({ type: "text-delta", text: "I need one decision before continuing." });
    store.getState().append({ type: "text-end" });
    store.getState().append({
      type: "execution-end",
      status: "waiting_for_human",
      blockedByHitlIds: ["hitl-1"],
    });

    const result = await executeBackgroundOutput(input(store.getState().sessionId), ctx);
    expect(sourceDraftText(result)).toContain("Status: waiting_for_human");
    expect(sourceDraftText(result)).toContain("I need one decision before continuing.");
    expect(sourceDraftText(result)).toContain("waiting for human input");
    expect(sourceDraftText(result)).toContain("not a final deliverable");
  });

  test("does not fall back to output from an older completed execution", async () => {
    const ctx = context();
    const store = child(ctx);
    store.getState().append(testExecutionStart("old"));
    store.getState().append({ type: "text-start" });
    store.getState().append({ type: "text-delta", text: "VERDICT: APPROVED" });
    store.getState().append({ type: "text-end" });
    store.getState().append({ type: "execution-end", status: "completed" });
    store.getState().append(testExecutionStart("latest"));
    store.getState().append({ type: "execution-end", status: "failed", error: "boom" });

    const result = await executeBackgroundOutput(input(store.getState().sessionId), ctx);
    expect(sourceDraftText(result)).not.toContain("VERDICT: APPROVED");
    expect(sourceDraftText(result)).toContain("No final output is available");
    expect(sourceDraftText(result)).toContain("Execution error: boom");
  });

  test("hard-cuts legacy message cursors and limits from the strict schema", () => {
    const session_id = crypto.randomUUID();
    expect(BackgroundOutputInputSchema.safeParse({ session_id, since_message_id: "old" }).success).toBe(false);
    expect(BackgroundOutputInputSchema.safeParse({ session_id, message_limit: 20 }).success).toBe(false);
  });

  test("rejects the current Session with a bounded Raw error", async () => {
    const ctx = context();
    const result = await executeBackgroundOutput(input(ctx.store.getState().sessionId), ctx);
    expect(result.isError).toBe(true);
    expect(result.details?.error?.code).toBe("TOOL_INVALID_BACKGROUND_SESSION");
  });
});
