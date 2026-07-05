import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { SkillService } from "../skills";
import type { GitHubConnectorApi, GitHubResponse, GitHubWorkflowRunsPage } from "../integrations/github";
import { createSessionStore } from "../store/store";
import { SessionStoreManager } from "../store/session-store-manager";
import { silentLogger } from "../logger";
import { createRegistry } from "../tools/registry";
import { createTestProjectContext } from "../tools/test-project-context";
import { createToolExecutionContext, type ToolExecutionContext } from "../tools/types";
import { createGitHubToolDescriptors } from "../tools/github";
import {
  TOOL_GITHUB_CREATE_ISSUE_COMMENT,
  TOOL_GITHUB_GET_PULL_REQUEST,
  TOOL_GITHUB_GET_PULL_REQUEST_CHECKS,
} from "../tools/names";
import { createLoopBudgetToolPermission } from "./budget-tool-guard";
import { CollisionLedger } from "./collision-ledger";
import { LoopJobCoordinator } from "./coordinator";
import { LoopJobQueue } from "./job-queue";
import { createLoopCollisionToolPermission, createLoopCollisionToolReleaseHook } from "./collision-tool-guard";
import { LoopKillStateManager } from "./kill-state";
import { LoopBudgetLedger } from "./budget-ledger";
import { expandLoopPreset } from "./presets";
import { LoopScheduler } from "./scheduler";
import { LoopBudgetConfigSchema, LoopStateManager, type LoopConfig } from "./state";
import { FakeClock } from "./test-utils";
import { resolveLoopToolProfile } from "./tool-profiles";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "loop-guardrail-e2e");
const storeManager = new SessionStoreManager({ logger: silentLogger });

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("Loop end-to-end guardrail flows", () => {
  test("PR Babysitter preset watches mocked GitHub reads and records soft-budget comment block", async () => {
    const clock = new FakeClock(Date.UTC(2026, 6, 5, 12, 0, 0));
    const stateManager = new LoopStateManager(TMP_DIR);
    const jobQueue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });
    const connector = makeConnector();
    const registry = createRegistry(createGitHubToolDescriptors({ connector }));
    registry.globalPermissions.push(createLoopBudgetToolPermission());
    registry.globalPermissions.push(createLoopCollisionToolPermission({ leaseTtlMs: 60_000 }));
    registry.globalHooks.after.push(createLoopCollisionToolReleaseHook({ leaseTtlMs: 60_000 }));
    const allowedTools = resolveLoopToolProfile({
      agentAllowedTools: registry.getAll().map((descriptor) => descriptor.name),
      toolProfileId: "loop_github_pr_watch",
    }).tools;
    const prBabysitter = await stateManager.create("project-a", prBabysitterConfig());
    const executedReadTools: string[] = [];
    const confirmPermission = mock(async () => "approve_once" as const);
    const scheduler = new LoopScheduler({
      stateManager,
      clock,
      jobQueue,
      coordinator: new LoopJobCoordinator({ queue: jobQueue, clock }),
      killStateManager: new LoopKillStateManager(TMP_DIR, { clock }),
      runner: async ({ loop, runId }) => {
        expect(loop.config.sourcePreset).toBe("pr_babysitter");
        expect(loop.config.toolProfileId).toBe("loop_github_pr_watch");
        expect(allowedTools).toContain(TOOL_GITHUB_GET_PULL_REQUEST);
        expect(allowedTools).toContain(TOOL_GITHUB_GET_PULL_REQUEST_CHECKS);
        expect(allowedTools).toContain(TOOL_GITHUB_CREATE_ISSUE_COMMENT);
        expect(allowedTools).not.toContain("github_rerun_workflow_run");

        const readContext = toolContext(TOOL_GITHUB_GET_PULL_REQUEST, loop.loopId, runId, allowedTools, { confirmPermission });
        const pullRequest = await registry.execute({
          toolName: TOOL_GITHUB_GET_PULL_REQUEST,
          toolCallId: "read-pr-42",
          input: { owner: "archcode", repo: "archcode", number: 42 },
        }, readContext);
        expect(pullRequest.isError).toBe(false);
        executedReadTools.push(TOOL_GITHUB_GET_PULL_REQUEST);

        const checks = await registry.execute({
          toolName: TOOL_GITHUB_GET_PULL_REQUEST_CHECKS,
          toolCallId: "read-pr-checks-42",
          input: { owner: "archcode", repo: "archcode", number: 42, perPage: 10 },
        }, toolContext(TOOL_GITHUB_GET_PULL_REQUEST_CHECKS, loop.loopId, runId, allowedTools, { confirmPermission }));
        expect(checks.isError).toBe(false);
        expect(JSON.parse(checks.output)).toMatchObject({
          type: "github.pull_request_checks",
          data: { headBranch: "automation/guardrail-evidence", headSha: "abc123" },
        });
        executedReadTools.push(TOOL_GITHUB_GET_PULL_REQUEST_CHECKS);

        await stateManager.updateBudgetSnapshot(loop.loopId, {
          budget: LoopBudgetConfigSchema.parse(loop.config.limits),
          usage: {
            iterations: 1,
            inputTokens: 800,
            outputTokens: 0,
            totalTokens: 800,
            wallClockMs: 2_000,
            runsToday: 1,
            resetDateUtc: "2026-07-05",
            pricingUnavailable: true,
          },
          updatedAt: clock.now(),
        });

        const comment = await registry.execute({
          toolName: TOOL_GITHUB_CREATE_ISSUE_COMMENT,
          toolCallId: "comment-pr-42",
          input: { owner: "archcode", repo: "archcode", issueNumber: 42, body: "Status update" },
        }, toolContext(TOOL_GITHUB_CREATE_ISSUE_COMMENT, loop.loopId, runId, allowedTools, { confirmPermission }));
        expect(comment.isError).toBe(true);
        expect(comment.output).toContain("LOOP_SOFT_BUDGET_BLOCKED");

        return {
          status: "succeeded",
          reason: "soft_budget_blocked",
          summary: "Mocked PR read tools completed; status comment was blocked at soft budget.",
          budgetUsage: (await stateManager.read(loop.loopId)).latestBudget?.usage,
        };
      },
    });

    const report = await scheduler.runManual(prBabysitter.loopId);

    expect(report).toMatchObject({
      status: "succeeded",
      reason: "soft_budget_blocked",
      toolProfileId: "loop_github_pr_watch",
    });
    expect(executedReadTools).toEqual([TOOL_GITHUB_GET_PULL_REQUEST, TOOL_GITHUB_GET_PULL_REQUEST_CHECKS]);
    expect(connector.getPullRequest).toHaveBeenCalledTimes(2);
    expect(connector.listWorkflowRuns).toHaveBeenCalledWith("archcode", "archcode", {
      branch: "automation/guardrail-evidence",
      headSha: "abc123",
      perPage: 10,
    });
    expect(connector.createIssueComment).not.toHaveBeenCalled();
    expect(confirmPermission).not.toHaveBeenCalled();
    expect(await stateManager.readRunLog(prBabysitter.loopId, 1)).toEqual([
      expect.objectContaining({ reason: "soft_budget_blocked", summary: expect.stringContaining("blocked at soft budget") }),
    ]);
  });

  test("collision conflict persists in run history with canonical GitHub PR target", async () => {
    const clock = new FakeClock(Date.UTC(2026, 6, 5, 12, 30, 0));
    const stateManager = new LoopStateManager(TMP_DIR);
    const jobQueue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });
    const collisionLedger = new CollisionLedger({ stateManager, workspaceRoot: TMP_DIR, clock, leaseTtlMs: 60_000 });
    const holder = await stateManager.create("project-a", prBabysitterConfig());
    const contender = await stateManager.create("project-a", {
      ...prBabysitterConfig(),
      collisionTargets: [{ type: "pr", owner: "archcode", repo: "archcode", number: 42 }],
    });
    await collisionLedger.acquire({
      target: { type: "pr", owner: "archcode", repo: "archcode", number: 42 },
      loopId: holder.loopId,
      runId: "holder-run",
      priority: 10,
      createdAt: clock.now(),
    });
    const runner = mock(async () => ({ summary: "should not run" }));
    const scheduler = new LoopScheduler({
      stateManager,
      clock,
      jobQueue,
      coordinator: new LoopJobCoordinator({ queue: jobQueue, clock }),
      collisionLedger,
      killStateManager: new LoopKillStateManager(TMP_DIR, { clock }),
      runner,
    });

    const report = await scheduler.runManual(contender.loopId);
    const runHistory = await stateManager.readRunLog(contender.loopId, 1);

    expect(report).toMatchObject({ status: "skipped", reason: "collision_conflict" });
    expect(report?.collisionConflicts?.[0]?.targetKey).toBe("github:archcode/archcode:pr:42");
    expect(runHistory).toEqual([
      expect.objectContaining({
        status: "skipped",
        reason: "collision_conflict",
        collisionConflicts: [expect.objectContaining({ targetKey: "github:archcode/archcode:pr:42" })],
      }),
    ]);
    expect(runner).not.toHaveBeenCalled();
  });

  test("global kill blocks new runs and clear enables the next manual run", async () => {
    const clock = new FakeClock(Date.UTC(2026, 6, 5, 13, 0, 0));
    const stateManager = new LoopStateManager(TMP_DIR);
    const jobQueue = new LoopJobQueue({ workspaceRoot: TMP_DIR, clock });
    const killStateManager = new LoopKillStateManager(TMP_DIR, { clock });
    const loop = await stateManager.create("project-a", prBabysitterConfig());
    const runner = mock(async () => ({ summary: "manual run accepted after clear" }));
    const scheduler = new LoopScheduler({
      stateManager,
      clock,
      jobQueue,
      coordinator: new LoopJobCoordinator({ queue: jobQueue, clock }),
      killStateManager,
      budgetLedger: new LoopBudgetLedger({ stateManager, workspaceRoot: TMP_DIR, clock }),
      runner,
    });

    await scheduler.activateGlobalKill({ activatedBy: "seeded-kill-switch", reason: "freeze automation" });
    const blocked = await scheduler.runManual(loop.loopId);
    const cleared = await scheduler.clearGlobalKill();
    const accepted = await scheduler.runManual(loop.loopId);

    expect(blocked).toMatchObject({ status: "skipped", reason: "global_kill_active" });
    expect(cleared).toEqual({ globalKillActive: false });
    expect(accepted).toMatchObject({ status: "succeeded", summary: "manual run accepted after clear" });
    expect(runner).toHaveBeenCalledTimes(1);
    expect((await stateManager.readRunLog(loop.loopId)).map((entry) => entry.reason ?? "completed")).toEqual(["completed", "global_kill_active"]);
  });
});

