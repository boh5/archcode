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
  return { registry: createRegistry(descriptors), stateManager, artifactManager, projectContext: makeProjectContext(stateManager, artifactManager) };
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
  return createToolExecutionContext({ store, storeManager, toolName,
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
  projectContext, });
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
  test("workflow_create and workflow_read round-trip workflow state", async () => {
    const { registry, projectContext } = createWorkflowRegistry();

    const created = await execute(registry, projectContext, "workflow_create", { id: "wf-create", type: "full_feature" });
    expect(created.isError).toBe(false);
    expect(JSON.parse(created.output)).toMatchObject({
      id: "wf-create",
      type: "full_feature",
      stage: "idle",
      status: "active",
    });

    const read = await execute(registry, projectContext, "workflow_read", { workflowId: "wf-create" });
    expect(read.isError).toBe(false);
    expect(JSON.parse(read.output)).toMatchObject({ id: "wf-create", stage: "idle" });
  });

  test("workflow_create links orchestrator session and emits state change", async () => {
    const { registry, projectContext } = createWorkflowRegistry();
    const orchestratorStore = storeManager.create("orchestrator-link", TMP_DIR);
    const store = createMockStore();

    const created = await execute(registry, projectContext, "workflow_create", {
      id: "wf-linked",
      type: "full_feature",
      orchestratorSessionId: "orchestrator-link",
    }, store);

    expect(created.isError).toBe(false);
    expect(JSON.parse(created.output).sessionIds).toMatchObject({ orchestrator: "orchestrator-link" });
    expect(orchestratorStore.getState().workflowId).toBe("wf-linked");
    expect(workflowEvents(store).at(-1)?.payload).toMatchObject({
      type: "workflow.state_change",
      workflowId: "wf-linked",
      changed: ["stage", "status", "sessionIds"],
    });
  });

  test("workflow_update_stage mutates stage with guarded transitions only", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    await stateManager.create({ id: "wf-stage", type: "full_feature" });

    const updated = await execute(registry, projectContext, "workflow_update_stage", {
      workflowId: "wf-stage",
      stage: "product_drafting",
    });
    expect(updated.isError).toBe(false);
    expect(JSON.parse(updated.output)).toMatchObject({
      id: "wf-stage",
      stage: "product_drafting",
      status: "active",
    });

    const invalid = await execute(registry, projectContext, "workflow_update_stage", {
      workflowId: "wf-stage",
      stage: "not_a_stage",
    });
    expect(invalid.isError).toBe(true);
    expect(inferToolErrorKindFromResult(invalid)).toBe("schema");

    const denied = await execute(registry, projectContext, "workflow_update_stage", {
      workflowId: "wf-stage",
      stage: "foreman_executing",
    });
    expect(denied.isError).toBe(true);
    expect(denied.output).toContain("WorkflowTransitionError");
  });

  test("workflow_update_stage emits state change after mutation", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const store = createMockStore();
    await stateManager.create({ id: "wf-stage-event", type: "full_feature" });

    const updated = await execute(registry, projectContext, "workflow_update_stage", {
      workflowId: "wf-stage-event",
      stage: "product_drafting",
    }, store);

    expect(updated.isError).toBe(false);
    expect(workflowEvents(store).at(-1)?.payload).toMatchObject({
      type: "workflow.state_change",
      workflowId: "wf-stage-event",
      changed: ["stage"],
    });
  });

  test("workflow_record_completion persists completion record and emits state change", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const store = createMockStore();
    await stateManager.create({ id: "wf-completion-record", type: "quick_fix" });

    const recorded = await execute(registry, projectContext, "workflow_record_completion", {
      workflowId: "wf-completion-record",
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
      workflowId: "wf-completion-record",
      changed: ["stageCompletions"],
    });
  });

  test("workflow_complete denies before completion policy is satisfied", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    await stateManager.create({ id: "wf-complete-denied", type: "quick_fix" });

    const denied = await execute(registry, projectContext, "workflow_complete", {
      workflowId: "wf-complete-denied",
    });

    expect(denied.isError).toBe(true);
    expect(denied.output).toContain("WorkflowTransitionError");
    expect(denied.output).toContain("required stage quick_verify");
  });

  test("workflow_complete checks policy, completes workflow, and emits state change", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const store = createMockStore();
    await stateManager.create({ id: "wf-complete", type: "quick_fix" });
    await stateManager.updateStage("wf-complete", "quick_verify");
    await stateManager.recordStageCompletion("wf-complete", { stage: "quick_verify" });

    const completed = await execute(registry, projectContext, "workflow_complete", {
      workflowId: "wf-complete",
    }, store);

    expect(completed.isError).toBe(false);
    expect(JSON.parse(completed.output)).toMatchObject({
      id: "wf-complete",
      stage: "quick_verify",
      status: "completed",
    });
    expect(workflowEvents(store).at(-1)?.payload).toMatchObject({
      type: "workflow.state_change",
      workflowId: "wf-complete",
      changed: ["status"],
    });
  });

  test("artifact_write and artifact_read use artifact manager without changing stage or status", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    await stateManager.create({ id: "wf-artifact", type: "full_feature" });
    await stateManager.updateStage("wf-artifact", "product_drafting");
    await stateManager.updateStatus("wf-artifact", "paused");
    const store = createMockStore();
    store.getState().setWorkflowId("wf-artifact");

    const written = await execute(registry, projectContext, "artifact_write", {
      workflowId: "wf-artifact",
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

    const state = await stateManager.read("wf-artifact");
    expect(state.stage).toBe("product_drafting");
    expect(state.status).toBe("paused");

    const read = await execute(registry, projectContext, "artifact_read", {
      workflowId: "wf-artifact",
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
    await stateManager.create({ id: "wf-artifact-modified", type: "full_feature" });
    const store = createMockStore();
    store.getState().setWorkflowId("wf-artifact-modified");

    await execute(registry, projectContext, "artifact_write", {
      workflowId: "wf-artifact-modified",
      kind: "SPEC",
      path: "SPEC.md",
      content: "# Spec\n\nBefore\n",
      frontmatter: { kind: "SPEC" },
    }, store);

    const updated = await execute(registry, projectContext, "artifact_write", {
      workflowId: "wf-artifact-modified",
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
    await stateManager.create({ id: "wf-artifact-unsupported", type: "full_feature" });
    const store = createMockStore();
    store.getState().setWorkflowId("wf-artifact-unsupported");

    const binary = await execute(registry, projectContext, "artifact_write", {
      workflowId: "wf-artifact-unsupported",
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
      workflowId: "wf-artifact-unsupported",
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
    await stateManager.create({ id: "wf-current", type: "full_feature" });
    await stateManager.create({ id: "wf-other", type: "full_feature" });
    await artifactManager.write({
      workflowId: "wf-other",
      kind: "PRD",
      path: "PRD.md",
      frontmatter: { kind: "PRD" },
      content: "# Other\n",
    });

    const store = createMockStore();
    store.getState().setWorkflowId("wf-current");

    const read = await execute(registry, projectContext, "artifact_read", {
      workflowId: "wf-other",
      kind: "PRD",
    }, store);
    expect(read.isError).toBe(false);
    expect(JSON.parse(read.output)).toMatchObject({ path: "PRD.md", body: "# Other\n" });

    const wrongWorkflowWrite = await execute(registry, projectContext, "artifact_write", {
      workflowId: "wf-other",
      kind: "SPEC",
      path: "SPEC.md",
      content: "# Wrong\n",
    }, store);
    expect(wrongWorkflowWrite.isError).toBe(true);
    expect(wrongWorkflowWrite.output).toContain("can only write to current workflow wf-current");
  });

  test("workflow_task_check toggles only top-level TASKS.md task checkboxes", async () => {
    const { registry, stateManager, artifactManager, projectContext } = createWorkflowRegistry();
    await stateManager.create({ id: "wf-tasks", type: "full_feature" });
    await artifactManager.write({
      workflowId: "wf-tasks",
      kind: "TASKS",
      path: "TASKS.md",
      frontmatter: { kind: "TASKS" },
      content: VALID_TASKS,
    });

    const result = await execute(registry, projectContext, "workflow_task_check", {
      workflowId: "wf-tasks",
      taskId: "T1",
      checked: true,
    });
    expect(result.isError).toBe(false);

    const tasks = await artifactManager.read("wf-tasks", "TASKS.md");
    expect(tasks.content).toContain("- [x] T1. Build tool");
    expect(tasks.content).toContain("    - [ ] Tool toggles tasks");
  });

  test("workflow_task_check rejects nested checkboxes, unknown ids, and non-TASKS targets", async () => {
    const { registry, stateManager, artifactManager, projectContext } = createWorkflowRegistry();
    await stateManager.create({ id: "wf-reject", type: "full_feature" });
    await artifactManager.write({
      workflowId: "wf-reject",
      kind: "TASKS",
      path: "TASKS.md",
      frontmatter: { kind: "TASKS" },
      content: VALID_TASKS,
    });

    const nested = await execute(registry, projectContext, "workflow_task_check", {
      workflowId: "wf-reject",
      taskId: "Tool toggles tasks",
      checked: true,
    });
    expect(nested.isError).toBe(true);
    expect(nested.output).toContain("Unknown task id");

    const unknown = await execute(registry, projectContext, "workflow_task_check", {
      workflowId: "wf-reject",
      taskId: "T9",
      checked: true,
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.output).toContain("Unknown task id");

    await stateManager.updateArtifacts("wf-reject", { TASKS: "PRD.md" });
    const nonTasks = await execute(registry, projectContext, "workflow_task_check", {
      workflowId: "wf-reject",
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
