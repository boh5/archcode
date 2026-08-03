import { describe, expect, it } from "bun:test";
import type { ChildExecutionHandle, ResumeChildRequest } from "../../delegation/types";
import { testExecutionEnd, testExecutionStart } from "../../testing/test-execution-fixtures";
import { storeManager } from "../../store/store";
import type { ToolExecutionContext } from "../types";
import { createTestProjectContext } from "../test-project-context";
import { executeResumeSession, ResumeSessionInputSchema } from "./resume-session";

const WORKSPACE_ROOT = import.meta.dir;

function context(resumeChildSession?: ToolExecutionContext["resumeChildSession"]): ToolExecutionContext {
  const store = storeManager.create(crypto.randomUUID(), WORKSPACE_ROOT, { source: { kind: "direct" }, agentName: "lead" });
  return {
    store,
    storeManager,
    toolName: "resume_session",
    toolCallId: "resume-call",
    input: {},
    step: 0,
    executionId: "parent-execution",
    runOrdinal: 1,
    toolBatchId: "parent-batch",
    abort: new AbortController().signal,
    startedAt: 0,
    allowedTools: new Set(["delegate", "resume_session"]),
    cwd: WORKSPACE_ROOT,
    projectContext: createTestProjectContext(WORKSPACE_ROOT),
    resumeChildSession,
  };
}

function handle(parentSessionId: string): ChildExecutionHandle {
  const store = storeManager.create(crypto.randomUUID(), WORKSPACE_ROOT, {
    agentName: "build",
    parentSessionId,
    title: "Original title",
  });
  const executionId = crypto.randomUUID();
  store.getState().append(testExecutionStart(executionId));
  const endedAt = Date.now() + 1;
  store.getState().append(testExecutionEnd(executionId, "failed", { endedAt, runEndedAt: endedAt }));
  return {
    sessionId: store.getState().sessionId,
    executionId: "child-execution",
    store,
    result: Promise.resolve({
      outcome: "terminal",
      executionId: "child-execution",
      executionStatus: "failed",
    }),
    abort: () => {},
  };
}

describe("resume_session V2 contract", () => {
  it("accepts only required session_id, instruction, and background", () => {
    const valid = { session_id: "child", instruction: "repair", background: false };
    expect(ResumeSessionInputSchema.safeParse(valid).success).toBe(true);
    expect(ResumeSessionInputSchema.safeParse({ ...valid, unexpectedField: true }).success).toBe(false);
    expect(ResumeSessionInputSchema.safeParse({ session_id: "child", instruction: "repair" }).success).toBe(false);
  });

  it("forwards no delegation identity overrides", async () => {
    let request: ResumeChildRequest | undefined;
    const ctx = context(async (_workspaceRoot, input) => {
      request = input;
      return handle(input.parentSessionId);
    });
    await executeResumeSession({
      session_id: "child",
      instruction: "repair",
      background: false,
    }, ctx);
    expect(request).toMatchObject({
      sessionId: "child",
      instruction: "repair",
      parentExecutionId: "parent-execution",
      parentRunOrdinal: 1,
      parentToolBatchId: "parent-batch",
    });
    expect(request?.childExecutionId).toBeString();
    expect(request && "contract" in request).toBe(false);
    expect(request && "prompt" in request).toBe(false);
  });
});
