import type { HitlResponse } from "@archcode/protocol";
import type { StoreApi } from "zustand";
import type { ChildExecutionOutcome } from "../delegation/types";

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
  readonly executionId: string;
  readonly runOrdinal: number;
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
  | { readonly status: "ready_for_continuation"; readonly sessionCwdChanged: boolean }
  | { readonly status: "execution_completed"; readonly sessionCwdChanged: boolean }
  | {
      readonly status: "suspended_hitl";
      readonly toolBatchId: string;
      readonly hitlIds: string[];
      readonly sessionCwdChanged: boolean;
    }
  | {
      readonly status: "waiting_for_child";
      readonly toolBatchId: string;
      readonly toolCallId: string;
      readonly childSessionId: string;
      readonly childExecutionId: string;
      readonly sessionCwdChanged: boolean;
    }
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

  async createBatch(toolCalls: readonly ToolCallLike[], stepId: string, step: number): Promise<SessionToolBatch> {
    if (this.activeBatch() !== undefined) throw new Error("Session already has an active tool batch");
    const partitions = partitionToolCalls([...toolCalls], this.#options.registry);
    const partitionIndexByCall = new Map<string, number>();
    partitions.forEach((partition, partitionIndex) => {
      const calls = partition.type === "parallel" ? partition.calls : [partition.call];
      for (const call of calls) partitionIndexByCall.set(call.toolCallId, partitionIndex);
    });
    const checkpointAt = Date.now();
    const now = new Date(checkpointAt).toISOString();
    const state = this.#options.store.getState();
    if (state.currentExecutionId !== this.#options.executionId) {
      throw new Error(
        `Tool batch execution ${this.#options.executionId} does not match current Session execution ${state.currentExecutionId ?? "none"}`,
      );
    }
    const assistantMessageId = state.currentAssistantMessageId;
    if (assistantMessageId === undefined) {
      throw new Error(`Tool batch step ${stepId} has no current Assistant message`);
    }
    const assistant = assistantMessageId === undefined
      ? undefined
      : state.messages.find((message) => message.id === assistantMessageId);
    if (assistant?.role !== "assistant" || assistant.stepId !== stepId) {
      throw new Error(`Tool batch step ${stepId} has no current model-step Assistant message`);
    }
    const batch: SessionToolBatch = {
      batchId: crypto.randomUUID(),
      executionId: this.#options.executionId,
      runOrdinal: this.#options.runOrdinal,
      stepId,
      assistantMessageId,
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
        checkpointAt,
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

  async prepareChildLaunch(input: {
    readonly parentExecutionId: string;
    readonly parentRunOrdinal: number;
    readonly parentToolBatchId: string;
    readonly parentToolCallId: string;
    readonly childSessionId: string;
    readonly childExecutionId: string;
  }): Promise<void> {
    const batch = this.#requireActiveBatch();
    if (
      batch.batchId !== input.parentToolBatchId
      || batch.executionId !== input.parentExecutionId
      || batch.runOrdinal !== input.parentRunOrdinal
    ) throw new Error("Synchronous child launch does not match its active Tool Batch");
    const call = requiredCall(batch, input.parentToolCallId);
    if (call.state === "child_launch" || call.state === "child_dependency") {
      if (
        call.childDependency?.parentExecutionId !== input.parentExecutionId
        || call.childDependency.runOrdinal !== input.parentRunOrdinal
        || call.childDependency.toolCallId !== input.parentToolCallId
        || call.childDependency.childSessionId !== input.childSessionId
        || call.childDependency.childExecutionId !== input.childExecutionId
      ) throw new Error("Synchronous child launch conflicts with its durable intent");
      return;
    }
    if (call.state !== "running") throw new Error(`Tool call ${call.toolCallId} cannot prepare a child launch from ${call.state}`);
    const createdAt = Date.now();
    await this.#updateBatch(batch.batchId, (current) => ({
      ...current,
      calls: current.calls.map((candidate) => candidate.toolCallId !== call.toolCallId ? candidate : {
        ...candidate,
        state: "child_launch",
        checkpointAt: createdAt,
        childDependency: {
          kind: "child_launch",
          parentExecutionId: input.parentExecutionId,
          runOrdinal: input.parentRunOrdinal,
          toolCallId: input.parentToolCallId,
          childSessionId: input.childSessionId,
          childExecutionId: input.childExecutionId,
          createdAt,
        },
      }),
    }));
  }

  async recoverInterruptedBatch(): Promise<SessionToolBatchAdvanceResult | undefined> {
    let batch = this.activeBatch();
    if (batch === undefined) return undefined;

    await this.#repairBlockerHitlIds(batch.batchId);
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
    let batch = this.#requireActiveBatch();
    let executionCompleted = batch.calls.some((call) => call.state === "completed" && call.executionCompleted === true);
    for (let partitionIndex = 0; partitionIndex < batch.partitions.length; partitionIndex += 1) {
      batch = this.#requireActiveBatch();
      const partition = batch.partitions[partitionIndex]!;
      if (!batch.calls.filter((call) => call.partitionIndex < partitionIndex).every((call) => TERMINAL_CALL_STATES.has(call.state))) break;

      const calls = partition.callIds.map((callId) => requiredCall(batch, callId));
      const hasUnansweredBlocker = batch.calls.some((call) => call.state === "blocked");
      const queued = calls.filter((call) =>
        call.state === "queued"
        && !(hasUnansweredBlocker && isApprovedPermissionResponse(call.blocker?.response))
      );
      if (partition.type === "parallel") {
        const outcomes = await Promise.all(queued.map((call) => this.#runCall(batch.batchId, call.toolCallId)));
        for (const outcome of outcomes) {
          sessionCwdChanged ||= outcome.sessionCwdChanged;
          executionCompleted ||= outcome.executionCompleted;
        }
      } else if (queued[0] !== undefined) {
        const outcome = await this.#runCall(batch.batchId, queued[0].toolCallId);
        sessionCwdChanged ||= outcome.sessionCwdChanged;
        executionCompleted ||= outcome.executionCompleted;
      }

      batch = this.#requireActiveBatch();
      const refreshed = partition.callIds.map((callId) => requiredCall(batch, callId));
      const manual = refreshed.find((call) => call.state === "manual_inspection_required");
      if (manual !== undefined) {
        return await this.#archiveManual(manualReasonFromCall(manual));
      }
      const child = refreshed.find((call) =>
        call.state === "child_launch" || call.state === "child_dependency"
      );
      if (child?.childDependency !== undefined) {
        return {
          status: "waiting_for_child",
          toolBatchId: batch.batchId,
          toolCallId: child.toolCallId,
          childSessionId: child.childDependency.childSessionId,
          childExecutionId: child.childDependency.childExecutionId,
          sessionCwdChanged,
        };
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
      if (executionCompleted) {
        await this.#failCallsAfterControlBoundary(batch.batchId, partitionIndex, {
          code: "SESSION_EXECUTION_COMPLETED",
          message: "Tool call skipped because a prior tool completed the current Execution",
        });
        await this.#archiveExecutionCompletion(batch.batchId);
        return { status: "execution_completed", sessionCwdChanged };
      }
      if (!refreshed.every((call) => TERMINAL_CALL_STATES.has(call.state))) break;
    }

    batch = this.#requireActiveBatch();
    const manual = batch.calls.find((call) => call.state === "manual_inspection_required");
    if (manual !== undefined) return await this.#archiveManual(manualReasonFromCall(manual));
    const child = batch.calls.find((call) =>
      call.state === "child_launch" || call.state === "child_dependency"
    );
    if (child?.childDependency !== undefined) {
      return {
        status: "waiting_for_child",
        toolBatchId: batch.batchId,
        toolCallId: child.toolCallId,
        childSessionId: child.childDependency.childSessionId,
        childExecutionId: child.childDependency.childExecutionId,
        sessionCwdChanged,
      };
    }
    const blockers = batch.calls.filter((call) => call.state === "blocked");
    if (blockers.length > 0 || !batch.calls.every((call) => TERMINAL_CALL_STATES.has(call.state))) {
      return {
        status: "suspended_hitl",
        toolBatchId: batch.batchId,
        hitlIds: blockers.flatMap((call) => call.blocker?.hitlId === undefined ? [] : [call.blocker.hitlId]).sort(),
        sessionCwdChanged,
      };
    }
    return {
      status: "ready_for_continuation",
      sessionCwdChanged,
    };
  }

  async completeContinuation(): Promise<void> {
    const batch = this.#requireActiveBatch();
    const now = new Date().toISOString();
    await this.#updateBatch(batch.batchId, (current) => ({ ...current, archivedAt: now }));
  }

  async #runCall(batchId: string, toolCallId: string): Promise<{ sessionCwdChanged: boolean; executionCompleted: boolean }> {
    let call = requiredCall(this.#requireActiveBatch(), toolCallId);
    if (call.state !== "queued") return {
      sessionCwdChanged: false,
      executionCompleted: call.state === "completed" && call.executionCompleted === true,
    };
    const checkpointAt = Date.now();
    await this.#updateBatch(batchId, (batch) => ({
      ...batch,
      calls: batch.calls.map((candidate) => candidate.toolCallId === toolCallId
        ? { ...candidate, state: "running", attempt: candidate.attempt + 1, checkpointAt }
        : candidate),
    }));
    const batch = this.#requireActiveBatch();
    call = requiredCall(batch, toolCallId);
    const toolCall = toToolCall(call);
    const context = await this.#options.createContext(toolCall, batch.step);
    const blocker = call.blocker;
    const dependency = call.childDependency;
    const outcome = dependency?.kind === "child_dependency" && dependency.outcome !== undefined
      ? await this.#options.registry.resumeChildDependency({
          toolCall,
          dependency: {
            parentExecutionId: dependency.parentExecutionId,
            runOrdinal: dependency.runOrdinal,
            toolBatchId: batch.batchId,
            toolCallId: dependency.toolCallId,
            childSessionId: dependency.childSessionId,
            childExecutionId: dependency.childExecutionId,
          },
          outcome: {
            outcome: "terminal",
            executionId: dependency.childExecutionId,
            executionStatus: dependency.outcome.executionStatus,
            ...(dependency.outcome.output === undefined ? {} : { output: dependency.outcome.output }),
            ...(dependency.outcome.terminalError === undefined
              ? {}
              : { terminalError: dependency.outcome.terminalError }),
          },
          context,
        })
      : blocker?.response === undefined
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
      return { sessionCwdChanged: false, executionCompleted: false };
    }
    if (outcome.kind === "child_deferred") {
      await this.#deferChild(batchId, call, outcome.dependency);
      return { sessionCwdChanged: false, executionCompleted: false };
    }
    await this.#commitSettled(batchId, call, outcome);
    return {
      sessionCwdChanged: outcome.sidecar?.sessionCwdChanged === true,
      executionCompleted: outcome.sidecar?.executionCompleted === true,
    };
  }

  async #deferChild(
    batchId: string,
    call: SessionToolBatchCall,
    dependency: Extract<RegistryExecutionOutcome, { kind: "child_deferred" }>["dependency"],
  ): Promise<void> {
    const launch = call.childDependency ?? requiredCall(this.#requireActiveBatch(), call.toolCallId).childDependency;
    if (
      launch?.kind !== "child_launch"
      || dependency.parentExecutionId !== launch.parentExecutionId
      || dependency.runOrdinal !== launch.runOrdinal
      || dependency.toolCallId !== launch.toolCallId
      || dependency.childSessionId !== launch.childSessionId
      || dependency.childExecutionId !== launch.childExecutionId
    ) throw new Error("Child-deferred result does not match the durable launch intent");
    const dependencyStartedAt = Date.now();
    await this.#updateBatch(batchId, (batch) => ({
      ...batch,
      calls: batch.calls.map((candidate) => candidate.toolCallId !== call.toolCallId ? candidate : {
        ...candidate,
        state: "child_dependency",
        checkpointAt: dependencyStartedAt,
        childDependency: {
          ...launch,
          kind: "child_dependency",
          dependencyStartedAt,
        },
      }),
    }));
  }

  async #blockCall(
    batchId: string,
    call: SessionToolBatchCall,
    requestKey: string,
    request: ToolBlockedRequest,
  ): Promise<void> {
    const checkpointAt = Date.now();
    await this.#updateBatch(batchId, (batch) => ({
      ...batch,
      calls: batch.calls.map((candidate) => candidate.toolCallId === call.toolCallId ? {
        ...candidate,
        state: "blocked",
        checkpointAt,
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
    await repairSessionToolBatchHitlIds({
      store: this.#options.store,
      storeManager: this.#options.storeManager,
      workspaceRoot: this.#options.workspaceRoot,
      hitlQueue: this.#options.hitlQueue,
      batchId,
    });
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

  async #archiveExecutionCompletion(batchId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.#updateBatch(batchId, (current) => ({
      ...current,
      archivedAt: current.archivedAt ?? now,
    }));
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
    await commitSessionToolResult({
      store: this.#options.store,
      storeManager: this.#options.storeManager,
      sessionId: this.#options.store.getState().sessionId,
      workspaceRoot: this.#options.workspaceRoot,
      batchId,
      call,
      outcome,
      recoveryFailure,
      markBlockerApplied,
    });
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

}

