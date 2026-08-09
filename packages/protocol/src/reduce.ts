import type {
  CompressionBlockPart,
  CompressionBlockSnapshot,
  CompressionFailureSnapshot,
  CompressionRefMapSnapshot,
  CompressionStateSnapshot,
  CompactionPart,
  CompletedToolPart,
  ErrorToolPart,
  AssistantOutputPart,
  AssistantSessionPart,
  ReasoningPart,
  RecoveryNoticePart,
  RunningToolPart,
  SessionMessage,
  SessionPart,
  SessionProjection,
  SessionStats,
  SessionTodo,
  StreamEvent,
  SystemNoticePart,
  ToolChildSessionLink,
  ToolPart,
  FinalizedToolResult,
  ExecutionLifecycleEvent,
  ExecutionEndEvent,
  ExecutionTransitionValidation,
  SessionExecutionRecord,
} from "./types";
import type { SessionGoalChangedEvent } from "./session-goal";
import { renderCompressionSummarySnapshot } from "./compression";
import { addUsage, createEmptySessionStats, normalizeUsage } from "./usage";
import { validateExecutionTransition } from "./execution";

const LIVE_TOOL_OUTPUT_PREVIEW_MAX_BYTES = 50 * 1024;
const UTF8_ENCODER = new TextEncoder();
const ASSISTANT_PROJECTION_ENVELOPE =
  /^\s*<message ref="m\d{4,}">(?:\r?\n)?([\s\S]*?)(?:\r?\n)?<\/message>\s*$/;

