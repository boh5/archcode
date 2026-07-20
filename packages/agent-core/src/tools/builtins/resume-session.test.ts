import { describe, expect, it } from "bun:test";
import type { ChildExecutionHandle, ResumeChildRequest } from "../../delegation/types";
import { testExecutionStart } from "../../testing/test-execution-fixtures";
import { storeManager } from "../../store/store";
import type { ToolExecutionContext } from "../types";
import { createTestProjectContext } from "../test-project-context";
import { executeResumeSession, ResumeSessionInputSchema } from "./resume-session";

const WORKSPACE_ROOT = import.meta.dir;

function context(resumeChildSession?: ToolExecutionContext["resumeChildSession"]): ToolExecutionContext {
  const store = storeManager.create(crypto.randomUUID(), WORKSPACE_ROOT, { agentName: "engineer" });
  return {
    store,
    storeManager,
    toolName: "resume_session",
    toolCallId: "resume-call",
    input: {},
    step: 0,
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
  store.getState().append(testExecutionStart(crypto.randomUUID()));
  store.getState().append({ type: "execution-end", status: "failed" });
  return {
    sessionId: store.getState().sessionId,
    store,
    result: Promise.resolve({ executionStatus: "failed" }),
    abort: () => {},
  };
}

describe("resume_session V2 contract", () => {
  it("accepts only required session_id, instruction, and background", () => {
    const valid = { session_id: "child", instruction: "repair", background: false };
    expect(ResumeSessionInputSchema.safeParse(valid).success).toBe(true);
    for (const field of ["task", "context", "agent_type", "persona", "skills", "title", "owned_scope"]) {
      expect(ResumeSessionInputSchema.safeParse({ ...valid, [field]: "legacy" }).success).toBe(false);
    }
    expect(ResumeSessionInputSchema.safeParse({ ...valid, new_evidence: [] }).success).toBe(false);
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
    });
    expect(request && "contract" in request).toBe(false);
    expect(request && "prompt" in request).toBe(false);
  });
});
