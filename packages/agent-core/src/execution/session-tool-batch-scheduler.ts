import type { FinalizedToolResult, HitlResponse } from "@archcode/protocol";
import type { StoreApi } from "zustand";

import { toDurableToolInput } from "../store/durable-tool-input";
import type { SessionStoreManager } from "../store/session-store-manager";
import type {
  SessionStoreState,
  SessionToolBatch,
  SessionToolBatchCall,
  SessionToolManualInspectionReason,
} from "../store/types";
import { partitionToolCalls } from "../tools/concurrency/partition";
import { createToolErrorResult } from "../tools/errors";
import type { ToolRegistry } from "../tools/registry";
import type {
  RawToolResult,
  RegistryExecutionOutcome,
  ToolBlockedRequest,
  ToolCallLike,
  ToolExecutionContext,
  ToolExecutionControl,
} from "../tools/types";

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

export interface SessionToolBatchSchedulerOptions {
  readonly store: StoreApi<SessionStoreState>;
  readonly storeManager: SessionStoreManager;
  readonly workspaceRoot: string;
  readonly registry: ToolRegistry;
  readonly hitlQueue: SessionToolBatchQueue;
  readonly agentName: SessionStoreState["agentName"];
  readonly allowedTools: readonly string[];
  readonly agentSkills: readonly string[];
  readonly createContext: (call: ToolCallLike, step: number) => ToolExecutionContext | Promise<ToolExecutionContext>;
}

