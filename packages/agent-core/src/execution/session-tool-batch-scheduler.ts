import type { HitlResponse } from "@archcode/protocol";
import type { StoreApi } from "zustand";

import { toDurableToolInput } from "../store/durable-tool-input";
import type { SessionStoreManager } from "../store/session-store-manager";
import type {
  SessionStoreState,
  SessionToolBatch,
  SessionToolBatchCall,
  SessionToolCallResult,
} from "../store/types";
import { partitionToolCalls } from "../tools/concurrency/partition";
import { createAskUserSuccessResult } from "../tools/builtins/ask-user-format";
import { AskUserInputSchema } from "../tools/builtins/ask-user";
import { createToolErrorResult } from "../tools/errors";
import type { ToolRegistry } from "../tools/registry";
import type { ToolBlockedRequest, ToolCallLike, ToolExecutionControl, ToolExecutionResult } from "../tools/types";

export interface SessionToolBatchQueue {
  create(input: {
    requestKey: string;
    owner: { type: "session"; id: string };
    source: ToolBlockedRequest["source"];
    displayPayload: ToolBlockedRequest["displayPayload"];
    persistentApprovalEligible?: boolean;
  }): Promise<{ record: { hitlId: string } }>;
  cancel(hitlId: string, response: Extract<HitlResponse, { type: "cancel" }>): Promise<unknown>;
  resolve(hitlId: string, outcome: { readonly type: "dispatching" } | { readonly type: "applied" }): Promise<unknown>;
}

export interface SessionToolBatchExecuteContext {
  readonly deferredPermissionResponse?: {
    readonly decision: "approve_once" | "approve_always";
    readonly fingerprint: string;
  };
}

export interface SessionToolBatchSchedulerOptions {
  readonly store: StoreApi<SessionStoreState>;
  readonly storeManager: SessionStoreManager;
  readonly workspaceRoot: string;
  readonly registry: ToolRegistry;
  readonly hitlQueue: SessionToolBatchQueue;
  readonly agentName: SessionStoreState["agentName"];
  readonly allowedTools: readonly string[];
  readonly agentSkills: readonly string[];
  readonly executeCall: (call: ToolCallLike, context: SessionToolBatchExecuteContext) => Promise<ToolExecutionResult>;
}

export type SessionToolBatchAdvanceResult =
  | { readonly status: "ready_for_continuation"; readonly sessionCwdChanged: boolean; readonly executionControl?: ToolExecutionControl }
  | { readonly status: "waiting_for_human"; readonly hitlIds: string[]; readonly sessionCwdChanged: boolean; readonly executionControl?: ToolExecutionControl }
  | { readonly status: "manual_inspection_required"; readonly reason: string };

const TERMINAL_CALL_STATES = new Set<SessionToolBatchCall["state"]>(["completed", "failed"]);

export class SessionToolBatchScheduler {
  readonly #options: SessionToolBatchSchedulerOptions;

  constructor(options: SessionToolBatchSchedulerOptions) {
    this.#options = options;
  }

  activeBatch(): SessionToolBatch | undefined {
    return this.#options.store.getState().toolBatches.find((batch) => batch.archivedAt === undefined);
  }

