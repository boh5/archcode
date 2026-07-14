import { describe, expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StoreApi } from "zustand";

import type { GoalReviewReceipt, GoalState } from "@archcode/protocol";
import { createPreparedHitlResume, ResumeCoordinator } from "../../hitl/resume-coordinator";
import { HitlService } from "../../hitl/service";
import { silentLogger } from "../../logger";
import { MemoryFileManager } from "../../memory/file-manager";
import type { ProjectContext } from "../../projects/types";
import { SkillService } from "../../skills";
import { createMockStore } from "../../store/test-helpers";
import { storeManager } from "../../store/store";
import type { SessionStoreState } from "../../store/types";
import { createTestTempRoot } from "../../testing/test-temp-root";
import { WorktreeService } from "../../worktrees";
import { ProjectApprovalManager } from "../permission/project-approvals";
import { createToolExecutionContext, type ToolExecutionContext, type ToolExecutionResult } from "../types";
import { goalManageTool } from "./goal-tools";

const testSkillService = new SkillService({ builtinSkills: {} });

class GoalStateManagerMock {
  readonly calls: string[] = [];

  constructor(private readonly goal: GoalState) {}

  async read(): Promise<GoalState> {
    return this.goal;
  }

  async beginReview(): Promise<GoalState> {
    this.calls.push("beginReview");
    return { ...this.goal, status: "reviewing", reviewGeneration: this.goal.reviewGeneration + 1 };
  }

  async finalizeReview(
    _goalId: string,
    input: {
      readonly expectedReviewGeneration: number;
      readonly verdict: "DONE" | "NOT_DONE";
      readonly summary: string;
      readonly evidenceRefs?: readonly GoalReviewReceipt["evidenceRefs"][number][];
      readonly authorization: { readonly reviewerSessionId?: string };
    },
  ): Promise<GoalState> {
    this.calls.push("finalizeReview");
    return {
      ...this.goal,
      status: input.verdict === "DONE" ? "done" : "not_done",
      review: {
        reviewGeneration: input.expectedReviewGeneration,
        verdict: input.verdict,
        summary: input.summary,
        evidenceRefs: [...(input.evidenceRefs ?? [])],
        reviewerSessionId: input.authorization.reviewerSessionId ?? "review-session",
        decidedAt: "2026-07-08T00:00:00.000Z",
      },
    };
  }
}

function makeGoalState(goalId: string, worktree: GoalState["worktree"]): GoalState {
  return {
    id: goalId,
    projectId: "test-project",
    createdFromSessionId: "engineer-session",
    title: null,
    objective: "Validate a persisted Goal worktree claim.",
    acceptanceCriteria: "Lifecycle actions reject a changed branch or lineage.",
    status: "running",
    attempt: 1,
    reviewGeneration: 0,
    mainSessionId: "main-session",
    pendingHitlIds: [],
    approvalRefs: [],
    appliedHitlIds: [],
    childSessionIds: [],
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
    startedAt: "2026-07-08T00:00:00.000Z",
    version: 4,
    useWorktree: true,
    worktree,
  };
}

function makeStore(
  goalId: string,
  agentName: "goal_lead" | "reviewer",
  sessionRole: "main" | "review",
): StoreApi<SessionStoreState> {
  return createMockStore({
    sessionId: sessionRole === "main" ? "main-session" : "review-session",
    agentName,
    sessionRole,
    goalId,
  });
}

function makeProjectContext(
  manager: GoalStateManagerMock,
  workspaceRoot: string,
): ProjectContext {
  const project = {
    slug: "test-project",
    name: "Test Project",
    workspaceRoot,
    addedAt: new Date().toISOString(),
  };
  const goalState = manager as unknown as ProjectContext["goalState"];
  const hitl = new HitlService({ workspaceRoot, project, sessions: storeManager, goalState });
  return {
    project,
    goalState,
    goalRunner: manager as unknown as ProjectContext["goalRunner"],
    createAutomation: async () => { throw new Error("unused automation creator"); },
    goalCancellation: {
      cancel: async () => { throw new Error("unused goal cancellation"); },
    },
    hitl,
    hitlResumeCoordinator: new ResumeCoordinator({
      hitl,
      adapters: {
        session: { prepare: async () => createPreparedHitlResume(async () => undefined) },
        goal: { prepare: async () => createPreparedHitlResume(async () => undefined) },
      },
      logger: silentLogger,
    }),
    memory: new MemoryFileManager({
      project: join(workspaceRoot, ".archcode", "memory"),
      user: join(workspaceRoot, ".archcode", "user-memory"),
    }),
    approvals: new ProjectApprovalManager(silentLogger),
  };
}

