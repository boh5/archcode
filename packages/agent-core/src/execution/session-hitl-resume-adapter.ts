import type { HitlRecord, HitlResponse, ToolChildSessionLinkStatus } from "@archcode/protocol";
import type { StoreApi } from "zustand";

import type { Agent } from "../agents/types";
import type { ChildExecutionHandle, ChildExecutionRequest, ResumeChildRequest } from "../delegation/types";
import type { ProjectContextResolver } from "../projects/context-resolver";
import type { SkillService } from "../skills";
import type { SessionStoreManager } from "../store/session-store-manager";
import { assertValidSessionCwd } from "../store/session-cwd";
import type { SessionStoreState } from "../store/types";
import type { ToolRegistry } from "../tools/registry";
import { createToolExecutionContext } from "../tools/types";
import type { ToolConfirmationResult, ToolExecutionResult, ToolCallLike } from "../tools/types";
import { createToolErrorResult } from "../tools/errors";
import { redactValue } from "../tools/security/redaction";
import type { SessionHitlResumeAdapter as ResumeAdapterContract } from "../hitl/resume-coordinator";
import { askUserResponseToToolResult } from "./session-hitl-pause";
import type { ReserveSessionHitlResumeOptions, SessionHitlResumeLease } from "./session-execution-manager";
import type { SessionExecutionScopeValidator } from "./session-execution-scope-validator";
import { resolveSessionExecutionIdentity } from "./session-execution-identity";
import {
  isResponseForSessionCheckpoint,
  readSessionHitlCheckpoint,
  readSessionHitlCheckpointByBlockingKey,
  sessionHitlJournalPhase,
  transitionSessionHitlJournalPhase,
  type SessionHitlCheckpointRecord,
  type SessionHitlCompletedToolResult,
} from "./session-hitl-checkpoint";
import {
  finalizeResolvedSessionHitlJournal,
  moveContinuingJournalToManualUnknown,
  repairSessionHitlJournalForReplay,
} from "./session-hitl-journal";

export interface SessionHitlResumeAdapterOptions {
  readonly workspaceRoot: string;
  readonly storeManager: SessionStoreManager;
  readonly toolRegistry: ToolRegistry;
  readonly projectContextResolver: ProjectContextResolver;
  readonly executionScopeValidator: Pick<SessionExecutionScopeValidator, "validate">;
  readonly skillService: SkillService;
  readonly getAgent: (workspaceRoot: string, sessionId: string) => Promise<Agent>;
  readonly startChildExecution?: (workspaceRoot: string, request: ChildExecutionRequest) => Promise<ChildExecutionHandle>;
  readonly cancelChildSession?: (workspaceRoot: string, parentSessionId: string, childSessionId: string) => boolean;
  readonly resumeChildSession?: (workspaceRoot: string, request: ResumeChildRequest) => Promise<ChildExecutionHandle>;
  readonly reserveSessionHitlResume: (
    workspaceRoot: string,
    sessionId: string,
    rootSessionId: string,
    options?: ReserveSessionHitlResumeOptions,
  ) => SessionHitlResumeLease;
  readonly updateChildSessionLinkForHitl?: (
    workspaceRoot: string,
    childSessionId: string,
    status: ToolChildSessionLinkStatus,
  ) => Promise<void>;
  readonly readCheckpoint?: typeof readSessionHitlCheckpoint;
  readonly attachSessionEvents?: (workspaceRoot: string, sessionId: string, store: StoreApi<SessionStoreState>) => void;
  readonly detachSessionEvents?: (workspaceRoot: string, sessionId: string) => void;
}

export class SessionHitlResumeAdapter implements ResumeAdapterContract {
  constructor(private readonly options: SessionHitlResumeAdapterOptions) {}

