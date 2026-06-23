import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { StoreApi } from "zustand";

import { WorkflowArtifactManager } from "./artifacts";
import { processCriticDecision } from "./critic-protocol";
import { canCompleteWorkflow, hasResolvedBlockingDecisionInteractions, hasUnresolvedBlockingInteractions, validateTransition } from "./guards";
import {
  createDerivedWorkflowWithOrchestrator,
  createWorkflowWithOrchestrator,
} from "./linking";
import { WorkflowStateManager, WorkflowTerminalStateError, type WorkflowStage } from "./state";
import {
  calculateReadyWave,
  parseTasksMarkdown,
  toggleTaskCheckbox,
  validateTasksMarkdown,
} from "./tasks-format";
import { createRegistry } from "../../tools/registry";
import { createToolExecutionContext, type ToolExecutionContext, type ToolExecutionResult } from "../../tools/types";
import { registerBuiltinTools } from "../../core/register-tools";
import { silentLogger } from "../../logger";
import { SessionStoreManager } from "../../store/session-store-manager";
import type { SessionStoreState } from "../../store/types";
import { createTestProjectContext } from "../../tools/test-project-context";
import { createArtifactReadTool } from "../../tools/builtins/workflow/artifact-read";
import { createArtifactWriteTool } from "../../tools/builtins/workflow/artifact-write";
import { createWorkflowCreateTool } from "../../tools/builtins/workflow/workflow-create";
import { createWorkflowReadTool } from "../../tools/builtins/workflow/workflow-read";
import { createWorkflowUpdateStageTool } from "../../tools/builtins/workflow/workflow-update-stage";
import { createWorkflowCompleteTool } from "../../tools/builtins/workflow/workflow-complete";
import { createWorkflowRecordCompletionTool } from "../../tools/builtins/workflow/workflow-record-completion";
import { createWorkflowProposeInteractionsTool } from "../../tools/builtins/workflow/workflow-propose-interactions";
import { createWorkflowRequestInteractionsTool } from "../../tools/builtins/workflow/workflow-request-interactions";
import { SessionExecutionManager } from "../../execution/session-execution-manager";
import type { AgentDefinition } from "../factory-types";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "workflow-integration");

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

    const createdWf = await stateManager.create({ title: "integration test", type: "full_feature" });
    await transition(stateManager, createdWf.id, "idle", "requirements_interview", false);
    await stateManager.recordStageCompletion(createdWf.id, { stage: "requirements_interview", noRequiredInteractionsReason: "Mocked path has no requirements questions." });
    await transition(stateManager, createdWf.id, "requirements_interview", "product_drafting", false);
    await stateManager.recordStageCompletion(createdWf.id, { stage: "product_drafting", noRequiredInteractionsReason: "Mocked PRD path has no product questions." });

    await artifactManager.write({ workflowId: createdWf.id, kind: "PRD", content: "# PRD\n\nShip a mocked MVP workflow integration path." });
    await transition(stateManager, createdWf.id, "product_drafting", "critic_prd_review", false);

    const prdReport = await artifactManager.write({
      workflowId: createdWf.id,
      kind: "CRITIC_REPORT",
      name: "prd",
      content: "PRD approved.",
    });
    const prdDecision = await processCriticDecision(
      {
        workflowId: createdWf.id,
        decision: "approved",
        currentStage: "critic_prd_review",
        criticReportPath: prdReport.path,
      },
      stateManager,
    );
    expect(prdDecision.newState.stage).toBe("spec_drafting");

    await artifactManager.write({ workflowId: createdWf.id, kind: "SPEC", content: "# SPEC\n\nImplement the mocked path using workflow managers directly." });
    await artifactManager.write({
      workflowId: createdWf.id,
      kind: "TASKS",
      content: TASKS_MARKDOWN,
    });
    const tasksDraft = await artifactManager.read(createdWf.id, "TASKS.md");
    expect(validateTasksMarkdown(tasksDraft.body).valid).toBe(true);
    await stateManager.recordStageCompletion(createdWf.id, { stage: "spec_drafting", noRequiredInteractionsReason: "Mocked SPEC path has no spec questions." });
    await transition(stateManager, createdWf.id, "spec_drafting", "critic_spec_review", false);

    const specReport = await artifactManager.write({
      workflowId: createdWf.id,
      kind: "CRITIC_REPORT",
      name: "spec-tasks",
      content: "SPEC and TASKS approved.",
    });
    const specDecision = await processCriticDecision(
      {
        workflowId: createdWf.id,
        decision: "approved",
        currentStage: "critic_spec_review",
        criticReportPath: specReport.path,
      },
      stateManager,
    );
    expect(specDecision.newState.stage).toBe("awaiting_user_approval");

    await stateManager.recordStageCompletion(createdWf.id, { stage: "awaiting_user_approval" });
    await transition(stateManager, createdWf.id, "awaiting_user_approval", "foreman_executing", true);

    let currentTasks = (await artifactManager.read(createdWf.id, "TASKS.md")).body;
    for (const expectedWave of [["T1"], ["T2"]]) {
      const readyWave = calculateReadyWave(parseTasksMarkdown(currentTasks));
      expect(readyWave.map((task) => task.id)).toEqual(expectedWave);

      for (const task of readyWave) {
        const result = task.agent === "reviewer" ? await delegateReviewer() : await delegateBuilder();
        expect(result.ok).toBe(true);
        await artifactManager.write({
          workflowId: createdWf.id,
          kind: "EVIDENCE",
          name: result.evidencePath.replace(/^evidence\/(.+)\.md$/, "$1"),
          content: `${task.id} ${task.agent} succeeded.`,
        });
        currentTasks = toggleTaskCheckbox(currentTasks, task.id, true);
      }

      await artifactManager.write({
        workflowId: createdWf.id,
        kind: "TASKS",
        content: currentTasks,
      });
      currentTasks = (await artifactManager.read(createdWf.id, "TASKS.md")).body;
    }

    expect(calculateReadyWave(parseTasksMarkdown(currentTasks))).toEqual([]);
    await stateManager.recordStageCompletion(createdWf.id, { stage: "foreman_executing" });
    await transition(stateManager, createdWf.id, "foreman_executing", "final_review", false);
    await artifactManager.write({ workflowId: createdWf.id, kind: "FINAL_REPORT", content: "# Final Report\n\nWorkflow completed with mocked builder and reviewer outputs." });
    await stateManager.updateStatus(createdWf.id, "completed");

    const finalState = await stateManager.read(createdWf.id);
    const discovered = await stateManager.listWorkflows({ status: "completed" });
    const finalTasks = parseTasksMarkdown((await artifactManager.read(createdWf.id, "TASKS.md")).body);

    expect(finalState.stage).toBe("final_review");
    expect(finalState.status).toBe("completed");
    expect(discovered.map((workflow) => workflow.id)).toContain(createdWf.id);
    expect(finalState.artifacts.PRD).toBe("PRD.md");
    expect(finalState.artifacts.SPEC).toBe("SPEC.md");
    expect(finalState.artifacts.TASKS).toBe("TASKS.md");
    expect(finalState.artifacts.CRITIC_REPORT).toEqual([
      prdReport.path,
      specReport.path,
    ]);
    expect(finalState.artifacts.EVIDENCE).toHaveLength(2);
    expect(finalState.artifacts.FINAL_REPORT).toBe("FINAL_REPORT.md");
    expect(finalTasks.every((task) => task.checked)).toBe(true);
    expect(delegateBuilder).toHaveBeenCalledTimes(1);
    expect(delegateReviewer).toHaveBeenCalledTimes(1);
    expect(await Bun.file(join(TMP_DIR, ".specra", "workflows", createdWf.id, "PLAN.md")).exists()).toBe(false);
  });
});

