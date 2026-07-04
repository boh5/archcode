import type { CollisionTarget } from "./state";
import { normalizeCollisionTarget } from "./collision-ledger";
import {
  LOOP_GITHUB_CREATE_ISSUE_COMMENT_TOOL,
  LOOP_GITHUB_GET_PULL_REQUEST_CHECKS_TOOL,
  LOOP_GITHUB_GET_PULL_REQUEST_TOOL,
  LOOP_GITHUB_GET_WORKFLOW_RUN_TOOL,
  LOOP_GITHUB_LIST_ISSUE_COMMENTS_TOOL,
  LOOP_GITHUB_LIST_PULL_REQUESTS_TOOL,
  LOOP_GITHUB_LIST_WORKFLOW_RUNS_TOOL,
  LOOP_GITHUB_RERUN_WORKFLOW_RUN_TOOL,
} from "./tool-profiles";
import { TOOL_FILE_EDIT, TOOL_FILE_WRITE } from "../tools/names";

export interface ToolTargetExtractorContext {
  readonly workspaceRoot: string;
}

export type ToolTargetExtractor = (input: unknown, ctx: ToolTargetExtractorContext) => CollisionTarget[];

export class ToolTargetExtractorRegistry {
  readonly #extractors = new Map<string, ToolTargetExtractor>();

  register(toolName: string, extractor: ToolTargetExtractor): void {
    this.#extractors.set(toolName, extractor);
  }

  extract(toolName: string, input: unknown, ctx: ToolTargetExtractorContext): CollisionTarget[] {
    return this.#extractors.get(toolName)?.(input, ctx) ?? [];
  }
}

export function createDefaultToolTargetExtractorRegistry(): ToolTargetExtractorRegistry {
  const registry = new ToolTargetExtractorRegistry();
  registry.register(TOOL_FILE_WRITE, extractFileToolTargets);
  registry.register(TOOL_FILE_EDIT, extractFileToolTargets);

  registry.register(LOOP_GITHUB_GET_PULL_REQUEST_TOOL, extractPullRequestTarget);
  registry.register(LOOP_GITHUB_GET_PULL_REQUEST_CHECKS_TOOL, extractPullRequestTarget);
  registry.register(LOOP_GITHUB_CREATE_ISSUE_COMMENT_TOOL, extractIssueTarget);
  registry.register(LOOP_GITHUB_LIST_ISSUE_COMMENTS_TOOL, extractIssueTarget);
  registry.register(LOOP_GITHUB_LIST_PULL_REQUESTS_TOOL, extractBranchTarget);
  registry.register(LOOP_GITHUB_LIST_WORKFLOW_RUNS_TOOL, extractBranchTarget);
  registry.register(LOOP_GITHUB_GET_WORKFLOW_RUN_TOOL, extractBranchTarget);
  registry.register(LOOP_GITHUB_RERUN_WORKFLOW_RUN_TOOL, extractBranchTarget);
  return registry;
}

function extractFileToolTargets(input: unknown, ctx: ToolTargetExtractorContext): CollisionTarget[] {
  const path = stringField(input, "path");
  if (path === undefined) return [];
  return [normalizeCollisionTarget({ type: "file", path }, ctx.workspaceRoot)];
}

function extractPullRequestTarget(input: unknown): CollisionTarget[] {
  const owner = stringField(input, "owner");
  const repo = stringField(input, "repo");
  const number = numberField(input, "number") ?? numberField(input, "pullRequestNumber") ?? numberField(input, "prNumber");
  if (owner === undefined || repo === undefined || number === undefined) return [];
  return [{ type: "pr", owner, repo, number }];
}

function extractIssueTarget(input: unknown): CollisionTarget[] {
  const owner = stringField(input, "owner");
  const repo = stringField(input, "repo");
  const number = numberField(input, "issueNumber") ?? numberField(input, "number");
  if (owner === undefined || repo === undefined || number === undefined) return [];
  return [{ type: "issue", owner, repo, number }];
}

function extractBranchTarget(input: unknown): CollisionTarget[] {
  const owner = stringField(input, "owner");
  const repo = stringField(input, "repo");
  const branch = stringField(input, "branch") ?? stringField(input, "headBranch");
  if (owner === undefined || repo === undefined || branch === undefined) return [];
  return [{ type: "branch", owner, repo, branch }];
}

function stringField(input: unknown, key: string): string | undefined {
  if (!isRecord(input)) return undefined;
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberField(input: unknown, key: string): number | undefined {
  if (!isRecord(input)) return undefined;
  const value = input[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
