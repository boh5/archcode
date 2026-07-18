import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ChildResult, DelegationContract } from "@archcode/protocol";
import { hashDelegationContract } from "../../delegation/contract";
import { silentLogger } from "../../logger";
import { SessionStoreManager } from "../../store/session-store-manager";
import { __setSessionsDirForTest } from "../../store/sessions-dir";
import type { ToolExecutionContext, ToolExecutionResult } from "../types";
import type { SessionToolBatch } from "../../store/types";
import { createTestProjectContext } from "../test-project-context";
import { createRegistry } from "../registry";
import {
  countStructuredResultFailures,
  createStructuredResultCorrectionGate,
} from "../structured-result-correction";
import { executeSubmitChildResult, submitChildResultTool } from "./submit-child-result";

const TMP = join(import.meta.dir, "__test_tmp__", "submit-child-result", crypto.randomUUID());
const WORKSPACE = join(TMP, "workspace");

beforeEach(async () => {
  await mkdir(WORKSPACE, { recursive: true });
  __setSessionsDirForTest(() => join(TMP, "sessions"));
});

afterEach(async () => {
  __setSessionsDirForTest(undefined);
  await rm(TMP, { recursive: true, force: true });
});

function contract(): DelegationContract {
  return {
    agent_type: "explore",
    title: "Inspect",
    objective: "Inspect",
    owned_scope: [],
    non_goals: [],
    acceptance_criteria: [{ id: "ac-1", condition: "Found", requiredEvidence: "Ref" }],
    evidence: [],
    verification: [],
    depends_on: [],
    skills: [],
    background: false,
  };
}

function childResult(): ChildResult {
  return {
    status: "completed",
    summary: "Found",
    deliverables: [],
    evidence: [{ claim: "Found", ref: "src/a.ts:1" }],
    criteria: [{ id: "ac-1", status: "passed", evidenceRefs: ["src/a.ts:1"] }],
    verification: [],
    unresolved: [],
  };
}

function context() {
  const manager = new SessionStoreManager({ logger: silentLogger });
  const parent = manager.create(crypto.randomUUID(), WORKSPACE, { agentName: "engineer" });
  const value = contract();
  const child = manager.create(crypto.randomUUID(), WORKSPACE, {
    agentName: "explore",
    parentSessionId: parent.getState().sessionId,
    rootSessionId: parent.getState().rootSessionId,
    delegationContract: value,
    delegationContractHash: hashDelegationContract(value),
    title: value.title,
  });
  child.getState().append({ type: "execution-start", executionId: "execution-1" });
  const ctx: ToolExecutionContext = {
    store: child,
    storeManager: manager,
    toolName: "submit_child_result",
    toolCallId: "submit-call",
    input: {},
    step: 0,
    abort: new AbortController().signal,
    startedAt: 0,
    allowedTools: new Set(["submit_child_result"]),
    cwd: WORKSPACE,
    projectContext: createTestProjectContext(WORKSPACE),
  };
  return { manager, child, ctx };
}