  async prepare(record: HitlRecord, response: HitlResponse) {
    if (record.owner.ownerType !== "session") throw new Error(`Session adapter cannot prepare ${record.owner.ownerType} HITL`);
    const sessionId = record.owner.ownerId;
    const rootSessionId = record.sessionRootId;
    if (rootSessionId === undefined) throw new Error(`Session HITL ${record.hitlId} is missing canonical sessionRootId`);
    // The reservation is deliberately the first operation. Stop sees and owns
    // this generation even while Session identity is still loading from disk.
    const resumeLease = this.options.reserveSessionHitlResume(
      this.options.workspaceRoot,
      sessionId,
      rootSessionId,
      { mode: response.type === "cancel" ? "cancel_only" : "replay" },
    );
    let store: StoreApi<SessionStoreState>;
    try {
      store = await this.options.storeManager.getOrLoad(sessionId, this.options.workspaceRoot);
      const sessionState = store.getState();
      if (sessionState.parentSessionId !== undefined) {
        resumeLease.abortSignal.throwIfAborted();
        await this.options.storeManager.getOrLoad(sessionState.rootSessionId, this.options.workspaceRoot);
      }
      resumeLease.activate();
    } catch (error) {
      resumeLease.release();
      throw error;
    }
    let afterSessionRelease: (() => void) | undefined;
    let started = false;
    let released = false;
    return {
      run: async (claimedRecord: HitlRecord, claimedResponse: HitlResponse): Promise<void> => {
        if (started) throw new Error(`Session HITL ${claimedRecord.hitlId} prepared resume was already started`);
        started = true;
        try {
          resumeLease.abortSignal.throwIfAborted();
          await this.#updateChildLink(sessionId, "running");
          const pausedExecutionId = store.getState().executions.at(-1)?.id;
          await this.#resumePrepared(claimedRecord, claimedResponse, store, resumeLease, (callback) => {
            afterSessionRelease = callback;
          });
          await this.#updateChildLink(sessionId, resumedChildLinkStatus(store, claimedResponse, pausedExecutionId));
        } catch (error) {
          await this.#updateChildLink(
            sessionId,
            resumeLease.abortSignal.aborted ? "cancelled" : "failed",
          );
          throw error;
        }
      },
      release: () => {
        if (released) return;
        released = true;
        resumeLease.release();
        void afterSessionRelease?.();
      },
    };
  }

  async #resumePrepared(
    record: HitlRecord,
    response: HitlResponse,
    store: StoreApi<SessionStoreState>,
    resumeLease: SessionHitlResumeLease,
    setAfterSessionRelease: (callback: (() => void) | undefined) => void,
  ): Promise<void> {
    if (record.owner.ownerType !== "session") throw new Error(`Session adapter cannot resume ${record.owner.ownerType} HITL`);
    const sessionId = record.owner.ownerId;
    let eventsAttached = false;
    let checkpoint: SessionHitlCheckpointRecord | undefined;
    try {
      checkpoint = await (this.options.readCheckpoint ?? readSessionHitlCheckpoint)(
        this.options.workspaceRoot,
        sessionId,
        record.hitlId,
      );
      if (checkpoint === undefined && this.options.readCheckpoint === undefined) {
        checkpoint = await readSessionHitlCheckpointByBlockingKey(
          this.options.workspaceRoot,
          sessionId,
          record.blockingKey,
        );
      }
      if (checkpoint === undefined) throw new Error(`Missing Session HITL checkpoint for ${record.hitlId}`);
      const projectContext = await this.options.projectContextResolver.resolve(this.options.workspaceRoot);
      checkpoint = await repairSessionHitlJournalForReplay({
        workspaceRoot: this.options.workspaceRoot,
        sessionId,
        sessions: this.options.storeManager,
        hitl: projectContext.hitl,
        checkpoint,
      });
      if (checkpoint.hitlId !== record.hitlId) {
        throw new Error(`Session HITL journal ${checkpoint.hitlId} does not match claimed owner record ${record.hitlId}`);
      }
      if (!isResponseForSessionCheckpoint(checkpoint, response)) throw new Error(`Invalid response type ${response.type} for Session HITL ${record.hitlId}`);

      let phase = sessionHitlJournalPhase(checkpoint);
      // Explicit cancel is a fail-closed acknowledgement, not a replay. It must
      // remain available when the old execution scope is no longer runnable
      // (for example a removed worktree). The durable
      // owner/checkpoint/response match above is sufficient authority to clear
      // only this Session blocker without executing tools or the model.
      if (response.type === "cancel") {
        await cancelCheckpointWithoutExecution(store, checkpoint, response);
        await this.options.storeManager.flushSession(sessionId, this.options.workspaceRoot);
        if (phase !== "resolving") {
          checkpoint = await transitionSessionHitlJournalPhase(
            this.options.workspaceRoot,
            sessionId,
            checkpoint.hitlId,
            "resolving",
          );
          phase = "resolving";
        }
        await resolveSessionBlockerDurably(this.options.storeManager, this.options.workspaceRoot, store, record, response);
        return;
      }
      if (phase === "continuing" || phase === "manual_unknown") {
        await moveContinuingJournalToManualUnknown({
          workspaceRoot: this.options.workspaceRoot,
          sessionId,
          checkpoint,
        });
      }

      await this.options.executionScopeValidator.validate({
        projectRoot: this.options.workspaceRoot,
        subject: await resolveSessionExecutionIdentity({
          workspaceRoot: this.options.workspaceRoot,
          sessionId,
          sessions: this.options.storeManager,
        }),
        entry: { kind: "hitl_replay" },
      });
      await assertValidSessionCwd(this.options.workspaceRoot, store.getState().cwd);
      this.options.attachSessionEvents?.(this.options.workspaceRoot, sessionId, store);
      eventsAttached = this.options.attachSessionEvents !== undefined;

      phase = sessionHitlJournalPhase(checkpoint);
      if (phase === "paused") {
        checkpoint = await transitionSessionHitlJournalPhase(
          this.options.workspaceRoot,
          sessionId,
          checkpoint.hitlId,
          "replaying",
        );
        phase = "replaying";
      }

      if (phase === "replaying") {
        await this.replayCheckpoint(checkpoint, response, store, projectContext, resumeLease);
        await this.options.storeManager.flushSession(sessionId, this.options.workspaceRoot);
        checkpoint = await transitionSessionHitlJournalPhase(
          this.options.workspaceRoot,
          sessionId,
          checkpoint.hitlId,
          "continuing",
        );
        await this.continueAgent(checkpoint, sessionId, resumeLease);
        resumeLease.abortSignal.throwIfAborted();
        await this.options.storeManager.flushSession(sessionId, this.options.workspaceRoot);
        checkpoint = await transitionSessionHitlJournalPhase(
          this.options.workspaceRoot,
          sessionId,
          checkpoint.hitlId,
          "continued",
        );
        phase = "continued";
      }

      if (phase === "continued") {
        checkpoint = await transitionSessionHitlJournalPhase(
          this.options.workspaceRoot,
          sessionId,
          checkpoint.hitlId,
          "resolving",
        );
        phase = "resolving";
      }
      if (phase !== "resolving") throw new Error(`Unsupported Session HITL journal phase ${phase}`);
      await resolveSessionBlockerDurably(this.options.storeManager, this.options.workspaceRoot, store, record, response);
    } catch (error) {
      if (checkpoint !== undefined && sessionHitlJournalPhase(checkpoint) === "continuing") {
        await moveContinuingJournalToManualUnknown({
          workspaceRoot: this.options.workspaceRoot,
          sessionId,
          checkpoint,
        });
      }
      throw error;
    } finally {
      if (eventsAttached) this.options.detachSessionEvents?.(this.options.workspaceRoot, sessionId);
      setAfterSessionRelease(undefined);
    }
  }

  async finalize(record: HitlRecord): Promise<void> {
    await finalizeResolvedSessionHitlJournal(this.options.workspaceRoot, record);
  }

  async #updateChildLink(sessionId: string, status: ToolChildSessionLinkStatus): Promise<void> {
    await this.options.updateChildSessionLinkForHitl?.(this.options.workspaceRoot, sessionId, status);
  }

  private async replayCheckpoint(
    checkpoint: SessionHitlCheckpointRecord,
    response: HitlResponse,
    store: StoreApi<SessionStoreState>,
    projectContext: Awaited<ReturnType<ProjectContextResolver["resolve"]>>,
    resumeLease: SessionHitlResumeLease,
  ): Promise<void> {
    const completed = [...checkpoint.completedToolResults];
    restoreAssistantPointer(store, checkpoint);
    const pending = pendingFromCheckpoint(checkpoint);
    if (pending instanceof Error) {
      appendToolResult(store, blockedToolCall(checkpoint), createToolErrorResult({
        kind: "execution",
        message: pending.message,
        code: "SESSION_HITL_CHECKPOINT_INVALID",
      }));
      for (const call of checkpoint.pendingToolCalls.filter((call) => call.toolCallId !== checkpoint.toolCallId)) {
        appendToolResult(store, call, createToolErrorResult({
          kind: "execution",
          message: `Skipped ${call.toolName} because Session HITL checkpoint ${checkpoint.hitlId} is invalid`,
          code: "SESSION_HITL_CHECKPOINT_INVALID",
        }));
      }
      return;
    }

    for (let index = 0; index < pending.length; index += 1) {
      resumeLease.abortSignal.throwIfAborted();
      const call = pending[index]!;
      const result = index === 0
        ? await this.resumeBlockedTool(checkpoint, response, store, completed, resumeLease)
        : await this.executeTool(call, checkpoint, store, completed, pending.slice(index), projectContext, resumeLease);
      appendToolResult(store, call, result);
      completed.push({ toolCallId: call.toolCallId, toolName: call.toolName, output: result.output, isError: result.isError, ...(result.meta === undefined ? {} : { meta: result.meta }) });
      if (result.meta?.unknownResult === true) {
        for (const remaining of pending.slice(index + 1)) {
          const skipped = unknownPriorOutcomeSkippedResult(call);
          appendToolResult(store, remaining, skipped);
          completed.push({ toolCallId: remaining.toolCallId, toolName: remaining.toolName, output: skipped.output, isError: true, ...(skipped.meta === undefined ? {} : { meta: skipped.meta }) });
        }
        break;
      }
      if (result.meta?.sessionCwdChanged === true) {
        for (const remaining of pending.slice(index + 1)) {
          const skipped = cwdTransitionSkippedResult();
          appendToolResult(store, remaining, skipped);
          completed.push({ toolCallId: remaining.toolCallId, toolName: remaining.toolName, output: skipped.output, isError: skipped.isError, ...(skipped.meta === undefined ? {} : { meta: skipped.meta }) });
        }
        break;
      }
    }
  }

  private async continueAgent(
    checkpoint: SessionHitlCheckpointRecord,
    sessionId: string,
    resumeLease: SessionHitlResumeLease,
  ): Promise<void> {
    const agent = await this.options.getAgent(this.options.workspaceRoot, sessionId);
    await agent.run("", { abort: resumeLease.abortSignal });
  }

  private async resumeBlockedTool(
    checkpoint: SessionHitlCheckpointRecord,
    response: HitlResponse,
    store: StoreApi<SessionStoreState>,
    completed: readonly SessionHitlCompletedToolResult[],
    resumeLease: SessionHitlResumeLease,
  ): Promise<ToolExecutionResult> {
    if (response.type === "cancel") {
      return createToolErrorResult({ kind: "cancelled", message: response.reason });
    }
    if (checkpoint.kind === "ask_user") {
      return askUserResponseToToolResult({ questions: extractAskUserQuestions(checkpoint.rawToolInput) }, response);
    }
    const projectContext = await this.options.projectContextResolver.resolve(this.options.workspaceRoot);
    return await this.executeTool(
      { toolCallId: checkpoint.toolCallId, toolName: checkpoint.toolName, input: checkpoint.rawToolInput },
      checkpoint,
      store,
      completed,
      checkpoint.pendingToolCalls,
      projectContext,
      resumeLease,
      response,
    );
  }

  private async executeTool(
    call: ToolCallLike,
    checkpoint: SessionHitlCheckpointRecord,
    store: StoreApi<SessionStoreState>,
    completed: readonly SessionHitlCompletedToolResult[],
    pending: readonly ToolCallLike[],
    projectContext: Awaited<ReturnType<ProjectContextResolver["resolve"]>>,
    resumeLease: SessionHitlResumeLease,
    response?: HitlResponse,
  ): Promise<ToolExecutionResult> {
    const durableResult = durableToolResult(store, call);
    if (durableResult !== undefined) return durableResult;

    const abort = resumeLease.abortSignal;
    const { storeManager, workspaceRoot } = this.options;
    const ctx = createToolExecutionContext({
      store,
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      input: call.input,
      redactedInput: redactValue(call.input),
      step: checkpoint.step,
      abort,
      startedAt: Date.now(),
      allowedTools: new Set(checkpoint.allowedTools),
      agentSkills: checkpoint.agentSkills,
      skillService: this.options.skillService,
      projectContext,
      cwd: store.getState().cwd,
      storeManager: this.options.storeManager,
      agentName: checkpoint.agentName,
      ...(checkpoint.currentDepth === undefined ? {} : { currentDepth: checkpoint.currentDepth }),
      ...(response === undefined ? {} : { confirmPermission: async () => permissionDecisionFromResponse(response) }),
      ...(this.options.startChildExecution === undefined ? {} : { startChildExecution: (request) => this.options.startChildExecution!(this.options.workspaceRoot, request) }),
      ...(this.options.cancelChildSession === undefined ? {} : { cancelChildSession: this.options.cancelChildSession }),
      ...(this.options.resumeChildSession === undefined ? {} : { resumeChildSession: this.options.resumeChildSession }),
      acquireSessionCwdTransition: resumeLease.acquireSessionCwdTransition,
      hitlCheckpoint: {
        toolCalls: checkpoint.toolCalls,
        completedToolResults: [...completed],
        pendingToolCalls: [...pending],
        blockedToolIndex: checkpoint.blockedToolIndex,
        ...(checkpoint.assistantMessageId === undefined ? {} : { assistantMessageId: checkpoint.assistantMessageId }),
      },
      onInputResolved(redactedInput) {
        store.getState().append({ type: "tool-input-resolved", toolCallId: call.toolCallId, toolName: call.toolName, input: redactedInput });
      },
      async onToolAttempt(attempt) {
        store.getState().append({
          type: "tool-attempt",
          toolCallId: attempt.toolCallId,
          toolName: attempt.toolName,
          attemptId: attempt.attemptId,
          timestamp: attempt.timestamp,
          destructive: attempt.destructive,
        });
        await storeManager.flushSession(store.getState().sessionId, workspaceRoot);
      },
    });
    return await this.options.toolRegistry.execute(call, ctx);
  }
}

