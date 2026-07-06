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
import { GoalArtifactManager } from "../../goals/artifacts";
import { GoalMemoryManager } from "../../goals/goal-memory";
import { GoalStateManager } from "../../goals/state";
import { HitlService } from "../../hitl/service";
import { silentLogger } from "../../logger";
import { LoopStateManager } from "../../loops/state";
import { MemoryFileManager } from "../../memory/file-manager";
import type { ProjectContext } from "../../projects/types";
import { createMockStore } from "../../store/test-helpers";
import { storeManager } from "../../store/store";
import type { SessionStoreState } from "../../store/types";
import { createToolErrorResult } from "../errors";
import { ProjectApprovalManager } from "../permission/project-approvals";
import type { AnyToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../types";
import { createToolExecutionContext } from "../types";
import { createGoalArtifactReadTool, createGoalArtifactWriteTool } from "./goal-artifacts";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "goal-artifacts-tool");
const GOAL_ARTIFACT_TOOL_NAMES = [
  TOOL_GOAL_ARTIFACT_READ,
  TOOL_GOAL_ARTIFACT_WRITE,
];

const DONE_CONDITION: DoneCondition = {
  id: "artifact-exists",
  kind: "file_exists",
  params: { path: "artifact.txt" },
};

function createArtifactProjectContext(): ProjectContext {
  return {
    project: {
      slug: "test-project",
      name: "Test Project",
      workspaceRoot: TMP_DIR,
      addedAt: new Date().toISOString(),
    },
    goalState: new GoalStateManager(TMP_DIR),
    goalArtifacts: new GoalArtifactManager(TMP_DIR),
    goalMemory: new GoalMemoryManager(TMP_DIR),
    loopState: new LoopStateManager(TMP_DIR),
    hitl: new HitlService(),
    memory: new MemoryFileManager({
      project: join(TMP_DIR, ".archcode", "memory"),
      user: join(TMP_DIR, ".archcode", "user-memory"),
    }),
    approvals: new ProjectApprovalManager(silentLogger),
  };
}

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

function createGoalArtifactDescriptor(toolName: string): AnyToolDescriptor {
  if (toolName === TOOL_GOAL_ARTIFACT_READ) return createGoalArtifactReadTool();
  if (toolName === TOOL_GOAL_ARTIFACT_WRITE) return createGoalArtifactWriteTool();
  throw new Error(`Unknown Goal artifact tool in test: ${toolName}`);
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
    projectContext: createArtifactProjectContext(),
  });
}

