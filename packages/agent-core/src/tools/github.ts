import { z } from "zod";
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
import { defineTool } from "./define-tool";
import { createToolErrorResult } from "./errors";
import type { AnyToolDescriptor, PermissionDecision, ToolExecutionResult } from "./types";
import {
  createGitHubConnector,
  IntegrationError,
  type GitHubConnectorApi,
  type GitHubListPullRequestsFilters,
  type GitHubListWorkflowRunsFilters,
} from "../integrations/github";

export interface GitHubToolDescriptorOptions {
  readonly connector?: GitHubConnectorApi | (() => GitHubConnectorApi);
}

const OwnerSchema = z.string().trim().min(1).max(200);
const RepoSchema = z.string().trim().min(1).max(200);
const BranchSchema = z.string().trim().min(1).max(255);
const PositiveIntSchema = z.number().int().positive();

export const GitHubGetPullRequestInputSchema = z.object({
  owner: OwnerSchema,
  repo: RepoSchema,
  number: PositiveIntSchema.describe("Pull request number."),
}).strict();

export const GitHubListPullRequestsInputSchema = z.object({
  owner: OwnerSchema,
  repo: RepoSchema,
  state: z.enum(["open", "closed", "all"]).optional(),
  head: z.string().trim().min(1).max(300).optional(),
  base: BranchSchema.optional(),
  sort: z.enum(["created", "updated", "popularity", "long-running"]).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
  perPage: z.number().int().min(1).max(100).optional(),
  page: z.number().int().positive().optional(),
}).strict();

export const GitHubGetPullRequestChecksInputSchema = z.object({
  owner: OwnerSchema,
  repo: RepoSchema,
  number: PositiveIntSchema.describe("Pull request number."),
  perPage: z.number().int().min(1).max(100).optional(),
  page: z.number().int().positive().optional(),
}).strict();

export const GitHubListIssueCommentsInputSchema = z.object({
  owner: OwnerSchema,
  repo: RepoSchema,
  issueNumber: PositiveIntSchema,
  perPage: z.number().int().min(1).max(100).optional(),
  page: z.number().int().positive().optional(),
}).strict();

export const GitHubCreateIssueCommentInputSchema = z.object({
  owner: OwnerSchema,
  repo: RepoSchema,
  issueNumber: PositiveIntSchema,
  body: z.string().trim().min(1).max(65_536),
}).strict();

export const GitHubListWorkflowRunsInputSchema = z.object({
  owner: OwnerSchema,
  repo: RepoSchema,
  branch: BranchSchema.optional(),
  actor: z.string().trim().min(1).max(200).optional(),
  event: z.string().trim().min(1).max(200).optional(),
  status: z.enum([
    "completed",
    "action_required",
    "cancelled",
    "failure",
    "neutral",
    "skipped",
    "stale",
    "success",
    "timed_out",
    "in_progress",
    "queued",
    "requested",
    "waiting",
    "pending",
  ]).optional(),
  created: z.string().trim().min(1).max(200).optional(),
  headSha: z.string().trim().min(1).max(200).optional(),
  perPage: z.number().int().min(1).max(100).optional(),
  page: z.number().int().positive().optional(),
}).strict();

export const GitHubGetWorkflowRunInputSchema = z.object({
  owner: OwnerSchema,
  repo: RepoSchema,
  runId: PositiveIntSchema,
  headBranch: BranchSchema.optional(),
}).strict();

export const GitHubRerunWorkflowRunInputSchema = z.object({
  owner: OwnerSchema,
  repo: RepoSchema,
  runId: PositiveIntSchema,
  headBranch: BranchSchema.optional(),
}).strict();

