import { describe, expect, test } from "bun:test";
import { formatGoalWorktreeStatus } from "./GoalInspector";

describe("formatGoalWorktreeStatus", () => {
  test("distinguishes disabled, pending, and active worktree states", () => {
    expect(formatGoalWorktreeStatus({ useWorktree: false })).toBe("disabled");
    expect(formatGoalWorktreeStatus({ useWorktree: true })).toBe("pending");
    expect(formatGoalWorktreeStatus({
      useWorktree: true,
      worktree: {
        path: "/workspace/goal",
        branchName: "codex/goal",
        baseSha: "abc123",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    })).toBe("active");
  });
});
