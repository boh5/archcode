import { describe, expect, test } from "bun:test";
import type { LoopToolProfileId } from "@archcode/protocol";
import {
  LOOP_CI_WATCH_PLAYBOOK,
  LOOP_GITHUB_PR_WATCH_PLAYBOOK,
  LOOP_GITHUB_CREATE_ISSUE_COMMENT_TOOL,
  LOOP_GITHUB_GET_PULL_REQUEST_CHECKS_TOOL,
  LOOP_GITHUB_GET_PULL_REQUEST_TOOL,
  LOOP_GITHUB_GET_WORKFLOW_RUN_TOOL,
  LOOP_GITHUB_LIST_ISSUE_COMMENTS_TOOL,
  LOOP_GITHUB_LIST_PULL_REQUESTS_TOOL,
  LOOP_GITHUB_LIST_WORKFLOW_RUNS_TOOL,
  LOOP_GITHUB_RERUN_WORKFLOW_RUN_TOOL,
  LOOP_GOAL_ACTION_PLAYBOOK,
  LOOP_LOCAL_MAINTENANCE_PLAYBOOK,
  LOOP_LOCAL_REPORT_PLAYBOOK,
  LOOP_PROFILE_ONLY_CONNECTOR_TOOLS,
  LOOP_TOOL_PROFILES,
  resolveLoopToolProfile,
} from "./tool-profiles";

const PROFILE_IDS = [
  "loop_local_report",
  "loop_local_maintenance",
  "loop_github_pr_watch",
  "loop_ci_watch",
  "loop_goal_action",
] as const satisfies readonly LoopToolProfileId[];

const EXPECTED_PLAYBOOKS = {
  loop_local_report: [LOOP_LOCAL_REPORT_PLAYBOOK],
  loop_local_maintenance: [LOOP_LOCAL_MAINTENANCE_PLAYBOOK],
  loop_github_pr_watch: [LOOP_GITHUB_PR_WATCH_PLAYBOOK],
  loop_ci_watch: [LOOP_CI_WATCH_PLAYBOOK],
  loop_goal_action: [LOOP_GOAL_ACTION_PLAYBOOK],
} as const satisfies Record<LoopToolProfileId, readonly string[]>;