/** Repairs the durable blocked-call -> Project HITL link before lifecycle recovery. */
export async function repairSessionToolBatchHitlIds(input: {
  readonly store: StoreApi<SessionStoreState>;
  readonly storeManager: SessionStoreManager;
  readonly workspaceRoot: string;
  readonly hitlQueue: Pick<SessionToolBatchQueue, "create">;
  readonly batchId: string;
}): Promise<void> {
  const sessionId = input.store.getState().sessionId;
  const batch = input.store.getState().toolBatches.find((candidate) =>
    candidate.archivedAt === undefined && candidate.batchId === input.batchId
  );
  if (batch === undefined) throw new Error(`Session has no active Tool Batch ${input.batchId}`);
  for (const call of batch.calls) {
    const blocker = call.state === "blocked" ? call.blocker : undefined;
    if (blocker === undefined || blocker.hitlId !== undefined) continue;
    const created = await input.hitlQueue.create({
      requestKey: blocker.requestKey,
      owner: { type: "session", id: sessionId },
      source: blocker.source,
      displayPayload: blocker.displayPayload,
      ...(blocker.source.type === "tool_permission"
        ? { persistentApprovalEligible: blocker.persistentApprovalEligible }
        : {}),
    });
    const hitlId = created.record.hitlId;
    const updatedAt = new Date().toISOString();
    await input.storeManager.updateToolBatches(
      sessionId,
      input.workspaceRoot,
      (batches) => batches.map((candidate) => candidate.batchId !== input.batchId
          ? candidate
          : {
            ...candidate,
            updatedAt,
            calls: candidate.calls.map((candidateCall) =>
              candidateCall.toolCallId === call.toolCallId
                && candidateCall.blocker?.requestKey === blocker.requestKey
                ? {
                    ...candidateCall,
                    blocker: { ...candidateCall.blocker, hitlId },
                  }
                : candidateCall
            ),
          }),
    );
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
  const accepted = findExactHitlCall(store.getState(), input.hitlId, input.requestKey);
  if (accepted?.call.blocker?.response !== undefined) {
    const response = input.registry.validateBlockedResponse(
      requestFromBlocker(accepted.call.blocker),
      input.response,
    );
    if (JSON.stringify(accepted.call.blocker.response) !== JSON.stringify(response)) {
      throw new Error("HITL response conflicts with the accepted response");
    }
    return { batchId: accepted.batch.batchId, toolCallId: accepted.call.toolCallId };
  }
  const { batch, call } = requireExactBlockedCall(store.getState(), input.hitlId, input.requestKey);
  const response = input.registry.validateBlockedResponse(requestFromBlocker(call.blocker!), input.response);
  const checkpointAt = Date.now();
  const now = new Date(checkpointAt).toISOString();
  await input.storeManager.updateToolBatches(input.sessionId, input.workspaceRoot, (batches) => batches.map((candidate) => candidate.batchId !== batch.batchId ? candidate : {
    ...candidate,
    updatedAt: now,
    calls: candidate.calls.map((candidateCall) => candidateCall.toolCallId !== call.toolCallId ? candidateCall : {
      ...candidateCall,
      state: "queued",
      checkpointAt,
      blocker: { ...call.blocker!, hitlId: input.hitlId, responseAppliedAt: now, response },
    }),
  }));
  return { batchId: batch.batchId, toolCallId: call.toolCallId };
}

export async function applySessionToolBatchChildOutcome(input: {
  readonly storeManager: SessionStoreManager;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly batchId: string;
  readonly toolCallId: string;
  readonly childSessionId: string;
  readonly childExecutionId: string;
  readonly outcome: Extract<ChildExecutionOutcome, { outcome: "terminal" }>;
}): Promise<void> {
  if (input.outcome.executionId !== input.childExecutionId) {
    throw new Error("Child terminal outcome executionId conflicts with the durable dependency");
  }
  const store = await input.storeManager.getOrLoad(input.sessionId, input.workspaceRoot);
  const batch = store.getState().toolBatches.find((candidate) => candidate.batchId === input.batchId);
  const call = batch === undefined ? undefined : batch.calls.find((candidate) => candidate.toolCallId === input.toolCallId);
  const dependency = call?.childDependency;
  if (
    batch?.archivedAt !== undefined
    || call?.state !== "child_dependency"
    || dependency?.kind !== "child_dependency"
    || dependency.childSessionId !== input.childSessionId
    || dependency.childExecutionId !== input.childExecutionId
  ) throw new Error("Child terminal outcome has no exact active dependency");
  const durableOutcome = {
    executionStatus: input.outcome.executionStatus,
    ...(input.outcome.output === undefined ? {} : { output: input.outcome.output }),
    ...(input.outcome.terminalError === undefined
      ? {}
      : {
          terminalError: input.outcome.terminalError instanceof Error
            ? input.outcome.terminalError.message
            : String(input.outcome.terminalError),
        }),
    resolvedAt: Date.now(),
  };
  if (dependency.outcome !== undefined) {
    const previous = JSON.stringify({ ...dependency.outcome, resolvedAt: 0 });
    const next = JSON.stringify({ ...durableOutcome, resolvedAt: 0 });
    if (previous !== next) throw new Error("Child terminal outcome conflicts with the applied dependency outcome");
    return;
  }
  await input.storeManager.updateToolBatches(input.sessionId, input.workspaceRoot, (batches) => batches.map((candidate) => (
    candidate.batchId !== input.batchId ? candidate : {
      ...candidate,
      calls: candidate.calls.map((candidateCall) => candidateCall.toolCallId !== input.toolCallId
        ? candidateCall
        : {
            ...candidateCall,
            state: "queued",
            checkpointAt: durableOutcome.resolvedAt,
            childDependency: {
              ...dependency,
              outcome: durableOutcome,
            },
          }),
    }
  )));
}

export function listSessionToolBatchHitlIds(state: Pick<SessionStoreState, "toolBatches">): string[] {
  const active = state.toolBatches.find((batch) => batch.archivedAt === undefined);
  if (active === undefined) return [];
  return [...new Set(active.calls.flatMap((call) => call.blocker?.hitlId === undefined ? [] : [call.blocker.hitlId]))].sort();
}

export async function validateSessionToolBatchResponse(input: {
  readonly registry: ToolRegistry;
  readonly storeManager: SessionStoreManager;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly hitlId: string;
  readonly requestKey: string;
  readonly response: HitlResponse;
}): Promise<{ executionId: string; batchId: string; toolCallId: string }> {
  const store = await input.storeManager.getOrLoad(input.sessionId, input.workspaceRoot);
  const exact = findExactHitlCall(store.getState(), input.hitlId, input.requestKey);
  if (exact === undefined || exact.call.blocker === undefined) {
    throw new Error(`HITL ${input.hitlId} and request key do not match a Session tool batch`);
  }
  const response = input.registry.validateBlockedResponse(
    requestFromBlocker(exact.call.blocker),
    input.response,
  );
  if (exact.call.blocker.response !== undefined) {
    if (JSON.stringify(exact.call.blocker.response) !== JSON.stringify(response)) {
      throw new Error("HITL response conflicts with the accepted response");
    }
  } else if (exact.batch.archivedAt !== undefined || exact.call.state !== "blocked") {
    throw new Error(`HITL ${input.hitlId} call ${exact.call.toolCallId} is not awaiting a response`);
  }
  return {
    executionId: exact.batch.executionId,
    batchId: exact.batch.batchId,
    toolCallId: exact.call.toolCallId,
  };
}

export function hasRunnableSessionToolBatch(state: Pick<SessionStoreState, "toolBatches">): boolean {
  const active = state.toolBatches.find((batch) => batch.archivedAt === undefined);
  if (active === undefined) return false;
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
  await repairSessionToolBatchHitlIds({
    store,
    storeManager: input.storeManager,
    workspaceRoot: input.workspaceRoot,
    hitlQueue: input.hitlQueue,
    batchId: batch.batchId,
  });
  batch = store.getState().toolBatches.find((candidate) => candidate.archivedAt === undefined);
  if (batch === undefined) return { hitlIds: [], manualInspectionRequired: false };
  const hitlIds = listSessionToolBatchHitlIds(store.getState());
  await input.prepareHitlCancellation(hitlIds);
  batch = store.getState().toolBatches.find((candidate) => candidate.archivedAt === undefined);
  if (batch === undefined) return { hitlIds, manualInspectionRequired: false };
  let manualInspectionRequired = false;
  let manualReason: SessionToolManualInspectionReason | undefined;
  for (const call of batch.calls) {
    if (TERMINAL_CALL_STATES.has(call.state)) continue;
    if (call.state === "running" && !call.traits.readOnly) {
      manualInspectionRequired = true;
      manualReason = { kind: "effectful_cancelled_unknown", toolCallId: call.toolCallId, toolName: call.toolName };
      const raw = createToolErrorResult({
        kind: "execution",
        code: "TOOL_RESULT_UNKNOWN",
        message: "Tool execution result is unknown because execution was interrupted",
      });
      const outcome = await input.settleSystem(toToolCall(call), batch.step, {
        ...raw,
        details: { ...raw.details, unknownResult: true },
      });
      await commitSessionToolResult({
        store,
        storeManager: input.storeManager,
        sessionId: input.sessionId,
        workspaceRoot: input.workspaceRoot,
        batchId: batch.batchId,
        call,
        outcome,
        recoveryFailure: { kind: "effectful_cancelled_unknown" },
      });
      continue;
    }
    const outcome = await input.settleSystem(toToolCall(call), batch.step, createToolErrorResult({ kind: "cancelled", message: input.reason }));
    await commitSessionToolResult({
      store,
      storeManager: input.storeManager,
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      batchId: batch.batchId,
      call,
      outcome,
      markBlockerApplied: true,
    });
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
  const exact = findExactHitlCall(state, hitlId, requestKey);
  if (exact === undefined) throw new Error(`HITL ${hitlId} and request key do not match an active Session tool batch`);
  const { batch, call } = exact;
  if (batch.archivedAt !== undefined || call.state !== "blocked" || call.blocker?.response !== undefined) {
    throw new Error(`HITL ${hitlId} call ${call.toolCallId} is not awaiting or holding a response`);
  }
  return { batch, call };
}

function findExactHitlCall(
  state: Pick<SessionStoreState, "toolBatches">,
  hitlId: string,
  requestKey: string,
): { batch: SessionToolBatch; call: SessionToolBatchCall } | undefined {
  const exactBatch = state.toolBatches.find((candidate) => candidate.calls.some((call) => (
    call.blocker?.hitlId === hitlId && call.blocker.requestKey === requestKey
  )));
  if (exactBatch !== undefined) {
    const exactCall = exactBatch.calls.find((candidate) =>
      candidate.blocker?.hitlId === hitlId && candidate.blocker.requestKey === requestKey
    );
    if (exactCall !== undefined) return { batch: exactBatch, call: exactCall };
  }
  const unlinkedBatch = state.toolBatches.find((candidate) =>
    candidate.archivedAt === undefined
    && candidate.calls.some((call) =>
      call.blocker?.hitlId === undefined && call.blocker?.requestKey === requestKey
    )
  );
  if (unlinkedBatch === undefined) return undefined;
  const unlinkedCall = unlinkedBatch.calls.find((candidate) =>
    candidate.blocker?.hitlId === undefined && candidate.blocker?.requestKey === requestKey
  );
  return unlinkedCall === undefined ? undefined : { batch: unlinkedBatch, call: unlinkedCall };
}

function isApprovedPermissionResponse(response: HitlResponse | undefined): boolean {
  return response?.type === "permission_decision" && response.decision !== "deny";
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

async function commitSessionToolResult(input: {
  readonly store: StoreApi<SessionStoreState>;
  readonly storeManager: SessionStoreManager;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly batchId: string;
  readonly call: Pick<SessionToolBatchCall, "toolCallId" | "toolName">;
  readonly outcome: Extract<RegistryExecutionOutcome, { kind: "settled" }>;
  readonly recoveryFailure?: SessionToolBatchCall["recoveryFailure"];
  readonly markBlockerApplied?: boolean;
}): Promise<void> {
  const settledAt = Date.now();
  const updatedAt = new Date(settledAt).toISOString();
  await input.storeManager.updateToolBatches(
    input.sessionId,
    input.workspaceRoot,
    (batches) => batches.map((batch) => batch.batchId !== input.batchId ? batch : {
      ...batch,
      updatedAt,
      calls: batch.calls.map((candidate) => {
        if (candidate.toolCallId !== input.call.toolCallId) return candidate;
        const { childDependency: _childDependency, ...terminalCall } = candidate;
        return {
          ...terminalCall,
          state: input.outcome.result.isError ? "failed" : "completed",
          checkpointAt: settledAt,
          result: input.outcome.result,
          settledAt,
          ...(input.outcome.sidecar?.executionCompleted === true && !input.outcome.result.isError
            ? { executionCompleted: true as const }
            : {}),
          ...(input.recoveryFailure === undefined ? {} : { recoveryFailure: input.recoveryFailure }),
          ...(input.markBlockerApplied === true && candidate.blocker !== undefined
            ? {
                blocker: {
                  ...candidate.blocker,
                  responseAppliedAt: candidate.blocker.responseAppliedAt ?? updatedAt,
                  response: candidate.blocker.response ?? {
                    type: "cancel" as const,
                    reason: "Tool batch stopped",
                  },
                },
              }
            : {}),
        };
      }),
    }),
  );
  input.store.getState().append({
    type: "tool-result",
    toolCallId: input.call.toolCallId,
    toolName: input.call.toolName,
    settledAt,
    result: input.outcome.result,
  });
  await input.storeManager.flushSession(input.sessionId, input.workspaceRoot);
}