describe("end-to-end workflow lifecycle integration", () => {
  test("full_feature lifecycle advances through stages, records completions, artifacts, and completes", async () => {
    const root = workspaceRoot("full-feature");
    const stateManager = new WorkflowStateManager(root);
    const artifactManager = new WorkflowArtifactManager(root, stateManager);

    const wf_full = await stateManager.create({ title: "Full Feature", type: "full_feature" });
    await advance(stateManager, wf_full.id, "requirements_interview");
    await stateManager.recordStageCompletion(wf_full.id, { stage: "requirements_interview", evidence: ["requirements cleared"], noRequiredInteractionsReason: "Lifecycle test starts with complete requirements." });
    await advance(stateManager, wf_full.id, "product_drafting");
    await artifactManager.write({ workflowId: wf_full.id, kind: "PRD", content: "# PRD" });
    await stateManager.recordStageCompletion(wf_full.id, { stage: "product_drafting", evidence: ["PRD.md"], noRequiredInteractionsReason: "Lifecycle PRD has no outstanding product questions." });
    await advance(stateManager, wf_full.id, "critic_prd_review");
    const fullPrdReport = await artifactManager.write({ workflowId: wf_full.id, kind: "CRITIC_REPORT", name: "prd", content: "approved" });
    await processCriticDecision({ workflowId: wf_full.id, decision: "approved", currentStage: "critic_prd_review", criticReportPath: fullPrdReport.path }, stateManager);

    await artifactManager.write({ workflowId: wf_full.id, kind: "SPEC", content: "# SPEC" });
    await artifactManager.write({ workflowId: wf_full.id, kind: "TASKS", content: TASKS_MARKDOWN });
    await stateManager.recordStageCompletion(wf_full.id, { stage: "spec_drafting", evidence: ["SPEC.md", "TASKS.md"], noRequiredInteractionsReason: "Lifecycle SPEC has no outstanding spec questions." });
    await advance(stateManager, wf_full.id, "critic_spec_review");
    const fullSpecReport = await artifactManager.write({ workflowId: wf_full.id, kind: "CRITIC_REPORT", name: "spec", content: "approved" });
    await processCriticDecision({ workflowId: wf_full.id, decision: "approved", currentStage: "critic_spec_review", criticReportPath: fullSpecReport.path }, stateManager);

    await stateManager.recordStageCompletion(wf_full.id, { stage: "awaiting_user_approval", evidence: ["user-approved"] });
    await advance(stateManager, wf_full.id, "foreman_executing", true);
    const fullEvidence = await artifactManager.write({ workflowId: wf_full.id, kind: "EVIDENCE", name: "builder", content: "builder done" });
    await stateManager.recordStageCompletion(wf_full.id, { stage: "foreman_executing", evidence: [fullEvidence.path] });
    await advance(stateManager, wf_full.id, "final_review");
    await artifactManager.write({ workflowId: wf_full.id, kind: "FINAL_REPORT", content: "# Done" });
    await stateManager.recordStageCompletion(wf_full.id, { stage: "final_review", evidence: ["FINAL_REPORT.md"] });

    const beforeComplete = await stateManager.read(wf_full.id);
    expect(canCompleteWorkflow(beforeComplete, (kind) => Boolean(beforeComplete.artifacts[kind as keyof typeof beforeComplete.artifacts]))).toEqual({ allowed: true });
    const completed = await stateManager.complete(wf_full.id);

    expect(completed.status).toBe("completed");
    expect(completed.stage).toBe("final_review");
    expect(completed.artifacts).toMatchObject({ PRD: "PRD.md", SPEC: "SPEC.md", TASKS: "TASKS.md", FINAL_REPORT: "FINAL_REPORT.md" });
    expect(completed.artifacts.CRITIC_REPORT).toEqual([fullPrdReport.path, fullSpecReport.path]);
    expect(completed.artifacts.EVIDENCE).toEqual([fullEvidence.path]);
    expect(completed.stageCompletions.final_review?.evidence).toEqual(["FINAL_REPORT.md"]);
  });

  test("full_feature planning decisions are batched, resolved, archived, and keep Foreman gated until approval", async () => {
    const root = workspaceRoot("full-feature-interactions");
    const storeManager = new SessionStoreManager({ logger: silentLogger });
    const store = storeManager.create("orchestrator-interactions", root, { agentName: "orchestrator" });
    const registry = createWorkflowToolRegistry();
    const stateManager = new WorkflowStateManager(root);
    const artifactManager = new WorkflowArtifactManager(root, stateManager);
    const answersByDecisionKey: Record<string, string> = {
      "requirements.scope": "Ship billing dashboard",
      "requirements.timeline": "Safe rollout",
      "product.api": "Public REST API",
      "spec.storage": "SQLite first",
      "critic.risk": "Accept staged rollout risk",
    };
    const decisionAskUser = mock(async (request: Parameters<NonNullable<ToolExecutionContext["askUser"]>>[0]) => {
      const decisionKeys = request.context?.decisionKeys;
      if (!Array.isArray(decisionKeys)) throw new Error("Expected batched decision keys");
      return {
        answers: decisionKeys.map((decisionKey) => [answersByDecisionKey[String(decisionKey)] ?? `answer for ${String(decisionKey)}`]),
      };
    });
    const implementationAskUser = mock(async () => ({ answers: [["ordinary implementation choice"]] }));
    const beginForeman = mock(async () => ({ ok: true }));
    const runBuilder = mock(async () => ({ ok: true }));

    const created = parseToolJson<{ id: string; stage: WorkflowStage }>(await executeWorkflowTool(registry, root, storeManager, store, "workflow_create", {
      title: "Decision-complete full feature",
      type: "full_feature",
    }));
    const workflowId = created.id;
    expect(created.stage).toBe("idle");
    expect(store.getState().workflowId).toBe(workflowId);

    parseToolJson(await executeWorkflowTool(registry, root, storeManager, store, "workflow_update_stage", {
      workflowId,
      stage: "requirements_interview",
      hasUserApproval: false,
      incrementRetry: false,
    }));
    parseToolJson(await executeWorkflowTool(registry, root, storeManager, store, "workflow_propose_interactions", {
      workflowId,
      proposals: [
        interactionProposal({ decisionKey: "requirements.scope", sourceAgent: "product", question: "Which scope should the PRD target?", options: ["Ship billing dashboard", "Reports only"], recommendedOption: "Ship billing dashboard" }),
        interactionProposal({ decisionKey: "requirements.timeline", sourceAgent: "product", kind: "preference", question: "Which rollout timeline should planning assume?", options: ["Fast rollout", "Safe rollout"], recommendedOption: "Safe rollout" }),
      ],
    }, { agentName: "product" }));
    parseToolJson(await executeWorkflowTool(registry, root, storeManager, store, "workflow_record_completion", {
      workflowId,
      stage: "requirements_interview",
      evidence: ["requirements interview completed"],
    }));
    expectToolError(await executeWorkflowTool(registry, root, storeManager, store, "workflow_update_stage", {
      workflowId,
      stage: "product_drafting",
      hasUserApproval: false,
      incrementRetry: false,
    }), "unresolved blocking interaction(s) remain");

    const requirementsRequest = parseToolJson<{ requested: number; resolved: number; pending: number; archive: { archived: number } }>(await executeWorkflowTool(registry, root, storeManager, store, "workflow_request_interactions", {
      workflowId,
      stage: "requirements_interview",
    }, { askUser: decisionAskUser }));
    expect(requirementsRequest).toMatchObject({ requested: 2, resolved: 2, pending: 0, archive: { archived: 2 } });
    expect(decisionAskUser).toHaveBeenCalledTimes(1);
    const firstDecisionRequest = decisionAskUser.mock.calls[0]?.[0];
    expect(firstDecisionRequest?.questions).toHaveLength(2);
    expect(firstDecisionRequest?.context).toMatchObject({ workflowId, stage: "requirements_interview", decisionKeys: ["requirements.scope", "requirements.timeline"] });
    parseToolJson(await executeWorkflowTool(registry, root, storeManager, store, "workflow_update_stage", {
      workflowId,
      stage: "product_drafting",
      hasUserApproval: false,
      incrementRetry: false,
    }));

    parseToolJson(await executeWorkflowTool(registry, root, storeManager, store, "workflow_propose_interactions", {
      workflowId,
      proposals: [interactionProposal({ decisionKey: "product.api", stage: "product_drafting", sourceAgent: "product", question: "Which API surface should the PRD require?", options: ["Public REST API", "Internal-only API"], recommendedOption: "Public REST API" })],
    }, { agentName: "product" }));
    await artifactManager.write({ workflowId, kind: "PRD", content: "# PRD\n\nBuild the billing dashboard with the selected scope." });
    parseToolJson(await executeWorkflowTool(registry, root, storeManager, store, "workflow_record_completion", {
      workflowId,
      stage: "product_drafting",
      evidence: ["PRD.md"],
    }));
    expectToolError(await executeWorkflowTool(registry, root, storeManager, store, "workflow_update_stage", {
      workflowId,
      stage: "critic_prd_review",
      hasUserApproval: false,
      incrementRetry: false,
    }), "unresolved blocking interaction(s) remain");
    parseToolJson(await executeWorkflowTool(registry, root, storeManager, store, "workflow_request_interactions", {
      workflowId,
      stage: "product_drafting",
    }, { askUser: decisionAskUser }));
    parseToolJson(await executeWorkflowTool(registry, root, storeManager, store, "workflow_update_stage", {
      workflowId,
      stage: "critic_prd_review",
      hasUserApproval: false,
      incrementRetry: false,
    }));

    const prdReport = await artifactManager.write({ workflowId, kind: "CRITIC_REPORT", name: "prd", content: "PRD approved after decision clearance." });
    parseToolJson(await executeWorkflowTool(registry, root, storeManager, store, "workflow_record_completion", {
      workflowId,
      stage: "critic_prd_review",
      evidence: [prdReport.path],
      noRequiredInteractionsReason: "PRD critic review found no user-owned decision requiring clarification.",
    }));
    parseToolJson(await executeWorkflowTool(registry, root, storeManager, store, "workflow_update_stage", {
      workflowId,
      stage: "spec_drafting",
      hasUserApproval: false,
      incrementRetry: false,
      criticDecision: "approved",
      criticReportPath: prdReport.path,
    }));

    parseToolJson(await executeWorkflowTool(registry, root, storeManager, store, "workflow_propose_interactions", {
      workflowId,
      proposals: [interactionProposal({ decisionKey: "spec.storage", stage: "spec_drafting", sourceAgent: "spec", question: "Which storage strategy should the SPEC encode?", options: ["SQLite first", "External Postgres required"], recommendedOption: "SQLite first" })],
    }, { agentName: "spec" }));
    await artifactManager.write({ workflowId, kind: "SPEC", content: "# SPEC\n\nImplement the approved billing dashboard path." });
    await artifactManager.write({ workflowId, kind: "TASKS", content: TASKS_MARKDOWN });
    parseToolJson(await executeWorkflowTool(registry, root, storeManager, store, "workflow_record_completion", {
      workflowId,
      stage: "spec_drafting",
      evidence: ["SPEC.md", "TASKS.md"],
    }));
    expectToolError(await executeWorkflowTool(registry, root, storeManager, store, "workflow_update_stage", {
      workflowId,
      stage: "critic_spec_review",
      hasUserApproval: false,
      incrementRetry: false,
    }), "unresolved blocking interaction(s) remain");
    parseToolJson(await executeWorkflowTool(registry, root, storeManager, store, "workflow_request_interactions", {
      workflowId,
      stage: "spec_drafting",
    }, { askUser: decisionAskUser }));
    parseToolJson(await executeWorkflowTool(registry, root, storeManager, store, "workflow_update_stage", {
      workflowId,
      stage: "critic_spec_review",
      hasUserApproval: false,
      incrementRetry: false,
    }));

    parseToolJson(await executeWorkflowTool(registry, root, storeManager, store, "workflow_propose_interactions", {
      workflowId,
      proposals: [interactionProposal({ decisionKey: "critic.risk", stage: "critic_spec_review", sourceAgent: "critic", question: "Accept staged rollout risk noted by Critic?", options: ["Accept staged rollout risk", "Block release until all risk is eliminated"], recommendedOption: "Accept staged rollout risk" })],
    }, { agentName: "critic" }));
    const specReport = await artifactManager.write({ workflowId, kind: "CRITIC_REPORT", name: "spec", content: "SPEC/TASKS approved after risk decision." });
    parseToolJson(await executeWorkflowTool(registry, root, storeManager, store, "workflow_record_completion", {
      workflowId,
      stage: "critic_spec_review",
      evidence: [specReport.path],
    }));
    expectToolError(await executeWorkflowTool(registry, root, storeManager, store, "workflow_update_stage", {
      workflowId,
      stage: "awaiting_user_approval",
      hasUserApproval: false,
      incrementRetry: false,
    }), "unresolved blocking interaction(s) remain");
    parseToolJson(await executeWorkflowTool(registry, root, storeManager, store, "workflow_request_interactions", {
      workflowId,
      stage: "critic_spec_review",
    }, { askUser: decisionAskUser }));

    const afterCriticDecision = await stateManager.read(workflowId);
    expect(validateTransition({
      workflowId,
      workflowType: afterCriticDecision.type,
      currentStage: afterCriticDecision.stage,
      targetStage: "awaiting_user_approval",
      retryCount: afterCriticDecision.retryCount,
      maxRetries: afterCriticDecision.maxRetries,
      hasArtifact: (kind) => Boolean(afterCriticDecision.artifacts[kind as keyof typeof afterCriticDecision.artifacts]),
      hasStageCompletion: (stage) => Boolean(afterCriticDecision.stageCompletions[stage]),
      hasUnresolvedBlockingInteractions: (stage) => hasUnresolvedBlockingInteractions(afterCriticDecision, stage),
      hasResolvedBlockingDecisionInteractions: (stage) => hasResolvedBlockingDecisionInteractions(afterCriticDecision, stage),
      hasNoRequiredInteractionsReason: (stage) => Boolean(afterCriticDecision.noRequiredInteractionsReason[stage]?.trim()),
      hasUserApproval: false,
    })).toEqual({ allowed: true });
    parseToolJson(await executeWorkflowTool(registry, root, storeManager, store, "workflow_update_stage", {
      workflowId,
      stage: "awaiting_user_approval",
      hasUserApproval: false,
      incrementRetry: false,
      criticDecision: "approved",
      criticReportPath: specReport.path,
    }));

    expectToolError(await executeWorkflowTool(registry, root, storeManager, store, "workflow_update_stage", {
      workflowId,
      stage: "foreman_executing",
      hasUserApproval: false,
      incrementRetry: false,
    }), "record completion for awaiting_user_approval");
    expect(beginForeman).not.toHaveBeenCalled();
    parseToolJson(await executeWorkflowTool(registry, root, storeManager, store, "workflow_record_completion", {
      workflowId,
      stage: "awaiting_user_approval",
      evidence: ["user-approved-final-plan"],
    }));
    expectToolError(await executeWorkflowTool(registry, root, storeManager, store, "workflow_update_stage", {
      workflowId,
      stage: "foreman_executing",
      hasUserApproval: false,
      incrementRetry: false,
    }), "without user approval");
    expect(beginForeman).not.toHaveBeenCalled();
    parseToolJson(await executeWorkflowTool(registry, root, storeManager, store, "workflow_update_stage", {
      workflowId,
      stage: "foreman_executing",
      hasUserApproval: true,
      incrementRetry: false,
    }));
    await beginForeman();
    await runBuilder();

    const finalState = await stateManager.read(workflowId);
    const archive = await artifactManager.readByKind(workflowId, "INTERACTIONS");
    expect(finalState.stage).toBe("foreman_executing");
    expect(finalState.requiredInteractions).toEqual([]);
    expect(finalState.resolvedInteractions.map((interaction) => interaction.decisionKey).sort()).toEqual([
      "critic.risk",
      "product.api",
      "requirements.scope",
      "requirements.timeline",
      "spec.storage",
    ]);
    expect(archive.body).toContain("# Workflow Interactions Archive");
    for (const [decisionKey, answer] of Object.entries(answersByDecisionKey)) {
      expect(archive.body).toContain(`## ${decisionKey}`);
      expect(archive.body).toContain(`- Selected Answer: ${answer}`);
    }
    expect(decisionAskUser).toHaveBeenCalledTimes(4);
    expect(beginForeman).toHaveBeenCalledTimes(1);
    expect(runBuilder).toHaveBeenCalledTimes(1);
    expect(implementationAskUser).not.toHaveBeenCalled();
  });

  test("cancelled and empty batched decision answers remain blocking", async () => {
    const cancelled = await createWorkflowAtRequirementsGate("cancelled-decision");
    const cancelledResult = parseToolJson<{ cancelled: number; archive: { archived: number } }>(await executeWorkflowTool(
      cancelled.registry,
      cancelled.root,
      cancelled.storeManager,
      cancelled.store,
      "workflow_request_interactions",
      { workflowId: cancelled.workflowId, stage: "requirements_interview" },
      { askUser: mock(async () => ({ isError: true as const, reason: "Cancelled" })) },
    ));
    expect(cancelledResult).toMatchObject({ cancelled: 1, archive: { archived: 1 } });
    const cancelledState = await cancelled.stateManager.read(cancelled.workflowId);
    expect(cancelledState.requiredInteractions).toHaveLength(1);
    expect(cancelledState.requiredInteractions[0]).toMatchObject({ decisionKey: "requirements.blocker", status: "cancelled" });
    expect(hasUnresolvedBlockingInteractions(cancelledState, "requirements_interview")).toBe(true);
    expectToolError(await executeWorkflowTool(cancelled.registry, cancelled.root, cancelled.storeManager, cancelled.store, "workflow_update_stage", {
      workflowId: cancelled.workflowId,
      stage: "product_drafting",
      hasUserApproval: false,
      incrementRetry: false,
    }), "unresolved blocking interaction(s) remain");
    expect((await cancelled.artifactManager.readByKind(cancelled.workflowId, "INTERACTIONS")).body).toContain("- Status: cancelled");

    const empty = await createWorkflowAtRequirementsGate("empty-decision");
    const emptyResult = parseToolJson<{ resolved: number; pending: number }>(await executeWorkflowTool(
      empty.registry,
      empty.root,
      empty.storeManager,
      empty.store,
      "workflow_request_interactions",
      { workflowId: empty.workflowId, stage: "requirements_interview" },
      { askUser: mock(async () => ({ answers: [[]] })) },
    ));
    expect(emptyResult).toMatchObject({ resolved: 0, pending: 1 });
    const emptyState = await empty.stateManager.read(empty.workflowId);
    expect(emptyState.requiredInteractions).toHaveLength(1);
    expect(emptyState.requiredInteractions[0]).toMatchObject({ decisionKey: "requirements.blocker", status: "requested" });
    expect(hasUnresolvedBlockingInteractions(emptyState, "requirements_interview")).toBe(true);
    expectToolError(await executeWorkflowTool(empty.registry, empty.root, empty.storeManager, empty.store, "workflow_update_stage", {
      workflowId: empty.workflowId,
      stage: "product_drafting",
      hasUserApproval: false,
      incrementRetry: false,
    }), "unresolved blocking interaction(s) remain");
  });

  test("research_only lifecycle creates research, consolidates, and completes", async () => {
    const root = workspaceRoot("research-only");
    const stateManager = new WorkflowStateManager(root);
    const artifactManager = new WorkflowArtifactManager(root, stateManager);

    const wf_research = await stateManager.create({ title: "Research Only", type: "research_only" });
    await advance(stateManager, wf_research.id, "researching");
    await artifactManager.write({ workflowId: wf_research.id, kind: "RESEARCH", content: "# Findings" });
    await stateManager.recordStageCompletion(wf_research.id, { stage: "researching", evidence: ["RESEARCH.md"] });
    await advance(stateManager, wf_research.id, "research_consolidation");
    await stateManager.recordStageCompletion(wf_research.id, { stage: "research_consolidation", evidence: ["RESEARCH.md"] });

    const ready = await stateManager.read(wf_research.id);
    expect(canCompleteWorkflow(ready, (kind) => Boolean(ready.artifacts[kind as keyof typeof ready.artifacts]))).toEqual({ allowed: true });
    expect((await stateManager.complete(wf_research.id)).status).toBe("completed");
  });

  test("quick_fix lifecycle advances through analysis, patch, verify, and completes", async () => {
    const root = workspaceRoot("quick-fix");
    const stateManager = new WorkflowStateManager(root);

    const wf_quick = await stateManager.create({ title: "Quick Fix", type: "quick_fix" });
    await advance(stateManager, wf_quick.id, "quick_analysis");
    await stateManager.recordStageCompletion(wf_quick.id, { stage: "quick_analysis", evidence: ["analysis"] });
    await advance(stateManager, wf_quick.id, "quick_patch");
    await stateManager.recordStageCompletion(wf_quick.id, { stage: "quick_patch", evidence: ["patch"] });
    await advance(stateManager, wf_quick.id, "quick_verify");
    await stateManager.recordStageCompletion(wf_quick.id, { stage: "quick_verify", evidence: ["bun test"] });

    const ready = await stateManager.read(wf_quick.id);
    expect(canCompleteWorkflow(ready, () => true)).toEqual({ allowed: true });
    expect((await stateManager.complete(wf_quick.id)).status).toBe("completed");
  });

  test("derived upgrade from research_only keeps source active and links derived full_feature", async () => {
    const root = workspaceRoot("derived-upgrade");
    const stateManager = new WorkflowStateManager(root);
    const artifactManager = new WorkflowArtifactManager(root, stateManager);
    const storeManager = new SessionStoreManager({ logger: silentLogger });
    const sourceStore = storeManager.create("source-session", root);

    const source = await createWorkflowWithOrchestrator({ title: "Source Workflow", type: "research_only", orchestratorSessionId: sourceStore.getState().sessionId }, stateManager, storeManager);
    await advance(stateManager, source.workflow.id, "researching");
    await artifactManager.write({ workflowId: source.workflow.id, kind: "RESEARCH", content: "# Source research" });
    await stateManager.recordStageCompletion(source.workflow.id, { stage: "researching", evidence: ["RESEARCH.md"] });
    await advance(stateManager, source.workflow.id, "research_consolidation");
    await stateManager.recordStageCompletion(source.workflow.id, { stage: "research_consolidation" });

    const result = await createDerivedWorkflowWithOrchestrator({ sourceWorkflowId: source.workflow.id, title: "Derived from source", targetType: "full_feature", reason: "upgrade", workspaceRoot: root }, stateManager, storeManager);
    const sourceAfter = await stateManager.read(source.workflow.id);
    const derived = await stateManager.read(result.workflow.id);

    expect(sourceAfter.status).toBe("active");
    expect(sourceAfter.stage).toBe("research_consolidation");
    expect(sourceAfter.derivedWorkflows).toEqual([{ workflowId: result.workflow.id, reason: "upgrade", createdAt: result.source.derivedWorkflows[0]?.createdAt }]);
    expect(sourceAfter.artifacts.RESEARCH).toBe("RESEARCH.md");
    expect(derived.type).toBe("full_feature");
    expect(derived.title).toBe("Derived from source");
    expect(derived.derivedFrom?.workflowId).toBe(source.workflow.id);
    expect(derived.derivedFrom?.reason).toBe("upgrade");
    expect(result.session.workflowId).toBe(result.workflow.id);
    expect(result.workflow.sessionIds.orchestrator).toBe(result.session.sessionId);
    expect(result.session.messages[0]?.parts[0]).toMatchObject({ type: "text" });

    const initialMessageText = result.session.messages[0]?.parts[0]?.type === "text" ? result.session.messages[0].parts[0].text : "";
    expect(initialMessageText).toContain(`derived workflow ${result.workflow.id}`);
    expect(initialMessageText).toContain(`titled "Derived from source"`);
    expect(initialMessageText).toContain(`Source workflow: ${source.workflow.id}`);
    expect(initialMessageText).toContain(`titled "Source Workflow"`);
    expect(initialMessageText).toContain('artifact_read({ workflowId: "' + source.workflow.id + '", path: "RESEARCH.md" })');

    const derivedStore = storeManager.get(result.session.sessionId, root);
    expect(derivedStore).toBeDefined();
    expect(derivedStore?.getState().workflowId).toBe(result.workflow.id);

    const capturedMessages: string[] = [];
    const manager = new SessionExecutionManager({
      sessionAgentManager: createFakeSessionAgentManager(capturedMessages, ["workflow_read", "artifact_read", "artifact_write"]) as never,
      createSessionStore: (sessionId, workspaceRoot, options) => storeManager.create(sessionId, workspaceRoot, options),
      getSessionStore: (sessionId, workspaceRoot) => storeManager.get(sessionId, workspaceRoot),
      deleteSessionStore: (sessionId, workspaceRoot) => storeManager.delete(sessionId, workspaceRoot),
      resolveRootSessionId: (sessionId) => Promise.resolve(sessionId),
      buildSessionTree: async (_workspaceRoot, rootSessionId) => ({ root: { session: { sessionId: rootSessionId, rootSessionId, agentName: "orchestrator", title: null, createdAt: Date.now() }, children: [] }, diagnostics: [] }),
      requestPermission: async () => "approve_once",
      requestQuestion: async () => ({ answers: [] }),
      cleanupDeferredSession: () => {},
      trackSession: () => {},
      untrackSession: () => {},
      logger: silentLogger,
    });
    if (derivedStore === undefined) throw new Error("Expected derived workflow store");

    const handle = await manager.startChildExecution(root, {
      parentStore: derivedStore,
      parentSessionId: result.session.sessionId,
      parentToolCallId: "derived-child",
      toolName: "delegate",
      targetAgentName: "explore",
      prompt: "Read source references before planning W2 work.",
      skills: [],
      available_artifacts: [{ workflowId: source.workflow.id, path: "RESEARCH.md" }],
      background: false,
      currentDepth: 0,
    });
    await handle.result;

    expect(handle.store.getState().workflowId).toBe(result.workflow.id);
    expect(capturedMessages[0]).toContain("## Active Workflow");
    expect(capturedMessages[0]).toContain(`Workflow ID: ${result.workflow.id}`);
    expect(capturedMessages[0]).toContain("Title: Derived from source");
    expect(capturedMessages[0]).toContain("Type: full_feature");
    expect(capturedMessages[0]).toContain(`Use the exact workflow UUID \`${result.workflow.id}\``);
    expect(capturedMessages[0]).toContain(`${source.workflow.id}/RESEARCH.md`);

    const ctx = createContext(root, storeManager, derivedStore);
    const sourceWorkflowRead = await createWorkflowReadTool().execute({ workflowId: source.workflow.id }, ctx);
    const sourceArtifactRead = await createArtifactReadTool().execute({ workflowId: source.workflow.id, path: "RESEARCH.md" }, ctx);
    const sourceArtifactWrite = await createArtifactWriteTool().execute({
      workflowId: source.workflow.id,
      kind: "SPEC",
      content: "# Wrong workflow write\n",
    }, ctx);

    expect(isToolError(sourceWorkflowRead)).toBe(false);
    expect(toolOutput(sourceWorkflowRead)).toContain(source.workflow.id);
    expect(isToolError(sourceArtifactRead)).toBe(false);
    expect(toolOutput(sourceArtifactRead)).toContain("# Source research");
    expect(isToolError(sourceArtifactWrite)).toBe(true);
    expect(toolOutput(sourceArtifactWrite)).toContain("TOOL_WORKFLOW_WRONG_WORKFLOW");
    expect(toolOutput(sourceArtifactWrite)).toContain(result.workflow.id);
    expect(toolOutput(sourceArtifactWrite)).toContain(source.workflow.id);
  });

  test("artifact manager reads artifacts across workflow contexts by workflow id", async () => {
    const root = workspaceRoot("cross-artifacts");
    const stateManager = new WorkflowStateManager(root);
    const artifactManager = new WorkflowArtifactManager(root, stateManager);

    const wf_a = await stateManager.create({ title: "Workflow A", type: "research_only" });
    const wf_b = await stateManager.create({ title: "Workflow B", type: "quick_fix" });
    await artifactManager.write({ workflowId: wf_a.id, kind: "RESEARCH", content: "# Shared research" });
    await artifactManager.write({ workflowId: wf_b.id, kind: "FINAL_REPORT", content: "# Other workflow" });

    const readFromOtherContext = await artifactManager.read(wf_a.id, "RESEARCH.md");
    expect(readFromOtherContext.frontmatter).toMatchObject({
      "specra.workflowId": wf_a.id,
      "specra.artifactKind": "RESEARCH",
      "specra.artifactPath": "RESEARCH.md",
    });
    expect(readFromOtherContext.body).toContain("Shared research");
    expect((await stateManager.read(wf_b.id)).artifacts).toEqual({ FINAL_REPORT: "FINAL_REPORT.md" });
  });

  test("session linking stores workflowId on session and orchestrator session id on workflow", async () => {
    const root = workspaceRoot("session-linking");
    const stateManager = new WorkflowStateManager(root);
    const storeManager = new SessionStoreManager({ logger: silentLogger });
    const session = storeManager.create("orchestrator-session", root);

    const linked = await createWorkflowWithOrchestrator({ title: "Linked Workflow", type: "full_feature", orchestratorSessionId: session.getState().sessionId }, stateManager, storeManager);

    expect(linked.session.workflowId).toBe(linked.workflow.id);
    expect(linked.workflow.sessionIds.orchestrator).toBe("orchestrator-session");
    expect((await stateManager.read(linked.workflow.id)).sessionIds.orchestrator).toBe("orchestrator-session");
    expect(storeManager.get("orchestrator-session", root)?.getState().workflowId).toBe(linked.workflow.id);
  });

  test("workflow tools emit workflow.state_change SSE stream events", async () => {
    const root = workspaceRoot("sse-events");
    const storeManager = new SessionStoreManager({ logger: silentLogger });
    const store = storeManager.create("sse-session", root);
    const ctx = createContext(root, storeManager, store);

    const createdResult = JSON.parse(await createWorkflowCreateTool().execute({ title: "SSE Events", type: "quick_fix" }, ctx) as string);
    const workflowId = createdResult.id;
    await createWorkflowRecordCompletionTool().execute({ workflowId, stage: "idle" }, ctx);
    await createWorkflowUpdateStageTool().execute({ workflowId, stage: "quick_analysis", hasUserApproval: false, incrementRetry: false }, ctx);

    const events = store.getState().events.filter((event) => event.kind === "workflow.state_change");
    expect(events.map((event) => event.payload)).toMatchObject([
      { type: "workflow.state_change", workflowId, changed: ["stage", "status", "sessionIds"] },
      { type: "workflow.state_change", workflowId, changed: ["stageCompletions"] },
      { type: "workflow.state_change", workflowId, changed: ["stage"] },
    ]);
  });

  test("pending interactions can be added, answered, and terminally resolved in the session store", () => {
    const root = workspaceRoot("pending-interactions");
    const storeManager = new SessionStoreManager({ logger: silentLogger });
    const store = storeManager.create("pending-session", root);

    store.getState().addPendingInteraction({ id: "q-1", type: "clarification", question: "Proceed?", askedAt: "2026-01-01T00:00:00.000Z", status: "pending" });
    expect(store.getState().pendingInteractions).toEqual([{ id: "q-1", type: "clarification", question: "Proceed?", askedAt: "2026-01-01T00:00:00.000Z", status: "pending" }]);

    store.getState().answerPendingInteraction("q-1", "yes", "2026-01-01T00:01:00.000Z");
    expect(store.getState().pendingInteractions?.[0]).toMatchObject({ id: "q-1", status: "answered", answer: { content: "yes", answeredAt: "2026-01-01T00:01:00.000Z" } });

    store.getState().append({ type: "question.request", questionId: "q-2", question: "Ship?", questionType: "approval" });
    store.getState().append({ type: "question.terminal", questionId: "q-2", status: "resolved", answer: "ship" });
    expect(store.getState().pendingInteractions?.find((entry) => entry.id === "q-2")).toMatchObject({ status: "answered", answer: { content: "ship" } });
  });

  test("child execution receives delegate artifact references without artifact content", async () => {
    const root = workspaceRoot("delegate-artifacts");
    const storeManager = new SessionStoreManager({ logger: silentLogger });
    const parentStore = storeManager.create("parent-session", root, { agentName: "orchestrator", workflowId: "550e8400-e29b-41d4-a716-446655440010" });
    const capturedMessages: string[] = [];
    const manager = new SessionExecutionManager({
      sessionAgentManager: createFakeSessionAgentManager(capturedMessages) as never,
      createSessionStore: (sessionId, workspaceRoot, options) => storeManager.create(sessionId, workspaceRoot, options),
      getSessionStore: (sessionId, workspaceRoot) => storeManager.get(sessionId, workspaceRoot),
      deleteSessionStore: (sessionId, workspaceRoot) => storeManager.delete(sessionId, workspaceRoot),
      resolveRootSessionId: (sessionId) => Promise.resolve(sessionId),
      buildSessionTree: async (_workspaceRoot, rootSessionId) => ({ root: { session: { sessionId: rootSessionId, rootSessionId, agentName: "orchestrator", title: null, createdAt: Date.now() }, children: [] }, diagnostics: [] }),
      requestPermission: async () => "approve_once",
      requestQuestion: async () => ({ answers: [] }),
      cleanupDeferredSession: () => {},
      trackSession: () => {},
      untrackSession: () => {},
      logger: silentLogger,
    });
    const secretArtifactContent = "SECRET ARTIFACT CONTENT";

    const handle = await manager.startChildExecution(root, {
      parentStore,
      parentSessionId: "parent-session",
      parentToolCallId: "delegate-1",
      toolName: "delegate",
      targetAgentName: "explore",
      prompt: "Inspect the available research reference only.",
      skills: [],
      available_artifacts: [
        { workflowId: "550e8400-e29b-41d4-a716-446655440010", kind: "RESEARCH", description: "Research summary reference" },
        { workflowId: "550e8400-e29b-41d4-a716-446655440010", path: "notes/context.md" },
      ],
      background: false,
      currentDepth: 0,
    });
    await handle.result;

    expect(capturedMessages[0]).toContain("Available artifacts:");
    expect(capturedMessages[0]).toContain("550e8400-e29b-41d4-a716-446655440010/RESEARCH: Research summary reference");
    expect(capturedMessages[0]).toContain("550e8400-e29b-41d4-a716-446655440010/notes/context.md");
    expect(capturedMessages[0]).toContain("Use artifact_read before relying on artifact content");
    expect(capturedMessages[0]).not.toContain(secretArtifactContent);
    expect(handle.store.getState().workflowId).toBe("550e8400-e29b-41d4-a716-446655440010");
  });

  test("error cases reject invalid transitions, premature completion, and derivation from terminal sources", async () => {
    const root = workspaceRoot("error-cases");
    const stateManager = new WorkflowStateManager(root);
    const artifactManager = new WorkflowArtifactManager(root, stateManager);

    const wf_errors = await stateManager.create({ title: "Error Cases", type: "full_feature" });
    const invalid = validateTransition({ workflowId: wf_errors.id, workflowType: "full_feature", currentStage: "idle", targetStage: "final_review", retryCount: 0, maxRetries: 3, hasArtifact: () => false, hasStageCompletion: () => false, hasUserApproval: false });
    expect(invalid.allowed).toBe(false);
    expect(invalid.errorName).toBe("WorkflowTransitionError");

    await advance(stateManager, wf_errors.id, "requirements_interview");
    await stateManager.recordStageCompletion(wf_errors.id, { stage: "requirements_interview", noRequiredInteractionsReason: "Error-case setup has no requirements questions." });
    await advance(stateManager, wf_errors.id, "product_drafting");
    await artifactManager.write({ workflowId: wf_errors.id, kind: "PRD", content: "# PRD" });
    const missingCompletion = validateTransition({ workflowId: wf_errors.id, workflowType: "full_feature", currentStage: "product_drafting", targetStage: "critic_prd_review", retryCount: 0, maxRetries: 3, hasArtifact: (kind) => kind === "PRD", hasStageCompletion: (stage) => stage === "requirements_interview", hasUserApproval: false });
    expect(missingCompletion.allowed).toBe(false);
    expect(missingCompletion.error).toContain("record completion for product_drafting");

    const prematureComplete = canCompleteWorkflow(await stateManager.read(wf_errors.id), () => true);
    expect(prematureComplete.allowed).toBe(false);
    expect(prematureComplete.error).toContain("required stage final_review");

    await stateManager.complete(wf_errors.id);
    await stateManager.createDerived({ sourceWorkflowId: wf_errors.id, targetType: "full_feature", reason: "upgrade", title: "Derived" })
      .then(
        () => { throw new Error("Expected terminal source derivation to fail"); },
        (error) => expect(error).toBeInstanceOf(WorkflowTerminalStateError),
      );
  });

  test("workflow tools deny invalid transition and completion without prerequisites", async () => {
    const root = workspaceRoot("tool-errors");
    const storeManager = new SessionStoreManager({ logger: silentLogger });
    const store = storeManager.create("tool-error-session", root);
    const ctx = createContext(root, storeManager, store);

    const createdResult = JSON.parse(await createWorkflowCreateTool().execute({ title: "Tool Errors", type: "full_feature" }, ctx) as string);
    const wfToolId = createdResult.id;
    const transitionResult = await createWorkflowUpdateStageTool().execute({ workflowId: wfToolId, stage: "final_review", hasUserApproval: false, incrementRetry: false }, ctx);
    const completeResult = await createWorkflowCompleteTool().execute({ workflowId: wfToolId }, ctx);

    expect(isToolError(transitionResult)).toBe(true);
    expect(isToolError(completeResult)).toBe(true);
    expect(toolOutput(transitionResult)).toContain("TOOL_WORKFLOW_TRANSITION_DENIED");
    expect(toolOutput(completeResult)).toContain("TOOL_WORKFLOW_COMPLETION_DENIED");
  });
});

