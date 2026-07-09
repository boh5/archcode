import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { GoalState } from "@archcode/protocol";

import { GoalStateManager } from "../goals/state";
import { silentLogger } from "../logger";
import { LoopStateManager } from "../loops/state";
import { SessionStoreManager } from "../store/session-store-manager";
import { HitlService } from "./service";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "aggregation");

describe("HITL aggregation", () => {
  beforeEach(async () => {
    await rm(TMP_ROOT, { recursive: true, force: true });
    await mkdir(TMP_ROOT, { recursive: true });
  });

  afterAll(async () => {
    await rm(TMP_ROOT, { recursive: true, force: true });
  });

  test("loop scope includeChildren returns loop, child goal, and descendant session HITL without project queue", async () => {
    const workspaceRoot = await mkdtemp(join(TMP_ROOT, "workspace-"));
    const sessions = new SessionStoreManager({ logger: silentLogger });
    const goalState = new GoalStateManager(workspaceRoot, silentLogger);
    const loopState = new LoopStateManager(workspaceRoot, silentLogger);
    const service = new HitlService({
      workspaceRoot,
      project: { slug: "archcode", name: "ArchCode" },
      sessions,
      goalState,
      loopState,
    });
    await service.load(workspaceRoot);

    const loop = await loopState.create("archcode", {
      templateId: "goal_runner",
      title: "Watch CI",
      schedule: { kind: "manual" },
      approvalPolicy: "interactive",
      limits: { maxIterationsPerRun: 1 },
    });
    const goal = await createGoalOwnedByLoop(goalState, loop.loopId);
    const rootSessionId = crypto.randomUUID();
    const childSessionId = crypto.randomUUID();
    sessions.create(rootSessionId, workspaceRoot, { loopId: loop.loopId });
    sessions.create(childSessionId, workspaceRoot, {
      rootSessionId,
      parentSessionId: rootSessionId,
      goalId: goal.id,
    });
    await waitForSession(workspaceRoot, rootSessionId);
    await waitForSession(workspaceRoot, childSessionId);

    const loopHitl = await service.create({
      owner: { projectSlug: "archcode", ownerType: "loop", ownerId: loop.loopId },
      blockingKey: `loop:${loop.loopId}:approval:manual`,
      source: { type: "loop_approval", loopId: loop.loopId, approvalPoint: "manual" },
      displayPayload: { title: "Approve loop", redacted: true },
    });
    const goalHitl = await service.create({
      owner: { projectSlug: "archcode", ownerType: "goal", ownerId: goal.id },
      blockingKey: `goal:${goal.id}:approval:after_plan`,
      source: { type: "goal_approval", goalId: goal.id, approvalPoint: "after_plan" },
      displayPayload: { title: "Approve goal", redacted: true },
    });
    const sessionHitl = await service.create({
      owner: { projectSlug: "archcode", ownerType: "session", ownerId: childSessionId },
      blockingKey: `session:${childSessionId}:ask:tool`,
      source: { type: "ask_user", sessionId: childSessionId, toolCallId: "tool" },
      displayPayload: { title: "Answer child session", redacted: true },
    });

    const projections = await service.list({ scope: "loop", ownerId: loop.loopId, includeChildren: true });
    expect(projections.map((projection) => projection.hitlId).sort()).toEqual([goalHitl.hitlId, loopHitl.hitlId, sessionHitl.hitlId].sort());
    expect(new Set(projections.map((projection) => projection.hitlId)).size).toBe(projections.length);
    expect(projections.find((projection) => projection.hitlId === sessionHitl.hitlId)?.ancestry?.projectionPath).toEqual([
      "loop",
      loop.loopId,
      "goal",
      goal.id,
      "session",
      childSessionId,
    ]);
    expect(projections.find((projection) => projection.hitlId === sessionHitl.hitlId)?.ancestry).toMatchObject({
      goalId: goal.id,
      rootSessionId,
      parentSessionId: rootSessionId,
    });
    expect(await Bun.file(join(workspaceRoot, ".archcode", "hitl-queue.json")).exists()).toBe(false);
  });

  test("loop scope without includeChildren excludes sessions owned only by loop child goals", async () => {
    const workspaceRoot = await mkdtemp(join(TMP_ROOT, "workspace-"));
    const sessions = new SessionStoreManager({ logger: silentLogger });
    const goalState = new GoalStateManager(workspaceRoot, silentLogger);
    const loopState = new LoopStateManager(workspaceRoot, silentLogger);
    const service = new HitlService({
      workspaceRoot,
      project: { slug: "archcode", name: "ArchCode" },
      sessions,
      goalState,
      loopState,
    });
    await service.load(workspaceRoot);

    const loop = await loopState.create("archcode", {
      templateId: "goal_runner",
      title: "Watch CI",
      schedule: { kind: "manual" },
      approvalPolicy: "interactive",
      limits: { maxIterationsPerRun: 1 },
    });
    const goal = await createGoalOwnedByLoop(goalState, loop.loopId);
    const directLoopSessionId = crypto.randomUUID();
    const goalSessionId = crypto.randomUUID();
    sessions.create(directLoopSessionId, workspaceRoot, { loopId: loop.loopId });
    sessions.create(goalSessionId, workspaceRoot, { goalId: goal.id });
    await waitForSession(workspaceRoot, directLoopSessionId);
    await waitForSession(workspaceRoot, goalSessionId);

    const directLoopSessionHitl = await service.create({
      owner: { projectSlug: "archcode", ownerType: "session", ownerId: directLoopSessionId },
      blockingKey: `session:${directLoopSessionId}:ask:tool`,
      source: { type: "ask_user", sessionId: directLoopSessionId, toolCallId: "tool" },
      displayPayload: { title: "Answer loop session", redacted: true },
    });
    const goalSessionHitl = await service.create({
      owner: { projectSlug: "archcode", ownerType: "session", ownerId: goalSessionId },
      blockingKey: `session:${goalSessionId}:ask:tool`,
      source: { type: "ask_user", sessionId: goalSessionId, toolCallId: "tool" },
      displayPayload: { title: "Answer goal session", redacted: true },
    });

    const projections = await service.list({ scope: "loop", ownerId: loop.loopId });
    expect(projections.map((projection) => projection.hitlId)).toContain(directLoopSessionHitl.hitlId);
    expect(projections.map((projection) => projection.hitlId)).not.toContain(goalSessionHitl.hitlId);
  });
});

async function createGoalOwnedByLoop(goalState: GoalStateManager, loopId: string): Promise<GoalState> {
  const goal = await goalState.create({
    projectId: "archcode",
    objective: "Run the loop child goal.",
    acceptanceCriteria: "Reviewer can decide from loop run evidence.",
  });
  const filePath = await goalState.resolveContainedPathForTest(join(goal.id, "goal.json"));
  const updated: GoalState = { ...goal, loopId, updatedAt: new Date().toISOString() };
  await Bun.write(filePath, `${JSON.stringify(updated, null, 2)}\n`);
  return updated;
}

async function waitForSession(workspaceRoot: string, sessionId: string): Promise<void> {
  const path = join(workspaceRoot, ".archcode", "sessions", sessionId, "session.json");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await Bun.file(path).exists()) return;
    await Bun.sleep(5);
  }
  throw new Error(`session was not persisted: ${sessionId}`);
}
