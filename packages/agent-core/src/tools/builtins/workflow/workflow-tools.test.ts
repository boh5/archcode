import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { StoreApi } from "zustand";

import { WorkflowArtifactManager } from "../../../agents/workflow/artifacts";
import { WorkflowStateManager } from "../../../agents/workflow/state";
import { MemoryFileManager } from "../../../memory/file-manager";
import { ProjectApprovalManager } from "../../permission";
import type { ProjectContext } from "../../../projects/types";
import { SkillService } from "../../../skills";
import { storeManager } from "../../../store/store";
import { createMockStore } from "../../../store/test-helpers";
import { registerBuiltinTools } from "../../../core/register-tools";
import { silentLogger } from "../../../logger";
import { inferToolErrorKindFromResult } from "../../errors";
import { createRegistry, ToolRegistry } from "../../registry";
import { createToolExecutionContext, type AnyToolDescriptor, type ToolExecutionContext } from "../../types";
import {
  createArtifactReadTool,
  createArtifactWriteTool,
  createWorkflowCompleteTool,
  createWorkflowCreateTool,
  createWorkflowReadTool,
  createWorkflowRecordCompletionTool,
  createWorkflowTaskCheckTool,
  createWorkflowUpdateStageTool,
} from "./index";
import type { SessionStoreState } from "../../../store/types";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "workflow-tools");
const testSkillService = new SkillService({ builtinSkills: {} });

const VALID_TASKS = `# TASKS

- [ ] T1. Build tool

  Agent: builder
  Dependencies: none
  Description: Build the workflow tool.
  Acceptance:
    - [ ] Tool toggles tasks
  QA:
    - [ ] Tests pass

- [ ] T2. Review tool

  Agent: reviewer
  Dependencies: T1
  Description: Review the workflow tool.
  Acceptance:
    - [ ] Review complete
  QA:
    - [ ] No issues
`;

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

function createWorkflowRegistry(): {
  registry: ToolRegistry;
  stateManager: WorkflowStateManager;
  artifactManager: WorkflowArtifactManager;
  projectContext: ProjectContext;
} {
  const stateManager = new WorkflowStateManager(TMP_DIR);
  const artifactManager = new WorkflowArtifactManager(TMP_DIR, stateManager);
  const descriptors: AnyToolDescriptor[] = [
    createWorkflowCreateTool(),
    createWorkflowReadTool(),
    createWorkflowUpdateStageTool(),
    createWorkflowCompleteTool(),
    createWorkflowRecordCompletionTool(),
    createArtifactReadTool(),
    createArtifactWriteTool(),
    createWorkflowTaskCheckTool(),
  ];
  return {
    registry: createRegistry(descriptors),
    stateManager,
    artifactManager,
    projectContext: makeProjectContext(stateManager, artifactManager),
  };
}

function makeProjectContext(stateManager: WorkflowStateManager, artifactManager: WorkflowArtifactManager): ProjectContext {
  return {
    project: { slug: "workflow-tools", name: "Workflow Tools", workspaceRoot: TMP_DIR, addedAt: new Date().toISOString() },
    workflowState: stateManager,
    memory: new MemoryFileManager({ project: join(TMP_DIR, ".specra", "memory"), user: join(TMP_DIR, ".specra", "user-memory") }),
    approvals: new ProjectApprovalManager(silentLogger),
    artifacts: artifactManager,
  };
}

function makeCtx(
  toolName: string,
  input: unknown,
  projectContext: ProjectContext,
  store: StoreApi<SessionStoreState> = createMockStore(),
): ToolExecutionContext {
  return createToolExecutionContext({
    store,
    storeManager,
    toolName,
    toolCallId: `${toolName}-call`,
    input,
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set([
      "workflow_create",
      "workflow_read",
      "workflow_update_stage",
      "workflow_complete",
      "workflow_record_completion",
      "artifact_read",
      "artifact_write",
      "workflow_task_check",
    ]),
    agentSkills: [],
    skillService: testSkillService,
    projectContext,
  });
}

async function execute(
  registry: ToolRegistry,
  projectContext: ProjectContext,
  toolName: string,
  input: unknown,
  store?: StoreApi<SessionStoreState>,
) {
  return registry.execute(
    { toolName, toolCallId: `${toolName}-call`, input },
    makeCtx(toolName, input, projectContext, store),
  );
}

function workflowEvents(store: StoreApi<SessionStoreState>) {
  return store.getState().events.filter((event) => event.kind === "workflow.state_change");
}