async function transition(
  stateManager: WorkflowStateManager,
  workflowId: string,
  currentStage: WorkflowStage,
  targetStage: WorkflowStage,
  hasUserApproval: boolean,
): Promise<void> {
  const state = await stateManager.read(workflowId);
  expect(state.stage).toBe(currentStage);

  const result = validateTransition({
    workflowId,
    workflowType: state.type,
    currentStage,
    targetStage,
    retryCount: state.retryCount,
    maxRetries: state.maxRetries,
    hasArtifact: (kind: string) => Boolean(state.artifacts[kind as keyof typeof state.artifacts]),
    hasStageCompletion: (stage: WorkflowStage) => Boolean(state.stageCompletions[stage]),
    hasResolvedBlockingDecisionInteractions: (stage: WorkflowStage) => hasResolvedBlockingDecisionInteractions(state, stage),
    hasNoRequiredInteractionsReason: (stage: WorkflowStage) => Boolean(state.noRequiredInteractionsReason[stage]?.trim()),
    hasUserApproval,
  });

  expect(result).toEqual({ allowed: true });
  if (currentStage !== "idle") {
    await stateManager.recordStageCompletion(workflowId, {
      stage: currentStage,
      noRequiredInteractionsReason: isPlanningOrReviewStage(currentStage)
        ? `No user interaction required for ${currentStage} in test transition.`
        : undefined,
    });
  }
  await stateManager.updateStage(workflowId, targetStage);
}

