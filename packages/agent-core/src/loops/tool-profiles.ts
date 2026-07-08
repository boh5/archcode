import type { LoopToolProfileId } from "@archcode/protocol";
import {
  TOOL_ASK_USER,
  TOOL_AST_GREP_REPLACE,
  TOOL_AST_GREP_SEARCH,
  TOOL_BACKGROUND_OUTPUT,
  TOOL_BASH,
  TOOL_DELEGATE,
  TOOL_FILE_EDIT,
  TOOL_FILE_READ,
  TOOL_FILE_WRITE,
  TOOL_GIT_DIFF,
  TOOL_GIT_STATUS,
  TOOL_GLOB,
  TOOL_GOAL_MANAGE,
  TOOL_GREP,
  TOOL_LSP_DIAGNOSTICS,
  TOOL_LSP_FIND_REFERENCES,
  TOOL_LSP_GOTO_DEFINITION,
  TOOL_LSP_SYMBOLS,
  TOOL_MEMORY_READ,
  TOOL_MEMORY_WRITE,
  TOOL_TODO_WRITE,
  TOOL_VIEW_TOOL_OUTPUT,
  TOOL_WAIT_FOR_REMINDER,
  TOOL_WEB_FETCH,
} from "../tools/names";

export const LOOP_GITHUB_GET_PULL_REQUEST_TOOL = "github_get_pull_request";
export const LOOP_GITHUB_LIST_PULL_REQUESTS_TOOL = "github_list_pull_requests";
export const LOOP_GITHUB_GET_PULL_REQUEST_CHECKS_TOOL = "github_get_pull_request_checks";
export const LOOP_GITHUB_LIST_ISSUE_COMMENTS_TOOL = "github_list_issue_comments";
export const LOOP_GITHUB_CREATE_ISSUE_COMMENT_TOOL = "github_create_issue_comment";
export const LOOP_GITHUB_LIST_WORKFLOW_RUNS_TOOL = "github_list_workflow_runs";
export const LOOP_GITHUB_GET_WORKFLOW_RUN_TOOL = "github_get_workflow_run";
export const LOOP_GITHUB_RERUN_WORKFLOW_RUN_TOOL = "github_rerun_workflow_run";

export const LOOP_PROFILE_ONLY_CONNECTOR_TOOLS = [
  LOOP_GITHUB_GET_PULL_REQUEST_TOOL,
  LOOP_GITHUB_LIST_PULL_REQUESTS_TOOL,
  LOOP_GITHUB_GET_PULL_REQUEST_CHECKS_TOOL,
  LOOP_GITHUB_LIST_ISSUE_COMMENTS_TOOL,
  LOOP_GITHUB_CREATE_ISSUE_COMMENT_TOOL,
  LOOP_GITHUB_LIST_WORKFLOW_RUNS_TOOL,
  LOOP_GITHUB_GET_WORKFLOW_RUN_TOOL,
  LOOP_GITHUB_RERUN_WORKFLOW_RUN_TOOL,
] as const;

export const LOOP_LOCAL_REPORT_PLAYBOOK = "loop-local-report-playbook";
export const LOOP_LOCAL_MAINTENANCE_PLAYBOOK = "loop-local-maintenance-playbook";
export const LOOP_GITHUB_PR_WATCH_PLAYBOOK = "loop-github-pr-watch-playbook";
export const LOOP_CI_WATCH_PLAYBOOK = "loop-ci-watch-playbook";
export const LOOP_GOAL_ACTION_PLAYBOOK = "loop-goal-action-playbook";

const LOCAL_REPORT_TOOLS = [
  TOOL_FILE_READ,
  TOOL_GREP,
  TOOL_GLOB,
  TOOL_GIT_STATUS,
  TOOL_GIT_DIFF,
  TOOL_LSP_DIAGNOSTICS,
  TOOL_LSP_GOTO_DEFINITION,
  TOOL_LSP_FIND_REFERENCES,
  TOOL_LSP_SYMBOLS,
  TOOL_WEB_FETCH,
  TOOL_TODO_WRITE,
  TOOL_ASK_USER,
  TOOL_WAIT_FOR_REMINDER,
  TOOL_BACKGROUND_OUTPUT,
  TOOL_VIEW_TOOL_OUTPUT,
  TOOL_MEMORY_READ,
] as const;