describe("workflow builtin tools", () => {
  test("workflow_read rejects non-UUID workflowId at schema level", async () => {
    const { registry, projectContext } = createWorkflowRegistry();
    const result = await execute(registry, projectContext, "workflow_read", { workflowId: "default" });
    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("schema");
    expect(result.output).toContain("Invalid UUID");
  });

  test("artifact_read rejects non-UUID workflowId at schema level", async () => {
    const { registry, projectContext } = createWorkflowRegistry();
    const result = await execute(registry, projectContext, "artifact_read", { workflowId: "default", kind: "PRD" });
    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("schema");
    expect(result.output).toContain("Invalid UUID");
  });

  test("artifact_write rejects non-UUID workflowId at schema level", async () => {
    const { registry, projectContext } = createWorkflowRegistry();
    const result = await execute(registry, projectContext, "artifact_write", {
      workflowId: "default",
      kind: "PRD",
      path: "PRD.md",
      content: "# Product\n",
    });
    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("schema");
    expect(result.output).toContain("Invalid UUID");
  });

  test("workflow_create and workflow_read round-trip workflow state", async () => {
    const { registry, projectContext } = createWorkflowRegistry();
    const orchestratorStore = storeManager.create("test-roundtrip", TMP_DIR);
    const store = createMockStore({ sessionId: "test-roundtrip" });

    const created = await execute(registry, projectContext, "workflow_create", { title: "Creation Test", type: "full_feature" }, store);
    expect(created.isError).toBe(false);
    const createdState = JSON.parse(created.output);
    expect(createdState.title).toBe("Creation Test");
    expect(createdState).toMatchObject({
      type: "full_feature",
      stage: "idle",
      status: "active",
      sessionIds: { orchestrator: "test-roundtrip" },
    });
    expect(createdState.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(orchestratorStore.getState().workflowId).toBe(createdState.id);

    const read = await execute(registry, projectContext, "workflow_read", { workflowId: createdState.id });
    expect(read.isError).toBe(false);
    expect(JSON.parse(read.output)).toMatchObject({ id: createdState.id, stage: "idle" });
  });

  test("workflow_create links orchestrator session and emits state change", async () => {
    const { registry, projectContext } = createWorkflowRegistry();
    const orchestratorStore = storeManager.create("orchestrator-link", TMP_DIR);
    const store = createMockStore({ sessionId: "orchestrator-link" });

    const created = await execute(registry, projectContext, "workflow_create", {
      title: "Linked Workflow",
      type: "full_feature",
    }, store);

    expect(created.isError).toBe(false);
    const createdState = JSON.parse(created.output);
    expect(createdState.sessionIds).toMatchObject({ orchestrator: "orchestrator-link" });
    expect(orchestratorStore.getState().workflowId).toBe(createdState.id);
    expect(workflowEvents(store).at(-1)?.payload).toMatchObject({
      type: "workflow.state_change",
      workflowId: createdState.id,
      changed: ["stage", "status", "sessionIds"],
    });
  });

  test("workflow_create rejects caller-provided id at schema level", async () => {
    const { registry, projectContext } = createWorkflowRegistry();
    const result = await execute(registry, projectContext, "workflow_create", {
      title: "test",
      type: "full_feature",
      id: "00000000-0000-0000-0000-000000000001",
    });
    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("schema");
  });

  test("workflow_create rejects empty title at schema level", async () => {
    const { registry, projectContext } = createWorkflowRegistry();
    const result = await execute(registry, projectContext, "workflow_create", {
      title: "",
      type: "full_feature",
    });
    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("schema");
  });

  test("workflow_create rejects whitespace-only title at schema level", async () => {
    const { registry, projectContext } = createWorkflowRegistry();
    const result = await execute(registry, projectContext, "workflow_create", {
      title: "   ",
      type: "full_feature",
    });
    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("schema");
  });

  test("workflow_create blocks creation when current workflow is active", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const wf = await stateManager.create({ title: "existing-active", type: "full_feature" });
    const store = createMockStore({ workflowId: wf.id, sessionId: "test-active" });

    const result = await execute(registry, projectContext, "workflow_create", {
      title: "new-one",
      type: "full_feature",
    }, store);

    expect(result.isError).toBe(true);
    expect(result.output).toContain(wf.id);
    expect(result.output).toContain("active");
    expect(result.output).toContain("existing-active");
    expect(result.output).toContain("full_feature");
    expect(result.output).toContain("Continue the existing workflow");
  });

  test("workflow_create blocks creation when current workflow is paused", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const wf = await stateManager.create({ title: "paused-wf", type: "quick_fix" });
    await stateManager.updateStatus(wf.id, "paused");
    const store = createMockStore({ workflowId: wf.id, sessionId: "test-paused" });

    const result = await execute(registry, projectContext, "workflow_create", {
      title: "another",
      type: "full_feature",
    }, store);

    expect(result.isError).toBe(true);
    expect(result.output).toContain(wf.id);
    expect(result.output).toContain("paused");
    expect(result.output).toContain("paused-wf");
    expect(result.output).toContain("Continue the existing workflow");
  });

  test("workflow_create allows creation when current workflow is completed", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const wf = await stateManager.create({ title: "completed-wf", type: "full_feature" });
    await stateManager.complete(wf.id);
    const orchestratorStore = storeManager.create("test-completed", TMP_DIR);
    const store = createMockStore({ workflowId: wf.id, sessionId: "test-completed" });

    const result = await execute(registry, projectContext, "workflow_create", {
      title: "after-completed",
      type: "quick_fix",
    }, store);

    expect(result.isError).toBe(false);
    const createdState = JSON.parse(result.output);
    expect(createdState.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(createdState.id).not.toBe(wf.id);
    expect(createdState.title).toBe("after-completed");
    expect(createdState.type).toBe("quick_fix");
    expect(createdState.stage).toBe("idle");
    expect(createdState.status).toBe("active");
    expect(orchestratorStore.getState().workflowId).toBe(createdState.id);
  });

  test("workflow_create allows creation when current workflow is failed", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const wf = await stateManager.create({ title: "failed-wf", type: "full_feature" });
    await stateManager.updateStatus(wf.id, "failed");
    const orchestratorStore = storeManager.create("test-failed", TMP_DIR);
    const store = createMockStore({ workflowId: wf.id, sessionId: "test-failed" });

    const result = await execute(registry, projectContext, "workflow_create", {
      title: "after-failed",
      type: "research_only",
    }, store);

    expect(result.isError).toBe(false);
    const createdState = JSON.parse(result.output);
    expect(createdState.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(createdState.id).not.toBe(wf.id);
    expect(createdState.title).toBe("after-failed");
    expect(createdState.type).toBe("research_only");
    expect(createdState.stage).toBe("idle");
    expect(createdState.status).toBe("active");
    expect(orchestratorStore.getState().workflowId).toBe(createdState.id);
  });

  test("workflow_update_stage mutates stage with guarded transitions only", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const wf_stage = await stateManager.create({ title: "Stage Test", type: "full_feature" });

    const updated = await execute(registry, projectContext, "workflow_update_stage", {
      workflowId: wf_stage.id,
      stage: "product_drafting",
    });
    expect(updated.isError).toBe(false);
    expect(JSON.parse(updated.output)).toMatchObject({
      id: wf_stage.id,
      stage: "product_drafting",
      status: "active",
    });

    const invalid = await execute(registry, projectContext, "workflow_update_stage", {
      workflowId: wf_stage.id,
      stage: "not_a_stage",
    });
    expect(invalid.isError).toBe(true);
    expect(inferToolErrorKindFromResult(invalid)).toBe("schema");

    const denied = await execute(registry, projectContext, "workflow_update_stage", {
      workflowId: wf_stage.id,
      stage: "foreman_executing",
    });
    expect(denied.isError).toBe(true);
    expect(denied.output).toContain("WorkflowTransitionError");
  });

  test("workflow_update_stage emits state change after mutation", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const store = createMockStore();
    const wf_stage_event = await stateManager.create({ title: "Stage Event", type: "full_feature" });

    const updated = await execute(registry, projectContext, "workflow_update_stage", {
      workflowId: wf_stage_event.id,
      stage: "product_drafting",
    }, store);

    expect(updated.isError).toBe(false);
    expect(workflowEvents(store).at(-1)?.payload).toMatchObject({
      type: "workflow.state_change",
      workflowId: wf_stage_event.id,
      changed: ["stage"],
    });
  });

  test("workflow_record_completion persists completion record and emits state change", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const store = createMockStore();
    const wf_completion_record = await stateManager.create({ title: "Completion Record", type: "quick_fix" });

    const recorded = await execute(registry, projectContext, "workflow_record_completion", {
      workflowId: wf_completion_record.id,
      stage: "quick_verify",
      criticPassed: true,
      evidence: ["evidence/check.md"],
    }, store);

    expect(recorded.isError).toBe(false);
    const state = JSON.parse(recorded.output);
    expect(state.stageCompletions.quick_verify).toMatchObject({
      stage: "quick_verify",
      criticPassed: true,
      evidence: ["evidence/check.md"],
    });
    expect(workflowEvents(store).at(-1)?.payload).toMatchObject({
      type: "workflow.state_change",
      workflowId: wf_completion_record.id,
      changed: ["stageCompletions"],
    });
  });

  test("workflow_complete denies before completion policy is satisfied", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const wf_complete_denied = await stateManager.create({ title: "Complete Denied", type: "quick_fix" });

    const denied = await execute(registry, projectContext, "workflow_complete", {
      workflowId: wf_complete_denied.id,
    });

    expect(denied.isError).toBe(true);
    expect(denied.output).toContain("WorkflowTransitionError");
    expect(denied.output).toContain("required stage quick_verify");
  });

  test("workflow_complete checks policy, completes workflow, and emits state change", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const store = createMockStore();
    const wf_complete = await stateManager.create({ title: "Complete Test", type: "quick_fix" });
    await stateManager.updateStage(wf_complete.id, "quick_verify");
    await stateManager.recordStageCompletion(wf_complete.id, { stage: "quick_verify" });

    const completed = await execute(registry, projectContext, "workflow_complete", {
      workflowId: wf_complete.id,
    }, store);

    expect(completed.isError).toBe(false);
    expect(JSON.parse(completed.output)).toMatchObject({
      id: wf_complete.id,
      stage: "quick_verify",
      status: "completed",
    });
    expect(workflowEvents(store).at(-1)?.payload).toMatchObject({
      type: "workflow.state_change",
      workflowId: wf_complete.id,
      changed: ["status"],
    });
  });

  test("artifact_write and artifact_read use artifact manager without changing stage or status", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const wf_artifact = await stateManager.create({ title: "Artifact Test", type: "full_feature" });
    await stateManager.updateStage(wf_artifact.id, "product_drafting");
    await stateManager.updateStatus(wf_artifact.id, "paused");
    const store = createMockStore();
    store.getState().setWorkflowId(wf_artifact.id);

    const written = await execute(registry, projectContext, "artifact_write", {
      workflowId: wf_artifact.id,
      kind: "PRD",
      path: "PRD.md",
      content: "# Product\n",
      frontmatter: { owner: "pm" },
    }, store);
    expect(written.isError).toBe(false);
    expect(written.meta?.diffs).toMatchObject({
      version: 1,
      files: [{ path: "PRD.md", status: "created" }],
    });
    expect(JSON.parse(written.output).state).toMatchObject({
      stage: "product_drafting",
      status: "paused",
      artifacts: { PRD: "PRD.md" },
    });

    const state = await stateManager.read(wf_artifact.id);
    expect(state.stage).toBe("product_drafting");
    expect(state.status).toBe("paused");

    const read = await execute(registry, projectContext, "artifact_read", {
      workflowId: wf_artifact.id,
      kind: "PRD",
    });
    expect(read.isError).toBe(false);
    expect(JSON.parse(read.output)).toMatchObject({
      path: "PRD.md",
      frontmatter: { owner: "pm" },
      body: "# Product\n",
    });
  });

  test("artifact_write includes modified diff metadata for existing text artifacts", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const wf_artifact_modified = await stateManager.create({ title: "Artifact Modified", type: "full_feature" });
    const store = createMockStore();
    store.getState().setWorkflowId(wf_artifact_modified.id);

    await execute(registry, projectContext, "artifact_write", {
      workflowId: wf_artifact_modified.id,
      kind: "SPEC",
      path: "SPEC.md",
      content: "# Spec\n\nBefore\n",
      frontmatter: { kind: "SPEC" },
    }, store);

    const updated = await execute(registry, projectContext, "artifact_write", {
      workflowId: wf_artifact_modified.id,
      kind: "SPEC",
      path: "SPEC.md",
      content: "# Spec\n\nAfter\n",
      frontmatter: { kind: "SPEC" },
    }, store);

    expect(updated.isError).toBe(false);
    expect(updated.output).toContain('"path": "SPEC.md"');
    expect(updated.meta?.diffs).toMatchObject({
      version: 1,
      files: [{ path: "SPEC.md", status: "modified", additions: 1, deletions: 1 }],
    });
  });

  test("artifact_write returns unsupported diff metadata for binary or oversized content", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const wf_artifact_unsupported = await stateManager.create({ title: "Artifact Unsupported", type: "full_feature" });
    const store = createMockStore();
    store.getState().setWorkflowId(wf_artifact_unsupported.id);

    const binary = await execute(registry, projectContext, "artifact_write", {
      workflowId: wf_artifact_unsupported.id,
      kind: "EVIDENCE",
      path: "evidence/blob.md",
      content: "\0\0\0binary",
    }, store);
    expect(binary.isError).toBe(false);
    expect(binary.meta?.diffs).toMatchObject({
      version: 1,
      files: [],
      unsupportedReason: "binary",
    });

    const oversized = await execute(registry, projectContext, "artifact_write", {
      workflowId: wf_artifact_unsupported.id,
      kind: "EVIDENCE",
      path: "evidence/large.md",
      content: "x".repeat(1_000_001),
    }, store);
    expect(oversized.isError).toBe(false);
    expect(oversized.meta?.diffs).toMatchObject({
      version: 1,
      files: [],
      unsupportedReason: "too_large",
    });
  });

  test("artifact_read supports same-project cross-workflow reads while artifact_write stays current-workflow only", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const artifactManager = projectContext.artifacts;
    const wf_current = await stateManager.create({ title: "Current Workflow", type: "full_feature" });
    const wf_other = await stateManager.create({ title: "Other Workflow", type: "full_feature" });
    await artifactManager.write({
      workflowId: wf_other.id,
      kind: "PRD",
      path: "PRD.md",
      frontmatter: { kind: "PRD" },
      content: "# Other\n",
    });

    const store = createMockStore();
    store.getState().setWorkflowId(wf_current.id);

    const read = await execute(registry, projectContext, "artifact_read", {
      workflowId: wf_other.id,
      kind: "PRD",
    }, store);
    expect(read.isError).toBe(false);
    expect(JSON.parse(read.output)).toMatchObject({ path: "PRD.md", body: "# Other\n" });

    const wrongWorkflowWrite = await execute(registry, projectContext, "artifact_write", {
      workflowId: wf_other.id,
      kind: "SPEC",
      path: "SPEC.md",
      content: "# Wrong\n",
    }, store);
    expect(wrongWorkflowWrite.isError).toBe(true);
    expect(wrongWorkflowWrite.output).toContain(`can only write to current workflow ${wf_current.id}`);
  });

  test("workflow_task_check toggles only top-level TASKS.md task checkboxes", async () => {
    const { registry, stateManager, artifactManager, projectContext } = createWorkflowRegistry();
    const wf_tasks = await stateManager.create({ title: "Task List", type: "full_feature" });
    await artifactManager.write({
      workflowId: wf_tasks.id,
      kind: "TASKS",
      path: "TASKS.md",
      frontmatter: { kind: "TASKS" },
      content: VALID_TASKS,
    });

    const result = await execute(registry, projectContext, "workflow_task_check", {
      workflowId: wf_tasks.id,
      taskId: "T1",
      checked: true,
    });
    expect(result.isError).toBe(false);

    const tasks = await artifactManager.read(wf_tasks.id, "TASKS.md");
    expect(tasks.content).toContain("- [x] T1. Build tool");
    expect(tasks.content).toContain("    - [ ] Tool toggles tasks");
  });

  test("workflow_task_check rejects nested checkboxes, unknown ids, and non-TASKS targets", async () => {
    const { registry, stateManager, artifactManager, projectContext } = createWorkflowRegistry();
    const wf_reject = await stateManager.create({ title: "Reject Test", type: "full_feature" });
    await artifactManager.write({
      workflowId: wf_reject.id,
      kind: "TASKS",
      path: "TASKS.md",
      frontmatter: { kind: "TASKS" },
      content: VALID_TASKS,
    });

    const nested = await execute(registry, projectContext, "workflow_task_check", {
      workflowId: wf_reject.id,
      taskId: "Tool toggles tasks",
      checked: true,
    });
    expect(nested.isError).toBe(true);
    expect(nested.output).toContain("Unknown task id");

    const unknown = await execute(registry, projectContext, "workflow_task_check", {
      workflowId: wf_reject.id,
      taskId: "T9",
      checked: true,
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.output).toContain("Unknown task id");

    await stateManager.updateArtifacts(wf_reject.id, { TASKS: "PRD.md" });
    const nonTasks = await execute(registry, projectContext, "workflow_task_check", {
      workflowId: wf_reject.id,
      taskId: "T1",
      checked: true,
    });
    expect(nonTasks.isError).toBe(true);
    expect(nonTasks.output).toContain("only supports TASKS.md");
  });

  test("registerBuiltinTools includes all workflow tools", () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, silentLogger);

    expect(registry.get("workflow_create")).toBeDefined();
    expect(registry.get("workflow_read")).toBeDefined();
    expect(registry.get("workflow_update_stage")).toBeDefined();
    expect(registry.get("workflow_complete")).toBeDefined();
    expect(registry.get("workflow_record_completion")).toBeDefined();
    expect(registry.get("artifact_read")).toBeDefined();
    expect(registry.get("artifact_write")).toBeDefined();
    expect(registry.get("workflow_task_check")).toBeDefined();
  });
});