  async createBatch(toolCalls: readonly ToolCallLike[], step: number): Promise<SessionToolBatch> {
    if (this.activeBatch() !== undefined) throw new Error("Session already has an active tool batch");
    const partitions = partitionToolCalls([...toolCalls], this.#options.registry);
    const partitionIndexByCall = new Map<string, number>();
    partitions.forEach((partition, partitionIndex) => {
      const calls = partition.type === "parallel" ? partition.calls : [partition.call];
      for (const call of calls) partitionIndexByCall.set(call.toolCallId, partitionIndex);
    });
    const now = new Date().toISOString();
    const state = this.#options.store.getState();
    const batch: SessionToolBatch = {
      batchId: crypto.randomUUID(),
      executionId: state.currentExecutionId ?? crypto.randomUUID(),
      ...(state.currentAssistantMessageId === undefined ? {} : { assistantMessageId: state.currentAssistantMessageId }),
      step,
      agentName: this.#options.agentName,
      allowedTools: [...this.#options.allowedTools],
      agentSkills: [...this.#options.agentSkills],
      partitions: partitions.map((partition) => ({
        type: partition.type,
        callIds: (partition.type === "parallel" ? partition.calls : [partition.call]).map((call) => call.toolCallId),
      })),
      calls: toolCalls.map((call, ordinal) => {
        const descriptor = this.#options.registry.get(call.toolName);
        return {
          ordinal,
          partitionIndex: partitionIndexByCall.get(call.toolCallId) ?? ordinal,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: toDurableToolInput(call.input),
          traits: descriptor?.traits ?? { readOnly: false, destructive: false, concurrencySafe: false },
          state: "queued" as const,
          attempt: 0,
        };
      }),
      createdAt: now,
      updatedAt: now,
    };
    await this.#options.storeManager.updateToolBatches(state.sessionId, this.#options.workspaceRoot, (batches) => [...batches, batch]);
    return batch;
  }

  async recoverInterruptedBatch(): Promise<SessionToolBatchAdvanceResult | undefined> {
    const batch = this.activeBatch();
    if (batch === undefined) return undefined;
    if (batch.continuationStartedAt !== undefined && batch.continuationCompletedAt === undefined) {
      return await this.#archiveManual(`LLM continuation for batch ${batch.batchId} was interrupted`);
    }

    await this.#repairBlockerHitlIds(batch.batchId);
    await this.#repairMissingToolResults();

    let manualReason: string | undefined;
    const recoveredResults: Array<{ call: SessionToolBatchCall; result: SessionToolCallResult }> = [];
    await this.#updateBatch(batch.batchId, (current) => ({
      ...current,
      calls: current.calls.map((call) => {
        if (call.state !== "running") return call;
        if (!call.traits.readOnly) {
          manualReason ??= `Effectful tool ${call.toolName} (${call.toolCallId}) has an unknown outcome`;
          return { ...call, state: "manual_inspection_required", recoveryFailure: manualReason };
        }
        if (call.attempt < 2) return { ...call, state: "queued" };
        const result = createToolErrorResult({
          kind: "execution",
          code: "TOOL_RECOVERY_FAILED",
          message: `Read-only tool ${call.toolName} (${call.toolCallId}) remained without a durable result after one recovery retry`,
        });
        recoveredResults.push({ call, result });
        return { ...call, state: "failed", result, recoveryFailure: result.output };
      }),
    }));
    for (const recovered of recoveredResults) this.#appendResult(recovered.call, recovered.result);
    if (recoveredResults.length > 0) {
      await this.#options.storeManager.flushSession(this.#options.store.getState().sessionId, this.#options.workspaceRoot);
    }
    if (manualReason !== undefined) return await this.#archiveManual(manualReason);
    return await this.advance();
  }

