import { describe, expect, it, mock } from "bun:test";
import { ChildSessionNotDescendantError } from "../../agents/errors";
import { storeManager } from "../../store/store";
import { expectTextDraft } from "../test-results";
import type { RawToolResult, ToolExecutionContext } from "../types";
import { createTestProjectContext } from "../test-project-context";
import { CancelSessionInputSchema, cancelSessionTool, executeCancelSession } from "./cancel-session";

const PARENT_SESSION_ID = "parent-session-abc";
const CHILD_SESSION_ID = "child-session-xyz";
const NON_DESCENDANT_ID = "other-session-999";
const WORKSPACE_ROOT = "/workspace/test";

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  const store = storeManager.create(`cancel-parent-${crypto.randomUUID()}`, WORKSPACE_ROOT, { agentName: "lead" });
  return {
    store,
    toolName: "cancel_session",
    toolCallId: "cancel-call",
    input: {},
    step: 0,
    abort: new AbortController().signal,
    startedAt: 0,
    allowedTools: new Set(["cancel_session"]),
    cwd: WORKSPACE_ROOT,
    storeManager,
    projectContext: createTestProjectContext(WORKSPACE_ROOT),
    agentName: "lead",
    ...overrides,
  };
}

function isToolError(result: RawToolResult): boolean {
  return result.isError;
}

function errorOutput(result: RawToolResult): string {
  return expectTextDraft(result);
}

describe("cancel_session tool", () => {
  describe("schema", () => {
    it("accepts a non-empty session_id", () => {
      expect(CancelSessionInputSchema.safeParse({ session_id: "abc-123" }).success).toBe(true);
    });

    it("rejects empty session_id", () => {
      expect(CancelSessionInputSchema.safeParse({ session_id: "" }).success).toBe(false);
    });

    it("rejects missing session_id", () => {
      expect(CancelSessionInputSchema.safeParse({}).success).toBe(false);
    });

    it("rejects unknown fields (strict)", () => {
      expect(CancelSessionInputSchema.safeParse({ session_id: "abc", extra: true }).success).toBe(false);
    });
  });

  describe("traits", () => {
    it("is destructive and not read-only and not concurrency-safe", () => {
      expect(cancelSessionTool.traits).toEqual({
        readOnly: false,
        destructive: true,
        concurrencySafe: false,
      });
    });

    it("has name cancel_session", () => {
      expect(cancelSessionTool.name).toBe("cancel_session");
    });
  });

  describe("execute", () => {
    it("returns error when ctx.cancelChildSession is undefined", async () => {
      const ctx = makeContext({ cancelChildSession: undefined });
      const result = await executeCancelSession({ session_id: CHILD_SESSION_ID }, ctx);
      expect(isToolError(result)).toBe(true);
      if (isToolError(result)) {
        expect(errorOutput(result)).toContain("not available");
      }
    });

    it("returns error when cancelling own session", async () => {
      const callingSessionId = "self-session-id";
      const store = storeManager.create(callingSessionId, WORKSPACE_ROOT, { agentName: "lead" });
      const cancelChildSession = mock(() => true);
      const ctx = makeContext({
        store,
        cancelChildSession: cancelChildSession as unknown as ToolExecutionContext["cancelChildSession"],
      });
      const result = await executeCancelSession({ session_id: callingSessionId }, ctx);
      expect(isToolError(result)).toBe(true);
      if (isToolError(result)) {
        expect(errorOutput(result)).toContain("Cannot cancel own session");
      }
      expect(cancelChildSession).not.toHaveBeenCalled();
    });

    it("cancels a running descendant and returns success", async () => {
      const cancelChildSession = mock(() => true);
      const ctx = makeContext({
        cancelChildSession: cancelChildSession as unknown as ToolExecutionContext["cancelChildSession"],
      });
      const callingSessionId = ctx.store.getState().sessionId;
      const result = await executeCancelSession({ session_id: CHILD_SESSION_ID }, ctx);
      expect(isToolError(result)).toBe(false);
      expect(expectTextDraft(result)).toContain(CHILD_SESSION_ID);
      expect(cancelChildSession).toHaveBeenCalledTimes(1);
      expect(cancelChildSession).toHaveBeenCalledWith(WORKSPACE_ROOT, callingSessionId, CHILD_SESSION_ID);
    });

    it("returns error when target is not a descendant (ChildSessionNotDescendantError)", async () => {
      const cancelChildSession = mock(() => {
        throw new ChildSessionNotDescendantError(PARENT_SESSION_ID, NON_DESCENDANT_ID);
      });
      const ctx = makeContext({
        cancelChildSession: cancelChildSession as unknown as ToolExecutionContext["cancelChildSession"],
      });
      const result = await executeCancelSession({ session_id: NON_DESCENDANT_ID }, ctx);
      expect(isToolError(result)).toBe(true);
      if (isToolError(result)) {
        expect(result.details?.error?.name).toBe("ChildSessionNotDescendantError");
        expect(errorOutput(result)).toContain("not a descendant");
      }
    });

    it("returns info message when session is not running (callback returns false)", async () => {
      const cancelChildSession = mock(() => false);
      const ctx = makeContext({
        cancelChildSession: cancelChildSession as unknown as ToolExecutionContext["cancelChildSession"],
      });
      const result = await executeCancelSession({ session_id: CHILD_SESSION_ID }, ctx);
      expect(isToolError(result)).toBe(false);
      expect(expectTextDraft(result)).toContain("not running");
    });

    it("returns error when target session does not exist (callback throws generic error)", async () => {
      const cancelChildSession = mock(() => {
        throw new Error(`Session "${CHILD_SESSION_ID}" not found`);
      });
      const ctx = makeContext({
        cancelChildSession: cancelChildSession as unknown as ToolExecutionContext["cancelChildSession"],
      });
      const result = await executeCancelSession({ session_id: CHILD_SESSION_ID }, ctx);
      expect(isToolError(result)).toBe(true);
      if (isToolError(result)) {
        expect(errorOutput(result)).toContain("not found");
      }
    });
  });
});
