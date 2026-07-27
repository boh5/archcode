import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SESSION_GOAL_BLOCKED_REASON_MAX_LENGTH,
  type GoalNoticePart,
  type Reminder,
} from "@archcode/protocol";
import { silentLogger } from "../logger";
import { SessionFileSchema, sessionFileInternals } from "../store/helpers";
import { SessionStoreManager } from "../store/session-store-manager";
import { getSessionPath } from "../store/sessions-dir";
import { GoalNoticePartSchema, SessionGoalSchema } from "./schema";
import { SessionGoalService, SessionGoalServiceError } from "./service";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", crypto.randomUUID());
const manager = new SessionStoreManager({ logger: silentLogger });
const service = new SessionGoalService(manager);
const user = { kind: "user_control" } as const;
const agent = { kind: "agent" } as const;
const runtime = { kind: "runtime" } as const;

afterEach(async () => {
  manager.clearAll();
  await rm(TMP_DIR, { recursive: true, force: true });
});

async function rootSession(): Promise<string> {
  await mkdir(TMP_DIR, { recursive: true });
  const sessionId = crypto.randomUUID();
  await manager.createSessionFile(TMP_DIR, { agentName: "lead" }, sessionId);
  return sessionId;
}

function usage(totalTokens: number) {
  return {
    inputTokens: totalTokens,
    outputTokens: 0,
    totalTokens,
    reasoningTokens: 0,
    cachedInputTokens: 0,
  };
}

function pendingGoalReminders(reminders: readonly Reminder[]): Array<Reminder & {
  source: Extract<Reminder["source"], { type: "session_goal_changed" }>;
}> {
  return reminders.filter((reminder): reminder is Reminder & {
    source: Extract<Reminder["source"], { type: "session_goal_changed" }>;
  } => reminder.source.type === "session_goal_changed" && reminder.consumedAt === null);
}

function materializedGoalNotices(messages: readonly { parts: readonly unknown[] }[]): GoalNoticePart[] {
  return messages.flatMap((message) =>
    message.parts.filter((part): part is GoalNoticePart =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "goal-notice"
    )
  );
}

describe("SessionGoalSchema", () => {
  test("accepts exactly the current Goal contract", () => {
    const goal = {
      instanceId: crypto.randomUUID(),
      generation: 1,
      objective: "Ship the result.",
      status: "active" as const,
      tokenBudget: 100,
      usage: { tokens: usage(0), executionTimeMs: 0, executionCount: 0 },
      createdAt: 1,
      activatedAt: 1,
      updatedAt: 1,
    };

    expect(SessionGoalSchema.parse(goal)).toEqual(goal);
    expect(Object.keys(SessionGoalSchema.parse(goal)).sort()).toEqual([
      "activatedAt",
      "createdAt",
      "generation",
      "instanceId",
      "objective",
      "status",
      "tokenBudget",
      "updatedAt",
      "usage",
    ]);

    expect(SessionGoalSchema.safeParse({ ...goal, unexpectedField: true }).success).toBe(false);
  });

  test("enforces terminal and visible status metadata invariants", () => {
    const base = {
      instanceId: crypto.randomUUID(),
      generation: 1,
      objective: "Ship the result.",
      usage: { tokens: usage(0), executionTimeMs: 0, executionCount: 0 },
      createdAt: 1,
      activatedAt: 1,
      updatedAt: 1,
    };

    expect(SessionGoalSchema.safeParse({ ...base, status: "complete" }).success).toBe(false);
    expect(SessionGoalSchema.safeParse({ ...base, status: "active", completedAt: 2 }).success).toBe(false);
    expect(SessionGoalSchema.safeParse({ ...base, status: "paused" }).success).toBe(false);
    expect(SessionGoalSchema.safeParse({ ...base, status: "blocked" }).success).toBe(false);
    expect(SessionGoalSchema.safeParse({ ...base, status: "budget_limited", pausedAt: 2 }).success).toBe(true);
    expect(SessionGoalSchema.safeParse({ ...base, status: "budget_limited", blockedReason: "Needs input" }).success).toBe(true);
    expect(SessionGoalSchema.safeParse({
      ...base,
      status: "blocked",
      blockedReason: "x".repeat(SESSION_GOAL_BLOCKED_REASON_MAX_LENGTH + 1),
    }).success).toBe(false);
  });

  test("accepts only strict actionable Goal notice snapshots", () => {
    const notice = {
      type: "goal-notice" as const,
      id: crypto.randomUUID(),
      action: "edited" as const,
      authority: "user_control" as const,
      instanceId: crypto.randomUUID(),
      previousGeneration: 1,
      generation: 2,
      goal: { objective: "Ship it.", status: "active" as const },
      createdAt: 1,
    };
    expect(GoalNoticePartSchema.parse(notice)).toEqual(notice);
    expect(GoalNoticePartSchema.safeParse({ ...notice, previousGeneration: undefined }).success).toBe(false);
    expect(GoalNoticePartSchema.safeParse({ ...notice, generation: 3 }).success).toBe(false);
    expect(GoalNoticePartSchema.safeParse({ ...notice, authority: "runtime" }).success).toBe(false);
    expect(GoalNoticePartSchema.safeParse({ ...notice, goal: { ...notice.goal, usage: {} } }).success).toBe(false);
    expect(GoalNoticePartSchema.safeParse({
      ...notice,
      action: "completed",
      authority: "agent",
      previousGeneration: undefined,
      goal: { ...notice.goal, status: "active" },
    }).success).toBe(false);

    const created = {
      ...notice,
      action: "created" as const,
      previousGeneration: undefined,
      generation: 1,
    };
    expect(GoalNoticePartSchema.safeParse(created).success).toBe(true);
    expect(GoalNoticePartSchema.safeParse({ ...created, generation: 2 }).success).toBe(false);
  });
});

