import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { silentLogger } from "../../logger";
import { SessionStoreManager } from "../../store/session-store-manager";
import {
  createDerivedWorkflowWithOrchestrator,
  createWorkflowWithOrchestrator,
  linkSessionToWorkflow,
  unlinkSessionFromWorkflow,
  WORKFLOW_PARTICIPANT_KEYS,
  type WorkflowParticipantKey,
} from "./linking";
import { WorkflowStateManager } from "./state";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "workflow-linking");

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("workflow session linking", () => {
  test("links a session as orchestrator and persists the session workflow id", async () => {
    const { stateManager, storeManager } = createManagers();
    const wf_orchestrator = await stateManager.create({ title: "wf-orchestrator", type: "full_feature" });
    const store = storeManager.create("session-orchestrator", TMP_DIR);

    const linked = await linkSessionToWorkflow(
      wf_orchestrator.id,
      "orchestrator",
      "session-orchestrator",
      stateManager,
      storeManager,
    );

    expect(linked.workflow.sessionIds).toEqual({ orchestrator: "session-orchestrator" });
    expect(linked.session.workflowId).toBe(wf_orchestrator.id);
    expect(store.getState().workflowId).toBe(wf_orchestrator.id);
    await expect(stateManager.read(wf_orchestrator.id)).resolves.toMatchObject({
      sessionIds: { orchestrator: "session-orchestrator" },
    });
    await expect(storeManager.getSessionFile(TMP_DIR, "session-orchestrator")).resolves.toMatchObject({
      workflowId: wf_orchestrator.id,
    });
  });

  test("links first-class role participants with stable keys", async () => {
    const { stateManager, storeManager } = createManagers();
    const wf_roles = await stateManager.create({ title: "wf-roles", type: "full_feature" });

    for (const key of WORKFLOW_PARTICIPANT_KEYS) {
      const sessionId = `session-${key}`;
      storeManager.create(sessionId, TMP_DIR);
      await linkSessionToWorkflow(wf_roles.id, key, sessionId, stateManager, storeManager);
    }

    const workflow = await stateManager.read(wf_roles.id);
    expect(workflow.sessionIds).toEqual({
      orchestrator: "session-orchestrator",
      product: "session-product",
      spec: "session-spec",
      critic: "session-critic",
      foreman: "session-foreman",
    });
    for (const key of WORKFLOW_PARTICIPANT_KEYS) {
      expect(storeManager.get(`session-${key}`, TMP_DIR)?.getState().workflowId).toBe(wf_roles.id);
    }
  });

  test("unlinks a participant without clearing the session workflow id", async () => {
    const { stateManager, storeManager } = createManagers();
    const wf_unlink = await stateManager.create({ title: "wf-unlink", type: "quick_fix" });
    storeManager.create("session-product", TMP_DIR);
    await linkSessionToWorkflow(wf_unlink.id, "product", "session-product", stateManager, storeManager);

    const workflow = await unlinkSessionFromWorkflow(wf_unlink.id, "product", stateManager);

    expect(workflow.sessionIds).toEqual({});
    expect(storeManager.get("session-product", TMP_DIR)?.getState().workflowId).toBe(wf_unlink.id);
    await expect(stateManager.read(wf_unlink.id)).resolves.toMatchObject({ sessionIds: {} });
  });

  test("child sessions inherit workflow id but are not added to workflow session ids", async () => {
    const { stateManager, storeManager } = createManagers();
    const wf_child = await stateManager.create({ title: "wf-child", type: "full_feature" });
    const parent = storeManager.create("session-parent", TMP_DIR);
    await linkSessionToWorkflow(wf_child.id, "orchestrator", "session-parent", stateManager, storeManager);

    const parentState = parent.getState();
    const child = storeManager.create("session-child", TMP_DIR, {
      rootSessionId: parentState.rootSessionId,
      parentSessionId: parentState.sessionId,
      workflowId: parentState.workflowId,
      agentName: "explore",
    });

    expect(child.getState().workflowId).toBe(wf_child.id);
    await expect(stateManager.read(wf_child.id)).resolves.toMatchObject({
      sessionIds: { orchestrator: "session-parent" },
    });
  });

  test("creates workflow and registers orchestrator in one entry point", async () => {
    const { stateManager, storeManager } = createManagers();
    storeManager.create("session-create", TMP_DIR);

    const result = await createWorkflowWithOrchestrator(
      {
        title: "wf-create",
        type: "research_only",
        orchestratorSessionId: "session-create",
        artifacts: { RESEARCH: "RESEARCH.md" },
      },
      stateManager,
      storeManager,
    );

    expect(result.workflow).toMatchObject({
      type: "research_only",
      artifacts: { RESEARCH: "RESEARCH.md" },
      sessionIds: { orchestrator: "session-create" },
    });
  });

  test("creates a derived workflow with a fresh orchestrator session and handoff message", async () => {
    const { stateManager, storeManager } = createManagers();
    storeManager.create("source-session", TMP_DIR);
    const source = await createWorkflowWithOrchestrator(
      {
        title: "source-derive",
        type: "research_only",
        orchestratorSessionId: "source-session",
        artifacts: { RESEARCH: "RESEARCH.md" },
      },
      stateManager,
      storeManager,
    );

    const result = await createDerivedWorkflowWithOrchestrator(
      {
        sourceWorkflowId: source.workflow.id,
        title: "Derived from source",
        targetType: "full_feature",
        reason: "upgrade",
        triggerMessageId: "msg-upgrade",
        workspaceRoot: TMP_DIR,
      },
      stateManager,
      storeManager,
    );

    expect(result.workflow.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(result.workflow.sessionIds.orchestrator).toBeDefined();
    expect(result.workflow.sessionIds.orchestrator).not.toBe("source-session");
    expect(result.session.sessionId).toBe(result.workflow.sessionIds.orchestrator);
    expect(result.session.messages[0]).toMatchObject({ role: "user" });
    expect(JSON.stringify(result.session.messages[0])).toContain("Start derived workflow");
    expect(JSON.stringify(result.session.messages[0])).toContain("artifact_read");

    const sourceState = await stateManager.read(source.workflow.id);
    expect(sourceState.type).toBe("research_only");
    expect(sourceState.sessionIds.orchestrator).toBe("source-session");
    expect(sourceState.derivedWorkflows).toEqual([{
      workflowId: result.workflow.id,
      reason: "upgrade",
      createdAt: sourceState.derivedWorkflows[0]?.createdAt,
    }]);
    await expect(storeManager.getSessionFile(TMP_DIR, result.session.sessionId)).resolves.toMatchObject({
      workflowId: result.workflow.id,
    });
  });

  test("stable participant keys are explicit workflow role keys", () => {
    const keys = ["orchestrator", "product", "spec", "critic", "foreman"] as const satisfies readonly WorkflowParticipantKey[];
    expect(WORKFLOW_PARTICIPANT_KEYS).toEqual(keys);
  });
});

function createManagers(): { stateManager: WorkflowStateManager; storeManager: SessionStoreManager } {
  return {
    stateManager: new WorkflowStateManager(TMP_DIR),
    storeManager: new SessionStoreManager({ logger: silentLogger }),
  };
}
