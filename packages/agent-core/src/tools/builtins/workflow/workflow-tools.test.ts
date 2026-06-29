import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
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
  createWorkflowCreateTool,
  createWorkflowReadTool,
  createWorkflowProposeInteractionsTool,
  createWorkflowRequestInteractionsTool,
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
    createWorkflowProposeInteractionsTool(),
    createWorkflowRequestInteractionsTool(),
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
    memory: new MemoryFileManager({ project: join(TMP_DIR, ".archcode", "memory"), user: join(TMP_DIR, ".archcode", "user-memory") }),
    approvals: new ProjectApprovalManager(silentLogger),
    artifacts: artifactManager,
  };
}

function makeCtx(
  toolName: string,
  input: unknown,
  projectContext: ProjectContext,
  store: StoreApi<SessionStoreState> = createMockStore(),
  options: {
    askUser?: ToolExecutionContext["askUser"];
    allowedTools?: readonly string[];
    agentName?: string;
  } = {},
): ToolExecutionContext {
  const defaultAllowedTools = [
    "workflow_create",
    "workflow_read",
    "workflow_update_stage",
    "workflow_propose_interactions",
    "workflow_request_interactions",
    "artifact_read",
    "artifact_write",
    "workflow_task_check",
  ];
  return createToolExecutionContext({
    store,
    storeManager,
    toolName,
    toolCallId: `${toolName}-call`,
    input,
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(options.allowedTools ?? defaultAllowedTools),
    agentName: options.agentName ?? store.getState().agentName,
    agentSkills: [],
    skillService: testSkillService,
    projectContext,
    ...(options.askUser ? { askUser: options.askUser } : {}),
  });
}

async function execute(
  registry: ToolRegistry,
  projectContext: ProjectContext,
  toolName: string,
  input: unknown,
  store?: StoreApi<SessionStoreState>,
  options?: Parameters<typeof makeCtx>[4],
) {
  return registry.execute(
    { toolName, toolCallId: `${toolName}-call`, input },
    makeCtx(toolName, input, projectContext, store, options),
  );
}

function workflowEvents(store: StoreApi<SessionStoreState>) {
  return store.getState().events.filter((event) => event.kind === "workflow.state_change");
}

function validInteractionProposal(overrides: Record<string, unknown> = {}) {
  return {
    decisionKey: "requirements.scope",
    stage: "product_drafting",
    sourceAgent: "product",
    kind: "decision",
    question: "Should this workflow include the billing dashboard?",
    options: ["Include billing dashboard", "Exclude billing dashboard"],
    recommendedOption: "Include billing dashboard",
    rationale: "The PRD needs this scope decision before drafting acceptance criteria.",
    ...overrides,
  };
}