function resumedChildLinkStatus(
  store: StoreApi<SessionStoreState>,
  response: HitlResponse,
  pausedExecutionId: string | undefined,
): ToolChildSessionLinkStatus {
  if (response.type === "cancel") return "cancelled";
  const execution = store.getState().executions.at(-1);
  switch (execution?.status) {
    case "waiting_for_human": return execution.id === pausedExecutionId ? "completed" : "waiting_for_human";
    case "failed":
    case "max_steps": return "failed";
    case "aborted":
    case "cancelled": return "cancelled";
    case "timed_out": return "timed_out";
    case "interrupted": return "interrupted";
    case "completed": return "completed";
    case "running":
    case undefined: return "completed";
  }
}

function remainingSessionBlockers(store: StoreApi<SessionStoreState>, resolvedHitlId: string): string[] | undefined {
  const remaining = store.getState().blockedByHitlIds?.filter((hitlId) => hitlId !== resolvedHitlId) ?? [];
  return remaining.length === 0 ? undefined : remaining;
}

function cwdTransitionSkippedResult(): ToolExecutionResult {
  return createToolErrorResult({
    kind: "execution",
    code: "SESSION_CWD_CHANGED",
    message: "Skipped because a previous tool changed Session cwd; retry from the rebuilt Agent context.",
  });
}