describe("submit_child_result", () => {
  it("mints and durably persists one execution-bound receipt", async () => {
    const { manager, child, ctx } = context();
    const result = await executeSubmitChildResult(childResult(), ctx);
    expect(result.isError).toBe(false);
    expect(result.meta?.executionControl).toEqual({ action: "complete_execution", reason: "child_result_submitted" });
    expect(child.getState().childResultReceipts).toHaveLength(1);
    expect(child.getState().childResultReceipts[0]).toMatchObject({
      executionId: "execution-1",
      delegationContractHash: child.getState().delegationContractHash,
      result: { status: "completed" },
    });

    manager.releaseWorkspace(WORKSPACE);
    const loaded = await manager.getOrLoad(child.getState().sessionId, WORKSPACE);
    expect(loaded.getState().childResultReceipts).toEqual(child.getState().childResultReceipts);
  });

  it("rejects mismatched acceptance criteria and duplicate submission", async () => {
    const { ctx } = context();
    const invalid = childResult();
    invalid.criteria = [{ id: "wrong", status: "passed", evidenceRefs: [] }];
    const mismatch = await executeSubmitChildResult(invalid, ctx);
    expect(mismatch.isError).toBe(true);
    expect(JSON.parse(mismatch.output).message).toContain("exactly match");

    expect((await executeSubmitChildResult(childResult(), ctx)).isError).toBe(false);
    const duplicate = await executeSubmitChildResult(childResult(), ctx);
    expect(duplicate.isError).toBe(true);
    expect(JSON.parse(duplicate.output).message).toContain("already submitted");
  });

  it("rejects root Sessions", async () => {
    const { ctx } = context();
    const root = ctx.storeManager.create(crypto.randomUUID(), WORKSPACE, { agentName: "engineer" });
    root.getState().append({ type: "execution-start", executionId: "root-execution" });
    const result = await executeSubmitChildResult(childResult(), { ...ctx, store: root }) as ToolExecutionResult;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output).message).toContain("delegated child");
  });

  it("allows one best-effort semantic correction and fails the second attempt", async () => {
    const { ctx } = context();
    ctx.structuredResultCorrection = createStructuredResultCorrectionGate("best_effort");
    const invalid = childResult();
    invalid.criteria = [{ id: "wrong", status: "passed", evidenceRefs: [] }];

    const first = await executeSubmitChildResult(invalid, ctx);
    expect(JSON.parse(first.output).code).toBe("STRUCTURED_RESULT_CORRECTION_REQUIRED");
    expect(first.meta?.executionControl).toBeUndefined();

    const second = await executeSubmitChildResult(invalid, ctx);
    expect(JSON.parse(second.output).code).toBe("CHILD_RESULT_REQUIRED");
    expect(second.meta?.executionControl).toEqual({
      action: "fail_execution",
      reason: "child_result_required",
      error: expect.stringContaining("CHILD_RESULT_REQUIRED"),
    });
  });

  it("accepts one valid best-effort correction after the first failure", async () => {
    const { child, ctx } = context();
    ctx.structuredResultCorrection = createStructuredResultCorrectionGate("best_effort");
    const invalid = childResult();
    invalid.criteria = [{ id: "wrong", status: "passed", evidenceRefs: [] }];

    const first = await executeSubmitChildResult(invalid, ctx);
    expect(first.meta?.executionControl).toBeUndefined();
    const corrected = await executeSubmitChildResult(childResult(), ctx);

    expect(corrected.isError).toBe(false);
    expect(corrected.meta?.executionControl).toEqual({
      action: "complete_execution",
      reason: "child_result_submitted",
    });
    expect(child.getState().childResultReceipts).toHaveLength(1);
  });

  it("shares one best-effort correction across schema and semantic failures", async () => {
    const { ctx } = context();
    ctx.structuredResultCorrection = createStructuredResultCorrectionGate("best_effort");
    const registry = createRegistry([submitChildResultTool]);

    const schemaFailure = await registry.execute({
      toolName: "submit_child_result",
      toolCallId: "schema-failure",
      input: { status: "completed" },
    }, ctx);
    expect(JSON.parse(schemaFailure.output).code).toBe("STRUCTURED_RESULT_CORRECTION_REQUIRED");

    const invalid = childResult();
    invalid.criteria = [{ id: "wrong", status: "passed", evidenceRefs: [] }];
    const semanticFailure = await registry.execute({
      toolName: "submit_child_result",
      toolCallId: "semantic-failure",
      input: invalid,
    }, ctx);
    expect(JSON.parse(semanticFailure.output).code).toBe("CHILD_RESULT_REQUIRED");
    expect(semanticFailure.meta?.executionControl).toMatchObject({ action: "fail_execution" });
  });

  it("fails the first invalid strict submission", async () => {
    const { ctx } = context();
    ctx.structuredResultCorrection = createStructuredResultCorrectionGate("strict");
    const invalid = childResult();
    invalid.criteria = [{ id: "wrong", status: "passed", evidenceRefs: [] }];

    const result = await executeSubmitChildResult(invalid, ctx);
    expect(JSON.parse(result.output).code).toBe("CHILD_RESULT_REQUIRED");
    expect(result.meta?.executionControl).toMatchObject({
      action: "fail_execution",
      reason: "child_result_required",
    });
  });

  it("rebuilds the correction count from the durable current-execution tool batch", async () => {
    const { child, ctx } = context();
    const firstGate = createStructuredResultCorrectionGate("best_effort");
    const durableFailure = firstGate.recordFailure(new Error("schema mismatch"));
    const now = new Date().toISOString();
    const batch: SessionToolBatch = {
      batchId: "batch-1",
      executionId: "execution-1",
      step: 1,
      agentName: "explore",
      allowedTools: ["submit_child_result"],
      agentSkills: [],
      partitions: [{ type: "serial", callIds: ["failed-submit"] }],
      calls: [{
        ordinal: 0,
        partitionIndex: 0,
        toolCallId: "failed-submit",
        toolName: "submit_child_result",
        input: { status: "completed" },
        traits: { readOnly: false, destructive: false, concurrencySafe: false },
        state: "failed",
        attempt: 1,
        result: durableFailure,
      }],
      createdAt: now,
      updatedAt: now,
    };
    child.setState({ toolBatches: [batch] });
    ctx.structuredResultCorrection = createStructuredResultCorrectionGate(
      "best_effort",
      countStructuredResultFailures(child.getState()),
    );
    const invalid = childResult();
    invalid.criteria = [{ id: "wrong", status: "passed", evidenceRefs: [] }];

    const recoveredAttempt = await executeSubmitChildResult(invalid, ctx);
    expect(JSON.parse(recoveredAttempt.output).code).toBe("CHILD_RESULT_REQUIRED");
    expect(recoveredAttempt.meta?.executionControl).toMatchObject({ action: "fail_execution" });
  });
});
