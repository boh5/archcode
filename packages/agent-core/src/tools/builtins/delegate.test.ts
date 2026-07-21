import { describe, expect, it, mock } from "bun:test";
import type { DelegationRequest } from "@archcode/protocol";
import type { ChildExecutionHandle, ChildExecutionRequest } from "../../delegation/types";
import { SkillNotAllowedError } from "../../agents/errors";
import { storeManager } from "../../store/store";
import { expectTextDraft } from "../test-results";
import type { ToolExecutionContext } from "../types";
import { createTestProjectContext } from "../test-project-context";
import { DelegateInputSchema, executeDelegate } from "./delegate";

const WORKSPACE_ROOT = import.meta.dir;

function request(overrides: Partial<DelegationRequest> = {}): DelegationRequest {
  const agentType = overrides.agent_type ?? "explore";
  return {
    agent_type: agentType,
    profile: overrides.profile ?? (agentType === "build" || agentType === "analyst" ? "deep" : "fast"),
    title: "Inspect ownership",
    objective: "Trace the owner and report exact references",
    skills: [],
    background: false,
    ...overrides,
  };
}

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    store: storeManager.create(crypto.randomUUID(), WORKSPACE_ROOT, { agentName: "lead" }),
    storeManager,
    toolName: "delegate",
    toolCallId: "delegate-call",
    input: {},
    step: 0,
    abort: new AbortController().signal,
    agentName: "lead",
    startedAt: 0,
    allowedTools: new Set(["delegate", "resume_session"]),
    cwd: WORKSPACE_ROOT,
    projectContext: createTestProjectContext(WORKSPACE_ROOT),
    ...overrides,
  };
}

function childHandle(parentSessionId: string, value: DelegationRequest): ChildExecutionHandle {
  const store = storeManager.create(crypto.randomUUID(), WORKSPACE_ROOT, {
    agentName: value.agent_type,
    parentSessionId,
    delegationRequest: value,
    title: value.title,
  });
  return {
    sessionId: store.getState().sessionId,
    store,
    result: Promise.resolve({ executionStatus: "completed", output: "Owner found" }),
    abort: () => {},
  };
}

describe("delegate request", () => {
  it("accepts exactly six required fields and enforces role ownership", () => {
    expect(DelegateInputSchema.safeParse(request()).success).toBe(true);
    expect(DelegateInputSchema.safeParse(request({ agent_type: "build", profile: "deep" })).success).toBe(true);
    expect(DelegateInputSchema.safeParse(request({ agent_type: "build", profile: "fast" })).success).toBe(true);
    expect(DelegateInputSchema.safeParse({ ...request(), owned_scope: [] }).success).toBe(false);
    for (const field of ["non_goals", "acceptance_criteria", "evidence", "verification", "depends_on", "persona", "description", "task", "context", "session_id"]) {
      expect(DelegateInputSchema.safeParse({ ...request(), [field]: [] }).success).toBe(false);
    }
    expect(DelegateInputSchema.safeParse({ ...request(), background: undefined }).success).toBe(false);
  });

  it("passes one canonical request and returns ordinary final output", async () => {
    const parentStore = storeManager.create(crypto.randomUUID(), WORKSPACE_ROOT, { agentName: "lead" });
    const value = request();
    const handle = childHandle(parentStore.getState().sessionId, value);
    let childRequest: ChildExecutionRequest | undefined;
    const output = await executeDelegate(value, makeContext({
      store: parentStore,
      startChildExecution: async (input) => {
        childRequest = input;
        return handle;
      },
    }));
    expect(childRequest).toMatchObject({ toolName: "delegate", request: value });
    expect(JSON.parse(expectTextDraft(output))).toEqual({
      session_id: handle.sessionId,
      agent_type: "explore",
      execution_status: "completed",
      output: "Owner found",
    });
  });

  it("does not expose output for a failed execution", async () => {
    const value = request();
    const parent = makeContext();
    const handle = childHandle(parent.store.getState().sessionId, value);
    const output = await executeDelegate(value, {
      ...parent,
      startChildExecution: async () => ({
        ...handle,
        result: Promise.resolve({ executionStatus: "failed", terminalError: "boom" }),
      }),
    });
    expect(JSON.parse(expectTextDraft(output))).toEqual({
      session_id: handle.sessionId,
      agent_type: "explore",
      execution_status: "failed",
      error: "boom",
    });
  });

  it("returns target Skill recovery details", async () => {
    const result = await executeDelegate(request({ skills: ["research-docs"] }), makeContext({
      startChildExecution: async () => {
        throw new SkillNotAllowedError("explore", "research-docs", ["codemap"]);
      },
    }));
    expect(JSON.parse(expectTextDraft(result))).toMatchObject({
      code: "TOOL_DELEGATE_FAILED",
      name: "SkillNotAllowedError",
    });
  });

  it("returns only launch metadata for a background child", async () => {
    const parent = makeContext();
    const value = request({ background: true });
    const handle = childHandle(parent.store.getState().sessionId, value);
    const startChildExecution = mock(async (_request: ChildExecutionRequest) => handle);
    const output = await executeDelegate(value, { ...parent, startChildExecution });
    expect(JSON.parse(expectTextDraft(output))).toEqual({
      session_id: handle.sessionId,
      agent_type: "explore",
      execution_status: "running",
    });
  });
});
