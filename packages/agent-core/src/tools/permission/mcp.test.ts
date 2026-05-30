import { describe, expect, test } from "bun:test";
import { storeManager } from "../../store/store";
import { createMcpDestructivePermission } from "./mcp";
import type { ToolExecutionContext } from "../types";
import { createTestProjectContext } from "../test-project-context";

function mockCtx(): ToolExecutionContext {
  return {
    store: {} as any,
    storeManager,
    toolName: "test",
    toolCallId: "call_1",
    input: {},
    step: 1,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(),
    workspaceRoot: "/tmp",
    projectContext: createTestProjectContext("/tmp"),
  };
}

describe("createMcpDestructivePermission", () => {
  test("returns ask outcome with server and tool name in reason", async () => {
    const perm = createMcpDestructivePermission("my-server", "delete_item");
    const decision = await perm({}, mockCtx());

    expect(decision.outcome).toBe("ask");
    expect(decision.reason).toContain("my-server");
    expect(decision.reason).toContain("delete_item");
    expect(decision.prompt).toContain("delete_item");
    expect(decision.prompt).toContain("my-server");
  });

  test("returns ask outcome for different server/tool combinations", async () => {
    const perm = createMcpDestructivePermission("github", "create_issue");
    const decision = await perm({}, mockCtx());

    expect(decision.outcome).toBe("ask");
    expect(decision.reason).toContain("github");
    expect(decision.reason).toContain("create_issue");
  });

  test("decision has no errorKind or errorCode", async () => {
    const perm = createMcpDestructivePermission("srv", "tool");
    const decision = await perm({}, mockCtx());

    expect(decision.errorKind).toBeUndefined();
    expect(decision.errorCode).toBeUndefined();
  });
});
