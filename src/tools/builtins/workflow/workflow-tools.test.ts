import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { WorkflowArtifactManager } from "../../../agents/workflow/artifacts";
import { WorkflowStateManager } from "../../../agents/workflow/state";
import { createMockStore } from "../../../store/test-helpers";
import { registerBuiltinTools } from "../../../core/register-tools";
import { inferToolErrorKindFromResult } from "../../errors";
import { createRegistry, ToolRegistry } from "../../registry";
import type { AnyToolDescriptor, ToolExecutionContext } from "../../types";
import {
  createArtifactReadTool,
  createArtifactWriteTool,
  createWorkflowCreateTool,
  createWorkflowReadTool,
  createWorkflowTaskCheckTool,
  createWorkflowUpdateStageTool,
} from "./index";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "workflow-tools");

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
} {
  const stateManager = new WorkflowStateManager(TMP_DIR);
  const artifactManager = new WorkflowArtifactManager(TMP_DIR, stateManager);
  const descriptors: AnyToolDescriptor[] = [
    createWorkflowCreateTool(stateManager),
    createWorkflowReadTool(stateManager),
    createWorkflowUpdateStageTool(stateManager, artifactManager),
    createArtifactReadTool(artifactManager),
    createArtifactWriteTool(artifactManager),
    createWorkflowTaskCheckTool(stateManager, artifactManager),
  ];
  return { registry: createRegistry(descriptors), stateManager, artifactManager };
}

function makeCtx(toolName: string, input: unknown): ToolExecutionContext {
  return {
    store: createMockStore(),
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
      "artifact_read",
      "artifact_write",
      "workflow_task_check",
    ]),
    workspaceRoot: TMP_DIR,
  };
}

async function execute(registry: ToolRegistry, toolName: string, input: unknown) {
  return registry.execute(
    { toolName, toolCallId: `${toolName}-call`, input },
    makeCtx(toolName, input),
  );
}

describe("workflow builtin tools", () => {
  test("workflow_create and workflow_read round-trip workflow state", async () => {
    const { registry } = createWorkflowRegistry();

    const created = await execute(registry, "workflow_create", { id: "wf-create" });
    expect(created.isError).toBe(false);
    expect(JSON.parse(created.output)).toMatchObject({
      id: "wf-create",
      stage: "idle",
      status: "active",
    });

    const read = await execute(registry, "workflow_read", { workflowId: "wf-create" });
    expect(read.isError).toBe(false);
    expect(JSON.parse(read.output)).toMatchObject({ id: "wf-create", stage: "idle" });
  });

  test("workflow_update_stage mutates stage with guarded transitions only", async () => {
    const { registry, stateManager } = createWorkflowRegistry();
    await stateManager.create({ id: "wf-stage" });

    const updated = await execute(registry, "workflow_update_stage", {
      workflowId: "wf-stage",
      stage: "product_drafting",
    });
    expect(updated.isError).toBe(false);
    expect(JSON.parse(updated.output)).toMatchObject({
      id: "wf-stage",
      stage: "product_drafting",
      status: "active",
    });

    const invalid = await execute(registry, "workflow_update_stage", {
      workflowId: "wf-stage",
      stage: "not_a_stage",
    });
    expect(invalid.isError).toBe(true);
    expect(inferToolErrorKindFromResult(invalid)).toBe("schema");

    const denied = await execute(registry, "workflow_update_stage", {
      workflowId: "wf-stage",
      stage: "foreman_executing",
    });
    expect(denied.isError).toBe(true);
    expect(denied.output).toContain("WorkflowTransitionError");
  });

  test("artifact_write and artifact_read use artifact manager without changing stage or status", async () => {
    const { registry, stateManager } = createWorkflowRegistry();
    await stateManager.create({ id: "wf-artifact" });
    await stateManager.updateStage("wf-artifact", "product_drafting");
    await stateManager.updateStatus("wf-artifact", "paused");

    const written = await execute(registry, "artifact_write", {
      workflowId: "wf-artifact",
      kind: "PRD",
      path: "PRD.md",
      content: "# Product\n",
      frontmatter: { owner: "pm" },
    });
    expect(written.isError).toBe(false);
    expect(JSON.parse(written.output).state).toMatchObject({
      stage: "product_drafting",
      status: "paused",
      artifacts: { PRD: "PRD.md" },
    });

    const state = await stateManager.read("wf-artifact");
    expect(state.stage).toBe("product_drafting");
    expect(state.status).toBe("paused");

    const read = await execute(registry, "artifact_read", {
      workflowId: "wf-artifact",
      path: "PRD.md",
    });
    expect(read.isError).toBe(false);
    expect(JSON.parse(read.output)).toMatchObject({
      path: "PRD.md",
      frontmatter: { owner: "pm" },
      body: "# Product\n",
    });
  });

  test("workflow_task_check toggles only top-level TASKS.md task checkboxes", async () => {
    const { registry, stateManager, artifactManager } = createWorkflowRegistry();
    await stateManager.create({ id: "wf-tasks" });
    await artifactManager.write({
      workflowId: "wf-tasks",
      kind: "TASKS",
      path: "TASKS.md",
      frontmatter: { kind: "TASKS" },
      content: VALID_TASKS,
    });

    const result = await execute(registry, "workflow_task_check", {
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
    const { registry, stateManager, artifactManager } = createWorkflowRegistry();
    await stateManager.create({ id: "wf-reject" });
    await artifactManager.write({
      workflowId: "wf-reject",
      kind: "TASKS",
      path: "TASKS.md",
      frontmatter: { kind: "TASKS" },
      content: VALID_TASKS,
    });

    const nested = await execute(registry, "workflow_task_check", {
      workflowId: "wf-reject",
      taskId: "Tool toggles tasks",
      checked: true,
    });
    expect(nested.isError).toBe(true);
    expect(nested.output).toContain("Unknown task id");

    const unknown = await execute(registry, "workflow_task_check", {
      workflowId: "wf-reject",
      taskId: "T9",
      checked: true,
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.output).toContain("Unknown task id");

    await stateManager.updateArtifacts("wf-reject", { TASKS: "PRD.md" });
    const nonTasks = await execute(registry, "workflow_task_check", {
      workflowId: "wf-reject",
      taskId: "T1",
      checked: true,
    });
    expect(nonTasks.isError).toBe(true);
    expect(nonTasks.output).toContain("only supports TASKS.md");
  });

  test("registerBuiltinTools includes all six workflow tools", () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);

    expect(registry.get("workflow_create")).toBeDefined();
    expect(registry.get("workflow_read")).toBeDefined();
    expect(registry.get("workflow_update_stage")).toBeDefined();
    expect(registry.get("artifact_read")).toBeDefined();
    expect(registry.get("artifact_write")).toBeDefined();
    expect(registry.get("workflow_task_check")).toBeDefined();
  });
});
