import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { StoreApi } from "zustand";

import {
  TOOL_GOAL_ARTIFACT_READ,
  TOOL_GOAL_ARTIFACT_WRITE,
  type DoneCondition,
  type GoalArtifactFile,
  type GoalState,
} from "@archcode/protocol";
import { GoalStateManager } from "../../goals";
import { SkillService } from "../../skills";
import { createMockStore } from "../../store/test-helpers";
import { storeManager } from "../../store/store";
import type { SessionStoreState } from "../../store/types";
import { createRegistry, type ToolRegistry } from "../registry";
import { createTestProjectContext } from "../test-project-context";
import { createToolExecutionContext, type AnyToolDescriptor, type ToolExecutionContext } from "../types";
import { createGoalCreateTool, createGoalLockTool, createGoalRunTool } from "./goal-tools";
import { createGoalArtifactReadTool, createGoalArtifactWriteTool } from "./goal-artifacts";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "goal-artifacts-tool");
const testSkillService = new SkillService({ builtinSkills: {} });
const GOAL_ARTIFACT_TOOL_NAMES = [
  TOOL_GOAL_ARTIFACT_READ,
  TOOL_GOAL_ARTIFACT_WRITE,
  "goal_create",
  "goal_lock",
  "goal_run",
];

const DONE_CONDITION: DoneCondition = {
  id: "artifact-exists",
  kind: "file_exists",
  params: { path: "artifact.txt" },
};

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

function createGoalArtifactRegistry(): ToolRegistry {
  const descriptors: AnyToolDescriptor[] = [
    createGoalCreateTool(),
    createGoalLockTool(),
    createGoalRunTool(),
    createGoalArtifactReadTool(),
    createGoalArtifactWriteTool(),
  ];
  return createRegistry(descriptors);
}

function makeCtx(
  toolName: string,
  input: unknown,
  store: StoreApi<SessionStoreState>,
): ToolExecutionContext {
  return createToolExecutionContext({
    store,
    storeManager,
    toolName,
    toolCallId: `${toolName}-call`,
    input,
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(GOAL_ARTIFACT_TOOL_NAMES),
    agentName: store.getState().agentName,
    agentSkills: [],
    skillService: testSkillService,
    projectContext: createTestProjectContext(TMP_DIR),
  });
}

async function execute(
  registry: ToolRegistry,
  toolName: string,
  input: unknown,
  store: StoreApi<SessionStoreState>,
) {
  return registry.execute(
    { toolName, toolCallId: `${toolName}-call`, input },
    makeCtx(toolName, input, store),
  );
}

function artifactStore(
  goalId: string,
  agentName: string,
  sessionRole: SessionStoreState["sessionRole"],
): StoreApi<SessionStoreState> {
  return createMockStore({
    sessionId: `${agentName}-${sessionRole}-session`,
    agentName,
    goalId,
    sessionRole,
  });
}

async function createDraftGoal(registry: ToolRegistry): Promise<GoalState> {
  const result = await execute(
    registry,
    "goal_create",
    {
      title: "Ship Goal artifact tools",
      doneConditions: [DONE_CONDITION],
      retryPolicy: { maxRetries: 1, backoffMs: 100, escalateOnFailure: true },
      approvalPoints: ["after_plan"],
      author: "orchestrator",
    },
    createMockStore({ agentName: "orchestrator", sessionRole: "main" }),
  );
  expect(result.isError).toBe(false);
  return JSON.parse(result.output) as GoalState;
}

async function createRunningGoalInPhase(registry: ToolRegistry, phase: "build" | "review"): Promise<GoalState> {
  const draft = await createDraftGoal(registry);
  const manager = new GoalStateManager(TMP_DIR);
  await manager.lock(draft.id, "main-session");
  await manager.transitionStatus(draft.id, "running");
  return await manager.updatePhase(draft.id, phase);
}

