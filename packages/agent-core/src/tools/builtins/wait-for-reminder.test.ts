import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import type { StoreApi } from "zustand";
import { storeManager } from "../../store/store";
import type { Reminder, SessionStoreState } from "../../store/types";
import type { ToolExecutionContext } from "../types";
import { createBuiltinToolDescriptors, waitForReminderTool, WaitForReminderInputSchema } from "./index";
import {
  executeWaitForReminder,
  type WaitForReminderDeadlineHandle,
  type WaitForReminderScheduler,
} from "./wait-for-reminder";
import { createTestProjectContext } from "../test-project-context";
import { expectTextDraft } from "../test-results";
import { testExecutionEnd, testExecutionStart } from "../../testing/test-execution-fixtures";
import type { SessionStoreManager } from "../../store/session-store-manager";

const testDir = join(tmpdir(), "archcode-wait-for-reminder", crypto.randomUUID());

function makeStore(): StoreApi<SessionStoreState> {
  mkdirSync(testDir, { recursive: true });
  const store = storeManager.create(crypto.randomUUID(), testDir, { source: { kind: "direct" }, agentName: "lead" });
  store.setState({ rootSessionId: store.getState().sessionId });
  return store;
}

function makeCtx(
  store: StoreApi<SessionStoreState>,
  abort = new AbortController(),
  manager: SessionStoreManager = storeManager,
): ToolExecutionContext {
  return {
    store,
    storeManager: manager,
    toolName: "wait_for_reminder",
    toolCallId: "call-1",
    input: {},
    step: 1,
    executionId: "test-execution",
    runOrdinal: 0,
    toolBatchId: "test-tool-batch",
    abort: abort.signal,
    startedAt: Date.now(),
    allowedTools: new Set(["wait_for_reminder"]),
    cwd: testDir,
    projectContext: createTestProjectContext(testDir),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function delayDurableMutationUntil(release: Promise<void>): {
  manager: SessionStoreManager;
  entered: Promise<void>;
} {
  const entered = deferred<void>();
  const manager = new Proxy(storeManager, {
    get(target, property, receiver) {
      if (property === "commitDurableSessionMutation") {
        return async (...args: Parameters<SessionStoreManager["commitDurableSessionMutation"]>) => {
          entered.resolve(undefined);
          await release;
          return await target.commitDurableSessionMutation(...args);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { manager, entered: entered.promise };
}

function makeTerminalChild(parent: StoreApi<SessionStoreState>, label: string) {
  void label;
  const sessionId = crypto.randomUUID();
  const executionId = `execution-${crypto.randomUUID()}`;
  const child = storeManager.create(sessionId, testDir, {
    rootSessionId: parent.getState().rootSessionId,
    parentSessionId: parent.getState().sessionId,
    agentName: "explore",
  });
  child.getState().append(testExecutionStart(executionId));
  const endedAt = Date.now() + 1;
  child.getState().append(testExecutionEnd(executionId, "completed", { endedAt, runEndedAt: endedAt }));
  return { sessionId, childExecutionId: executionId };
}

function makeReminder(overrides: Partial<Reminder> & { sessionId: string; childExecutionId: string; id: string }): Reminder {
  const { id, sessionId, childExecutionId, ...rest } = overrides;
  return {
    id,
    source: { type: "subagent_completed", sessionId, childExecutionId },
    delivery: "on_demand",
    sessionId,
    content: `Reminder for ${sessionId}`,
    createdAt: Date.now(),
    consumedAt: null,
    ...rest,
  };
}

function parseResult(output: Awaited<ReturnType<typeof waitForReminderTool.execute>>): Record<string, unknown> {
  return JSON.parse(expectTextDraft(output)) as Record<string, unknown>;
}

function createManualDeadlineScheduler(): {
  scheduler: WaitForReminderScheduler;
  fire: () => void;
  scheduledDelays: number[];
  cancelled: WaitForReminderDeadlineHandle[];
} {
  let callback: (() => void) | undefined;
  const scheduledDelays: number[] = [];
  const cancelled: WaitForReminderDeadlineHandle[] = [];
  const handle = { id: Symbol("wait-for-reminder-deadline") };
  return {
    scheduler: {
      schedule(delayMs, nextCallback) {
        scheduledDelays.push(delayMs);
        callback = nextCallback;
        return handle;
      },
      cancel(cancelledHandle) {
        cancelled.push(cancelledHandle);
      },
    },
    fire() {
      const pending = callback;
      callback = undefined;
      if (pending === undefined) throw new Error("No reminder deadline is scheduled");
      pending();
    },
    scheduledDelays,
    cancelled,
  };
}

describe("WaitForReminderInputSchema", () => {
  test("accepts valid input and applies defaults", () => {
    const result = WaitForReminderInputSchema.safeParse({ session_ids: ["child-1"] });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.condition).toBe("any");
      expect(result.data.timeout_ms).toBe(1_800_000);
    }
  });

  test("accepts all and count conditions", () => {
    expect(WaitForReminderInputSchema.safeParse({ session_ids: ["a"], condition: "all" }).success).toBe(true);
    expect(WaitForReminderInputSchema.safeParse({ session_ids: ["a"], condition: { count: 2 } }).success).toBe(true);
  });

  test("rejects unknown fields and out-of-range timeout", () => {
    expect(WaitForReminderInputSchema.safeParse({ session_ids: ["a"], extra: true }).success).toBe(false);
    expect(WaitForReminderInputSchema.safeParse({ session_ids: ["a"], timeout_ms: 999 }).success).toBe(false);
    expect(WaitForReminderInputSchema.safeParse({ session_ids: ["a"], timeout_ms: 1_800_001 }).success).toBe(false);
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

  test("rejects a count larger than the distinct child set", async () => {
    const store = makeStore();
    const child = makeTerminalChild(store, "child-1");
    const output = await waitForReminderTool.execute({
      session_ids: [child.sessionId, child.sessionId],
      condition: { count: 2 },
      timeout_ms: 1000,
    }, makeCtx(store));

    expect(parseResult(output)).toEqual({
      status: "error",
      message: "condition.count must not exceed the number of distinct session_ids",
    });
  });

  test("consumes an already-present matching on-demand reminder for any condition", async () => {
    const store = makeStore();
    const child = makeTerminalChild(store, "child-1");
    store.getState().append({ type: "reminder", reminder: makeReminder({ id: "rem-1", ...child }) });

    const output = await waitForReminderTool.execute(
      { session_ids: [child.sessionId], condition: "any", timeout_ms: 1000 },
      makeCtx(store),
    );

    const result = parseResult(output);
    expect(result.status).toBe("success");
    expect(result.consumed_ids).toEqual(["rem-1"]);
    expect((result.reminders as Reminder[])[0]?.id).toBe("rem-1");
    expect(store.getState().reminders[0]?.consumedAt).toBeNumber();
  });

  test("timeout ignores consumed, auto-inject, and non-target reminders", async () => {
    const store = makeStore();
    const child = makeTerminalChild(store, "child-1");
    const other = makeTerminalChild(store, "child-2");
    store.getState().append({ type: "reminder", reminder: makeReminder({ id: "consumed", ...child }) });
    store.getState().append({ type: "reminder-consumed", reminderIds: ["consumed"] });
    store.getState().append({ type: "reminder", reminder: makeReminder({ id: "auto", ...child, delivery: "auto_inject" }) });
    store.getState().append({ type: "reminder", reminder: makeReminder({ id: "other", ...other }) });
    const deadline = createManualDeadlineScheduler();

    const pending = executeWaitForReminder(
      { session_ids: [child.sessionId], condition: "any", timeout_ms: 20 },
      makeCtx(store),
      deadline.scheduler,
    );
    while (deadline.scheduledDelays.length === 0) await Bun.sleep(0);
    deadline.fire();

    expect(JSON.parse(await pending)).toEqual({ status: "timeout", pending: [child.sessionId] });
    expect(deadline.scheduledDelays).toEqual([20]);
    expect(deadline.cancelled).toHaveLength(1);
    expect(store.getState().reminders.find((reminder) => reminder.id === "other")?.consumedAt).toBeNull();
  });

  test("waits until all requested sessions have reminders", async () => {
    const store = makeStore();
    const child1 = makeTerminalChild(store, "child-1");
    const child2 = makeTerminalChild(store, "child-2");
    const promise = waitForReminderTool.execute(
      { session_ids: [child1.sessionId, child2.sessionId], condition: "all", timeout_ms: 1000 },
      makeCtx(store),
    );

    store.getState().append({ type: "reminder", reminder: makeReminder({ id: "rem-1", ...child1 }) });
    store.getState().append({ type: "reminder", reminder: makeReminder({ id: "rem-2", ...child2 }) });
    const result = parseResult(await promise);

    expect(result.status).toBe("success");
    expect(result.consumed_ids).toEqual(["rem-1", "rem-2"]);
    expect(store.getState().reminders.every((reminder) => reminder.consumedAt !== null)).toBe(true);
  });

  test("count condition uses distinct sessions because terminal reminders are deduped by session", async () => {
    const store = makeStore();
    const child1 = makeTerminalChild(store, "child-1");
    const child2 = makeTerminalChild(store, "child-2");
    const promise = waitForReminderTool.execute(
      { session_ids: [child1.sessionId, child2.sessionId], condition: { count: 2 }, timeout_ms: 1000 },
      makeCtx(store),
    );

    store.getState().append({ type: "reminder", reminder: makeReminder({ id: "rem-1", ...child1 }) });
    store.getState().append({
      type: "reminder",
      reminder: makeReminder({
        id: "same-child-blocked",
        ...child1,
        source: {
          type: "queue_dispatch_blocked",
          sessionId: child1.sessionId,
          blockedAfterExecutionId: child1.childExecutionId,
          error: "blocked",
        },
      }),
    });
    expect(store.getState().reminders.map((reminder) => reminder.id)).toEqual(["rem-1", "same-child-blocked"]);

    store.getState().append({ type: "reminder", reminder: makeReminder({ id: "rem-2", ...child2 }) });
    const result = parseResult(await promise);

    expect(result.status).toBe("success");
    expect(result.consumed_ids).toEqual(["rem-1", "rem-2"]);
    expect(store.getState().reminders.find((reminder) => reminder.id === "rem-1")?.consumedAt).toBeNumber();
    expect(store.getState().reminders.find((reminder) => reminder.id === "rem-2")?.consumedAt).toBeNumber();
    expect(store.getState().reminders.find((reminder) => reminder.id === "same-child-blocked")?.consumedAt).toBeNull();
  });

  test("timeout reports only sessions that are still pending without consuming matches", async () => {
    const store = makeStore();
    const child1 = makeTerminalChild(store, "child-1");
    const child2 = makeTerminalChild(store, "child-2");
    store.getState().append({ type: "reminder", reminder: makeReminder({ id: "rem-1", ...child1 }) });
    const deadline = createManualDeadlineScheduler();

    const pending = executeWaitForReminder(
      { session_ids: [child1.sessionId, child2.sessionId], condition: "all", timeout_ms: 20 },
      makeCtx(store),
      deadline.scheduler,
    );
    while (deadline.scheduledDelays.length === 0) await Bun.sleep(0);
    deadline.fire();

    expect(JSON.parse(await pending)).toEqual({ status: "timeout", pending: [child2.sessionId] });
    expect(store.getState().reminders[0]?.consumedAt).toBeNull();
  });

  test("returns aborted and unsubscribes when abort signal fires", async () => {
    const store = makeStore();
    const child = makeTerminalChild(store, "child-1");
    const abort = new AbortController();
    const promise = waitForReminderTool.execute(
      { session_ids: [child.sessionId], condition: "any", timeout_ms: 1000 },
      makeCtx(store, abort),
    );

    abort.abort();
    expect(parseResult(await promise)).toEqual({ status: "aborted" });

    store.getState().append({ type: "reminder", reminder: makeReminder({ id: "late", ...child }) });
    expect(store.getState().reminders[0]?.consumedAt).toBeNull();
  });

  test("timeout wins before an in-flight durable consume and leaves the reminder unconsumed", async () => {
    const store = makeStore();
    const child = makeTerminalChild(store, "child-timeout-race");
    store.getState().append({ type: "reminder", reminder: makeReminder({ id: "timeout-race", ...child }) });
    const release = deferred<void>();
    const delayedMutation = delayDurableMutationUntil(release.promise);
    const deadline = createManualDeadlineScheduler();
    const pending = executeWaitForReminder(
      { session_ids: [child.sessionId], condition: "any", timeout_ms: 20 },
      makeCtx(store, new AbortController(), delayedMutation.manager),
      deadline.scheduler,
    );
    while (deadline.scheduledDelays.length === 0) await Bun.sleep(0);
    await delayedMutation.entered;

    deadline.fire();
    release.resolve(undefined);

    expect(JSON.parse(await pending)).toEqual({ status: "timeout", pending: [] });
    await Bun.sleep(0);
    expect(store.getState().reminders[0]?.consumedAt).toBeNull();
  });

  test("timeout remains the first winner when abort arrives during its latest-child read", async () => {
    const store = makeStore();
    const child = makeTerminalChild(store, "child-timeout-abort-order");
    const initialLatestRead = deferred<void>();
    const timeoutLatestRead = deferred<void>();
    const releaseTimeoutRead = deferred<void>();
    let getOrLoadCalls = 0;
    const manager = new Proxy(storeManager, {
      get(target, property, receiver) {
        if (property === "getOrLoad") {
          return async (...args: Parameters<SessionStoreManager["getOrLoad"]>) => {
            getOrLoadCalls += 1;
            if (getOrLoadCalls === 2) initialLatestRead.resolve(undefined);
            if (getOrLoadCalls === 3) {
              timeoutLatestRead.resolve(undefined);
              await releaseTimeoutRead.promise;
            }
            return await target.getOrLoad(...args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const abort = new AbortController();
    const deadline = createManualDeadlineScheduler();
    const pending = executeWaitForReminder(
      { session_ids: [child.sessionId], condition: "any", timeout_ms: 20 },
      makeCtx(store, abort, manager),
      deadline.scheduler,
    );
    await initialLatestRead.promise;

    deadline.fire();
    await timeoutLatestRead.promise;
    abort.abort();
    releaseTimeoutRead.resolve(undefined);

    expect(JSON.parse(await pending)).toEqual({ status: "timeout", pending: [child.sessionId] });
  });

  test("abort wins before an in-flight durable consume and leaves the reminder unconsumed", async () => {
    const store = makeStore();
    const child = makeTerminalChild(store, "child-abort-race");
    store.getState().append({ type: "reminder", reminder: makeReminder({ id: "abort-race", ...child }) });
    const abort = new AbortController();
    const release = deferred<void>();
    const delayedMutation = delayDurableMutationUntil(release.promise);
    const pending = executeWaitForReminder(
      { session_ids: [child.sessionId], condition: "any", timeout_ms: 1000 },
      makeCtx(store, abort, delayedMutation.manager),
    );

    await delayedMutation.entered;
    abort.abort();
    release.resolve(undefined);

    expect(JSON.parse(await pending)).toEqual({ status: "aborted" });
    await Bun.sleep(0);
    expect(store.getState().reminders[0]?.consumedAt).toBeNull();
  });

  test("does not consume a stale terminal reminder when a newer child execution starts before the parent mutation", async () => {
    const store = makeStore();
    const child = makeTerminalChild(store, "child-latest-execution-race");
    store.getState().append({ type: "reminder", reminder: makeReminder({ id: "stale-e1", ...child }) });
    const childStore = await storeManager.getOrLoad(child.sessionId, testDir);
    const abort = new AbortController();
    const release = deferred<void>();
    const delayedMutation = delayDurableMutationUntil(release.promise);
    let settled = false;
    const pending = executeWaitForReminder(
      { session_ids: [child.sessionId], condition: "any", timeout_ms: 1000 },
      makeCtx(store, abort, delayedMutation.manager),
    ).then((result) => {
      settled = true;
      return result;
    });

    await delayedMutation.entered;
    childStore.getState().append(testExecutionStart(`execution-${crypto.randomUUID()}`));
    release.resolve(undefined);
    await Bun.sleep(0);
    await Bun.sleep(0);

    expect(settled).toBe(false);
    expect(store.getState().reminders.find((reminder) => reminder.id === "stale-e1")?.consumedAt).toBeNull();

    abort.abort();
    expect(JSON.parse(await pending)).toEqual({ status: "aborted" });
    expect(store.getState().reminders.find((reminder) => reminder.id === "stale-e1")?.consumedAt).toBeNull();
  });

  test("returns aborted immediately if signal is already aborted", async () => {
    const store = makeStore();
    const abort = new AbortController();
    abort.abort();

    const output = await waitForReminderTool.execute(
      { session_ids: ["child-1"], condition: "any", timeout_ms: 1000 },
      makeCtx(store, abort),
    );

    expect(parseResult(output)).toEqual({ status: "aborted" });
  });
});