  async advance(): Promise<SessionToolBatchAdvanceResult> {
    let sessionCwdChanged = false;
    let executionControl: ToolExecutionControl | undefined;
    let batch = this.#requireActiveBatch();
    for (let partitionIndex = 0; partitionIndex < batch.partitions.length; partitionIndex += 1) {
      batch = this.#requireActiveBatch();
      const partition = batch.partitions[partitionIndex]!;
      const priorCalls = batch.calls.filter((call) => call.partitionIndex < partitionIndex);
      if (!priorCalls.every((call) => TERMINAL_CALL_STATES.has(call.state))) break;

      const calls = partition.callIds.map((callId) => requiredCall(batch, callId));
      const queued = calls.filter((call) => call.state === "queued");
      if (partition.type === "parallel") {
        const settled = await Promise.allSettled(queued.map((call) => this.#runCall(batch.batchId, call.toolCallId)));
        for (const outcome of settled) {
          if (outcome.status === "rejected") throw outcome.reason;
          sessionCwdChanged ||= outcome.value.sessionCwdChanged;
          executionControl ??= outcome.value.executionControl;
        }
      } else if (queued[0] !== undefined) {
        const outcome = await this.#runCall(batch.batchId, queued[0].toolCallId);
        sessionCwdChanged ||= outcome.sessionCwdChanged;
        executionControl ??= outcome.executionControl;
      }

      batch = this.#requireActiveBatch();
      const refreshed = partition.callIds.map((callId) => requiredCall(batch, callId));
      const manual = refreshed.find((call) => call.state === "manual_inspection_required");
      if (manual !== undefined) {
        return await this.#archiveManual(manual.recoveryFailure ?? `Tool ${manual.toolName} requires manual inspection`);
      }
      if (sessionCwdChanged || executionControl !== undefined) {
        await this.#failCallsAfterControlBoundary(batch.batchId, partitionIndex, sessionCwdChanged
          ? {
              code: "SESSION_CWD_CHANGED",
              message: "Tool call skipped because the Session cwd changed",
            }
          : {
              code: "SESSION_EXECUTION_STOPPED",
              message: "Tool call skipped because Session execution stopped",
            });
        return {
          status: "ready_for_continuation",
          sessionCwdChanged,
          ...(executionControl === undefined ? {} : { executionControl }),
        };
      }
      if (!refreshed.every((call) => TERMINAL_CALL_STATES.has(call.state))) break;
    }

    batch = this.#requireActiveBatch();
    const manual = batch.calls.find((call) => call.state === "manual_inspection_required");
    if (manual !== undefined) return await this.#archiveManual(manual.recoveryFailure ?? "Tool outcome requires manual inspection");
    const blockers = batch.calls.filter((call) => call.state === "blocked");
    if (blockers.length > 0 || !batch.calls.every((call) => TERMINAL_CALL_STATES.has(call.state))) {
      return {
        status: "waiting_for_human",
        hitlIds: blockers.flatMap((call) => call.blocker?.hitlId === undefined ? [] : [call.blocker.hitlId]).sort(),
        sessionCwdChanged,
        ...(executionControl === undefined ? {} : { executionControl }),
      };
    }
    return {
      status: "ready_for_continuation",
      sessionCwdChanged,
      ...(executionControl === undefined ? {} : { executionControl }),
    };
  }

  async claimContinuation(): Promise<boolean> {
    const batch = this.#requireActiveBatch();
    if (batch.continuationStartedAt !== undefined) return false;
    await this.#updateBatch(batch.batchId, (current) => ({ ...current, continuationStartedAt: new Date().toISOString() }));
    return true;
  }

  async completeContinuation(): Promise<void> {
    const batch = this.#requireActiveBatch();
    const now = new Date().toISOString();
    await this.#updateBatch(batch.batchId, (current) => ({ ...current, continuationCompletedAt: now, archivedAt: now }));
  }

  async #runCall(batchId: string, toolCallId: string): Promise<{ sessionCwdChanged: boolean; executionControl?: ToolExecutionControl }> {
    let call = requiredCall(this.#requireActiveBatch(), toolCallId);
    if (call.state !== "queued") return { sessionCwdChanged: false };
    await this.#updateBatch(batchId, (batch) => ({
      ...batch,
      calls: batch.calls.map((candidate) => candidate.toolCallId === toolCallId
        ? { ...candidate, state: "running", attempt: candidate.attempt + 1 }
        : candidate),
    }));
    call = requiredCall(this.#requireActiveBatch(), toolCallId);
    const permissionDecision = call.blocker?.permissionDecision;
    const permissionFingerprint = call.blocker?.permissionFingerprint;
    const result = await this.#options.executeCall({
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.input,
    }, {
      ...(permissionFingerprint !== undefined && (permissionDecision === "approve_once" || permissionDecision === "approve_always")
        ? { deferredPermissionResponse: { decision: permissionDecision, fingerprint: permissionFingerprint } }
        : {}),
    });
    if (result.blocked !== undefined) {
      await this.#blockCall(batchId, call, result.blocked);
      return { sessionCwdChanged: false };
    }
    await this.#updateBatch(batchId, (batch) => ({
      ...batch,
      calls: batch.calls.map((candidate) => candidate.toolCallId === toolCallId
        ? { ...candidate, state: result.isError ? "failed" : "completed", result: withoutBlocked(result) }
        : candidate),
    }));
    this.#appendResult(call, result);
    await this.#options.storeManager.flushSession(this.#options.store.getState().sessionId, this.#options.workspaceRoot);
    return {
      sessionCwdChanged: result.meta?.sessionCwdChanged === true,
      ...(executionControlFromMeta(result.meta) === undefined ? {} : { executionControl: executionControlFromMeta(result.meta) }),
    };
  }

  async #blockCall(batchId: string, call: SessionToolBatchCall, blocked: ToolBlockedRequest): Promise<void> {
    const requestKey = `session:${this.#options.store.getState().sessionId}:batch:${batchId}:tool:${call.toolCallId}:attempt:${call.attempt}`
      + (blocked.permissionFingerprint === undefined ? "" : `:permission:${blocked.permissionFingerprint}`);
    await this.#updateBatch(batchId, (batch) => ({
      ...batch,
      calls: batch.calls.map((candidate) => candidate.toolCallId === call.toolCallId ? {
        ...candidate,
        state: "blocked",
        blocker: {
          requestKey,
          source: blocked.source,
          displayPayload: blocked.displayPayload,
          ...(blocked.permissionFingerprint === undefined ? {} : { permissionFingerprint: blocked.permissionFingerprint }),
          ...(blocked.persistentApprovalEligible === undefined ? {} : { persistentApprovalEligible: blocked.persistentApprovalEligible }),
          ...(blocked.permission === undefined ? {} : { permission: blocked.permission }),
        },
      } : candidate),
    }));
    const created = await this.#options.hitlQueue.create({
      requestKey,
      owner: { type: "session", id: this.#options.store.getState().sessionId },
      source: blocked.source,
      displayPayload: blocked.displayPayload,
      ...(blocked.persistentApprovalEligible === undefined ? {} : { persistentApprovalEligible: blocked.persistentApprovalEligible }),
    });
    await this.#updateBatch(batchId, (batch) => ({
      ...batch,
      calls: batch.calls.map((candidate) => candidate.toolCallId === call.toolCallId && candidate.blocker?.requestKey === requestKey
        ? { ...candidate, blocker: { ...candidate.blocker, hitlId: created.record.hitlId } }
        : candidate),
    }));
  }

  async #repairBlockerHitlIds(batchId: string): Promise<void> {
    const batch = this.#requireActiveBatch();
    for (const call of batch.calls) {
      const blocker = call.state === "blocked" ? call.blocker : undefined;
      if (blocker === undefined || blocker.hitlId !== undefined) continue;
      const created = await this.#options.hitlQueue.create({
        requestKey: blocker.requestKey,
        owner: { type: "session", id: this.#options.store.getState().sessionId },
        source: blocker.source,
        displayPayload: blocker.displayPayload,
        ...(blocker.persistentApprovalEligible === undefined ? {} : { persistentApprovalEligible: blocker.persistentApprovalEligible }),
      });
      await this.#updateBatch(batchId, (current) => ({
        ...current,
        calls: current.calls.map((candidate) => candidate.toolCallId === call.toolCallId && candidate.blocker?.requestKey === blocker.requestKey
          ? { ...candidate, blocker: { ...candidate.blocker, hitlId: created.record.hitlId } }
          : candidate),
      }));
    }
  }

  async #repairMissingToolResults(): Promise<void> {
    const batch = this.#requireActiveBatch();
    let appended = false;
    for (const call of batch.calls) {
      if (call.result === undefined || hasSettledToolPart(this.#options.store.getState(), call.toolCallId)) continue;
      this.#appendResult(call, call.result);
      appended = true;
    }
    if (appended) {
      await this.#options.storeManager.flushSession(this.#options.store.getState().sessionId, this.#options.workspaceRoot);
    }
  }

  async #failCallsAfterControlBoundary(
    batchId: string,
    partitionIndex: number,
    failure: { readonly code: string; readonly message: string },
  ): Promise<void> {
    const failed: Array<{ call: SessionToolBatchCall; result: SessionToolCallResult }> = [];
    await this.#updateBatch(batchId, (batch) => ({
      ...batch,
      calls: batch.calls.map((call) => {
        if (call.partitionIndex <= partitionIndex || TERMINAL_CALL_STATES.has(call.state)) return call;
        const result = createToolErrorResult({
          kind: "execution",
          code: failure.code,
          message: failure.message,
          meta: { skippedExecution: true },
        });
        failed.push({ call, result });
        return { ...call, state: "failed", result };
      }),
    }));
    for (const { call, result } of failed) this.#appendResult(call, result);
    if (failed.length > 0) {
      await this.#options.storeManager.flushSession(this.#options.store.getState().sessionId, this.#options.workspaceRoot);
    }
  }

  async #updateBatch(batchId: string, update: (batch: SessionToolBatch) => SessionToolBatch): Promise<void> {
    const sessionId = this.#options.store.getState().sessionId;
    const now = new Date().toISOString();
    await this.#options.storeManager.updateToolBatches(sessionId, this.#options.workspaceRoot, (batches) => batches.map((batch) => (
      batch.batchId === batchId ? { ...update(batch), updatedAt: now } : batch
    )));
  }

  async #archiveManual(reason: string): Promise<SessionToolBatchAdvanceResult> {
    const batch = this.#requireActiveBatch();
    const blockedHitlIds = batch.calls.flatMap((call) => (
      call.state === "blocked" && call.blocker?.hitlId !== undefined ? [call.blocker.hitlId] : []
    ));
    for (const hitlId of blockedHitlIds) {
      await this.#options.hitlQueue.cancel(hitlId, {
        type: "cancel",
        reason: `Tool batch requires manual inspection: ${reason}`,
      });
      await this.#options.hitlQueue.resolve(hitlId, { type: "dispatching" });
    }

    const now = new Date().toISOString();
    const appended: Array<{ call: SessionToolBatchCall; result: SessionToolCallResult }> = [];
    await this.#updateBatch(batch.batchId, (current) => ({
      ...current,
      archivedAt: now,
      manualInspectionReason: reason,
      calls: current.calls.map((call) => {
        if (TERMINAL_CALL_STATES.has(call.state) || call.state === "manual_inspection_required") return call;
        const result = createToolErrorResult({
          kind: "cancelled",
          message: `Tool batch stopped because manual inspection is required: ${reason}`,
        });
        appended.push({ call, result });
        return {
          ...call,
          state: "failed",
          result,
          ...(call.blocker === undefined ? {} : { blocker: { ...call.blocker, responseAppliedAt: now } }),
        };
      }),
    }));
    for (const { call, result } of appended) this.#appendResult(call, result);
    if (appended.length > 0) {
      await this.#options.storeManager.flushSession(this.#options.store.getState().sessionId, this.#options.workspaceRoot);
    }
    for (const hitlId of blockedHitlIds) {
      await this.#options.hitlQueue.resolve(hitlId, { type: "applied" });
    }
    return { status: "manual_inspection_required", reason };
  }

  #requireActiveBatch(): SessionToolBatch {
    const batch = this.activeBatch();
    if (batch === undefined) throw new Error("Session has no active tool batch");
    return batch;
  }

  #appendResult(call: Pick<SessionToolBatchCall, "toolCallId" | "toolName">, result: SessionToolCallResult): void {
    this.#options.store.getState().append({
      type: "tool-result",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output: result.output,
      isError: result.isError,
      ...(result.meta === undefined ? {} : { meta: result.meta }),
    });
  }
}