function workspaceRoot(name: string): string {
  return join(TMP_DIR, name);
}

function createWorkflowToolRegistry(): ReturnType<typeof createRegistry> {
  return createRegistry([
    createWorkflowCreateTool(),
    createWorkflowReadTool(),
    createWorkflowUpdateStageTool(),
    createWorkflowRecordCompletionTool(),
    createWorkflowCompleteTool(),
    createWorkflowProposeInteractionsTool(),
    createWorkflowRequestInteractionsTool(),
    createArtifactReadTool(),
    createArtifactWriteTool(),
  ]);
}

async function executeWorkflowTool(
  registry: ReturnType<typeof createRegistry>,
  root: string,
  storeManager: SessionStoreManager,
  store: StoreApi<SessionStoreState>,
  toolName: string,
  input: unknown,
  options: {
    askUser?: ToolExecutionContext["askUser"];
    agentName?: string;
  } = {},
): Promise<ToolExecutionResult> {
  const ctx = createToolExecutionContext({
    store,
    storeManager,
    toolName,
    toolCallId: `${toolName}-${crypto.randomUUID()}`,
    input,
    step: 1,
    abort: new AbortController().signal,
    agentName: options.agentName ?? store.getState().agentName,
    startedAt: Date.now(),
    allowedTools: new Set(registry.getAll().map((tool) => tool.name)),
    projectContext: createTestProjectContext(root),
    ...(options.askUser ? { askUser: options.askUser } : {}),
  });
  return await registry.execute({ toolName, toolCallId: ctx.toolCallId, input }, ctx);
}

