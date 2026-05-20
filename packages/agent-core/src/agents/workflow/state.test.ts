import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  WorkflowArtifactKindSchema,
  WorkflowPathError,
  WorkflowStageSchema,
  WorkflowStateManager,
  WorkflowStateSchema,
  WorkflowStatusSchema,
} from "./state";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "workflow-state");

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("workflow schemas", () => {
  test("cover required stage, status, and artifact enums", () => {
    expect(WorkflowStageSchema.options).toEqual([
      "idle",
      "product_drafting",
      "critic_prd_review",
      "spec_drafting",
      "critic_spec_review",
      "awaiting_user_approval",
      "foreman_executing",
      "final_review",
      "complete",
      "failed",
    ]);
    expect(WorkflowStatusSchema.options).toEqual([
      "active",
      "paused",
      "completed",
      "failed",
    ]);
    expect(WorkflowArtifactKindSchema.options).toEqual([
      "PRD",
      "SPEC",
      "TASKS",
      "CRITIC_REPORT",
      "EVIDENCE",
      "FINAL_REPORT",
    ]);
    expect(WorkflowArtifactKindSchema.options).not.toContain("PLAN");
  });

  test("accepts metadata-only workflow state and rejects unknown keys", () => {
    const now = new Date().toISOString();
    const state = WorkflowStateSchema.parse({
      id: "wf-1",
      stage: "idle",
      status: "active",
      artifacts: { PRD: "PRD.md", EVIDENCE: ["evidence/run.md"] },
      agentIds: { product: "agent-1" },
      sessionIds: { orchestrator: "session-1" },
      taskSessionIds: { T1: "session-task-1" },
      createdAt: now,
      updatedAt: now,
      retryCount: 0,
      maxRetries: 3,
    });

    expect(state.id).toBe("wf-1");
    expect(() => WorkflowStateSchema.parse({ ...state, transcripts: [] })).toThrow();
  });
});

describe("WorkflowStateManager", () => {
  test("creates and reads .specra/workflows/{workflowId}/workflow.json", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);

    const created = await manager.create({ id: "wf-1", maxRetries: 5 });
    const filePath = join(TMP_DIR, ".specra", "workflows", "wf-1", "workflow.json");

    expect(await Bun.file(filePath).exists()).toBe(true);
    expect(created.stage).toBe("idle");
    expect(created.status).toBe("active");
    expect(created.retryCount).toBe(0);
    expect(created.maxRetries).toBe(5);
    await expect(manager.read("wf-1")).resolves.toEqual(created);
  });

  test("updates stage and status with timestamps", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);
    const created = await manager.create({ id: "wf-2" });

    const staged = await manager.updateStage("wf-2", "spec_drafting");
    expect(staged.stage).toBe("spec_drafting");
    expect(staged.updatedAt >= created.updatedAt).toBe(true);

    const paused = await manager.updateStatus("wf-2", "paused");
    expect(paused.status).toBe("paused");
    await expect(manager.read("wf-2")).resolves.toEqual(paused);
  });

  test("stores artifact paths and ids without artifact contents", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);

    const created = await manager.create({
      id: "wf-3",
      artifacts: { PRD: "artifacts/PRD.md", EVIDENCE: ["evidence/a.md"] },
      agentIds: { product: "agent-product" },
      sessionIds: { product: "session-product" },
      taskSessionIds: { T1: "session-t1" },
      lastError: "critic rejected SPEC",
    });

    expect(created.artifacts.PRD).toBe("artifacts/PRD.md");
    expect(JSON.stringify(created)).not.toContain("full artifact content");
  });

  test("rejects traversal workflow ids with WorkflowPathError", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);

    await expect(manager.create({ id: "../escape" })).rejects.toThrow(WorkflowPathError);
    await expect(manager.read("../escape")).rejects.toThrow(WorkflowPathError);
  });

  test("lists incomplete workflows and can include completed workflows when requested", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);
    await manager.create({ id: "wf-active" });
    await manager.create({ id: "wf-paused" });
    await manager.create({ id: "wf-completed" });
    await manager.updateStatus("wf-paused", "paused");
    await manager.updateStatus("wf-completed", "completed");

    const incomplete = await manager.listWorkflows({ status: ["active", "paused"] });
    const all = await manager.listWorkflows();

    expect(incomplete.map((state) => state.id)).toEqual(["wf-active", "wf-paused"]);
    expect(incomplete.map((state) => state.status)).toEqual(["active", "paused"]);
    expect(all.map((state) => state.id)).toEqual(["wf-active", "wf-completed", "wf-paused"]);
  });

  test("reads workflow metadata with stored session ids without transcript content", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);
    await manager.create({
      id: "wf-resume",
      artifacts: { TASKS: "TASKS.md" },
      sessionIds: { orchestrator: "session-orchestrator" },
      taskSessionIds: { T14: "session-t14" },
    });

    const state = await manager.readWorkflow("wf-resume");

    expect(state.sessionIds).toEqual({ orchestrator: "session-orchestrator" });
    expect(state.taskSessionIds).toEqual({ T14: "session-t14" });
    expect(JSON.stringify(state)).not.toContain("transcript");
  });

  test("corrupt workflow json returns a named error and list skips only corrupt entries", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);
    await manager.create({ id: "wf-valid" });
    await mkdir(join(TMP_DIR, ".specra", "workflows", "wf-corrupt"), { recursive: true });
    await Bun.write(join(TMP_DIR, ".specra", "workflows", "wf-corrupt", "workflow.json"), "{broken json");

    await expect(manager.readWorkflow("wf-corrupt")).rejects.toMatchObject({
      name: "WorkflowStateError",
      workflowId: "wf-corrupt",
    });

    const listed = await manager.listWorkflows();
    expect(listed.map((state) => state.id)).toEqual(["wf-valid"]);
  });

  test("resume discovery only reads metadata and does not execute workflow transitions", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);
    const created = await manager.create({ id: "wf-discovery" });

    const listed = await manager.listWorkflows({ status: ["active", "paused"] });
    const read = await manager.readWorkflow("wf-discovery");

    expect(listed).toHaveLength(1);
    expect(read.stage).toBe("idle");
    expect(read.status).toBe("active");
    expect(read.updatedAt).toBe(created.updatedAt);
  });
});
