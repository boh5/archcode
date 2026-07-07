import type { HitlRecord, HitlResponse } from "@archcode/protocol";
import type { StoreApi } from "zustand";

import type { Agent } from "../agents/types";
import type { ChildExecutionHandle, ChildExecutionRequest, ResumeChildRequest } from "../delegation/types";
import type { ProjectContextResolver } from "../projects/context-resolver";
import type { SkillService } from "../skills";
import type { SessionStoreManager } from "../store/session-store-manager";
import type { SessionStoreState } from "../store/types";
import type { ToolRegistry } from "../tools/registry";
import { createToolExecutionContext } from "../tools/types";
import type { ToolConfirmationResult, ToolExecutionResult, ToolCallLike } from "../tools/types";
import { createToolErrorResult } from "../tools/errors";
import { redactValue } from "../tools/security/redaction";
import type { SessionHitlResumeAdapter as ResumeAdapterContract } from "../hitl/resume-coordinator";
import { askUserResponseToToolResult } from "./session-hitl-pause";
import {
  deleteSessionHitlCheckpoint,
  isResponseForSessionCheckpoint,
  readSessionHitlCheckpoint,
  type SessionHitlCheckpointRecord,
  type SessionHitlCompletedToolResult,
} from "./session-hitl-checkpoint";

export interface SessionHitlResumeAdapterOptions {
  readonly workspaceRoot: string;
  readonly storeManager: SessionStoreManager;
  readonly toolRegistry: ToolRegistry;
  readonly projectContextResolver: ProjectContextResolver;
  readonly skillService?: SkillService;
  readonly getAgent?: (workspaceRoot: string, sessionId: string) => Promise<Agent>;
  readonly startChildExecution?: (workspaceRoot: string, request: ChildExecutionRequest) => Promise<ChildExecutionHandle>;
  readonly cancelChildSession?: (workspaceRoot: string, parentSessionId: string, childSessionId: string) => boolean;
  readonly resumeChildSession?: (workspaceRoot: string, request: ResumeChildRequest) => Promise<ChildExecutionHandle>;
  readonly abortSessionExecutionAndWait?: (workspaceRoot: string, sessionId: string) => Promise<void>;
}

export class SessionHitlResumeAdapter implements ResumeAdapterContract {
  constructor(private readonly options: SessionHitlResumeAdapterOptions) {}

  async resume(record: HitlRecord, response: HitlResponse): Promise<void> {
    if (record.owner.ownerType !== "session") throw new Error(`Session adapter cannot resume ${record.owner.ownerType} HITL`);
    const sessionId = record.owner.ownerId;
    const checkpoint = await readSessionHitlCheckpoint(this.options.workspaceRoot, sessionId, record.hitlId);
    if (checkpoint === undefined) throw new Error(`Missing Session HITL checkpoint for ${record.hitlId}`);
    if (!isResponseForSessionCheckpoint(checkpoint, response)) throw new Error(`Invalid response type ${response.type} for Session HITL ${record.hitlId}`);

    const store = await this.options.storeManager.getOrLoad(sessionId, this.options.workspaceRoot);
    const projectContext = await this.options.projectContextResolver.resolve(this.options.workspaceRoot);
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
      await this.continueAgent(checkpoint, sessionId);
      clearBlockerForHitlId(store, record.hitlId);
      await deleteSessionHitlCheckpoint(this.options.workspaceRoot, sessionId, record.hitlId);
      return;
    }

    for (let index = 0; index < pending.length; index += 1) {
      const call = pending[index]!;
      const result = index === 0
        ? await this.resumeBlockedTool(checkpoint, response, store, completed)
        : await this.executeTool(call, checkpoint, store, completed, pending.slice(index), projectContext);
      appendToolResult(store, call, result);
      completed.push({ toolCallId: call.toolCallId, toolName: call.toolName, output: result.output, isError: result.isError, ...(result.meta === undefined ? {} : { meta: result.meta }) });
    }

    await this.continueAgent(checkpoint, sessionId);
    clearBlockerForHitlId(store, record.hitlId);
    await deleteSessionHitlCheckpoint(this.options.workspaceRoot, sessionId, record.hitlId);
  }

  private async continueAgent(checkpoint: SessionHitlCheckpointRecord, sessionId: string): Promise<void> {
    if (this.options.getAgent !== undefined) {
      const agent = await this.options.getAgent(this.options.workspaceRoot, sessionId);
      await agent.run("", {
        ...(checkpoint.origin === undefined ? {} : { origin: checkpoint.origin }),
      });
    }
  }

  private async resumeBlockedTool(
    checkpoint: SessionHitlCheckpointRecord,
    response: HitlResponse,
    store: StoreApi<SessionStoreState>,
    completed: readonly SessionHitlCompletedToolResult[],
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
    response?: HitlResponse,
  ): Promise<ToolExecutionResult> {
    const abort = new AbortController().signal;
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
      ...(this.options.skillService === undefined ? {} : { skillService: this.options.skillService }),
      projectContext,
      storeManager: this.options.storeManager,
      ...(checkpoint.agentName === undefined ? {} : { agentName: checkpoint.agentName }),
      ...(checkpoint.currentDepth === undefined ? {} : { currentDepth: checkpoint.currentDepth }),
      ...(checkpoint.origin === undefined ? {} : { origin: checkpoint.origin }),
      ...(response === undefined ? {} : { confirmPermission: async () => permissionDecisionFromResponse(response) }),
      ...(this.options.startChildExecution === undefined ? {} : { startChildExecution: (request) => this.options.startChildExecution!(this.options.workspaceRoot, request) }),
      ...(this.options.cancelChildSession === undefined ? {} : { cancelChildSession: this.options.cancelChildSession }),
      ...(this.options.resumeChildSession === undefined ? {} : { resumeChildSession: this.options.resumeChildSession }),
      ...(this.options.abortSessionExecutionAndWait === undefined ? {} : { abortSessionExecutionAndWait: this.options.abortSessionExecutionAndWait }),
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
      onToolAttempt(attempt) {
        store.getState().append({
          type: "tool-attempt",
          toolCallId: attempt.toolCallId,
          toolName: attempt.toolName,
          attemptId: attempt.attemptId,
          timestamp: attempt.timestamp,
          destructive: attempt.destructive,
        });
      },
    });
    return await this.options.toolRegistry.execute(call, ctx);
  }
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

function clearBlockerForHitlId(store: StoreApi<SessionStoreState>, hitlId: string): void {
  const state = store.getState();
  const blockedByHitlIds = state.blockedByHitlIds?.filter((id) => id !== hitlId);
  const blockedHitl = state.blockedHitl?.hitlId === hitlId ? undefined : state.blockedHitl;
  if (blockedHitl === state.blockedHitl && blockedByHitlIds?.length === state.blockedByHitlIds?.length) return;

  store.setState({
    blockedHitl,
    blockedByHitlIds: blockedByHitlIds === undefined || blockedByHitlIds.length === 0 ? undefined : blockedByHitlIds,
  });
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
