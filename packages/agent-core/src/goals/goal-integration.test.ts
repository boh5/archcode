import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { PROJECT_STATE_DIR_NAME, type GoalState } from "@archcode/protocol";

import { silentLogger } from "../logger";
import { SessionStoreManager } from "../store/session-store-manager";
import { GoalRunner } from "./runner";
import { GoalStateManager } from "./state";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "goal-integration");
const SOURCE_SESSION_ID = "11111111-1111-4111-8111-111111111111";

let workspaceRoot = "";
let manager: GoalStateManager;
let sessions: SessionStoreManager;

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
  workspaceRoot = await mkdtemp(join(TMP_ROOT, "workspace-"));
  manager = new GoalStateManager(workspaceRoot);
  sessions = new SessionStoreManager({ logger: silentLogger });
  await sessions.createSessionFile(workspaceRoot, { agentName: "engineer" }, SOURCE_SESSION_ID);
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

function createRunner(): GoalRunner {
  return new GoalRunner({
    goalStateManager: manager,
    workspaceRoot,
    readSourceSession: (root, id) => sessions.getSessionFile(root, id),
    ensureSessionFile: (root, id, options) => sessions.ensureSessionFile(root, id, options),
    startCheckedExecutionWithinGoalClaim: mock(async () => ({}) as never),
  });
}

function reviewerAuth(goalId: string, sessionId = "review-session") {
  return { agentName: "reviewer", sessionRole: "review", sessionGoalId: goalId, reviewerSessionId: sessionId };
}

async function readGoalFile(goalId: string): Promise<GoalState> {
  return JSON.parse(await Bun.file(join(workspaceRoot, PROJECT_STATE_DIR_NAME, "goals", goalId, "goal.json")).text()) as GoalState;
}

describe("Goal core integration", () => {
  test("persists committed creation through DONE without auxiliary artifacts", async () => {
    const runner = createRunner();
    const goal = await runner.create({
      projectId: "project-a",
      createdFromSessionId: SOURCE_SESSION_ID,
      objective: "Persist a protocol-shaped committed Goal through review.",
      acceptanceCriteria: "Final state contains reviewer receipt and no auxiliary artifact files.",
    });
    await runner.addChildSession(goal.id, "plan-child-session");
    const reviewing = await runner.beginReview(goal.id);
    const done = await runner.finalizeReview(goal.id, {
      expectedReviewGeneration: reviewing.reviewGeneration,
      verdict: "DONE",
      summary: "Reviewer verified the durable state and tests.",
      evidenceRefs: [{ kind: "session", ref: goal.mainSessionId, summary: "Main Session completed implementation." }],
      authorization: reviewerAuth(goal.id),
    });

    expect(await readGoalFile(goal.id)).toEqual(done);
    expect(done).toMatchObject({ status: "done", createdFromSessionId: SOURCE_SESSION_ID });
    expect(existsSync(join(workspaceRoot, PROJECT_STATE_DIR_NAME, "goals", done.id, `arti${"facts"}`))).toBe(false);
  });

  test("persists NOT_DONE retry without replacing Goal or main Session identity", async () => {
    const runner = createRunner();
    const goal = await runner.create({
      projectId: "project-a",
      createdFromSessionId: SOURCE_SESSION_ID,
      objective: "Capture explicit retry semantics.",
      acceptanceCriteria: "Retry increments attempt and keeps stable ownership.",
    });
    await runner.beginReview(goal.id);
    await runner.finalizeReview(goal.id, {
      expectedReviewGeneration: 1,
      verdict: "NOT_DONE",
      summary: "Regression evidence is missing.",
      authorization: reviewerAuth(goal.id),
    });
    const retry = await runner.retry(goal.id);

    expect(retry).toMatchObject({ id: goal.id, status: "running", attempt: 2, mainSessionId: goal.mainSessionId });
    expect(retry.review).toBeUndefined();
  });
});
