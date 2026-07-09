import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  TOOL_BASH,
  TOOL_DELEGATE,
  TOOL_GOAL_MANAGE,
} from "@archcode/protocol";

import type { ProjectContext } from "../../projects/types";
import { createMockStore } from "../../store/test-helpers";
import { storeManager } from "../../store/store";
import type { SessionStoreState } from "../../store/types";
import { createTestProjectContext } from "../test-project-context";
import { createToolExecutionContext, type ToolExecutionContext } from "../types";
import { createGoalBootstrapPermission } from "./goal-bootstrap";

const mainSessionId = "main-session";
const TMP_DIR = join(import.meta.dir, "__test_tmp__", "goal-bootstrap");

async function createReviewingGoal(mainSession = mainSessionId): Promise<{
  readonly projectContext: ProjectContext;
  readonly goalId: string;
}> {
  const workspaceRoot = join(TMP_DIR, crypto.randomUUID());
  await mkdir(workspaceRoot, { recursive: true });
  const projectContext = createTestProjectContext(workspaceRoot);
  const goal = await projectContext.goalState.create({
    projectId: projectContext.project.slug,
    title: "Review delegation",
    objective: "Allow reviewer delegation after begin_review.",
    acceptanceCriteria: "Reviewer can finalize the Goal.",
  });
  await projectContext.goalState.start(goal.id, { mainSessionId: mainSession });
  const reviewing = await projectContext.goalState.beginReview(goal.id);
  return { projectContext, goalId: reviewing.id };
}

function makeCtx(input: unknown, options: {
  readonly projectContext: ProjectContext;
  readonly goalId: string;
  readonly toolName?: string;
  readonly storeOverrides?: Partial<SessionStoreState>;
}): ToolExecutionContext {
  const toolName = options.toolName ?? TOOL_DELEGATE;
  const store = createMockStore({
    sessionId: mainSessionId,
    agentName: "orchestrator",
    sessionRole: "main",
    goalId: options.goalId,
    ...options.storeOverrides,
  });
  return createToolExecutionContext({
    store,
    storeManager,
    toolName,
    toolCallId: `${toolName}-call`,
    input,
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set([toolName]),
    agentName: store.getState().agentName,
    agentSkills: [],
    projectContext: options.projectContext,
  });
}

describe("createGoalBootstrapPermission", () => {
  beforeEach(async () => {
    await rm(TMP_DIR, { recursive: true, force: true });
    await mkdir(TMP_DIR, { recursive: true });
  });

  afterAll(async () => {
    await rm(TMP_DIR, { recursive: true, force: true });
  });

  test("allows the claimed main session to delegate Reviewer while the Goal is reviewing", async () => {
    const permission = createGoalBootstrapPermission();
    const { projectContext, goalId } = await createReviewingGoal();
    const input = { agent_type: "reviewer", task: "Review the Goal", skills: [] };

    const decision = await permission(input, makeCtx(input, { projectContext, goalId }));

    expect(decision).toEqual({ outcome: "allow" });
  });

  test("does not broadly allow non-Reviewer delegation while the Goal is reviewing", async () => {
    const permission = createGoalBootstrapPermission();
    const { projectContext, goalId } = await createReviewingGoal();
    const input = { agent_type: "build", task: "Keep working", skills: [] };

    const decision = await permission(input, makeCtx(input, { projectContext, goalId }));

    expect(decision.outcome).toBe("deny");
    expect(decision.errorCode).toBe("GOAL_BOOTSTRAP_TOOL_DENIED");
  });

  test("requires the reviewing Goal to be claimed by the current main session", async () => {
    const permission = createGoalBootstrapPermission();
    const { projectContext, goalId } = await createReviewingGoal("different-main-session");
    const input = { agent_type: "reviewer", task: "Review the Goal", skills: [] };

    const decision = await permission(input, makeCtx(input, { projectContext, goalId }));

    expect(decision.outcome).toBe("deny");
    expect(decision.errorCode).toBe("GOAL_BOOTSTRAP_TOOL_DENIED");
  });

  test("allows block reporting while the claimed main session is waiting for review", async () => {
    const permission = createGoalBootstrapPermission();
    const { projectContext, goalId } = await createReviewingGoal();
    const input = {
      action: "block",
      goalId,
      kind: "tool_error",
      summary: "Reviewer delegation failed.",
    };

    const decision = await permission(input, makeCtx(input, { projectContext, goalId, toolName: TOOL_GOAL_MANAGE }));

    expect(decision).toEqual({ outcome: "allow" });
  });

  test("still denies unrelated unsafe tools while the Goal is reviewing", async () => {
    const permission = createGoalBootstrapPermission();
    const { projectContext, goalId } = await createReviewingGoal();
    const input = { command: "echo unsafe" };

    const decision = await permission(input, makeCtx(input, { projectContext, goalId, toolName: TOOL_BASH }));

    expect(decision.outcome).toBe("deny");
    expect(decision.errorCode).toBe("GOAL_BOOTSTRAP_TOOL_DENIED");
  });
});