function unknownPriorOutcomeSkippedResult(prior: ToolCallLike): ToolExecutionResult {
  return createToolErrorResult({
    kind: "execution",
    code: "SESSION_HITL_PRIOR_TOOL_OUTCOME_UNKNOWN",
    message: `Skipped because ${prior.toolName} (${prior.toolCallId}) has an unknown outcome; inspect external state before retrying the batch.`,
  });
}

function durableToolResult(store: StoreApi<SessionStoreState>, call: ToolCallLike): ToolExecutionResult | undefined {
  for (const message of [...store.getState().messages].reverse()) {
    for (const part of [...message.parts].reverse()) {
      if (part.type !== "tool" || part.toolCallId !== call.toolCallId) continue;
      if (part.state === "completed") {
        return {
          output: part.output,
          isError: false,
          ...(part.meta === undefined ? {} : { meta: part.meta }),
        };
      }
      if (part.state === "error" && part.meta?.unknownResult === true) {
        return createToolErrorResult({
          kind: "execution",
          code: "TOOL_EXECUTION_OUTCOME_UNKNOWN",
          message: `Effectful tool ${call.toolName} (${call.toolCallId}) may already have run before restart. Inspect external state and retry only if still required.`,
          meta: { ...part.meta, unknownResult: true },
        });
      }
      if (part.state === "error") {
        return {
          output: part.errorMessage,
          isError: true,
          ...(part.meta === undefined ? {} : { meta: part.meta }),
        };
      }
      return undefined;
    }
  }
  return undefined;
}

