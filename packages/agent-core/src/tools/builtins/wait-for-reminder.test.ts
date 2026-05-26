import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { StoreApi } from "zustand";
import { storeManager } from "../../store/store";
import type { Reminder, SessionStoreState } from "../../store/types";
import type { ToolExecutionContext } from "../types";
import { createBuiltinToolDescriptors, waitForReminderTool, WaitForReminderInputSchema } from "./index";
import { createTestProjectContext } from "../test-project-context";

const testDir = join(import.meta.dir, "__test_tmp__", "wait-for-reminder");

function makeStore(childSessionIds: string[] = ["child-1"]): StoreApi<SessionStoreState> {
  const store = storeManager.create(`wait-reminder-test-${crypto.randomUUID()}`);
  store.setState({ childSessionIds: new Set(childSessionIds) });
  return store;
}

function makeCtx(store: StoreApi<SessionStoreState>, abort = new AbortController()): ToolExecutionContext {
  return {
    store,
    toolName: "wait_for_reminder",
    toolCallId: "call-1",
    input: {},
    step: 1,
    abort: abort.signal,
    startedAt: Date.now(),
    allowedTools: new Set(["wait_for_reminder"]),
    workspaceRoot: testDir,
    projectContext: createTestProjectContext(testDir),
  };
}

function makeReminder(overrides: Partial<Reminder> & { sessionId: string; id: string }): Reminder {
  const { id, sessionId, ...rest } = overrides;
  return {
    id,
    source: { type: "subagent_completed", sessionId },
    delivery: "on_demand",
    sessionId,
    content: `Reminder for ${sessionId}`,
    createdAt: Date.now(),
    consumedAt: null,
    ...rest,
  };
}

function parseResult(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
}

describe("WaitForReminderInputSchema", () => {
  test("accepts valid input and applies defaults", () => {
    const result = WaitForReminderInputSchema.safeParse({ session_ids: ["child-1"] });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.condition).toBe("any");
      expect(result.data.timeout_ms).toBe(120000);
    }
  });

  test("accepts all and count conditions", () => {
    expect(WaitForReminderInputSchema.safeParse({ session_ids: ["a"], condition: "all" }).success).toBe(true);
    expect(WaitForReminderInputSchema.safeParse({ session_ids: ["a"], condition: { count: 2 } }).success).toBe(true);
  });

  test("rejects unknown fields and out-of-range timeout", () => {
    expect(WaitForReminderInputSchema.safeParse({ session_ids: ["a"], extra: true }).success).toBe(false);
    expect(WaitForReminderInputSchema.safeParse({ session_ids: ["a"], timeout_ms: 999 }).success).toBe(false);
    expect(WaitForReminderInputSchema.safeParse({ session_ids: ["a"], timeout_ms: 600001 }).success).toBe(false);
  });

  test("rejects invalid count", () => {
    expect(WaitForReminderInputSchema.safeParse({ session_ids: ["a"], condition: { count: 0 } }).success).toBe(false);
  });
});

