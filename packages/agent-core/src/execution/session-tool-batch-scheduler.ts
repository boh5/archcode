import type { HitlResponse } from "@archcode/protocol";
import type { StoreApi } from "zustand";
import type { ChildExecutionOutcome } from "../delegation/types";

import { silentLogger, type Logger } from "../logger";
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
  AnyToolDescriptor,
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
  readonly logger?: Logger;
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
  #liveDescriptors = new Map<string, AnyToolDescriptor>();

  constructor(options: SessionToolBatchSchedulerOptions) {
    this.#options = options;
  }

  activeBatch(): SessionToolBatch | undefined {
    return this.#options.store.getState().toolBatches.find((batch) => batch.archivedAt === undefined);
  }

  async createBatch(
    toolCalls: readonly ToolCallLike[],
    stepId: string,
    step: number,
    descriptors: readonly AnyToolDescriptor[] = [],
  ): Promise<SessionToolBatch> {
    if (this.activeBatch() !== undefined) throw new Error("Session already has an active tool batch");
    this.#liveDescriptors = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
    const descriptorSource = {
      get: (name: string) => this.#liveDescriptors.get(name) ?? this.#options.registry.get(name),
    };
    const partitions = partitionToolCalls([...toolCalls], descriptorSource);
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
      allowedTools: [...new Set(descriptors.length > 0
        ? descriptors.map((descriptor) => descriptor.name)
        : this.#options.allowedTools)],
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
        traits: descriptorSource.get(call.toolName)?.traits
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

    for (const call of batch.calls.filter((candidate) =>
      isMcpToolName(candidate.toolName)
      && candidate.state !== "completed"
      && candidate.state !== "failed"
      && !(candidate.state === "running" && !candidate.traits.readOnly)
    )) {
      const outcome = await this.#settleSystem(call, batch.step, mcpInterruptedResult());
      await this.#commitSettled(batch.batchId, call, outcome);
    }
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
          if (outcome.manualInspectionReason !== undefined) {
            return { status: "manual_inspection_required", reason: outcome.manualInspectionReason };
          }
        }
      } else if (queued[0] !== undefined) {
        const outcome = await this.#runCall(batch.batchId, queued[0].toolCallId);
        sessionCwdChanged ||= outcome.sessionCwdChanged;
        executionCompleted ||= outcome.executionCompleted;
        if (outcome.manualInspectionReason !== undefined) {
          return { status: "manual_inspection_required", reason: outcome.manualInspectionReason };
        }
      }

      const settledBatch = this.#findBatch(batch.batchId);
      if (settledBatch?.archivedAt !== undefined && settledBatch.manualInspectionReason !== undefined) {
        return { status: "manual_inspection_required", reason: settledBatch.manualInspectionReason };
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
        await this.#settleQueuedMcpCalls(batch.batchId, batch.step);
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
      await this.#settleQueuedMcpCalls(batch.batchId, batch.step);
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
      await this.#settleQueuedMcpCalls(batch.batchId, batch.step);
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

  async #runCall(batchId: string, toolCallId: string): Promise<{
    sessionCwdChanged: boolean;
    executionCompleted: boolean;
    manualInspectionReason?: SessionToolManualInspectionReason;
  }> {
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
    const context = await this.#createContext(toolCall, batch);
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
        ? await this.#execute(toolCall, context)
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
    const committed = await this.#commitSettled(
      batchId,
      this.#callForSettlement(batchId, call),
      outcome,
    );
    return {
      sessionCwdChanged: committed.status === "committed" && outcome.sidecar?.sessionCwdChanged === true,
      executionCompleted: committed.status === "committed" && outcome.sidecar?.executionCompleted === true,
      ...(committed.status === "committed" && committed.manualInspectionReason !== undefined
        ? { manualInspectionReason: committed.manualInspectionReason }
        : {}),
    };
  }

  #execute(toolCall: ToolCallLike, context: ToolExecutionContext): Promise<RegistryExecutionOutcome> {
    const descriptor = this.#liveDescriptors.get(toolCall.toolName);
    if (descriptor !== undefined) {
      return this.#options.registry.executeResolved(descriptor, toolCall, context);
    }
    if (isMcpToolName(toolCall.toolName)) {
      return this.#options.registry.settleSystem(toolCall, context, mcpInterruptedResult());
    }
    return this.#options.registry.execute(toolCall, context);
  }

  async #settleQueuedMcpCalls(batchId: string, step: number): Promise<void> {
    const batch = this.#requireActiveBatch();
    for (const call of batch.calls.filter((candidate) =>
      candidate.state === "queued" && isMcpToolName(candidate.toolName)
    )) {
      const outcome = await this.#settleSystem(call, step, mcpInterruptedResult());
      await this.#commitSettled(batchId, call, outcome);
    }
  }

  #callForSettlement(batchId: string, startedCall: SessionToolBatchCall): SessionToolBatchCall {
    const batch = this.#findBatch(batchId);
    const current = batch?.calls.find((call) => call.toolCallId === startedCall.toolCallId);
    const dependency = current?.childDependency;
    if (
      batch !== undefined
      && batch.archivedAt === undefined
      && startedCall.state === "running"
      && current?.state === "child_launch"
      && current.toolName === startedCall.toolName
      && current.attempt === startedCall.attempt
      && current.result === undefined
      && dependency?.kind === "child_launch"
      && dependency.parentExecutionId === batch.executionId
      && dependency.runOrdinal === batch.runOrdinal
      && dependency.toolCallId === startedCall.toolCallId
    ) {
      return current;
    }
    return startedCall;
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
    const batch = this.#requireActiveBatch();
    const outcome = await this.#options.registry.settleSystem(
      toolCall,
      await this.#createContext(toolCall, batch, step),
      raw,
    );
    if (outcome.kind !== "settled") throw new Error("System result unexpectedly blocked");
    return outcome;
  }

  async #createContext(
    toolCall: ToolCallLike,
    batch: SessionToolBatch,
    step: number = batch.step,
  ): Promise<ToolExecutionContext> {
    const context = await this.#options.createContext(toolCall, step);
    const currentlyAllowed = new Set(this.#options.allowedTools);
    for (const name of this.#liveDescriptors.keys()) currentlyAllowed.add(name);
    return {
      ...context,
      allowedTools: new Set(batch.allowedTools.filter((name) => currentlyAllowed.has(name))),
    };
  }

  async #commitSettled(
    batchId: string,
    call: SessionToolBatchCall,
    outcome: Extract<RegistryExecutionOutcome, { kind: "settled" }>,
    recoveryFailure?: SessionToolBatchCall["recoveryFailure"],
    markBlockerApplied = false,
  ): Promise<SessionToolResultCommit> {
    return await commitSessionToolResult({
      store: this.#options.store,
      storeManager: this.#options.storeManager,
      sessionId: this.#options.store.getState().sessionId,
      workspaceRoot: this.#options.workspaceRoot,
      batchId,
      call,
      outcome,
      recoveryFailure,
      markBlockerApplied,
      logger: this.#options.logger,
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

  #findBatch(batchId: string): SessionToolBatch | undefined {
    return this.#options.store.getState().toolBatches.find((batch) => batch.batchId === batchId);
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
  readonly logger?: Logger;
}): Promise<{ batchId: string; toolCallId: string }> {
  const store = await input.storeManager.getOrLoad(input.sessionId, input.workspaceRoot);
  const initial = findExactHitlCall(store.getState(), input.hitlId, input.requestKey);
  if (initial?.call.blocker === undefined) {
    throw new Error(`HITL ${input.hitlId} and request key do not match a Session tool batch`);
  }
  const response = input.registry.validateBlockedResponse(requestFromBlocker(initial.call.blocker), input.response);
  const checkpointAt = Date.now();
  const now = new Date(checkpointAt).toISOString();
  const applied = await input.storeManager.commitDurableSessionMutation<
    | { readonly status: "applied" | "replayed"; readonly batchId: string; readonly toolCallId: string }
    | { readonly status: "discarded"; readonly reason: "conflict" | "late"; readonly toolCallId?: string }
  >(input.sessionId, input.workspaceRoot, (state) => {
    const exact = findExactHitlCall(state, input.hitlId, input.requestKey);
    if (exact?.call.blocker?.response !== undefined) {
      if (JSON.stringify(exact.call.blocker.response) !== JSON.stringify(response)) {
        return { result: { status: "discarded", reason: "conflict", toolCallId: exact.call.toolCallId } };
      }
      return {
        result: { status: "replayed", batchId: exact.batch.batchId, toolCallId: exact.call.toolCallId },
      };
    }
    if (exact === undefined || exact.batch.archivedAt !== undefined || exact.call.state !== "blocked") {
      return {
        result: {
          status: "discarded",
          reason: "late",
          ...(exact === undefined ? {} : { toolCallId: exact.call.toolCallId }),
        },
      };
    }
    const toolBatches = state.toolBatches.map((candidate) => candidate.batchId !== exact.batch.batchId ? candidate : {
      ...candidate,
      updatedAt: now,
      calls: candidate.calls.map((candidateCall) => candidateCall.toolCallId !== exact.call.toolCallId ? candidateCall : {
        ...candidateCall,
        state: "queued" as const,
        checkpointAt,
        blocker: { ...exact.call.blocker!, hitlId: input.hitlId, responseAppliedAt: now, response },
      }),
    });
    return {
      result: { status: "applied", batchId: exact.batch.batchId, toolCallId: exact.call.toolCallId },
      patch: { toolBatches },
    };
  });
  if (applied.status === "discarded") {
    (input.logger ?? silentLogger).warn("tool.hitl.late_response_discarded", {
      context: {
        sessionId: input.sessionId,
        hitlId: input.hitlId,
        requestKey: input.requestKey,
        ...(applied.toolCallId === undefined ? {} : { toolCallId: applied.toolCallId }),
      },
    });
    if (applied.reason === "conflict") throw new Error("HITL response conflicts with the accepted response");
    throw new Error(`HITL ${input.hitlId} response lost the tool-batch settlement race`);
  }
  return { batchId: applied.batchId, toolCallId: applied.toolCallId };
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
  readonly logger?: Logger;
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
    const claim = await claimCallForCancellation({
      storeManager: input.storeManager,
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      batchId: batch.batchId,
      toolCallId: call.toolCallId,
    });
    if (claim.kind === "skipped") continue;
    if (claim.kind === "mcp_manual") {
      manualInspectionRequired = true;
      manualReason = claim.reason;
      continue;
    }
    if (claim.wasRunning && !claim.call.traits.readOnly) {
      manualInspectionRequired = true;
      manualReason = {
        kind: "effectful_cancelled_unknown",
        toolCallId: claim.call.toolCallId,
        toolName: claim.call.toolName,
      };
      const raw = createToolErrorResult({
        kind: "execution",
        code: "TOOL_RESULT_UNKNOWN",
        message: "Tool execution result is unknown because execution was interrupted",
      });
      const outcome = await input.settleSystem(toToolCall(claim.call), batch.step, {
        ...raw,
        details: { ...raw.details, unknownResult: true },
      });
      await commitSessionToolResult({
        store,
        storeManager: input.storeManager,
        sessionId: input.sessionId,
        workspaceRoot: input.workspaceRoot,
        batchId: batch.batchId,
        call: claim.call,
        outcome,
        recoveryFailure: { kind: "effectful_cancelled_unknown" },
        logger: input.logger,
      });
      continue;
    }
    const outcome = await input.settleSystem(
      toToolCall(claim.call),
      batch.step,
      createToolErrorResult({ kind: "cancelled", message: input.reason }),
    );
    await commitSessionToolResult({
      store,
      storeManager: input.storeManager,
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      batchId: batch.batchId,
      call: claim.call,
      outcome,
      markBlockerApplied: true,
      logger: input.logger,
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

type SessionToolCancellationClaim =
  | { readonly kind: "skipped" }
  | { readonly kind: "claimed"; readonly call: SessionToolBatchCall; readonly wasRunning: boolean }
  | { readonly kind: "mcp_manual"; readonly reason: SessionToolManualInspectionReason };

async function claimCallForCancellation(input: {
  readonly storeManager: SessionStoreManager;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly batchId: string;
  readonly toolCallId: string;
}): Promise<SessionToolCancellationClaim> {
  const checkpointAt = Date.now();
  const updatedAt = new Date().toISOString();
  return await input.storeManager.commitDurableSessionMutation<SessionToolCancellationClaim>(
    input.sessionId,
    input.workspaceRoot,
    (state) => {
      const batch = state.toolBatches.find((candidate) => candidate.batchId === input.batchId);
      const call = batch?.calls.find((candidate) => candidate.toolCallId === input.toolCallId);
      if (
        batch === undefined
        || batch.archivedAt !== undefined
        || call === undefined
        || TERMINAL_CALL_STATES.has(call.state)
        || call.state === "manual_inspection_required"
        || call.result !== undefined
      ) return { result: { kind: "skipped" as const } };
      if (call.state === "running" && !call.traits.readOnly && isMcpToolName(call.toolName)) {
        const reason: SessionToolManualInspectionReason = {
          kind: "effectful_cancelled_unknown",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
        };
        const toolBatches = state.toolBatches.map((candidate) => candidate.batchId !== input.batchId
          ? candidate
          : {
              ...candidate,
              updatedAt,
              archivedAt: updatedAt,
              manualInspectionReason: reason,
              calls: candidate.calls.map((candidateCall) => candidateCall.toolCallId !== input.toolCallId
                ? candidateCall
                : {
                    ...candidateCall,
                    state: "manual_inspection_required" as const,
                    recoveryFailure: { kind: "effectful_cancelled_unknown" as const },
                  }),
            });
        return { result: { kind: "mcp_manual" as const, reason }, patch: { toolBatches } };
      }
      const { childDependency: _childDependency, ...claimedCall } = call;
      const claimed: SessionToolBatchCall = {
        ...claimedCall,
        state: "running",
        checkpointAt,
        ...(call.blocker === undefined
          ? {}
          : {
              blocker: {
                ...call.blocker,
                responseAppliedAt: call.blocker.responseAppliedAt ?? updatedAt,
                response: call.blocker.response ?? {
                  type: "cancel" as const,
                  reason: "Tool batch stopped",
                },
              },
            }),
      };
      const toolBatches = state.toolBatches.map((candidate) => candidate.batchId !== input.batchId
        ? candidate
        : {
            ...candidate,
            updatedAt,
            calls: candidate.calls.map((candidateCall) => candidateCall.toolCallId !== input.toolCallId
              ? candidateCall
              : claimed),
          });
      return {
        result: { kind: "claimed" as const, call: claimed, wasRunning: call.state === "running" },
        patch: { toolBatches },
      };
    },
  );
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

function isMcpToolName(toolName: string): boolean {
  return toolName.startsWith("mcp__");
}

function mcpInterruptedResult(): RawToolResult {
  return createToolErrorResult({
    kind: "execution",
    code: "TOOL_MCP_INTERRUPTED",
    message: "MCP tool call was interrupted and was not replayed",
  });
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

type SessionToolResultCommit =
  | { readonly status: "committed"; readonly manualInspectionReason?: SessionToolManualInspectionReason }
  | { readonly status: "discarded" };

async function commitSessionToolResult(input: {
  readonly store: StoreApi<SessionStoreState>;
  readonly storeManager: SessionStoreManager;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly batchId: string;
  readonly call: Pick<SessionToolBatchCall, "toolCallId" | "toolName" | "state" | "checkpointAt" | "traits">;
  readonly outcome: Extract<RegistryExecutionOutcome, { kind: "settled" }>;
  readonly recoveryFailure?: SessionToolBatchCall["recoveryFailure"];
  readonly markBlockerApplied?: boolean;
  readonly logger?: Logger;
}): Promise<SessionToolResultCommit> {
  const settledAt = Date.now();
  const updatedAt = new Date(settledAt).toISOString();
  const unknownEffectfulMcp = isMcpToolName(input.call.toolName)
    && !input.call.traits.readOnly
    && input.outcome.result.details?.unknownResult === true;
  const manualInspectionReason: SessionToolManualInspectionReason | undefined = unknownEffectfulMcp
    ? {
        kind: "effectful_cancelled_unknown",
        toolCallId: input.call.toolCallId,
        toolName: input.call.toolName,
      }
    : undefined;
  const stateBeforeCommit = input.store.getState();
  let commit: SessionToolResultCommit;
  try {
    commit = await input.storeManager.commitDurableSessionMutation<SessionToolResultCommit>(
      input.sessionId,
      input.workspaceRoot,
      (state) => {
        const batch = state.toolBatches.find((candidate) => candidate.batchId === input.batchId);
        const candidate = batch?.calls.find((call) => call.toolCallId === input.call.toolCallId);
        const lateUnknownForManual = manualInspectionReason !== undefined
          && batch?.archivedAt !== undefined
          && candidate?.state === "manual_inspection_required"
          && candidate.result === undefined
          && candidate.checkpointAt === input.call.checkpointAt
          && candidate.recoveryFailure?.kind === "effectful_cancelled_unknown"
          && batch.manualInspectionReason?.kind === "effectful_cancelled_unknown"
          && batch.manualInspectionReason.toolCallId === input.call.toolCallId;
        const activeExpectedState = batch?.archivedAt === undefined
          && candidate?.state === input.call.state
          && candidate.checkpointAt === input.call.checkpointAt
          && candidate.result === undefined;
        if (
          batch === undefined
          || candidate === undefined
          || (!activeExpectedState && !lateUnknownForManual)
        ) return { result: { status: "discarded" } };

        const calls = batch.calls.map((current) => {
          if (current.toolCallId !== input.call.toolCallId) return current;
          const { childDependency: _childDependency, ...terminalCall } = current;
          return {
            ...terminalCall,
            state: lateUnknownForManual
              ? "manual_inspection_required" as const
              : manualInspectionReason === undefined
                ? input.outcome.result.isError ? "failed" as const : "completed" as const
                : "manual_inspection_required" as const,
            checkpointAt: settledAt,
            result: input.outcome.result,
            settledAt,
            ...(input.outcome.sidecar?.executionCompleted === true
              && !input.outcome.result.isError
              && manualInspectionReason === undefined
              ? { executionCompleted: true as const }
              : {}),
            ...(manualInspectionReason !== undefined
              ? { recoveryFailure: { kind: "effectful_cancelled_unknown" as const } }
              : input.recoveryFailure === undefined ? {} : { recoveryFailure: input.recoveryFailure }),
            ...(input.markBlockerApplied === true && current.blocker !== undefined
              ? {
                  blocker: {
                    ...current.blocker,
                    responseAppliedAt: current.blocker.responseAppliedAt ?? updatedAt,
                    response: current.blocker.response ?? {
                      type: "cancel" as const,
                      reason: "Tool batch stopped",
                    },
                  },
                }
              : {}),
          };
        });
        const toolBatches = state.toolBatches.map((current) => current.batchId !== input.batchId
          ? current
          : {
              ...current,
              updatedAt,
              calls,
              ...(manualInspectionReason === undefined
                ? {}
                : {
                    archivedAt: updatedAt,
                    manualInspectionReason,
                  }),
            });
        return {
          result: {
            status: "committed",
            ...(manualInspectionReason === undefined ? {} : { manualInspectionReason }),
          },
          patch: { toolBatches },
          events: [{
            type: "tool-result",
            toolCallId: input.call.toolCallId,
            toolName: input.call.toolName,
            settledAt,
            result: input.outcome.result,
          }],
        };
      },
    );
  } catch (error) {
    const current = input.store.getState();
    const lastEvent = current.events.at(-1);
    if (
      current.nextEventId === stateBeforeCommit.nextEventId + 1
      && lastEvent?.id === stateBeforeCommit.nextEventId
      && lastEvent.payload.type === "tool-result"
      && lastEvent.payload.toolCallId === input.call.toolCallId
    ) {
      input.store.setState(stateBeforeCommit, true);
    }
    throw error;
  }
  if (commit.status === "discarded") {
    (input.logger ?? silentLogger).warn("tool.result.late_discarded", {
      context: {
        sessionId: input.sessionId,
        toolBatchId: input.batchId,
        toolCallId: input.call.toolCallId,
        toolName: input.call.toolName,
      },
      meta: {
        expectedState: input.call.state,
        expectedCheckpointAt: input.call.checkpointAt,
      },
    });
  }
  return commit;
}
