import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { StoreApi } from "zustand";

import { WorkflowArtifactManager } from "./artifacts";
import { processCriticDecision } from "./critic-protocol";
import { canCompleteWorkflow, validateTransition } from "./guards";
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
import { createWorkflowCreateTool } from "../../tools/builtins/workflow/workflow-create";
import { createWorkflowUpdateStageTool } from "../../tools/builtins/workflow/workflow-update-stage";
import { createWorkflowCompleteTool } from "../../tools/builtins/workflow/workflow-complete";
import { createWorkflowRecordCompletionTool } from "../../tools/builtins/workflow/workflow-record-completion";
import { SessionExecutionManager } from "../../execution/session-execution-manager";
import type { AgentDefinition } from "../factory-types";

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
    await stateManager.recordStageCompletion(WORKFLOW_ID, { stage: "product_drafting" });

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
    await stateManager.recordStageCompletion(WORKFLOW_ID, { stage: "spec_drafting" });
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

    await stateManager.recordStageCompletion(WORKFLOW_ID, { stage: "awaiting_user_approval" });
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
    await stateManager.recordStageCompletion(WORKFLOW_ID, { stage: "foreman_executing" });
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

describe("end-to-end workflow lifecycle integration", () => {
  test("full_feature lifecycle advances through stages, records completions, artifacts, and completes", async () => {
    const root = workspaceRoot("full-feature");
    const stateManager = new WorkflowStateManager(root);
    const artifactManager = new WorkflowArtifactManager(root, stateManager);

    await stateManager.create({ id: "wf-full", type: "full_feature" });
    await advance(stateManager, "wf-full", "product_drafting");
    await artifactManager.write({ workflowId: "wf-full", kind: "PRD", path: "PRD.md", content: "---\nowner: product\n---\n# PRD" });
    await stateManager.recordStageCompletion("wf-full", { stage: "product_drafting", evidence: ["PRD.md"] });
    await advance(stateManager, "wf-full", "critic_prd_review");
    await artifactManager.write({ workflowId: "wf-full", kind: "CRITIC_REPORT", path: "critic-reports/prd.md", content: "approved" });
    await processCriticDecision({ workflowId: "wf-full", decision: "approved", currentStage: "critic_prd_review", criticReportPath: "critic-reports/prd.md" }, stateManager);

    await artifactManager.write({ workflowId: "wf-full", kind: "SPEC", path: "SPEC.md", content: "---\nowner: spec\n---\n# SPEC" });
    await artifactManager.write({ workflowId: "wf-full", kind: "TASKS", path: "TASKS.md", content: TASKS_MARKDOWN });
    await stateManager.recordStageCompletion("wf-full", { stage: "spec_drafting", evidence: ["SPEC.md", "TASKS.md"] });
    await advance(stateManager, "wf-full", "critic_spec_review");
    await artifactManager.write({ workflowId: "wf-full", kind: "CRITIC_REPORT", path: "critic-reports/spec.md", content: "approved" });
    await processCriticDecision({ workflowId: "wf-full", decision: "approved", currentStage: "critic_spec_review", criticReportPath: "critic-reports/spec.md" }, stateManager);

    await stateManager.recordStageCompletion("wf-full", { stage: "awaiting_user_approval", evidence: ["user-approved"] });
    await advance(stateManager, "wf-full", "foreman_executing", true);
    await artifactManager.write({ workflowId: "wf-full", kind: "EVIDENCE", path: "evidence/builder.md", content: "builder done" });
    await stateManager.recordStageCompletion("wf-full", { stage: "foreman_executing", evidence: ["evidence/builder.md"] });
    await advance(stateManager, "wf-full", "final_review");
    await artifactManager.write({ workflowId: "wf-full", kind: "FINAL_REPORT", path: "FINAL_REPORT.md", content: "---\nstatus: complete\n---\n# Done" });
    await stateManager.recordStageCompletion("wf-full", { stage: "final_review", evidence: ["FINAL_REPORT.md"] });

    const beforeComplete = await stateManager.read("wf-full");
    expect(canCompleteWorkflow(beforeComplete, (kind) => Boolean(beforeComplete.artifacts[kind as keyof typeof beforeComplete.artifacts]))).toEqual({ allowed: true });
    const completed = await stateManager.complete("wf-full");

    expect(completed.status).toBe("completed");
    expect(completed.stage).toBe("final_review");
    expect(completed.artifacts).toMatchObject({ PRD: "PRD.md", SPEC: "SPEC.md", TASKS: "TASKS.md", FINAL_REPORT: "FINAL_REPORT.md" });
    expect(completed.artifacts.CRITIC_REPORT).toEqual(["critic-reports/prd.md", "critic-reports/spec.md"]);
    expect(completed.artifacts.EVIDENCE).toEqual(["evidence/builder.md"]);
    expect(completed.stageCompletions.final_review?.evidence).toEqual(["FINAL_REPORT.md"]);
  });

  test("research_only lifecycle creates research, consolidates, and completes", async () => {
    const root = workspaceRoot("research-only");
    const stateManager = new WorkflowStateManager(root);
    const artifactManager = new WorkflowArtifactManager(root, stateManager);

    await stateManager.create({ id: "wf-research", type: "research_only" });
    await advance(stateManager, "wf-research", "researching");
    await artifactManager.write({ workflowId: "wf-research", kind: "RESEARCH", path: "RESEARCH.md", content: "---\nowner: librarian\n---\n# Findings" });
    await stateManager.recordStageCompletion("wf-research", { stage: "researching", evidence: ["RESEARCH.md"] });
    await advance(stateManager, "wf-research", "research_consolidation");
    await stateManager.recordStageCompletion("wf-research", { stage: "research_consolidation", evidence: ["RESEARCH.md"] });

    const ready = await stateManager.read("wf-research");
    expect(canCompleteWorkflow(ready, (kind) => Boolean(ready.artifacts[kind as keyof typeof ready.artifacts]))).toEqual({ allowed: true });
    expect((await stateManager.complete("wf-research")).status).toBe("completed");
  });

  test("quick_fix lifecycle advances through analysis, patch, verify, and completes", async () => {
    const root = workspaceRoot("quick-fix");
    const stateManager = new WorkflowStateManager(root);

    await stateManager.create({ id: "wf-quick", type: "quick_fix" });
    await advance(stateManager, "wf-quick", "quick_analysis");
    await stateManager.recordStageCompletion("wf-quick", { stage: "quick_analysis", evidence: ["analysis"] });
    await advance(stateManager, "wf-quick", "quick_patch");
    await stateManager.recordStageCompletion("wf-quick", { stage: "quick_patch", evidence: ["patch"] });
    await advance(stateManager, "wf-quick", "quick_verify");
    await stateManager.recordStageCompletion("wf-quick", { stage: "quick_verify", evidence: ["bun test"] });

    const ready = await stateManager.read("wf-quick");
    expect(canCompleteWorkflow(ready, () => true)).toEqual({ allowed: true });
    expect((await stateManager.complete("wf-quick")).status).toBe("completed");
  });

  test("derived upgrade from research_only keeps source active and links derived full_feature", async () => {
    const root = workspaceRoot("derived-upgrade");
    const stateManager = new WorkflowStateManager(root);
    const artifactManager = new WorkflowArtifactManager(root, stateManager);
    const storeManager = new SessionStoreManager({ logger: silentLogger });
    const sourceStore = storeManager.create("source-session", root);

    await createWorkflowWithOrchestrator({ id: "wf-source", type: "research_only", orchestratorSessionId: sourceStore.getState().sessionId }, stateManager, storeManager);
    await advance(stateManager, "wf-source", "researching");
    await artifactManager.write({ workflowId: "wf-source", kind: "RESEARCH", path: "RESEARCH.md", content: "---\nowner: research\n---\n# Source research" });
    await stateManager.recordStageCompletion("wf-source", { stage: "researching", evidence: ["RESEARCH.md"] });
    await advance(stateManager, "wf-source", "research_consolidation");
    await stateManager.recordStageCompletion("wf-source", { stage: "research_consolidation" });

    const result = await createDerivedWorkflowWithOrchestrator({ sourceWorkflowId: "wf-source", targetType: "full_feature", reason: "upgrade", id: "wf-derived", workspaceRoot: root }, stateManager, storeManager);
    const sourceAfter = await stateManager.read("wf-source");
    const derived = await stateManager.read("wf-derived");

    expect(sourceAfter.status).toBe("active");
    expect(sourceAfter.stage).toBe("research_consolidation");
    expect(sourceAfter.derivedWorkflows).toEqual([{ workflowId: "wf-derived", reason: "upgrade", createdAt: result.source.derivedWorkflows[0]?.createdAt }]);
    expect(sourceAfter.artifacts.RESEARCH).toBe("RESEARCH.md");
    expect(derived.type).toBe("full_feature");
    expect(derived.derivedFrom?.workflowId).toBe("wf-source");
    expect(derived.derivedFrom?.reason).toBe("upgrade");
    expect(result.session.workflowId).toBe("wf-derived");
    expect(result.workflow.sessionIds.orchestrator).toBe(result.session.sessionId);
    expect(result.session.messages[0]?.parts[0]).toMatchObject({ type: "text" });
    expect(result.session.messages[0]?.parts[0]?.type === "text" ? result.session.messages[0].parts[0].text : "").toContain('artifact_read({ workflowId: "wf-source", path: "RESEARCH.md" })');
  });

  test("artifact manager reads artifacts across workflow contexts by workflow id", async () => {
    const root = workspaceRoot("cross-artifacts");
    const stateManager = new WorkflowStateManager(root);
    const artifactManager = new WorkflowArtifactManager(root, stateManager);

    await stateManager.create({ id: "wf-a", type: "research_only" });
    await stateManager.create({ id: "wf-b", type: "quick_fix" });
    await artifactManager.write({ workflowId: "wf-a", kind: "RESEARCH", path: "RESEARCH.md", content: "---\nowner: a\n---\n# Shared research" });
    await artifactManager.write({ workflowId: "wf-b", kind: "FINAL_REPORT", path: "FINAL_REPORT.md", content: "---\nowner: b\n---\n# Other workflow" });

    const readFromOtherContext = await artifactManager.read("wf-a", "RESEARCH.md");
    expect(readFromOtherContext.frontmatter.owner).toBe("a");
    expect(readFromOtherContext.body).toContain("Shared research");
    expect((await stateManager.read("wf-b")).artifacts).toEqual({ FINAL_REPORT: "FINAL_REPORT.md" });
  });

  test("session linking stores workflowId on session and orchestrator session id on workflow", async () => {
    const root = workspaceRoot("session-linking");
    const stateManager = new WorkflowStateManager(root);
    const storeManager = new SessionStoreManager({ logger: silentLogger });
    const session = storeManager.create("orchestrator-session", root);

    const linked = await createWorkflowWithOrchestrator({ id: "wf-linked", type: "full_feature", orchestratorSessionId: session.getState().sessionId }, stateManager, storeManager);

    expect(linked.session.workflowId).toBe("wf-linked");
    expect(linked.workflow.sessionIds.orchestrator).toBe("orchestrator-session");
    expect((await stateManager.read("wf-linked")).sessionIds.orchestrator).toBe("orchestrator-session");
    expect(storeManager.get("orchestrator-session", root)?.getState().workflowId).toBe("wf-linked");
  });

  test("workflow tools emit workflow.state_change SSE stream events", async () => {
    const root = workspaceRoot("sse-events");
    const storeManager = new SessionStoreManager({ logger: silentLogger });
    const store = storeManager.create("sse-session", root);
    const ctx = createContext(root, storeManager, store);

    await createWorkflowCreateTool().execute({ id: "wf-sse", type: "quick_fix" }, ctx);
    await createWorkflowRecordCompletionTool().execute({ workflowId: "wf-sse", stage: "idle" }, ctx);
    await createWorkflowUpdateStageTool().execute({ workflowId: "wf-sse", stage: "quick_analysis", hasUserApproval: false, incrementRetry: false }, ctx);

    const events = store.getState().events.filter((event) => event.kind === "workflow.state_change");
    expect(events.map((event) => event.payload)).toMatchObject([
      { type: "workflow.state_change", workflowId: "wf-sse", changed: ["stage", "status", "sessionIds"] },
      { type: "workflow.state_change", workflowId: "wf-sse", changed: ["stageCompletions"] },
      { type: "workflow.state_change", workflowId: "wf-sse", changed: ["stage"] },
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
    const parentStore = storeManager.create("parent-session", root, { agentName: "orchestrator", workflowId: "wf-parent" });
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
        { workflowId: "wf-parent", kind: "RESEARCH", description: "Research summary reference" },
        { workflowId: "wf-parent", path: "notes/context.md" },
      ],
      background: false,
      currentDepth: 0,
    });
    await handle.result;

    expect(capturedMessages[0]).toContain("Available artifacts:");
    expect(capturedMessages[0]).toContain("wf-parent/RESEARCH: Research summary reference");
    expect(capturedMessages[0]).toContain("wf-parent/notes/context.md");
    expect(capturedMessages[0]).toContain("Use artifact_read before relying on artifact content");
    expect(capturedMessages[0]).not.toContain(secretArtifactContent);
    expect(handle.store.getState().workflowId).toBe("wf-parent");
  });

  test("error cases reject invalid transitions, premature completion, and derivation from terminal sources", async () => {
    const root = workspaceRoot("error-cases");
    const stateManager = new WorkflowStateManager(root);
    const artifactManager = new WorkflowArtifactManager(root, stateManager);

    await stateManager.create({ id: "wf-errors", type: "full_feature" });
    const invalid = validateTransition({ workflowId: "wf-errors", workflowType: "full_feature", currentStage: "idle", targetStage: "final_review", retryCount: 0, maxRetries: 3, hasArtifact: () => false, hasStageCompletion: () => false, hasUserApproval: false });
    expect(invalid.allowed).toBe(false);
    expect(invalid.errorName).toBe("WorkflowTransitionError");

    await advance(stateManager, "wf-errors", "product_drafting");
    await artifactManager.write({ workflowId: "wf-errors", kind: "PRD", path: "PRD.md", content: "---\nowner: product\n---\n# PRD" });
    const missingCompletion = validateTransition({ workflowId: "wf-errors", workflowType: "full_feature", currentStage: "product_drafting", targetStage: "critic_prd_review", retryCount: 0, maxRetries: 3, hasArtifact: (kind) => kind === "PRD", hasStageCompletion: () => false, hasUserApproval: false });
    expect(missingCompletion.allowed).toBe(false);
    expect(missingCompletion.error).toContain("record completion for product_drafting");

    const prematureComplete = canCompleteWorkflow(await stateManager.read("wf-errors"), () => true);
    expect(prematureComplete.allowed).toBe(false);
    expect(prematureComplete.error).toContain("required stage final_review");

    await stateManager.complete("wf-errors");
    await stateManager.createDerived({ sourceWorkflowId: "wf-errors", targetType: "full_feature", reason: "upgrade", id: "wf-derived-error" })
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

    await createWorkflowCreateTool().execute({ id: "wf-tool-errors", type: "full_feature" }, ctx);
    const transitionResult = await createWorkflowUpdateStageTool().execute({ workflowId: "wf-tool-errors", stage: "final_review", hasUserApproval: false, incrementRetry: false }, ctx);
    const completeResult = await createWorkflowCompleteTool().execute({ workflowId: "wf-tool-errors" }, ctx);

    expect(isToolError(transitionResult)).toBe(true);
    expect(isToolError(completeResult)).toBe(true);
    expect(toolOutput(transitionResult)).toContain("TOOL_WORKFLOW_TRANSITION_DENIED");
    expect(toolOutput(completeResult)).toContain("TOOL_WORKFLOW_COMPLETION_DENIED");
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
    hasStageCompletion: (stage: WorkflowStage) => Boolean(state.stageCompletions[stage]),
    hasUserApproval,
  });

  expect(result).toEqual({ allowed: true });
  if (currentStage !== "idle") {
    await stateManager.recordStageCompletion(WORKFLOW_ID, { stage: currentStage });
  }
  await stateManager.updateStage(WORKFLOW_ID, targetStage);
}

function workspaceRoot(name: string): string {
  return join(TMP_DIR, name);
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
    hasUserApproval,
  });

  expect(result).toEqual({ allowed: true });
  await stateManager.updateStage(workflowId, targetStage);
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

function createFakeSessionAgentManager(capturedMessages: string[]) {
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
      tools: { tools: [] },
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