/** Applies one accepted response to the exact persisted call without executing tools or the model. */
export async function applySessionToolBatchResponse(input: {
  readonly storeManager: SessionStoreManager;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly hitlId: string;
  readonly requestKey: string;
  readonly response: HitlResponse;
}): Promise<{ batchId: string; toolCallId: string }> {
  const store = await input.storeManager.getOrLoad(input.sessionId, input.workspaceRoot);
  const matchingBatches = store.getState().toolBatches.filter((candidate) => candidate.calls.some((call) => (
    call.blocker?.hitlId === input.hitlId || call.blocker?.requestKey === input.requestKey
  )));
  const batch = matchingBatches.find((candidate) => candidate.archivedAt === undefined) ?? matchingBatches.at(-1);
  if (batch === undefined) throw new Error(`HITL ${input.hitlId} does not match a Session tool batch`);
  const call = batch.calls.find((candidate) => candidate.blocker?.hitlId === input.hitlId || candidate.blocker?.requestKey === input.requestKey);
  if (call === undefined || call.blocker === undefined) throw new Error(`HITL ${input.hitlId} does not match an active blocked tool call`);
  if (call.blocker.responseAppliedAt !== undefined) {
    return { batchId: batch.batchId, toolCallId: call.toolCallId };
  }
  if (batch.archivedAt !== undefined) throw new Error(`HITL ${input.hitlId} belongs to an archived tool batch`);
  if (call.state !== "blocked") throw new Error(`HITL ${input.hitlId} call ${call.toolCallId} is not blocked`);
  const now = new Date().toISOString();
  const applied = responseForCall(call, input.response);
  await input.storeManager.updateToolBatches(input.sessionId, input.workspaceRoot, (batches) => batches.map((candidate) => candidate.batchId !== batch.batchId ? candidate : {
    ...candidate,
    updatedAt: now,
    calls: candidate.calls.map((candidateCall) => candidateCall.toolCallId !== call.toolCallId ? candidateCall : {
      ...candidateCall,
      state: applied.state,
      ...(applied.result === undefined ? {} : { result: applied.result }),
      blocker: {
        ...call.blocker!,
        hitlId: input.hitlId,
        responseAppliedAt: now,
        ...(applied.permissionDecision === undefined ? {} : { permissionDecision: applied.permissionDecision }),
      },
    }),
  }));
  if (applied.result !== undefined) {
    store.getState().append({
      type: "tool-result",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output: applied.result.output,
      isError: applied.result.isError,
      ...(applied.result.meta === undefined ? {} : { meta: applied.result.meta }),
    });
    await input.storeManager.flushSession(input.sessionId, input.workspaceRoot);
  }
  return { batchId: batch.batchId, toolCallId: call.toolCallId };
}