function parseToolJson<T = unknown>(result: ToolExecutionResult): T {
  expect(result.isError).toBe(false);
  return JSON.parse(result.output) as T;
}

function expectToolError(result: ToolExecutionResult, expectedFragment: string): string {
  expect(result.isError).toBe(true);
  expect(result.output).toContain(expectedFragment);
  return result.output;
}

function interactionProposal(overrides: Record<string, unknown> = {}) {
  return {
    decisionKey: "requirements.scope",
    stage: "requirements_interview",
    sourceAgent: "product",
    kind: "decision",
    blocking: true,
    question: "Which user-owned decision should planning use?",
    options: ["Option A", "Option B"],
    recommendedOption: "Option A",
    rationale: "The workflow needs this decision before the next planning gate can be completed.",
    ...overrides,
  };
}

async function createWorkflowAtRequirementsGate(name: string): Promise<{
  root: string;
  storeManager: SessionStoreManager;
  store: StoreApi<SessionStoreState>;
  registry: ReturnType<typeof createRegistry>;
  stateManager: WorkflowStateManager;
  artifactManager: WorkflowArtifactManager;
  workflowId: string;
}> {
  const root = workspaceRoot(name);
  const storeManager = new SessionStoreManager({ logger: silentLogger });
  const store = storeManager.create(`${name}-session`, root, { agentName: "orchestrator" });
  const registry = createWorkflowToolRegistry();
  const stateManager = new WorkflowStateManager(root);
  const artifactManager = new WorkflowArtifactManager(root, stateManager);
  const workflow = parseToolJson<{ id: string }>(await executeWorkflowTool(registry, root, storeManager, store, "workflow_create", {
    title: name,
    type: "full_feature",
  }));

  parseToolJson(await executeWorkflowTool(registry, root, storeManager, store, "workflow_update_stage", {
    workflowId: workflow.id,
    stage: "requirements_interview",
    hasUserApproval: false,
    incrementRetry: false,
  }));
  parseToolJson(await executeWorkflowTool(registry, root, storeManager, store, "workflow_propose_interactions", {
    workflowId: workflow.id,
    proposals: [interactionProposal({
      decisionKey: "requirements.blocker",
      question: "Resolve the requirements blocker?",
      options: ["Resolve now", "Defer"],
      recommendedOption: "Resolve now",
    })],
  }, { agentName: "product" }));
  parseToolJson(await executeWorkflowTool(registry, root, storeManager, store, "workflow_record_completion", {
    workflowId: workflow.id,
    stage: "requirements_interview",
    evidence: ["requirements gate attempted"],
  }));

  return { root, storeManager, store, registry, stateManager, artifactManager, workflowId: workflow.id };
}

