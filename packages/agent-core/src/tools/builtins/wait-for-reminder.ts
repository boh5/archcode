import { z } from "zod";
import { defineTool } from "../define-tool";
import { createTextToolResult } from "../results";
import type { Reminder } from "../../store/types";
import type { ToolExecutionContext } from "../types";
import type { SessionExecutionRecord } from "@archcode/protocol";

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

export interface WaitForReminderDeadlineHandle {
  readonly id?: unknown;
}

export interface WaitForReminderScheduler {
  schedule(delayMs: number, callback: () => void): WaitForReminderDeadlineHandle;
  cancel(handle: WaitForReminderDeadlineHandle): void;
}

const systemWaitForReminderScheduler: WaitForReminderScheduler = {
  schedule: (delayMs, callback) => {
    const id = setTimeout(callback, delayMs);
    return { id };
  },
  cancel: (handle) => {
    if (handle.id !== undefined) clearTimeout(handle.id as Timer);
  },
};

function getMatchingReminders(
  reminders: readonly Reminder[],
  sessionIds: readonly string[],
  latestExecutions: ReadonlyMap<string, SessionExecutionRecord | undefined>,
): Reminder[] {
  const wanted = new Set(sessionIds);
  return reminders.filter(
    (reminder) => {
      if (
        reminder.delivery !== "on_demand"
        || reminder.consumedAt !== null
        || reminder.sessionId === undefined
        || !wanted.has(reminder.sessionId)
      ) return false;
      const latest = latestExecutions.get(reminder.sessionId);
      if (latest === undefined || latest.status === "running" || latest.status === "suspended") return false;
      if (reminder.source.type === "queue_dispatch_blocked") {
        return reminder.source.blockedAfterExecutionId === latest.id;
      }
      if (!reminder.source.type.startsWith("subagent_") || !("childExecutionId" in reminder.source)) {
        return false;
      }
      return reminder.source.childExecutionId === latest.id;
    },
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
  latestExecutions: ReadonlyMap<string, SessionExecutionRecord | undefined>,
): Reminder[] | undefined {
  const matchingReminders = distinctRemindersBySession(
    getMatchingReminders(reminders, sessionIds, latestExecutions),
  );
  if (!isConditionSatisfied(matchingReminders, sessionIds, condition)) return undefined;
  return selectRemindersToConsume(matchingReminders, sessionIds, condition);
}

function distinctRemindersBySession(reminders: readonly Reminder[]): Reminder[] {
  const selected = new Map<string, Reminder>();
  for (const reminder of reminders) {
    if (reminder.sessionId !== undefined && !selected.has(reminder.sessionId)) {
      selected.set(reminder.sessionId, reminder);
    }
  }
  return [...selected.values()];
}

function consumeReminders(input: { reminders: Reminder[] }): Extract<WaitForReminderResult, { status: "success" }> {
  return {
    status: "success",
    reminders: input.reminders,
    consumed_ids: input.reminders.map((reminder) => reminder.id),
  };
}

type ReminderConsumeAttempt =
  | { readonly kind: "pending" }
  | { readonly kind: "conflict" }
  | {
      readonly kind: "committed";
      readonly value: Extract<WaitForReminderResult, { status: "success" }>;
    };

export async function executeWaitForReminder(
  input: WaitForReminderInput,
  ctx: ToolExecutionContext,
  scheduler: WaitForReminderScheduler = systemWaitForReminderScheduler,
): Promise<string> {
  if (input.session_ids.length === 0) {
    return JSON.stringify({ status: "error", message: "session_ids must not be empty" } satisfies WaitForReminderResult);
  }
  if (
    typeof input.condition === "object"
    && input.condition.count > new Set(input.session_ids).size
  ) {
    return JSON.stringify({
      status: "error",
      message: "condition.count must not exceed the number of distinct session_ids",
    } satisfies WaitForReminderResult);
  }

  if (ctx.abort.aborted) {
    return JSON.stringify({ status: "aborted" } satisfies WaitForReminderResult);
  }

  const childError = await validateDirectChildren(ctx, input.session_ids);
  if (childError !== undefined) {
    return JSON.stringify({ status: "error", message: childError } satisfies WaitForReminderResult);
  }

  const result = await waitForMatch(input, ctx, scheduler);
  return JSON.stringify(result);
}

function waitForMatch(
  input: WaitForReminderInput,
  ctx: ToolExecutionContext,
  scheduler: WaitForReminderScheduler,
): Promise<WaitForReminderResult> {
  return new Promise((resolve) => {
    let settled = false;
    let checking = false;
    let recheck = false;
    let terminalRequested: "timeout" | "aborted" | undefined;
    let consumptionCommitted = false;
    let unsubscribe: (() => void) | undefined;
    let timeout: WaitForReminderDeadlineHandle | undefined;

    const cleanup = () => {
      if (timeout !== undefined) scheduler.cancel(timeout);
      unsubscribe?.();
      ctx.abort.removeEventListener("abort", onAbort);
    };

    const settle = (result: WaitForReminderResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const check = async () => {
      if (settled) return;
      if (checking) {
        recheck = true;
        return;
      }
      checking = true;
      try {
        const consumed = await tryConsumeSatisfiedReminders(
          input,
          ctx,
          () => terminalRequested === undefined && !settled,
          () => { consumptionCommitted = true; },
        );
        if (consumed !== undefined) settle(consumed);
      } catch (error) {
        settle({ status: "error", message: error instanceof Error ? error.message : String(error) });
      } finally {
        checking = false;
        if (recheck && !settled) {
          recheck = false;
          void check();
        }
      }
    };

    const onAbort = () => {
      if (settled || consumptionCommitted || terminalRequested !== undefined) return;
      terminalRequested = "aborted";
      settle({ status: "aborted" });
    };

    // Subscribe first so reminders arriving during setup cannot be missed.
    unsubscribe = ctx.store.subscribe(() => { void check(); });
    ctx.abort.addEventListener("abort", onAbort, { once: true });
    timeout = scheduler.schedule(input.timeout_ms, () => {
      if (settled || consumptionCommitted) return;
      terminalRequested ??= "timeout";
      void latestChildExecutions(ctx, input.session_ids).then((latest) => {
        const matchingReminders = getMatchingReminders(ctx.store.getState().reminders, input.session_ids, latest);
        settle({ status: "timeout", pending: pendingSessionIds(matchingReminders, input.session_ids) });
      }, (error) => {
        settle({ status: "error", message: error instanceof Error ? error.message : String(error) });
      });
    });

    if (ctx.abort.aborted) {
      onAbort();
      return;
    }

    void check();
  });
}

async function validateDirectChildren(
  ctx: ToolExecutionContext,
  sessionIds: readonly string[],
): Promise<string | undefined> {
  const parent = ctx.store.getState();
  for (const sessionId of new Set(sessionIds)) {
    const child = await ctx.storeManager.getOrLoad(
      sessionId,
      ctx.projectContext.project.workspaceRoot,
    ).catch(() => undefined);
    if (
      child === undefined
      || child.getState().parentSessionId !== parent.sessionId
      || child.getState().rootSessionId !== parent.rootSessionId
    ) return `Session ${sessionId} is not a direct child of ${parent.sessionId}`;
  }
  return undefined;
}

async function latestChildExecutions(
  ctx: ToolExecutionContext,
  sessionIds: readonly string[],
): Promise<ReadonlyMap<string, SessionExecutionRecord | undefined>> {
  const snapshots = await latestChildExecutionSnapshots(ctx, sessionIds);
  return new Map(
    [...snapshots].map(([sessionId, snapshot]) => [sessionId, snapshot.execution]),
  );
}

interface LatestChildExecutionSnapshot {
  readonly execution: SessionExecutionRecord | undefined;
  readonly revision: number;
  readonly readCurrent: () => {
    readonly execution: SessionExecutionRecord | undefined;
    readonly revision: number;
  };
}

async function latestChildExecutionSnapshots(
  ctx: ToolExecutionContext,
  sessionIds: readonly string[],
): Promise<ReadonlyMap<string, LatestChildExecutionSnapshot>> {
  const snapshots = new Map<string, LatestChildExecutionSnapshot>();
  for (const sessionId of new Set(sessionIds)) {
    const child = await ctx.storeManager.getOrLoad(
      sessionId,
      ctx.projectContext.project.workspaceRoot,
    );
    const state = child.getState();
    snapshots.set(sessionId, {
      execution: state.executions.at(-1),
      revision: state.nextEventId,
      readCurrent: () => {
        const current = child.getState();
        return {
          execution: current.executions.at(-1),
          revision: current.nextEventId,
        };
      },
    });
  }
  return snapshots;
}

function areLatestChildSnapshotsCurrent(
  snapshots: ReadonlyMap<string, LatestChildExecutionSnapshot>,
): boolean {
  for (const snapshot of snapshots.values()) {
    const current = snapshot.readCurrent();
    if (
      current.revision !== snapshot.revision
      || current.execution?.id !== snapshot.execution?.id
    ) return false;
  }
  return true;
}

async function tryConsumeSatisfiedReminders(
  input: WaitForReminderInput,
  ctx: ToolExecutionContext,
  canConsume: () => boolean,
  onConsumptionCommitted: () => void,
): Promise<WaitForReminderResult | undefined> {
  while (canConsume()) {
    const snapshots = await latestChildExecutionSnapshots(ctx, input.session_ids);
    const latest = new Map(
      [...snapshots].map(([sessionId, snapshot]) => [sessionId, snapshot.execution]),
    );
    const attempt = await ctx.storeManager.commitDurableSessionMutation<ReminderConsumeAttempt>(
      ctx.store.getState().sessionId,
      ctx.projectContext.project.workspaceRoot,
      (state) => {
        if (!canConsume()) return { result: { kind: "pending" } as const };
        if (!areLatestChildSnapshotsCurrent(snapshots)) {
          return { result: { kind: "conflict" } as const };
        }
        const satisfied = findSatisfiedReminders(
          state.reminders,
          input.session_ids,
          input.condition,
          latest,
        );
        if (satisfied === undefined) return { result: { kind: "pending" } as const };
        if (!areLatestChildSnapshotsCurrent(snapshots)) {
          return { result: { kind: "conflict" } as const };
        }
        const result = consumeReminders({ reminders: satisfied });
        onConsumptionCommitted();
        return {
          result: { kind: "committed", value: result } as const,
          events: [{
            type: "reminder-consumed",
            reminderIds: result.consumed_ids,
          }],
        };
      },
    );
    if (attempt.kind === "committed") return attempt.value;
    if (attempt.kind === "pending") return undefined;
  }
  return undefined;
}

export const waitForReminderTool = defineTool({
  name: "wait_for_reminder",
  description: [
    "Wait once for delegated task completion by consuming unconsumed on-demand terminal reminders already queued or arriving for specified background child Session IDs. Use it after launching all independent background children, not as a polling loop.",
    "",
    "Example: `wait_for_reminder({\"session_ids\":[\"<session-a>\",\"<session-b>\"],\"condition\":\"all\",\"timeout_ms\":1800000})`. Use `any` when the first completed child unblocks work, `all` when every child is required, or `{\"count\":2}` for the first two distinct Sessions.",
    "",
    "The call consumes only the reminders used to satisfy the condition and returns terminal metadata, not child output. After success, call background_output with block=true for every returned Session ID whose final response matters. Timeout or abort returns status without consuming reminders; do not poll.",
  ].join("\n"),
  inputSchema: WaitForReminderInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: true },
  outputPolicy: { kind: "inline", previewDirection: "head" },
  execute: async (input, ctx) => createTextToolResult(await executeWaitForReminder(input, ctx)),
});
