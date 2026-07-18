import { describe, expect, test } from "bun:test";
import { buildDelegationSection } from "./delegation";
import type { PromptContext } from "../types";

function makeCtx(allowedTools: readonly string[]): PromptContext {
  return {
    allowedTools,
    promptProfileId: "test",
    env: {
      platform: "darwin",
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
      projectRoot: "/workspace",
      cwd: "/workspace",
      versionControl: "git",
      date: "2026-07-12",
    },
  };
}

describe("buildDelegationSection", () => {
  test("omits the policy when delegate is unavailable", () => {
    expect(buildDelegationSection(makeCtx(["file_read"]))).toBeNull();
  });

  test("defines the strict simple-task gate and gap-driven evidence reuse", () => {
    const result = buildDelegationSection(makeCtx(["delegate", "background_output", "wait_for_reminder"]));

    expect(result).toContain("## Delegation Policy");
    expect(result).toContain("all six conditions");
    expect(result).toContain("current, direct, scope-complete, and verifiable");
    expect(result).toContain("Reuse sufficient upstream evidence");
    expect(result).toContain("Do not repeat research for ceremony");
    expect(result).toContain("concrete evidence gap");
    expect(result).toContain("Explore child");
    expect(result).toContain("Librarian");
    expect(result).toContain("Start independent children before waiting");
    expect(result).not.toContain("For every non-trivial task, launch 2-4");
  });

  test("keeps immutable authority while leaving field instructions to the tool contract", () => {
    const result = buildDelegationSection(makeCtx(["delegate"]));

    expect(result).toContain("allowed targets");
    expect(result).toContain("never expands hardcoded tools, permissions, targets, or depth");
    expect(result).not.toContain("Encode all six fields");
    expect(result).not.toContain("Expected outcome —");
    expect(result).not.toContain("background=true");
  });

  test("does not assign implementation orchestration to every delegating role", () => {
    const result = buildDelegationSection(makeCtx(["delegate"]));

    expect(result).toContain("Research delegation never grants implementation authority");
    expect(result).toContain("Only Engineer and Goal Lead may delegate source changes to Build");
    expect(result).toContain("Build may delegate only local research to Explore");
    expect(result).not.toContain("two or more implementation units");
    expect(result).not.toContain("start them as background children");
  });

  test("requires parent acceptance without duplicating lifecycle tool manuals", () => {
    const result = buildDelegationSection(makeCtx(["delegate"]));

    expect(result).toContain("child claim is not evidence");
    expect(result).toContain("test output, and diff");
    expect(result).toContain("terminal deliverable");
    expect(result).toContain("completion notification is not evidence");
    expect(result).not.toContain("resume_session");
    expect(result).not.toContain("wait_for_reminder");
    expect(result).not.toContain("background_output");
    expect(result).not.toContain("session_id");
  });
});
