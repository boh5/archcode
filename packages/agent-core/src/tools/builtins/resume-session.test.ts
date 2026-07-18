import { describe, expect, it } from "bun:test";
import type { ChildExecutionHandle, ResumeChildRequest } from "../../delegation/types";
import { storeManager } from "../../store/store";
import type { ToolExecutionContext } from "../types";
import { createTestProjectContext } from "../test-project-context";
import { testExecutionStart } from "../../testing/test-execution-fixtures";
import { executeResumeSession, ResumeSessionInputSchema, resumeSessionTool } from "./resume-session";

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
    activeSkillNames: ["git-master"],
    title: "Original title",
  });
  store.getState().append(testExecutionStart(crypto.randomUUID()));
  store.getState().append({ type: "execution-end", status: "completed" });
  return {
    sessionId: store.getState().sessionId,
    store,
    result: Promise.resolve({ text: "resumed", steps: 1, status: "completed" }),
    abort: () => {},
  };
}

describe("resume_session tool", () => {
  it("accepts only session_id, task, optional context, and background", () => {
    const valid = { session_id: "child", task: "repair" };
    expect(ResumeSessionInputSchema.safeParse(valid).success).toBe(true);
    for (const override of ["agent_type", "persona", "skills", "title", "depth"]) {
      expect(ResumeSessionInputSchema.safeParse({ ...valid, [override]: "override" }).success).toBe(false);
    }
    expect(resumeSessionTool.description).toContain("cannot be overridden");
  });

  it("forwards no identity override fields and preserves the persisted display identity", async () => {
    let request: ResumeChildRequest | undefined;
    const ctx = context(async (_workspaceRoot, input) => {
      request = input;
      return handle(input.parentSessionId);
    });
    const result = await executeResumeSession({
      session_id: "child",
      task: "repair",
      context: "keep identity",
      background: false,
    }, ctx);

    expect(request).toMatchObject({
      sessionId: "child",
      toolName: "resume_session",
      prompt: "Task:\nrepair\n\nContext:\nkeep identity",
    });
    expect(request && "agent_type" in request).toBe(false);
    expect(request && "targetAgentName" in request).toBe(false);
    expect(request && "title" in request).toBe(false);
    expect(request && "skills" in request).toBe(false);
    expect(result).toContain("Agent type: build");
  });
});