export type SessionToolBatchAdvanceResult =
  | { readonly status: "ready_for_continuation"; readonly sessionCwdChanged: boolean; readonly executionControl?: ToolExecutionControl }
  | { readonly status: "waiting_for_human"; readonly hitlIds: string[]; readonly sessionCwdChanged: boolean; readonly executionControl?: ToolExecutionControl }
  | { readonly status: "manual_inspection_required"; readonly reason: SessionToolManualInspectionReason };

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
      calls: toolCalls.map((call, ordinal) => ({
        ordinal,
        partitionIndex: partitionIndexByCall.get(call.toolCallId) ?? ordinal,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: toDurableToolInput(call.input),
        traits: this.#options.registry.get(call.toolName)?.traits
          ?? { readOnly: false, destructive: false, concurrencySafe: false },
        state: "queued",
        attempt: 0,
      })),
      createdAt: now,
      updatedAt: now,
    };
    await this.#options.storeManager.updateToolBatches(
      state.sessionId,
      this.#options.workspaceRoot,
      (batches) => [...batches, batch],
    );
    return batch;
  }

  async settleQueuedCall(toolCallId: string, raw: RawToolResult): Promise<void> {
    const batch = this.#requireActiveBatch();
    const call = requiredCall(batch, toolCallId);
    if (call.state !== "queued") throw new Error(`Tool call ${toolCallId} is not queued`);
    const outcome = await this.#settleSystem(call, batch.step, raw);
    await this.#commitSettled(batch.batchId, call, outcome);
  }

  async recoverInterruptedBatch(): Promise<SessionToolBatchAdvanceResult | undefined> {
    let batch = this.activeBatch();
    if (batch === undefined) return undefined;
    if (batch.continuationStartedAt !== undefined && batch.continuationCompletedAt === undefined) {
      return await this.#archiveManual({ kind: "continuation_interrupted", batchId: batch.batchId });
    }

    await this.#repairBlockerHitlIds(batch.batchId);
    await this.#repairMissingToolResults();
    batch = this.#requireActiveBatch();

    const unknownEffectful = batch.calls.find((call) => call.state === "running" && !call.traits.readOnly);
    if (unknownEffectful !== undefined) {
      await this.#updateBatch(batch.batchId, (current) => ({
        ...current,
        calls: current.calls.map((call) => call.toolCallId === unknownEffectful.toolCallId
          ? { ...call, state: "manual_inspection_required", recoveryFailure: { kind: "effectful_outcome_unknown" } }
          : call),
      }));
      return await this.#archiveManual({
        kind: "effectful_outcome_unknown",
        toolCallId: unknownEffectful.toolCallId,
        toolName: unknownEffectful.toolName,
      });
    }

    for (const call of batch.calls.filter((candidate) => candidate.state === "running" && candidate.traits.readOnly)) {
      if (call.attempt < 2) {
        await this.#updateBatch(batch.batchId, (current) => ({
          ...current,
          calls: current.calls.map((candidate) => candidate.toolCallId === call.toolCallId
            ? { ...candidate, state: "queued" }
            : candidate),
        }));
        continue;
      }
      const outcome = await this.#settleSystem(call, batch.step, createToolErrorResult({
        kind: "execution",
        code: "TOOL_RECOVERY_FAILED",
        message: "Read-only tool remained without a durable result after one recovery retry",
      }));
      await this.#commitSettled(batch.batchId, call, outcome, { kind: "read_retry_exhausted" });
    }
    return await this.advance();
  }

  async advance(): Promise<SessionToolBatchAdvanceResult> {
    let sessionCwdChanged = false;
    let executionControl: ToolExecutionControl | undefined;
    let batch = this.#requireActiveBatch();
    for (let partitionIndex = 0; partitionIndex < batch.partitions.length; partitionIndex += 1) {
      batch = this.#requireActiveBatch();
      const partition = batch.partitions[partitionIndex]!;
      if (!batch.calls.filter((call) => call.partitionIndex < partitionIndex).every((call) => TERMINAL_CALL_STATES.has(call.state))) break;

      const calls = partition.callIds.map((callId) => requiredCall(batch, callId));
      const queued = calls.filter((call) => call.state === "queued");
      if (partition.type === "parallel") {
        const outcomes = await Promise.all(queued.map((call) => this.#runCall(batch.batchId, call.toolCallId)));
        for (const outcome of outcomes) {
          sessionCwdChanged ||= outcome.sessionCwdChanged;
          executionControl ??= outcome.executionControl;
        }
      } else if (queued[0] !== undefined) {
        const outcome = await this.#runCall(batch.batchId, queued[0].toolCallId);
        sessionCwdChanged ||= outcome.sessionCwdChanged;
        executionControl ??= outcome.executionControl;
      }

      if (executionControl !== undefined) {
        return {
          status: "ready_for_continuation",
          sessionCwdChanged,
          executionControl,
        };
      }

      batch = this.#requireActiveBatch();
      const refreshed = partition.callIds.map((callId) => requiredCall(batch, callId));
      const manual = refreshed.find((call) => call.state === "manual_inspection_required");
      if (manual !== undefined) {
        return await this.#archiveManual(manualReasonFromCall(manual));
      }
      if (sessionCwdChanged) {
        await this.#failCallsAfterControlBoundary(batch.batchId, partitionIndex, {
          code: "SESSION_CWD_CHANGED",
          message: "Tool call skipped because the Session cwd changed",
        });
        return {
          status: "ready_for_continuation",
          sessionCwdChanged,
        };
      }
      if (!refreshed.every((call) => TERMINAL_CALL_STATES.has(call.state))) break;
    }

    batch = this.#requireActiveBatch();
    const manual = batch.calls.find((call) => call.state === "manual_inspection_required");
    if (manual !== undefined) return await this.#archiveManual(manualReasonFromCall(manual));
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
    const batch = this.#requireActiveBatch();
    call = requiredCall(batch, toolCallId);
    const toolCall = toToolCall(call);
    const context = await this.#options.createContext(toolCall, batch.step);
    const blocker = call.blocker;
    const outcome = blocker?.response === undefined
      ? await this.#options.registry.execute(toolCall, context)
      : await this.#options.registry.resumeBlocked({
          toolCall,
          request: requestFromBlocker(blocker),
          requestKey: blocker.requestKey,
          response: blocker.response,
          context,
        });
    if (outcome.kind === "blocked") {
      await this.#blockCall(batchId, call, outcome.requestKey, outcome.request);
      return { sessionCwdChanged: false };
    }
    if (outcome.sidecar?.executionControl !== undefined) {
      await this.#commitExecutionControlBoundary(batch, call, outcome);
    } else {
      await this.#commitSettled(batchId, call, outcome);
    }
    return {
      sessionCwdChanged: outcome.sidecar?.sessionCwdChanged === true,
      ...(outcome.sidecar?.executionControl === undefined ? {} : { executionControl: outcome.sidecar.executionControl }),
    };
  }

  /**
   * A successful terminal tool result and the fact that its batch needs no LLM
   * continuation are one durable transition. Keeping those as separate writes
   * can revive a completed child through the runtime Tool Batch reconciler.
   */
  async #commitExecutionControlBoundary(
    batch: SessionToolBatch,
    call: SessionToolBatchCall,
    outcome: Extract<RegistryExecutionOutcome, { kind: "settled" }>,
  ): Promise<void> {
    const partition = batch.partitions[call.partitionIndex];
    if (partition?.type !== "serial") {
      throw new Error(`Execution-control tool call ${call.toolCallId} must own a serial Tool Batch partition`);
    }

    const skipped = batch.calls.filter((candidate) => (
      candidate.toolCallId !== call.toolCallId && !TERMINAL_CALL_STATES.has(candidate.state)
    ));
    const skippedOutcomes = new Map<string, Extract<RegistryExecutionOutcome, { kind: "settled" }>>();
    for (const candidate of skipped) {
      skippedOutcomes.set(candidate.toolCallId, await this.#settleSystem(
        candidate,
        batch.step,
        createToolErrorResult({
          kind: "execution",
          code: "SESSION_EXECUTION_STOPPED",
          message: "Tool call skipped because Session execution stopped",
        }),
      ));
    }

    const now = new Date().toISOString();
    await this.#updateBatch(batch.batchId, (current) => ({
      ...current,
      archivedAt: now,
      calls: current.calls.map((candidate) => {
        if (candidate.toolCallId === call.toolCallId) {
          return {
            ...candidate,
            state: outcome.result.isError ? "failed" as const : "completed" as const,
            result: outcome.result,
          };
        }
        const skippedOutcome = skippedOutcomes.get(candidate.toolCallId);
        if (skippedOutcome === undefined) return candidate;
        return {
          ...candidate,
          state: skippedOutcome.result.isError ? "failed" as const : "completed" as const,
          result: skippedOutcome.result,
        };
      }),
    }));
    for (const candidate of batch.calls) {
      if (candidate.toolCallId === call.toolCallId) {
        this.#appendResult(candidate, outcome.result);
        continue;
      }
      const skippedOutcome = skippedOutcomes.get(candidate.toolCallId);
      if (skippedOutcome !== undefined) this.#appendResult(candidate, skippedOutcome.result);
    }
    await this.#flush();
  }

  async #blockCall(
    batchId: string,
    call: SessionToolBatchCall,
    requestKey: string,
    request: ToolBlockedRequest,
  ): Promise<void> {
    await this.#updateBatch(batchId, (batch) => ({
      ...batch,
      calls: batch.calls.map((candidate) => candidate.toolCallId === call.toolCallId ? {
        ...candidate,
        state: "blocked",
        blocker: blockerFromRequest(requestKey, request),
      } : candidate),
    }));
    const created = await this.#options.hitlQueue.create({
      requestKey,
      owner: { type: "session", id: this.#options.store.getState().sessionId },
      source: request.source,
      displayPayload: request.displayPayload,
      ...("permissionFingerprint" in request
        ? { persistentApprovalEligible: request.persistentApprovalEligible }
        : {}),
    });
    await this.#updateBatch(batchId, (batch) => ({
      ...batch,
      calls: batch.calls.map((candidate) => candidate.toolCallId === call.toolCallId && candidate.blocker?.requestKey === requestKey
        ? { ...candidate, blocker: { ...candidate.blocker, hitlId: created.record.hitlId } }
        : candidate),
    }));
  }

  async #repairBlockerHitlIds(batchId: string): Promise<void> {
    for (const call of this.#requireActiveBatch().calls) {
      const blocker = call.state === "blocked" ? call.blocker : undefined;
      if (blocker === undefined || blocker.hitlId !== undefined) continue;
      const created = await this.#options.hitlQueue.create({
        requestKey: blocker.requestKey,
        owner: { type: "session", id: this.#options.store.getState().sessionId },
        source: blocker.source,
        displayPayload: blocker.displayPayload,
        ...(blocker.source.type === "tool_permission"
          ? { persistentApprovalEligible: blocker.persistentApprovalEligible }
          : {}),
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
    let appended = false;
    for (const call of this.#requireActiveBatch().calls) {
      if (call.result === undefined || hasSettledToolPart(this.#options.store.getState(), call.toolCallId)) continue;
      this.#appendResult(call, call.result);
      appended = true;
    }
    if (appended) await this.#flush();
  }

  async #failCallsAfterControlBoundary(
    batchId: string,
    partitionIndex: number,
    failure: { readonly code: string; readonly message: string },
  ): Promise<void> {
    const batch = this.#requireActiveBatch();
    for (const call of batch.calls) {
      if (call.partitionIndex <= partitionIndex || TERMINAL_CALL_STATES.has(call.state)) continue;
      const outcome = await this.#settleSystem(call, batch.step, createToolErrorResult({
        kind: "execution",
        code: failure.code,
        message: failure.message,
      }));
      await this.#commitSettled(batchId, call, outcome);
    }
  }

  async #archiveManual(reason: SessionToolManualInspectionReason): Promise<SessionToolBatchAdvanceResult> {
    const batch = this.#requireActiveBatch();
    const blockedHitlIds = batch.calls.flatMap((call) => (
      call.state === "blocked" && call.blocker?.hitlId !== undefined ? [call.blocker.hitlId] : []
    ));
    for (const hitlId of blockedHitlIds) {
      await this.#options.hitlQueue.cancel(hitlId, {
        type: "cancel",
        reason: "Tool batch requires manual inspection",
      });
      await this.#options.hitlQueue.resolve(hitlId, { type: "dispatching" });
    }

    for (const call of batch.calls) {
      if (TERMINAL_CALL_STATES.has(call.state) || call.state === "manual_inspection_required") continue;
      const outcome = await this.#settleSystem(call, batch.step, createToolErrorResult({
        kind: "cancelled",
        code: "TOOL_BATCH_MANUAL_INSPECTION",
        message: "Tool batch stopped because manual inspection is required",
      }));
      await this.#commitSettled(batch.batchId, call, outcome, undefined, true);
    }
    const now = new Date().toISOString();
    await this.#updateBatch(batch.batchId, (current) => ({ ...current, archivedAt: now, manualInspectionReason: reason }));
    for (const hitlId of blockedHitlIds) await this.#options.hitlQueue.resolve(hitlId, { type: "applied" });
    return { status: "manual_inspection_required", reason };
  }

  async #settleSystem(call: SessionToolBatchCall, step: number, raw: RawToolResult): Promise<Extract<RegistryExecutionOutcome, { kind: "settled" }>> {
    const toolCall = toToolCall(call);
    const outcome = await this.#options.registry.settleSystem(
      toolCall,
      await this.#options.createContext(toolCall, step),
      raw,
    );
    if (outcome.kind !== "settled") throw new Error("System result unexpectedly blocked");
    return outcome;
  }

  async #commitSettled(
    batchId: string,
    call: SessionToolBatchCall,
    outcome: Extract<RegistryExecutionOutcome, { kind: "settled" }>,
    recoveryFailure?: SessionToolBatchCall["recoveryFailure"],
    markBlockerApplied = false,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.#updateBatch(batchId, (batch) => ({
      ...batch,
      calls: batch.calls.map((candidate) => candidate.toolCallId === call.toolCallId ? {
        ...candidate,
        state: outcome.result.isError ? "failed" : "completed",
        result: outcome.result,
        ...(recoveryFailure === undefined ? {} : { recoveryFailure }),
        ...(markBlockerApplied && candidate.blocker !== undefined
          ? { blocker: { ...candidate.blocker, responseAppliedAt: candidate.blocker.responseAppliedAt ?? now, response: candidate.blocker.response ?? { type: "cancel", reason: "Tool batch stopped" } } }
          : {}),
      } : candidate),
    }));
    this.#appendResult(call, outcome.result);
    await this.#flush();
  }

  async #updateBatch(batchId: string, update: (batch: SessionToolBatch) => SessionToolBatch): Promise<void> {
    const sessionId = this.#options.store.getState().sessionId;
    const now = new Date().toISOString();
    await this.#options.storeManager.updateToolBatches(sessionId, this.#options.workspaceRoot, (batches) => batches.map((batch) => (
      batch.batchId === batchId ? { ...update(batch), updatedAt: now } : batch
    )));
  }

  #requireActiveBatch(): SessionToolBatch {
    const batch = this.activeBatch();
    if (batch === undefined) throw new Error("Session has no active tool batch");
    return batch;
  }

  #appendResult(call: Pick<SessionToolBatchCall, "toolCallId" | "toolName">, result: FinalizedToolResult): void {
    this.#options.store.getState().append({
      type: "tool-result",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      result,
    });
  }

  async #flush(): Promise<void> {
    await this.#options.storeManager.flushSession(this.#options.store.getState().sessionId, this.#options.workspaceRoot);
  }
}

