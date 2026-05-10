import type { BeforeModelCallContext } from "../loop-hooks";

export function createAutoInjectReminderHook(): (
  ctx: BeforeModelCallContext,
) => Promise<void> {
  return async (ctx: BeforeModelCallContext): Promise<void> => {
    const state = ctx.store.getState();
    const unconsumedAutoInject = state.reminders.filter(
      (reminder) =>
        reminder.delivery === "auto_inject" && reminder.consumedAt === null,
    );

    if (unconsumedAutoInject.length === 0) return;

    const sorted = [...unconsumedAutoInject].sort(
      (a, b) => a.createdAt - b.createdAt,
    );

    for (const reminder of sorted) {
      ctx.messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `<system-reminder>\n${reminder.content}\n</system-reminder>`,
          },
        ],
      });
    }

    ctx.store.getState().append({
      type: "reminder-consumed",
      reminderIds: unconsumedAutoInject.map((reminder) => reminder.id),
    });
  };
}