export function listSessionToolBatchHitlIds(state: Pick<SessionStoreState, "toolBatches">): string[] {
  const active = state.toolBatches.find((batch) => batch.archivedAt === undefined);
  if (active === undefined) return [];
  return active.calls.flatMap((call) => call.state === "blocked" && call.blocker?.hitlId !== undefined ? [call.blocker.hitlId] : []).sort();
}

/** Validates a pending Session answer before the project queue makes it immutable. */
export async function validateSessionToolBatchResponse(input: {
  readonly storeManager: SessionStoreManager;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly hitlId: string;
  readonly requestKey: string;
  readonly response: HitlResponse;
}): Promise<void> {
  const store = await input.storeManager.getOrLoad(input.sessionId, input.workspaceRoot);
  const batch = store.getState().toolBatches.find((candidate) => candidate.archivedAt === undefined);
  if (batch === undefined) throw new Error(`Session ${input.sessionId} has no active tool batch`);
  const call = batch.calls.find((candidate) => (
    candidate.blocker?.hitlId === input.hitlId || candidate.blocker?.requestKey === input.requestKey
  ));
  if (call === undefined || call.blocker === undefined || call.state !== "blocked") {
    throw new Error(`HITL ${input.hitlId} does not match an active blocked tool call`);
  }
  responseForCall(call, input.response);
}