describe("waitForReminderTool", () => {
  test("is registered with builtin descriptors", () => {
    expect(createBuiltinToolDescriptors()).toContain(waitForReminderTool);
    expect(waitForReminderTool.traits).toEqual({ readOnly: false, destructive: false, concurrencySafe: true });
  });

  test("returns error for empty session_ids", async () => {
    const store = makeStore();
    const output = await waitForReminderTool.execute({ session_ids: [], condition: "any", timeout_ms: 1000 }, makeCtx(store));

    expect(parseResult(output)).toEqual({ status: "error", message: "session_ids must not be empty" });
  });

  test("returns error for unknown child session IDs", async () => {
    const store = makeStore(["child-1"]);
    const output = await waitForReminderTool.execute(
      { session_ids: ["child-1", "missing"], condition: "any", timeout_ms: 1000 },
      makeCtx(store),
    );

    expect(parseResult(output)).toEqual({
      status: "error",
      message: "Unknown session_id: missing",
      unknown_ids: ["missing"],
    });
  });

  test("consumes an already-present matching on-demand reminder for any condition", async () => {
    const store = makeStore(["child-1"]);
    store.getState().append({ type: "reminder", reminder: makeReminder({ id: "rem-1", sessionId: "child-1" }) });

    const output = await waitForReminderTool.execute(
      { session_ids: ["child-1"], condition: "any", timeout_ms: 1000 },
      makeCtx(store),
    );

    const result = parseResult(output);
    expect(result.status).toBe("success");
    expect(result.consumed_ids).toEqual(["rem-1"]);
    expect((result.reminders as Reminder[])[0]?.id).toBe("rem-1");
    expect(store.getState().reminders[0]?.consumedAt).toBeNumber();
  });

  test("ignores consumed, auto-inject, and non-target reminders", async () => {
    const store = makeStore(["child-1", "child-2"]);
    store.getState().append({ type: "reminder", reminder: makeReminder({ id: "consumed", sessionId: "child-1" }) });
    store.getState().append({ type: "reminder-consumed", reminderIds: ["consumed"] });
    store.getState().append({ type: "reminder", reminder: makeReminder({ id: "auto", sessionId: "child-1", delivery: "auto_inject" }) });
    store.getState().append({ type: "reminder", reminder: makeReminder({ id: "other", sessionId: "child-2" }) });

    const output = await waitForReminderTool.execute(
      { session_ids: ["child-1"], condition: "any", timeout_ms: 20 },
      makeCtx(store),
    );

    expect(parseResult(output)).toEqual({ status: "timeout", pending: ["child-1"] });
    expect(store.getState().reminders.find((reminder) => reminder.id === "other")?.consumedAt).toBeNull();
  });

  test("waits until all requested sessions have reminders", async () => {
    const store = makeStore(["child-1", "child-2"]);
    const promise = waitForReminderTool.execute(
      { session_ids: ["child-1", "child-2"], condition: "all", timeout_ms: 1000 },
      makeCtx(store),
    );

    store.getState().append({ type: "reminder", reminder: makeReminder({ id: "rem-1", sessionId: "child-1" }) });
    await Bun.sleep(5);
    expect(store.getState().reminders.find((reminder) => reminder.id === "rem-1")?.consumedAt).toBeNull();

    store.getState().append({ type: "reminder", reminder: makeReminder({ id: "rem-2", sessionId: "child-2" }) });
    const result = parseResult(await promise);

    expect(result.status).toBe("success");
    expect(result.consumed_ids).toEqual(["rem-1", "rem-2"]);
    expect(store.getState().reminders.every((reminder) => reminder.consumedAt !== null)).toBe(true);
  });

  test("waits until count condition is met", async () => {
    const store = makeStore(["child-1", "child-2", "child-3"]);
    const promise = waitForReminderTool.execute(
      { session_ids: ["child-1", "child-2", "child-3"], condition: { count: 2 }, timeout_ms: 1000 },
      makeCtx(store),
    );

    store.getState().append({ type: "reminder", reminder: makeReminder({ id: "rem-1", sessionId: "child-1" }) });
    store.getState().append({ type: "reminder", reminder: makeReminder({ id: "rem-2", sessionId: "child-2" }) });
    const result = parseResult(await promise);

    expect(result.status).toBe("success");
    expect(result.consumed_ids).toEqual(["rem-1", "rem-2"]);
  });

  test("returns timeout with pending session IDs", async () => {
    const store = makeStore(["child-1", "child-2"]);
    store.getState().append({ type: "reminder", reminder: makeReminder({ id: "rem-1", sessionId: "child-1" }) });

    const output = await waitForReminderTool.execute(
      { session_ids: ["child-1", "child-2"], condition: "all", timeout_ms: 20 },
      makeCtx(store),
    );

    expect(parseResult(output)).toEqual({ status: "timeout", pending: ["child-2"] });
    expect(store.getState().reminders[0]?.consumedAt).toBeNull();
  });

  test("returns aborted and unsubscribes when abort signal fires", async () => {
    const store = makeStore(["child-1"]);
    const abort = new AbortController();
    const promise = waitForReminderTool.execute(
      { session_ids: ["child-1"], condition: "any", timeout_ms: 1000 },
      makeCtx(store, abort),
    );

    abort.abort();
    expect(parseResult(await promise)).toEqual({ status: "aborted" });

    store.getState().append({ type: "reminder", reminder: makeReminder({ id: "late", sessionId: "child-1" }) });
    expect(store.getState().reminders[0]?.consumedAt).toBeNull();
  });

  test("returns aborted immediately if signal is already aborted", async () => {
    const store = makeStore(["child-1"]);
    const abort = new AbortController();
    abort.abort();

    const output = await waitForReminderTool.execute(
      { session_ids: ["child-1"], condition: "any", timeout_ms: 1000 },
      makeCtx(store, abort),
    );

    expect(parseResult(output)).toEqual({ status: "aborted" });
  });
});