/** Persists one accepted response for later Registry.resumeBlocked execution. */
export async function applySessionToolBatchResponse(input: {
  readonly registry: ToolRegistry;
  readonly storeManager: SessionStoreManager;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly hitlId: string;
  readonly requestKey: string;
  readonly response: HitlResponse;
}): Promise<{ batchId: string; toolCallId: string }> {
  const store = await input.storeManager.getOrLoad(input.sessionId, input.workspaceRoot);
  const { batch, call } = requireExactBlockedCall(store.getState(), input.hitlId, input.requestKey);
  if (call.blocker!.response !== undefined) {
    if (JSON.stringify(call.blocker!.response) !== JSON.stringify(input.response)) throw new Error("HITL response conflicts with the accepted response");
    return { batchId: batch.batchId, toolCallId: call.toolCallId };
  }
  const response = input.registry.validateBlockedResponse(requestFromBlocker(call.blocker!), input.response);
  const now = new Date().toISOString();
  await input.storeManager.updateToolBatches(input.sessionId, input.workspaceRoot, (batches) => batches.map((candidate) => candidate.batchId !== batch.batchId ? candidate : {
    ...candidate,
    updatedAt: now,
    calls: candidate.calls.map((candidateCall) => candidateCall.toolCallId !== call.toolCallId ? candidateCall : {
      ...candidateCall,
      state: "queued",
      blocker: { ...call.blocker!, hitlId: input.hitlId, responseAppliedAt: now, response },
    }),
  }));
  return { batchId: batch.batchId, toolCallId: call.toolCallId };
}

