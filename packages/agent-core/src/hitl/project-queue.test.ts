import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  HitlConflictError,
  MAX_HITL_DELIVERY_ATTEMPTS,
  ProjectHitlQueue,
  projectHitlQueuePath,
  type CreateHitlInput,
  type ProjectHitlQueueEvent,
} from "./project-queue";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "project-queue", crypto.randomUUID());

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe("ProjectHitlQueue", () => {
  test("persists every owner in the one project queue", async () => {
    const queue = new ProjectHitlQueue({ workspaceRoot: TMP_ROOT });
    const session = await queue.create(questionInput("question-1"));
    const goal = await queue.create(budgetInput("budget-1"));

    expect(session.created).toBe(true);
    expect(goal.created).toBe(true);
    expect(await Bun.file(projectHitlQueuePath(TMP_ROOT)).exists()).toBe(true);
    expect(await Bun.file(join(TMP_ROOT, ".archcode", "sessions", "session-1", "hitl.json")).exists()).toBe(false);
    expect(await Bun.file(join(TMP_ROOT, ".archcode", "goals", "goal-1", "hitl.json")).exists()).toBe(false);
    expect((await queue.list()).map((record) => record.requestKey)).toEqual(["question-1", "budget-1"]);
  });

  test("create is idempotent by requestKey and rejects a changed intent", async () => {
    const queue = new ProjectHitlQueue({ workspaceRoot: TMP_ROOT });
    const first = await queue.create(questionInput("same"));
    const repeated = await queue.create(questionInput("same"));

    expect(repeated).toEqual({ created: false, record: first.record });
    await expect(queue.create({
      ...questionInput("same"),
      source: { type: "ask_user", toolCallId: "different-call" },
    })).rejects.toBeInstanceOf(HitlConflictError);
  });

  test("strict parsing rejects old queue and owner-local shapes", async () => {
    await Bun.write(projectHitlQueuePath(TMP_ROOT), JSON.stringify({
      owner: { projectSlug: "archcode", ownerType: "session", ownerId: "session-1" },
      pending: [],
      recentTerminal: [],
      updatedAt: new Date().toISOString(),
    }));

    const queue = new ProjectHitlQueue({ workspaceRoot: TMP_ROOT });
    await expect(queue.list()).rejects.toThrow();
  });

  test("strict creation enforces owner-source boundaries", async () => {
    const queue = new ProjectHitlQueue({ workspaceRoot: TMP_ROOT });
    await expect(queue.create({
      ...questionInput("wrong-owner"),
      owner: { type: "goal", id: "goal-1" },
    })).rejects.toThrow("does not belong");
    await expect(queue.create({
      ...budgetInput("wrong-budget-owner"),
      owner: { type: "session", id: "session-1" },
    })).rejects.toThrow("does not belong");
  });

  test("accepts one immutable response under a race", async () => {
    const queue = new ProjectHitlQueue({ workspaceRoot: TMP_ROOT });
    const { record } = await queue.create(questionInput("race"));
    const results = await Promise.allSettled([
      queue.respond(record.hitlId, { type: "question_answer", answers: ["first"] }),
      queue.respond(record.hitlId, { type: "question_answer", answers: ["second"] }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const answered = (await queue.list())[0]!;
    expect(answered.status).toBe("answered");
    expect(["first", "second"]).toContain(answered.response?.type === "question_answer" ? answered.response.answers[0] : "");
    expect(await queue.respond(record.hitlId, answered.response as { type: "question_answer"; answers: string[] })).toEqual(answered);
  });

  test("validates response variant against source", async () => {
    const queue = new ProjectHitlQueue({ workspaceRoot: TMP_ROOT });
    const { record } = await queue.create(budgetInput("budget-response"));

    await expect(queue.respond(record.hitlId, {
      type: "permission_decision",
      decision: "approve_once",
    })).rejects.toThrow("does not answer goal_budget");
  });

  test("persists dispatch attempts and derives inspection after the third failure", async () => {
    const queue = new ProjectHitlQueue({ workspaceRoot: TMP_ROOT });
    const events: ProjectHitlQueueEvent[] = [];
    const eventQueue = new ProjectHitlQueue({ workspaceRoot: TMP_ROOT, onEvent: (event) => events.push(event) });
    const { record } = await eventQueue.create(questionInput("delivery"));
    await eventQueue.respond(record.hitlId, { type: "question_answer", answers: ["yes"] });

    for (let attempt = 1; attempt <= MAX_HITL_DELIVERY_ATTEMPTS; attempt++) {
      const dispatching = await eventQueue.resolve(record.hitlId, { type: "dispatching" });
      expect(dispatching.delivery?.attempts).toBe(attempt);
      const failed = await eventQueue.resolve(record.hitlId, {
        type: "delivery_failed",
        error: `failed-${attempt}`,
        retryAt: "2026-07-14T00:00:00.000Z",
      });
      expect(failed.delivery?.retryAt === undefined).toBe(attempt === MAX_HITL_DELIVERY_ATTEMPTS);
    }

    await expect(eventQueue.resolve(record.hitlId, { type: "dispatching" })).rejects.toThrow("manual inspection");
    const latest = (await queue.list())[0]!;
    expect(latest).toMatchObject({
      status: "answered",
      delivery: { attempts: 3, error: "failed-3" },
    });
    expect(events.at(-1)).toMatchObject({
      type: "hitl.delivery",
      view: { requiresInspection: true },
    });
  });

  test("applied answer resolves while applied cancel becomes cancelled", async () => {
    const queue = new ProjectHitlQueue({ workspaceRoot: TMP_ROOT });
    const question = (await queue.create(questionInput("resolve"))).record;
    const permission = (await queue.create(permissionInput("cancel"))).record;
    await queue.respond(question.hitlId, { type: "question_answer", answers: ["yes"] });
    await queue.cancel(permission.hitlId, { type: "cancel", reason: "session stopped" });
    await queue.resolve(question.hitlId, { type: "dispatching" });
    await queue.resolve(permission.hitlId, { type: "dispatching" });

    expect(await queue.resolve(question.hitlId, { type: "applied" })).toMatchObject({ status: "resolved" });
    expect(await queue.resolve(permission.hitlId, { type: "applied" })).toMatchObject({ status: "cancelled" });
  });

  test("events and safe views never expose accepted responses or delivery errors", async () => {
    const events: ProjectHitlQueueEvent[] = [];
    const queue = new ProjectHitlQueue({ workspaceRoot: TMP_ROOT, onEvent: (event) => events.push(event) });
    const { record } = await queue.create(questionInput("safe-events"));
    await queue.respond(record.hitlId, { type: "question_answer", answers: ["secret answer"] });
    await queue.resolve(record.hitlId, { type: "dispatching" });
    await queue.resolve(record.hitlId, { type: "delivery_failed", error: "raw internal failure" });

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("secret answer");
    expect(serialized).not.toContain("raw internal failure");
    expect(events[0]).toMatchObject({
      type: "hitl.created",
      view: { allowedActions: ["answer", "cancel"] },
    });
    expect(events[1]).toMatchObject({
      type: "hitl.answered",
      view: { allowedActions: [] },
    });
  });

  test("event callback failure never rolls back durable queue mutations", async () => {
    const queue = new ProjectHitlQueue({
      workspaceRoot: TMP_ROOT,
      onEvent: () => { throw new Error("subscriber unavailable"); },
    });

    const { record } = await queue.create(questionInput("event-failure"));
    await queue.respond(record.hitlId, { type: "question_answer", answers: ["persisted"] });

    const reloaded = new ProjectHitlQueue({ workspaceRoot: TMP_ROOT });
    expect((await reloaded.list())[0]).toMatchObject({
      hitlId: record.hitlId,
      status: "answered",
      response: { type: "question_answer", answers: ["persisted"] },
    });
  });
});

function questionInput(requestKey: string): CreateHitlInput {
  return {
    requestKey,
    owner: { type: "session", id: "session-1" },
    source: { type: "ask_user", toolCallId: "ask-1" },
    displayPayload: {
      title: "Choose",
      questions: [{ question: "Continue?", header: "Decision", custom: true }],
      redacted: true,
    },
  };
}

function permissionInput(requestKey: string): CreateHitlInput {
  return {
    requestKey,
    owner: { type: "session", id: "session-1" },
    source: { type: "tool_permission", toolCallId: "bash-1", toolName: "bash" },
    displayPayload: { title: "Allow bash", redacted: true },
  };
}

function budgetInput(requestKey: string): CreateHitlInput {
  return {
    requestKey,
    owner: { type: "goal", id: "goal-1" },
    source: { type: "goal_budget", approvalPoint: "warning-1" },
    displayPayload: { title: "Approve budget", redacted: true },
  };
}
