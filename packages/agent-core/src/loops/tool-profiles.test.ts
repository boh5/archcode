import { describe, expect, test } from "bun:test";
import type { LoopToolProfileId } from "@archcode/protocol";
import {
  LOOP_GITHUB_CREATE_ISSUE_COMMENT_TOOL,
  LOOP_GITHUB_GET_PULL_REQUEST_CHECKS_TOOL,
  LOOP_GITHUB_GET_PULL_REQUEST_TOOL,
  LOOP_GITHUB_GET_WORKFLOW_RUN_TOOL,
  LOOP_GITHUB_LIST_ISSUE_COMMENTS_TOOL,
  LOOP_GITHUB_LIST_PULL_REQUESTS_TOOL,
  LOOP_GITHUB_LIST_WORKFLOW_RUNS_TOOL,
  LOOP_GITHUB_RERUN_WORKFLOW_RUN_TOOL,
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

describe("Loop tool profiles", () => {
  test("defines every fixed code-owned Loop profile id", () => {
    expect(Object.keys(LOOP_TOOL_PROFILES).sort()).toEqual([...PROFILE_IDS].sort());
    expect(LOOP_TOOL_PROFILES.loop_local_maintenance.id).toBe("loop_local_maintenance");
    expect("loop_local_action" in LOOP_TOOL_PROFILES).toBe(false);
  });

  test("returns default agent tools unchanged when no Loop profile is selected", () => {
    const tools = ["file_read", "github_get_pull_request", "bash"];

    expect(resolveLoopToolProfile({ agentAllowedTools: tools }).tools).toEqual(tools);
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
});