describe("workflow builtin tools", () => {
  test("workflow_read rejects original default workflowId bug at schema level before lookup", async () => {
    const { registry, projectContext } = createWorkflowRegistry();
    const result = await execute(registry, projectContext, "workflow_read", { workflowId: "default" });
    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("schema");
    expect(result.output).toContain("Invalid UUID");
    expect(result.output).toContain("workflowId");
    expect(result.output).not.toContain("TOOL_FILE_NOT_FOUND");
    expect(result.output).not.toContain("Workflow not found: default");
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

  test("workflow_create rejects invalid (non-UUID) current workflow id", async () => {
    const { registry, projectContext } = createWorkflowRegistry();
    const store = createMockStore({ workflowId: "default", sessionId: "test-invalid-id" });

    const result = await execute(registry, projectContext, "workflow_create", {
      title: "new-after-invalid",
      type: "full_feature",
    }, store);

    expect(result.isError).toBe(true);
    expect(result.output).toContain("TOOL_WORKFLOW_INVALID_ID");
    expect(result.output).toContain("default");
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
    const store = createMockStore();
    store.getState().setWorkflowId(wf_stage.id);

    const updated = await execute(registry, projectContext, "workflow_update_stage", {
      workflowId: wf_stage.id,
      stage: "product_drafting",
    }, store);
    expect(updated.isError).toBe(false);
    expect(JSON.parse(updated.output)).toMatchObject({
      id: wf_stage.id,
      stage: "product_drafting",
      status: "active",
    });

    const invalid = await execute(registry, projectContext, "workflow_update_stage", {
      workflowId: wf_stage.id,
      stage: "not_a_stage",
    }, store);
    expect(invalid.isError).toBe(true);
    expect(inferToolErrorKindFromResult(invalid)).toBe("schema");

    const denied = await execute(registry, projectContext, "workflow_update_stage", {
      workflowId: wf_stage.id,
      stage: "foreman_executing",
    }, store);
    expect(denied.isError).toBe(true);
    expect(denied.output).toContain("WorkflowTransitionError");
  });

  test("workflow_update_stage emits state change after mutation", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const wf_stage_event = await stateManager.create({ title: "Stage Event", type: "full_feature" });
    const store = createMockStore();
    store.getState().setWorkflowId(wf_stage_event.id);

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

  test("workflow_update_stage with completeCurrentStage persists completion record and emits state change", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const wf_completion_record = await stateManager.create({ title: "Completion Record", type: "quick_fix" });
    await stateManager.updateStage(wf_completion_record.id, "quick_analysis");
    const store = createMockStore();
    store.getState().setWorkflowId(wf_completion_record.id);

    const recorded = await execute(registry, projectContext, "workflow_update_stage", {
      workflowId: wf_completion_record.id,
      stage: "quick_patch",
      completeCurrentStage: {
        criticPassed: true,
        evidence: ["evidence/check.md"],
      },
    }, store);

    expect(recorded.isError).toBe(false);
    expect(JSON.parse(recorded.output)).toMatchObject({
      workflowId: wf_completion_record.id,
      stage: "quick_patch",
      status: "active",
    });
    const state = await stateManager.read(wf_completion_record.id);
    expect(state.stageCompletions.quick_analysis).toMatchObject({
      stage: "quick_analysis",
      criticPassed: true,
      evidence: ["evidence/check.md"],
    });
    const completionEvents = workflowEvents(store).filter((event) => {
      const payload = event.payload as { changed?: string[] };
      return payload.changed?.includes("stageCompletions");
    });
    expect(completionEvents.length).toBeGreaterThan(0);
    expect(completionEvents.at(-1)?.payload).toMatchObject({
      type: "workflow.state_change",
      workflowId: wf_completion_record.id,
      changed: ["stageCompletions"],
    });
  });

  test("workflow_update_stage with status completed denies before completion policy is satisfied", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const wf_complete_denied = await stateManager.create({ title: "Complete Denied", type: "quick_fix" });
    const store = createMockStore();
    store.getState().setWorkflowId(wf_complete_denied.id);

    const denied = await execute(registry, projectContext, "workflow_update_stage", {
      workflowId: wf_complete_denied.id,
      stage: "idle",
      status: "completed",
    }, store);

    expect(denied.isError).toBe(true);
    expect(denied.output).toContain("WorkflowTransitionError");
    expect(denied.output).toContain("required stage quick_verify");
  });

  test("workflow_update_stage with status completed checks policy, completes workflow, and emits state change", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const wf_complete = await stateManager.create({ title: "Complete Test", type: "quick_fix" });
    await stateManager.updateStage(wf_complete.id, "quick_verify");
    await stateManager.recordStageCompletion(wf_complete.id, { stage: "quick_verify" });
    const store = createMockStore();
    store.getState().setWorkflowId(wf_complete.id);

    const completed = await execute(registry, projectContext, "workflow_update_stage", {
      workflowId: wf_complete.id,
      stage: "quick_verify",
      status: "completed",
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
      content: "# Product\n",
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
      frontmatter: {
        "archcode.schema": "1",
        "archcode.workflowId": wf_artifact.id,
        "archcode.workflowType": "full_feature",
        "archcode.artifactKind": "PRD",
        "archcode.artifactPath": "PRD.md",
        "archcode.workflowStage": "product_drafting",
        "archcode.writerSessionId": "test",
        "archcode.toolCallId": "artifact_write-call",
      },
      body: "# Product\n",
    });
  });

  test("artifact_write rejects caller-provided frontmatter at schema level", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const wf_artifact = await stateManager.create({ title: "Artifact Schema Test", type: "full_feature" });
    const store = createMockStore();
    store.getState().setWorkflowId(wf_artifact.id);

    const result = await execute(registry, projectContext, "artifact_write", {
      workflowId: wf_artifact.id,
      kind: "PRD",
      frontmatter: { owner: "pm" },
      content: "# Product\n",
    }, store);

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("schema");
    expect(result.output).toContain("Unrecognized key");
    expect(result.output).toContain("frontmatter");
  });

  test("artifact_write accepts parser-valid TASKS.md", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const wf_artifact_tasks = await stateManager.create({ title: "Tasks Artifact", type: "full_feature" });
    const store = createMockStore();
    store.getState().setWorkflowId(wf_artifact_tasks.id);

    const written = await execute(registry, projectContext, "artifact_write", {
      workflowId: wf_artifact_tasks.id,
      kind: "TASKS",
      content: VALID_TASKS,
    }, store);

    expect(written.isError).toBe(false);
    expect(JSON.parse(written.output).state).toMatchObject({ artifacts: { TASKS: "TASKS.md" } });
  });

  test("artifact_write rejects invalid TASKS.md and preserves existing artifact", async () => {
    const { registry, stateManager, artifactManager, projectContext } = createWorkflowRegistry();
    const wf_artifact_tasks_invalid = await stateManager.create({ title: "Invalid Tasks Artifact", type: "full_feature" });
    const store = createMockStore();
    store.getState().setWorkflowId(wf_artifact_tasks_invalid.id);
    await artifactManager.write({
      workflowId: wf_artifact_tasks_invalid.id,
      kind: "TASKS",
      content: VALID_TASKS,
    });

    const rejected = await execute(registry, projectContext, "artifact_write", {
      workflowId: wf_artifact_tasks_invalid.id,
      kind: "TASKS",
      content: "# Invalid tasks\n",
    }, store);

    expect(rejected.isError).toBe(true);
    expect(rejected.output).toContain("TOOL_ARTIFACT_VALIDATION_FAILED");
    expect(rejected.output).toContain("TASKS.md is invalid and was not written");
    const preserved = await artifactManager.read(wf_artifact_tasks_invalid.id, "TASKS.md");
    expect(preserved.body).toBe(VALID_TASKS);
    expect((await stateManager.read(wf_artifact_tasks_invalid.id)).artifacts).toMatchObject({ TASKS: "TASKS.md" });
  });

  test("artifact_write includes modified diff metadata for existing text artifacts", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const wf_artifact_modified = await stateManager.create({ title: "Artifact Modified", type: "full_feature" });
    const store = createMockStore();
    store.getState().setWorkflowId(wf_artifact_modified.id);

    await execute(registry, projectContext, "artifact_write", {
      workflowId: wf_artifact_modified.id,
      kind: "SPEC",
      content: "# Spec\n\nBefore\n",
    }, store);

    const updated = await execute(registry, projectContext, "artifact_write", {
      workflowId: wf_artifact_modified.id,
      kind: "SPEC",
      content: "# Spec\n\nAfter\n",
    }, store);

    expect(updated.isError).toBe(false);
    expect(updated.output).toContain('"path": "SPEC.md"');
    expect(updated.meta?.diffs).toMatchObject({
      version: 1,
      files: [{ path: "SPEC.md", status: "modified" }],
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
      name: "blob",
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
      name: "large",
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
    await artifactManager.write({ workflowId: wf_other.id, kind: "PRD", content: "# Other\n" });

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
      content: "# Wrong\n",
    }, store);
    expect(wrongWorkflowWrite.isError).toBe(true);
    expect(wrongWorkflowWrite.output).toContain(`can only write to current workflow ${wf_current.id}`);
    expect(wrongWorkflowWrite.output).toContain("TOOL_WORKFLOW_WRONG_WORKFLOW");
  });

  test("workflow_read supports same-project cross-workflow reads", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const wf_current = await stateManager.create({ title: "Current Workflow", type: "full_feature" });
    const wf_other = await stateManager.create({ title: "Other Workflow", type: "full_feature" });

    const store = createMockStore();
    store.getState().setWorkflowId(wf_current.id);

    const read = await execute(registry, projectContext, "workflow_read", {
      workflowId: wf_other.id,
    }, store);
    expect(read.isError).toBe(false);
    expect(JSON.parse(read.output)).toMatchObject({ id: wf_other.id, title: "Other Workflow" });
  });

  test("mutating tools reject wrong workflow with TOOL_WORKFLOW_WRONG_WORKFLOW", async () => {
    const { registry, stateManager, artifactManager, projectContext } = createWorkflowRegistry();
    const wf_current = await stateManager.create({ title: "Current", type: "full_feature" });
    const wf_other = await stateManager.create({ title: "Other", type: "full_feature" });
    await artifactManager.write({
      workflowId: wf_current.id,
      kind: "TASKS",
      content: VALID_TASKS,
    });

    const store = createMockStore();
    store.getState().setWorkflowId(wf_current.id);

    const updateStage = await execute(registry, projectContext, "workflow_update_stage", {
      workflowId: wf_other.id,
      stage: "product_drafting",
    }, store);
    expect(updateStage.isError).toBe(true);
    expect(updateStage.output).toContain("TOOL_WORKFLOW_WRONG_WORKFLOW");
    expect(updateStage.output).toContain(`can only write to current workflow ${wf_current.id}`);
    expect(updateStage.output).toContain(wf_other.id);

    const completeViaUpdateStage = await execute(registry, projectContext, "workflow_update_stage", {
      workflowId: wf_other.id,
      stage: "idle",
      status: "completed",
    }, store);
    expect(completeViaUpdateStage.isError).toBe(true);
    expect(completeViaUpdateStage.output).toContain("TOOL_WORKFLOW_WRONG_WORKFLOW");
    expect(completeViaUpdateStage.output).toContain(wf_current.id);
    expect(completeViaUpdateStage.output).toContain(wf_other.id);

    const taskCheck = await execute(registry, projectContext, "workflow_task_check", {
      workflowId: wf_other.id,
      taskId: "T1",
      checked: true,
    }, store);
    expect(taskCheck.isError).toBe(true);
    expect(taskCheck.output).toContain("TOOL_WORKFLOW_WRONG_WORKFLOW");
    expect(taskCheck.output).toContain(wf_current.id);
    expect(taskCheck.output).toContain(wf_other.id);

    const artifactWrite = await execute(registry, projectContext, "artifact_write", {
      workflowId: wf_other.id,
      kind: "PRD",
      content: "# Wrong\n",
    }, store);
    expect(artifactWrite.isError).toBe(true);
    expect(artifactWrite.output).toContain("TOOL_WORKFLOW_WRONG_WORKFLOW");
    expect(artifactWrite.output).toContain(wf_current.id);
    expect(artifactWrite.output).toContain(wf_other.id);
  });

  test("mutating tools reject when session has no current workflowId", async () => {
    const { registry, stateManager, artifactManager, projectContext } = createWorkflowRegistry();
    const wf = await stateManager.create({ title: "Orphan", type: "full_feature" });
    await artifactManager.write({
      workflowId: wf.id,
      kind: "TASKS",
      content: VALID_TASKS,
    });

    const store = createMockStore();

    const updateStage = await execute(registry, projectContext, "workflow_update_stage", {
      workflowId: wf.id,
      stage: "product_drafting",
    }, store);
    expect(updateStage.isError).toBe(true);
    expect(updateStage.output).toContain("TOOL_WORKFLOW_WRONG_WORKFLOW");
    expect(updateStage.output).toContain("requires the current session to be linked to a workflow");
    expect(updateStage.output).toContain(wf.id);

    const completeViaUpdateStage = await execute(registry, projectContext, "workflow_update_stage", {
      workflowId: wf.id,
      stage: "idle",
      status: "completed",
    }, store);
    expect(completeViaUpdateStage.isError).toBe(true);
    expect(completeViaUpdateStage.output).toContain("requires the current session to be linked to a workflow");
    expect(completeViaUpdateStage.output).toContain(wf.id);

    const taskCheck = await execute(registry, projectContext, "workflow_task_check", {
      workflowId: wf.id,
      taskId: "T1",
      checked: true,
    }, store);
    expect(taskCheck.isError).toBe(true);
    expect(taskCheck.output).toContain("requires the current session to be linked to a workflow");
    expect(taskCheck.output).toContain(wf.id);

    const artifactWrite = await execute(registry, projectContext, "artifact_write", {
      workflowId: wf.id,
      kind: "PRD",
      content: "# Wrong\n",
    }, store);
    expect(artifactWrite.isError).toBe(true);
    expect(artifactWrite.output).toContain("requires the current session to be linked to a workflow");
    expect(artifactWrite.output).toContain(wf.id);
  });

  test("workflow_task_check toggles only top-level TASKS.md task checkboxes", async () => {
    const { registry, stateManager, artifactManager, projectContext } = createWorkflowRegistry();
    const wf_tasks = await stateManager.create({ title: "Task List", type: "full_feature" });
    const store = createMockStore();
    store.getState().setWorkflowId(wf_tasks.id);
    await artifactManager.write({
      workflowId: wf_tasks.id,
      kind: "TASKS",
      content: VALID_TASKS,
    });

    const result = await execute(registry, projectContext, "workflow_task_check", {
      workflowId: wf_tasks.id,
      taskId: "T1",
      checked: true,
    }, store);
    expect(result.isError).toBe(false);

    const tasks = await artifactManager.read(wf_tasks.id, "TASKS.md");
    expect(tasks.content).toContain("- [x] T1. Build tool");
    expect(tasks.content).toContain("    - [ ] Tool toggles tasks");
  });

  test("workflow_update_stage reports invalid TASKS.md instead of missing artifact", async () => {
    const { registry, stateManager, artifactManager, projectContext } = createWorkflowRegistry();
    const wf_invalid_tasks_transition = await stateManager.create({ title: "Invalid Tasks Transition", type: "full_feature" });
    await stateManager.updateStage(wf_invalid_tasks_transition.id, "spec_drafting");
    await stateManager.recordStageCompletion(wf_invalid_tasks_transition.id, { stage: "spec_drafting" });
    await artifactManager.write({ workflowId: wf_invalid_tasks_transition.id, kind: "SPEC", content: "# Spec\n" });
    await artifactManager.write({
      workflowId: wf_invalid_tasks_transition.id,
      kind: "TASKS",
      content: "# Invalid tasks\n",
    });
    const store = createMockStore();
    store.getState().setWorkflowId(wf_invalid_tasks_transition.id);

    const result = await execute(registry, projectContext, "workflow_update_stage", {
      workflowId: wf_invalid_tasks_transition.id,
      stage: "critic_spec_review",
      hasUserApproval: false,
      incrementRetry: false,
    }, store);

    expect(result.isError).toBe(true);
    expect(result.output).toContain("TOOL_WORKFLOW_INVALID_ARTIFACT");
    expect(result.output).toContain("TASKS.md exists but is invalid");
    expect(result.output).not.toContain("missing required artifact(s): TASKS");
  });

  test("workflow_update_stage still reports missing TASKS.md when artifact is absent", async () => {
    const { registry, stateManager, artifactManager, projectContext } = createWorkflowRegistry();
    const wf_missing_tasks_transition = await stateManager.create({ title: "Missing Tasks Transition", type: "full_feature" });
    await stateManager.updateStage(wf_missing_tasks_transition.id, "spec_drafting");
    await stateManager.recordStageCompletion(wf_missing_tasks_transition.id, { stage: "spec_drafting" });
    await artifactManager.write({ workflowId: wf_missing_tasks_transition.id, kind: "SPEC", content: "# Spec\n" });
    const store = createMockStore();
    store.getState().setWorkflowId(wf_missing_tasks_transition.id);

    const result = await execute(registry, projectContext, "workflow_update_stage", {
      workflowId: wf_missing_tasks_transition.id,
      stage: "critic_spec_review",
      hasUserApproval: false,
      incrementRetry: false,
    }, store);

    expect(result.isError).toBe(true);
    expect(result.output).toContain("TOOL_WORKFLOW_TRANSITION_DENIED");
    expect(result.output).toContain("missing required artifact(s): TASKS");
    expect(result.output).not.toContain("TOOL_WORKFLOW_INVALID_ARTIFACT");
  });

  test("workflow_task_check rejects nested checkboxes, unknown ids, and non-TASKS targets", async () => {
    const { registry, stateManager, artifactManager, projectContext } = createWorkflowRegistry();
    const wf_reject = await stateManager.create({ title: "Reject Test", type: "full_feature" });
    const store = createMockStore();
    store.getState().setWorkflowId(wf_reject.id);
    await artifactManager.write({
      workflowId: wf_reject.id,
      kind: "TASKS",
      content: VALID_TASKS,
    });

    const nested = await execute(registry, projectContext, "workflow_task_check", {
      workflowId: wf_reject.id,
      taskId: "Tool toggles tasks",
      checked: true,
    }, store);
    expect(nested.isError).toBe(true);
    expect(nested.output).toContain("Unknown task id");

    const unknown = await execute(registry, projectContext, "workflow_task_check", {
      workflowId: wf_reject.id,
      taskId: "T9",
      checked: true,
    }, store);
    expect(unknown.isError).toBe(true);
    expect(unknown.output).toContain("Unknown task id");

    await stateManager.updateArtifacts(wf_reject.id, { TASKS: "PRD.md" });
    const nonTasks = await execute(registry, projectContext, "workflow_task_check", {
      workflowId: wf_reject.id,
      taskId: "T1",
      checked: true,
    }, store);
    expect(nonTasks.isError).toBe(true);
    expect(nonTasks.output).toContain("only supports TASKS.md");
  });

  test("workflow_propose_interactions rejects invalid proposal fields at schema level", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const wf = await stateManager.create({ title: "Invalid Interaction Proposal", type: "full_feature" });
    const store = createMockStore({ workflowId: wf.id, agentName: "product" });
    const invalidCases = [
      ["decisionKey", { decisionKey: "   " }],
      ["stage", { stage: "not_a_stage" }],
      ["sourceAgent", { sourceAgent: "foreman" }],
      ["kind", { kind: "note" }],
      ["question", { question: "" }],
      ["rationale", { rationale: "" }],
      ["options", { kind: "decision", options: ["Only one"] }],
      ["recommendedOption", { recommendedOption: "Not one of the options" }],
    ] as const;

    for (const [field, overrides] of invalidCases) {
      const result = await execute(registry, projectContext, "workflow_propose_interactions", {
        workflowId: wf.id,
        proposals: [validInteractionProposal(overrides)],
      }, store);

      expect(result.isError).toBe(true);
      expect(inferToolErrorKindFromResult(result)).toBe("schema");
      expect(result.output).toContain(field);
    }
  });

  test("workflow_propose_interactions dedupes by stage and decision key with revision increment", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const wf = await stateManager.create({ title: "Interaction Dedupe", type: "full_feature" });
    const store = createMockStore({ workflowId: wf.id, agentName: "critic" });

    const first = await execute(registry, projectContext, "workflow_propose_interactions", {
      workflowId: wf.id,
      proposals: [validInteractionProposal({ decisionKey: "requirements.scope", question: "Pick initial scope?" })],
    }, store);
    expect(first.isError).toBe(false);

    const second = await execute(registry, projectContext, "workflow_propose_interactions", {
      workflowId: wf.id,
      proposals: [validInteractionProposal({ decisionKey: "requirements.scope", question: "Pick revised scope?" })],
    }, store);

    expect(second.isError).toBe(false);
    const summary = JSON.parse(second.output);
    expect(summary).toMatchObject({ accepted: 1, created: 0, updated: 1 });
    const state = await stateManager.read(wf.id);
    expect(state.requiredInteractions).toHaveLength(1);
    expect(state.requiredInteractions[0]).toMatchObject({
      decisionKey: "requirements.scope",
      stage: "product_drafting",
      question: "Pick revised scope?",
      status: "proposed",
      revision: 2,
    });
  });

  test("workflow_request_interactions batches multiple proposals into one askUser call", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const wf = await stateManager.create({ title: "Interaction Batch", type: "full_feature" });
    await stateManager.updateStage(wf.id, "product_drafting");
    const store = createMockStore({ workflowId: wf.id, agentName: "orchestrator" });
    await execute(registry, projectContext, "workflow_propose_interactions", {
      workflowId: wf.id,
      proposals: [
        validInteractionProposal({ decisionKey: "requirements.scope", question: "Pick scope?", options: ["A", "B"], recommendedOption: "A" }),
        validInteractionProposal({ decisionKey: "requirements.timeline", kind: "preference", question: "Pick timeline?", options: ["Fast", "Safe"], recommendedOption: "Safe" }),
      ],
    }, store);
    const askUser = mock(async () => ({ answers: [["A"], ["Safe"]] }));

    const result = await execute(registry, projectContext, "workflow_request_interactions", {
      workflowId: wf.id,
      stage: "product_drafting",
    }, store, { askUser });

    expect(result.isError).toBe(false);
    expect(askUser).toHaveBeenCalledTimes(1);
    const firstAskUserCall = askUser.mock.calls[0] as unknown as Parameters<NonNullable<ToolExecutionContext["askUser"]>> | undefined;
    expect(firstAskUserCall).toBeDefined();
    expect(firstAskUserCall![0].questions).toHaveLength(2);
    expect(JSON.parse(result.output)).toMatchObject({ requested: 2, resolved: 2, cancelled: 0, pending: 0 });
  });

  test("workflow_request_interactions persists resolved answers in resolvedInteractions", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const wf = await stateManager.create({ title: "Interaction Answers", type: "full_feature" });
    const store = createMockStore({ workflowId: wf.id, agentName: "orchestrator" });
    await execute(registry, projectContext, "workflow_propose_interactions", {
      workflowId: wf.id,
      proposals: [validInteractionProposal({ decisionKey: "requirements.scope", options: ["Include", "Exclude"], recommendedOption: "Include" })],
    }, store);
    const askUser = mock(async () => ({ answers: [["Include"]] }));

    const result = await execute(registry, projectContext, "workflow_request_interactions", {
      workflowId: wf.id,
      stage: "product_drafting",
    }, store, { askUser });

    expect(result.isError).toBe(false);
    const state = await stateManager.read(wf.id);
    expect(state.requiredInteractions).toHaveLength(0);
    expect(state.resolvedInteractions).toHaveLength(1);
    expect(state.resolvedInteractions[0]).toMatchObject({
      decisionKey: "requirements.scope",
      status: "resolved",
      answer: "Include",
    });
    expect(state.resolvedInteractions[0]?.resolvedAt).toBeString();
  });

  test("workflow_request_interactions leaves partially unanswered decisions requested and cancels denied batches", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const partialWorkflow = await stateManager.create({ title: "Partial Interactions", type: "full_feature" });
    const partialStore = createMockStore({ workflowId: partialWorkflow.id, agentName: "orchestrator" });
    await execute(registry, projectContext, "workflow_propose_interactions", {
      workflowId: partialWorkflow.id,
      proposals: [
        validInteractionProposal({ decisionKey: "requirements.scope", question: "Pick scope?", options: ["A", "B"], recommendedOption: "A" }),
        validInteractionProposal({ decisionKey: "requirements.timeline", kind: "preference", question: "Pick timeline?", options: ["Fast", "Safe"], recommendedOption: "Safe" }),
      ],
    }, partialStore);

    const partial = await execute(registry, projectContext, "workflow_request_interactions", {
      workflowId: partialWorkflow.id,
      stage: "product_drafting",
    }, partialStore, { askUser: mock(async () => ({ answers: [["A"], []] })) });

    expect(partial.isError).toBe(false);
    expect(JSON.parse(partial.output)).toMatchObject({ requested: 2, resolved: 1, cancelled: 0, pending: 1 });
    const partialState = await stateManager.read(partialWorkflow.id);
    expect(partialState.resolvedInteractions.map((interaction) => interaction.decisionKey)).toEqual(["requirements.scope"]);
    expect(partialState.requiredInteractions).toHaveLength(1);
    expect(partialState.requiredInteractions[0]).toMatchObject({ decisionKey: "requirements.timeline", status: "requested" });

    const cancelledWorkflow = await stateManager.create({ title: "Cancelled Interactions", type: "full_feature" });
    const cancelledStore = createMockStore({ workflowId: cancelledWorkflow.id, agentName: "orchestrator" });
    await execute(registry, projectContext, "workflow_propose_interactions", {
      workflowId: cancelledWorkflow.id,
      proposals: [validInteractionProposal({ decisionKey: "requirements.cancel", options: ["A", "B"], recommendedOption: "A" })],
    }, cancelledStore);
    const cancelled = await execute(registry, projectContext, "workflow_request_interactions", {
      workflowId: cancelledWorkflow.id,
      stage: "product_drafting",
    }, cancelledStore, { askUser: mock(async () => ({ isError: true as const, reason: "Cancelled" })) });

    expect(cancelled.isError).toBe(false);
    expect(JSON.parse(cancelled.output)).toMatchObject({ requested: 1, resolved: 0, cancelled: 1, pending: 0 });
    const cancelledState = await stateManager.read(cancelledWorkflow.id);
    expect(cancelledState.requiredInteractions).toHaveLength(1);
    expect(cancelledState.requiredInteractions[0]).toMatchObject({ decisionKey: "requirements.cancel", status: "cancelled" });
    expect(cancelledState.requiredInteractions[0]?.cancelledAt).toBeString();
  });

  test("workflow_request_interactions re-requests cancelled interactions and clears cancelledAt on retry", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const wf = await stateManager.create({ title: "Cancelled Retry", type: "full_feature" });
    const store = createMockStore({ workflowId: wf.id, agentName: "orchestrator" });
    await execute(registry, projectContext, "workflow_propose_interactions", {
      workflowId: wf.id,
      proposals: [validInteractionProposal({ decisionKey: "requirements.retry", options: ["A", "B"], recommendedOption: "A" })],
    }, store);

    // First request: askUser cancels
    const first = await execute(registry, projectContext, "workflow_request_interactions", {
      workflowId: wf.id,
      stage: "product_drafting",
    }, store, { askUser: mock(async () => ({ isError: true as const, reason: "User dismissed" })) });
    expect(first.isError).toBe(false);
    expect(JSON.parse(first.output)).toMatchObject({ requested: 1, resolved: 0, cancelled: 1, pending: 0 });
    const cancelledState = await stateManager.read(wf.id);
    expect(cancelledState.requiredInteractions[0]).toMatchObject({ decisionKey: "requirements.retry", status: "cancelled" });
    expect(cancelledState.requiredInteractions[0]?.cancelledAt).toBeString();

    // Second request: cancelled interaction should be selectable and re-requested
    const second = await execute(registry, projectContext, "workflow_request_interactions", {
      workflowId: wf.id,
      stage: "product_drafting",
    }, store, { askUser: mock(async () => ({ answers: [["A"]] })) });
    expect(second.isError).toBe(false);
    expect(JSON.parse(second.output)).toMatchObject({ requested: 1, resolved: 1, cancelled: 0, pending: 0 });
    const resolvedState = await stateManager.read(wf.id);
    expect(resolvedState.requiredInteractions).toHaveLength(0);
    expect(resolvedState.resolvedInteractions[0]).toMatchObject({ decisionKey: "requirements.retry", status: "resolved", answer: "A" });
    expect(resolvedState.resolvedInteractions[0]?.cancelledAt).toBeUndefined();
  });

  test("workflow_request_interactions asks pending preference and clarification interactions", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const wf = await stateManager.create({ title: "No Interaction Pending", type: "full_feature" });
    const store = createMockStore({ workflowId: wf.id, agentName: "orchestrator" });
    await execute(registry, projectContext, "workflow_propose_interactions", {
      workflowId: wf.id,
      proposals: [validInteractionProposal({ decisionKey: "requirements.optional", kind: "clarification", options: ["Answered"], recommendedOption: "Answered" })],
    }, store);
    const askUser = mock(async () => ({ answers: [["Answered"]] }));

    const result = await execute(registry, projectContext, "workflow_request_interactions", {
      workflowId: wf.id,
      stage: "product_drafting",
    }, store, { askUser });

    expect(result.isError).toBe(false);
    expect(askUser).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.output)).toMatchObject({ requested: 1, resolved: 1, cancelled: 0, pending: 0 });
  });

  test("workflow_request_interactions is denied for product role context", async () => {
    const { registry, stateManager, projectContext } = createWorkflowRegistry();
    const wf = await stateManager.create({ title: "Product Request Denied", type: "full_feature" });
    const store = createMockStore({ workflowId: wf.id, agentName: "product" });
    await execute(registry, projectContext, "workflow_propose_interactions", {
      workflowId: wf.id,
      proposals: [validInteractionProposal()],
    }, store);

    const result = await execute(registry, projectContext, "workflow_request_interactions", {
      workflowId: wf.id,
      stage: "product_drafting",
    }, store, {
      allowedTools: ["workflow_read", "workflow_propose_interactions"],
      agentName: "product",
      askUser: mock(async () => ({ answers: [["Include billing dashboard"]] })),
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("TOOL_NOT_ALLOWED");
    expect(result.output).toContain("workflow_request_interactions");
  });

  test("registerBuiltinTools includes all workflow tools", () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, silentLogger);

    expect(registry.get("workflow_create")).toBeDefined();
    expect(registry.get("workflow_read")).toBeDefined();
    expect(registry.get("workflow_update_stage")).toBeDefined();
    expect(registry.get("workflow_propose_interactions")).toBeDefined();
    expect(registry.get("workflow_request_interactions")).toBeDefined();
    expect(registry.get("artifact_read")).toBeDefined();
    expect(registry.get("artifact_write")).toBeDefined();
    expect(registry.get("workflow_task_check")).toBeDefined();
  });

  describe("compact workflow output", () => {
    // These tests define the expected compact output shape BEFORE implementation (T7).
    // They FAIL against current code because tools return full JSON blobs.
    // After T7 implements the compact formatter, these tests will pass.
    //
    // Compact output shape: { workflowId, type, stage, status, artifactSummary?, interactionSummary?, message? }
    // Must NOT contain: requiredInteractions, resolvedInteractions, stageCompletions, artifacts (raw maps)

    test("workflow_create returns compact output without full state arrays", async () => {
      const { registry, projectContext } = createWorkflowRegistry();
      const store = createMockStore({ sessionId: "compact-create" });

      const result = await execute(registry, projectContext, "workflow_create", {
        title: "Compact Create Test",
        type: "full_feature",
      }, store);

      expect(result.isError).toBe(false);
      const output = JSON.parse(result.output);

      // Compact shape assertions — these will fail against current full-state output
      expect(output).toHaveProperty("workflowId");
      expect(output).toHaveProperty("type");
      expect(output).toHaveProperty("stage");
      expect(output).toHaveProperty("status");
      expect(output).toHaveProperty("message");

      // Must NOT contain full state arrays/maps
      expect(output).not.toHaveProperty("requiredInteractions");
      expect(output).not.toHaveProperty("resolvedInteractions");
      expect(output).not.toHaveProperty("stageCompletions");
      expect(output).not.toHaveProperty("artifacts");
    });

    test("workflow_read returns compact output without full state arrays", async () => {
      const { registry, stateManager, projectContext } = createWorkflowRegistry();
      const wf = await stateManager.create({ title: "Compact Read Test", type: "quick_fix" });

      const result = await execute(registry, projectContext, "workflow_read", {
        workflowId: wf.id,
      });

      expect(result.isError).toBe(false);
      const output = JSON.parse(result.output);

      // Compact shape assertions — will fail against current full-state output
      expect(output).toHaveProperty("workflowId");
      expect(output).toHaveProperty("type");
      expect(output).toHaveProperty("stage");
      expect(output).toHaveProperty("status");
      expect(output).toHaveProperty("message");

      // Must NOT contain full state arrays/maps
      expect(output).not.toHaveProperty("requiredInteractions");
      expect(output).not.toHaveProperty("resolvedInteractions");
      expect(output).not.toHaveProperty("stageCompletions");
      expect(output).not.toHaveProperty("artifacts");
    });

    test("workflow_update_stage returns compact output without full state arrays", async () => {
      const { registry, stateManager, projectContext } = createWorkflowRegistry();
      const wf = await stateManager.create({ title: "Compact Stage Update", type: "full_feature" });
      const store = createMockStore();
      store.getState().setWorkflowId(wf.id);

      const result = await execute(registry, projectContext, "workflow_update_stage", {
        workflowId: wf.id,
        stage: "product_drafting",
      }, store);

      expect(result.isError).toBe(false);
      const output = JSON.parse(result.output);

      // Compact shape assertions — will fail against current full-state output
      expect(output).toHaveProperty("workflowId");
      expect(output).toHaveProperty("type");
      expect(output).toHaveProperty("stage");
      expect(output).toHaveProperty("status");
      expect(output).toHaveProperty("message");

      // Must NOT contain full state arrays/maps
      expect(output).not.toHaveProperty("requiredInteractions");
      expect(output).not.toHaveProperty("resolvedInteractions");
      expect(output).not.toHaveProperty("stageCompletions");
      expect(output).not.toHaveProperty("artifacts");
    });

    test("workflow_update_stage with completeCurrentStage returns compact output without full state arrays", async () => {
      const { registry, stateManager, projectContext } = createWorkflowRegistry();
      const wf = await stateManager.create({ title: "Compact Completion Record", type: "quick_fix" });
      await stateManager.updateStage(wf.id, "quick_analysis");
      const store = createMockStore();
      store.getState().setWorkflowId(wf.id);

      const result = await execute(registry, projectContext, "workflow_update_stage", {
        workflowId: wf.id,
        stage: "quick_patch",
        completeCurrentStage: {
          criticPassed: true,
          evidence: ["evidence/check.md"],
        },
      }, store);

      expect(result.isError).toBe(false);
      const output = JSON.parse(result.output);

      // Compact shape assertions — will fail against current full-state output
      expect(output).toHaveProperty("workflowId");
      expect(output).toHaveProperty("type");
      expect(output).toHaveProperty("stage");
      expect(output).toHaveProperty("status");
      expect(output).toHaveProperty("message");

      // Must NOT contain full state arrays/maps
      expect(output).not.toHaveProperty("requiredInteractions");
      expect(output).not.toHaveProperty("resolvedInteractions");
      expect(output).not.toHaveProperty("stageCompletions");
      expect(output).not.toHaveProperty("artifacts");
    });

    test("workflow_update_stage with status completed returns compact output without full state arrays", async () => {
      const { registry, stateManager, projectContext } = createWorkflowRegistry();
      const wf = await stateManager.create({ title: "Compact Complete", type: "quick_fix" });
      await stateManager.updateStage(wf.id, "quick_verify");
      await stateManager.recordStageCompletion(wf.id, { stage: "quick_verify" });
      const store = createMockStore();
      store.getState().setWorkflowId(wf.id);

      const result = await execute(registry, projectContext, "workflow_update_stage", {
        workflowId: wf.id,
        stage: "quick_verify",
        status: "completed",
      }, store);

      expect(result.isError).toBe(false);
      const output = JSON.parse(result.output);

      // Compact shape assertions — will fail against current full-state output
      expect(output).toHaveProperty("workflowId");
      expect(output).toHaveProperty("type");
      expect(output).toHaveProperty("stage");
      expect(output).toHaveProperty("status");
      expect(output).toHaveProperty("message");

      // Must NOT contain full state arrays/maps
      expect(output).not.toHaveProperty("requiredInteractions");
      expect(output).not.toHaveProperty("resolvedInteractions");
      expect(output).not.toHaveProperty("stageCompletions");
      expect(output).not.toHaveProperty("artifacts");
    });

    test("workflow_propose_interactions does not embed full state in output", async () => {
      const { registry, stateManager, projectContext } = createWorkflowRegistry();
      const wf = await stateManager.create({ title: "Compact Propose", type: "full_feature" });
      const store = createMockStore({ workflowId: wf.id, agentName: "product" });

      const result = await execute(registry, projectContext, "workflow_propose_interactions", {
        workflowId: wf.id,
        proposals: [validInteractionProposal()],
      }, store);

      expect(result.isError).toBe(false);
      const output = JSON.parse(result.output);

      // Compact shape assertions — will fail against current output which embeds full state
      expect(output).toHaveProperty("workflowId");
      expect(output).toHaveProperty("message");

      // Must NOT embed full state field
      expect(output).not.toHaveProperty("state");

      // Must NOT contain full state arrays/maps
      expect(output).not.toHaveProperty("requiredInteractions");
      expect(output).not.toHaveProperty("resolvedInteractions");
      expect(output).not.toHaveProperty("stageCompletions");
      expect(output).not.toHaveProperty("artifacts");
    });
  });

  describe("artifact_read truncation", () => {
    // These tests define the expected truncation behavior BEFORE implementation (T8).
    // They FAIL against current code because artifact_read returns full body
    // with no truncation metadata. After T8 implements truncation, these tests will pass.
    //
    // Truncation output shape (default, unbounded):
    //   { path, content?, frontmatter?, body?, truncated, bodyChars, returnedBodyChars, fullContentRequestHint }
    // Multi-file list mode:
    //   { workflowId, kind, paths } — must NOT be truncated

    test("artifact_read with long body returns truncated output with metadata", async () => {
      const { registry, stateManager, projectContext } = createWorkflowRegistry();
      const wf = await stateManager.create({ title: "Truncation Test", type: "full_feature" });
      const store = createMockStore();
      store.getState().setWorkflowId(wf.id);

      const LONG_BODY = "# Long Artifact\n\n" + "x".repeat(5000);

      await execute(registry, projectContext, "artifact_write", {
        workflowId: wf.id,
        kind: "PRD",
        content: LONG_BODY,
      }, store);

      const result = await execute(registry, projectContext, "artifact_read", {
        workflowId: wf.id,
        kind: "PRD",
      });

      expect(result.isError).toBe(false);
      const output = JSON.parse(result.output);

      // Truncation metadata — will fail against current full-body output
      expect(output).toHaveProperty("truncated");
      expect(output.truncated).toBe(true);
      expect(output).toHaveProperty("bodyChars");
      expect(output.bodyChars).toBeGreaterThan(5000);
      expect(output).toHaveProperty("returnedBodyChars");
      expect(output.returnedBodyChars).toBeLessThan(output.bodyChars);
      expect(output).toHaveProperty("fullContentRequestHint");
      expect(typeof output.fullContentRequestHint).toBe("string");
      expect(output.fullContentRequestHint.length).toBeGreaterThan(0);
    });

    test("artifact_read with includeFullContent: true returns complete body", async () => {
      const { registry, stateManager, projectContext } = createWorkflowRegistry();
      const wf = await stateManager.create({ title: "Full Content Test", type: "full_feature" });
      const store = createMockStore();
      store.getState().setWorkflowId(wf.id);

      const LONG_BODY = "# Full Artifact\n\n" + "y".repeat(3000);

      await execute(registry, projectContext, "artifact_write", {
        workflowId: wf.id,
        kind: "PRD",
        content: LONG_BODY,
      }, store);

      // includeFullContent is an unrecognized field in current strictObject schema.
      // This call will fail because the schema rejects it, so the assertion
      // expect(result.isError).toBe(false) will fail — this is the "red" phase.
      const result = await execute(registry, projectContext, "artifact_read", {
        workflowId: wf.id,
        kind: "PRD",
        includeFullContent: true,
      });

      expect(result.isError).toBe(false);
      const output = JSON.parse(result.output);

      // Full body must be present when includeFullContent is set
      expect(output).toHaveProperty("body");
      expect(output.body).toBe(LONG_BODY);
      // No truncation metadata when full content requested
      expect(output).not.toHaveProperty("truncated");
    });

    test("artifact_read rejects invalid maxChars values at schema level", async () => {
      const { registry, stateManager, projectContext } = createWorkflowRegistry();

      // Use a real workflow (artifact_write not needed — schema check happens first)
      const wf = await stateManager.create({ title: "MaxChars Schema", type: "full_feature" });

      // maxChars: 0 is rejected (must be positive)
      const zeroResult = await execute(registry, projectContext, "artifact_read", {
        workflowId: wf.id,
        kind: "PRD",
        maxChars: 0,
      });
      expect(zeroResult.isError).toBe(true);
      expect(inferToolErrorKindFromResult(zeroResult)).toBe("schema");

      // maxChars: -1 is rejected (must be positive)
      const negativeResult = await execute(registry, projectContext, "artifact_read", {
        workflowId: wf.id,
        kind: "PRD",
        maxChars: -1,
      });
      expect(negativeResult.isError).toBe(true);
      expect(inferToolErrorKindFromResult(negativeResult)).toBe("schema");
    });

    test("artifact_read multi-file list mode returns paths without truncation", async () => {
      const { registry, stateManager, projectContext } = createWorkflowRegistry();
      const wf = await stateManager.create({ title: "Multi-file List", type: "full_feature" });
      const store = createMockStore();
      store.getState().setWorkflowId(wf.id);

      // Write two multi-file EVIDENCE artifacts
      await execute(registry, projectContext, "artifact_write", {
        workflowId: wf.id,
        kind: "EVIDENCE",
        name: "report1",
        content: "Evidence content\n",
      }, store);
      await execute(registry, projectContext, "artifact_write", {
        workflowId: wf.id,
        kind: "EVIDENCE",
        name: "report2",
        content: "More evidence\n",
      }, store);

      // Read by kind to get paths list
      const result = await execute(registry, projectContext, "artifact_read", {
        workflowId: wf.id,
        kind: "EVIDENCE",
      });

      expect(result.isError).toBe(false);
      const output = JSON.parse(result.output);

      // Multi-file list shape must be preserved
      expect(output).toMatchObject({
        workflowId: wf.id,
        kind: "EVIDENCE",
      });
      expect(output).toHaveProperty("paths");
      expect(Array.isArray(output.paths)).toBe(true);
      expect(output.paths.length).toBeGreaterThanOrEqual(1);

      // Multi-file list mode must NOT have truncation metadata or body
      expect(output).not.toHaveProperty("truncated");
      expect(output).not.toHaveProperty("body");
      expect(output).not.toHaveProperty("bodyChars");
      expect(output).not.toHaveProperty("returnedBodyChars");
      expect(output).not.toHaveProperty("fullContentRequestHint");
    });
  });

  describe("clean-break critic lifecycle contract", () => {
    // These tests define the NEW contract AFTER T10 removes criticDecision from
    // workflow_update_stage. The Orchestrator will own Critic-result handling,
    // and workflow_update_stage will support generic terminal lifecycle status
    // (failed/paused + lastError).
    //
    // They FAIL against current code because:
    // 1. criticDecision is still accepted by the schema (should be rejected)
    // 2. status: "failed"/"paused" + lastError are not yet supported
    // 3. After T10 implements the clean break, these tests will pass.

    test("workflow_update_stage schema REJECTS criticDecision input", async () => {
      const { registry, stateManager, projectContext } = createWorkflowRegistry();
      const wf = await stateManager.create({ title: "Clean Break Critic", type: "full_feature" });
      await stateManager.updateStage(wf.id, "critic_prd_review");
      const store = createMockStore();
      store.getState().setWorkflowId(wf.id);

      // After T10, criticDecision should be rejected by the schema.
      // Currently it IS accepted, so this assertion FAILS (red phase).
      const result = await execute(registry, projectContext, "workflow_update_stage", {
        workflowId: wf.id,
        stage: "critic_prd_review",
        criticDecision: "approved",
      }, store);

      expect(result.isError).toBe(true);
      expect(inferToolErrorKindFromResult(result)).toBe("schema");
      expect(result.output).toContain("criticDecision");
    });

    test("workflow_update_stage ACCEPTS status: failed with lastError (generic terminal lifecycle)", async () => {
      const { registry, stateManager, projectContext } = createWorkflowRegistry();
      const wf = await stateManager.create({ title: "Generic Fail", type: "full_feature" });
      const store = createMockStore();
      store.getState().setWorkflowId(wf.id);

      // After T10, workflow_update_stage should accept status: "failed" + lastError.
      // Currently these fields don't exist in the schema, so this FAILS (red phase).
      const result = await execute(registry, projectContext, "workflow_update_stage", {
        workflowId: wf.id,
        stage: "product_drafting",
        status: "failed",
        lastError: "Critic rejected PRD: missing acceptance criteria",
      }, store);

      expect(result.isError).toBe(false);
      const output = JSON.parse(result.output);
      expect(output).toMatchObject({
        status: "failed",
        lastError: "Critic rejected PRD: missing acceptance criteria",
      });
    });

    test("workflow_update_stage ACCEPTS status: paused with reason (user withholding approval)", async () => {
      const { registry, stateManager, projectContext } = createWorkflowRegistry();
      const wf = await stateManager.create({ title: "User Paused", type: "full_feature" });
      const store = createMockStore();
      store.getState().setWorkflowId(wf.id);

      // After T10, workflow_update_stage should accept status: "paused" with a reason.
      // Currently these fields don't exist in the schema, so this FAILS (red phase).
      const result = await execute(registry, projectContext, "workflow_update_stage", {
        workflowId: wf.id,
        stage: "awaiting_user_approval",
        status: "paused",
        lastError: "User withheld execution approval pending clarification",
      }, store);

      expect(result.isError).toBe(false);
      const output = JSON.parse(result.output);
      expect(output).toMatchObject({
        status: "paused",
        lastError: "User withheld execution approval pending clarification",
      });
    });

    test("workflow state reflects failed status and lastError after workflow_update_stage with status: failed", async () => {
      const { registry, stateManager, projectContext } = createWorkflowRegistry();
      const wf = await stateManager.create({ title: "State Reflects Fail", type: "full_feature" });
      const store = createMockStore();
      store.getState().setWorkflowId(wf.id);

      // After T10, setting status: "failed" via workflow_update_stage should persist
      // the failure to workflow state. Currently the schema doesn't support this, so FAILS.
      await execute(registry, projectContext, "workflow_update_stage", {
        workflowId: wf.id,
        stage: "product_drafting",
        status: "failed",
        lastError: "Critic rejected PRD: missing acceptance criteria",
      }, store);

      const state = await stateManager.read(wf.id);
      expect(state.status).toBe("failed");
      expect(state.lastError).toBe("Critic rejected PRD: missing acceptance criteria");
    });
  });
});