type GitHubGetPullRequestInput = z.infer<typeof GitHubGetPullRequestInputSchema>;
type GitHubListPullRequestsInput = z.infer<typeof GitHubListPullRequestsInputSchema>;
type GitHubGetPullRequestChecksInput = z.infer<typeof GitHubGetPullRequestChecksInputSchema>;
type GitHubListIssueCommentsInput = z.infer<typeof GitHubListIssueCommentsInputSchema>;
type GitHubCreateIssueCommentInput = z.infer<typeof GitHubCreateIssueCommentInputSchema>;
type GitHubListWorkflowRunsInput = z.infer<typeof GitHubListWorkflowRunsInputSchema>;
type GitHubGetWorkflowRunInput = z.infer<typeof GitHubGetWorkflowRunInputSchema>;
type GitHubRerunWorkflowRunInput = z.infer<typeof GitHubRerunWorkflowRunInputSchema>;

export function createGitHubToolDescriptors(options: GitHubToolDescriptorOptions = {}): AnyToolDescriptor[] {
  const connectorFactory = makeConnectorFactory(options.connector);

  return [
    defineTool({
      name: TOOL_GITHUB_GET_PULL_REQUEST,
      description: "Fetch a GitHub pull request by owner, repo, and PR number through the configured connector.",
      inputSchema: GitHubGetPullRequestInputSchema,
      traits: { readOnly: true, destructive: false, concurrencySafe: true },
      execute: async (input: GitHubGetPullRequestInput) => withGitHubErrors(async () => {
        const response = await connectorFactory().getPullRequest(input.owner, input.repo, input.number);
        return formatGitHubResult("github.pull_request", response);
      }),
    }),
    defineTool({
      name: TOOL_GITHUB_LIST_PULL_REQUESTS,
      description: "List GitHub pull requests for a repository with optional state, branch, sort, and pagination filters.",
      inputSchema: GitHubListPullRequestsInputSchema,
      traits: { readOnly: true, destructive: false, concurrencySafe: true },
      execute: async (input: GitHubListPullRequestsInput) => withGitHubErrors(async () => {
        const response = await connectorFactory().listPullRequests(input.owner, input.repo, pullRequestFilters(input));
        return formatGitHubResult("github.pull_requests", response);
      }),
    }),
    defineTool({
      name: TOOL_GITHUB_GET_PULL_REQUEST_CHECKS,
      description: "Fetch PR status context using connector-supported PR metadata and matching GitHub Actions workflow runs.",
      inputSchema: GitHubGetPullRequestChecksInputSchema,
      traits: { readOnly: true, destructive: false, concurrencySafe: true },
      execute: async (input: GitHubGetPullRequestChecksInput) => withGitHubErrors(async () => {
        const connector = connectorFactory();
        const pullRequest = await connector.getPullRequest(input.owner, input.repo, input.number);
        const headSha = pullRequest.data.head?.sha;
        const branch = pullRequest.data.head?.ref;
        const workflowRuns = await connector.listWorkflowRuns(input.owner, input.repo, {
          ...(branch ? { branch } : {}),
          ...(headSha ? { headSha } : {}),
          ...(input.perPage === undefined ? {} : { perPage: input.perPage }),
          ...(input.page === undefined ? {} : { page: input.page }),
        });
        return formatGitHubResult("github.pull_request_checks", {
          status: workflowRuns.status,
          rateLimit: workflowRuns.rateLimit ?? pullRequest.rateLimit,
          data: {
            pullRequest: pullRequest.data,
            headBranch: branch,
            headSha,
            workflowRuns: workflowRuns.data.workflow_runs,
            totalCount: workflowRuns.data.total_count,
          },
        });
      }),
    }),
    defineTool({
      name: TOOL_GITHUB_LIST_ISSUE_COMMENTS,
      description: "List issue or pull-request comments for a GitHub repository issue number.",
      inputSchema: GitHubListIssueCommentsInputSchema,
      traits: { readOnly: true, destructive: false, concurrencySafe: true },
      execute: async (input: GitHubListIssueCommentsInput) => withGitHubErrors(async () => {
        const response = await connectorFactory().listIssueComments(input.owner, input.repo, input.issueNumber, pagination(input));
        return formatGitHubResult("github.issue_comments", response);
      }),
    }),
    defineTool({
      name: TOOL_GITHUB_CREATE_ISSUE_COMMENT,
      description: "Create a GitHub issue or pull-request comment after permission approval.",
      inputSchema: GitHubCreateIssueCommentInputSchema,
      traits: { readOnly: false, destructive: false, concurrencySafe: false },
      permissions: [createGitHubIssueCommentPermission()],
      execute: async (input: GitHubCreateIssueCommentInput) => withGitHubErrors(async () => {
        const response = await connectorFactory().createIssueComment(input.owner, input.repo, input.issueNumber, input.body);
        return formatGitHubResult("github.issue_comment_created", response);
      }),
    }),
    defineTool({
      name: TOOL_GITHUB_LIST_WORKFLOW_RUNS,
      description: "List GitHub Actions workflow runs for a repository with optional branch, status, SHA, and pagination filters.",
      inputSchema: GitHubListWorkflowRunsInputSchema,
      traits: { readOnly: true, destructive: false, concurrencySafe: true },
      execute: async (input: GitHubListWorkflowRunsInput) => withGitHubErrors(async () => {
        const response = await connectorFactory().listWorkflowRuns(input.owner, input.repo, workflowRunFilters(input));
        return formatGitHubResult("github.workflow_runs", response);
      }),
    }),
    defineTool({
      name: TOOL_GITHUB_GET_WORKFLOW_RUN,
      description: "Fetch one GitHub Actions workflow run by repository and run id.",
      inputSchema: GitHubGetWorkflowRunInputSchema,
      traits: { readOnly: true, destructive: false, concurrencySafe: true },
      execute: async (input: GitHubGetWorkflowRunInput) => withGitHubErrors(async () => {
        const response = await connectorFactory().getWorkflowRun(input.owner, input.repo, input.runId);
        return formatGitHubResult("github.workflow_run", response);
      }),
    }),
    defineTool({
      name: TOOL_GITHUB_RERUN_WORKFLOW_RUN,
      description: "Rerun a GitHub Actions workflow run after permission approval.",
      inputSchema: GitHubRerunWorkflowRunInputSchema,
      traits: { readOnly: false, destructive: false, concurrencySafe: false },
      permissions: [createGitHubWorkflowRerunPermission()],
      execute: async (input: GitHubRerunWorkflowRunInput) => withGitHubErrors(async () => {
        const response = await connectorFactory().rerunWorkflowRun(input.owner, input.repo, input.runId);
        return formatGitHubResult("github.workflow_run_rerun", response);
      }),
    }),
  ];
}

