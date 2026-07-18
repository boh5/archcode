import { describe, expect, test } from "bun:test";
import { buildLifecycleCurrentContext, filterRoleVisibleTools, mapMcpServerStatusForPrompt } from "./configured-agent";

describe("mapMcpServerStatusForPrompt", () => {
  test("projects real frozen runtime states without guessing from tool names", () => {
    expect(mapMcpServerStatusForPrompt(undefined)).toBe("pending");
    expect(mapMcpServerStatusForPrompt({ state: "pending" })).toBe("pending");
    expect(mapMcpServerStatusForPrompt({ state: "ready", toolCount: 0, warningCount: 1 })).toBe("ready-zero");
    expect(mapMcpServerStatusForPrompt({ state: "ready", toolCount: 2, warningCount: 0 })).toBe("ready");
    expect(mapMcpServerStatusForPrompt({ state: "ready", toolCount: 2, warningCount: 1 })).toBe("partial-warning");
    expect(mapMcpServerStatusForPrompt({ state: "failed", error: "offline" })).toBe("failed");
    expect(mapMcpServerStatusForPrompt({ state: "disabled" })).toBe("failed");
  });
});

describe("filterRoleVisibleTools", () => {
  test("separates ordinary child submission from Goal Reviewer finalization", () => {
    const base = ["file_read", "goal_manage", "submit_child_result"];
    expect(filterRoleVisibleTools("reviewer", undefined, base)).toEqual(["file_read", "submit_child_result"]);
    expect(filterRoleVisibleTools("reviewer", "goal-1", base)).toEqual(["file_read", "goal_manage"]);
    expect(filterRoleVisibleTools("explore", "goal-1", base)).toEqual(base);
  });
});

test("buildLifecycleCurrentContext snapshots available Goal and Todo intent without manager dependencies", () => {
  expect(buildLifecycleCurrentContext(
    { sessionRole: "review", goalId: "goal-1" },
    { status: "reviewing", reviewGeneration: 3, objective: "Ship Prompt V2", acceptanceCriteria: "AC-01 through AC-08 pass" },
    { id: "todo-1", title: "Prompt architecture", body: "Keep compiler pure" },
  )).toEqual([
    "sessionRole=review",
    "goalId=goal-1",
    "goalStatus=reviewing",
    "reviewGeneration=3",
    'goalObjective="Ship Prompt V2"',
    'goalAcceptanceCriteria="AC-01 through AC-08 pass"',
    "todoId=todo-1",
    'todoTitle="Prompt architecture"',
    'todoBody="Keep compiler pure"',
  ]);
});
