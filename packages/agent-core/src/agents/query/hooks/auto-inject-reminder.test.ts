import { describe, expect, mock, test } from "bun:test";
import type { ModelMessage } from "ai";
import type { BeforeModelCallContext } from "../loop-hooks";
import { storeManager } from "../../../store/store";
import type { Reminder } from "../../../store/types";
import { createAutoInjectReminderHook } from "./auto-inject-reminder";

function createReminder(overrides: Partial<Reminder> = {}): Reminder {
  const id = overrides.id ?? crypto.randomUUID();

  return {
    id,
    source: { type: "todo_step_reminder", pendingTodos: [] },
    delivery: "auto_inject",
    content: `Reminder ${id}`,
    createdAt: Date.now(),
    consumedAt: null,
    ...overrides,
  };
}

function createContext(messages: ModelMessage[] = []): BeforeModelCallContext {
  return {
    store: storeManager.create(crypto.randomUUID()),
    modelInfo: undefined as never,
    messages,
  };
}

function addReminder(ctx: BeforeModelCallContext, reminder: Reminder): void {
  ctx.store.getState().append({ type: "reminder", reminder });
}

describe("createAutoInjectReminderHook", () => {
  test("injects unconsumed auto-inject reminders into messages", async () => {
    const ctx = createContext();
    addReminder(ctx, createReminder({ id: "reminder-1", content: "Check this" }));

    await createAutoInjectReminderHook()(ctx);

    expect(ctx.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<system-reminder>\nCheck this\n</system-reminder>",
          },
        ],
      },
    ]);
  });

  test("marks injected reminders as consumed in store", async () => {
    const ctx = createContext();
    addReminder(ctx, createReminder({ id: "reminder-1" }));

    await createAutoInjectReminderHook()(ctx);

    expect(ctx.store.getState().reminders[0]?.consumedAt).toEqual(expect.any(Number));
  });

  test("injects multiple reminders sorted by createdAt", async () => {
    const ctx = createContext();
    addReminder(ctx, createReminder({ id: "newer", content: "Newer", createdAt: 30 }));
    addReminder(ctx, createReminder({ id: "older", content: "Older", createdAt: 10 }));
    addReminder(ctx, createReminder({ id: "middle", content: "Middle", createdAt: 20 }));

    await createAutoInjectReminderHook()(ctx);

    expect(ctx.messages.map((message) => message.content)).toEqual([
      [{ type: "text", text: "<system-reminder>\nOlder\n</system-reminder>" }],
      [{ type: "text", text: "<system-reminder>\nMiddle\n</system-reminder>" }],
      [{ type: "text", text: "<system-reminder>\nNewer\n</system-reminder>" }],
    ]);
  });

  test("does NOT inject on-demand reminders", async () => {
    const ctx = createContext();
    addReminder(
      ctx,
      createReminder({
        id: "on-demand",
        delivery: "on_demand",
        content: "Only on demand",
      }),
    );

    await createAutoInjectReminderHook()(ctx);

    expect(ctx.messages).toEqual([]);
    expect(ctx.store.getState().reminders[0]?.consumedAt).toBeNull();
  });

  test("does NOT inject already-consumed reminders", async () => {
    const ctx = createContext();
    const reminder = createReminder({ id: "consumed", content: "Already done" });
    addReminder(ctx, reminder);
    ctx.store.getState().append({ type: "reminder-consumed", reminderIds: [reminder.id] });

    await createAutoInjectReminderHook()(ctx);

    expect(ctx.messages).toEqual([]);
  });

  test("does NOT modify store.messages, only context.messages", async () => {
    const ctx = createContext();
    addReminder(ctx, createReminder({ id: "reminder-1", content: "Transient" }));
    const storeMessagesBefore = ctx.store.getState().messages;

    await createAutoInjectReminderHook()(ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.store.getState().messages).toBe(storeMessagesBefore);
    expect(ctx.store.getState().messages).toEqual([]);
  });

  test("no-op when no unconsumed auto-inject reminders exist", async () => {
    const messages: ModelMessage[] = [{ role: "user", content: "Hello" }];
    const ctx = createContext(messages);
    const append = mock(ctx.store.getState().append);
    ctx.store.setState({ append });

    await createAutoInjectReminderHook()(ctx);

    expect(ctx.messages).toBe(messages);
    expect(ctx.messages).toEqual([{ role: "user", content: "Hello" }]);
    expect(append).not.toHaveBeenCalled();
  });
});
