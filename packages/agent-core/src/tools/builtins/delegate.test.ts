import { describe, expect, it, mock } from "bun:test";
import type { ChildResultReceipt, DelegationContract } from "@archcode/protocol";
import type { ChildExecutionHandle, ChildExecutionRequest } from "../../delegation/types";
import { hashDelegationContract } from "../../delegation/contract";
import { SkillNotAllowedError } from "../../agents/errors";
import { storeManager } from "../../store/store";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import { createTestProjectContext } from "../test-project-context";
import { DelegateInputSchema, executeDelegate } from "./delegate";

const WORKSPACE_ROOT = import.meta.dir;

function contract(overrides: Partial<DelegationContract> = {}): DelegationContract {
  return {
    agent_type: "explore",
    title: "Inspect ownership",
    objective: "Trace the owner and report exact references",
    owned_scope: [],
    non_goals: ["Do not edit"],
    acceptance_criteria: [{ id: "ac-1", condition: "Owner identified", requiredEvidence: "File reference" }],
    evidence: [],
    verification: [],
    depends_on: [],
    skills: [],
    background: false,
    ...overrides,
  };
}

function receipt(contractValue: DelegationContract, executionId: string): ChildResultReceipt {
  return {
    executionId,
    delegationContractHash: hashDelegationContract(contractValue),
    submittedAt: 100,
    result: {
      status: "completed",
      summary: "Owner found",
      deliverables: [],
      evidence: [{ claim: "Owner identified", ref: "src/owner.ts:1" }],
      criteria: [{ id: "ac-1", status: "passed", evidenceRefs: ["src/owner.ts:1"] }],
      verification: [],
      unresolved: [],
    },
  };
}

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

function childHandle(parentSessionId: string, contractValue: DelegationContract): ChildExecutionHandle {
  const executionId = crypto.randomUUID();
  const store = storeManager.create(crypto.randomUUID(), WORKSPACE_ROOT, {
    agentName: "explore",
    parentSessionId,
    delegationContract: contractValue,
    delegationContractHash: hashDelegationContract(contractValue),
    title: contractValue.title,
  });
  const resultReceipt = receipt(contractValue, executionId);
  store.getState().append({ type: "execution-start", executionId });
  store.getState().append({ type: "child-result", receipt: resultReceipt });
  store.getState().append({ type: "execution-end", status: "completed" });
  return {
    sessionId: store.getState().sessionId,
    store,
    result: Promise.resolve({ executionStatus: "completed", resultReceipt }),
    abort: () => {},
  };
}

describe("delegate V2 contract", () => {
  it("requires structured arrays and rejects every removed free-text field", () => {
    expect(DelegateInputSchema.safeParse(contract()).success).toBe(true);
    expect(DelegateInputSchema.safeParse(contract({ agent_type: "build", owned_scope: [] })).success).toBe(false);
    expect(DelegateInputSchema.safeParse({ ...contract(), agent_type: "engineer" }).success).toBe(false);
    for (const field of ["persona", "description", "task", "context", "session_id"]) {
      expect(DelegateInputSchema.safeParse({ ...contract(), [field]: "legacy" }).success).toBe(false);
    }
  });

  it("passes one canonical contract and returns its receipt", async () => {
    const parentStore = storeManager.create(crypto.randomUUID(), WORKSPACE_ROOT, { agentName: "engineer" });
    const contractValue = contract();
    const handle = childHandle(parentStore.getState().sessionId, contractValue);
    let request: ChildExecutionRequest | undefined;

    const output = await executeDelegate(contractValue, makeContext({
      store: parentStore,
      startChildExecution: async (input) => {
        request = input;
        return handle;
      },
    }));

    expect(request).toMatchObject({ toolName: "delegate", contract: contractValue });
    expect(request && "prompt" in request).toBe(false);
    expect(JSON.parse(output as string)).toMatchObject({
      session_id: handle.sessionId,
      execution_status: "completed",
      result_receipt: { result: { status: "completed" } },
    });
  });

  it("returns target Skill recovery details", async () => {
    const result = await executeDelegate(contract({ skills: ["research-docs"] }), makeContext({
      startChildExecution: async () => {
        throw new SkillNotAllowedError("explore", "research-docs", ["codemap"]);
      },
    })) as ToolExecutionResult;
    expect(JSON.parse(result.output).details).toMatchObject({
      target_agent: "explore",
      rejected_skill: "research-docs",
      allowed_skills: ["codemap"],
    });
  });

  it("returns only launch metadata for a background child", async () => {
    const parent = makeContext();
    const contractValue = contract({ background: true });
    const handle = childHandle(parent.store.getState().sessionId, contractValue);
    const startChildExecution = mock(async (_request: ChildExecutionRequest) => handle);
    const output = await executeDelegate(contractValue, { ...parent, startChildExecution });
    expect(JSON.parse(output as string)).toEqual({
      session_id: handle.sessionId,
      agent_type: "explore",
      execution_status: "running",
    });
  });
});