export function listSessionToolBatchHitlIds(state: Pick<SessionStoreState, "toolBatches">): string[] {
  const active = state.toolBatches.find((batch) => batch.archivedAt === undefined);
  if (active === undefined) return [];
  return active.calls.flatMap((call) => call.state === "blocked" && call.blocker?.hitlId !== undefined ? [call.blocker.hitlId] : []).sort();
}

export async function validateSessionToolBatchResponse(input: {
  readonly registry: ToolRegistry;
  readonly storeManager: SessionStoreManager;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly hitlId: string;
  readonly requestKey: string;
  readonly response: HitlResponse;
}): Promise<void> {
  const store = await input.storeManager.getOrLoad(input.sessionId, input.workspaceRoot);
  const { call } = requireExactBlockedCall(store.getState(), input.hitlId, input.requestKey);
  input.registry.validateBlockedResponse(requestFromBlocker(call.blocker!), input.response);
}

export function hasRunnableSessionToolBatch(state: Pick<SessionStoreState, "toolBatches">): boolean {
  const active = state.toolBatches.find((batch) => batch.archivedAt === undefined);
  if (active === undefined || active.continuationStartedAt !== undefined) return false;
  for (const partition of active.partitions) {
    const calls = partition.callIds.map((callId) => requiredCall(active, callId));
    if (calls.every((call) => TERMINAL_CALL_STATES.has(call.state))) continue;
    return calls.some((call) => call.state === "queued" || call.state === "running" || (call.state === "blocked" && call.blocker?.hitlId === undefined));
  }
  return active.calls.every((call) => TERMINAL_CALL_STATES.has(call.state));
}

