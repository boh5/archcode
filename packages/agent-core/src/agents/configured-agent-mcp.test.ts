import { describe, expect, test } from "bun:test";
import { buildLifecycleCurrentContext, mapMcpServerStatusForPrompt } from "./configured-agent";

describe("mapMcpServerStatusForPrompt", () => {
  test("projects real frozen runtime states without guessing from tool names", () => {
    expect(mapMcpServerStatusForPrompt(undefined)).toBe("connecting");
    expect(mapMcpServerStatusForPrompt({ state: "connecting", startedAt: 1 })).toBe("connecting");
    expect(mapMcpServerStatusForPrompt({ state: "ready", toolCount: 0, warningCount: 1, connectedAt: 2 })).toBe("ready-zero");
    expect(mapMcpServerStatusForPrompt({ state: "ready", toolCount: 2, warningCount: 0, connectedAt: 2 })).toBe("ready");
    expect(mapMcpServerStatusForPrompt({ state: "ready", toolCount: 2, warningCount: 1, connectedAt: 2 })).toBe("partial-warning");
    expect(mapMcpServerStatusForPrompt({ state: "failed", error: "offline", failedAt: 2 })).toBe("failed");
    expect(mapMcpServerStatusForPrompt({ state: "disabled", updatedAt: 2 })).toBe("disabled");
  });
});

test("buildLifecycleCurrentContext snapshots Todo intent without Session Goal state", () => {
  expect(buildLifecycleCurrentContext(
    {
      id: "todo-1",
      revision: 4,
      status: "ready",
      content: "Prompt architecture\n\nKeep compiler pure",
    },
    { path: ".archcode/plans/todo-1.md", state: "present" },
  )).toEqual([
    "todoId=todo-1",
    "todoRevision=4",
    "todoStatus=ready",
    "todoArchived=false",
    "todoRejectionReason=none",
    'todoContent="Prompt architecture\\n\\nKeep compiler pure"',
    'todoPlanPath=".archcode/plans/todo-1.md"',
    "todoPlanState=present",
  ]);
});