function makeConnectorFactory(connector: GitHubToolDescriptorOptions["connector"]): () => GitHubConnectorApi {
  if (connector === undefined) return () => createGitHubConnector();
  if (typeof connector === "function") return connector;
  return () => connector;
}

function createGitHubIssueCommentPermission() {
  return (input: unknown): PermissionDecision => {
    const parsed = GitHubCreateIssueCommentInputSchema.safeParse(input);
    const target = parsed.success ? `${parsed.data.owner}/${parsed.data.repo}#${parsed.data.issueNumber}` : undefined;
    return {
      outcome: "ask",
      source: "builtin-policy",
      ruleId: "github.create_issue_comment",
      reason: target ? `Create GitHub issue comment on ${target}.` : "Create GitHub issue comment.",
      prompt: target ? `Allow creating a GitHub issue comment on ${target}?` : "Allow creating a GitHub issue comment?",
      display: target ? `Create GitHub issue comment on ${target}` : "Create GitHub issue comment",
      approval: {
        eligible: parsed.success,
        ...(target ? { scope: { kind: "tool-operation", toolName: TOOL_GITHUB_CREATE_ISSUE_COMMENT, operation: "create_issue_comment", target } } : {}),
        display: target ? `Create GitHub issue comment on ${target}` : "Create GitHub issue comment",
        reason: "GitHub comments modify upstream repository state.",
      },
    };
  };
}

