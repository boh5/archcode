import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { StoreApi } from "zustand";

import {
  TOOL_GOAL_CREATE,
  TOOL_GOAL_LOCK,
  TOOL_GOAL_RETRY,
  TOOL_GOAL_RUN,
  type DoneCondition,
} from "@archcode/protocol";
import { GoalStateManager } from "../../goals";
import { createTestProjectContext } from "../test-project-context";
import { inferToolErrorKindFromResult } from "../errors";
import { createRegistry, type ToolRegistry } from "../registry";
import { createMockStore } from "../../store/test-helpers";
import { storeManager } from "../../store/store";
import { SkillService } from "../../skills";
import { createToolExecutionContext, type AnyToolDescriptor, type ToolExecutionContext } from "../types";
import type { SessionStoreState } from "../../store/types";
import {
  createGoalCreateTool,
  createGoalLockTool,
  createGoalRetryTool,
  createGoalRunTool,
} from "./goal-tools";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "goal-tools");
const testSkillService = new SkillService({ builtinSkills: {} });
const GOAL_TOOL_NAMES = [TOOL_GOAL_CREATE, TOOL_GOAL_LOCK, TOOL_GOAL_RUN, TOOL_GOAL_RETRY];

const DONE_CONDITION: DoneCondition = {
  id: "tests",
  kind: "tests_pass",
  params: { command: "bun test packages/agent-core/src/tools/builtins/goal-tools.test.ts" },
};

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

function createGoalRegistry(): ToolRegistry {
  const descriptors: AnyToolDescriptor[] = [
    createGoalCreateTool(),
    createGoalLockTool(),
    createGoalRunTool(),
    createGoalRetryTool(),
  ];
  return createRegistry(descriptors);
}

function makeCtx(
  toolName: string,
  input: unknown,
  store: StoreApi<SessionStoreState> = createMockStore({ sessionId: "goal-session" }),
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
    allowedTools: new Set(GOAL_TOOL_NAMES),
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
  store?: StoreApi<SessionStoreState>,
) {
  return registry.execute(
    { toolName, toolCallId: `${toolName}-call`, input },
    makeCtx(toolName, input, store),
  );
}

function validCreateInput(overrides: Record<string, unknown> = {}) {
  return {
    title: "Ship goal tools",
    doneConditions: [DONE_CONDITION],
    retryPolicy: { maxRetries: 3, backoffMs: 1000, escalateOnFailure: true },
    approvalPoints: ["after_plan"],
    author: "orchestrator",
    ...overrides,
  };
}

async function createDraftGoal(registry: ToolRegistry) {
  const result = await execute(registry, TOOL_GOAL_CREATE, validCreateInput());
  expect(result.isError).toBe(false);
  return JSON.parse(result.output) as { id: string; status: string; phase: string };
}

async function createLockedGoal(registry: ToolRegistry, store = createMockStore({ sessionId: "locker-session" })) {
  const draft = await createDraftGoal(registry);
  const locked = await execute(registry, TOOL_GOAL_LOCK, { goalId: draft.id }, store);
  expect(locked.isError).toBe(false);
  return JSON.parse(locked.output) as { id: string; status: string; phase: string; lockedBy?: string };
}

describe("goal builtin tools", () => {
  it("goal_create creates a draft goal through GoalStateManager", async () => {
    const registry = createGoalRegistry();

    const result = await execute(registry, TOOL_GOAL_CREATE, validCreateInput());

    expect(result.isError).toBe(false);
    const goal = JSON.parse(result.output);
    expect(goal).toMatchObject({
      projectId: "test-project",
      title: "Ship goal tools",
      status: "draft",
      phase: "plan",
      author: "orchestrator",
      retryCount: 0,
      retryPolicy: { maxRetries: 3, backoffMs: 1000, escalateOnFailure: true },
      approvalPoints: ["after_plan"],
    });
    expect(goal.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(goal.doneConditions).toHaveLength(1);

    const persisted = await new GoalStateManager(TMP_DIR).read(goal.id);
    expect(persisted.status).toBe("draft");
  });

  it("goal_create rejects caller-provided ids via strict schema", async () => {
    const registry = createGoalRegistry();

    const result = await execute(registry, TOOL_GOAL_CREATE, validCreateInput({ id: crypto.randomUUID() }));

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("schema");
  });

  it("goal_lock locks a draft goal and records the session id as lockedBy", async () => {
    const registry = createGoalRegistry();
    const draft = await createDraftGoal(registry);
    const store = createMockStore({ sessionId: "session-locker" });

    const result = await execute(registry, TOOL_GOAL_LOCK, { goalId: draft.id }, store);

    expect(result.isError).toBe(false);
    const goal = JSON.parse(result.output);
    expect(goal).toMatchObject({ id: draft.id, status: "locked", lockedBy: "session-locker" });
    expect(goal.lockedAt).toBeString();
  });

  it("goal_lock returns GOAL_INVALID_TRANSITION for an already locked goal", async () => {
    const registry = createGoalRegistry();
    const locked = await createLockedGoal(registry);

    const result = await execute(registry, TOOL_GOAL_LOCK, { goalId: locked.id });

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("workspace");
    expect(result.output).toContain("GOAL_INVALID_TRANSITION");
  });

  it("goal_run transitions a locked goal to running and records mainSessionId", async () => {
    const registry = createGoalRegistry();
    const store = createMockStore({ sessionId: "main-session" });
    const locked = await createLockedGoal(registry, store);

    const result = await execute(registry, TOOL_GOAL_RUN, { goalId: locked.id }, store);

    expect(result.isError).toBe(false);
    const goal = JSON.parse(result.output);
    expect(goal).toMatchObject({ id: locked.id, status: "running", mainSessionId: "main-session" });
  });

  it("goal_run returns GOAL_INVALID_TRANSITION when called from draft", async () => {
    const registry = createGoalRegistry();
    const draft = await createDraftGoal(registry);

    const result = await execute(registry, TOOL_GOAL_RUN, { goalId: draft.id });

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("workspace");
    expect(result.output).toContain("GOAL_INVALID_TRANSITION");
  });

  it("goal_retry increments retry count, resets phase to plan, and transitions to running", async () => {
    const registry = createGoalRegistry();
    const locked = await createLockedGoal(registry);
    const manager = new GoalStateManager(TMP_DIR);
    await manager.transitionStatus(locked.id, "running");
    await manager.updatePhase(locked.id, "review");
    await manager.transitionStatus(locked.id, "failed");

    const result = await execute(registry, TOOL_GOAL_RETRY, { goalId: locked.id });

    expect(result.isError).toBe(false);
    const goal = JSON.parse(result.output);
    expect(goal).toMatchObject({ id: locked.id, status: "running", phase: "plan", retryCount: 1 });
  });

  it("goal_retry returns GOAL_INVALID_TRANSITION when retrying a draft goal", async () => {
    const registry = createGoalRegistry();
    const draft = await createDraftGoal(registry);

    const result = await execute(registry, TOOL_GOAL_RETRY, { goalId: draft.id });

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("workspace");
    expect(result.output).toContain("GOAL_INVALID_TRANSITION");
  });

  it("returns GOAL_NOT_FOUND for missing goals", async () => {
    const registry = createGoalRegistry();
    const missingGoalId = crypto.randomUUID();

    const result = await execute(registry, TOOL_GOAL_LOCK, { goalId: missingGoalId });

    expect(result.isError).toBe(true);
    expect(inferToolErrorKindFromResult(result)).toBe("workspace");
    expect(result.output).toContain("GOAL_NOT_FOUND");
  });
});