const TODO_STATUSES = new Set<SessionTodo["status"]>([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

interface AssistantMessageResult {
  messages: SessionMessage[];
  currentAssistantMessageId: string;
  stats?: SessionStats;
}

interface RecoveryAssistantResult {
  messages: SessionMessage[];
  assistantMessageId: string;
  stats?: SessionStats;
}

interface PartLocation {
  messageId: string;
  partId: string;
}

/**
 * Message refs are model-facing projection metadata, not canonical Assistant
 * content. Some providers echo the complete envelope around an otherwise valid
 * response, so remove only that exact outer shape once streaming completes.
 */
function unwrapAssistantProjectionEnvelope(text: string): string {
  return ASSISTANT_PROJECTION_ENVELOPE.exec(text)?.[1] ?? text;
}

export interface ReduceContext {
  timestamp: number;
  generateId: () => string;
}

export function reduceStreamEvent(
  state: SessionProjection,
  event: StreamEvent | SessionGoalChangedEvent,
  ctx: ReduceContext,
): Partial<SessionProjection> {
  const timestamp = ctx.timestamp;
  if (isExecutionLifecycleEvent(event)) {
    const transition = validateExecutionTransition(state.executions, event);
    if (transition.outcome !== "valid") return {};
    if (
      event.type === "execution-end"
      && validateExecutionFinalOutputSelection(state, event).outcome === "invalid"
    ) return {};
  }

  switch (event.type) {
    case "execution-start": {
      const executionId = event.executionId;
      const executions = [
        ...(state.executions ?? []),
        {
          id: executionId,
          startedAt: timestamp,
          status: "running" as const,
          origin: event.origin,
          maxSteps: event.maxSteps,
          ...(event.activeTimeoutMs === undefined ? {} : { activeTimeoutMs: event.activeTimeoutMs }),
          memoryPolicy: event.memoryPolicy,
          durationMs: 0,
          runs: [{ ordinal: 0, startedAt: timestamp, binding: event.binding }],
        },
      ];

      return {
        isRunning: true,
        currentExecutionId: executionId,
        currentAssistantMessageId: undefined,
        isStreamingModel: false,
        executions,
        executionCount: executions.length,
      };
    }

    case "execution-suspended": {
      const executions = state.executions.map((execution): SessionExecutionRecord => {
        if (execution.id !== event.executionId || execution.status !== "running") return execution;
        const run = execution.runs.at(-1)!;
        const durationMs = Math.max(0, event.runEndedAt - run.startedAt);
        return {
          ...execution,
          status: "suspended",
          durationMs: execution.durationMs + durationMs,
          runs: [
            ...execution.runs.slice(0, -1),
            {
              ...run,
              endedAt: event.runEndedAt,
              durationMs,
              usageDelta: event.runUsageDelta,
              settlement: event.runSettlement,
            },
          ],
          suspension: event.suspension,
        };
      });
      return {
        executions,
        isRunning: false,
        isStreamingModel: false,
        currentExecutionId: event.executionId,
      };
    }

    case "execution-suspension-updated":
      return {
        executions: state.executions.map((execution): SessionExecutionRecord =>
          execution.id === event.executionId && execution.status === "suspended"
            ? { ...execution, suspension: event.suspension }
            : execution
        ),
      };

    case "execution-resumed":
      return {
        executions: state.executions.map((execution): SessionExecutionRecord =>
          execution.id === event.executionId && execution.status === "suspended"
            ? resumeExecution(execution, event.runOrdinal, event.binding, timestamp)
            : execution
        ),
        isRunning: true,
        isStreamingModel: false,
        currentExecutionId: event.executionId,
      };

    case "execution-end": {
      const executions = endExecution(state, event);
      const settledMessages = settleIncompleteState(
        state.messages,
        state.currentAssistantMessageId,
        event.endedAt,
        event.terminalStatus,
      );

      return {
        messages: event.finalOutputStepId === undefined
          ? settledMessages
          : promoteFinalAssistantOutput(settledMessages, event.executionId, event.finalOutputStepId),
        executions,
        executionCount: executions.length,
        isRunning: false,
        isStreamingModel: false,
        currentExecutionId: undefined,
        currentAssistantMessageId: undefined,
      };
    }

    case "session.cwd_changed":
      return { cwd: event.cwd };

    case "session.model_selection_changed":
      return { modelSelection: event.modelSelection };

    case "session.goal_changed":
      return { goal: event.goal ?? undefined };

    case "session.message_accepted":
      return { pendingMessages: [...state.pendingMessages, event.message] };

    case "session.message_edited":
    case "session.message_steer_claimed":
    case "session.message_steer_rolled_back":
      return {
        pendingMessages: state.pendingMessages.map((message) =>
          message.id === event.message.id ? event.message : message
        ),
      };

    case "session.message_deleted":
      return {
        pendingMessages: state.pendingMessages.filter((message) => message.id !== event.messageId),
      };

    case "session.messages_committed": {
      const committedIds = new Set(event.messages.map((message) => message.id));
      const existingIds = new Set(state.messages.map((message) => message.id));
      const newMessages = event.messages.filter((message) => !existingIds.has(message.id));
      return {
        pendingMessages: state.pendingMessages.filter((message) => !committedIds.has(message.id)),
        messages: [...state.messages, ...newMessages],
        stats: incrementUserMessagesBy(state.stats, newMessages.length),
      };
    }

    case "execution-stop-requested": {
      let changed = false;
      const executions = state.executions.map((execution) => {
        if (execution.id !== event.executionId) return execution;
        changed = true;
        return {
          ...execution,
          stopRequestedAt: Math.max(execution.stopRequestedAt ?? 0, event.timestamp),
        };
      });
      return changed ? { executions } : {};
    }

    case "system-notice": {
      const part: SystemNoticePart = {
        type: "system-notice",
        id: ctx.generateId(),
        notice: event.message,
        createdAt: timestamp,
        completedAt: timestamp,
      };
      const message: SessionMessage = {
        id: ctx.generateId(),
        role: "user",
        parts: [part],
        createdAt: timestamp,
        completedAt: timestamp,
        ...currentMessageExecution(state),
      };

      return { messages: [...state.messages, message] };
    }

    case "text-start": {
      if (!isActiveOpenStep(state, event.stepId)) return {};
      const messageId = modelStepMessageId(state.messages, event.stepId);
      if (messageId === undefined || findBlockLocation(state.messages, event.stepId, "assistant-output", event.blockId)) {
        return {};
      }
      return appendAssistantOutputPart(
        state.messages,
        messageId,
        event.blockId,
        timestamp,
        "",
        ctx,
      );
    }

    case "text-delta": {
      if (!isActiveOpenStep(state, event.stepId)) return {};
      const location = findBlockLocation(state.messages, event.stepId, "assistant-output", event.blockId);
      const part = location === undefined ? undefined : getPartAtLocation(state.messages, location);
      if (!location || part?.type !== "assistant-output" || part.completedAt !== undefined) return {};
      const stats = part.text.length === 0 && event.text.length > 0
        ? firstAssistantContentStats(state, location.messageId)
        : undefined;
      return {
        messages: updateMessagePart(
          state.messages,
          location.messageId,
          location.partId,
          (part) => part.type === "assistant-output"
            ? { ...part, text: `${part.text}${event.text}` }
            : part,
        ),
        ...(stats === undefined ? {} : { stats }),
      };
    }

    case "text-end": {
      if (!isActiveOpenStep(state, event.stepId)) return {};
      const location = findBlockLocation(state.messages, event.stepId, "assistant-output", event.blockId);
      const part = location === undefined ? undefined : getPartAtLocation(state.messages, location);
      if (!location || part?.type !== "assistant-output" || part.completedAt !== undefined) return {};
      if (part.text.length === 0) {
        return {
          messages: removeMessagePart(state.messages, location.messageId, location.partId),
        };
      }

      return {
        messages: updateMessagePart(
          state.messages,
          location.messageId,
          location.partId,
          (part) =>
            part.type === "assistant-output"
              ? {
                  ...part,
                  text: unwrapAssistantProjectionEnvelope(part.text),
                  completedAt: timestamp,
                }
              : part,
        ),
      };
    }

    case "reasoning-start": {
      if (!isActiveOpenStep(state, event.stepId)) return {};
      const messageId = modelStepMessageId(state.messages, event.stepId);
      if (messageId === undefined || findBlockLocation(state.messages, event.stepId, "reasoning", event.blockId)) {
        return {};
      }
      return appendReasoningPart(
        state.messages,
        messageId,
        event.blockId,
        timestamp,
        "",
        ctx,
      );
    }

    case "reasoning-delta": {
      if (!isActiveOpenStep(state, event.stepId)) return {};
      const location = findBlockLocation(state.messages, event.stepId, "reasoning", event.blockId);
      const part = location === undefined ? undefined : getPartAtLocation(state.messages, location);
      if (!location || part?.type !== "reasoning" || part.completedAt !== undefined) return {};
      const stats = part.text.length === 0 && event.text.length > 0
        ? firstAssistantContentStats(state, location.messageId)
        : undefined;
      return {
        messages: updateMessagePart(
          state.messages,
          location.messageId,
          location.partId,
          (part) => part.type === "reasoning"
            ? { ...part, text: `${part.text}${event.text}` }
            : part,
        ),
        ...(stats === undefined ? {} : { stats }),
      };
    }

    case "reasoning-end": {
      if (!isActiveOpenStep(state, event.stepId)) return {};
      const location = findBlockLocation(state.messages, event.stepId, "reasoning", event.blockId);
      const part = location === undefined ? undefined : getPartAtLocation(state.messages, location);
      if (!location || part?.type !== "reasoning" || part.completedAt !== undefined) return {};
      if (part.text.length === 0) {
        return {
          messages: removeMessagePart(state.messages, location.messageId, location.partId),
        };
      }

      return {
        messages: updateMessagePart(
          state.messages,
          location.messageId,
          location.partId,
          (part) => (part.type === "reasoning" ? { ...part, completedAt: timestamp } : part),
        ),
      };
    }

    case "tool-input-start": {
      const assistant = ensureCurrentAssistantMessage(state, timestamp, ctx);
      const existing = findCurrentToolPartByCallId(
        assistant.messages,
        assistant.currentAssistantMessageId,
        event.toolCallId,
      );

      if (existing) return {};

      const part: ToolPart = {
        type: "tool",
        id: ctx.generateId(),
        state: "pending",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        createdAt: timestamp,
      };

      return {
        messages: appendPartToMessage(
          assistant.messages,
          assistant.currentAssistantMessageId,
          part,
        ),
        currentAssistantMessageId: assistant.currentAssistantMessageId,
        ...(assistant.stats ? { stats: assistant.stats } : {}),
      };
    }

    case "tool-call": {
      const location = findCurrentToolPartByCallId(
        state.messages,
        state.currentAssistantMessageId,
        event.toolCallId,
      );

      if (location) {
        const existing = getToolPartAtLocation(state.messages, location.messageId, location.partId);
        if (!existing || (existing.state !== "pending" && existing.state !== "running")) {
          return {};
        }

        const countsCall = existing.state === "pending";
        return {
          messages: updateMessagePart(
            state.messages,
            location.messageId,
            location.partId,
            (part) => (part.type === "tool" ? toRunningToolPart(part, event.input, timestamp) : part),
          ),
          ...(countsCall ? { stats: incrementToolCalls(state.stats) } : {}),
        };
      }

      const assistant = ensureCurrentAssistantMessage(state, timestamp, ctx);
      const part: RunningToolPart = {
        type: "tool",
        id: ctx.generateId(),
        state: "running",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input === undefined ? null : event.input,
        createdAt: timestamp,
        startedAt: timestamp,
      };

      return {
        messages: appendPartToMessage(
          assistant.messages,
          assistant.currentAssistantMessageId,
          part,
        ),
        currentAssistantMessageId: assistant.currentAssistantMessageId,
        stats: incrementToolCalls(assistant.stats ?? state.stats),
      };
    }

    case "tool-input-resolved": {
      const location = findCurrentToolPartByCallId(
        state.messages,
        state.currentAssistantMessageId,
        event.toolCallId,
      ) ?? findLatestIncompleteToolPartByCallId(
        state.messages,
        event.toolCallId,
      );

      if (!location) return {};

      const existing = getToolPartAtLocation(state.messages, location.messageId, location.partId);
      if (!existing || existing.state === "pending" || existing.state === "interrupted") return {};

      return {
        messages: updateMessagePart(
          state.messages,
          location.messageId,
          location.partId,
          (part) => (part.type === "tool" ? { ...part, input: event.input === undefined ? null : event.input } : part),
        ),
      };
    }

    case "tool-attempt": {
      const location = findCurrentToolPartByCallId(
        state.messages,
        state.currentAssistantMessageId,
        event.toolCallId,
      ) ?? findLatestIncompleteToolPartByCallId(
        state.messages,
        event.toolCallId,
      );

      if (!location) return {};

      const existing = getToolPartAtLocation(state.messages, location.messageId, location.partId);
      if (
        !existing
        || (
          existing.state !== "pending"
          && existing.state !== "running"
          && existing.state !== "interrupted"
        )
      ) {
        return {};
      }

      return {
        messages: updateMessagePart(
          state.messages,
          location.messageId,
          location.partId,
          (part) => part.type === "tool" ? withToolAttempt(part, event) : part,
        ),
      };
    }

    case "tool-output-delta": {
      const location = findCurrentToolPartByCallId(
        state.messages,
        state.currentAssistantMessageId,
        event.toolCallId,
      ) ?? findLatestIncompleteToolPartByCallId(
        state.messages,
        event.toolCallId,
      );

      if (!location) return {};

      const existing = getToolPartAtLocation(state.messages, location.messageId, location.partId);
      if (
        !existing
        || existing.state !== "running"
        || existing.toolName !== "bash"
        || existing.toolName !== event.toolName
      ) {
        return {};
      }

      return {
        messages: updateMessagePart(
          state.messages,
          location.messageId,
          location.partId,
          (part) => part.type === "tool" && part.state === "running"
            ? appendLiveToolOutput(part, event)
            : part,
        ),
      };
    }

    case "tool-result": {
      const location = findCurrentToolPartByCallId(
        state.messages,
        state.currentAssistantMessageId,
        event.toolCallId,
      ) ?? findLatestIncompleteToolPartByCallId(
        state.messages,
        event.toolCallId,
      );

      if (!location) return {};

      const existing = getToolPartAtLocation(state.messages, location.messageId, location.partId);
      if (!existing || existing.state === "completed" || existing.state === "error") return {};

      return {
        messages: updateMessagePart(
          state.messages,
          location.messageId,
          location.partId,
          (part) =>
            part.type === "tool"
              ? toSettledToolPart(part, event.result, event.settledAt)
              : part,
        ),
        stats: event.result.isError ? incrementToolFailures(state.stats, 1) : incrementToolCompleted(state.stats),
      };
    }

    case "tool-child-session-link": {
      return {
        childSessionLinks: upsertChildSessionLink(state.childSessionLinks, event.link),
      };
    }

    case "todo-write": {
      if (!areTodosValid(event.todos)) return {};
      return { todos: [...event.todos] };
    }

    case "reminder": {
      if (state.reminders.some((reminder) => reminder.id === event.reminder.id)) {
        return {};
      }

      if (isSubAgentReminder(event.reminder)) {
        const hasTerminalReminder = state.reminders.some(
          (reminder) =>
            reminder.sessionId === event.reminder.sessionId &&
            isSubAgentReminder(reminder),
        );

        if (hasTerminalReminder) return {};
      }

      return {
        reminders: [...state.reminders, { ...event.reminder, consumedAt: null }],
      };
    }

    case "reminder-consumed": {
      const reminderIds = new Set(event.reminderIds);
      let changed = false;

      const reminders = state.reminders.map((reminder) => {
        if (!reminderIds.has(reminder.id) || reminder.consumedAt !== null) {
          return reminder;
        }

        changed = true;
        return { ...reminder, consumedAt: timestamp };
      });

      return changed ? { reminders } : {};
    }

    case "step-start": {
      const executionId = state.currentExecutionId;
      const runOrdinal = currentRunOrdinal(state);
      if (executionId === undefined || runOrdinal === undefined) return {};
      if (state.steps.some((step) => step.id === event.stepId)) return {};
      const message: SessionMessage = {
        id: ctx.generateId(),
        role: "assistant",
        parts: [],
        createdAt: timestamp,
        executionId,
        runOrdinal,
        stepId: event.stepId,
        outputPhase: "commentary",
      };

      return {
        isStreamingModel: true,
        messages: [...state.messages, message],
        currentAssistantMessageId: message.id,
        steps: [
          ...state.steps,
          {
            id: event.stepId,
            step: event.step,
            executionId,
            runOrdinal,
            startedAt: timestamp,
          },
        ],
        stats: incrementStepStarted(state.stats),
      };
    }

    case "step-end": {
      const executionId = state.currentExecutionId;
      const runOrdinal = currentRunOrdinal(state);
      if (executionId === undefined || runOrdinal === undefined) return {};
      const usage = normalizeUsage(event.usage);
      const hasOpenStep = state.steps.some(
        (step) => step.id === event.stepId
          && step.step === event.step
          && step.executionId === executionId
          && step.runOrdinal === runOrdinal
          && !step.completedAt,
      );
      if (!hasOpenStep) return {};
      const interruptedMessages = event.finishReason === "interrupted" || event.finishReason === "error"
        ? markAssistantModelOutputInterruptedForStep(state.messages, event.stepId, timestamp)
        : state.messages;
      const messages = completeAssistantMessageForStep(interruptedMessages, event.stepId, timestamp);
      return {
        isStreamingModel: false,
        steps: state.steps.map((step) =>
          step.id === event.stepId
            && step.step === event.step
            && step.executionId === executionId
            && step.runOrdinal === runOrdinal
            && !step.completedAt
            ? {
                ...step,
                completedAt: timestamp,
                finishReason: event.finishReason,
                usage,
              }
            : step,
        ),
        messages,
        stats: incrementStepCompleted(state.stats, usage),
      };
    }

    case "execution-error": {
      // Preparation can fail before a model Step exists. Keep the durable error
      // event without fabricating a Step that never started.
      if (event.step === undefined) return {};
      const executionId = state.currentExecutionId;
      const runOrdinal = currentRunOrdinal(state);
      if (executionId === undefined || runOrdinal === undefined) return {};

      const matchingStep =
        state.steps.find(
          (step) => step.id === event.stepId
            && step.step === event.step
            && step.executionId === executionId
            && step.runOrdinal === runOrdinal,
        );

      if (matchingStep) {
        return {
          steps: state.steps.map((step) =>
            step.id === matchingStep.id ? { ...step, error: event.error } : step,
          ),
        };
      }

      return {};
    }

    case "prompt-trace":
      return { promptTraces: [...(state.promptTraces ?? []), event.trace] };

    case "llm-retry": {
      if (event.visibility === "internal") return {};

      const assistant = assistantForRecoveryEvent(state, event);
      if (assistant === undefined) return {};
      const status = event.nextRetryAt === undefined || event.nextRetryAt <= timestamp ? "retrying" : "scheduled";
      return upsertRecoveryNoticePart(
        assistant.messages,
        assistant.assistantMessageId,
        {
          type: "recovery-notice",
          id: recoveryNoticeId(event, ctx),
          status,
          message: event.message,
          attempt: event.attempt,
          ...(event.nextRetryAt === undefined ? {} : { nextRetryAt: event.nextRetryAt }),
          errorKind: event.errorKind,
          createdAt: timestamp,
        },
        assistant.stats,
      );
    }

    case "llm-recovery": {
      if (event.visibility === "internal") return {};

      const assistant = assistantForRecoveryEvent(state, event);
      if (assistant === undefined) return {};
      return upsertRecoveryNoticePart(
        assistant.messages,
        assistant.assistantMessageId,
        {
          type: "recovery-notice",
          id: recoveryNoticeId(event, ctx),
          status: "recovered",
          message: event.message,
          attempt: event.attempt,
          ...(event.errorKind === undefined ? {} : { errorKind: event.errorKind }),
          createdAt: timestamp,
          completedAt: timestamp,
        },
        assistant.stats,
      );
    }

    case "llm-recovery-failed": {
      const assistant = assistantForRecoveryEvent(state, event);
      if (assistant === undefined) return {};
      return upsertRecoveryNoticePart(
        assistant.messages,
        assistant.assistantMessageId,
        {
          type: "recovery-notice",
          id: recoveryNoticeId(event, ctx),
          status: "failed",
          message: event.message,
          attempt: event.attempt,
          errorKind: event.errorKind,
          statusCode: event.statusCode,
          createdAt: timestamp,
          completedAt: timestamp,
        },
        assistant.stats,
      );
    }

    case "compression.block_committed": {
      const compression = event.state ?? commitCompressionBlockSnapshot(state.compression, event.block, timestamp);
      const compressionBlocks = upsertCompressionBlockPart(state.compressionBlocks ?? [], event.block, timestamp, ctx);

      return { compression, compressionBlocks };
    }

    case "compression.block_failed": {
      const compression = event.state ?? appendCompressionFailureSnapshot(state.compression, event.failure, timestamp);

      return { compression };
    }

    case "compression.ref_map_updated": {
      const compression = {
        ...(state.compression ?? createEmptyCompressionStateSnapshot()),
        refMap: event.refMap,
        ...(event.updatedAt === undefined ? {} : { updatedAt: event.updatedAt }),
      } satisfies CompressionStateSnapshot;

      return { compression };
    }

    case "compact": {
      const { summary, tailStartId } = event;

      const tailStartIndex = state.messages.findIndex((message) => message.id === tailStartId);
      const compactUpTo = tailStartIndex === -1 ? state.messages.length : tailStartIndex;

      const messages = state.messages.map((message, index) => {
        if (index < compactUpTo) {
          if (message.parts.some((part) => part.type === "compaction")) return message;
          return { ...message, compacted: true };
        }
        return message;
      });

      const existingCompactionIndex = messages.findIndex((message) =>
        message.parts.some((part) => part.type === "compaction"),
      );

      if (existingCompactionIndex !== -1) {
        const existingMessage = messages[existingCompactionIndex]!;
        const updatedParts = existingMessage.parts.map((part) => {
          if (part.type === "compaction") {
            return {
              ...part,
              summary,
              tailStartId,
              compactedAt: timestamp,
            } satisfies CompactionPart;
          }
          return part;
        });

        messages[existingCompactionIndex] = {
          ...existingMessage,
          parts: updatedParts,
          compacted: undefined,
        } as SessionMessage;
      } else {
        const compactionPart: CompactionPart = {
          type: "compaction",
          id: ctx.generateId(),
          summary,
          tailStartId,
          compactedAt: timestamp,
        };

        const syntheticMessage: SessionMessage = {
          id: ctx.generateId(),
          role: "user",
          parts: [compactionPart],
          createdAt: timestamp,
          completedAt: timestamp,
        };

        messages.splice(compactUpTo, 0, syntheticMessage);
      }

      return { messages, compression: undefined, compressionBlocks: [] };
    }
  }
}

function completeAssistantMessageForStep(
  messages: SessionMessage[],
  stepId: string,
  completedAt: number,
): SessionMessage[] {
  return messages.map((message) => (
    message.role === "assistant" && message.stepId === stepId && message.completedAt === undefined
      ? { ...message, completedAt }
      : message
  ));
}

export function validateExecutionFinalOutputSelection(
  state: Pick<SessionProjection, "messages" | "steps">,
  event: Pick<ExecutionEndEvent, "executionId" | "terminalStatus" | "finalOutputStepId">,
): ExecutionTransitionValidation {
  if (event.finalOutputStepId === undefined) return { outcome: "valid" };
  if (event.terminalStatus !== "completed") {
    return { outcome: "invalid", reason: "Only a completed Execution may select final Assistant output" };
  }
  const executionSteps = state.steps.filter((step) => step.executionId === event.executionId);
  const selected = executionSteps.at(-1);
  if (selected?.id !== event.finalOutputStepId || selected.completedAt === undefined) {
    return { outcome: "invalid", reason: "Final Assistant output must select the last completed model attempt" };
  }
  if (selected.finishReason !== "stop") {
    return { outcome: "invalid", reason: "Final Assistant output requires finishReason stop" };
  }
  if (!hasTrustedAssistantOutput(state.messages, selected.id)) {
    return { outcome: "invalid", reason: "Final Assistant output must be completed, non-empty, and trusted" };
  }
  return { outcome: "valid" };
}

function hasTrustedAssistantOutput(messages: SessionMessage[], stepId: string): boolean {
  const message = messages.find((candidate) => candidate.role === "assistant" && candidate.stepId === stepId);
  if (message?.role !== "assistant") return false;
  const outputParts = message.parts.filter((part) => part.type === "assistant-output");
  return outputParts.length > 0
    && outputParts.every((part) => (
      part.completedAt !== undefined
      && part.meta?.interrupted !== true
      && part.meta?.discardedFromContext !== true
    ))
    && outputParts.some((part) => part.text.trim().length > 0);
}

function promoteFinalAssistantOutput(
  messages: SessionMessage[],
  executionId: string,
  stepId: string,
): SessionMessage[] {
  return messages.map((message) => (
    message.role === "assistant"
    && message.executionId === executionId
    && message.stepId === stepId
      ? { ...message, outputPhase: "final_answer" }
      : message
  ));
}

function createEmptyCompressionRefMapSnapshot(): CompressionRefMapSnapshot {
  return {
    messageRefsById: {},
    messageIdsByRef: {},
    blockRefsById: {},
    blockIdsByRef: {},
    nextMessageIndex: 1,
    nextBlockIndex: 1,
  };
}

function createEmptyCompressionStateSnapshot(): CompressionStateSnapshot {
  return {
    refMap: createEmptyCompressionRefMapSnapshot(),
    blocksByRef: {},
    activeBlockRefs: [],
    inactiveBlockRefs: [],
    supersededBlockRefs: [],
    failures: [],
  };
}

function commitCompressionBlockSnapshot(
  existing: CompressionStateSnapshot | undefined,
  block: CompressionBlockSnapshot,
  timestamp: number,
): CompressionStateSnapshot {
  const base = existing ?? createEmptyCompressionStateSnapshot();
  const blocksByRef = { ...base.blocksByRef, [block.ref]: block };
  return normalizeCompressionStateSnapshot({
    ...base,
    refMap: mergeCompressionRefMap(base.refMap, block),
    blocksByRef,
    updatedAt: block.updatedAt || timestamp,
  });
}

function appendCompressionFailureSnapshot(
  existing: CompressionStateSnapshot | undefined,
  failure: CompressionFailureSnapshot,
  timestamp: number,
): CompressionStateSnapshot {
  const base = existing ?? createEmptyCompressionStateSnapshot();
  return {
    ...base,
    failures: [...base.failures, failure],
    updatedAt: failure.failedAt || timestamp,
  };
}

function normalizeCompressionStateSnapshot(state: CompressionStateSnapshot): CompressionStateSnapshot {
  const blocks = Object.values(state.blocksByRef);
  return {
    ...state,
    activeBlockRefs: blocks.filter((block) => block.status === "active").map((block) => block.ref),
    inactiveBlockRefs: blocks.filter((block) => block.status === "inactive").map((block) => block.ref),
    supersededBlockRefs: blocks.filter((block) => block.status === "superseded").map((block) => block.ref),
  };
}

function mergeCompressionRefMap(
  refMap: CompressionRefMapSnapshot,
  block: CompressionBlockSnapshot,
): CompressionRefMapSnapshot {
  return {
    ...refMap,
    messageRefsById: {
      ...refMap.messageRefsById,
      [block.range.startMessageId]: block.range.startRef,
      [block.range.endMessageId]: block.range.endRef,
    },
    messageIdsByRef: {
      ...refMap.messageIdsByRef,
      [block.range.startRef]: block.range.startMessageId,
      [block.range.endRef]: block.range.endMessageId,
    },
    blockRefsById: { ...refMap.blockRefsById, [block.id]: block.ref },
    blockIdsByRef: { ...refMap.blockIdsByRef, [block.ref]: block.id },
  };
}

function upsertCompressionBlockPart(
  parts: CompressionBlockPart[],
  block: CompressionBlockSnapshot,
  timestamp: number,
  ctx: ReduceContext,
): CompressionBlockPart[] {
  const part = toCompressionBlockPart(block, timestamp, ctx);
  const existingIndex = parts.findIndex((item) => item.blockRef === block.ref);
  if (existingIndex === -1) return [...parts, part];
  return parts.map((item, index) => index === existingIndex ? part : item);
}

function toCompressionBlockPart(
  block: CompressionBlockSnapshot,
  timestamp: number,
  ctx: ReduceContext,
): CompressionBlockPart {
  return {
    type: "compression-block",
    id: `compression:${block.ref}:${ctx.generateId()}`,
    blockRef: block.ref,
    status: block.status,
    strategy: block.strategy,
    trigger: block.trigger,
    summary: renderCompressionSummarySnapshot(block.summary),
    startRef: block.range.startRef,
    endRef: block.range.endRef,
    childBlockRefs: block.childBlockRefs,
    committedAt: block.createdAt || timestamp,
  };
}

function upsertChildSessionLink(
  links: readonly ToolChildSessionLink[],
  nextLink: ToolChildSessionLink,
): ToolChildSessionLink[] {
  const existingIndex = links.findIndex((link) =>
    link.parentSessionId === nextLink.parentSessionId &&
    link.parentToolCallId === nextLink.parentToolCallId &&
    link.childSessionId === nextLink.childSessionId &&
    link.childExecutionId === nextLink.childExecutionId
  );

  if (existingIndex === -1) return [...links, nextLink];

  return links.map((link, index) => index === existingIndex ? nextLink : link);
}

function areTodosValid(todos: readonly SessionTodo[]): boolean {
  let inProgressCount = 0;

  for (const todo of todos) {
    if (!TODO_STATUSES.has(todo.status)) return false;

    if (todo.status === "in_progress") {
      inProgressCount += 1;
    }
  }

  return inProgressCount <= 1;
}

function isSubAgentReminder(reminder: { source: { type: string } }): boolean {
  return reminder.source.type.startsWith("subagent_");
}

function incrementUserMessages(stats: SessionStats): SessionStats {
  return incrementUserMessagesBy(stats, 1);
}

function incrementUserMessagesBy(stats: SessionStats, count: number): SessionStats {
  if (count <= 0) return stats;
  return {
    ...stats,
    messages: {
      user: stats.messages.user + count,
      assistant: stats.messages.assistant,
      total: stats.messages.total + count,
    },
  };
}

function incrementAssistantMessages(stats: SessionStats): SessionStats {
  return {
    ...stats,
    messages: {
      user: stats.messages.user,
      assistant: stats.messages.assistant + 1,
      total: stats.messages.total + 1,
    },
  };
}

function incrementToolCalls(stats: SessionStats): SessionStats {
  return { ...stats, tools: { ...stats.tools, calls: stats.tools.calls + 1 } };
}

function incrementToolCompleted(stats: SessionStats): SessionStats {
  return { ...stats, tools: { ...stats.tools, completed: stats.tools.completed + 1 } };
}

function incrementToolFailures(stats: SessionStats, count: number): SessionStats {
  if (count <= 0) return stats;
  return { ...stats, tools: { ...stats.tools, failed: stats.tools.failed + count } };
}

function incrementStepStarted(stats: SessionStats): SessionStats {
  return { ...stats, steps: { ...stats.steps, started: stats.steps.started + 1 } };
}

function incrementStepCompleted(stats: SessionStats, usage: ReturnType<typeof normalizeUsage>): SessionStats {
  return {
    ...stats,
    steps: { ...stats.steps, completed: stats.steps.completed + 1 },
    usage: addUsage(stats.usage, usage),
  };
}

function isExecutionLifecycleEvent(
  event: StreamEvent | SessionGoalChangedEvent,
): event is ExecutionLifecycleEvent {
  return event.type === "execution-start"
    || event.type === "execution-suspended"
    || event.type === "execution-suspension-updated"
    || event.type === "execution-resumed"
    || event.type === "execution-end";
}

function endExecution(
  state: SessionProjection,
  event: ExecutionEndEvent,
): SessionExecutionRecord[] {
  return state.executions.map((execution): SessionExecutionRecord => {
    if (execution.id !== event.executionId
      || (execution.status !== "running" && execution.status !== "suspended")) {
      return execution;
    }

    const { status: _status, ...record } = execution;
    let runs = execution.runs;
    let durationMs = execution.durationMs;
    if (execution.status === "running") {
      const run = execution.runs.at(-1)!;
      const runDurationMs = Math.max(0, event.runEndedAt! - run.startedAt);
      durationMs += runDurationMs;
      runs = [
        ...execution.runs.slice(0, -1),
        {
          ...run,
          endedAt: event.runEndedAt!,
          durationMs: runDurationMs,
          usageDelta: event.runUsageDelta!,
          settlement: event.runSettlement!,
        },
      ];
    }

    const { suspension: _suspension, ...terminalBase } = record;
    return {
      ...terminalBase,
      status: event.terminalStatus,
      durationMs,
      runs,
      endedAt: event.endedAt,
      ...(event.finalOutputStepId === undefined ? {} : { finalOutputStepId: event.finalOutputStepId }),
      ...(event.error === undefined ? {} : { error: event.error }),
      terminalSettlement: event.terminalSettlement,
    };
  });
}

function resumeExecution(
  execution: Extract<SessionExecutionRecord, { status: "suspended" }>,
  runOrdinal: number,
  binding: Extract<ExecutionLifecycleEvent, { type: "execution-resumed" }>["binding"],
  startedAt: number,
): SessionExecutionRecord {
  const { status: _status, suspension: _suspension, ...record } = execution;
  return {
    ...record,
    status: "running",
    runs: [
      ...execution.runs,
      {
        ordinal: runOrdinal,
        startedAt,
        binding,
      },
    ],
  };
}

function currentRunOrdinal(state: SessionProjection): number | undefined {
  if (state.currentExecutionId === undefined) return undefined;
  return state.executions.find((execution) => execution.id === state.currentExecutionId)?.runs.at(-1)?.ordinal;
}

function currentMessageExecution(
  state: SessionProjection,
): Pick<SessionMessage, "executionId" | "runOrdinal"> | Record<string, never> {
  const executionId = state.currentExecutionId;
  const runOrdinal = currentRunOrdinal(state);
  return executionId === undefined || runOrdinal === undefined
    ? {}
    : { executionId, runOrdinal };
}

function settleIncompleteState(
  messages: SessionMessage[],
  currentAssistantMessageId: string | undefined,
  timestamp: number,
  executionStatus: ExecutionEndEvent["terminalStatus"],
): SessionMessage[] {
  const shouldDiscardPartialModelOutput = executionStatus !== "completed";
  const settledMessages = messages.map((message) => {
    if (message.role !== "assistant") return message;
    const parts: AssistantSessionPart[] = message.parts.map((part): AssistantSessionPart => {
      if (part.type === "assistant-output" && part.completedAt === undefined) {
        return shouldDiscardPartialModelOutput
          ? {
              ...part,
              completedAt: timestamp,
              meta: { ...(part.meta ?? {}), interrupted: true, discardedFromContext: true },
            }
          : { ...part, completedAt: timestamp };
      }

      if (part.type === "reasoning" && part.completedAt === undefined) {
        return shouldDiscardPartialModelOutput
          ? {
              ...part,
              completedAt: timestamp,
              meta: { ...(part.meta ?? {}), interrupted: true, discardedFromContext: true },
            }
          : { ...part, completedAt: timestamp };
      }

      if (part.type === "system-notice" && part.completedAt === undefined) {
        return { ...part, completedAt: timestamp };
      }

      if (part.type === "recovery-notice" && part.completedAt === undefined) {
        return { ...part, completedAt: timestamp };
      }

      return part;
    });

    const hasIncompletePart = parts.some((part) => isIncompletePart(part));
    const shouldCompleteMessage =
      message.completedAt === undefined &&
      (hasIncompletePart || message.id === currentAssistantMessageId);

    if (parts === message.parts && !shouldCompleteMessage) {
      return message;
    }

    return {
      ...message,
      parts,
      ...(shouldCompleteMessage ? { completedAt: timestamp } : {}),
    };
  });

  return interruptIncompleteToolParts(settledMessages, timestamp);
}

/**
 * Projects incomplete Tool Parts into their non-final interrupted state.
 * This is intentionally independent of events, results, persistence, and stats.
 */
export function interruptIncompleteToolParts(
  messages: SessionMessage[],
  endedAt: number,
): SessionMessage[] {
  let messagesChanged = false;
  const nextMessages = messages.map((message) => {
    if (message.role !== "assistant") return message;
    let partsChanged = false;
    const parts = message.parts.map((part): AssistantSessionPart => {
      if (part.type !== "tool" || (part.state !== "pending" && part.state !== "running")) {
        return part;
      }
      partsChanged = true;
      return toInterruptedToolPart(part, endedAt);
    });

    if (!partsChanged) return message;
    messagesChanged = true;
    return { ...message, parts };
  });

  return messagesChanged ? nextMessages : messages;
}

function markAssistantModelOutputInterruptedForStep(
  messages: SessionMessage[],
  stepId: string,
  timestamp: number,
): SessionMessage[] {
  let changed = false;
  const nextMessages = messages.map((message) => {
    if (message.role !== "assistant" || message.stepId !== stepId) return message;

    const parts = message.parts.map((part): AssistantSessionPart => {
      if ((part.type !== "assistant-output" && part.type !== "reasoning") || part.text.length === 0) {
        return part;
      }

      if (part.meta?.interrupted === true && part.meta?.discardedFromContext === true && part.completedAt !== undefined) {
        return part;
      }

      changed = true;
      return {
        ...part,
        completedAt: part.completedAt ?? timestamp,
        meta: { ...(part.meta ?? {}), interrupted: true, discardedFromContext: true },
      };
    });

    return parts === message.parts ? message : { ...message, parts };
  });

  return changed ? nextMessages : messages;
}

function isActiveOpenStep(state: SessionProjection, stepId: string): boolean {
  const executionId = state.currentExecutionId;
  const runOrdinal = currentRunOrdinal(state);
  return executionId !== undefined
    && runOrdinal !== undefined
    && state.steps.some((step) =>
      step.id === stepId
      && step.executionId === executionId
      && step.runOrdinal === runOrdinal
      && step.completedAt === undefined
    );
}

function isIncompletePart(part: SessionPart): boolean {
  if (part.type === "assistant-output" || part.type === "reasoning" || part.type === "system-notice" || part.type === "recovery-notice") {
    return part.completedAt === undefined;
  }

  return part.type === "tool" && (part.state === "pending" || part.state === "running");
}

function ensureCurrentAssistantMessage(
  state: SessionProjection,
  _timestamp: number,
  _ctx: ReduceContext,
): AssistantMessageResult {
  if (state.currentAssistantMessageId) {
    const existing = state.messages.find((message): message is Extract<SessionMessage, { role: "assistant" }> =>
      message.id === state.currentAssistantMessageId && message.role === "assistant"
    );
    if (existing === undefined) throw new Error("Current Assistant message is not a model-step message");
    return {
      messages: state.messages,
      currentAssistantMessageId: state.currentAssistantMessageId,
      ...(!assistantMessageHasContent(existing)
        ? { stats: incrementAssistantMessages(state.stats ?? createEmptySessionStats()) }
        : {}),
    };
  }
  throw new Error("Assistant event requires a current model-step message");
}

function assistantForRecoveryEvent(
  state: SessionProjection,
  event: { stepId?: string },
): RecoveryAssistantResult | undefined {
  const messageId = event.stepId === undefined
    ? state.currentAssistantMessageId
    : modelStepMessageId(state.messages, event.stepId);
  if (messageId === undefined) return undefined;
  const message = state.messages.find((candidate): candidate is Extract<SessionMessage, { role: "assistant" }> =>
    candidate.id === messageId && candidate.role === "assistant"
  );
  if (message === undefined) return undefined;
  return {
    messages: state.messages,
    assistantMessageId: messageId,
    ...(!assistantMessageHasContent(message)
      ? { stats: incrementAssistantMessages(state.stats ?? createEmptySessionStats()) }
      : {}),
  };
}

function updateMessagePart(
  messages: SessionMessage[],
  messageId: string,
  partId: string,
  update: (part: AssistantSessionPart) => AssistantSessionPart,
): SessionMessage[] {
  return messages.map((message) => {
    if (message.id !== messageId || message.role !== "assistant") return message;

    return {
      ...message,
      parts: message.parts.map((part) => (part.id === partId ? update(part) : part)),
    };
  });
}

function removeMessagePart(
  messages: SessionMessage[],
  messageId: string,
  partId: string,
): SessionMessage[] {
  return messages.map((message) =>
    message.id === messageId && message.role === "assistant"
      ? { ...message, parts: message.parts.filter((part) => part.id !== partId) }
      : message
  );
}

function appendPartToMessage(
  messages: SessionMessage[],
  messageId: string,
  part: AssistantSessionPart,
): SessionMessage[] {
  return messages.map((message) =>
    message.id === messageId && message.role === "assistant"
      ? { ...message, parts: [...message.parts, part] }
      : message,
  );
}

function modelStepMessageId(
  messages: SessionMessage[],
  stepId: string,
): string | undefined {
  return messages.find((message) => message.role === "assistant" && message.stepId === stepId)?.id;
}

function findBlockLocation(
  messages: SessionMessage[],
  stepId: string,
  partType: "assistant-output" | "reasoning",
  blockId: string,
): PartLocation | undefined {
  const message = messages.find((item) => item.role === "assistant" && item.stepId === stepId);
  const part = message?.parts.find((item) => item.type === partType && item.blockId === blockId);
  return message && part ? { messageId: message.id, partId: part.id } : undefined;
}

function getPartAtLocation(messages: SessionMessage[], location: PartLocation): SessionPart | undefined {
  return messages.find((message) => message.id === location.messageId)
    ?.parts.find((part) => part.id === location.partId);
}

function firstAssistantContentStats(state: SessionProjection, messageId: string): SessionStats | undefined {
  const message = state.messages.find((candidate) => candidate.id === messageId);
  return message?.role === "assistant" && !assistantMessageHasContent(message)
    ? incrementAssistantMessages(state.stats)
    : undefined;
}

function assistantMessageHasContent(
  message: Extract<SessionMessage, { role: "assistant" }>,
): boolean {
  return message.parts.some((part) =>
    part.type === "assistant-output" || part.type === "reasoning"
      ? part.text.length > 0
      : true
  );
}

function findCurrentToolPartByCallId(
  messages: SessionMessage[],
  messageId: string | undefined,
  toolCallId: string,
): PartLocation | undefined {
  if (!messageId) return undefined;
  const message = messages.find((item) => item.id === messageId);
  const part = message?.parts.find((item) => item.type === "tool" && item.toolCallId === toolCallId);
  return part ? { messageId, partId: part.id } : undefined;
}

function findLatestIncompleteToolPartByCallId(
  messages: SessionMessage[],
  toolCallId: string,
): PartLocation | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const part = message.parts.find((item) => (
      item.type === "tool"
      && item.toolCallId === toolCallId
      && item.state !== "completed"
      && item.state !== "error"
    ));
    if (part) return { messageId: message.id, partId: part.id };
  }

  return undefined;
}