const LOCAL_MAINTENANCE_TOOLS = [
  ...LOCAL_REPORT_TOOLS,
  TOOL_FILE_WRITE,
  TOOL_FILE_EDIT,
  TOOL_AST_GREP_SEARCH,
  TOOL_AST_GREP_REPLACE,
  TOOL_BASH,
  TOOL_DELEGATE,
  TOOL_MEMORY_WRITE,
] as const;

const GOAL_ACTION_TOOLS = [
  ...LOCAL_MAINTENANCE_TOOLS,
  TOOL_GOAL_MANAGE,
] as const;

export interface LoopToolProfile {
  readonly id: LoopToolProfileId;
  readonly allowedTools: readonly string[];
  readonly profileOnlyConnectorTools: readonly string[];
  readonly activeSkillPlaybookIds: readonly string[];
}

export interface ResolveLoopToolProfileInput {
  readonly agentAllowedTools: readonly string[];
  readonly toolProfileId?: LoopToolProfileId;
}

export interface ResolvedLoopToolProfile {
  readonly toolProfileId?: LoopToolProfileId;
  readonly tools: readonly string[];
  readonly activeSkillPlaybookIds: readonly string[];
}

export const LOOP_TOOL_PROFILES = {
  loop_local_report: {
    id: "loop_local_report",
    allowedTools: LOCAL_REPORT_TOOLS,
    profileOnlyConnectorTools: [],
    activeSkillPlaybookIds: [LOOP_LOCAL_REPORT_PLAYBOOK],
  },
  loop_local_maintenance: {
    id: "loop_local_maintenance",
    allowedTools: LOCAL_MAINTENANCE_TOOLS,
    profileOnlyConnectorTools: [],
    activeSkillPlaybookIds: [LOOP_LOCAL_MAINTENANCE_PLAYBOOK],
  },
  loop_github_pr_watch: {
    id: "loop_github_pr_watch",
    allowedTools: LOCAL_REPORT_TOOLS,
    profileOnlyConnectorTools: [
      LOOP_GITHUB_GET_PULL_REQUEST_TOOL,
      LOOP_GITHUB_LIST_PULL_REQUESTS_TOOL,
      LOOP_GITHUB_GET_PULL_REQUEST_CHECKS_TOOL,
      LOOP_GITHUB_LIST_ISSUE_COMMENTS_TOOL,
      LOOP_GITHUB_CREATE_ISSUE_COMMENT_TOOL,
    ],
    activeSkillPlaybookIds: [LOOP_GITHUB_PR_WATCH_PLAYBOOK],
  },
  loop_ci_watch: {
    id: "loop_ci_watch",
    allowedTools: LOCAL_REPORT_TOOLS,
    profileOnlyConnectorTools: [
      LOOP_GITHUB_LIST_WORKFLOW_RUNS_TOOL,
      LOOP_GITHUB_GET_WORKFLOW_RUN_TOOL,
      LOOP_GITHUB_RERUN_WORKFLOW_RUN_TOOL,
    ],
    activeSkillPlaybookIds: [LOOP_CI_WATCH_PLAYBOOK],
  },
  loop_goal_action: {
    id: "loop_goal_action",
    allowedTools: GOAL_ACTION_TOOLS,
    profileOnlyConnectorTools: [],
    activeSkillPlaybookIds: [LOOP_GOAL_ACTION_PLAYBOOK],
  },
} as const satisfies Record<LoopToolProfileId, LoopToolProfile>;

export function getLoopToolProfile(toolProfileId: LoopToolProfileId): LoopToolProfile {
  return LOOP_TOOL_PROFILES[toolProfileId];
}

export function resolveLoopToolProfile(input: ResolveLoopToolProfileInput): ResolvedLoopToolProfile {
  if (input.toolProfileId === undefined) {
    return { tools: [...input.agentAllowedTools], activeSkillPlaybookIds: [] };
  }

  const profile = getLoopToolProfile(input.toolProfileId);
  const profileAllowed = new Set(profile.allowedTools);
  const tools = input.agentAllowedTools.filter((toolName) => profileAllowed.has(toolName));

  for (const connectorTool of profile.profileOnlyConnectorTools) {
    if (!tools.includes(connectorTool)) {
      tools.push(connectorTool);
    }
  }

  return {
    toolProfileId: input.toolProfileId,
    tools,
    activeSkillPlaybookIds: [...profile.activeSkillPlaybookIds],
  };
}