async function execute(
  toolName: string,
  input: unknown,
  store: StoreApi<SessionStoreState>,
): Promise<ToolExecutionResult> {
  const descriptor = createGoalArtifactDescriptor(toolName);
  const parsed = descriptor.inputSchema.safeParse(input);
  if (!parsed.success) {
    return createToolErrorResult({
      kind: "schema",
      zodError: parsed.error,
      expectedInput: `Tool "${descriptor.name}" input must match its registered Zod schema.`,
    });
  }

  const output = await descriptor.execute(parsed.data, makeCtx(toolName, parsed.data, store));
  if (typeof output === "string") return { output, isError: false };
  return output;
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

async function createDraftGoal(): Promise<GoalState> {
  return await new GoalStateManager(TMP_DIR).create(
    "test-project",
    "Ship Goal artifact tools",
    "orchestrator",
    [DONE_CONDITION],
    { maxRetries: 1, backoffMs: 100, escalateOnFailure: true },
    ["after_plan"],
  );
}

async function createRunningGoalInPhase(phase: "build" | "review"): Promise<GoalState> {
  const draft = await createDraftGoal();
  const manager = new GoalStateManager(TMP_DIR);
  await manager.lock(draft.id, "main-session");
  await manager.transitionStatus(draft.id, "running");
  return await manager.updatePhase(draft.id, phase);
}

describe("goal_artifact tools", () => {
  it("keeps artifact read and write as separate tools with split descriptor traits", () => {
    const read = createGoalArtifactReadTool();
    const write = createGoalArtifactWriteTool();

    expect(read.name).toBe(TOOL_GOAL_ARTIFACT_READ);
    expect(write.name).toBe(TOOL_GOAL_ARTIFACT_WRITE);
    expect(read.name).not.toBe(write.name);
    expect(read.traits).toEqual({ readOnly: true, destructive: false, concurrencySafe: true });
    expect(write.traits).toEqual({ readOnly: false, destructive: false, concurrencySafe: false });
  });

  it("lets the Plan role write plan.md during the plan phase and read it back", async () => {
    const goal = await createDraftGoal();
    const store = artifactStore(goal.id, "plan", "plan");

    const write = await execute(TOOL_GOAL_ARTIFACT_WRITE, {
      goalId: goal.id,
      name: "plan.md",
      content: "# Plan\n\n- Build safely",
    }, store);
    const list = await execute(TOOL_GOAL_ARTIFACT_READ, { goalId: goal.id }, store);
    const read = await execute(TOOL_GOAL_ARTIFACT_READ, { goalId: goal.id, name: "plan.md" }, store);

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
    const goal = await createDraftGoal();
    const otherGoal = await createDraftGoal();
    const input = { goalId: goal.id, name: "plan.md", content: "# Plan" };

    const wrongGoal = await execute(TOOL_GOAL_ARTIFACT_WRITE, input, artifactStore(otherGoal.id, "plan", "plan"));
    const wrongRole = await execute(TOOL_GOAL_ARTIFACT_WRITE, input, artifactStore(goal.id, "build", "build"));

    const manager = new GoalStateManager(TMP_DIR);
    await manager.lock(goal.id, "main-session");
    await manager.transitionStatus(goal.id, "running");
    await manager.updatePhase(goal.id, "build");
    const wrongPhase = await execute(TOOL_GOAL_ARTIFACT_WRITE, input, artifactStore(goal.id, "plan", "plan"));

    expect(wrongGoal.isError).toBe(true);
    expect(wrongGoal.output).toContain("GOAL_ARTIFACT_WRONG_SESSION");
    expect(wrongRole.isError).toBe(true);
    expect(wrongRole.output).toContain("GOAL_ARTIFACT_ROLE_DENIED");
    expect(wrongPhase.isError).toBe(true);
    expect(wrongPhase.output).toContain("GOAL_ARTIFACT_PHASE_DENIED");
    expect(await new GoalArtifactManager(TMP_DIR).listArtifacts(goal.id)).toEqual([]);
  });

  it("lets Build write only build.md during build phase", async () => {
    const goal = await createRunningGoalInPhase("build");
    const store = artifactStore(goal.id, "build", "build");

    const allowed = await execute(TOOL_GOAL_ARTIFACT_WRITE, {
      goalId: goal.id,
      name: "build.md",
      content: "# Build\n\nImplemented focused changes.",
    }, store);
    const denied = await execute(TOOL_GOAL_ARTIFACT_WRITE, {
      goalId: goal.id,
      name: "review.md",
      content: "# Review",
    }, store);

    expect(allowed.isError).toBe(false);
    expect(denied.isError).toBe(true);
    expect(denied.output).toContain("GOAL_ARTIFACT_PHASE_DENIED");
  });

  it("lets the configured Reviewer write review and spec-compliance artifacts during review", async () => {
    const goal = await createRunningGoalInPhase("review");
    const manager = new GoalStateManager(TMP_DIR);
    await manager.transitionStatus(goal.id, "verifying");
    const store = artifactStore(goal.id, "reviewer", "review");

    const review = await execute(TOOL_GOAL_ARTIFACT_WRITE, {
      goalId: goal.id,
      name: "review.md",
      content: "# Review\n\nDONE evidence summary.",
    }, store);
    const spec = await execute(TOOL_GOAL_ARTIFACT_WRITE, {
      goalId: goal.id,
      name: "spec-compliance.md",
      content: "# Spec Compliance\n\nAC-001 satisfied.",
    }, store);
    const build = await execute(TOOL_GOAL_ARTIFACT_WRITE, {
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
    const goal = await createDraftGoal();
    const store = artifactStore(goal.id, "plan", "plan");

    const invalidName = await execute(TOOL_GOAL_ARTIFACT_WRITE, {
      goalId: goal.id,
      name: "../plan.md",
      content: "# Plan",
    }, store);
    const secret = await execute(TOOL_GOAL_ARTIFACT_WRITE, {
      goalId: goal.id,
      name: "plan.md",
      content: "token=sk-test-secret",
    }, store);

    expect(invalidName.isError).toBe(true);
    expect(invalidName.output).toContain("TOOL_SCHEMA_INVALID_INPUT");
    expect(secret.isError).toBe(true);
    expect(secret.output).toContain("GOAL_ARTIFACT_SECRET_DETECTED");
    expect(await new GoalArtifactManager(TMP_DIR).listArtifacts(goal.id)).toEqual([]);
  });
});