function getToolPartAtLocation(
  messages: SessionMessage[],
  messageId: string,
  partId: string,
): ToolPart | undefined {
  const message = messages.find((item) => item.id === messageId);
  const part = message?.parts.find((item) => item.id === partId);
  return part?.type === "tool" ? part : undefined;
}

function appendAssistantOutputPart(
  messages: SessionMessage[],
  messageId: string,
  blockId: string,
  timestamp: number,
  text: string,
  ctx: ReduceContext,
  stats?: SessionStats,
): Partial<SessionProjection> {
  const part: AssistantOutputPart = {
    type: "assistant-output",
    id: ctx.generateId(),
    blockId,
    text,
    createdAt: timestamp,
  };

  return {
    messages: appendPartToMessage(messages, messageId, part),
    currentAssistantMessageId: messageId,
    ...(stats ? { stats } : {}),
  };
}

function appendReasoningPart(
  messages: SessionMessage[],
  messageId: string,
  blockId: string,
  timestamp: number,
  text: string,
  ctx: ReduceContext,
  stats?: SessionStats,
): Partial<SessionProjection> {
  const part: ReasoningPart = {
    type: "reasoning",
    id: ctx.generateId(),
    blockId,
    text,
    createdAt: timestamp,
  };

  return {
    messages: appendPartToMessage(messages, messageId, part),
    currentAssistantMessageId: messageId,
    ...(stats ? { stats } : {}),
  };
}

