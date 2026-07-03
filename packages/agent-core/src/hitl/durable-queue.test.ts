import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { DurableHitlQueue, deterministicApprovalKey, hitlQueuePath } from "./durable-queue";
import type { HitlPayload, HitlTrigger } from "./types";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "durable-queue");

const approvalPayload: HitlPayload = {
  kind: "approval",
  title: "Approve budget warning",
  message: "Approve continuing the Goal?",
  action: "goal.approval.after_plan",
  context: { approvalPoint: "after_plan", goalTitle: "Ship durable queue" },
};

const trigger: Omit<HitlTrigger, "abortSignal"> = {
  projectSlug: "test-project",
  goalId: "goal-123",
  source: "goal.approval.after_plan",
  approvalPoint: "after_plan",
  timeoutMs: 1000,
};

async function makeWorkspace(name: string): Promise<string> {
  await mkdir(TMP_ROOT, { recursive: true });
  return await mkdtemp(join(TMP_ROOT, `${name}-`));
}

async function loadedQueue(workspace: string): Promise<DurableHitlQueue> {
  const queue = new DurableHitlQueue();
  await queue.load(workspace);
  return queue;
}

describe("DurableHitlQueue", () => {
  beforeEach(async () => {
    await rm(TMP_ROOT, { recursive: true, force: true });
    await mkdir(TMP_ROOT, { recursive: true });
  });

  afterAll(async () => {
    await rm(TMP_ROOT, { recursive: true, force: true });
  });

  test("persists, lists, responds, cancels, and reloads terminal records", async () => {
    const workspace = await makeWorkspace("lifecycle");
    const queue = await loadedQueue(workspace);

    const first = queue.createOrReusePending({
      hitlId: "approval_1",
      sessionId: "session-1",
      kind: "approval",
      payload: approvalPayload,
      trigger,
      createdAt: Date.now(),
    });
    const second = queue.createOrReusePending({
      hitlId: "approval_2",
      sessionId: "session-2",
      kind: "approval",
      payload: approvalPayload,
      trigger: { ...trigger, approvalPoint: "before_complete", source: "goal.approval.before_complete" },
      createdAt: Date.now(),
    });
    await queue.flush();

    expect(queue.listPending("test-project").map((record) => record.id)).toEqual([first.id, second.id]);
    expect(queue.resolve("test-project", first.id, { decision: "approved", comment: "ok" }).ok).toBe(true);
    expect(queue.cancel("test-project", second.id, "No longer needed").ok).toBe(true);
    await queue.flush();

    const reloaded = await loadedQueue(workspace);
    expect(reloaded.listPending("test-project")).toEqual([]);
    expect(reloaded.listRecords("test-project")).toEqual([
      expect.objectContaining({ id: first.id, status: "resolved", response: { decision: "approved", comment: "ok" } }),
      expect.objectContaining({ id: second.id, status: "cancelled", terminalReason: "No longer needed" }),
    ]);
  });

  test("survives reload with pending approval visible but no resumed Promise", async () => {
    const workspace = await makeWorkspace("reload");
    const queue = await loadedQueue(workspace);
    const record = queue.createOrReusePending({
      hitlId: "approval_budget_1",
      sessionId: "session-1",
      kind: "approval",
      payload: approvalPayload,
      trigger,
      createdAt: Date.now(),
    });
    await queue.flush();

    const reloaded = await loadedQueue(workspace);
    const pending = reloaded.listPending("test-project", "goal-123");

    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: "approval_budget_1", status: "pending", approvalKey: record.approvalKey });
    expect(reloaded.toRequest(pending[0]!).hitlId).toBe("approval_budget_1");
  });

  test("denies wrong project mutation without changing the record", async () => {
    const workspace = await makeWorkspace("wrong-project");
    const queue = await loadedQueue(workspace);
    const record = queue.createOrReusePending({
      hitlId: "approval_wrong_project",
      sessionId: "session-1",
      kind: "approval",
      payload: approvalPayload,
      trigger,
      createdAt: Date.now(),
    });

    const denied = queue.resolve("other-project", record.id, { decision: "approved" });

    expect(denied).toEqual({ ok: false, reason: "wrong_project", record: expect.objectContaining({ id: record.id, status: "pending" }) });
    const unchanged = queue.get(record.id);
    expect(unchanged).toMatchObject({ status: "pending" });
    expect(unchanged).not.toHaveProperty("response");
    expect(unchanged).not.toHaveProperty("terminalReason");
  });

  test("redacts secret-like payload values in display and stored decision payload", async () => {
    const workspace = await makeWorkspace("redaction");
    const queue = await loadedQueue(workspace);
    const record = queue.createOrReusePending({
      hitlId: "approval_redaction",
      sessionId: "session-1",
      kind: "approval",
      payload: {
        ...approvalPayload,
        message: "Approve apiKey=sk-test-secret before continuing",
        context: { apiKey: "sk-test-secret", safe: "visible" },
      },
      trigger,
      createdAt: Date.now(),
    });
    await queue.flush();

    const fileText = await Bun.file(hitlQueuePath(workspace)).text();
    const serializedRecord = JSON.stringify(record);

    expect(serializedRecord).toContain("[REDACTED]");
    expect(serializedRecord).not.toContain("sk-test-secret");
    expect(fileText).not.toContain("sk-test-secret");
    expect(record.displayPayload.redacted).toBe(true);
  });

  test("redacts secret-like terminal reasons before persistence", async () => {
    const workspace = await makeWorkspace("terminal-redaction");
    const queue = await loadedQueue(workspace);
    const record = queue.createOrReusePending({
      hitlId: "approval_terminal_redaction",
      sessionId: "session-1",
      kind: "approval",
      payload: approvalPayload,
      trigger,
      createdAt: Date.now(),
    });

    const result = queue.cancel("test-project", record.id, "Cancelled with apiKey=sk-test-secret");
    expect(result).toEqual({
      ok: true,
      record: expect.objectContaining({ terminalReason: expect.stringContaining("[REDACTED]") }),
    });
    await queue.flush();

    const fileText = await Bun.file(hitlQueuePath(workspace)).text();
    expect(fileText).toContain("[REDACTED]");
    expect(fileText).not.toContain("sk-test-secret");
  });

  test("reuses deterministic key for matching pending Goal gate request", async () => {
    const workspace = await makeWorkspace("reuse");
    const queue = await loadedQueue(workspace);
    const first = queue.createOrReusePending({
      hitlId: "first-hitl-id",
      sessionId: "session-1",
      kind: "approval",
      payload: approvalPayload,
      trigger,
      createdAt: Date.now(),
    });
    const second = queue.createOrReusePending({
      hitlId: "second-hitl-id",
      sessionId: "session-1",
      kind: "approval",
      payload: approvalPayload,
      trigger,
      createdAt: Date.now() + 1000,
    });

    expect(second.id).toBe(first.id);
    expect(queue.listPending("test-project", "goal-123")).toHaveLength(1);
    expect(first.approvalKey).toBe("test-project:goal-123:session-1:approval_point:after_plan");
  });

  test("does not reuse independent agent question requests without approval points", async () => {
    const workspace = await makeWorkspace("question-unique");
    const queue = await loadedQueue(workspace);
    const first = queue.createOrReusePending({
      hitlId: "question-1",
      sessionId: "session-1",
      kind: "question",
      payload: { kind: "question", title: "First question", message: "Choose first", options: [{ label: "A" }] },
      trigger: { projectSlug: "test-project", goalId: "goal-123", source: "agent.question" },
      createdAt: Date.now(),
    });
    const second = queue.createOrReusePending({
      hitlId: "question-2",
      sessionId: "session-1",
      kind: "question",
      payload: { kind: "question", title: "Second question", message: "Choose second", options: [{ label: "B" }] },
      trigger: { projectSlug: "test-project", goalId: "goal-123", source: "agent.question" },
      createdAt: Date.now(),
    });

    expect(first.id).toBe("question-1");
    expect(second.id).toBe("question-2");
    expect(first.approvalKey).not.toBe(second.approvalKey);
    expect(queue.listPending("test-project", "goal-123")).toHaveLength(2);
  });

  test("builds deterministic tool approval keys when toolCallId is present", () => {
    const key = deterministicApprovalKey("session-1", "approval", approvalPayload, {
      projectSlug: "test-project",
      goalId: "goal-123",
      source: "tool.permission",
      toolCallId: "tool-call-1",
    });

    expect(key).toBe("test-project:goal-123:session-1:tool-call-1");
  });
});
