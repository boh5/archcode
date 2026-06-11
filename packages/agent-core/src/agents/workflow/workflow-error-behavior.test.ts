import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { WorkflowArtifactManager } from "./artifacts";
import { processCriticDecision } from "./critic-protocol";
import { validateTransition } from "./guards";
import { WorkflowStateManager } from "./state";
import {
  parseTasksMarkdown,
  toggleTaskCheckbox,
  validateTasksMarkdown,
} from "./tasks-format";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "workflow-error-behavior");

const THREE_TASKS_MARKDOWN = `# TASKS

- [ ] T1. Build first slice

  Agent: builder
  Dependencies: none
  Description: Build the first independently executable slice.
  Acceptance:
    - [ ] First slice exists
  QA:
    - [ ] First slice verified

- [ ] T2. Build second slice

  Agent: builder
  Dependencies: none
  Description: Build the second independently executable slice.
  Acceptance:
    - [ ] Second slice exists
  QA:
    - [ ] Second slice verified

- [ ] T3. Integrate slices

  Agent: builder
  Dependencies: T1, T2
  Description: Integrate the first and second slices after both pass review.
  Acceptance:
    - [ ] Integration exists
  QA:
    - [ ] Integration verified
`;

const CIRCULAR_TASKS_MARKDOWN = `# TASKS

- [ ] T1. First blocked task

  Agent: builder
  Dependencies: T2
  Description: First task in a dependency cycle.
  Acceptance:
    - [ ] First done
  QA:
    - [ ] First checked

- [ ] T2. Second blocked task

  Agent: builder
  Dependencies: T1
  Description: Second task in a dependency cycle.
  Acceptance:
    - [ ] Second done
  QA:
    - [ ] Second checked
`;

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("workflow error and partial failure behavior", () => {
  test("Product timeout leaves workflow failed with lastError", async () => {
    const stateManager = new WorkflowStateManager(TMP_DIR);
    const wf_product_timeout = await stateManager.create({ title: "Product Timeout", type: "full_feature" });
    await stateManager.updateStage(wf_product_timeout.id, "product_drafting");

    const failed = await stateManager.fail(wf_product_timeout.id, "Product timeout");

    expect(failed.stage).toBe("product_drafting");
    expect(failed.status).toBe("failed");
    expect(failed.lastError).toBe("Product timeout");
    const persisted = await stateManager.read(wf_product_timeout.id);
    expect(persisted).toMatchObject({
      stage: "product_drafting",
      status: "failed",
      lastError: "Product timeout",
    });
  });

  test("Critic rejection hard-fails workflow and preserves critic report path", async () => {
    const stateManager = new WorkflowStateManager(TMP_DIR);
    const artifacts = new WorkflowArtifactManager(TMP_DIR, stateManager);
    const wf_critic_reject = await stateManager.create({ title: "Critic Reject", type: "full_feature" });
    await stateManager.updateStage(wf_critic_reject.id, "product_drafting");
    await artifacts.write({
      workflowId: wf_critic_reject.id,
      kind: "PRD",
      path: "PRD.md",
      content: "# PRD\n",
    });
    await stateManager.updateStage(wf_critic_reject.id, "critic_prd_review");
    await artifacts.write({
      workflowId: wf_critic_reject.id,
      kind: "CRITIC_REPORT",
      path: "critic-reports/prd-rejected.md",
      content: "Reject: scope is unsafe.",
    });

    const result = await processCriticDecision({
      workflowId: wf_critic_reject.id,
      decision: "rejected",
      currentStage: "critic_prd_review",
      criticReportPath: "critic-reports/prd-rejected.md",
    }, stateManager);

    expect(result.newState.stage).toBe("critic_prd_review");
    expect(result.newState.status).toBe("failed");
    expect(result.newState.lastError).toContain("Critic rejected");
    expect(result.newState.lastError).toContain("critic-reports/prd-rejected.md");
    expect(result.newState.artifacts.CRITIC_REPORT).toEqual(["critic-reports/prd-rejected.md"]);
    const criticReport = await artifacts.read(wf_critic_reject.id, "critic-reports/prd-rejected.md");
    expect(criticReport).toMatchObject({ body: "Reject: scope is unsafe." });
  });

  test("user rejection prevents foreman_executing and remains awaiting_user_approval", async () => {
    const stateManager = new WorkflowStateManager(TMP_DIR);
    const wf_user_reject = await stateManager.create({
      title: "User Reject",
      type: "full_feature",
      artifacts: { SPEC: "SPEC.md", TASKS: "TASKS.md" },
    });
    await stateManager.updateStage(wf_user_reject.id, "awaiting_user_approval");
    await stateManager.recordStageCompletion(wf_user_reject.id, { stage: "awaiting_user_approval" });
    const current = await stateManager.read(wf_user_reject.id);

    const result = validateTransition({
      workflowId: wf_user_reject.id,
      workflowType: current.type,
      currentStage: current.stage,
      targetStage: "foreman_executing",
      retryCount: current.retryCount,
      maxRetries: current.maxRetries,
      hasArtifact: (kind: string) => Boolean(current.artifacts[kind as keyof typeof current.artifacts]),
      hasStageCompletion: (stage) => Boolean(current.stageCompletions[stage]),
      hasUserApproval: false,
    });

    expect(result.allowed).toBe(false);
    expect(result.errorName).toBe("WorkflowTransitionError");
    expect(result.error).toContain("without user approval");
    expect((await stateManager.read(wf_user_reject.id)).stage).toBe("awaiting_user_approval");
  });

  test("Foreman partial wave failure preserves unchecked tasks and successful evidence", async () => {
    const stateManager = new WorkflowStateManager(TMP_DIR);
    const artifacts = new WorkflowArtifactManager(TMP_DIR, stateManager);
    const wf_partial_wave = await stateManager.create({ title: "Partial Wave", type: "full_feature" });
    await artifacts.write({
      workflowId: wf_partial_wave.id,
      kind: "TASKS",
      path: "TASKS.md",
      content: THREE_TASKS_MARKDOWN,
    });
    await artifacts.write({
      workflowId: wf_partial_wave.id,
      kind: "EVIDENCE",
      path: "evidence/T1-builder.md",
      content: "T1 builder and reviewer passed before the wave failed.",
    });
    const withOnlyT1Checked = toggleTaskCheckbox(THREE_TASKS_MARKDOWN, "T1", true);
    await artifacts.write({
      workflowId: wf_partial_wave.id,
      kind: "TASKS",
      path: "TASKS.md",
      content: withOnlyT1Checked,
    });
    await stateManager.fail(wf_partial_wave.id, "Foreman wave failed after T1");

    const tasks = parseTasksMarkdown((await artifacts.read(wf_partial_wave.id, "TASKS.md")).body);
    const state = await stateManager.read(wf_partial_wave.id);

    expect(tasks.find((task) => task.id === "T1")?.checked).toBe(true);
    expect(tasks.find((task) => task.id === "T2")?.checked).toBe(false);
    expect(tasks.find((task) => task.id === "T3")?.checked).toBe(false);
    expect(state.status).toBe("failed");
    expect(state.lastError).toBe("Foreman wave failed after T1");
    expect(state.artifacts.EVIDENCE).toEqual(["evidence/T1-builder.md"]);
    const evidence = await artifacts.read(wf_partial_wave.id, "evidence/T1-builder.md");
    expect(evidence).toMatchObject({
      body: "T1 builder and reviewer passed before the wave failed.",
    });
  });

  test("Builder failure plus Reviewer rejection preserves evidence and leaves task unchecked", async () => {
    const stateManager = new WorkflowStateManager(TMP_DIR);
    const artifacts = new WorkflowArtifactManager(TMP_DIR, stateManager);
    const wf_reviewer_reject = await stateManager.create({ title: "Reviewer Reject", type: "full_feature" });
    await artifacts.write({
      workflowId: wf_reviewer_reject.id,
      kind: "TASKS",
      path: "TASKS.md",
      content: THREE_TASKS_MARKDOWN,
    });
    await artifacts.write({
      workflowId: wf_reviewer_reject.id,
      kind: "EVIDENCE",
      path: "evidence/T1-builder-failed.md",
      content: "Builder failed verification for T1.",
    });
    await artifacts.write({
      workflowId: wf_reviewer_reject.id,
      kind: "EVIDENCE",
      path: "evidence/T1-reviewer-rejected.md",
      content: "Reviewer rejected T1 because verification failed.",
    });
    await stateManager.fail(wf_reviewer_reject.id, "Reviewer rejected T1 after builder failure");

    const tasks = parseTasksMarkdown((await artifacts.read(wf_reviewer_reject.id, "TASKS.md")).body);
    const state = await stateManager.read(wf_reviewer_reject.id);

    expect(tasks.find((task) => task.id === "T1")?.checked).toBe(false);
    expect(state.artifacts.EVIDENCE).toEqual([
      "evidence/T1-builder-failed.md",
      "evidence/T1-reviewer-rejected.md",
    ]);
    const builderEvidence = await artifacts.read(wf_reviewer_reject.id, "evidence/T1-builder-failed.md");
    const reviewerEvidence = await artifacts.read(wf_reviewer_reject.id, "evidence/T1-reviewer-rejected.md");
    expect(builderEvidence).toMatchObject({ body: "Builder failed verification for T1." });
    expect(reviewerEvidence).toMatchObject({
      body: "Reviewer rejected T1 because verification failed.",
    });
  });

  test("corrupt artifact read returns a named error without crashing unrelated reads", async () => {
    const stateManager = new WorkflowStateManager(TMP_DIR);
    const artifacts = new WorkflowArtifactManager(TMP_DIR, stateManager);
    const wf_corrupt_artifact = await stateManager.create({ title: "Corrupt Artifact", type: "full_feature" });
    const written = await artifacts.write({
      workflowId: wf_corrupt_artifact.id,
      kind: "PRD",
      path: "PRD.md",
      content: "# PRD\n",
    });
    await artifacts.write({
      workflowId: wf_corrupt_artifact.id,
      kind: "SPEC",
      path: "SPEC.md",
      content: "# SPEC\n",
    });
    await Bun.write(written.absolutePath, "missing frontmatter delimiter");

    try {
      await artifacts.read(wf_corrupt_artifact.id, "PRD.md");
      throw new Error("Expected corrupt artifact read to fail");
    } catch (error) {
      expect(error).toMatchObject({
        name: "Error",
        message: "Content does not start with frontmatter delimiter '---'",
      });
    }
    const unrelated = await artifacts.read(wf_corrupt_artifact.id, "SPEC.md");
    expect(unrelated).toMatchObject({ body: "# SPEC\n" });
  });

  test("circular TASKS.md validation rejects with involved task ids", () => {
    const result = validateTasksMarkdown(CIRCULAR_TASKS_MARKDOWN);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: "CIRCULAR_DEPENDENCY", taskIds: ["T1", "T2"] }),
    );
    const cycle = result.errors.find((error) => error.code === "CIRCULAR_DEPENDENCY");
    expect(cycle?.message).toContain("T1");
    expect(cycle?.message).toContain("T2");
  });
});