async function cancelCheckpointWithoutExecution(
  store: StoreApi<SessionStoreState>,
  checkpoint: SessionHitlCheckpointRecord,
  response: Extract<HitlResponse, { type: "cancel" }>,
): Promise<void> {
  const cancelled = createToolErrorResult({ kind: "cancelled", message: response.reason });
  const pending = pendingFromCheckpoint(checkpoint);
  const calls = pending instanceof Error
    ? checkpoint.pendingToolCalls.length === 0 ? [blockedToolCall(checkpoint)] : checkpoint.pendingToolCalls
    : pending;
  for (const call of calls) appendToolResult(store, call, cancelled);
}

function pendingFromCheckpoint(checkpoint: SessionHitlCheckpointRecord): readonly ToolCallLike[] | Error {
  const startIndex = checkpoint.pendingToolCalls.findIndex((call) => call.toolCallId === checkpoint.toolCallId);
  if (startIndex === -1) {
    return new Error(`Session HITL checkpoint ${checkpoint.hitlId} is invalid: blocked tool ${checkpoint.toolCallId} is missing from pendingToolCalls`);
  }
  const absoluteIndex = checkpoint.toolCalls.findIndex((call) => call.toolCallId === checkpoint.toolCallId);
  if (absoluteIndex === -1) {
    return new Error(`Session HITL checkpoint ${checkpoint.hitlId} is invalid: blocked tool ${checkpoint.toolCallId} is missing from toolCalls`);
  }
  if (absoluteIndex !== checkpoint.blockedToolIndex) {
    return new Error(`Session HITL checkpoint ${checkpoint.hitlId} is invalid: blockedToolIndex ${checkpoint.blockedToolIndex} does not match ${checkpoint.toolCallId}`);
  }
  const blocked = checkpoint.pendingToolCalls[startIndex];
  if (blocked?.toolName !== checkpoint.toolName) {
    return new Error(`Session HITL checkpoint ${checkpoint.hitlId} is invalid: blocked tool name does not match ${checkpoint.toolName}`);
  }
  return checkpoint.pendingToolCalls.slice(startIndex);
}