describe("goal_artifact tools", () => {
  it("lets the Plan role write plan.md during the plan phase and read it back", async () => {
    const registry = createGoalArtifactRegistry();
    const goal = await createDraftGoal(registry);
    const store = artifactStore(goal.id, "plan", "plan");

    const write = await execute(registry, TOOL_GOAL_ARTIFACT_WRITE, {
      goalId: goal.id,
      name: "plan.md",
      content: "# Plan\n\n- Build safely",
    }, store);
    const list = await execute(registry, TOOL_GOAL_ARTIFACT_READ, { goalId: goal.id }, store);
    const read = await execute(registry, TOOL_GOAL_ARTIFACT_READ, { goalId: goal.id, name: "plan.md" }, store);

    expect(write.isError).toBe(false);
    const writeBody = JSON.parse(write.output) as { artifact: GoalArtifactFile };
    expect(writeBody.artifact).toMatchObject({ name: "plan.md", mediaType: "text/markdown" });
    expect(writeBody.artifact.path).toBe(`.archcode/goals/${goal.id}/artifacts/plan.md`);

    expect(list.isError).toBe(false);
    expect((JSON.parse(list.output) as { artifacts: GoalArtifactFile[] }).artifacts.map((artifact) => artifact.name)).toEqual(["plan.md"]);

    expect(read.isError).toBe(false);
    expect(JSON.parse(read.output)).toMatchObject({
      artifact: { name: "plan.md" },
      content: "# Plan\n\n- Build safely\n",
    });
  });

  it("denies wrong Goal session, wrong role, and post-plan plan.md writes before mutation", async () => {
    const registry = createGoalArtifactRegistry();
    const goal = await createDraftGoal(registry);
    const otherGoal = await createDraftGoal(registry);
    const input = { goalId: goal.id, name: "plan.md", content: "# Plan" };

    const wrongGoal = await execute(registry, TOOL_GOAL_ARTIFACT_WRITE, input, artifactStore(otherGoal.id, "plan", "plan"));
    const wrongRole = await execute(registry, TOOL_GOAL_ARTIFACT_WRITE, input, artifactStore(goal.id, "build", "build"));

    const manager = new GoalStateManager(TMP_DIR);
    await manager.lock(goal.id, "main-session");
    await manager.transitionStatus(goal.id, "running");
    await manager.updatePhase(goal.id, "build");
    const wrongPhase = await execute(registry, TOOL_GOAL_ARTIFACT_WRITE, input, artifactStore(goal.id, "plan", "plan"));

    expect(wrongGoal.isError).toBe(true);
    expect(wrongGoal.output).toContain("GOAL_ARTIFACT_WRONG_SESSION");
    expect(wrongRole.isError).toBe(true);
    expect(wrongRole.output).toContain("GOAL_ARTIFACT_ROLE_DENIED");
    expect(wrongPhase.isError).toBe(true);
    expect(wrongPhase.output).toContain("GOAL_ARTIFACT_PHASE_DENIED");
    expect(await createTestProjectContext(TMP_DIR).goalArtifacts.listArtifacts(goal.id)).toEqual([]);
  });

  it("lets Build write only build.md during build phase", async () => {
    const registry = createGoalArtifactRegistry();
    const goal = await createRunningGoalInPhase(registry, "build");
    const store = artifactStore(goal.id, "build", "build");

    const allowed = await execute(registry, TOOL_GOAL_ARTIFACT_WRITE, {
      goalId: goal.id,
      name: "build.md",
      content: "# Build\n\nImplemented focused changes.",
    }, store);
    const denied = await execute(registry, TOOL_GOAL_ARTIFACT_WRITE, {
      goalId: goal.id,
      name: "review.md",
      content: "# Review",
    }, store);

    expect(allowed.isError).toBe(false);
    expect(denied.isError).toBe(true);
    expect(denied.output).toContain("GOAL_ARTIFACT_PHASE_DENIED");
  });

  it("lets the configured Reviewer write review and spec-compliance artifacts during review", async () => {
    const registry = createGoalArtifactRegistry();
    const goal = await createRunningGoalInPhase(registry, "review");
    const manager = new GoalStateManager(TMP_DIR);
    await manager.transitionStatus(goal.id, "verifying");
    const store = artifactStore(goal.id, "reviewer", "review");

    const review = await execute(registry, TOOL_GOAL_ARTIFACT_WRITE, {
      goalId: goal.id,
      name: "review.md",
      content: "# Review\n\nDONE evidence summary.",
    }, store);
    const spec = await execute(registry, TOOL_GOAL_ARTIFACT_WRITE, {
      goalId: goal.id,
      name: "spec-compliance.md",
      content: "# Spec Compliance\n\nAC-001 satisfied.",
    }, store);
    const build = await execute(registry, TOOL_GOAL_ARTIFACT_WRITE, {
      goalId: goal.id,
      name: "build.md",
      content: "# Build",
    }, store);

    expect(review.isError).toBe(false);
    expect(spec.isError).toBe(false);
    expect(build.isError).toBe(true);
    expect(build.output).toContain("GOAL_ARTIFACT_PHASE_DENIED");
  });

  it("rejects noncanonical names through strict schema and secret-bearing content through the manager", async () => {
    const registry = createGoalArtifactRegistry();
    const goal = await createDraftGoal(registry);
    const store = artifactStore(goal.id, "plan", "plan");

    const invalidName = await execute(registry, TOOL_GOAL_ARTIFACT_WRITE, {
      goalId: goal.id,
      name: "../plan.md",
      content: "# Plan",
    }, store);
    const secret = await execute(registry, TOOL_GOAL_ARTIFACT_WRITE, {
      goalId: goal.id,
      name: "plan.md",
      content: "token=sk-test-secret",
    }, store);

    expect(invalidName.isError).toBe(true);
    expect(invalidName.output).toContain("TOOL_SCHEMA_INVALID_INPUT");
    expect(secret.isError).toBe(true);
    expect(secret.output).toContain("GOAL_ARTIFACT_SECRET_DETECTED");
    expect(await createTestProjectContext(TMP_DIR).goalArtifacts.listArtifacts(goal.id)).toEqual([]);
  });
});
