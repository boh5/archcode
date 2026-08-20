import { describe, expect, it, mock } from "bun:test";
import { ChildSessionNotDescendantError } from "../../agents/errors";
import type { CancelDescendantSession } from "../../delegation/types";
import { storeManager } from "../../store/store";
import { expectTextDraft } from "../test-results";
import type { RawToolResult, ToolExecutionContext } from "../types";
import { createTestProjectContext } from "../test-project-context";
import { CancelSessionInputSchema, cancelSessionTool, executeCancelSession } from "./cancel-session";

const PARENT_SESSION_ID = "parent-session-abc";
const CHILD_SESSION_ID = "child-session-xyz";
const NON_DESCENDANT_ID = "other-session-999";
const WORKSPACE_ROOT = "/workspace/test";

function makeContext(overrides: Partial<ToolExecutionContext> & { cancelDescendantSession?: CancelDescendantSession } = {}): ToolExecutionContext {
  const store = storeManager.create(`cancel-parent-${crypto.randomUUID()}`, WORKSPACE_ROOT, { source: { kind: "direct" }, agentName: "lead" });
  return {
    store,
    toolName: "cancel_session",
    toolCallId: "cancel-call",
    input: {},
    step: 0,
    executionId: "test-execution",
    runOrdinal: 0,
    toolBatchId: "test-tool-batch",
    abort: new AbortController().signal,
    startedAt: 0,
    allowedTools: new Set(["cancel_session"]),
    cwd: WORKSPACE_ROOT,
    storeManager,
    projectContext: createTestProjectContext(WORKSPACE_ROOT),
    agentName: "lead",
    ...overrides,
  } as ToolExecutionContext;
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
    it("returns error when strong-cancel Runtime wiring is undefined", async () => {
      const ctx = makeContext();
      const result = await executeCancelSession({ session_id: CHILD_SESSION_ID }, ctx);
      expect(isToolError(result)).toBe(true);
      if (isToolError(result)) {
        expect(errorOutput(result)).toContain("not available");
      }
    });

    it("returns error when cancelling own session", async () => {
      const callingSessionId = "self-session-id";
      const store = storeManager.create(callingSessionId, WORKSPACE_ROOT, { source: { kind: "direct" }, agentName: "lead" });
      const cancelDescendantSession = mock(async () => "cancelled" as const);
      const ctx = makeContext({
        store,
        cancelDescendantSession,
      });
      const result = await executeCancelSession({ session_id: callingSessionId }, ctx);
      expect(isToolError(result)).toBe(true);
      if (isToolError(result)) {
        expect(errorOutput(result)).toContain("Cannot cancel own session");
      }
      expect(cancelDescendantSession).not.toHaveBeenCalled();
    });

    it("cancels a running descendant and returns success", async () => {
      const cancelDescendantSession = mock(async () => "cancelled" as const);
      const ctx = makeContext({
        cancelDescendantSession,
      });
      const callingSessionId = ctx.store.getState().sessionId;
      const result = await executeCancelSession({ session_id: CHILD_SESSION_ID }, ctx);
      expect(isToolError(result)).toBe(false);
      expect(expectTextDraft(result)).toContain(CHILD_SESSION_ID);
      expect(cancelDescendantSession).toHaveBeenCalledTimes(1);
      expect(cancelDescendantSession).toHaveBeenCalledWith(WORKSPACE_ROOT, callingSessionId, CHILD_SESSION_ID);
    });

    it("returns error when target is not a descendant (ChildSessionNotDescendantError)", async () => {
      const cancelDescendantSession = mock(async () => {
        throw new ChildSessionNotDescendantError(PARENT_SESSION_ID, NON_DESCENDANT_ID);
      });
      const ctx = makeContext({
        cancelDescendantSession,
      });
      const result = await executeCancelSession({ session_id: NON_DESCENDANT_ID }, ctx);
      expect(isToolError(result)).toBe(true);
      if (isToolError(result)) {
        expect(result.details?.error?.name).toBe("ChildSessionNotDescendantError");
        expect(errorOutput(result)).toContain("not a descendant");
      }
    });

    it("returns already_stopped only after the strong-cancel owner confirms the whole subtree", async () => {
      const cancelDescendantSession = mock(async () => "already_stopped" as const);
      const ctx = makeContext({
        cancelDescendantSession,
      });
      const result = await executeCancelSession({ session_id: CHILD_SESSION_ID }, ctx);
      expect(isToolError(result)).toBe(false);
      expect(expectTextDraft(result)).toContain("already_stopped");
    });

    it("returns error when target session does not exist (callback throws generic error)", async () => {
      const cancelDescendantSession = mock(async () => {
        throw new Error(`Session "${CHILD_SESSION_ID}" not found`);
      });
      const ctx = makeContext({
        cancelDescendantSession,
      });
      const result = await executeCancelSession({ session_id: CHILD_SESSION_ID }, ctx);
      expect(isToolError(result)).toBe(true);
      if (isToolError(result)) {
        expect(errorOutput(result)).toContain("not found");
      }
    });
  });
});
