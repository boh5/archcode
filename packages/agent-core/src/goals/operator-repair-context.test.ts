import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type { DoneCondition, GoalDoneResult, GoalRepairContext } from "@archcode/protocol";

import { buildSystemPrompt } from "../prompt/builder";
import type { PromptContext } from "../prompt/types";
import { GoalArtifactManager } from "./artifacts";
import { buildOperatorRepairContextSection } from "./operator-repair-context";
import { GoalRunner } from "./runner";
import { GoalStateManager } from "./state";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "operator-repair-context");

let workspaceRoot = "";
let manager: GoalStateManager;

const specCondition: DoneCondition = {
  id: "spec-check",
  kind: "spec_compliance",
  params: { specPath: "SPEC.md" },
};

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
  workspaceRoot = await mkdtemp(join(TMP_ROOT, "workspace-"));
  manager = new GoalStateManager(workspaceRoot);
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

function makePromptContext(overrides: Partial<PromptContext>): PromptContext {
  return {
    allowedTools: ["file_read", "delegate"],
    workspaceRoot,
    promptProfileId: "default",
    env: {
      platform: "darwin",
      timezone: "America/Los_Angeles",
      locale: "en-US",
      cwd: workspaceRoot,
      date: "2026-07-03",
    },
    ...overrides,
  };
}

