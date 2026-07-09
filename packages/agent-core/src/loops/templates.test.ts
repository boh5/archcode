import { describe, expect, test } from "bun:test";

import { LoopConfigSchema } from "./state";
import {
  LOOP_TEMPLATE_IDS,
  PR_BABYSITTER_EXTRA_TOOLS,
  expandLoopTemplate,
  getLoopTemplate,
  isLoopTemplateId,
} from "./templates";

const REMOVED_TEMPLATE_IDS = [
  "daily_triage",
  "changelog_drafter",
  "ci_sweeper",
  "dependency_sweeper",
  "post_merge_cleanup",
  "issue_triage",
] as const;

const REMOVED_PROFILE_IDS = [
  "loop_local_report",
  "loop_local_maintenance",
  "loop_github_pr_watch",
  "loop_ci_watch",
  "loop_goal_action",
] as const;

const FORBIDDEN_REPLACEMENT_PROFILE_IDS = [
  "loop_watch_report",
  "loop_maintain_fix",
  "loop_pr_babysitter",
  "loop_goal_runner",
] as const;

describe("Loop templates", () => {
  test("supports exactly four stable template ids", () => {
    expect(LOOP_TEMPLATE_IDS).toEqual([
      "watch_report",
      "maintain_fix",
      "pr_babysitter",
      "goal_runner",
    ]);
    expect(LOOP_TEMPLATE_IDS.every(isLoopTemplateId)).toBe(true);
    expect(isLoopTemplateId("daily_triage")).toBe(false);
    expect(isLoopTemplateId("loop_pr_babysitter")).toBe(false);
  });

  test("defines template-owned run primitives and no profile-like selector", () => {
    expect(getLoopTemplate("watch_report").run).toEqual({ type: "session", agent: "plan" });
    expect(getLoopTemplate("maintain_fix").run).toEqual({ type: "session", agent: "build" });
    expect(getLoopTemplate("pr_babysitter").run).toEqual({ type: "session", agent: "plan" });
    expect(getLoopTemplate("goal_runner").run).toEqual({ type: "goal", agent: "orchestrator" });

    for (const id of LOOP_TEMPLATE_IDS) {
      const template = getLoopTemplate(id);
      expect(Object.keys(template)).toEqual(["id", "label", "description", "run", "extraTools", "defaults"]);
      expect(Object.keys(template.run)).toEqual(["type", "agent"]);
      expect(JSON.stringify(template)).not.toMatch(/mode|capability|behavior|toolMode|toolSet|toolProfileId/);
    }
  });

  test("defines exact PR Babysitter connector extras only", () => {
    expect(PR_BABYSITTER_EXTRA_TOOLS).toEqual([
      "github_get_pull_request",
      "github_list_pull_requests",
      "github_get_pull_request_checks",
      "github_list_issue_comments",
      "github_create_issue_comment",
    ]);
    expect(getLoopTemplate("pr_babysitter").extraTools).toEqual(PR_BABYSITTER_EXTRA_TOOLS);

    for (const id of LOOP_TEMPLATE_IDS.filter((templateId) => templateId !== "pr_babysitter")) {
      expect(getLoopTemplate(id).extraTools).toEqual([]);
    }
  });

  test("expands templates to simplified persisted LoopConfig", () => {
    for (const id of LOOP_TEMPLATE_IDS) {
      const config = LoopConfigSchema.parse(expandLoopTemplate(id));
      expect(config.templateId).toBe(id);
      expect(config.schedule).toEqual({ kind: "manual" });
      expect(config.useWorktree).toBeUndefined();
      expect(config.limits.maxIterationsPerRun).toBeGreaterThan(0);
      expect(config.budget).toBeUndefined();
      expect(JSON.stringify(config)).not.toMatch(/runKind|mode|toolProfileId|sourcePreset|presetId|extraTools/);
    }
  });

  test("keeps manual worktree opt-in absent unless explicitly configured", () => {
    const base = expandLoopTemplate("maintain_fix");
    expect(LoopConfigSchema.parse(base).useWorktree).toBeUndefined();
    expect(LoopConfigSchema.parse({ ...base, useWorktree: false }).useWorktree).toBe(false);
    expect(LoopConfigSchema.parse({ ...base, useWorktree: true }).useWorktree).toBe(true);
  });

  test("rejects removed ids and does not provide fallback aliases", () => {
    for (const id of [...REMOVED_TEMPLATE_IDS, ...REMOVED_PROFILE_IDS, ...FORBIDDEN_REPLACEMENT_PROFILE_IDS]) {
      expect(isLoopTemplateId(id)).toBe(false);
      expect(() => getLoopTemplate(id)).toThrow(RangeError);
      expect(() => expandLoopTemplate(id)).toThrow(RangeError);
    }
  });

  test("LoopConfigSchema rejects removed public selectors", () => {
    const config = expandLoopTemplate("watch_report");
    for (const key of ["runKind", "mode", "toolProfileId", "sourcePreset", "presetId", "extraTools", "capability", "behavior", "toolMode", "toolSet"]) {
      expect(() => LoopConfigSchema.parse({ ...config, [key]: "removed" })).toThrow();
    }
  });
});