function makeContext(
  input: unknown,
  store: StoreApi<SessionStoreState>,
  projectContext: ProjectContext,
  cwd: string,
): ToolExecutionContext {
  return createToolExecutionContext({
    store,
    storeManager,
    toolName: goalManageTool.name,
    toolCallId: "goal-manage-call",
    input,
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set([goalManageTool.name]),
    agentName: store.getState().agentName,
    agentSkills: [],
    skillService: testSkillService,
    projectContext,
    cwd,
  });
}

function normalizeOutput(output: string | ToolExecutionResult): ToolExecutionResult {
  return typeof output === "string" ? { output, isError: false } : output;
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

async function initializeGitRepo(cwd: string): Promise<string> {
  await mkdir(cwd, { recursive: true });
  await runGit(cwd, ["init", "--initial-branch=main"]);
  await runGit(cwd, ["config", "user.email", "goal-tool@example.com"]);
  await runGit(cwd, ["config", "user.name", "Goal Tool Test"]);
  await writeFile(join(cwd, "README.md"), "# Goal tool claim\n");
  await runGit(cwd, ["add", "README.md"]);
  await runGit(cwd, ["commit", "-m", "initial commit"]);
  const firstSha = await runGit(cwd, ["rev-parse", "HEAD"]);
  await writeFile(join(cwd, "base.txt"), "Goal creation base\n");
  await runGit(cwd, ["add", "base.txt"]);
  await runGit(cwd, ["commit", "-m", "Goal creation base"]);
  return firstSha;
}

describe("goal_manage builtin tool integration", () => {
  it("validates the persisted Goal branch claim before lifecycle actions", async () => {
    const tempRoot = createTestTempRoot("goal-tools-worktree-claim");
    const workspaceRoot = join(tempRoot.path, "repo");

    try {
      const goalId = crypto.randomUUID();
      const firstSha = await initializeGitRepo(workspaceRoot);
      const created = await new WorktreeService({ canonicalRoot: workspaceRoot }).create({
        owner: { type: "goal", id: goalId },
      });
      const manager = new GoalStateManagerMock(makeGoalState(goalId, {
        path: created.worktreePath,
        branchName: created.branchName,
        baseSha: created.baseSha,
        createdAt: "2026-07-08T00:00:00.000Z",
      }));
      const context = makeProjectContext(manager, workspaceRoot);

      await writeFile(join(created.worktreePath, "descendant.txt"), "committed descendant\n");
      await runGit(created.worktreePath, ["add", "descendant.txt"]);
      await runGit(created.worktreePath, ["commit", "-m", "Goal descendant"]);
      await writeFile(join(created.worktreePath, "dirty.txt"), "in-progress review state\n");
      const finalizeInput = {
        action: "finalize_review",
        goalId,
        expectedReviewGeneration: 1,
        verdict: "DONE",
        summary: "Validated descendant work.",
        evidenceRefs: [{
          kind: "test_output",
          ref: "bun test packages/agent-core/src/tools/builtins/goal-tools.integration.test.ts",
          summary: "Targeted Goal tool integration test passed.",
        }],
      } as const;

      const allowed = normalizeOutput(await goalManageTool.execute(
        finalizeInput,
        makeContext(finalizeInput, makeStore(goalId, "reviewer", "review"), context, created.worktreePath),
      ));
      expect(allowed.isError).toBe(false);
      expect(manager.calls).toEqual(["finalizeReview"]);

      await runGit(created.worktreePath, ["switch", "-c", "foreign-review-branch"]);
      const wrongBranch = normalizeOutput(await goalManageTool.execute(
        finalizeInput,
        makeContext(finalizeInput, makeStore(goalId, "reviewer", "review"), context, created.worktreePath),
      ));
      expect(wrongBranch.isError).toBe(true);
      expect(wrongBranch.output).toContain("GOAL_WORKTREE_CHANGED");
      expect(manager.calls).toEqual(["finalizeReview"]);

      await runGit(created.worktreePath, ["switch", created.branchName]);
      await runGit(created.worktreePath, ["reset", "--hard", firstSha]);
      const beginReviewInput = { action: "begin_review", goalId } as const;
      const resetBehind = normalizeOutput(await goalManageTool.execute(
        beginReviewInput,
        makeContext(beginReviewInput, makeStore(goalId, "goal_lead", "main"), context, created.worktreePath),
      ));
      expect(resetBehind.isError).toBe(true);
      expect(resetBehind.output).toContain("GOAL_WORKTREE_CHANGED");
      expect(manager.calls).toEqual(["finalizeReview"]);
    } finally {
      await tempRoot.cleanup();
    }
  });
});
