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

test("buildLifecycleCurrentContext snapshots Todo intent without Session Goal state", () => {
  expect(buildLifecycleCurrentContext(
    { id: "todo-1", title: "Prompt architecture", body: "Keep compiler pure" },
  )).toEqual([
    "todoId=todo-1",
    'todoTitle="Prompt architecture"',
    'todoBody="Keep compiler pure"',
  ]);
});
