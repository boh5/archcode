import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  TOOL_GITHUB_CREATE_ISSUE_COMMENT,
  TOOL_GITHUB_GET_PULL_REQUEST,
  TOOL_GITHUB_GET_PULL_REQUEST_CHECKS,
  TOOL_GITHUB_GET_WORKFLOW_RUN,
  TOOL_GITHUB_LIST_ISSUE_COMMENTS,
  TOOL_GITHUB_LIST_PULL_REQUESTS,
  TOOL_GITHUB_LIST_WORKFLOW_RUNS,
  TOOL_GITHUB_RERUN_WORKFLOW_RUN,
} from "./names";
import { createGitHubToolDescriptors } from "./github";
import { createRegistry } from "./registry";
import { createToolExecutionContext, type ToolExecutionContext } from "./types";
import { createTestProjectContext } from "./test-project-context";
import { createSessionStore } from "../store/store";
import { SessionStoreManager } from "../store/session-store-manager";
import { SkillService } from "../skills";
import { silentLogger } from "../logger";
import { createLoopCollisionToolPermission } from "../loops/collision-tool-guard";
import { createLoopBudgetToolPermission } from "../loops/budget-tool-guard";
import { CollisionLedger } from "../loops/collision-ledger";
import { LoopBudgetConfigSchema, LoopStateManager, type LoopBudgetConfig, type LoopConfig } from "../loops/state";
import type { GitHubConnectorApi, GitHubResponse, GitHubWorkflowRunsPage } from "../integrations/github";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "github-tools");
const storeManager = new SessionStoreManager({ logger: silentLogger });
const CONNECTOR_COVERAGE_BRANCH = "feature/connector-coverage";

interface PullRequestChecksOutput {
  type: string;
  data: {
    headBranch: string;
    headSha: string;
    workflowRuns: Array<{ id: number }>;
  };
}

