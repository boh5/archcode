import { describe, expect, it, mock } from "bun:test";
import type { ChildExecutionHandle, ChildExecutionRequest } from "../../delegation/types";
import { storeManager } from "../../store/store";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import { createTestProjectContext } from "../test-project-context";
import { DelegateInputSchema, delegateTool, executeDelegate } from "./delegate";

const WORKSPACE_ROOT = import.meta.dir;

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    store: storeManager.create(crypto.randomUUID(), WORKSPACE_ROOT, { agentName: "engineer" }),
    storeManager,
    toolName: "delegate",
    toolCallId: "delegate-call",
    input: {},
    step: 0,
    abort: new AbortController().signal,
    agentName: "engineer",
    startedAt: 0,
    allowedTools: new Set(["delegate", "resume_session"]),
    cwd: WORKSPACE_ROOT,
    projectContext: createTestProjectContext(WORKSPACE_ROOT),
    ...overrides,
  };
}

function childHandle(parentSessionId: string): ChildExecutionHandle {
  const store = storeManager.create(crypto.randomUUID(), WORKSPACE_ROOT, {
    agentName: "explore",
    parentSessionId,
    activeSkillNames: ["codemap"],
    title: "Inspect ownership",
  });
  store.getState().append({ type: "execution-start", executionId: crypto.randomUUID() });
  store.getState().append({ type: "text-start" });
  store.getState().append({ type: "text-delta", text: "done" });
  store.getState().append({ type: "text-end" });
  store.getState().append({ type: "execution-end", status: "completed" });
  return {
    sessionId: store.getState().sessionId,
    store,
    result: Promise.resolve({ text: "done", steps: 1, status: "completed" }),
    abort: () => {},
  };
}

describe("delegate tool hard cut", () => {
  it("requires a non-empty title and rejects the removed session_id branch", () => {
    const valid = {
      agent_type: "explore",
      task: "inspect",
      skills: [],
      title: "Inspect ownership",
    };
    expect(DelegateInputSchema.safeParse(valid).success).toBe(true);
    expect(DelegateInputSchema.safeParse({ ...valid, title: " " }).success).toBe(false);
    expect(DelegateInputSchema.safeParse({ ...valid, session_id: "child" }).success).toBe(false);
    expect(delegateTool.description).toContain("Use resume_session");
  });

  it("passes the explicit title without a description fallback or caller depth", async () => {
    const parentStore = storeManager.create(crypto.randomUUID(), WORKSPACE_ROOT, { agentName: "engineer" });
    const handle = childHandle(parentStore.getState().sessionId);
    let request: ChildExecutionRequest | undefined;
    const result = await executeDelegate({
      agent_type: "explore",
      task: "inspect",
      context: "verify boundaries",
      skills: ["codemap"],
      title: "Inspect ownership",
      description: "Display detail",
      background: false,
    }, makeContext({
      store: parentStore,
      currentDepth: 99,
      startChildExecution: async (input) => {
        request = input;
        return handle;
      },
    }));

    expect(request).toMatchObject({
      parentSessionId: parentStore.getState().sessionId,
      toolName: "delegate",
      targetAgentName: "explore",
      title: "Inspect ownership",
      description: "Display detail",
      skills: ["codemap"],
      prompt: "Task:\ninspect\n\nContext:\nverify boundaries",
    });
    expect(request && "currentDepth" in request).toBe(false);
    expect(result).toContain("Agent type: explore");
    expect(result).toContain("Result:\ndone");
  });

  it("returns a structured error when child execution is unavailable", async () => {
    const result = await executeDelegate({
      agent_type: "explore",
      task: "inspect",
      skills: [],
      title: "Inspect ownership",
      background: false,
    }, makeContext()) as ToolExecutionResult;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output).code).toBe("TOOL_DELEGATE_EXECUTOR_UNAVAILABLE");
  });

  it("returns launch guidance for background children", async () => {
    const parentStore = storeManager.create(crypto.randomUUID(), WORKSPACE_ROOT, { agentName: "engineer" });
    const handle = childHandle(parentStore.getState().sessionId);
    const startChildExecution = mock(async (_request: ChildExecutionRequest) => handle);
    const result = await executeDelegate({
      agent_type: "explore",
      task: "inspect",
      skills: [],
      title: "Inspect ownership",
      background: true,
    }, makeContext({ store: parentStore, startChildExecution }));
    expect(result).toContain("Sub-agent started.");
    expect(result).toContain(`background_output(session_id="${handle.sessionId}")`);
  });
});
