import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  HitlConflictError,
  MAX_HITL_DELIVERY_ATTEMPTS,
  ProjectHitlQueue,
  projectHitlQueuePath,
  toHitlView,
  type CreateHitlInput,
  type ProjectHitlQueueEvent,
} from "./project-queue";
import { HitlBoundaryCodec } from "./boundary-codec";
import { REDACTION_MARKER, SecretRedactionPolicy } from "../security";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "project-queue", crypto.randomUUID());
const codec = new HitlBoundaryCodec(new SecretRedactionPolicy([]));

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe("ProjectHitlQueue", () => {
  test("persists every Session-owned request in the one project queue", async () => {
    const queue = new ProjectHitlQueue({ workspaceRoot: TMP_ROOT, codec });
    const session = await queue.create(questionInput("question-1"));
    const permission = await queue.create(permissionInput("permission-1"));

    expect(session.created).toBe(true);
    expect(permission.created).toBe(true);
    expect(await Bun.file(projectHitlQueuePath(TMP_ROOT)).exists()).toBe(true);
    expect(await Bun.file(join(TMP_ROOT, ".archcode", "sessions", "session-1", "hitl.json")).exists()).toBe(false);
    expect(await Bun.file(join(TMP_ROOT, ".archcode", "goals", "goal-1", "hitl.json")).exists()).toBe(false);
    expect((await queue.list()).map((record) => record.requestKey)).toEqual(["question-1", "permission-1"]);
  });

  test("create is idempotent by requestKey and rejects a changed intent", async () => {
    const queue = new ProjectHitlQueue({ workspaceRoot: TMP_ROOT, codec });
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

    const queue = new ProjectHitlQueue({ workspaceRoot: TMP_ROOT, codec });
    await expect(queue.list()).rejects.toThrow();
  });

  test("persists redacted persistent-approval eligibility and rejects forged approve always", async () => {
    const queue = new ProjectHitlQueue({ workspaceRoot: TMP_ROOT, codec });
    const eligible = await queue.create({ ...permissionInput("eligible"), persistentApprovalEligible: true });
    const ineligible = await queue.create({ ...permissionInput("ineligible"), persistentApprovalEligible: false });

    const listedById = new Map((await queue.list()).map((record) => [record.hitlId, record]));
    expect(listedById.get(eligible.record.hitlId)?.persistentApprovalEligible).toBe(true);
    expect(listedById.get(ineligible.record.hitlId)?.persistentApprovalEligible).toBe(false);
    expect(toHitlView(eligible.record).persistentApprovalEligible).toBe(true);
    await expect(queue.respond(ineligible.record.hitlId, {
      type: "permission_decision",
      decision: "approve_always",
    })).rejects.toThrow("not eligible for persistent approval");
    await expect(queue.respond(ineligible.record.hitlId, {
      type: "permission_decision",
      decision: "approve_once",
    })).resolves.toMatchObject({ status: "answered" });
  });

  test("accepts one immutable response under a race", async () => {
    const queue = new ProjectHitlQueue({ workspaceRoot: TMP_ROOT, codec });
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
    const queue = new ProjectHitlQueue({ workspaceRoot: TMP_ROOT, codec });
    const { record } = await queue.create(questionInput("question-response"));

    await expect(queue.respond(record.hitlId, {
      type: "permission_decision",
      decision: "approve_once",
    })).rejects.toThrow("does not answer ask_user");
  });

  test("persists dispatch attempts and derives inspection after the third failure", async () => {
    const queue = new ProjectHitlQueue({ workspaceRoot: TMP_ROOT, codec });
    const events: ProjectHitlQueueEvent[] = [];
    const eventQueue = new ProjectHitlQueue({ workspaceRoot: TMP_ROOT, codec, onEvent: (event) => events.push(event) });
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
    const queue = new ProjectHitlQueue({ workspaceRoot: TMP_ROOT, codec });
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
    const queue = new ProjectHitlQueue({ workspaceRoot: TMP_ROOT, codec, onEvent: (event) => events.push(event) });
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
      codec,
      onEvent: () => { throw new Error("subscriber unavailable"); },
    });

    const { record } = await queue.create(questionInput("event-failure"));
    await queue.respond(record.hitlId, { type: "question_answer", answers: ["persisted"] });

    const reloaded = new ProjectHitlQueue({ workspaceRoot: TMP_ROOT, codec });
    expect((await reloaded.list())[0]).toMatchObject({
      hitlId: record.hitlId,
      status: "answered",
      response: { type: "question_answer", answers: ["persisted"] },
    });
  });

  test("redacts secret-bearing request and response before durable validation and persistence", async () => {
    const secret = "hitl-secret-literal-123456";
    const secretCodec = new HitlBoundaryCodec(new SecretRedactionPolicy([secret]));
    const queue = new ProjectHitlQueue({ workspaceRoot: TMP_ROOT, codec: secretCodec });
    const { record } = await queue.create({
      ...questionInput("secret-safe"),
      displayPayload: {
        title: "Choose",
        summary: `Never persist ${secret}`,
        questions: [{ question: `Use ${secret}?`, header: "Decision", custom: true }],
        redacted: true,
      },
    });
    await queue.respond(record.hitlId, {
      type: "question_answer",
      answers: [`Continue with ${secret}`],
      comment: `Comment ${secret}`,
    });

    const persisted = await Bun.file(projectHitlQueuePath(TMP_ROOT)).text();
    expect(persisted).not.toContain(secret);
    expect(persisted).toContain(REDACTION_MARKER);
  });

  test("invalid request, response, and record candidates leave durable queue bytes unchanged", async () => {
    const queue = new ProjectHitlQueue({ workspaceRoot: TMP_ROOT, codec });
    await expect(queue.create({
      ...questionInput("x".repeat(129)),
    })).rejects.toThrow();
    expect(await Bun.file(projectHitlQueuePath(TMP_ROOT)).exists()).toBe(false);

    const { record } = await queue.create(questionInput("valid"));
    const beforeResponse = await Bun.file(projectHitlQueuePath(TMP_ROOT)).text();
    await expect(queue.respond(record.hitlId, {
      type: "question_answer",
      answers: ["ordinary words ".repeat(1400)],
    })).rejects.toThrow();
    expect(await Bun.file(projectHitlQueuePath(TMP_ROOT)).text()).toBe(beforeResponse);

    await queue.respond(record.hitlId, { type: "question_answer", answers: ["yes"] });
    await queue.resolve(record.hitlId, { type: "dispatching" });
    const beforeRecord = await Bun.file(projectHitlQueuePath(TMP_ROOT)).text();
    await expect(queue.resolve(record.hitlId, {
      type: "delivery_failed",
      error: "ordinary failure words ".repeat(100),
    })).rejects.toThrow();
    expect(await Bun.file(projectHitlQueuePath(TMP_ROOT)).text()).toBe(beforeRecord);
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