describe("SessionGoalService", () => {
  test("creates, edits, clears, and replaces the single root Lead Goal", async () => {
    const sessionId = await rootSession();
    const created = await service.create({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: user,
      objective: "  Finish the migration.  ",
    });

    expect(created).toMatchObject({ objective: "Finish the migration.", generation: 1, status: "active" });
    expect(created.tokenBudget).toBeUndefined();
    expect(Object.keys(created).sort()).toEqual([
      "activatedAt",
      "createdAt",
      "generation",
      "instanceId",
      "objective",
      "status",
      "updatedAt",
      "usage",
    ]);
    expect([...((await manager.getSessionFile(TMP_DIR, sessionId)).events ?? [])]
      .reverse().find((event) => event.payload.type === "session.goal_changed")?.payload)
      .toMatchObject({ type: "session.goal_changed", action: "created", goal: created });
    const createdReminder = pendingGoalReminders(manager.get(sessionId, TMP_DIR)!.getState().reminders);
    expect(createdReminder).toHaveLength(1);
    expect(createdReminder[0]!.source.notice).toMatchObject({
      action: "created",
      authority: "user_control",
      instanceId: created.instanceId,
      generation: 1,
      goal: {
        objective: created.objective,
        status: "active",
      },
    });

    await expect(service.create({ workspaceRoot: TMP_DIR, sessionId, authority: user, objective: "Second Goal" }))
      .rejects.toMatchObject({ code: "GOAL_ALREADY_ACTIVE" });

    const edited = await service.edit({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: user,
      expectedGeneration: 1,
      objective: "Finish the migration and tests.",
    });
    expect(edited).toMatchObject({ generation: 2, objective: "Finish the migration and tests." });
    expect(pendingGoalReminders(manager.get(sessionId, TMP_DIR)!.getState().reminders).at(-1)?.source.notice)
      .toMatchObject({
        action: "edited",
        previousGeneration: 1,
        generation: 2,
        goal: { objective: "Finish the migration and tests." },
      });
    await expect(service.edit({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: user,
      expectedGeneration: 1,
      objective: "Stale edit",
    })).rejects.toMatchObject({ code: "GENERATION_CONFLICT" });

    await service.clear({ workspaceRoot: TMP_DIR, sessionId, authority: user });
    const cleared = await manager.getSessionFile(TMP_DIR, sessionId);
    expect(cleared.goal).toBeUndefined();
    expect([...(cleared.events ?? [])].reverse()
      .find((event) => event.payload.type === "session.goal_changed")?.payload)
      .toMatchObject({ type: "session.goal_changed", action: "cleared", goal: null });
    expect(pendingGoalReminders(cleared.reminders).at(-1)?.source.notice)
      .toMatchObject({ action: "cleared", instanceId: created.instanceId, generation: 2, goal: null });

    const replacement = await service.create({ workspaceRoot: TMP_DIR, sessionId, authority: user, objective: "Replacement Goal" });
    expect(replacement.instanceId).not.toBe(created.instanceId);
    expect(replacement.generation).toBe(1);
  });

  test("materializes pending notices once in durable append order without client input fields", async () => {
    const sessionId = await rootSession();
    const created = await service.create({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: user,
      objective: "Deliver every semantic transition.",
    });
    await service.edit({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: user,
      expectedGeneration: created.generation,
      objective: "Deliver every semantic transition exactly once.",
    });
    await service.pause({ workspaceRoot: TMP_DIR, sessionId, authority: user });

    const before = manager.get(sessionId, TMP_DIR)!.getState();
    const statsBefore = before.stats;
    const appendOrder = pendingGoalReminders(before.reminders).map((reminder) => reminder.id);
    expect(appendOrder).toHaveLength(3);

    await Promise.all([
      service.materializeModelContextNotices({ workspaceRoot: TMP_DIR, sessionId }),
      service.materializeModelContextNotices({ workspaceRoot: TMP_DIR, sessionId }),
    ]);
    const after = await manager.getSessionFile(TMP_DIR, sessionId);
    const notices = materializedGoalNotices(after.messages);
    expect(notices.map((notice) => notice.id)).toEqual(appendOrder);
    expect(notices.map((notice) => notice.action)).toEqual(["created", "edited", "paused"]);
    expect(pendingGoalReminders(after.reminders)).toHaveLength(0);
    expect(after.reminders.filter((reminder) => reminder.source.type === "session_goal_changed")
      .every((reminder) => reminder.consumedAt !== null)).toBe(true);
    expect(after.stats).toEqual(statsBefore);

    for (const message of after.messages.filter((candidate) =>
      candidate.parts.some((part) => part.type === "goal-notice")
    )) {
      expect(message).toMatchObject({
        role: "user",
        completedAt: message.createdAt,
      });
      expect(message.clientRequestId).toBeUndefined();
      expect(message.modelAudit).toBeUndefined();
      expect(message.executionId).toBeUndefined();
      expect(message.parts).toHaveLength(1);
      expect(SessionFileSchema.safeParse({
        ...after,
        messages: after.messages.map((candidate) => candidate.id === message.id
          ? { ...candidate, clientRequestId: "forged-client-input" }
          : candidate),
      }).success).toBe(false);
    }

    await service.materializeModelContextNotices({ workspaceRoot: TMP_DIR, sessionId });
    expect(materializedGoalNotices((await manager.getSessionFile(TMP_DIR, sessionId)).messages))
      .toHaveLength(3);
  });

  test("materializes equal-time notices in durable append order rather than id order", async () => {
    const sessionId = await rootSession();
    const instanceId = crypto.randomUUID();
    const createdAt = 123;
    const ids = [
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
      "00000000-0000-4000-8000-000000000000",
    ];
    const reminders: Reminder[] = ids.map((id, index) => ({
      id,
      source: {
        type: "session_goal_changed",
        notice: GoalNoticePartSchema.parse({
          type: "goal-notice",
          id,
          action: index === 0 ? "created" : "cleared",
          authority: "user_control",
          instanceId,
          generation: 1,
          goal: index === 0 ? { objective: "Historical Goal", status: "active" } : null,
          createdAt,
        }),
      },
      delivery: "model_context",
      content: "Session Goal created",
      createdAt,
      consumedAt: null,
    }));
    manager.get(sessionId, TMP_DIR)!.setState({ reminders });
    await manager.flushSession(sessionId, TMP_DIR);

    await service.materializeModelContextNotices({ workspaceRoot: TMP_DIR, sessionId });

    expect(materializedGoalNotices((await manager.getSessionFile(TMP_DIR, sessionId)).messages)
      .map((notice) => notice.id)).toEqual(ids);
  });

  test("recovers a failed materialization from the last durable pending notice after restart", async () => {
    const sessionId = await rootSession();
    await service.create({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: user,
      objective: "Deliver after durable storage recovers.",
    });
    const originalSave = sessionFileInternals.saveSessionTranscript;
    sessionFileInternals.saveSessionTranscript = async () => {
      throw new Error("simulated materialization persistence failure");
    };
    try {
      await expect(service.materializeModelContextNotices({ workspaceRoot: TMP_DIR, sessionId }))
        .rejects.toThrow("simulated materialization persistence failure");
    } finally {
      sessionFileInternals.saveSessionTranscript = originalSave;
    }

    const durableBeforeRestart = JSON.parse(await readFile(getSessionPath(TMP_DIR, sessionId), "utf8")) as {
      messages: Array<{ parts: Array<{ type: string }> }>;
      reminders: Reminder[];
    };
    expect(materializedGoalNotices(durableBeforeRestart.messages)).toHaveLength(0);
    expect(pendingGoalReminders(durableBeforeRestart.reminders)).toHaveLength(1);

    manager.clearAll();
    const restartedManager = new SessionStoreManager({ logger: silentLogger });
    const restartedService = new SessionGoalService(restartedManager);
    await restartedManager.getOrLoad(sessionId, TMP_DIR);
    await restartedService.materializeModelContextNotices({ workspaceRoot: TMP_DIR, sessionId });
    expect(materializedGoalNotices((await restartedManager.getSessionFile(TMP_DIR, sessionId)).messages))
      .toHaveLength(1);
    await restartedService.materializeModelContextNotices({ workspaceRoot: TMP_DIR, sessionId });
    expect(materializedGoalNotices((await restartedManager.getSessionFile(TMP_DIR, sessionId)).messages))
      .toHaveLength(1);
    restartedManager.clearAll();
  });

  test("strict current-contract accepts never-Goal, pending, materialized, and cleared states", async () => {
    const neverGoalId = await rootSession();
    expect(SessionFileSchema.safeParse(await manager.getSessionFile(TMP_DIR, neverGoalId)).success).toBe(true);

    const sessionId = await rootSession();
    await service.create({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: user,
      objective: "Keep the durable Goal contract proven.",
    });
    expect(SessionFileSchema.safeParse(await manager.getSessionFile(TMP_DIR, sessionId)).success).toBe(true);

    await service.materializeModelContextNotices({ workspaceRoot: TMP_DIR, sessionId });
    expect(SessionFileSchema.safeParse(await manager.getSessionFile(TMP_DIR, sessionId)).success).toBe(true);

    await service.clear({ workspaceRoot: TMP_DIR, sessionId, authority: user });
    expect(SessionFileSchema.safeParse(await manager.getSessionFile(TMP_DIR, sessionId)).success).toBe(true);

    await service.materializeModelContextNotices({ workspaceRoot: TMP_DIR, sessionId });
    expect(SessionFileSchema.safeParse(await manager.getSessionFile(TMP_DIR, sessionId)).success).toBe(true);
  });

  test("strict current-contract rejects broken Goal notice chains and non-root ownership", async () => {
    const sessionId = await rootSession();
    await service.create({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: user,
      objective: "Reject every partial Goal notice state.",
    });
    const pending = await manager.getSessionFile(TMP_DIR, sessionId);

    const unproven = SessionFileSchema.safeParse({ ...pending, reminders: [], messages: [] });
    expect(unproven.success).toBe(false);
    if (!unproven.success) {
      expect(unproven.error.issues.some((issue) =>
        issue.message.includes("has no pending or materialized Goal notice")
      )).toBe(true);
    }

    const absentWithActiveNotice = SessionFileSchema.safeParse({ ...pending, goal: undefined });
    expect(absentWithActiveNotice.success).toBe(false);
    if (!absentWithActiveNotice.success) {
      expect(absentWithActiveNotice.error.issues.some((issue) =>
        issue.message.includes("latest Goal notice is not cleared")
      )).toBe(true);
    }

    const consumedWithoutMessage = SessionFileSchema.safeParse({
      ...pending,
      reminders: pending.reminders.map((reminder) =>
        reminder.source.type === "session_goal_changed" ? { ...reminder, consumedAt: 1 } : reminder
      ),
    });
    expect(consumedWithoutMessage.success).toBe(false);
    if (!consumedWithoutMessage.success) {
      expect(consumedWithoutMessage.error.issues.some((issue) =>
        issue.message.includes("has no exact internal message")
      )).toBe(true);
    }

    await service.edit({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: user,
      expectedGeneration: 1,
      objective: "Reject every partial or reordered Goal notice state.",
    });
    await service.materializeModelContextNotices({ workspaceRoot: TMP_DIR, sessionId });
    const materialized = await manager.getSessionFile(TMP_DIR, sessionId);

    const messageWithoutReminder = SessionFileSchema.safeParse({ ...materialized, reminders: [] });
    expect(messageWithoutReminder.success).toBe(false);
    if (!messageWithoutReminder.success) {
      expect(messageWithoutReminder.error.issues.some((issue) =>
        issue.message.includes("has no matching reminder")
      )).toBe(true);
    }

    const pendingWithMessage = SessionFileSchema.safeParse({
      ...materialized,
      reminders: materialized.reminders.map((reminder, index) =>
        index === 0 ? { ...reminder, consumedAt: null } : reminder
      ),
    });
    expect(pendingWithMessage.success).toBe(false);
    if (!pendingWithMessage.success) {
      expect(pendingWithMessage.error.issues.some((issue) =>
        issue.message.includes("must not have a materialized message")
      )).toBe(true);
    }

    const reordered = SessionFileSchema.safeParse({
      ...materialized,
      messages: [...materialized.messages].reverse(),
    });
    expect(reordered.success).toBe(false);
    if (!reordered.success) {
      expect(reordered.error.issues.some((issue) =>
        issue.message.includes("do not preserve reminder append order")
      )).toBe(true);
    }

    const analystId = crypto.randomUUID();
    await manager.createSessionFile(TMP_DIR, { agentName: "analyst" }, analystId);
    const analyst = await manager.getSessionFile(TMP_DIR, analystId);
    const nonRoot = SessionFileSchema.safeParse({
      ...analyst,
      reminders: materialized.reminders,
      messages: materialized.messages,
    });
    expect(nonRoot.success).toBe(false);
    if (!nonRoot.success) {
      expect(nonRoot.error.issues.some((issue) =>
        issue.message.includes("belong only to root Lead Sessions")
      )).toBe(true);
    }
  });

  test("materialization rejects current-contract half states instead of repairing them", async () => {
    const sessionId = await rootSession();
    await service.create({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: user,
      objective: "Fail closed on a half-materialized notice.",
    });
    const state = manager.get(sessionId, TMP_DIR)!.getState();
    const reminder = pendingGoalReminders(state.reminders)[0]!;
    const halfMessage = {
      id: reminder.id,
      role: "user" as const,
      parts: [reminder.source.notice],
      createdAt: reminder.createdAt,
      completedAt: reminder.createdAt,
    };
    manager.get(sessionId, TMP_DIR)!.setState({ messages: [...state.messages, halfMessage] });

    await expect(service.materializeModelContextNotices({ workspaceRoot: TMP_DIR, sessionId }))
      .rejects.toMatchObject({ code: "CONTRACT_VIOLATION" });

    const durable = await manager.getSessionFile(TMP_DIR, sessionId);
    const invalid = SessionFileSchema.safeParse({
      ...durable,
      messages: [...durable.messages, halfMessage],
    });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues.some((issue) =>
        issue.message.includes("must not have a materialized message")
      )).toBe(true);
    }
  });

  test("strict store load rejects an unproven Goal with an actionable contract error", async () => {
    const sessionId = await rootSession();
    await service.create({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: user,
      objective: "Reject an unproven persisted Goal.",
    });
    const path = getSessionPath(TMP_DIR, sessionId);
    const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...persisted, reminders: [], messages: [] }));
    manager.clearAll();

    await expect(manager.getOrLoad(sessionId, TMP_DIR))
      .rejects.toThrow("has no pending or materialized Goal notice");
  });

  test("emits exactly one notice for every semantic transition and none for no-ops or ordinary usage", async () => {
    const sessionId = await rootSession();
    const created = await service.create({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: user,
      objective: "Exercise the complete notice matrix.",
    });
    await service.edit({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: user,
      expectedGeneration: created.generation,
      objective: "Exercise every semantic notice exactly once.",
    });
    await service.pause({ workspaceRoot: TMP_DIR, sessionId, authority: user });
    const afterPause = pendingGoalReminders(manager.get(sessionId, TMP_DIR)!.getState().reminders).length;
    await service.pause({ workspaceRoot: TMP_DIR, sessionId, authority: user });
    expect(pendingGoalReminders(manager.get(sessionId, TMP_DIR)!.getState().reminders)).toHaveLength(afterPause);
    await service.resume({ workspaceRoot: TMP_DIR, sessionId, authority: user });
    await service.setTokenBudget({ workspaceRoot: TMP_DIR, sessionId, authority: user, tokenBudget: 50 });
    const afterBudget = pendingGoalReminders(manager.get(sessionId, TMP_DIR)!.getState().reminders).length;
    await service.setTokenBudget({ workspaceRoot: TMP_DIR, sessionId, authority: user, tokenBudget: 50 });
    await service.recordUsage({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: runtime,
      usage: usage(1),
      executionTimeMs: 1,
    });
    expect(pendingGoalReminders(manager.get(sessionId, TMP_DIR)!.getState().reminders)).toHaveLength(afterBudget);
    await service.block({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: agent,
      reason: "Need a decision.",
    });
    await service.clear({ workspaceRoot: TMP_DIR, sessionId, authority: user });
    const replacement = await service.create({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: user,
      objective: "Complete the matrix.",
    });
    await service.complete({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: agent,
      reason: "Verified.",
      expectedInstanceId: replacement.instanceId,
      expectedGeneration: replacement.generation,
    });

    const notices = pendingGoalReminders(manager.get(sessionId, TMP_DIR)!.getState().reminders)
      .map((reminder) => reminder.source.notice);
    expect(notices.map((notice) => notice.action)).toEqual([
      "created",
      "edited",
      "paused",
      "resumed",
      "budget_updated",
      "blocked",
      "cleared",
      "created",
      "completed",
    ]);
    expect(notices.find((notice) => notice.action === "edited")).toMatchObject({
      previousGeneration: 1,
      generation: 2,
    });
    expect(notices.find((notice) => notice.action === "blocked")?.goal).toMatchObject({
      status: "blocked",
      blockedReason: "Need a decision.",
    });
    expect(notices.find((notice) => notice.action === "cleared")).toMatchObject({
      instanceId: created.instanceId,
      generation: 2,
      goal: null,
    });
    expect(notices.find((notice) => notice.action === "completed")).toMatchObject({
      authority: "agent",
      goal: { status: "complete" },
    });
  });

  test("enforces user ownership and root Lead identity", async () => {
    const sessionId = await rootSession();
    await expect(service.create({ workspaceRoot: TMP_DIR, sessionId, authority: agent, objective: "Denied" }))
      .rejects.toBeInstanceOf(SessionGoalServiceError);

    const analystId = crypto.randomUUID();
    await manager.createSessionFile(TMP_DIR, { agentName: "analyst" }, analystId);
    await expect(service.create({ workspaceRoot: TMP_DIR, sessionId: analystId, authority: user, objective: "Denied" }))
      .rejects.toMatchObject({ code: "NOT_ROOT_LEAD" });
  });

  test("pauses, resumes, and preserves user intent behind a budget gate", async () => {
    const sessionId = await rootSession();
    await service.create({ workspaceRoot: TMP_DIR, sessionId, authority: user, objective: "Stay controllable." });

    const paused = await service.pause({ workspaceRoot: TMP_DIR, sessionId, authority: user });
    expect(paused.status).toBe("paused");
    expect(paused.pausedAt).toBeNumber();
    const sessionUpdatedAt = manager.get(sessionId, TMP_DIR)!.getState().updatedAt;
    const noticeCount = pendingGoalReminders(manager.get(sessionId, TMP_DIR)!.getState().reminders).length;
    const originalSave = sessionFileInternals.saveSessionTranscript;
    let unchangedSaveCount = 0;
    sessionFileInternals.saveSessionTranscript = async (state, workspaceRoot) => {
      unchangedSaveCount += 1;
      await originalSave(state, workspaceRoot);
    };
    try {
      expect((await service.pause({ workspaceRoot: TMP_DIR, sessionId, authority: user })).pausedAt)
        .toBe(paused.pausedAt);
      expect(unchangedSaveCount).toBe(0);
      expect(manager.get(sessionId, TMP_DIR)!.getState().updatedAt).toBe(sessionUpdatedAt);
      expect(pendingGoalReminders(manager.get(sessionId, TMP_DIR)!.getState().reminders)).toHaveLength(noticeCount);
    } finally {
      sessionFileInternals.saveSessionTranscript = originalSave;
    }
    expect((await service.resume({ workspaceRoot: TMP_DIR, sessionId, authority: user })).status).toBe("active");

    await service.recordUsage({ workspaceRoot: TMP_DIR, sessionId, authority: runtime, usage: usage(10), executionTimeMs: 5 });
    await service.setTokenBudget({ workspaceRoot: TMP_DIR, sessionId, authority: user, tokenBudget: 10 });
    const limited = await service.pause({ workspaceRoot: TMP_DIR, sessionId, authority: user });
    expect(limited.status).toBe("budget_limited");
    expect(limited.pausedAt).toBeNumber();
    await expect(service.resume({ workspaceRoot: TMP_DIR, sessionId, authority: user }))
      .rejects.toThrow("Increase the token budget before resuming");
    const raised = await service.setTokenBudget({ workspaceRoot: TMP_DIR, sessionId, authority: user, tokenBudget: 11 });
    expect(raised).toMatchObject({ status: "paused", pausedAt: limited.pausedAt });
    expect((await service.resume({ workspaceRoot: TMP_DIR, sessionId, authority: user })).status).toBe("active");
  });

  test("records usage without retry state and enforces the token budget", async () => {
    const sessionId = await rootSession();
    await service.create({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: user,
      objective: "Respect the budget.",
    });
    await service.setTokenBudget({ workspaceRoot: TMP_DIR, sessionId, authority: user, tokenBudget: 7 });

    const created = await service.get({ workspaceRoot: TMP_DIR, sessionId });
    const first = await service.recordUsage({ workspaceRoot: TMP_DIR, sessionId, authority: runtime, usage: usage(3), executionTimeMs: 10 });
    const beforeCrossing = pendingGoalReminders(manager.get(sessionId, TMP_DIR)!.getState().reminders).length;
    const second = await service.recordUsage({ workspaceRoot: TMP_DIR, sessionId, authority: runtime, usage: usage(4), executionTimeMs: 20 });
    expect(first).toMatchObject({ status: "active", usage: { tokens: { totalTokens: 3 }, executionCount: 1 } });
    expect(first.updatedAt).toBe(created!.updatedAt);
    expect(second).toMatchObject({
      status: "budget_limited",
      usage: { tokens: { totalTokens: 7 }, executionTimeMs: 30, executionCount: 2 },
    });
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    expect(Object.hasOwn(second, "failureCount")).toBe(false);
    expect(Object.hasOwn(second, "nextRetryAt")).toBe(false);
    const afterCrossing = pendingGoalReminders(manager.get(sessionId, TMP_DIR)!.getState().reminders);
    expect(afterCrossing).toHaveLength(beforeCrossing + 1);
    expect(afterCrossing.at(-1)?.source.notice).toMatchObject({
      action: "budget_limited",
      authority: "runtime",
      goal: { status: "budget_limited", tokenBudget: 7 },
    });

    const raised = await service.setTokenBudget({ workspaceRoot: TMP_DIR, sessionId, authority: user, tokenBudget: 8 });
    expect(raised.status).toBe("active");
    const removed = await service.setTokenBudget({ workspaceRoot: TMP_DIR, sessionId, authority: user });
    expect(removed.tokenBudget).toBeUndefined();
  });

  test("preserves the canonical blocked reason across both budget-limited paths", async () => {
    const loweringSession = await rootSession();
    await service.create({
      workspaceRoot: TMP_DIR,
      sessionId: loweringSession,
      authority: user,
      objective: "Preserve the blocker while lowering budget.",
    });
    await service.recordUsage({
      workspaceRoot: TMP_DIR,
      sessionId: loweringSession,
      authority: runtime,
      usage: usage(5),
      executionTimeMs: 1,
    });
    await service.block({
      workspaceRoot: TMP_DIR,
      sessionId: loweringSession,
      authority: agent,
      reason: "Waiting on owner approval.",
    });
    const lowered = await service.setTokenBudget({
      workspaceRoot: TMP_DIR,
      sessionId: loweringSession,
      authority: user,
      tokenBudget: 5,
    });
    expect(lowered).toMatchObject({
      status: "budget_limited",
      blockedReason: "Waiting on owner approval.",
    });
    expect(pendingGoalReminders(manager.get(loweringSession, TMP_DIR)!.getState().reminders).at(-1)?.source.notice)
      .toMatchObject({
        action: "budget_updated",
        goal: {
          status: "budget_limited",
          blockedReason: "Waiting on owner approval.",
        },
      });

    const usageSession = await rootSession();
    await service.create({
      workspaceRoot: TMP_DIR,
      sessionId: usageSession,
      authority: user,
      objective: "Preserve the blocker when usage crosses budget.",
    });
    await service.setTokenBudget({
      workspaceRoot: TMP_DIR,
      sessionId: usageSession,
      authority: user,
      tokenBudget: 5,
    });
    await service.recordUsage({
      workspaceRoot: TMP_DIR,
      sessionId: usageSession,
      authority: runtime,
      usage: usage(4),
      executionTimeMs: 1,
    });
    await service.block({
      workspaceRoot: TMP_DIR,
      sessionId: usageSession,
      authority: agent,
      reason: "Missing production credential.",
    });
    const crossed = await service.recordUsage({
      workspaceRoot: TMP_DIR,
      sessionId: usageSession,
      authority: runtime,
      usage: usage(1),
      executionTimeMs: 1,
    });
    expect(crossed).toMatchObject({
      status: "budget_limited",
      blockedReason: "Missing production credential.",
    });
    expect(pendingGoalReminders(manager.get(usageSession, TMP_DIR)!.getState().reminders).at(-1)?.source.notice)
      .toMatchObject({
        action: "budget_limited",
        authority: "runtime",
        goal: {
          status: "budget_limited",
          blockedReason: "Missing production credential.",
        },
      });
  });

  test("blocks active Goal in one Agent call and resumes only by user control", async () => {
    const sessionId = await rootSession();
    await service.create({ workspaceRoot: TMP_DIR, sessionId, authority: user, objective: "Stop at a real blocker." });

    await expect(service.block({ workspaceRoot: TMP_DIR, sessionId, authority: runtime, reason: "Missing credential" }))
      .rejects.toMatchObject({ code: "AUTHORITY_DENIED" });
    const blocked = await service.block({ workspaceRoot: TMP_DIR, sessionId, authority: agent, reason: "  Missing credential  " });
    expect(blocked).toMatchObject({ status: "blocked", blockedReason: "Missing credential" });
    expect(Object.hasOwn(blocked, "blockerCandidate")).toBe(false);
    await expect(service.resume({ workspaceRoot: TMP_DIR, sessionId, authority: user }))
      .resolves.toMatchObject({ status: "active" });
    await expect(service.block({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: agent,
      reason: "x".repeat(SESSION_GOAL_BLOCKED_REASON_MAX_LENGTH + 1),
    })).rejects.toBeDefined();
    const reblocked = await service.block({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: agent,
      reason: "Missing credential",
    });
    expect(reblocked.status).toBe("blocked");
    await expect(service.block({ workspaceRoot: TMP_DIR, sessionId, authority: agent, reason: "Again" }))
      .rejects.toMatchObject({ code: "INVALID_TRANSITION" });

    const resumed = await service.resume({ workspaceRoot: TMP_DIR, sessionId, authority: user });
    expect(resumed.status).toBe("active");
    expect(resumed.blockedReason).toBeUndefined();
  });

  test("completes active Goal once and still settles the completing Execution usage", async () => {
    const sessionId = await rootSession();
    const created = await service.create({ workspaceRoot: TMP_DIR, sessionId, authority: user, objective: "Finish after review." });
    const expected = { expectedInstanceId: created.instanceId, expectedGeneration: created.generation };

    await expect(service.complete({ workspaceRoot: TMP_DIR, sessionId, authority: runtime, reason: "Denied", ...expected }))
      .rejects.toMatchObject({ code: "AUTHORITY_DENIED" });
    const completed = await service.complete({ workspaceRoot: TMP_DIR, sessionId, authority: agent, reason: "Analyst approved", ...expected });
    expect(completed.status).toBe("complete");
    expect(completed.completedAt).toBeNumber();

    const settled = await service.recordUsage({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: runtime,
      usage: usage(5),
      executionTimeMs: 25,
    });
    expect(settled).toMatchObject({
      status: "complete",
      completedAt: completed.completedAt,
      usage: { tokens: { totalTokens: 5 }, executionTimeMs: 25, executionCount: 1 },
    });
    await expect(service.pause({ workspaceRoot: TMP_DIR, sessionId, authority: user }))
      .rejects.toMatchObject({ code: "GOAL_TERMINAL" });
    await expect(service.complete({ workspaceRoot: TMP_DIR, sessionId, authority: agent, reason: "Again", ...expected }))
      .rejects.toMatchObject({ code: "GOAL_TERMINAL" });
  });

  test("completes only the expected Goal instance and generation inside the durable mutation", async () => {
    const sessionId = await rootSession();
    const created = await service.create({ workspaceRoot: TMP_DIR, sessionId, authority: user, objective: "Finish after review." });
    const edited = await service.edit({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: user,
      expectedGeneration: created.generation,
      objective: "Finish the edited Goal after a fresh review.",
    });

    await expect(service.complete({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: agent,
      reason: "Stale generation",
      expectedInstanceId: created.instanceId,
      expectedGeneration: created.generation,
    })).rejects.toMatchObject({ code: "GENERATION_CONFLICT" });
    await expect(service.complete({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: agent,
      reason: "Wrong instance",
      expectedInstanceId: crypto.randomUUID(),
      expectedGeneration: edited.generation,
    })).rejects.toMatchObject({ code: "GENERATION_CONFLICT" });

    const completed = await service.complete({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: agent,
      reason: "Fresh identity",
      expectedInstanceId: edited.instanceId,
      expectedGeneration: edited.generation,
    });
    expect(completed.status).toBe("complete");
  });
});
