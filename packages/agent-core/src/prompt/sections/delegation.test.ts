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
      date: "2026-07-12",
    },
  };
}

describe("buildDelegationSection", () => {
  test("omits the protocol when delegate is unavailable", () => {
    expect(buildDelegationSection(makeCtx(["file_read"]))).toBeNull();
  });

  test("defines the strict simple-task gate and gap-driven evidence reuse", () => {
    const result = buildDelegationSection(makeCtx(["delegate", "background_output", "wait_for_reminder"]));

    expect(result).toContain("## Delegation Protocol");
    expect(result).toContain("all six conditions");
    expect(result).toContain("current, direct, scope-complete, and verifiable");
    expect(result).toContain("Reuse sufficient upstream evidence");
    expect(result).toContain("Do not repeat research for ceremony");
    expect(result).toContain("concrete evidence gap");
    expect(result).toContain("Explore child");
    expect(result).toContain("Librarian");
    expect(result).toContain("background=true");
    expect(result).toContain("before waiting for any result");
    expect(result).not.toContain("For every non-trivial task, launch 2-4");
  });

  test("defines the six-part delegation envelope and immutable authority", () => {
    const result = buildDelegationSection(makeCtx(["delegate"]));

    for (const field of [
      "Task",
      "Expected outcome",
      "Context and evidence",
      "Scope ownership and non-goals",
      "Must do / must not do",
      "Verification and output",
    ]) {
      expect(result).toContain(field);
    }
    expect(result).toContain("allowed targets");
    expect(result).toContain("cannot expand hardcoded tools, permissions, targets, or depth");
  });

  test("does not assign implementation orchestration to every delegating role", () => {
    const result = buildDelegationSection(makeCtx(["delegate"]));

    expect(result).toContain("Research delegation never grants implementation authority");
    expect(result).toContain("Only Engineer and Goal Lead may delegate source changes to Build");
    expect(result).toContain("Build may delegate only local research to Explore");
    expect(result).not.toContain("two or more implementation units");
    expect(result).not.toContain("start them as background children");
  });

  test("defines stopped-child resume, terminal collection, and parent verification", () => {
    const result = buildDelegationSection(makeCtx(["delegate"]));

    expect(result).toContain("same agent type");
    expect(result).toContain("stopped child");
    expect(result).toContain("child claim is not evidence");
    expect(result).toContain("terminal result");
    expect(result).toContain("reminder is only a terminal notification");
    expect(result).toContain("blocking background_output");
  });
});