function createGitHubWorkflowRerunPermission() {
  return (input: unknown): PermissionDecision => {
    const parsed = GitHubRerunWorkflowRunInputSchema.safeParse(input);
    const target = parsed.success ? `${parsed.data.owner}/${parsed.data.repo}/actions/runs/${parsed.data.runId}` : undefined;
    return {
      outcome: "ask",
      source: "builtin-policy",
      ruleId: "github_actions.rerun_workflow_run",
      reason: target ? `Rerun GitHub Actions workflow run ${target}.` : "Rerun GitHub Actions workflow run.",
      prompt: target ? `Allow rerunning GitHub Actions workflow run ${target}?` : "Allow rerunning GitHub Actions workflow run?",
      display: target ? `Rerun GitHub Actions workflow run ${target}` : "Rerun GitHub Actions workflow run",
      approval: {
        eligible: parsed.success,
        ...(target ? { scope: { kind: "tool-operation", toolName: TOOL_GITHUB_RERUN_WORKFLOW_RUN, operation: "rerun_workflow_run", target } } : {}),
        display: target ? `Rerun GitHub Actions workflow run ${target}` : "Rerun GitHub Actions workflow run",
        reason: "Rerunning workflow runs modifies upstream CI state.",
      },
    };
  };
}

function pullRequestFilters(input: GitHubListPullRequestsInput): GitHubListPullRequestsFilters {
  return {
    ...(input.state === undefined ? {} : { state: input.state }),
    ...(input.head === undefined ? {} : { head: input.head }),
    ...(input.base === undefined ? {} : { base: input.base }),
    ...(input.sort === undefined ? {} : { sort: input.sort }),
    ...(input.direction === undefined ? {} : { direction: input.direction }),
    ...(input.perPage === undefined ? {} : { perPage: input.perPage }),
    ...(input.page === undefined ? {} : { page: input.page }),
  };
}

function workflowRunFilters(input: GitHubListWorkflowRunsInput): GitHubListWorkflowRunsFilters {
  return {
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    ...(input.branch === undefined ? {} : { branch: input.branch }),
    ...(input.event === undefined ? {} : { event: input.event }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.created === undefined ? {} : { created: input.created }),
    ...(input.headSha === undefined ? {} : { headSha: input.headSha }),
    ...(input.perPage === undefined ? {} : { perPage: input.perPage }),
    ...(input.page === undefined ? {} : { page: input.page }),
  };
}

function pagination(input: { readonly perPage?: number; readonly page?: number }) {
  return {
    ...(input.perPage === undefined ? {} : { perPage: input.perPage }),
    ...(input.page === undefined ? {} : { page: input.page }),
  };
}

async function withGitHubErrors(action: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof IntegrationError) {
      return createToolErrorResult({
        kind: "execution",
        code: error.code.toUpperCase(),
        message: error.message,
        meta: {
          integrationId: error.integrationId,
          integrationErrorCode: error.code,
          ...(error.status === undefined ? {} : { status: error.status }),
          ...(error.rateLimit?.retryAfterMs === undefined ? {} : { retryAfterMs: error.rateLimit.retryAfterMs }),
        },
      });
    }

    return createToolErrorResult({ kind: "execution", error });
  }
}

function formatGitHubResult(label: string, response: { readonly data: unknown; readonly status: number; readonly rateLimit?: unknown }): ToolExecutionResult {
  return {
    output: JSON.stringify({
      type: label,
      status: response.status,
      data: response.data,
      ...(response.rateLimit === undefined ? {} : { rateLimit: response.rateLimit }),
    }, null, 2),
    isError: false,
    meta: { status: response.status },
  };
}
