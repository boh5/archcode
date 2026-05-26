import { describe, expect, it } from "bun:test";
import { storeManager } from "../../store/store";
import type { ToolExecutionContext } from "../types";
import { executeBackgroundOutput } from "./background-output";
import { createTestProjectContext } from "../test-project-context";

function makeContext(parentId = `background-parent-${crypto.randomUUID()}`): ToolExecutionContext {
  return {
    store: storeManager.create(parentId),
    toolName: "background_output",
    toolCallId: "background-output-call",
    input: {},
    step: 0,
    abort: new AbortController().signal,
    startedAt: 0,
    allowedTools: new Set(["background_output"]),
    workspaceRoot: import.meta.dir,
    projectContext: createTestProjectContext(import.meta.dir),
  };
}

describe("background_output tool", () => {
  it("returns last assistant text from a known child store", () => {
    const ctx = makeContext();
    const childStore = storeManager.create(`background-child-${crypto.randomUUID()}`);
    ctx.store.setState({ childSessionIds: new Set([childStore.getState().sessionId]) });
    childStore.getState().append({ type: "text-start" });
    childStore.getState().append({ type: "text-delta", text: "first" });
    childStore.getState().append({ type: "text-end" });
    childStore.getState().append({ type: "run-end", status: "completed" });
    childStore.getState().append({ type: "text-start" });
    childStore.getState().append({ type: "text-delta", text: "latest" });
    childStore.getState().append({ type: "text-end" });

    const result = executeBackgroundOutput({ session_id: childStore.getState().sessionId }, ctx);

    expect(result).toBe("latest");
  });

  it("returns running guidance when child has no assistant output", () => {
    const ctx = makeContext();
    const childStore = storeManager.create(`background-child-${crypto.randomUUID()}`);
    ctx.store.setState({ childSessionIds: new Set([childStore.getState().sessionId]) });

    const result = executeBackgroundOutput({ session_id: childStore.getState().sessionId }, ctx);

    expect(result).toBe("Sub-agent is still running. Use wait_for_reminder to wait for completion.");
  });

  it("rejects unknown child session ids", () => {
    const result = executeBackgroundOutput({ session_id: "missing" }, makeContext());

    expect(typeof result).toBe("object");
    expect((result as { isError: boolean }).isError).toBe(true);
    expect((result as { output: string }).output).toContain("Unknown child session_id: missing");
  });
});