/** True only when the first incomplete partition can make progress without a new human answer. */
export function hasRunnableSessionToolBatch(state: Pick<SessionStoreState, "toolBatches">): boolean {
  const active = state.toolBatches.find((batch) => batch.archivedAt === undefined);
  if (active === undefined || active.continuationStartedAt !== undefined) return false;
  for (const partition of active.partitions) {
    const calls = partition.callIds.map((callId) => requiredCall(active, callId));
    if (calls.every((call) => TERMINAL_CALL_STATES.has(call.state))) continue;
    return calls.some((call) => call.state === "queued" || call.state === "running" || (call.state === "blocked" && call.blocker?.hitlId === undefined));
  }
  // All tool results are durable but the single continuation has not yet been claimed.
  return active.calls.every((call) => TERMINAL_CALL_STATES.has(call.state));
}

/** Archives an inactive batch during stop/delete and returns queue records the caller must cancel. */
export async function cancelSessionToolBatch(input: {
  readonly storeManager: SessionStoreManager;
  readonly hitlQueue: Pick<SessionToolBatchQueue, "create">;
  readonly prepareHitlCancellation: (hitlIds: readonly string[]) => Promise<void>;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly reason: string;
}): Promise<{ hitlIds: string[]; manualInspectionRequired: boolean }> {
  const store = await input.storeManager.getOrLoad(input.sessionId, input.workspaceRoot);
  let batch = store.getState().toolBatches.find((candidate) => candidate.archivedAt === undefined);
  if (batch === undefined) return { hitlIds: [], manualInspectionRequired: false };
  for (const call of batch.calls) {
    const blocker = call.state === "blocked" ? call.blocker : undefined;
    if (blocker === undefined || blocker.hitlId !== undefined) continue;
    const { record } = await input.hitlQueue.create({
      requestKey: blocker.requestKey,
      owner: { type: "session", id: input.sessionId },
      source: blocker.source,
      displayPayload: blocker.displayPayload,
      ...(blocker.persistentApprovalEligible === undefined ? {} : { persistentApprovalEligible: blocker.persistentApprovalEligible }),
    });
    await input.storeManager.updateToolBatches(input.sessionId, input.workspaceRoot, (batches) => batches.map((candidate) => candidate.batchId !== batch!.batchId ? candidate : {
      ...candidate,
      updatedAt: new Date().toISOString(),
      calls: candidate.calls.map((candidateCall) => candidateCall.toolCallId === call.toolCallId && candidateCall.blocker?.requestKey === blocker.requestKey
        ? { ...candidateCall, blocker: { ...candidateCall.blocker, hitlId: record.hitlId } }
        : candidateCall),
    }));
  }
  batch = store.getState().toolBatches.find((candidate) => candidate.archivedAt === undefined);
  if (batch === undefined) return { hitlIds: [], manualInspectionRequired: false };
  const hitlIds = listSessionToolBatchHitlIds(store.getState());
  await input.prepareHitlCancellation(hitlIds);
  const now = new Date().toISOString();
  let manualInspectionRequired = false;
  const appended: Array<{ call: SessionToolBatchCall; result: SessionToolCallResult }> = [];
  await input.storeManager.updateToolBatches(input.sessionId, input.workspaceRoot, (batches) => batches.map((candidate) => candidate.batchId !== batch.batchId ? candidate : {
    ...candidate,
    updatedAt: now,
    archivedAt: now,
    calls: candidate.calls.map((call) => {
      if (TERMINAL_CALL_STATES.has(call.state)) return call;
      if (call.state === "running" && !call.traits.readOnly) {
        manualInspectionRequired = true;
        return { ...call, state: "manual_inspection_required", recoveryFailure: `Effectful tool ${call.toolName} (${call.toolCallId}) was interrupted during cancellation` };
      }
      const result = createToolErrorResult({ kind: "cancelled", message: input.reason });
      appended.push({ call, result });
      return {
        ...call,
        state: "failed",
        result,
        ...(call.blocker === undefined ? {} : { blocker: { ...call.blocker, responseAppliedAt: now } }),
      };
    }),
    ...(manualInspectionRequired ? { manualInspectionReason: "An effectful tool was running when the batch was cancelled" } : {}),
  }));
  for (const { call, result } of appended) {
    store.getState().append({ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: result.output, isError: true });
  }
  if (appended.length > 0) await input.storeManager.flushSession(input.sessionId, input.workspaceRoot);
  return { hitlIds, manualInspectionRequired };
}