function upsertRecoveryNoticePart(
  messages: SessionMessage[],
  messageId: string,
  nextPart: RecoveryNoticePart,
  stats?: SessionStats,
): Partial<SessionProjection> {
  let found = false;
  const updatedMessages = messages.map((message) => {
    if (message.id !== messageId || message.role !== "assistant") return message;

    const parts = message.parts.map((part) => {
      if (part.type !== "recovery-notice" || part.id !== nextPart.id) return part;
      found = true;
      const { nextRetryAt: _oldNextRetryAt, completedAt: _oldCompletedAt, errorKind: oldErrorKind, statusCode: oldStatusCode, ...basePart } = part;
      const errorKind = nextPart.errorKind ?? oldErrorKind;
      const statusCode = nextPart.statusCode ?? oldStatusCode;
      return {
        ...basePart,
        status: nextPart.status,
        message: nextPart.message,
        attempt: nextPart.attempt,
        ...(nextPart.nextRetryAt === undefined ? {} : { nextRetryAt: nextPart.nextRetryAt }),
        ...(errorKind === undefined ? {} : { errorKind }),
        ...(statusCode === undefined ? {} : { statusCode }),
        ...(nextPart.completedAt === undefined ? {} : { completedAt: nextPart.completedAt }),
      } satisfies RecoveryNoticePart;
    });

    return { ...message, parts };
  });

  return {
    messages: found ? updatedMessages : appendPartToMessage(messages, messageId, nextPart),
    ...(stats ? { stats } : {}),
  };
}

