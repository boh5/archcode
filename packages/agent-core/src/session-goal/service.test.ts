import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { silentLogger } from "../logger";
import { SessionStoreManager } from "../store/session-store-manager";
import { SessionGoalSchema } from "./schema";
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

describe("SessionGoalSchema", () => {
  test("accepts exactly the compact Goal contract and rejects every removed state family", () => {
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

    const removedFields = [
      "evaluatorCount",
      "lastEvaluator",
      "noProgressCount",
      "blockerCandidate",
      "failureCount",
      "nextRetryAt",
      "userInputCursor",
      "sourceMutationEpoch",
      "review",
      "lastReviewReceipt",
    ];
    for (const field of removedFields) {
      expect(SessionGoalSchema.safeParse({ ...goal, [field]: 0 }).success).toBe(false);
    }
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
      tokenBudget: 10_000,
    });

    expect(created).toMatchObject({ objective: "Finish the migration.", generation: 1, status: "active" });
    expect(Object.keys(created).sort()).toEqual([
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
    expect((await manager.getSessionFile(TMP_DIR, sessionId)).events?.at(-1)?.payload)
      .toMatchObject({ type: "session.goal_changed", action: "created", goal: created });

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
    expect(cleared.events?.at(-1)?.payload).toMatchObject({ type: "session.goal_changed", action: "cleared", goal: null });

    const replacement = await service.create({ workspaceRoot: TMP_DIR, sessionId, authority: user, objective: "Replacement Goal" });
    expect(replacement.instanceId).not.toBe(created.instanceId);
    expect(replacement.generation).toBe(1);
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
    expect((await service.pause({ workspaceRoot: TMP_DIR, sessionId, authority: user })).pausedAt).toBe(paused.pausedAt);
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
      tokenBudget: 7,
    });

    const created = await service.get({ workspaceRoot: TMP_DIR, sessionId });
    const first = await service.recordUsage({ workspaceRoot: TMP_DIR, sessionId, authority: runtime, usage: usage(3), executionTimeMs: 10 });
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

    const raised = await service.setTokenBudget({ workspaceRoot: TMP_DIR, sessionId, authority: user, tokenBudget: 8 });
    expect(raised.status).toBe("active");
    const removed = await service.setTokenBudget({ workspaceRoot: TMP_DIR, sessionId, authority: user });
    expect(removed.tokenBudget).toBeUndefined();
  });

  test("blocks active Goal in one Agent call and resumes only by user control", async () => {
    const sessionId = await rootSession();
    await service.create({ workspaceRoot: TMP_DIR, sessionId, authority: user, objective: "Stop at a real blocker." });

    await expect(service.block({ workspaceRoot: TMP_DIR, sessionId, authority: runtime, reason: "Missing credential" }))
      .rejects.toMatchObject({ code: "AUTHORITY_DENIED" });
    const blocked = await service.block({ workspaceRoot: TMP_DIR, sessionId, authority: agent, reason: "  Missing credential  " });
    expect(blocked).toMatchObject({ status: "blocked", blockedReason: "Missing credential" });
    expect(Object.hasOwn(blocked, "blockerCandidate")).toBe(false);
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
    expect(Object.hasOwn(completed, "review")).toBe(false);
    expect(Object.hasOwn(completed, "lastReviewReceipt")).toBe(false);

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