async function advance(
  stateManager: WorkflowStateManager,
  workflowId: string,
  targetStage: WorkflowStage,
  hasUserApproval = false,
): Promise<void> {
  const state = await stateManager.read(workflowId);
  const result = validateTransition({
    workflowId,
    workflowType: state.type,
    currentStage: state.stage,
    targetStage,
    retryCount: state.retryCount,
    maxRetries: state.maxRetries,
    hasArtifact: (kind) => Boolean(state.artifacts[kind as keyof typeof state.artifacts]),
    hasStageCompletion: (stage) => Boolean(state.stageCompletions[stage]),
    hasResolvedBlockingDecisionInteractions: (stage) => hasResolvedBlockingDecisionInteractions(state, stage),
    hasNoRequiredInteractionsReason: (stage) => Boolean(state.noRequiredInteractionsReason[stage]?.trim()),
    hasUserApproval,
  });

  expect(result).toEqual({ allowed: true });
  await stateManager.updateStage(workflowId, targetStage);
}

function isPlanningOrReviewStage(stage: WorkflowStage): boolean {
  return stage === "requirements_interview" ||
    stage === "product_drafting" ||
    stage === "critic_prd_review" ||
    stage === "spec_drafting" ||
    stage === "critic_spec_review";
}

function createContext(
  root: string,
  storeManager: SessionStoreManager,
  store: StoreApi<SessionStoreState>,
): ToolExecutionContext {
  const registry = createRegistry();
  registerBuiltinTools(registry, silentLogger);
  return createToolExecutionContext({
    store,
    storeManager,
    toolName: "workflow-test",
    toolCallId: crypto.randomUUID(),
    input: {},
    step: 0,
    abort: new AbortController().signal,
    agentName: "orchestrator",
    startedAt: Date.now(),
    allowedTools: new Set(registry.getAll().map((tool) => tool.name)),
    projectContext: createTestProjectContext(root),
  });
}

