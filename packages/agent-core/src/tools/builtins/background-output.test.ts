import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { silentLogger } from "../../logger";
import { SessionStoreManager } from "../../store/session-store-manager";
import { __setSessionsDirForTest } from "../../store/sessions-dir";
import { createTestProjectContext } from "../test-project-context";
import type { SessionStoreState, StoredMessage } from "../../store/types";
import type { ToolExecutionContext } from "../types";
import {
  BackgroundOutputInputSchema,
  executeBackgroundOutput,
  type BackgroundOutputDeadlineHandle,
  type BackgroundOutputDeadlineScheduler,
} from "./background-output";
import { sourceDraftText } from "./source-page";
import {
  testExecutionEnd,
  testExecutionStart,
  testExecutionSuspended,
  testExecutionUsage,
} from "../../testing/test-execution-fixtures";

// Keep mutable fixtures out of the source worktree: constrained runners can mount it read-only.
const root = join("/tmp", "archcode-background-source", crypto.randomUUID());
const workspace = join(root, "workspace");
const sessions: Array<{
  manager: SessionStoreManager;
  sessionId: string;
}> = [];

function endExecution(
  executionId: string,
  terminalStatus: Parameters<typeof testExecutionEnd>[1] = "completed",
  error?: string,
  finalOutputStepId?: string,
) {
  const endedAt = Date.now() + 1;
  return testExecutionEnd(executionId, terminalStatus, {
    endedAt,
    runEndedAt: endedAt,
    ...(error === undefined ? {} : { error }),
    ...(finalOutputStepId === undefined ? {} : { finalOutputStepId }),
  });
}

function context(): ToolExecutionContext {
  const manager = new SessionStoreManager({ logger: silentLogger });
  const id = crypto.randomUUID();
  sessions.push({ manager, sessionId: id });
  return {
    store: manager.create(id, workspace, { source: { kind: "direct" }, agentName: "lead" }), storeManager: manager,
    toolName: "background_output", toolCallId: "call", input: {}, step: 1,
    executionId: "test-execution",
    runOrdinal: 0,
    toolBatchId: "test-tool-batch",
    abort: new AbortController().signal, startedAt: Date.now(), allowedTools: new Set(["background_output"]),
    cwd: workspace, projectContext: createTestProjectContext(workspace),
  };
}