export async function cancelSessionToolBatch(input: {
  readonly storeManager: SessionStoreManager;
  readonly hitlQueue: Pick<SessionToolBatchQueue, "create">;
  readonly prepareHitlCancellation: (hitlIds: readonly string[]) => Promise<void>;
  readonly settleSystem: (call: ToolCallLike, step: number, raw: RawToolResult) => Promise<Extract<RegistryExecutionOutcome, { kind: "settled" }>>;
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
      ...(blocker.source.type === "tool_permission" ? { persistentApprovalEligible: blocker.persistentApprovalEligible } : {}),
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
  let manualInspectionRequired = false;
  let manualReason: SessionToolManualInspectionReason | undefined;
  for (const call of batch.calls) {
    if (TERMINAL_CALL_STATES.has(call.state)) continue;
    if (call.state === "running" && !call.traits.readOnly) {
      manualInspectionRequired = true;
      manualReason = { kind: "effectful_cancelled_unknown", toolCallId: call.toolCallId, toolName: call.toolName };
      await updateSingleCall(input.storeManager, input.sessionId, input.workspaceRoot, batch.batchId, call.toolCallId, (current) => ({
        ...current,
        state: "manual_inspection_required",
        recoveryFailure: { kind: "effectful_cancelled_unknown" },
      }));
      continue;
    }
    const outcome = await input.settleSystem(toToolCall(call), batch.step, createToolErrorResult({ kind: "cancelled", message: input.reason }));
    await updateSingleCall(input.storeManager, input.sessionId, input.workspaceRoot, batch.batchId, call.toolCallId, (current) => ({
      ...current,
      state: "failed",
      result: outcome.result,
      ...(current.blocker === undefined ? {} : {
        blocker: {
          ...current.blocker,
          responseAppliedAt: new Date().toISOString(),
          response: { type: "cancel", reason: "Session tool batch cancelled" },
        },
      }),
    }));
    store.getState().append({ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, result: outcome.result });
  }
  const now = new Date().toISOString();
  await input.storeManager.updateToolBatches(input.sessionId, input.workspaceRoot, (batches) => batches.map((candidate) => candidate.batchId !== batch!.batchId ? candidate : {
    ...candidate,
    updatedAt: now,
    archivedAt: now,
    ...(manualReason === undefined ? {} : { manualInspectionReason: manualReason }),
  }));
  await input.storeManager.flushSession(input.sessionId, input.workspaceRoot);
  return { hitlIds, manualInspectionRequired };
}

function blockerFromRequest(requestKey: string, request: ToolBlockedRequest): NonNullable<SessionToolBatchCall["blocker"]> {
  return {
    requestKey,
    source: request.source,
    displayPayload: request.displayPayload,
    ...("permissionFingerprint" in request ? {
      permissionFingerprint: request.permissionFingerprint,
      persistentApprovalEligible: request.persistentApprovalEligible,
      permission: request.permission,
    } : {}),
  };
}

function requestFromBlocker(blocker: NonNullable<SessionToolBatchCall["blocker"]>): ToolBlockedRequest {
  if (blocker.source.type === "ask_user") return { source: blocker.source, displayPayload: blocker.displayPayload };
  if (blocker.permissionFingerprint === undefined || blocker.persistentApprovalEligible === undefined || blocker.permission === undefined) {
    throw new Error("Persisted permission blocker is incomplete");
  }
  return {
    source: blocker.source,
    displayPayload: blocker.displayPayload,
    permissionFingerprint: blocker.permissionFingerprint,
    persistentApprovalEligible: blocker.persistentApprovalEligible,
    permission: blocker.permission,
  };
}

function requireExactBlockedCall(
  state: Pick<SessionStoreState, "toolBatches">,
  hitlId: string,
  requestKey: string,
): { batch: SessionToolBatch; call: SessionToolBatchCall } {
  const batch = state.toolBatches.find((candidate) => candidate.archivedAt === undefined && candidate.calls.some((call) => (
    call.blocker?.hitlId === hitlId && call.blocker.requestKey === requestKey
  )));
  if (batch === undefined) throw new Error(`HITL ${hitlId} and request key do not match an active Session tool batch`);
  const call = batch.calls.find((candidate) => candidate.blocker?.hitlId === hitlId && candidate.blocker.requestKey === requestKey);
  if (call === undefined || call.blocker === undefined) throw new Error(`HITL ${hitlId} does not match an active blocked tool call`);
  if (call.state !== "blocked" && !(call.state === "queued" && call.blocker.response !== undefined)) {
    throw new Error(`HITL ${hitlId} call ${call.toolCallId} is not awaiting or holding a response`);
  }
  return { batch, call };
}

function requiredCall(batch: SessionToolBatch, toolCallId: string): SessionToolBatchCall {
  const call = batch.calls.find((candidate) => candidate.toolCallId === toolCallId);
  if (call === undefined) throw new Error(`Tool call ${toolCallId} is missing from batch ${batch.batchId}`);
  return call;
}

function toToolCall(call: Pick<SessionToolBatchCall, "toolCallId" | "toolName" | "input">): ToolCallLike {
  return { toolCallId: call.toolCallId, toolName: call.toolName, input: call.input };
}

function manualReasonFromCall(call: SessionToolBatchCall): SessionToolManualInspectionReason {
  return {
    kind: call.recoveryFailure?.kind === "effectful_cancelled_unknown"
      ? "effectful_cancelled_unknown"
      : "effectful_outcome_unknown",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
  };
}

function hasSettledToolPart(state: Pick<SessionStoreState, "messages">, toolCallId: string): boolean {
  return state.messages.some((message) => message.parts.some((part) => (
    part.type === "tool" && part.toolCallId === toolCallId && (part.state === "completed" || part.state === "error")
  )));
}

async function updateSingleCall(
  storeManager: SessionStoreManager,
  sessionId: string,
  workspaceRoot: string,
  batchId: string,
  toolCallId: string,
  update: (call: SessionToolBatchCall) => SessionToolBatchCall,
): Promise<void> {
  await storeManager.updateToolBatches(sessionId, workspaceRoot, (batches) => batches.map((batch) => batch.batchId !== batchId ? batch : {
    ...batch,
    updatedAt: new Date().toISOString(),
    calls: batch.calls.map((call) => call.toolCallId === toolCallId ? update(call) : call),
  }));
}