function createRunner(sessionIds: string[] = ["main-session-1", "fresh-session-2"]): GoalRunner {
  const ids = [...sessionIds];
  return new GoalRunner({
    goalStateManager: manager,
    goalArtifacts: new GoalArtifactManager(workspaceRoot),
    hitlService: {
      create: mock(async (input) => ({
        hitlId: crypto.randomUUID(),
        owner: input.owner,
        blockingKey: input.blockingKey,
        source: input.source,
        status: "pending" as const,
        displayPayload: input.displayPayload,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
      list: mock(async () => []),
    },
    workspaceRoot,
    createSession: mock(async () => ids.shift() ?? `session-${crypto.randomUUID()}`),
  });
}

async function lockedSpecGoal() {
  const goal = await manager.create(
    "project-a",
    "Repair failed AC-002",
    "architect",
    [specCondition],
    { maxRetries: 2, backoffMs: 0, escalateOnFailure: true },
    [],
  );
  return manager.lock(goal.id, "architect");
}

async function runToReview(goalId: string, runner: GoalRunner): Promise<void> {
  await runner.start(goalId);
  await runner.advancePhase(goalId, "build");
  await runner.advancePhase(goalId, "review");
}

function failedAc002SpecResult(): GoalDoneResult {
  return {
    conditionId: specCondition.id,
    passed: false,
    evidence: "spec_compliance: failed: AC-002",
    checkedAt: new Date().toISOString(),
    specCompliance: {
      checkedAt: new Date().toISOString(),
      specPath: "SPEC.md",
      summary: "1/2 acceptance criteria failed: AC-002.",
      criteria: [
        {
          criterionId: "AC-001",
          criterion: "Existing behavior remains stable",
          compliant: true,
          status: "satisfied",
          evidence: ["AC-001 passed."],
        },
        {
          criterionId: "AC-002",
          criterion: "Fresh retry receives structured repair context",
          compliant: false,
          status: "failed",
          evidence: ["Reviewer evidence summary: retry prompt omitted repair context."],
          fileRefs: ["packages/agent-core/src/goals/runner.ts"],
          commandRefs: ["bun test packages/agent-core/src/goals/operator-repair-context.test.ts"],
          resultRefs: ["operator repair context test failed"],
          repairGuidance: "Expose structured repair context to the next Operator retry session.",
        },
      ],
    },
  };
}

function passingSpecResult(): GoalDoneResult {
  return {
    ...failedAc002SpecResult(),
    passed: true,
    evidence: "spec_compliance: all criteria satisfied",
    specCompliance: {
      checkedAt: new Date().toISOString(),
      specPath: "SPEC.md",
      summary: "2/2 acceptance criteria satisfied.",
      criteria: failedAc002SpecResult().specCompliance!.criteria.map((criterion) => ({
        ...criterion,
        compliant: true,
        status: "satisfied" as const,
        repairGuidance: undefined,
      })),
    },
  };
}

describe("Operator repair context flow", () => {
  it("turns failed AC-002 review details into structured Operator retry prompt context", async () => {
    const goal = await lockedSpecGoal();
    const runner = createRunner();
    await runToReview(goal.id, runner);
    await runner.recordReviewerDoneResult(goal.id, specCondition.id, failedAc002SpecResult());

    const failed = await runner.finalizeReviewerReview(goal.id, "NOT_DONE", { waitForBackoff: false });
    const issue = failed.repairContext?.issues[0];

    expect(failed.status).toBe("failed");
    expect(issue).toMatchObject({
      conditionId: "AC-002",
      evidenceSummary: "Reviewer evidence summary: retry prompt omitted repair context.",
      repairGuidance: "Expose structured repair context to the next Operator retry session.",
      repairTarget: "packages/agent-core/src/goals/runner.ts",
      implicatedFiles: ["packages/agent-core/src/goals/runner.ts"],
      failingCommands: ["bun test packages/agent-core/src/goals/operator-repair-context.test.ts"],
      resultSummaries: ["operator repair context test failed"],
    });

    const retry = await runner.handleFailedVerification(goal.id, failed.repairContext!.summary);
    expect(retry.status).toBe("running");
    expect(retry.phase).toBe("plan");
    expect(retry.mainSessionId).toBe("fresh-session-2");
    expect(retry.repairContext?.issues[0]?.conditionId).toBe("AC-002");

    const prompt = await buildSystemPrompt(makePromptContext({
      goalId: goal.id,
      sessionRole: "main",
      goalRepairContext: retry.repairContext,
    }));

    expect(prompt).toContain("## Operator Repair Context");
    expect(prompt).toContain("<archcode-operator-repair-context>");
    expect(prompt).toContain("Condition/Criterion: AC-002");
    expect(prompt).toContain("Repair target: packages/agent-core/src/goals/runner.ts");
    expect(prompt).toContain("Failing commands: bun test packages/agent-core/src/goals/operator-repair-context.test.ts");
    expect(prompt).not.toContain("RAW_MODEL_PRIVATE_TEXT");
  });

  it("does not create or inject repair context for DONE", async () => {
    const goal = await lockedSpecGoal();
    const runner = createRunner();
    await runToReview(goal.id, runner);
    await runner.recordReviewerDoneResult(goal.id, specCondition.id, passingSpecResult());

    const completed = await runner.finalizeReviewerReview(goal.id, "DONE", { summary: "All criteria passed." });
    const prompt = await buildSystemPrompt(makePromptContext({
      goalId: goal.id,
      sessionRole: "main",
      goalRepairContext: completed.repairContext,
    }));

    expect(completed.status).toBe("completed");
    expect(completed.reviewReport?.outcome).toBe("DONE");
    expect(completed.repairContext).toBeUndefined();
    expect(prompt).not.toContain("## Operator Repair Context");
  });

  it("only exposes structured repair context to Operator repair roles", () => {
    const repairContext: GoalRepairContext = {
      generatedAt: "2026-07-03T00:00:00.000Z",
      summary: "Reviewer NOT_DONE: RAW_MODEL_PRIVATE_TEXT",
      issues: [{
        conditionId: "AC-002",
        evidenceSummary: "RAW_MODEL_PRIVATE_TEXT failed evidence",
        repairGuidance: "Fix AC-002",
        repairTarget: "packages/agent-core/src/goals/runner.ts",
      }],
    };

    expect(buildOperatorRepairContextSection(repairContext, { sessionRole: "build" })).toContain("[redacted-private-reviewer-output]");
    expect(buildOperatorRepairContextSection(repairContext, { sessionRole: "review" })).toBeNull();
    expect(buildOperatorRepairContextSection(undefined, { sessionRole: "main" })).toBeNull();
  });
});