function child(ctx: ToolExecutionContext) {
  const sessionId = crypto.randomUUID();
  const store = ctx.storeManager.create(sessionId, workspace, { source: { kind: "direct" }, agentName: "lead" });
  sessions.push({ manager: ctx.storeManager, sessionId });
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

function appendOutputAttempt(
  store: ReturnType<typeof child>,
  stepId: string,
  text: string,
  options: {
    finishReason?: string;
    complete?: boolean;
  } = {},
): void {
  const blockId = `block:${stepId}`;
  store.getState().append({ type: "step-start", stepId, step: 0 });
  store.getState().append({ type: "text-start", stepId, blockId });
  store.getState().append({ type: "text-delta", stepId, blockId, text });
  if (options.complete === false) return;
  store.getState().append({ type: "text-end", stepId, blockId });
  store.getState().append({
    type: "step-end",
    stepId,
    step: 0,
    finishReason: options.finishReason ?? "stop",
    usage: testExecutionUsage,
  });
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
  sessions.length = 0;
  await rm(root, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  __setSessionsDirForTest(() => join(root, "sessions"));
});
afterEach(async () => {
  try {
    await Promise.all(
      sessions.map(({ manager, sessionId }) => manager.flushSession(sessionId, workspace)),
    );
  } finally {
    for (const { manager } of sessions) manager.clearAll();
    sessions.length = 0;
    __setSessionsDirForTest(undefined);
  }
});
afterAll(async () => { __setSessionsDirForTest(undefined); await rm(root, { recursive: true, force: true }); });

describe("background_output source pages", () => {
  test("returns latest output as a Raw SourcePageDraft", async () => {
    const ctx = context();
    const store = child(ctx);
    store.getState().append(testExecutionStart("run"));
    appendOutputAttempt(store, "step:run", "latest");
    store.getState().append(
      endExecution("run", "completed", undefined, "step:run"),
    );

    const result = await executeBackgroundOutput(input(store.getState().sessionId), ctx);
    expect(result.draft.kind).toBe("source");
    expect(sourceDraftText(result)).toContain("latest");
    expect(result.draft.kind === "source" && result.draft.nextInput).toBeUndefined();
  });

  test("pages through a huge latest assistant part at UTF-8 boundaries", async () => {
    const ctx = context();
    const store = child(ctx);
    store.getState().append(testExecutionStart("huge"));
    store.getState().append({ type: "step-start", stepId: "step:huge", step: 0 });
    setMessages(store, [{
      id: "assistant-huge",
      role: "assistant",
      executionId: "huge",
      runOrdinal: 0,
      stepId: "step:huge",
      outputPhase: "commentary",
      createdAt: 1,
      completedAt: 2,
      parts: [{
        type: "assistant-output",
        id: "output-huge",
        blockId: "block:huge",
        text: `HEAD_SENTINEL${"界".repeat(45_000)}TAIL_SENTINEL`,
        createdAt: 1,
        completedAt: 2,
      }],
    }]);
    store.getState().append({
      type: "step-end",
      stepId: "step:huge",
      step: 0,
      finishReason: "stop",
      usage: testExecutionUsage,
    });
    store.getState().append(
      endExecution("huge", "completed", undefined, "step:huge"),
    );

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
    appendOutputAttempt(store, "step:running", "still working", {
      complete: false,
    });

    const result = await executeBackgroundOutput(input(store.getState().sessionId), ctx);
    expect(sourceDraftText(result)).toContain("Snapshot: false (live Session)");
    expect(sourceDraftText(result)).toContain("not a final deliverable");
  });

  test("blocking waits for the child state transition and cancels its deadline", async () => {
    const ctx = context();
    const store = child(ctx);
    store.getState().append(testExecutionStart("running"));
    const deadline = createManualDeadlineScheduler();

    const pending = executeBackgroundOutput(
      input(store.getState().sessionId, { block: true, timeout_ms: 60_000 }),
      ctx,
      deadline.scheduler,
    );
    await deadline.whenScheduled;
    store.getState().append(endExecution("running"));

    const result = await pending;
    expect(sourceDraftText(result)).toContain("Wait status: stopped");
    expect(deadline.scheduledDelays).toEqual([60_000]);
    expect(deadline.cancelled).toHaveLength(1);
  });

  test("blocking timeout returns a live snapshot when its controlled deadline fires", async () => {
    const ctx = context();
    const store = child(ctx);
    store.getState().append(testExecutionStart("running"));
    const deadline = createManualDeadlineScheduler();

    const pending = executeBackgroundOutput(
      input(store.getState().sessionId, { block: true, timeout_ms: 60_000 }),
      ctx,
      deadline.scheduler,
    );
    await deadline.whenScheduled;
    deadline.fire();

    const result = await pending;
    expect(sourceDraftText(result)).toContain("Wait status: timed_out");
    expect(sourceDraftText(result)).toContain("Snapshot: false (live Session)");
    expect(deadline.cancelled).toHaveLength(1);
  });

  test("blocking abort returns immediately without consuming the child state", async () => {
    const abort = new AbortController();
    const ctx = { ...context(), abort: abort.signal };
    const store = child(ctx);
    store.getState().append(testExecutionStart("running"));
    const deadline = createManualDeadlineScheduler();

    const pending = executeBackgroundOutput(
      input(store.getState().sessionId, { block: true, timeout_ms: 60_000 }),
      ctx,
      deadline.scheduler,
    );
    await deadline.whenScheduled;
    abort.abort();

    const result = await pending;
    expect(sourceDraftText(result)).toContain("Wait status: aborted");
    expect(store.getState().isRunning).toBe(true);
    expect(deadline.cancelled).toHaveLength(1);
  });

  test("waiting Session output is explicitly non-final even though the execution is not running", async () => {
    const ctx = context();
    const store = child(ctx);
    store.getState().append(testExecutionStart("waiting"));
    appendOutputAttempt(
      store,
      "step:waiting",
      "I need one decision before continuing.",
      { finishReason: "tool-calls" },
    );
    store.getState().append(testExecutionSuspended("waiting", {
      kind: "hitl",
      toolBatchId: "batch-1",
      blockerIds: ["hitl-1"],
    }, { runEndedAt: Date.now() + 1 }));

    const result = await executeBackgroundOutput(input(store.getState().sessionId), ctx);
    expect(sourceDraftText(result)).toContain("Status: suspended");
    expect(sourceDraftText(result)).toContain("I need one decision before continuing.");
    expect(sourceDraftText(result)).toContain("waiting for human input");
    expect(sourceDraftText(result)).toContain("not a final deliverable");
  });

  test("uses only the latest execution output", async () => {
    const ctx = context();
    const store = child(ctx);
    store.getState().append(testExecutionStart("old"));
    appendOutputAttempt(store, "step:old", "final review complete");
    store.getState().append(
      endExecution("old", "completed", undefined, "step:old"),
    );
    store.getState().append(testExecutionStart("latest"));
    store.getState().append(endExecution("latest", "failed", "boom"));

    const result = await executeBackgroundOutput(input(store.getState().sessionId), ctx);
    expect(sourceDraftText(result)).not.toContain("final review complete");
    expect(sourceDraftText(result)).toContain("No final output is available");
    expect(sourceDraftText(result)).toContain("Execution error: boom");
  });

  test("rejects unknown input fields", () => {
    const session_id = crypto.randomUUID();
    expect(BackgroundOutputInputSchema.safeParse({ session_id, unexpectedField: true }).success).toBe(false);
  });

  test("rejects the current Session with a bounded Raw error", async () => {
    const ctx = context();
    const result = await executeBackgroundOutput(input(ctx.store.getState().sessionId), ctx);
    expect(result.isError).toBe(true);
    expect(result.details?.error?.code).toBe("TOOL_INVALID_BACKGROUND_SESSION");
  });
});

function createManualDeadlineScheduler(): {
  scheduler: BackgroundOutputDeadlineScheduler;
  fire: () => void;
  whenScheduled: Promise<void>;
  scheduledDelays: number[];
  cancelled: BackgroundOutputDeadlineHandle[];
} {
  let callback: (() => void) | undefined;
  const scheduledDelays: number[] = [];
  const cancelled: BackgroundOutputDeadlineHandle[] = [];
  const handle = { id: Symbol("background-output") };
  let signalScheduled!: () => void;
  const whenScheduled = new Promise<void>((resolve) => {
    signalScheduled = resolve;
  });
  return {
    scheduler: {
      schedule(delayMs, nextCallback) {
        scheduledDelays.push(delayMs);
        callback = nextCallback;
        signalScheduled();
        return handle;
      },
      cancel(cancelledHandle) {
        cancelled.push(cancelledHandle);
      },
    },
    fire() {
      const pending = callback;
      callback = undefined;
      if (pending === undefined) throw new Error("No background_output deadline is scheduled");
      pending();
    },
    whenScheduled,
    scheduledDelays,
    cancelled,
  };
}
