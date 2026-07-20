import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ChildResult, DelegationContract, FinalizedToolResult } from "@archcode/protocol";
import { hashDelegationContract } from "../../delegation/contract";
import { silentLogger } from "../../logger";
import {
  RUNTIME_OBJECTIVE_CRITERION_ID,
  buildGoalReviewContract,
} from "../../session-goal/review-gate";
import { SessionStoreManager } from "../../store/session-store-manager";
import { __setSessionsDirForTest } from "../../store/sessions-dir";
import { testExecutionStart } from "../../testing/test-execution-fixtures";
import type { RawToolResult, ToolExecutionContext } from "../types";
import type { SessionToolBatch } from "../../store/types";
import { createTestProjectContext } from "../test-project-context";
import { createTestToolRegistryFixture } from "../test-registry";
import { expectTextDraft } from "../test-results";
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

function context(options: {
  contract?: DelegationContract;
  executionOrigin?: "tool_call" | "goal_review";
} = {}) {
  const manager = new SessionStoreManager({ logger: silentLogger });
  const parent = manager.create(crypto.randomUUID(), WORKSPACE, { agentName: "engineer" });
  const value = options.contract ?? contract();
  const child = manager.create(crypto.randomUUID(), WORKSPACE, {
    agentName: value.agent_type,
    parentSessionId: parent.getState().sessionId,
    rootSessionId: parent.getState().rootSessionId,
    delegationContract: value,
    delegationContractHash: hashDelegationContract(value),
    title: value.title,
  });
  child.getState().append(testExecutionStart("execution-1", options.executionOrigin ?? "tool_call"));
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
    expect(result.sidecar?.executionControl).toEqual({ action: "complete_execution", reason: "child_result_submitted" });
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
    expect(JSON.parse(expectTextDraft(mismatch)).message).toContain("exactly match");

    expect((await executeSubmitChildResult(childResult(), ctx)).isError).toBe(false);
    const duplicate = await executeSubmitChildResult(childResult(), ctx);
    expect(duplicate.isError).toBe(true);
    expect(JSON.parse(expectTextDraft(duplicate)).message).toContain("already submitted");
  });

  it("rejects root Sessions", async () => {
    const { ctx } = context();
    const root = ctx.storeManager.create(crypto.randomUUID(), WORKSPACE, { agentName: "engineer" });
    root.getState().append(testExecutionStart("root-execution"));
    const result = await executeSubmitChildResult(childResult(), { ...ctx, store: root });
    expect(result.isError).toBe(true);
    expect(JSON.parse(expectTextDraft(result)).message).toContain("delegated child");
  });

  it("allows one semantic correction and fails the second attempt", async () => {
    const { ctx } = context();
    ctx.structuredResultCorrection = createStructuredResultCorrectionGate();
    const invalid = childResult();
    invalid.criteria = [{ id: "wrong", status: "passed", evidenceRefs: [] }];

    const first = await executeSubmitChildResult(invalid, ctx);
    expect(JSON.parse(expectTextDraft(first)).code).toBe("STRUCTURED_RESULT_CORRECTION_REQUIRED");
    expect(first.sidecar?.executionControl).toBeUndefined();

    const second = await executeSubmitChildResult(invalid, ctx);
    expect(JSON.parse(expectTextDraft(second)).code).toBe("CHILD_RESULT_REQUIRED");
    expect(second.sidecar?.executionControl).toEqual({
      action: "fail_execution",
      reason: "child_result_required",
      error: expect.stringContaining("CHILD_RESULT_REQUIRED"),
    });
  });

  it("accepts one valid correction after the first failure", async () => {
    const { child, ctx } = context();
    ctx.structuredResultCorrection = createStructuredResultCorrectionGate();
    const invalid = childResult();
    invalid.criteria = [{ id: "wrong", status: "passed", evidenceRefs: [] }];

    const first = await executeSubmitChildResult(invalid, ctx);
    expect(first.sidecar?.executionControl).toBeUndefined();
    const corrected = await executeSubmitChildResult(childResult(), ctx);

    expect(corrected.isError).toBe(false);
    expect(corrected.sidecar?.executionControl).toEqual({
      action: "complete_execution",
      reason: "child_result_submitted",
    });
    expect(child.getState().childResultReceipts).toHaveLength(1);
  });

  it("corrects invented Goal-review tool aliases before terminal submission", async () => {
    const goalContract = buildGoalReviewContract("Implement and verify the complete objective");
    const { child, ctx } = context({ contract: goalContract, executionOrigin: "goal_review" });
    ctx.structuredResultCorrection = createStructuredResultCorrectionGate();
    child.getState().append({ type: "tool-input-start", toolCallId: "call-real-test", toolName: "bash" });
    child.getState().append({ type: "tool-call", toolCallId: "call-real-test", toolName: "bash", input: { command: "bun test" } });
    child.getState().append({
      type: "tool-result",
      toolCallId: "call-real-test",
      toolName: "bash",
      result: finalizedSuccess("1 pass, 0 fail"),
    });

    const inventedAlias: ChildResult = {
      status: "completed",
      summary: "Independent review passed",
      deliverables: [],
      evidence: [{ claim: "Tests passed", ref: "tool:functions.bash" }],
      criteria: [{
        id: RUNTIME_OBJECTIVE_CRITERION_ID,
        status: "passed",
        evidenceRefs: ["tool:functions.bash"],
      }],
      verification: [{ check: "bun test", status: "passed", outputRef: "tool:functions.bash" }],
      unresolved: [],
    };
    const rejectedAlias = await executeSubmitChildResult(inventedAlias, ctx);
    const correction = JSON.parse(expectTextDraft(rejectedAlias));
    expect(correction.code).toBe("STRUCTURED_RESULT_CORRECTION_REQUIRED");
    expect(correction.message).toContain("tool:functions.bash");
    expect(correction.message).toContain("tool:call-real-test (bash)");
    expect(rejectedAlias.sidecar?.executionControl).toBeUndefined();
    expect(child.getState().childResultReceipts).toHaveLength(0);

    const exactRefs: ChildResult = structuredClone(inventedAlias);
    exactRefs.evidence[0]!.ref = "tool:call-real-test";
    exactRefs.criteria[0]!.evidenceRefs = ["tool:call-real-test"];
    exactRefs.verification[0]!.outputRef = "tool:call-real-test";
    const accepted = await executeSubmitChildResult(exactRefs, ctx);
    expect(accepted.isError).toBe(false);
    expect(accepted.sidecar?.executionControl).toMatchObject({ action: "complete_execution" });
    expect(child.getState().childResultReceipts).toHaveLength(1);
  });

  it("shares one correction across schema and semantic failures", async () => {
    const { ctx } = context();
    ctx.structuredResultCorrection = createStructuredResultCorrectionGate();
    const fixture = createTestToolRegistryFixture({ descriptors: [submitChildResultTool] });
    const registry = fixture.registry;

    try {
      const schemaFailure = await registry.execute({
        toolName: "submit_child_result",
        toolCallId: "schema-failure",
        input: { status: "completed" },
      }, ctx);
      if (schemaFailure.kind !== "settled") throw new Error("Expected settled schema failure");
      expect(JSON.parse(schemaFailure.result.output.preview).code).toBe("STRUCTURED_RESULT_CORRECTION_REQUIRED");

      const invalid = childResult();
      invalid.criteria = [{ id: "wrong", status: "passed", evidenceRefs: [] }];
      const semanticFailure = await registry.execute({
        toolName: "submit_child_result",
        toolCallId: "semantic-failure",
        input: invalid,
      }, ctx);
      if (semanticFailure.kind !== "settled") throw new Error("Expected settled semantic failure");
      expect(JSON.parse(semanticFailure.result.output.preview).code).toBe("CHILD_RESULT_REQUIRED");
      expect(semanticFailure.sidecar?.executionControl).toMatchObject({ action: "fail_execution" });
    } finally {
      await fixture.dispose();
    }
  });

  it("carries one correction across a durable tool-batch continuation and resets on explicit resume", async () => {
    const { child, ctx } = context();
    const firstGate = createStructuredResultCorrectionGate();
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
        result: finalizedInlineResult(durableFailure),
      }],
      createdAt: now,
      updatedAt: now,
    };
    child.setState({ toolBatches: [batch] });
    child.getState().append({ type: "execution-end", status: "waiting_for_human" });
    child.getState().append(testExecutionStart("execution-2", "tool_batch"));
    ctx.structuredResultCorrection = createStructuredResultCorrectionGate(
      countStructuredResultFailures(child.getState()),
    );
    const invalid = childResult();
    invalid.criteria = [{ id: "wrong", status: "passed", evidenceRefs: [] }];

    const recoveredAttempt = await executeSubmitChildResult(invalid, ctx);
    expect(JSON.parse(expectTextDraft(recoveredAttempt)).code).toBe("CHILD_RESULT_REQUIRED");
    expect(recoveredAttempt.sidecar?.executionControl).toMatchObject({ action: "fail_execution" });

    child.getState().append({ type: "execution-end", status: "failed" });
    child.getState().append(testExecutionStart("execution-3", "tool_call"));
    expect(countStructuredResultFailures(child.getState())).toBe(0);
  });
});

function finalizedInlineResult(result: RawToolResult): FinalizedToolResult {
  const text = expectTextDraft(result);
  const count = { bytes: new TextEncoder().encode(text).byteLength, lines: text.length === 0 ? 0 : text.split("\n").length };
  return {
    isError: result.isError,
    output: {
      preview: text,
      completeness: "complete",
      observed: count,
      canonical: count,
      stored: count,
      omitted: { bytes: 0, lines: 0 },
      recovery: { kind: "none" },
    },
    ...(result.details === undefined ? {} : { details: result.details }),
  };
}

function finalizedSuccess(preview: string): FinalizedToolResult {
  const bytes = new TextEncoder().encode(preview).byteLength;
  const count = { bytes, lines: preview.length === 0 ? 0 : preview.split("\n").length };
  return {
    isError: false,
    output: {
      preview,
      completeness: "complete",
      observed: count,
      canonical: count,
      stored: count,
      omitted: { bytes: 0, lines: 0 },
      recovery: { kind: "none" },
    },
  };
}
