import { describe, expect, test } from "bun:test";
import { buildLifecycleCurrentContext, mapMcpServerStatusForPrompt } from "./configured-agent";

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

test("buildLifecycleCurrentContext snapshots available Goal and Todo intent without manager dependencies", () => {
  expect(buildLifecycleCurrentContext(
    { instanceId: "goal-1", generation: 3, status: "active", objective: "Ship Prompt V2 and pass AC-01 through AC-08" },
    { id: "todo-1", title: "Prompt architecture", body: "Keep compiler pure" },
  )).toEqual([
    "goalInstanceId=goal-1",
    "goalStatus=active",
    "goalGeneration=3",
    'goalObjective="Ship Prompt V2 and pass AC-01 through AC-08"',
    "todoId=todo-1",
    'todoTitle="Prompt architecture"',
    'todoBody="Keep compiler pure"',
  ]);
});