const LOOP_CONFIG: LoopConfig = {
  templateId: "pr_babysitter",
  title: "GitHub guarded loop",
  schedule: { kind: "manual" },
  approvalPolicy: "interactive",
  limits: { maxIterationsPerRun: 4, maxTokensPerRun: 1_000, softThresholdRatio: 0.8, hardThresholdRatio: 1 },
};

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("GitHub connector-backed tools", () => {
  test("registers the exact GitHub connector tool names with read-only and effectful traits", () => {
    const descriptors = createGitHubToolDescriptors({ connector: makeConnector() });
    const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));

    expect(descriptors.map((descriptor) => descriptor.name)).toEqual([
      TOOL_GITHUB_GET_PULL_REQUEST,
      TOOL_GITHUB_LIST_PULL_REQUESTS,
      TOOL_GITHUB_GET_PULL_REQUEST_CHECKS,
      TOOL_GITHUB_LIST_ISSUE_COMMENTS,
      TOOL_GITHUB_CREATE_ISSUE_COMMENT,
      TOOL_GITHUB_LIST_WORKFLOW_RUNS,
      TOOL_GITHUB_GET_WORKFLOW_RUN,
      TOOL_GITHUB_RERUN_WORKFLOW_RUN,
    ]);
    for (const name of [
      TOOL_GITHUB_GET_PULL_REQUEST,
      TOOL_GITHUB_LIST_PULL_REQUESTS,
      TOOL_GITHUB_GET_PULL_REQUEST_CHECKS,
      TOOL_GITHUB_LIST_ISSUE_COMMENTS,
      TOOL_GITHUB_LIST_WORKFLOW_RUNS,
      TOOL_GITHUB_GET_WORKFLOW_RUN,
    ]) {
      expect(byName.get(name)?.traits).toMatchObject({ readOnly: true, destructive: false });
    }
    expect(byName.get(TOOL_GITHUB_CREATE_ISSUE_COMMENT)?.traits.readOnly).toBe(false);
    expect(byName.get(TOOL_GITHUB_RERUN_WORKFLOW_RUN)?.traits.readOnly).toBe(false);
    expect(byName.get(TOOL_GITHUB_CREATE_ISSUE_COMMENT)?.permissions?.length).toBeGreaterThan(0);
    expect(byName.get(TOOL_GITHUB_RERUN_WORKFLOW_RUN)?.permissions?.length).toBeGreaterThan(0);
  });

  test("routes read tools to the injected connector without network access", async () => {
    const connector = makeConnector();
    const registry = createRegistry(createGitHubToolDescriptors({ connector }));
    const input = { owner: "test-owner", repo: "test-repo", number: 42 };

    const result = await registry.execute(
      { toolName: TOOL_GITHUB_GET_PULL_REQUEST, toolCallId: "gh-pr", input },
      context(TOOL_GITHUB_GET_PULL_REQUEST, [TOOL_GITHUB_GET_PULL_REQUEST], input),
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output)).toMatchObject({ type: "github.pull_request", data: { number: 42 } });
    expect(connector.getPullRequest).toHaveBeenCalledWith("test-owner", "test-repo", 42);
  });

  test("maps pull request checks to connector-supported PR metadata and workflow runs", async () => {
    const connector = makeConnector();
    const registry = createRegistry(createGitHubToolDescriptors({ connector }));
    const input = { owner: "test-owner", repo: "test-repo", number: 42, perPage: 25 };

    const result = await registry.execute(
      { toolName: TOOL_GITHUB_GET_PULL_REQUEST_CHECKS, toolCallId: "gh-checks", input },
      context(TOOL_GITHUB_GET_PULL_REQUEST_CHECKS, [TOOL_GITHUB_GET_PULL_REQUEST_CHECKS], input),
    );

    const output = JSON.parse(result.output) as PullRequestChecksOutput;
    expect(result.isError).toBe(false);
    expect(output.type).toBe("github.pull_request_checks");
    expect(output.data.headBranch).toBe(CONNECTOR_COVERAGE_BRANCH);
    expect(output.data.headSha).toBe("abc123");
    expect(output.data.workflowRuns[0].id).toBe(9001);
    expect(connector.listWorkflowRuns).toHaveBeenCalledWith("test-owner", "test-repo", {
      branch: CONNECTOR_COVERAGE_BRANCH,
      headSha: "abc123",
      perPage: 25,
    });
  });

  test("effectful tools request permission before connector execution", async () => {
    const connector = makeConnector();
    const registry = createRegistry(createGitHubToolDescriptors({ connector }));
    const input = { owner: "test-owner", repo: "test-repo", issueNumber: 42, body: "Looks good" };
    const confirmPermission = mock(async (request) => {
      expect(request.toolName).toBe(TOOL_GITHUB_CREATE_ISSUE_COMMENT);
      expect(request.ruleId).toBe("github.create_issue_comment");
      expect(request.approval).toMatchObject({
        eligible: true,
        scope: {
          kind: "tool-operation",
          toolName: TOOL_GITHUB_CREATE_ISSUE_COMMENT,
          operation: "create_issue_comment",
          target: "test-owner/test-repo#42",
        },
      });
      return "approve_once" as const;
    });

    const result = await registry.execute(
      { toolName: TOOL_GITHUB_CREATE_ISSUE_COMMENT, toolCallId: "gh-comment", input },
      context(TOOL_GITHUB_CREATE_ISSUE_COMMENT, [TOOL_GITHUB_CREATE_ISSUE_COMMENT], input, { confirmPermission }),
    );

    expect(result.isError).toBe(false);
    expect(confirmPermission).toHaveBeenCalledTimes(1);
    expect(connector.createIssueComment).toHaveBeenCalledWith("test-owner", "test-repo", 42, "Looks good");
  });

  test("permission denial blocks rerun connector execution", async () => {
    const connector = makeConnector();
    const registry = createRegistry(createGitHubToolDescriptors({ connector }));
    const input = { owner: "test-owner", repo: "test-repo", runId: 9001, headBranch: "main" };

    const result = await registry.execute(
      { toolName: TOOL_GITHUB_RERUN_WORKFLOW_RUN, toolCallId: "gh-rerun", input },
      context(TOOL_GITHUB_RERUN_WORKFLOW_RUN, [TOOL_GITHUB_RERUN_WORKFLOW_RUN], input, {
        confirmPermission: async () => "deny",
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.meta?.permissionErrorCode).toBe("TOOL_PERMISSION_CONFIRMATION_DENIED");
    expect(connector.rerunWorkflowRun).not.toHaveBeenCalled();
  });

  test("Loop collision conflict blocks issue comment before connector and HITL", async () => {
    const connector = makeConnector();
    const registry = createRegistry(createGitHubToolDescriptors({ connector }));
    registry.globalPermissions.push(createLoopCollisionToolPermission({ leaseTtlMs: 60_000 }));
    const stateManager = new LoopStateManager(TMP_DIR);
    const holder = await stateManager.create("project-a", LOOP_CONFIG);
    const contender = await stateManager.create("project-a", LOOP_CONFIG);
    const ledger = new CollisionLedger({ stateManager, workspaceRoot: TMP_DIR, leaseTtlMs: 60_000 });
    await ledger.acquire({
      target: { type: "issue", owner: "test-owner", repo: "test-repo", number: 42 },
      loopId: holder.loopId,
      runId: "run-a",
      priority: 10,
      expiresAt: Date.now() + 60_000,
    });
    const input = { owner: "test-owner", repo: "test-repo", issueNumber: 42, body: "Looks good" };
    const confirmPermission = mock(async () => "approve_once" as const);

    const result = await registry.execute(
      { toolName: TOOL_GITHUB_CREATE_ISSUE_COMMENT, toolCallId: "gh-comment-collision", input },
      context(TOOL_GITHUB_CREATE_ISSUE_COMMENT, [TOOL_GITHUB_CREATE_ISSUE_COMMENT], input, {
        confirmPermission,
        projectContext: createTestProjectContext(TMP_DIR),
        origin: {
          kind: "loop",
          loopId: contender.loopId,
          runId: "run-b",
          trigger: "manual",
          approvalPolicy: "interactive",
        },
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("LOOP_COLLISION_CONFLICT");
    expect(result.output).toContain("collision_conflict");
    expect(confirmPermission).not.toHaveBeenCalled();
    expect(connector.createIssueComment).not.toHaveBeenCalled();
  });

  test("Loop soft budget blocks issue comment before connector and HITL", async () => {
    const connector = makeConnector();
    const registry = createRegistry(createGitHubToolDescriptors({ connector }));
    registry.globalPermissions.push(createLoopBudgetToolPermission());
    const stateManager = new LoopStateManager(TMP_DIR);
    const loop = await stateManager.create("project-a", LOOP_CONFIG);
    await stateManager.updateBudgetSnapshot(loop.loopId, {
      budget: normalizedBudget(loop.config.limits),
      usage: {
        iterations: 1,
        inputTokens: 800,
        outputTokens: 0,
        totalTokens: 800,
        wallClockMs: 4,
        runsToday: 1,
        resetDateUtc: "2026-07-05",
        pricingUnavailable: true,
      },
      updatedAt: Date.now(),
    });
    const input = { owner: "test-owner", repo: "test-repo", issueNumber: 42, body: "Looks good" };
    const confirmPermission = mock(async () => "approve_once" as const);

    const result = await registry.execute(
      { toolName: TOOL_GITHUB_CREATE_ISSUE_COMMENT, toolCallId: "gh-comment-budget", input },
      context(TOOL_GITHUB_CREATE_ISSUE_COMMENT, [TOOL_GITHUB_CREATE_ISSUE_COMMENT], input, {
        confirmPermission,
        projectContext: createTestProjectContext(TMP_DIR),
        origin: {
          kind: "loop",
          loopId: loop.loopId,
          runId: "run-soft",
          trigger: "manual",
          approvalPolicy: "interactive",
        },
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("LOOP_SOFT_BUDGET_BLOCKED");
    expect(confirmPermission).not.toHaveBeenCalled();
    expect(connector.createIssueComment).not.toHaveBeenCalled();
  });
});

function context(
  toolName: string,
  allowedTools: string[],
  input: unknown,
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return createToolExecutionContext({
    store: createSessionStore(`github-tools-${crypto.randomUUID()}`),
    storeManager,
    toolName,
    toolCallId: `${toolName}-call`,
    input,
    step: 0,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(allowedTools),
    projectContext: createTestProjectContext(TMP_DIR),
    agentSkills: [],
    skillService: new SkillService({ builtinSkills: {} }),
    ...overrides,
    cwd: overrides.cwd ?? TMP_DIR,
  });
}

function makeConnector(): GitHubConnectorApi & Record<string, ReturnType<typeof mock>> {
  return {
    getPullRequest: mock(async (_owner: string, _repo: string, number: number) => response({
      number,
      title: "Improve connector coverage",
      head: { ref: CONNECTOR_COVERAGE_BRANCH, sha: "abc123" },
    })),
    listPullRequests: mock(async () => response([{ number: 1 }, { number: 2 }])),
    getPullRequestFiles: mock(async () => response([{ filename: "src/index.ts" }])),
    listIssueComments: mock(async () => response([{ id: 100, body: "hello" }])),
    createIssueComment: mock(async () => response({ id: 101, body: "created" }, 201)),
    listWorkflowRuns: mock(async () => response<GitHubWorkflowRunsPage>({
      total_count: 1,
      workflow_runs: [{ id: 9001, head_branch: CONNECTOR_COVERAGE_BRANCH, head_sha: "abc123", status: "completed" }],
    })),
    getWorkflowRun: mock(async (_owner: string, _repo: string, runId: number) => response({ id: runId, status: "completed", conclusion: "success" })),
    rerunWorkflowRun: mock(async () => response(undefined, 201)),
  };
}

function response<T>(data: T, status = 200): GitHubResponse<T> {
  return { data, status };
}

function normalizedBudget(value: unknown): LoopBudgetConfig {
  return LoopBudgetConfigSchema.parse(value);
}