function isToolError(result: string | ToolExecutionResult): boolean {
  return typeof result !== "string" && result.isError;
}

function toolOutput(result: string | ToolExecutionResult): string {
  return typeof result === "string" ? result : result.output;
}

function createFakeSessionAgentManager(capturedMessages: string[], childTools: string[] = []) {
  const definitions = new Map<string, AgentDefinition>([
    ["orchestrator", {
      name: "orchestrator",
      promptProfileId: "orchestrator",
      tools: { tools: ["delegate"], delegateTargets: ["explore"] },
      hooks: emptyHooks(),
      childPolicy: { maxDepth: 2, maxConcurrent: 2, timeoutMs: 0, abortCascade: true, terminalReminders: false },
      includeMemoryInPrompt: false,
      skills: [],
    }],
    ["explore", {
      name: "explore",
      promptProfileId: "explore",
      tools: { tools: childTools },
      hooks: emptyHooks(),
      includeMemoryInPrompt: false,
      skills: [],
    }],
  ]);

  const agents = new Map<string, { store: StoreApi<SessionStoreState>; run: (message: string) => Promise<void>; dispose: () => void }>();
  const factory = {
    getDefinition: (name: string) => definitions.get(name) ?? (() => { throw new Error(`Missing definition: ${name}`); })(),
    resolveAllowedTools: (definition: AgentDefinition) => definition.tools.tools,
    getDelegateTargetsFor: (definition: AgentDefinition) => definition.tools.delegateTargets ?? [],
    resolveDelegatedSkills: async () => [],
  };

  return {
    getFactory: () => factory,
    acquireSlot: () => {},
    releaseSlot: () => {},
    createChildAgent: (input: { sessionId: string; store: StoreApi<SessionStoreState> }) => {
      const agent = {
        store: input.store,
        run: async (message: string) => {
          capturedMessages.push(message);
          input.store.getState().append({ type: "text-start" });
          input.store.getState().append({ type: "text-delta", text: "done" });
          input.store.getState().append({ type: "text-end" });
        },
        dispose: () => {},
      };
      agents.set(input.sessionId, agent);
      return agent;
    },
    getOrCreate: async (_workspaceRoot: string, sessionId: string) => {
      const agent = agents.get(sessionId);
      if (!agent) throw new Error(`Missing child agent: ${sessionId}`);
      return agent;
    },
    dispatchCommand: async () => null,
    dispose: () => {},
  };
}

function emptyHooks(): AgentDefinition["hooks"] {
  return {
    autoCompact: false,
    autoInjectReminder: false,
    todoContinuation: false,
    transcriptSave: false,
    memoryExtraction: false,
    memoryConsolidation: false,
    titleGeneration: "disabled",
  };
}