function blockedToolCall(checkpoint: SessionHitlCheckpointRecord): ToolCallLike {
  return { toolCallId: checkpoint.toolCallId, toolName: checkpoint.toolName, input: checkpoint.rawToolInput };
}

function restoreAssistantPointer(store: StoreApi<SessionStoreState>, checkpoint: SessionHitlCheckpointRecord): void {
  if (checkpoint.assistantMessageId === undefined) return;
  store.setState({ currentAssistantMessageId: checkpoint.assistantMessageId });
}

async function resolveSessionBlockerDurably(
  storeManager: SessionStoreManager,
  workspaceRoot: string,
  store: StoreApi<SessionStoreState>,
  record: HitlRecord,
  response: HitlResponse,
): Promise<void> {
  store.getState().append({
    type: "hitl.resolved",
    hitlId: record.hitlId,
    status: response.type === "cancel" ? "cancelled" : "resolved",
    response,
  });
  await storeManager.flushSession(store.getState().sessionId, workspaceRoot);
}

function permissionDecisionFromResponse(response: HitlResponse): ToolConfirmationResult {
  if (response.type === "permission_decision") return response.decision;
  if (response.type === "cancel") return "deny";
  return "deny";
}

function appendToolResult(store: StoreApi<SessionStoreState>, call: ToolCallLike, result: ToolExecutionResult): void {
  store.getState().append({
    type: "tool-result",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    output: result.output,
    isError: result.isError,
    ...(result.meta === undefined ? {} : { meta: result.meta }),
  });
}

function extractAskUserQuestions(input: unknown): Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiple?: boolean; custom: boolean }> {
  if (!input || typeof input !== "object" || !("questions" in input) || !Array.isArray((input as { questions?: unknown }).questions)) return [];
  return (input as { questions: unknown[] }).questions.map((item) => {
    const question = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const options = Array.isArray(question.options)
      ? question.options.map((option) => {
        const value = option && typeof option === "object" ? option as Record<string, unknown> : {};
        return { label: String(value.label ?? ""), description: String(value.description ?? "") };
      })
      : [];
    return {
      question: String(question.question ?? ""),
      header: String(question.header ?? ""),
      options,
      ...(typeof question.multiple === "boolean" ? { multiple: question.multiple } : {}),
      custom: typeof question.custom === "boolean" ? question.custom : true,
    };
  });
}
