import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createSessionStore } from "../../store/store";
import {
  WorkflowArtifactKindSchema,
  WorkflowPathError,
  WorkflowStageSchema,
  WorkflowStateManager,
  WorkflowStateSchema,
  WorkflowStatusSchema,
  WorkflowTerminalStateError,
  WorkflowTypeSchema,
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
      "researching",
      "research_consolidation",
      "quick_analysis",
      "quick_patch",
      "quick_verify",
      "product_drafting",
      "critic_prd_review",
      "spec_drafting",
      "critic_spec_review",
      "awaiting_user_approval",
      "foreman_executing",
      "final_review",
    ]);
    expect(WorkflowTypeSchema.options).toEqual(["research_only", "quick_fix", "full_feature"]);
    expect(WorkflowStatusSchema.options).toEqual([
      "active",
      "paused",
      "completed",
      "failed",
    ]);
    expect(WorkflowArtifactKindSchema.options).toEqual([
      "RESEARCH",
      "PRD",
      "SPEC",
      "TASKS",
      "HANDOFF_SUMMARY",
      "INTERACTIONS",
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
      type: "full_feature",
      stage: "idle",
      status: "active",
      artifacts: { RESEARCH: "RESEARCH.md", PRD: "PRD.md", EVIDENCE: ["evidence/run.md"] },
      stageCompletions: {
        researching: {
          stage: "researching",
          completedAt: now,
          criticPassed: true,
          evidence: ["RESEARCH.md"],
        },
      },
      derivedFrom: {
        workflowId: "wf-parent",
        reason: "upgrade",
        handoffSummaryId: "HANDOFF_SUMMARY.md",
        triggeredAt: now,
        triggerMessageId: "msg-1",
      },
      derivedWorkflows: [{ workflowId: "wf-child", reason: "branch", createdAt: now }],
      sessionIds: { orchestrator: "session-1" },
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

    const created = await manager.create({ id: "wf-1", type: "full_feature", maxRetries: 5 });
    const filePath = join(TMP_DIR, ".specra", "workflows", "wf-1", "workflow.json");

    expect(await Bun.file(filePath).exists()).toBe(true);
    expect(created.stage).toBe("idle");
    expect(created.type).toBe("full_feature");
    expect(created.status).toBe("active");
    expect(created.stageCompletions).toEqual({});
    expect(created.derivedFrom).toBeUndefined();
    expect(created.derivedWorkflows).toEqual([]);
    expect(created.retryCount).toBe(0);
    expect(created.maxRetries).toBe(5);
    await expect(manager.read("wf-1")).resolves.toEqual(created);
  });

  test("updates stage and status with timestamps", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);
    const created = await manager.create({ id: "wf-2", type: "full_feature" });

    const staged = await manager.updateStage("wf-2", "spec_drafting");
    expect(staged.stage).toBe("spec_drafting");
    expect(staged.updatedAt >= created.updatedAt).toBe(true);

    const paused = await manager.updateStatus("wf-2", "paused");
    expect(paused.status).toBe("paused");
    await expect(manager.read("wf-2")).resolves.toEqual(paused);
  });

  test("records stage completion with completion timestamp", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);
    await manager.create({ id: "wf-completion-record", type: "full_feature" });

    const updated = await manager.recordStageCompletion("wf-completion-record", {
      stage: "critic_prd_review",
      criticPassed: true,
      evidence: ["critic-reports/prd.md"],
    });

    expect(updated.stageCompletions.critic_prd_review).toMatchObject({
      stage: "critic_prd_review",
      criticPassed: true,
      evidence: ["critic-reports/prd.md"],
    });
    expect(typeof updated.stageCompletions.critic_prd_review?.completedAt).toBe("string");
    await expect(manager.read("wf-completion-record")).resolves.toEqual(updated);
  });

  test("complete sets completed status while preserving business stage", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);
    await manager.create({ id: "wf-complete", type: "quick_fix" });
    await manager.updateStage("wf-complete", "quick_verify");

    const completed = await manager.complete("wf-complete");

    expect(completed.status).toBe("completed");
    expect(completed.stage).toBe("quick_verify");
    await expect(manager.read("wf-complete")).resolves.toEqual(completed);
  });

  test("stores artifact paths and ids without artifact contents", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);

    const created = await manager.create({
      id: "wf-3",
      type: "full_feature",
      artifacts: { PRD: "artifacts/PRD.md", EVIDENCE: ["evidence/a.md"] },
      sessionIds: { product: "session-product" },
      lastError: "critic rejected SPEC",
    });

    expect(created.artifacts.PRD).toBe("artifacts/PRD.md");
    expect(JSON.stringify(created)).not.toContain("full artifact content");
  });

  test("rejects traversal workflow ids with WorkflowPathError", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);

    await expect(manager.create({ id: "../escape", type: "full_feature" })).rejects.toThrow(WorkflowPathError);
    await expect(manager.read("../escape")).rejects.toThrow(WorkflowPathError);
  });

  test("lists incomplete workflows and can include completed workflows when requested", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);
    await manager.create({ id: "wf-active", type: "full_feature" });
    await manager.create({ id: "wf-paused", type: "quick_fix" });
    await manager.create({ id: "wf-completed", type: "research_only" });
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
      type: "full_feature",
      artifacts: { TASKS: "TASKS.md" },
      sessionIds: { orchestrator: "session-orchestrator" },
    });

    const state = await manager.readWorkflow("wf-resume");

    expect(state.sessionIds).toEqual({ orchestrator: "session-orchestrator" });
    expect("taskSessionIds" in state).toBe(false);
    expect(JSON.stringify(state)).not.toContain("transcript");
  });

  test("creates a derived workflow with source metadata and handoff summary", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);
    await manager.create({
      id: "wf-source",
      type: "research_only",
      artifacts: { RESEARCH: "RESEARCH.md" },
      sessionIds: { orchestrator: "source-session" },
    });
    await manager.updateStage("wf-source", "research_consolidation");

    const result = await manager.createDerived({
      sourceWorkflowId: "wf-source",
      targetType: "full_feature",
      reason: "upgrade",
      triggerMessageId: "msg-42",
      id: "wf-derived",
    });

    expect(result.source).toMatchObject({
      id: "wf-source",
      type: "research_only",
      stage: "research_consolidation",
      artifacts: { RESEARCH: "RESEARCH.md", HANDOFF_SUMMARY: "HANDOFF_SUMMARY.md" },
      derivedWorkflows: [{ workflowId: "wf-derived", reason: "upgrade" }],
      sessionIds: { orchestrator: "source-session" },
    });
    expect(result.derived).toMatchObject({
      id: "wf-derived",
      type: "full_feature",
      stage: "idle",
      status: "active",
      sessionIds: {},
      derivedFrom: {
        workflowId: "wf-source",
        reason: "upgrade",
        handoffSummaryId: "HANDOFF_SUMMARY.md",
        triggerMessageId: "msg-42",
      },
    });
    expect(result.handoffSummary).toContain("Source Workflow");
    expect(result.handoffSummary).toContain("- Type: research_only");
    expect(result.handoffSummary).toContain("- Stage: research_consolidation");
    expect(result.handoffSummary).toContain("- Status: active");
    expect(result.handoffSummary).toContain("- RESEARCH: RESEARCH.md");
    expect(await Bun.file(join(TMP_DIR, ".specra", "workflows", "wf-source", "HANDOFF_SUMMARY.md")).text()).toBe(result.handoffSummary);
    expect(await manager.read("wf-source")).toEqual(result.source);
    expect(await manager.read("wf-derived")).toEqual(result.derived);
  });

  test("rejects derived creation from terminal source workflows", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);
    await manager.create({ id: "wf-terminal", type: "quick_fix" });
    await manager.complete("wf-terminal");

    await expect(manager.createDerived({
      sourceWorkflowId: "wf-terminal",
      targetType: "full_feature",
      reason: "upgrade",
      id: "wf-derived-terminal",
    })).rejects.toThrow(WorkflowTerminalStateError);
  });

  test("emits state change events for source and derived workflows when requested", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);
    const store = createSessionStore("event-session", TMP_DIR);
    await manager.create({ id: "wf-event-source", type: "research_only" });

    await manager.createDerived({
      sourceWorkflowId: "wf-event-source",
      targetType: "quick_fix",
      reason: "branch",
      id: "wf-event-derived",
      eventStore: store,
    });

    const events = store.getState().events.map((event) => event.payload as { type: string; workflowId: string; changed: string[]; updatedAt: string });
    expect(events).toEqual([
      {
        type: "workflow.state_change",
        workflowId: "wf-event-source",
        changed: ["artifacts", "derivedWorkflows"],
        updatedAt: events[0]?.updatedAt,
      },
      {
        type: "workflow.state_change",
        workflowId: "wf-event-derived",
        changed: ["stage", "status", "derivedFrom"],
        updatedAt: events[1]?.updatedAt,
      },
    ]);
  });

  test("corrupt workflow json returns a named error and list skips only corrupt entries", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);
    await manager.create({ id: "wf-valid", type: "full_feature" });
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
    const created = await manager.create({ id: "wf-discovery", type: "full_feature" });

    const listed = await manager.listWorkflows({ status: ["active", "paused"] });
    const read = await manager.readWorkflow("wf-discovery");

    expect(listed).toHaveLength(1);
    expect(read.stage).toBe("idle");
    expect(read.status).toBe("active");
    expect(read.updatedAt).toBe(created.updatedAt);
  });
});