function recoveryNoticeId(
  event: { stepId?: string; messageId?: string; toolCallId?: string; scope: string },
  ctx: ReduceContext,
): string {
  const relatedId = event.toolCallId ?? event.messageId ?? event.stepId;
  return relatedId === undefined ? ctx.generateId() : `recovery:${event.scope}:${relatedId}`;
}

function toRunningToolPart(
  part: ToolPart,
  input: unknown,
  timestamp: number,
): RunningToolPart {
  return {
    type: "tool",
    id: part.id,
    state: "running",
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    input: input === undefined ? null : input,
    createdAt: part.createdAt,
    startedAt: "startedAt" in part && part.startedAt !== undefined ? part.startedAt : timestamp,
    ...(part.state === "running" && part.liveOutput !== undefined
      ? { liveOutput: part.liveOutput }
      : {}),
    ...(part.attemptId !== undefined ? { attemptId: part.attemptId } : {}),
    ...(part.attemptTimestamp !== undefined ? { attemptTimestamp: part.attemptTimestamp } : {}),
    ...(part.attemptDestructive !== undefined ? { attemptDestructive: part.attemptDestructive } : {}),
  };
}

function appendLiveToolOutput(
  part: RunningToolPart,
  event: Extract<StreamEvent, { type: "tool-output-delta" }>,
): RunningToolPart {
  const existing = part.liveOutput;
  const combined = `${existing?.preview ?? ""}${event.delta}`;
  const suffix = utf8Suffix(combined, LIVE_TOOL_OUTPUT_PREVIEW_MAX_BYTES);

  return {
    ...part,
    liveOutput: {
      preview: suffix.value,
      omittedBytes: (existing?.omittedBytes ?? 0) + event.omittedBytes + suffix.omittedBytes,
      liveLimitReached: (existing?.liveLimitReached ?? false) || event.liveLimitReached,
    },
  };
}

