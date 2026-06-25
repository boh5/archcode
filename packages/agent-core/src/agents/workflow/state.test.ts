import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createSessionStore } from "../../store/store";
import { WorkflowArtifactManager } from "./artifacts";
import type { WorkflowInteraction } from "./index";
import {
  WorkflowArtifactKindSchema,
  WorkflowInteractionKindSchema,
  WorkflowInteractionStatusSchema,
  WorkflowInvalidIdError,
  WorkflowStageSchema,
  WorkflowStateManager,
  WorkflowStateSchema,
  WorkflowStatusSchema,
  WorkflowTerminalStateError,
  WorkflowTitleSchema,
  WorkflowTypeSchema,
  WorkflowUuidSchema,
} from "./state";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "workflow-state");

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

async function captureAsyncError(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected async action to throw");
}

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
      id: VALID_UUID,
      title: "My workflow",
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
        workflowId: VALID_UUID,
        reason: "upgrade",
        handoffSummaryId: "HANDOFF_SUMMARY.md",
        triggeredAt: now,
        triggerMessageId: "msg-1",
      },
      derivedWorkflows: [{ workflowId: VALID_UUID, reason: "branch", createdAt: now }],
      sessionIds: { orchestrator: "session-1" },
      createdAt: now,
      updatedAt: now,
      retryCount: 0,
      maxRetries: 3,
    });

    expect(state.id).toBe(VALID_UUID);
    expect(state.title).toBe("My workflow");
    expect(() => WorkflowStateSchema.parse({ ...state, transcripts: [] })).toThrow();
  });

  test("defaults missing workflow interaction metadata for old persisted states", () => {
    const now = new Date().toISOString();
    const state = WorkflowStateSchema.parse({
      id: VALID_UUID,
      title: "Old workflow",
      type: "full_feature",
      stage: "idle",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    expect(state.requiredInteractions).toEqual([]);
    expect(state.resolvedInteractions).toEqual([]);
  });

  test("validates strict workflow-managed interaction metadata", () => {
    const now = new Date().toISOString();
    const interaction: WorkflowInteraction = {
      id: "interaction-1",
      decisionKey: "prd.scope",
      stage: "product_drafting",
      sourceAgent: "product",
      kind: "decision",
      blocking: true,
      question: "Which scope should the PRD use?",
      options: ["minimal", "complete"],
      recommendedOption: "minimal",
      rationale: "The minimal scope reduces implementation risk.",
      status: "proposed",
      answer: undefined,
      createdAt: now,
      resolvedAt: undefined,
      cancelledAt: undefined,
      supersededBy: undefined,
      revision: 1,
    };

    const state = WorkflowStateSchema.parse({
      id: VALID_UUID,
      title: "Workflow with interactions",
      type: "full_feature",
      stage: "product_drafting",
      status: "active",
      requiredInteractions: [interaction],
      resolvedInteractions: [{ ...interaction, id: "interaction-2", status: "resolved", answer: "minimal", resolvedAt: now }],
      createdAt: now,
      updatedAt: now,
    });

    expect(WorkflowInteractionStatusSchema.options).toEqual([
      "proposed",
      "requested",
      "resolved",
      "cancelled",
      "superseded",
    ]);
    expect(WorkflowInteractionKindSchema.options).toEqual([
      "decision",
      "preference",
      "clarification",
      "approval",
    ]);
    expect(state.requiredInteractions[0]).toMatchObject({
      id: "interaction-1",
      revision: 1,
    });
    expect(state.resolvedInteractions[0]?.answer).toBe("minimal");
  });

  test("rejects invalid workflow interaction status kind and stage", () => {
    const now = new Date().toISOString();
    const validInteraction = {
      id: "interaction-1",
      decisionKey: "prd.scope",
      stage: "product_drafting",
      sourceAgent: "product",
      kind: "decision",
      blocking: true,
      question: "Which scope should the PRD use?",
      options: ["minimal", "complete"],
      rationale: "The minimal scope reduces implementation risk.",
      status: "proposed",
      createdAt: now,
    };
    const baseState = {
      id: VALID_UUID,
      title: "Workflow with interactions",
      type: "full_feature",
      stage: "product_drafting",
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    expect(() => WorkflowStateSchema.parse({
      ...baseState,
      requiredInteractions: [{ ...validInteraction, status: "pending" }],
    })).toThrow();
    expect(() => WorkflowStateSchema.parse({
      ...baseState,
      requiredInteractions: [{ ...validInteraction, kind: "transport-only" }],
    })).toThrow();
    expect(() => WorkflowStateSchema.parse({
      ...baseState,
      requiredInteractions: [{ ...validInteraction, stage: "unknown_stage" }],
    })).toThrow();
    expect(() => WorkflowStateSchema.parse({
      ...baseState,
      requiredInteractions: [{ ...validInteraction, extra: "unknown" }],
    })).toThrow();
  });

  test("rejects non-uuid workflow id", () => {
    const now = new Date().toISOString();
    const valid = {
      title: "My workflow",
      type: "full_feature",
      stage: "idle",
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    expect(() => WorkflowStateSchema.parse({ id: "wf-1", ...valid })).toThrow();
    expect(() => WorkflowStateSchema.parse({ id: "default", ...valid })).toThrow();
    expect(() => WorkflowStateSchema.parse({ id: "../escape", ...valid })).toThrow();
    expect(() => WorkflowStateSchema.parse({ id: "not-a-uuid", ...valid })).toThrow();
  });

  test("rejects missing, empty, whitespace, and too-long titles", () => {
    const now = new Date().toISOString();
    const validMeta = {
      id: VALID_UUID,
      type: "full_feature",
      stage: "idle",
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    expect(() => WorkflowStateSchema.parse({ ...validMeta })).toThrow();
    expect(() => WorkflowStateSchema.parse({ ...validMeta, title: "" })).toThrow();
    expect(() => WorkflowStateSchema.parse({ ...validMeta, title: "   " })).toThrow();
    expect(() => WorkflowStateSchema.parse({ ...validMeta, title: "\t\n" })).toThrow();
    expect(() => WorkflowStateSchema.parse({ ...validMeta, title: "a".repeat(201) })).toThrow();
  });

  test("accepts valid title at boundaries", () => {
    const now = new Date().toISOString();
    const meta = {
      id: VALID_UUID,
      type: "full_feature",
      stage: "idle",
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    expect(WorkflowStateSchema.parse({ ...meta, title: "a" }).title).toBe("a");
    expect(WorkflowStateSchema.parse({ ...meta, title: "x".repeat(200) }).title).toBe("x".repeat(200));
  });

  test("trims title whitespace on parse", () => {
    const now = new Date().toISOString();
    const state = WorkflowStateSchema.parse({
      id: VALID_UUID,
      title: "  Hello World  ",
      type: "full_feature",
      stage: "idle",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    expect(state.title).toBe("Hello World");
  });

  test("rejects non-uuid workflowId in derivedFrom and derivedWorkflows", () => {
    const now = new Date().toISOString();
    const base = {
      id: VALID_UUID,
      title: "Test",
      type: "full_feature",
      stage: "idle",
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    expect(() => WorkflowStateSchema.parse({
      ...base,
      derivedFrom: { workflowId: "wf-parent", reason: "upgrade", triggeredAt: now },
    })).toThrow();

    expect(() => WorkflowStateSchema.parse({
      ...base,
      derivedWorkflows: [{ workflowId: "wf-child", reason: "branch", createdAt: now }],
    })).toThrow();
  });

  test("WorkflowUuidSchema accepts valid uuids and rejects invalid strings", () => {
    expect(WorkflowUuidSchema.parse(VALID_UUID)).toBe(VALID_UUID);
    expect(() => WorkflowUuidSchema.parse("wf-1")).toThrow();
    expect(() => WorkflowUuidSchema.parse("")).toThrow();
  });

  test("WorkflowTitleSchema rejects empty, whitespace, and too-long titles", () => {
    expect(() => WorkflowTitleSchema.parse("")).toThrow();
    expect(() => WorkflowTitleSchema.parse("   ")).toThrow();
    expect(() => WorkflowTitleSchema.parse("a".repeat(201))).toThrow();
    expect(WorkflowTitleSchema.parse("Hello")).toBe("Hello");
    expect(WorkflowTitleSchema.parse("  Hello  ")).toBe("Hello");
  });
});

describe("WorkflowStateManager", () => {
  test("creates and reads .archcode/workflows/{generatedUuid}/workflow.json", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);

    const created = await manager.create({ title: "My workflow", type: "full_feature", maxRetries: 5 });
    const filePath = join(TMP_DIR, ".archcode", "workflows", created.id, "workflow.json");

    expect(await Bun.file(filePath).exists()).toBe(true);
    expect(created.title).toBe("My workflow");
    expect(created.stage).toBe("idle");
    expect(created.type).toBe("full_feature");
    expect(created.status).toBe("active");
    expect(created.stageCompletions).toEqual({});
    expect(created.derivedFrom).toBeUndefined();
    expect(created.derivedWorkflows).toEqual([]);
    expect(created.retryCount).toBe(0);
    expect(created.maxRetries).toBe(5);
    expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(await Bun.file(filePath).text()).toContain('"title": "My workflow"');
    expect(await manager.read(created.id)).toEqual(created);
  });

  test("updates stage and status with timestamps", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);
    const created = await manager.create({ title: "Test", type: "full_feature" });

    const staged = await manager.updateStage(created.id, "spec_drafting");
    expect(staged.stage).toBe("spec_drafting");
    expect(staged.updatedAt >= created.updatedAt).toBe(true);

    const paused = await manager.updateStatus(created.id, "paused");
    expect(paused.status).toBe("paused");
    expect(await manager.read(created.id)).toEqual(paused);
  });

  test("records stage completion with completion timestamp", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);
    const created = await manager.create({ title: "Test", type: "full_feature" });

    const updated = await manager.recordStageCompletion(created.id, {
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
    expect(await manager.read(created.id)).toEqual(updated);
  });

  test("complete sets completed status while preserving business stage", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);
    const created = await manager.create({ title: "Test", type: "quick_fix" });
    await manager.updateStage(created.id, "quick_verify");

    const completed = await manager.complete(created.id);

    expect(completed.status).toBe("completed");
    expect(completed.stage).toBe("quick_verify");
    expect(await manager.read(created.id)).toEqual(completed);
  });

  test("stores artifact paths and ids without artifact contents", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);

    const created = await manager.create({
      title: "Test",
      type: "full_feature",
      artifacts: { PRD: "artifacts/PRD.md", EVIDENCE: ["evidence/a.md"] },
      sessionIds: { product: "session-product" },
      lastError: "critic rejected SPEC",
    });

    expect(created.artifacts.PRD).toBe("artifacts/PRD.md");
    expect(JSON.stringify(created)).not.toContain("full artifact content");
  });

  test("rejects non-uuid workflow ids with WorkflowInvalidIdError", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);

    expect(await captureAsyncError(() => manager.read("../escape"))).toBeInstanceOf(WorkflowInvalidIdError);
    expect(await captureAsyncError(() => manager.read("default"))).toBeInstanceOf(WorkflowInvalidIdError);
    expect(await captureAsyncError(() => manager.read("wf-1"))).toBeInstanceOf(WorkflowInvalidIdError);
  });

  test("listWorkflows fails fast on non-uuid workflow directories", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);
    await manager.create({ title: "Valid", type: "full_feature" });

    await mkdir(join(TMP_DIR, ".archcode", "workflows", "old-slug-dir"), { recursive: true });

    expect(await captureAsyncError(() => manager.listWorkflows())).toBeInstanceOf(WorkflowInvalidIdError);
  });

  test("lists incomplete workflows and can include completed workflows when requested", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);
    const wf1 = await manager.create({ title: "Active", type: "full_feature" });
    const wf2 = await manager.create({ title: "Paused", type: "quick_fix" });
    const wf3 = await manager.create({ title: "Completed", type: "research_only" });
    await manager.updateStatus(wf2.id, "paused");
    await manager.updateStatus(wf3.id, "completed");

    const incomplete = await manager.listWorkflows({ status: ["active", "paused"] });
    const all = await manager.listWorkflows();

    expect(incomplete).toHaveLength(2);
    expect(new Set(incomplete.map((s) => s.id))).toEqual(new Set([wf1.id, wf2.id]));
    expect(new Set(incomplete.map((s) => s.status))).toEqual(new Set(["active", "paused"]));
    expect(all).toHaveLength(3);
    expect(new Set(all.map((s) => s.id))).toEqual(new Set([wf1.id, wf2.id, wf3.id]));
  });

  test("reads workflow metadata with stored session ids without transcript content", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);
    const created = await manager.create({
      title: "Test",
      type: "full_feature",
      artifacts: { TASKS: "TASKS.md" },
      sessionIds: { orchestrator: "session-orchestrator" },
    });

    const state = await manager.readWorkflow(created.id);

    expect(state.sessionIds).toEqual({ orchestrator: "session-orchestrator" });
    expect("taskSessionIds" in state).toBe(false);
    expect(JSON.stringify(state)).not.toContain("transcript");
  });

  test("creates a derived workflow with source metadata and handoff summary", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);
    const source = await manager.create({
      title: "Source",
      type: "research_only",
      artifacts: { RESEARCH: "RESEARCH.md" },
      sessionIds: { orchestrator: "source-session" },
    });
    await manager.updateStage(source.id, "research_consolidation");

    const result = await manager.createDerived({
      sourceWorkflowId: source.id,
      title: "Upgrade to full feature",
      targetType: "full_feature",
      reason: "upgrade",
      triggerMessageId: "msg-42",
    });

    expect(result.derived.id).not.toBe(source.id);
    expect(result.source).toMatchObject({
      id: source.id,
      type: "research_only",
      stage: "research_consolidation",
      artifacts: { RESEARCH: "RESEARCH.md", HANDOFF_SUMMARY: "HANDOFF_SUMMARY.md" },
      derivedWorkflows: [{ workflowId: result.derived.id, reason: "upgrade" }],
      sessionIds: { orchestrator: "source-session" },
    });
    expect(result.derived).toMatchObject({
      title: "Upgrade to full feature",
      type: "full_feature",
      stage: "idle",
      status: "active",
      sessionIds: {},
      derivedFrom: {
        workflowId: source.id,
        reason: "upgrade",
        handoffSummaryId: "HANDOFF_SUMMARY.md",
        triggerMessageId: "msg-42",
      },
    });
    expect(result.derived.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(result.handoffSummary).toContain("Source Workflow");
    expect(result.handoffSummary).toContain(`Workflow ID: ${source.id}`);
    expect(result.handoffSummary).toContain("Title: Source");
    expect(result.handoffSummary).toContain("Type: research_only");
    expect(result.handoffSummary).toContain("Stage: research_consolidation");
    expect(result.handoffSummary).toContain("Status: active");
    expect(result.handoffSummary).toContain("Derived Workflow");
    expect(result.handoffSummary).toContain(`Workflow ID: ${result.derived.id}`);
    expect(result.handoffSummary).toContain("Title: Upgrade to full feature");
    expect(result.handoffSummary).toContain("Type: full_feature");
    expect(result.handoffSummary).toContain("Derived Workflow Request");
    expect(result.handoffSummary).toContain("- RESEARCH: RESEARCH.md");

    const handoff = await new WorkflowArtifactManager(TMP_DIR, manager).readByKind(
      source.id,
      "HANDOFF_SUMMARY",
    );
    expect(handoff.body).toBe(result.handoffSummary);
    expect(handoff.frontmatter).toMatchObject({
      "archcode.schema": "1",
      "archcode.workflowId": source.id,
      "archcode.workflowType": "research_only",
      "archcode.artifactKind": "HANDOFF_SUMMARY",
      "archcode.artifactPath": "HANDOFF_SUMMARY.md",
      "archcode.workflowStage": "research_consolidation",
      "archcode.writerAgent": "system",
      "archcode.writerSessionId": "source-session",
      "archcode.toolCallId": "createDerived",
      "archcode.writtenAt": result.source.updatedAt,
    });
    expect(await manager.read(source.id)).toEqual(result.source);
    expect(await manager.read(result.derived.id)).toEqual(result.derived);
  });

  test("rejects derived creation from terminal source workflows", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);
    const source = await manager.create({ title: "Terminal", type: "quick_fix" });
    await manager.complete(source.id);

    expect(await captureAsyncError(() => manager.createDerived({
      sourceWorkflowId: source.id,
      title: "Derived terminal",
      targetType: "full_feature",
      reason: "upgrade",
    }))).toBeInstanceOf(WorkflowTerminalStateError);
  });

  test("emits state change events for source and derived workflows when requested", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);
    const store = createSessionStore("event-session", TMP_DIR);
    const source = await manager.create({ title: "Source", type: "research_only" });

    const result = await manager.createDerived({
      sourceWorkflowId: source.id,
      title: "Event derived",
      targetType: "quick_fix",
      reason: "branch",
      eventStore: store,
    });

    const events = store.getState().events.map((event) => event.payload as { type: string; workflowId: string; changed: string[]; updatedAt: string });
    expect(events).toEqual([
      {
        type: "workflow.state_change",
        workflowId: source.id,
        changed: ["artifacts", "derivedWorkflows"],
        updatedAt: events[0]?.updatedAt,
      },
      {
        type: "workflow.state_change",
        workflowId: result.derived.id,
        changed: ["stage", "status", "derivedFrom"],
        updatedAt: events[1]?.updatedAt,
      },
    ]);
  });

  test("corrupt workflow json returns a named error and list skips only corrupt entries", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);
    const valid = await manager.create({ title: "Valid", type: "full_feature" });
    const corruptId = "550e8400-e29b-41d4-a716-446655440099";
    await mkdir(join(TMP_DIR, ".archcode", "workflows", corruptId), { recursive: true });
    await Bun.write(join(TMP_DIR, ".archcode", "workflows", corruptId, "workflow.json"), "{broken json");

    expect(await captureAsyncError(() => manager.readWorkflow(corruptId))).toMatchObject({
      name: "WorkflowStateError",
      workflowId: corruptId,
    });

    const listed = await manager.listWorkflows();
    expect(listed.map((state) => state.id)).toEqual([valid.id]);
  });

  test("resume discovery only reads metadata and does not execute workflow transitions", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);
    const created = await manager.create({ title: "Test", type: "full_feature" });

    const listed = await manager.listWorkflows({ status: ["active", "paused"] });
    const read = await manager.readWorkflow(created.id);

    expect(listed).toHaveLength(1);
    expect(read.stage).toBe("idle");
    expect(read.status).toBe("active");
    expect(read.updatedAt).toBe(created.updatedAt);
  });
});