function prBabysitterConfig(): LoopConfig {
  const preset = expandLoopPreset("pr_babysitter");
  const budget = LoopBudgetConfigSchema.parse({
    ...preset.limits,
    maxTokensPerRun: 1_000,
    softThresholdRatio: 0.8,
    hardThresholdRatio: 1,
  });
  return { ...preset, limits: budget, budget };
}

function toolContext(
  toolName: string,
  loopId: string,
  runId: string,
  allowedTools: readonly string[],
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return createToolExecutionContext({
    store: createSessionStore("loop-guardrail-session-1"),
    storeManager,
    toolName,
    toolCallId: `${toolName}-call`,
    input: {},
    step: 0,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(allowedTools),
    projectContext: createTestProjectContext(TMP_DIR),
    agentSkills: [],
    skillService: new SkillService({ builtinSkills: {} }),
    origin: { kind: "loop", loopId, runId, trigger: "manual", mode: "report", approvalPolicy: "interactive", toolProfileId: "loop_github_pr_watch" },
    ...overrides,
  });
}

function makeConnector(): GitHubConnectorApi & Record<string, ReturnType<typeof mock>> {
  return {
    getPullRequest: mock(async (_owner: string, _repo: string, number: number) => response({
      number,
      title: "Guardrail evidence fixture",
      head: { ref: "automation/guardrail-evidence", sha: "abc123" },
    })),
    listPullRequests: mock(async () => response([{ number: 42 }])),
    getPullRequestFiles: mock(async () => response([{ filename: "packages/agent-core/src/loops/loop-guardrail-e2e.test.ts" }])),
    listIssueComments: mock(async () => response([{ id: 100, body: "waiting for checks" }])),
    createIssueComment: mock(async () => response({ id: 101, body: "created" }, 201)),
    listWorkflowRuns: mock(async () => response<GitHubWorkflowRunsPage>({
      total_count: 1,
      workflow_runs: [{ id: 9001, head_branch: "automation/guardrail-evidence", head_sha: "abc123", status: "completed", conclusion: "success" }],
    })),
    getWorkflowRun: mock(async (_owner: string, _repo: string, runId: number) => response({ id: runId, status: "completed", conclusion: "success" })),
    rerunWorkflowRun: mock(async () => response(undefined, 201)),
  };
}

function response<T>(data: T, status = 200): GitHubResponse<T> {
  return { data, status };
}