type SessionToolCallBlockerPermissionDecision = "approve_once" | "approve_always" | "deny";

function requiredCall(batch: SessionToolBatch, toolCallId: string): SessionToolBatchCall {
  const call = batch.calls.find((candidate) => candidate.toolCallId === toolCallId);
  if (call === undefined) throw new Error(`Tool call ${toolCallId} is missing from batch ${batch.batchId}`);
  return call;
}

function withoutBlocked(result: ToolExecutionResult): SessionToolCallResult {
  return {
    output: result.output,
    isError: result.isError,
    ...(result.meta === undefined ? {} : { meta: result.meta }),
  };
}

function responseForCall(call: SessionToolBatchCall, response: HitlResponse): {
  state: SessionToolBatchCall["state"];
  result?: SessionToolCallResult;
  permissionDecision?: SessionToolCallBlockerPermissionDecision;
} {
  if (call.blocker === undefined) throw new Error(`Tool call ${call.toolCallId} is not blocked`);
  if (response.type === "cancel") {
    return { state: "failed", result: createToolErrorResult({ kind: "cancelled", message: response.reason }) };
  }
  if (call.blocker.source.type === "ask_user" && response.type === "question_answer") {
    const input = AskUserInputSchema.parse(call.input);
    if (response.answers.length !== input.questions.length) {
      throw new Error(`ask_user received ${response.answers.length} answers but expected ${input.questions.length}`);
    }
    const emptyIndex = response.answers.findIndex((answer) => answer.trim().length === 0);
    if (emptyIndex !== -1) throw new Error(`ask_user received empty answer for question ${emptyIndex + 1}`);
    return { state: "completed", result: createAskUserSuccessResult(response.answers.map((answer) => [answer]), input.questions) };
  }
  if (call.blocker.source.type === "tool_permission" && response.type === "permission_decision") {
    if (response.decision === "approve_always" && call.blocker.persistentApprovalEligible !== true) {
      throw new Error(`HITL permission for ${call.toolName} is not eligible for persistent approval`);
    }
    if (response.decision === "deny") {
      return {
        state: "failed",
        result: createToolErrorResult({ kind: "permission-confirmation-denied", code: "TOOL_PERMISSION_CONFIRMATION_DENIED", message: `User denied ${call.toolName}` }),
        permissionDecision: response.decision,
      };
    }
    return { state: "queued", permissionDecision: response.decision };
  }
  throw new Error(`Response ${response.type} does not match ${call.blocker.source.type}`);
}

function executionControlFromMeta(meta: Record<string, unknown> | undefined): ToolExecutionControl | undefined {
  const value = meta?.executionControl;
  if (typeof value !== "object" || value === null) return undefined;
  const control = value as Partial<ToolExecutionControl>;
  return control.action === "stop_session_family" && control.reason === "goal_cancelled"
    ? { action: control.action, reason: control.reason }
    : undefined;
}

function hasSettledToolPart(state: Pick<SessionStoreState, "messages">, toolCallId: string): boolean {
  return state.messages.some((message) => message.parts.some((part) => (
    part.type === "tool"
    && part.toolCallId === toolCallId
    && (part.state === "completed" || part.state === "error")
  )));
}
