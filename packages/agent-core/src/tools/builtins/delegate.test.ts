import { describe, expect, it, mock } from "bun:test";
import type { DelegationRequest } from "@archcode/protocol";
import type { ChildExecutionHandle, ChildExecutionRequest } from "../../delegation/types";
import {
  AgentChildPolicyMissingError,
  DelegateTargetNotAllowedError,
  DepthLimitError,
  SkillNotAllowedError,
} from "../../agents/errors";
import { SkillNotFoundError, SkillValidationError } from "../../skills";
import { storeManager } from "../../store/store";
import { expectTextDraft } from "../test-results";
import type { ToolExecutionContext } from "../types";
import { createTestProjectContext } from "../test-project-context";
import { DelegateInputSchema, executeDelegate } from "./delegate";
import type { ToolDescriptorExecutionResult } from "../types";

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
    store: storeManager.create(crypto.randomUUID(), WORKSPACE_ROOT, { source: { kind: "direct" }, agentName: "lead" }),
    storeManager,
    toolName: "delegate",
    toolCallId: "delegate-call",
    input: {},
    step: 0,
    executionId: "parent-execution",
    runOrdinal: 0,
    toolBatchId: "parent-batch",
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
    rootSessionId: parentSessionId,
    delegationRequest: value,
    title: value.title,
  });
  return {
    sessionId: store.getState().sessionId,
    executionId: "child-execution",
    store,
    result: Promise.resolve({
      outcome: "terminal",
      executionId: "child-execution",
      executionStatus: "completed",
      output: "Owner found",
    }),
    abort: () => {},
  };
}

function textResult(result: ToolDescriptorExecutionResult): string {
  if ("kind" in result) throw new Error(`Expected settled draft, got ${result.kind}`);
  return expectTextDraft(result);
}

describe("delegate request", () => {
  it("accepts exactly six required fields and enforces role ownership", () => {
    expect(DelegateInputSchema.safeParse(request()).success).toBe(true);
    expect(DelegateInputSchema.safeParse(request({ agent_type: "build", profile: "deep" })).success).toBe(true);
    expect(DelegateInputSchema.safeParse(request({ agent_type: "build", profile: "fast" })).success).toBe(true);
    expect(DelegateInputSchema.safeParse({ ...request(), unexpectedField: true }).success).toBe(false);
    expect(DelegateInputSchema.safeParse({ ...request(), background: undefined }).success).toBe(false);
  });

  it("passes one canonical request and returns ordinary final output", async () => {
    const parentStore = storeManager.create(crypto.randomUUID(), WORKSPACE_ROOT, { source: { kind: "direct" }, agentName: "lead" });
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
    expect(childRequest).toMatchObject({
      toolName: "delegate",
      request: value,
      parentExecutionId: "parent-execution",
      parentRunOrdinal: 0,
      parentToolBatchId: "parent-batch",
    });
    expect(childRequest?.childSessionId).toBeString();
    expect(childRequest?.childExecutionId).toBeString();
    expect(JSON.parse(textResult(output))).toEqual({
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
        result: Promise.resolve({
          outcome: "terminal",
          executionId: handle.executionId,
          executionStatus: "failed",
          terminalError: "boom",
        }),
      }),
    });
    expect(JSON.parse(textResult(output))).toEqual({
      session_id: handle.sessionId,
      agent_type: "explore",
      execution_status: "failed",
      error: "boom",
    });
  });

  it("maps known child-start admission failures to stable tool error codes", async () => {
    const profileError = Object.assign(new Error('Explore does not allow Profile "deep"'), {
      code: "DELEGATION_PROFILE_NOT_ALLOWED",
      name: "DelegationExecutionAdmissionError",
    });
    const cases: readonly [string, Error, string][] = [
      ["delegate target", new DelegateTargetNotAllowedError("lead", "build", 3), "TOOL_DELEGATE_TARGET_NOT_ALLOWED"],
      ["missing child policy", new AgentChildPolicyMissingError("lead"), "TOOL_DELEGATE_TARGET_NOT_ALLOWED"],
      ["depth limit", new DepthLimitError(3), "TOOL_DELEGATE_TARGET_NOT_ALLOWED"],
      ["profile", profileError, "TOOL_DELEGATE_PROFILE_NOT_ALLOWED"],
      ["missing Skill", new SkillNotFoundError("research-docs"), "TOOL_DELEGATE_SKILL_NOT_FOUND"],
      ["invalid Skill", new SkillValidationError("research-docs", "project-archcode", "missing SKILL.md"), "TOOL_DELEGATE_SKILL_INVALID"],
      ["disallowed Skill", new SkillNotAllowedError("explore", "research-docs", ["codemap"]), "TOOL_DELEGATE_SKILL_NOT_ALLOWED"],
    ];

    for (const [label, error, expectedCode] of cases) {
      const result = await executeDelegate(request({ skills: ["research-docs"] }), makeContext({
        startChildExecution: async () => {
          throw error;
        },
      }));
      expect(JSON.parse(textResult(result)), label).toMatchObject({
        code: expectedCode,
        name: error.name,
        message: error.message,
      });
    }
  });

  it("uses the generic code only for an unknown child-start failure", async () => {
    const error = new Error("unexpected launch failure");
    error.name = "UnexpectedLaunchError";
    const result = await executeDelegate(request(), makeContext({
      startChildExecution: async () => {
        throw error;
      },
    }));
    expect(JSON.parse(textResult(result))).toMatchObject({
      code: "TOOL_DELEGATE_FAILED",
      name: error.name,
      message: error.message,
    });
  });

  it("returns only launch metadata for a background child", async () => {
    const parent = makeContext();
    const value = request({ background: true });
    const handle = childHandle(parent.store.getState().sessionId, value);
    const startChildExecution = mock(async (_request: ChildExecutionRequest) => handle);
    const output = await executeDelegate(value, { ...parent, startChildExecution });
    expect(JSON.parse(textResult(output))).toEqual({
      session_id: handle.sessionId,
      agent_type: "explore",
      execution_status: "running",
    });
  });

  it("returns an internal dependency without final output when a synchronous child suspends", async () => {
    const parent = makeContext();
    const value = request();
    const handle = childHandle(parent.store.getState().sessionId, value);
    const output = await executeDelegate(value, {
      ...parent,
      startChildExecution: async () => ({
        ...handle,
        result: Promise.resolve({
          outcome: "suspended",
          executionId: handle.executionId,
          suspension: {
            kind: "hitl",
            toolBatchId: "child-batch",
            blockerIds: ["hitl-1"],
          },
        }),
      }),
    });
    expect(output).toEqual({
      kind: "child_deferred",
      dependency: {
        parentExecutionId: "parent-execution",
        runOrdinal: 0,
        toolBatchId: "parent-batch",
        toolCallId: "delegate-call",
        childSessionId: handle.sessionId,
        childExecutionId: handle.executionId,
      },
    });
  });
});
