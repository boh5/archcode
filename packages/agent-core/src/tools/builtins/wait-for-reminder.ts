import { z } from "zod";
import { defineTool } from "../define-tool";
import { createTextToolResult } from "../results";
import type { Reminder } from "../../store/types";
import type { ToolExecutionContext } from "../types";

const WaitForReminderConditionSchema = z
  .enum(["all", "any"])
  .or(z.object({ count: z.number().int().min(1).describe("Positive number of distinct requested Sessions whose terminal reminders must arrive. Do not exceed the number of distinct session_ids.") }).strict())
  .describe("Return after any one requested Session, every distinct requested Session, or the first N distinct requested Sessions produce terminal reminders.");

export const WaitForReminderInputSchema = z
  .object({
    session_ids: z.array(z.string()).describe("Non-empty child Session IDs copied from background delegate or resume_session results. Pass all independent children you intend to wait for in one call."),
    condition: WaitForReminderConditionSchema.default("any").describe("`any` returns after one requested Session, `all` after every distinct requested Session, and `{ count: N }` after the first N distinct requested Sessions produce terminal reminders. Default `any`."),
    timeout_ms: z.number().int().min(1000).max(1_800_000).default(1_800_000).describe("Max wait time in ms, from 1000 to 1800000. Default 1800000 (30 minutes)."),
  })
  .strict();

export type WaitForReminderInput = z.infer<typeof WaitForReminderInputSchema>;

type WaitForReminderResult =
  | {
      status: "success";
      reminders: Reminder[];
      consumed_ids: string[];
    }
  | {
      status: "error";
      message: string;
    }
  | {
      status: "timeout";
      pending: string[];
    }
  | {
      status: "aborted";
    };

function getMatchingReminders(reminders: readonly Reminder[], sessionIds: readonly string[]): Reminder[] {
  const wanted = new Set(sessionIds);
  return reminders.filter(
    (reminder) =>
      reminder.delivery === "on_demand" &&
      reminder.consumedAt === null &&
      reminder.sessionId !== undefined &&
      wanted.has(reminder.sessionId),
  );
}

function requiredCount(condition: WaitForReminderInput["condition"], sessionIds: readonly string[]): number {
  if (condition === "any") return 1;
  if (condition === "all") return new Set(sessionIds).size;
  return condition.count;
}

function isConditionSatisfied(
  reminders: readonly Reminder[],
  sessionIds: readonly string[],
  condition: WaitForReminderInput["condition"],
): boolean {
  if (condition === "all") {
    const matchedSessionIds = new Set(reminders.map((reminder) => reminder.sessionId));
    return [...new Set(sessionIds)].every((sessionId) => matchedSessionIds.has(sessionId));
  }

  return reminders.length >= requiredCount(condition, sessionIds);
}

function selectRemindersToConsume(
  reminders: readonly Reminder[],
  sessionIds: readonly string[],
  condition: WaitForReminderInput["condition"],
): Reminder[] {
  if (condition === "all") {
    const selected = new Map<string, Reminder>();
    for (const reminder of reminders) {
      if (reminder.sessionId !== undefined && !selected.has(reminder.sessionId)) {
        selected.set(reminder.sessionId, reminder);
      }
    }
    return [...new Set(sessionIds)].map((sessionId) => selected.get(sessionId)).filter((reminder): reminder is Reminder => reminder !== undefined);
  }

  return reminders.slice(0, requiredCount(condition, sessionIds));
}

function pendingSessionIds(reminders: readonly Reminder[], sessionIds: readonly string[]): string[] {
  const matchedSessionIds = new Set(reminders.map((reminder) => reminder.sessionId));
  return [...new Set(sessionIds)].filter((sessionId) => !matchedSessionIds.has(sessionId));
}

function findSatisfiedReminders(
  reminders: readonly Reminder[],
  sessionIds: readonly string[],
  condition: WaitForReminderInput["condition"],
): Reminder[] | undefined {
  const matchingReminders = getMatchingReminders(reminders, sessionIds);
  if (!isConditionSatisfied(matchingReminders, sessionIds, condition)) return undefined;
  return selectRemindersToConsume(matchingReminders, sessionIds, condition);
}

function consumeReminders(input: { reminders: Reminder[] }): WaitForReminderResult {
  return {
    status: "success",
    reminders: input.reminders,
    consumed_ids: input.reminders.map((reminder) => reminder.id),
  };
}

export async function executeWaitForReminder(
  input: WaitForReminderInput,
  ctx: ToolExecutionContext,
): Promise<string> {
  if (input.session_ids.length === 0) {
    return JSON.stringify({ status: "error", message: "session_ids must not be empty" } satisfies WaitForReminderResult);
  }

  if (ctx.abort.aborted) {
    return JSON.stringify({ status: "aborted" } satisfies WaitForReminderResult);
  }

  const result = await waitForMatch(input, ctx);
  if (result.status === "success" && result.consumed_ids.length > 0) {
    ctx.store.getState().append({ type: "reminder-consumed", reminderIds: result.consumed_ids });
  }

  return JSON.stringify(result);
}

function waitForMatch(
  input: WaitForReminderInput,
  ctx: ToolExecutionContext,
): Promise<WaitForReminderResult> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      unsubscribe?.();
      ctx.abort.removeEventListener("abort", onAbort);
    };

    const settle = (result: WaitForReminderResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const check = () => {
      const reminders = ctx.store.getState().reminders;
      const satisfied = findSatisfiedReminders(reminders, input.session_ids, input.condition);
      if (satisfied !== undefined) {
        settle(consumeReminders({ reminders: satisfied }));
      }
    };

    const onAbort = () => settle({ status: "aborted" });

    // Subscribe first so reminders arriving during setup cannot be missed.
    unsubscribe = ctx.store.subscribe(check);
    ctx.abort.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => {
      const matchingReminders = getMatchingReminders(ctx.store.getState().reminders, input.session_ids);
      settle({ status: "timeout", pending: pendingSessionIds(matchingReminders, input.session_ids) });
    }, input.timeout_ms);

    if (ctx.abort.aborted) {
      onAbort();
      return;
    }

    check();
  });
}

export const waitForReminderTool = defineTool({
  name: "wait_for_reminder",
  description: [
    "Wait once for unconsumed on-demand terminal reminders already queued or arriving for specified background child Session IDs. Use it after launching all independent background children, not as a polling loop.",
    "",
    "Example: `wait_for_reminder({\"session_ids\":[\"<session-a>\",\"<session-b>\"],\"condition\":\"all\",\"timeout_ms\":1800000})`. Use `any` when the first completed child unblocks work, `all` when every child is required, or `{\"count\":2}` for the first two distinct Sessions.",
    "",
    "The call consumes only the reminders used to satisfy the condition and returns reminder plus terminal-status metadata, not the children's final deliverables. After success, call background_output with block=true for every returned Session ID whose result matters. Timeout or abort returns status without consuming reminders; do not repeatedly call wait_for_reminder merely to check progress.",
  ].join("\n"),
  inputSchema: WaitForReminderInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: true },
  outputPolicy: { kind: "inline", previewDirection: "head" },
  execute: async (input, ctx) => createTextToolResult(await executeWaitForReminder(input, ctx)),
});
