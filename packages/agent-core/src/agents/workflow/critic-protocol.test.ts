import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { processCriticDecision } from "./critic-protocol";
import { WorkflowStateManager } from "./state";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "critic-protocol");

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("processCriticDecision", () => {
  test("approved at critic_prd_review transitions to spec_drafting", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);
    await manager.create({ id: "wf-prd-approved", type: "full_feature" });
    await manager.updateStage("wf-prd-approved", "critic_prd_review");

    const result = await processCriticDecision({
      workflowId: "wf-prd-approved",
      decision: "approved",
      currentStage: "critic_prd_review",
      criticReportPath: "critic-reports/prd.md",
    }, manager);

    expect(result.newState.stage).toBe("spec_drafting");
    expect(result.newState.artifacts.CRITIC_REPORT).toEqual(["critic-reports/prd.md"]);
    expect(result.newState.stageCompletions.critic_prd_review).toMatchObject({
      stage: "critic_prd_review",
      criticPassed: true,
      evidence: ["critic-reports/prd.md"],
    });
  });

  test("approved at critic_spec_review transitions to awaiting_user_approval", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);
    await manager.create({ id: "wf-spec-approved", type: "full_feature" });
    await manager.updateStage("wf-spec-approved", "critic_spec_review");

    const result = await processCriticDecision({
      workflowId: "wf-spec-approved",
      decision: "approved",
      currentStage: "critic_spec_review",
    }, manager);

    expect(result.newState.stage).toBe("awaiting_user_approval");
    expect(result.newState.stageCompletions.critic_spec_review).toMatchObject({
      stage: "critic_spec_review",
      criticPassed: true,
    });
  });

  test("changes_requested increments retry count and transitions back to producer", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);
    await manager.create({ id: "wf-change", type: "full_feature", maxRetries: 3 });
    await manager.updateStage("wf-change", "critic_prd_review");

    const result = await processCriticDecision({
      workflowId: "wf-change",
      decision: "changes_requested",
      currentStage: "critic_prd_review",
    }, manager);

    expect(result.newState.stage).toBe("product_drafting");
    expect(result.newState.retryCount).toBe(1);
  });

  test("changes_requested at max retries transitions to failed", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);
    await manager.create({ id: "wf-max", type: "full_feature", maxRetries: 1 });
    await manager.updateStage("wf-max", "critic_spec_review");

    const result = await processCriticDecision({
      workflowId: "wf-max",
      decision: "changes_requested",
      currentStage: "critic_spec_review",
      criticReportPath: "critic-reports/spec.md",
    }, manager);

    expect(result.newState.stage).toBe("critic_spec_review");
    expect(result.newState.status).toBe("failed");
    expect(result.newState.retryCount).toBe(1);
    expect(result.newState.lastError).toContain("retry limit");
    expect(result.newState.lastError).toContain("critic-reports/spec.md");
  });

  test("rejected transitions to failed with error message", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);
    await manager.create({ id: "wf-rejected", type: "full_feature" });
    await manager.updateStage("wf-rejected", "critic_prd_review");

    const result = await processCriticDecision({
      workflowId: "wf-rejected",
      decision: "rejected",
      currentStage: "critic_prd_review",
      criticReportPath: "critic-reports/rejected.md",
    }, manager);

    expect(result.newState.stage).toBe("critic_prd_review");
    expect(result.newState.status).toBe("failed");
    expect(result.newState.lastError).toContain("Critic rejected");
    expect(result.newState.lastError).toContain("critic-reports/rejected.md");
  });

  test("approved does not bypass user approval for foreman_executing", async () => {
    const manager = new WorkflowStateManager(TMP_DIR);
    await manager.create({ id: "wf-no-bypass", type: "full_feature" });
    await manager.updateStage("wf-no-bypass", "critic_spec_review");

    const result = await processCriticDecision({
      workflowId: "wf-no-bypass",
      decision: "approved",
      currentStage: "critic_spec_review",
    }, manager);

    expect(result.newState.stage).toBe("awaiting_user_approval");
    expect(result.newState.stage).not.toBe("foreman_executing");
  });
});
