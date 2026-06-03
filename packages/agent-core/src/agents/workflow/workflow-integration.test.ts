import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { WorkflowArtifactManager } from "./artifacts";
import { processCriticDecision } from "./critic-protocol";
import { validateTransition } from "./guards";
import { WorkflowStateManager, type WorkflowStage } from "./state";
import {
  calculateReadyWave,
  parseTasksMarkdown,
  toggleTaskCheckbox,
  validateTasksMarkdown,
} from "./tasks-format";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "workflow-integration");
const WORKFLOW_ID = "wf-mvp-integration";

const TASKS_MARKDOWN = `# TASKS

- [ ] T1. Implement feature slice

  Agent: builder
  Dependencies: none
  Description: Implement the smallest production slice for the approved specification.
  Acceptance:
    - [ ] Production slice exists
  QA:
    - [ ] Targeted test passes

- [ ] T2. Review feature slice

  Agent: reviewer
  Dependencies: T1
  Description: Review the builder output and approve the completed slice.
  Acceptance:
    - [ ] Review approves the slice
  QA:
    - [ ] No blocking findings remain
`;

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("mocked workflow MVP integration", () => {
  test("drives the complete workflow path without providers or PLAN.md", async () => {
    const stateManager = new WorkflowStateManager(TMP_DIR);
    const artifactManager = new WorkflowArtifactManager(TMP_DIR, stateManager);
    const delegateBuilder = mock(async () => ({ ok: true, evidencePath: "evidence/T1-builder.md" }));
    const delegateReviewer = mock(async () => ({ ok: true, evidencePath: "evidence/T2-reviewer.md" }));

    await stateManager.create({ id: WORKFLOW_ID, type: "full_feature" });
    await transition(stateManager, "idle", "product_drafting", false);

    await artifactManager.write({
      workflowId: WORKFLOW_ID,
      kind: "PRD",
      path: "PRD.md",
      frontmatter: { owner: "product", status: "draft" },
      content: "# PRD\n\nShip a mocked MVP workflow integration path.",
    });
    await transition(stateManager, "product_drafting", "critic_prd_review", false);

    await artifactManager.write({
      workflowId: WORKFLOW_ID,
      kind: "CRITIC_REPORT",
      path: "critic-reports/prd.md",
      frontmatter: { reviewer: "critic", decision: "approved" },
      content: "PRD approved.",
    });
    const prdDecision = await processCriticDecision(
      {
        workflowId: WORKFLOW_ID,
        decision: "approved",
        currentStage: "critic_prd_review",
        criticReportPath: "critic-reports/prd.md",
      },
      stateManager,
    );
    expect(prdDecision.newState.stage).toBe("spec_drafting");

    await artifactManager.write({
      workflowId: WORKFLOW_ID,
      kind: "SPEC",
      path: "SPEC.md",
      frontmatter: { owner: "spec", status: "draft" },
      content: "# SPEC\n\nImplement the mocked path using workflow managers directly.",
    });
    await artifactManager.write({
      workflowId: WORKFLOW_ID,
      kind: "TASKS",
      path: "TASKS.md",
      frontmatter: { owner: "spec", status: "draft" },
      content: TASKS_MARKDOWN,
    });
    const tasksDraft = await artifactManager.read(WORKFLOW_ID, "TASKS.md");
    expect(validateTasksMarkdown(tasksDraft.body).valid).toBe(true);
    await transition(stateManager, "spec_drafting", "critic_spec_review", false);

    await artifactManager.write({
      workflowId: WORKFLOW_ID,
      kind: "CRITIC_REPORT",
      path: "critic-reports/spec-tasks.md",
      frontmatter: { reviewer: "critic", decision: "approved" },
      content: "SPEC and TASKS approved.",
    });
    const specDecision = await processCriticDecision(
      {
        workflowId: WORKFLOW_ID,
        decision: "approved",
        currentStage: "critic_spec_review",
        criticReportPath: "critic-reports/spec-tasks.md",
      },
      stateManager,
    );
    expect(specDecision.newState.stage).toBe("awaiting_user_approval");

    await transition(stateManager, "awaiting_user_approval", "foreman_executing", true);

    let currentTasks = (await artifactManager.read(WORKFLOW_ID, "TASKS.md")).body;
    for (const expectedWave of [["T1"], ["T2"]]) {
      const readyWave = calculateReadyWave(parseTasksMarkdown(currentTasks));
      expect(readyWave.map((task) => task.id)).toEqual(expectedWave);

      for (const task of readyWave) {
        const result = task.agent === "reviewer" ? await delegateReviewer() : await delegateBuilder();
        expect(result.ok).toBe(true);
        await artifactManager.write({
          workflowId: WORKFLOW_ID,
          kind: "EVIDENCE",
          path: result.evidencePath,
          content: `${task.id} ${task.agent} succeeded.`,
        });
        currentTasks = toggleTaskCheckbox(currentTasks, task.id, true);
      }

      await artifactManager.write({
        workflowId: WORKFLOW_ID,
        kind: "TASKS",
        path: "TASKS.md",
        frontmatter: { owner: "foreman", status: "checked" },
        content: currentTasks,
      });
      currentTasks = (await artifactManager.read(WORKFLOW_ID, "TASKS.md")).body;
    }

    expect(calculateReadyWave(parseTasksMarkdown(currentTasks))).toEqual([]);
    await transition(stateManager, "foreman_executing", "final_review", false);
    await artifactManager.write({
      workflowId: WORKFLOW_ID,
      kind: "FINAL_REPORT",
      path: "FINAL_REPORT.md",
      frontmatter: { owner: "foreman", status: "complete" },
      content: "# Final Report\n\nWorkflow completed with mocked builder and reviewer outputs.",
    });
    await stateManager.updateStatus(WORKFLOW_ID, "completed");

    const finalState = await stateManager.read(WORKFLOW_ID);
    const discovered = await stateManager.listWorkflows({ status: "completed" });
    const finalTasks = parseTasksMarkdown((await artifactManager.read(WORKFLOW_ID, "TASKS.md")).body);

    expect(finalState.stage).toBe("final_review");
    expect(finalState.status).toBe("completed");
    expect(discovered.map((workflow) => workflow.id)).toContain(WORKFLOW_ID);
    expect(finalState.artifacts.PRD).toBe("PRD.md");
    expect(finalState.artifacts.SPEC).toBe("SPEC.md");
    expect(finalState.artifacts.TASKS).toBe("TASKS.md");
    expect(finalState.artifacts.CRITIC_REPORT).toEqual([
      "critic-reports/prd.md",
      "critic-reports/spec-tasks.md",
    ]);
    expect(finalState.artifacts.EVIDENCE).toEqual(["evidence/T1-builder.md", "evidence/T2-reviewer.md"]);
    expect(finalState.artifacts.FINAL_REPORT).toBe("FINAL_REPORT.md");
    expect(finalTasks.every((task) => task.checked)).toBe(true);
    expect(delegateBuilder).toHaveBeenCalledTimes(1);
    expect(delegateReviewer).toHaveBeenCalledTimes(1);
    expect(await Bun.file(join(TMP_DIR, ".specra", "workflows", WORKFLOW_ID, "PLAN.md")).exists()).toBe(false);
  });
});

async function transition(
  stateManager: WorkflowStateManager,
  currentStage: WorkflowStage,
  targetStage: WorkflowStage,
  hasUserApproval: boolean,
): Promise<void> {
  const state = await stateManager.read(WORKFLOW_ID);
  expect(state.stage).toBe(currentStage);

  const result = validateTransition({
    workflowId: WORKFLOW_ID,
    workflowType: state.type,
    currentStage,
    targetStage,
    retryCount: state.retryCount,
    maxRetries: state.maxRetries,
    hasArtifact: (kind: string) => Boolean(state.artifacts[kind as keyof typeof state.artifacts]),
    hasUserApproval,
  });

  expect(result).toEqual({ allowed: true });
  await stateManager.updateStage(WORKFLOW_ID, targetStage);
}
