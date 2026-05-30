import type {
  CompactionPart,
  CompletedToolPart,
  ErrorToolPart,
  ReasoningPart,
  RunningToolPart,
  SessionMessage,
  SessionPart,
  SessionProjection,
  SessionStats,
  SessionTodo,
  StreamEvent,
  SystemNoticePart,
  TextPart,
  ToolInputResolvedEvent,
  ToolPart,
  RunEndEvent,
} from "./types";
import { addUsage, createEmptySessionStats, normalizeUsage } from "./usage";

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

interface PartLocation {
  messageId: string;
  partId: string;
}

export interface ReduceContext {
  timestamp: number;
  generateId: () => string;
}

export function reduceStreamEvent(
  state: SessionProjection,
  event: StreamEvent,
  ctx: ReduceContext,
): Partial<SessionProjection> {
  const timestamp = ctx.timestamp;

  switch (event.type) {
    case "run-start": {
      const runId = event.runId ?? ctx.generateId();
      const runs = [
        ...(state.runs ?? []),
        { id: runId, startedAt: timestamp, status: "running" as const },
      ];

      return {
        isRunning: true,
        currentRunId: runId,
        currentAssistantMessageId: undefined,
        isStreamingModel: false,
        runs,
        runCount: runs.length,
      };
    }

    case "run-end": {
      const settledToolFailures = countRunningTools(state.messages, state.currentAssistantMessageId);
      const stats = incrementToolFailures(state.stats, settledToolFailures);
      const runs = settleCurrentRun(state.runs ?? [], state.currentRunId, event, timestamp);

      return {
        messages: settleIncompleteState(state.messages, state.currentAssistantMessageId, timestamp),
        stats,
        runs,
        runCount: runs.length,
        isRunning: false,
        isStreamingModel: false,
        currentRunId: undefined,
        currentAssistantMessageId: undefined,
      };
    }

    case "user-message": {
      const part: TextPart = {
        type: "text",
        id: ctx.generateId(),
        text: event.content,
        createdAt: timestamp,
        completedAt: timestamp,
      };
      const message: SessionMessage = {
        id: ctx.generateId(),
        role: "user",
        parts: [part],
        createdAt: timestamp,
        completedAt: timestamp,
        runId: state.currentRunId,
      };

      return { messages: [...state.messages, message], stats: incrementUserMessages(state.stats) };
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
        runId: state.currentRunId,
      };

      return { messages: [...state.messages, message] };
    }

    case "text-start": {
      const assistant = ensureCurrentAssistantMessage(state, timestamp, ctx);
      const messages = finalizeLastIncompletePartOfType(
        assistant.messages,
        assistant.currentAssistantMessageId,
        "text",
        timestamp,
      );

      return appendTextPart(messages, assistant.currentAssistantMessageId, timestamp, "", ctx, assistant.stats);
    }

    case "text-delta": {
      const assistant = ensureCurrentAssistantMessage(state, timestamp, ctx);
      const location = findLatestIncompletePartLocation(
        assistant.messages,
        assistant.currentAssistantMessageId,
        "text",
      );

      if (location) {
        return {
          messages: updateMessagePart(
            assistant.messages,
            location.messageId,
            location.partId,
            (part) =>
              part.type === "text"
                ? { ...part, text: `${part.text}${event.text}` }
                : part,
          ),
          currentAssistantMessageId: assistant.currentAssistantMessageId,
          ...(assistant.stats ? { stats: assistant.stats } : {}),
        };
      }

      return appendTextPart(
        assistant.messages,
        assistant.currentAssistantMessageId,
        timestamp,
        event.text,
        ctx,
        assistant.stats,
      );
    }

    case "text-end": {
      const location = findLatestIncompletePartLocation(
        state.messages,
        state.currentAssistantMessageId,
        "text",
      );

      if (!location) return {};

      return {
        messages: updateMessagePart(
          state.messages,
          location.messageId,
          location.partId,
          (part) => (part.type === "text" ? { ...part, completedAt: timestamp } : part),
        ),
      };
    }

    case "reasoning-start": {
      const assistant = ensureCurrentAssistantMessage(state, timestamp, ctx);
      const messages = finalizeLastIncompletePartOfType(
        assistant.messages,
        assistant.currentAssistantMessageId,
        "reasoning",
        timestamp,
      );

      return appendReasoningPart(messages, assistant.currentAssistantMessageId, timestamp, "", ctx, assistant.stats);
    }

    case "reasoning-delta": {
      const assistant = ensureCurrentAssistantMessage(state, timestamp, ctx);
      const location = findLatestIncompletePartLocation(
        assistant.messages,
        assistant.currentAssistantMessageId,
        "reasoning",
      );

      if (location) {
        return {
          messages: updateMessagePart(
            assistant.messages,
            location.messageId,
            location.partId,
            (part) =>
              part.type === "reasoning"
                ? { ...part, text: `${part.text}${event.text}` }
                : part,
          ),
          currentAssistantMessageId: assistant.currentAssistantMessageId,
          ...(assistant.stats ? { stats: assistant.stats } : {}),
        };
      }

      return appendReasoningPart(
        assistant.messages,
        assistant.currentAssistantMessageId,
        timestamp,
        event.text,
        ctx,
        assistant.stats,
      );
    }

    case "reasoning-end": {
      const location = findLatestIncompletePartLocation(
        state.messages,
        state.currentAssistantMessageId,
        "reasoning",
      );

      if (!location) return {};

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
      const existing = findToolPartByCallId(
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
      const location = findToolPartByCallId(
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
        input: event.input,
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
      const location = findToolPartByCallId(
        state.messages,
        state.currentAssistantMessageId,
        event.toolCallId,
      );

      if (!location) return {};

      const existing = getToolPartAtLocation(state.messages, location.messageId, location.partId);
      if (!existing || existing.state === "pending") return {};

      return {
        messages: updateMessagePart(
          state.messages,
          location.messageId,
          location.partId,
          (part) => (part.type === "tool" ? { ...part, input: event.input } : part),
        ),
      };
    }

    case "tool-result": {
      const location = findToolPartByCallId(
        state.messages,
        state.currentAssistantMessageId,
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
              ? toSettledToolPart(part, event.output, event.isError, timestamp, event.meta)
              : part,
        ),
        stats: event.isError ? incrementToolFailures(state.stats, 1) : incrementToolCompleted(state.stats),
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
      const resetAssistantMessage = event.step > 0 ? undefined : state.currentAssistantMessageId;

      return {
        isStreamingModel: true,
        currentAssistantMessageId: resetAssistantMessage,
        steps: [
          ...state.steps,
          {
            id: ctx.generateId(),
            step: event.step,
            runId: state.currentRunId,
            startedAt: timestamp,
          },
        ],
        stats: incrementStepStarted(state.stats),
      };
    }

    case "step-end": {
      const usage = normalizeUsage(event.usage);
      const hasOpenStep = state.steps.some(
        (step) => step.step === event.step && step.runId === state.currentRunId && !step.completedAt,
      );
      return {
        isStreamingModel: false,
        steps: state.steps.map((step) =>
          step.step === event.step && step.runId === state.currentRunId && !step.completedAt
            ? {
                ...step,
                completedAt: timestamp,
                finishReason: event.finishReason,
                usage: event.usage,
              }
            : step,
        ),
        ...(hasOpenStep ? { stats: incrementStepCompleted(state.stats, usage) } : {}),
      };
    }

    case "loop-error": {
      const matchingStep =
        event.step !== undefined
          ? state.steps.find(
              (step) => step.step === event.step && step.runId === state.currentRunId,
            )
          : undefined;

      if (matchingStep) {
        return {
          steps: state.steps.map((step) =>
            step.id === matchingStep.id ? { ...step, error: event.error } : step,
          ),
        };
      }

      return {
        steps: [
          ...state.steps,
          {
            id: ctx.generateId(),
            step: event.step ?? state.steps.length,
            runId: state.currentRunId,
            startedAt: timestamp,
            error: event.error,
          },
        ],
      };
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
        const updatedParts: SessionPart[] = existingMessage.parts.map((part) => {
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
        };
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

      return { messages };
    }
  }
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
  return {
    ...stats,
    messages: {
      user: stats.messages.user + 1,
      assistant: stats.messages.assistant,
      total: stats.messages.total + 1,
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

function settleCurrentRun(
  runs: SessionProjection["runs"],
  currentRunId: string | undefined,
  event: RunEndEvent,
  timestamp: number,
): SessionProjection["runs"] {
  if (!currentRunId) return runs;

  let changed = false;
  const updated = runs.map((run) => {
    if (run.id !== currentRunId || run.status !== "running") return run;
    changed = true;
    return {
      ...run,
      status: event.status,
      endedAt: timestamp,
      durationMs: timestamp - run.startedAt,
      ...(event.error ? { error: event.error } : {}),
    };
  });

  return changed ? updated : runs;
}

function countRunningTools(
  messages: SessionMessage[],
  currentAssistantMessageId: string | undefined,
): number {
  if (!currentAssistantMessageId) return 0;

  const message = messages.find((item) => item.id === currentAssistantMessageId);
  if (!message) return 0;

  return message.parts.filter((part) => part.type === "tool" && part.state === "running").length;
}

function settleIncompleteState(
  messages: SessionMessage[],
  currentAssistantMessageId: string | undefined,
  timestamp: number,
): SessionMessage[] {
  return messages.map((message) => {
    const parts: SessionPart[] = message.parts.map((part): SessionPart => {
      if (part.type === "text" && part.completedAt === undefined) {
        return { ...part, completedAt: timestamp };
      }

      if (part.type === "reasoning" && part.completedAt === undefined) {
        return { ...part, completedAt: timestamp };
      }

      if (part.type === "system-notice" && part.completedAt === undefined) {
        return { ...part, completedAt: timestamp };
      }

      if (part.type === "tool" && (part.state === "pending" || part.state === "running")) {
        const errorPart: ErrorToolPart = {
          ...toRunningToolPart(part, "input" in part ? part.input : undefined, timestamp),
          state: "error",
          errorMessage: "Run ended before tool result",
          endedAt: timestamp,
        };

        return errorPart;
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
}

function isIncompletePart(part: SessionPart): boolean {
  if (part.type === "text" || part.type === "reasoning" || part.type === "system-notice") {
    return part.completedAt === undefined;
  }

  return part.type === "tool" && (part.state === "pending" || part.state === "running");
}

function ensureCurrentAssistantMessage(
  state: SessionProjection,
  timestamp: number,
  ctx: ReduceContext,
): AssistantMessageResult {
  if (state.currentAssistantMessageId) {
    return {
      messages: state.messages,
      currentAssistantMessageId: state.currentAssistantMessageId,
    };
  }

  const message: SessionMessage = {
    id: ctx.generateId(),
    role: "assistant",
    parts: [],
    createdAt: timestamp,
    runId: state.currentRunId,
  };

  return {
    messages: [...state.messages, message],
    currentAssistantMessageId: message.id,
    stats: incrementAssistantMessages(state.stats ?? createEmptySessionStats()),
  };
}

function updateMessagePart(
  messages: SessionMessage[],
  messageId: string,
  partId: string,
  update: (part: SessionPart) => SessionPart,
): SessionMessage[] {
  return messages.map((message) => {
    if (message.id !== messageId) return message;

    return {
      ...message,
      parts: message.parts.map((part) => (part.id === partId ? update(part) : part)),
    };
  });
}

function appendPartToMessage(
  messages: SessionMessage[],
  messageId: string,
  part: SessionPart,
): SessionMessage[] {
  return messages.map((message) =>
    message.id === messageId ? { ...message, parts: [...message.parts, part] } : message,
  );
}

function finalizeLastIncompletePartOfType(
  messages: SessionMessage[],
  messageId: string,
  partType: "text" | "reasoning",
  timestamp: number,
): SessionMessage[] {
  const location = findLatestIncompletePartLocation(messages, messageId, partType);
  if (!location) return messages;

  return updateMessagePart(messages, location.messageId, location.partId, (part) => {
    if (part.type !== partType) return part;
    return { ...part, completedAt: timestamp };
  });
}

function findLatestIncompletePartLocation(
  messages: SessionMessage[],
  messageId: string | undefined,
  partType: "text" | "reasoning",
): PartLocation | undefined {
  if (!messageId) return undefined;

  const message = messages.find((item) => item.id === messageId);
  if (!message) return undefined;

  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (!part || part.type !== partType || part.completedAt !== undefined) continue;
    return { messageId, partId: part.id };
  }

  return undefined;
}

function findToolPartByCallId(
  messages: SessionMessage[],
  messageId: string | undefined,
  toolCallId: string,
): PartLocation | undefined {
  if (!messageId) return undefined;

  const message = messages.find((item) => item.id === messageId);
  const part = message?.parts.find((item) => item.type === "tool" && item.toolCallId === toolCallId);

  return part ? { messageId, partId: part.id } : undefined;
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

function appendTextPart(
  messages: SessionMessage[],
  messageId: string,
  timestamp: number,
  text: string,
  ctx: ReduceContext,
  stats?: SessionStats,
): Partial<SessionProjection> {
  const part: TextPart = {
    type: "text",
    id: ctx.generateId(),
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
  timestamp: number,
  text: string,
  ctx: ReduceContext,
  stats?: SessionStats,
): Partial<SessionProjection> {
  const part: ReasoningPart = {
    type: "reasoning",
    id: ctx.generateId(),
    text,
    createdAt: timestamp,
  };

  return {
    messages: appendPartToMessage(messages, messageId, part),
    currentAssistantMessageId: messageId,
    ...(stats ? { stats } : {}),
  };
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
    input,
    createdAt: part.createdAt,
    startedAt: "startedAt" in part ? part.startedAt : timestamp,
  };
}

function toSettledToolPart(
  part: ToolPart,
  output: string,
  isError: boolean,
  timestamp: number,
  meta?: Record<string, unknown>,
): CompletedToolPart | ErrorToolPart {
  const runningPart = toRunningToolPart(part, "input" in part ? part.input : undefined, timestamp);

  if (isError) {
    return {
      ...runningPart,
      state: "error",
      errorMessage: output,
      endedAt: timestamp,
      ...(meta ? { meta } : {}),
    };
  }

  return {
    ...runningPart,
    state: "completed",
    output,
    endedAt: timestamp,
    ...(meta ? { meta } : {}),
  };
}