describe("Loop tool profiles", () => {
  test("defines every fixed code-owned Loop profile id", () => {
    expect(Object.keys(LOOP_TOOL_PROFILES).sort()).toEqual([...PROFILE_IDS].sort());
    expect(LOOP_TOOL_PROFILES.loop_local_maintenance.id).toBe("loop_local_maintenance");
    expect("loop_local_action" in LOOP_TOOL_PROFILES).toBe(false);
  });

  test("returns default agent tools unchanged when no Loop profile is selected", () => {
    const tools = ["file_read", "github_get_pull_request", "bash"];
    const resolved = resolveLoopToolProfile({ agentAllowedTools: tools });

    expect(resolved.tools).toEqual(tools);
    expect(resolved.activeSkillPlaybookIds).toEqual([]);
  });

  test("defines deterministic prompt-only playbook ids for every profile", () => {
    for (const profileId of PROFILE_IDS) {
      expect(LOOP_TOOL_PROFILES[profileId].activeSkillPlaybookIds).toEqual(EXPECTED_PLAYBOOKS[profileId]);
      expect(resolveLoopToolProfile({ agentAllowedTools: [], toolProfileId: profileId }).activeSkillPlaybookIds)
        .toEqual(EXPECTED_PLAYBOOKS[profileId]);
    }
  });

  test("narrows normal tools to the agent/profile intersection", () => {
    const resolved = resolveLoopToolProfile({
      agentAllowedTools: ["file_read", "file_write", "bash", "github_get_pull_request"],
      toolProfileId: "loop_local_report",
    });

    expect(resolved.tools).toEqual(["file_read"]);
  });

  test("adds only explicitly approved PR-watch profile connector placeholders", () => {
    const resolved = resolveLoopToolProfile({
      agentAllowedTools: ["file_read", "file_write", "bash"],
      toolProfileId: "loop_github_pr_watch",
    });

    expect(resolved.tools).toEqual([
      "file_read",
      LOOP_GITHUB_GET_PULL_REQUEST_TOOL,
      LOOP_GITHUB_LIST_PULL_REQUESTS_TOOL,
      LOOP_GITHUB_GET_PULL_REQUEST_CHECKS_TOOL,
      LOOP_GITHUB_LIST_ISSUE_COMMENTS_TOOL,
      LOOP_GITHUB_CREATE_ISSUE_COMMENT_TOOL,
    ]);
    expect(resolved.tools).not.toContain(LOOP_GITHUB_RERUN_WORKFLOW_RUN_TOOL);
  });

  test("keeps CI rerun connector limited to the CI-watch profile", () => {
    const ci = resolveLoopToolProfile({ agentAllowedTools: ["file_read"], toolProfileId: "loop_ci_watch" });
    const pr = resolveLoopToolProfile({ agentAllowedTools: ["file_read"], toolProfileId: "loop_github_pr_watch" });

    expect(ci.tools).toContain(LOOP_GITHUB_LIST_WORKFLOW_RUNS_TOOL);
    expect(ci.tools).toContain(LOOP_GITHUB_GET_WORKFLOW_RUN_TOOL);
    expect(ci.tools).toContain(LOOP_GITHUB_RERUN_WORKFLOW_RUN_TOOL);
    expect(pr.tools).not.toContain(LOOP_GITHUB_RERUN_WORKFLOW_RUN_TOOL);
  });

  test("does not expose merge, approve, rebase, or force-push connector capabilities", () => {
    const allProfileTools = Object.values(LOOP_TOOL_PROFILES).flatMap((profile) => [
      ...profile.allowedTools,
      ...profile.profileOnlyConnectorTools,
    ]);

    expect(LOOP_PROFILE_ONLY_CONNECTOR_TOOLS.length).toBeGreaterThan(0);
    expect(allProfileTools.filter((toolName) => /merge|approve|rebase|force.?push/i.test(toolName))).toEqual([]);
  });

  test("registered profile-only connector names remain limited to safe GitHub watch and rerun actions", () => {
    const expectedConnectorTools = [
      LOOP_GITHUB_GET_PULL_REQUEST_TOOL,
      LOOP_GITHUB_LIST_PULL_REQUESTS_TOOL,
      LOOP_GITHUB_GET_PULL_REQUEST_CHECKS_TOOL,
      LOOP_GITHUB_LIST_ISSUE_COMMENTS_TOOL,
      LOOP_GITHUB_CREATE_ISSUE_COMMENT_TOOL,
      LOOP_GITHUB_LIST_WORKFLOW_RUNS_TOOL,
      LOOP_GITHUB_GET_WORKFLOW_RUN_TOOL,
      LOOP_GITHUB_RERUN_WORKFLOW_RUN_TOOL,
    ] as const satisfies typeof LOOP_PROFILE_ONLY_CONNECTOR_TOOLS;

    expect(LOOP_PROFILE_ONLY_CONNECTOR_TOOLS).toEqual(expectedConnectorTools);
  });

  test("playbook ids are prompt-only metadata and do not grant tools", () => {
    const withoutAgentTools = resolveLoopToolProfile({
      agentAllowedTools: [],
      toolProfileId: "loop_github_pr_watch",
    });
    const withReadTool = resolveLoopToolProfile({
      agentAllowedTools: ["file_read"],
      toolProfileId: "loop_github_pr_watch",
    });

    expect(withoutAgentTools.activeSkillPlaybookIds).toEqual([LOOP_GITHUB_PR_WATCH_PLAYBOOK]);
    expect(withoutAgentTools.tools).toEqual([
      LOOP_GITHUB_GET_PULL_REQUEST_TOOL,
      LOOP_GITHUB_LIST_PULL_REQUESTS_TOOL,
      LOOP_GITHUB_GET_PULL_REQUEST_CHECKS_TOOL,
      LOOP_GITHUB_LIST_ISSUE_COMMENTS_TOOL,
      LOOP_GITHUB_CREATE_ISSUE_COMMENT_TOOL,
    ]);
    expect(withoutAgentTools.tools).not.toContain("file_read");
    expect(withReadTool.activeSkillPlaybookIds).toEqual(withoutAgentTools.activeSkillPlaybookIds);
    expect(withReadTool.tools).toEqual(["file_read", ...withoutAgentTools.tools]);
  });
});