function toInterruptedToolPart(
  part: Extract<ToolPart, { state: "pending" | "running" }>,
  timestamp: number,
): Extract<ToolPart, { state: "interrupted" }> {
  return {
    type: "tool",
    id: part.id,
    state: "interrupted",
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    ...("input" in part ? { input: part.input } : {}),
    createdAt: part.createdAt,
    ...("startedAt" in part ? { startedAt: part.startedAt } : {}),
    endedAt: timestamp,
    ...(part.attemptId !== undefined ? { attemptId: part.attemptId } : {}),
    ...(part.attemptTimestamp !== undefined ? { attemptTimestamp: part.attemptTimestamp } : {}),
    ...(part.attemptDestructive !== undefined ? { attemptDestructive: part.attemptDestructive } : {}),
  };
}

function withToolAttempt(
  part: ToolPart,
  event: Extract<StreamEvent, { type: "tool-attempt" }>,
): ToolPart {
  const attemptedPart = part.state === "interrupted"
    ? toRunningToolPart(part, part.input, event.timestamp)
    : part;

  return {
    ...attemptedPart,
    attemptId: event.attemptId,
    attemptTimestamp: event.timestamp,
    attemptDestructive: event.destructive,
  };
}

function toSettledToolPart(
  part: ToolPart,
  result: FinalizedToolResult,
  timestamp: number,
): CompletedToolPart | ErrorToolPart {
  const runningPart = toRunningToolPart(part, "input" in part ? part.input : undefined, timestamp);
  const { liveOutput: _liveOutput, ...settledPart } = runningPart;

  if (result.isError) {
    return {
      ...settledPart,
      state: "error",
      result,
      endedAt: timestamp,
    };
  }

  return {
    ...settledPart,
    state: "completed",
    result,
    endedAt: timestamp,
  };
}

function utf8Suffix(value: string, maxBytes: number): { value: string; omittedBytes: number } {
  const totalBytes = UTF8_ENCODER.encode(value).byteLength;
  if (totalBytes <= maxBytes) {
    return { value, omittedBytes: 0 };
  }

  let retainedBytes = 0;
  let start = value.length;
  while (start > 0) {
    let codePointStart = start - 1;
    const codeUnit = value.charCodeAt(codePointStart);
    if (
      codeUnit >= 0xdc00
      && codeUnit <= 0xdfff
      && codePointStart > 0
    ) {
      const preceding = value.charCodeAt(codePointStart - 1);
      if (preceding >= 0xd800 && preceding <= 0xdbff) {
        codePointStart -= 1;
      }
    }

    const codePointBytes = UTF8_ENCODER.encode(value.slice(codePointStart, start)).byteLength;
    if (retainedBytes + codePointBytes > maxBytes) break;
    retainedBytes += codePointBytes;
    start = codePointStart;
  }

  return {
    value: value.slice(start),
    omittedBytes: totalBytes - retainedBytes,
  };
}
