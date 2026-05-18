import {
  BusyError,
  InvalidTodoStateError,
  type CompactionPart,
  type CompletedToolPart,
  type ErrorToolPart,
  type ReasoningPart,
  type RunningToolPart,
  type SessionStoreState,
  type StoredMessage,
  type StoredPart,
  type StoredTodo,
  type StreamEvent,
  type SystemNoticePart,
  type TextPart,
  type ToolPart,
} from "./types";

const TODO_STATUSES = new Set<StoredTodo["status"]>([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

interface AssistantMessageResult {
  messages: StoredMessage[];
  currentAssistantMessageId: string;
}

interface ToolPartLocation {
  messageId: string;
  partId: string;
}

export function reduceStreamEvent(
  state: SessionStoreState,
  event: StreamEvent,
): Partial<SessionStoreState> {
  const timestamp = Date.now();

  switch (event.type) {
    case "run-start": {
      if (state.isRunning) throw new BusyError(state.sessionId);

      return {
        isRunning: true,
        currentRunId: event.runId ?? crypto.randomUUID(),
        currentAssistantMessageId: undefined,
        isStreamingModel: false,
        streamingText: undefined,
        streamingReasoning: undefined,
        streamingTools: {},
        runCount: state.runCount + 1,
      };
    }

    case "run-end": {
      const messages = settleIncompleteState(state, timestamp);

      return {
        messages,
        isRunning: false,
        isStreamingModel: false,
        currentRunId: undefined,
        currentAssistantMessageId: undefined,
        streamingText: undefined,
        streamingReasoning: undefined,
        streamingTools: {},
      };
    }

    case "user-message": {
      const part: TextPart = {
        type: "text",
        id: crypto.randomUUID(),
        text: event.content,
        createdAt: timestamp,
        completedAt: timestamp,
      };
      const message: StoredMessage = {
        id: crypto.randomUUID(),
        role: "user",
        parts: [part],
        createdAt: timestamp,
        completedAt: timestamp,
        runId: state.currentRunId,
      };

      return { messages: [...state.messages, message] };
    }

    case "system-notice": {
      const part: SystemNoticePart = {
        type: "system-notice",
        id: crypto.randomUUID(),
        notice: event.message,
        createdAt: timestamp,
        completedAt: timestamp,
      };
      const message: StoredMessage = {
        id: crypto.randomUUID(),
        role: "user",
        parts: [part],
        createdAt: timestamp,
        completedAt: timestamp,
        runId: state.currentRunId,
      };

      return { messages: [...state.messages, message] };
    }

    case "text-start": {
      if (state.streamingText) {
        const flushedMessages = updateMessagePart(
          state.messages,
          state.streamingText.messageId,
          state.streamingText.partId,
          (part) =>
            part.type === "text"
              ? { ...part, text: state.streamingText!.text, completedAt: timestamp }
              : part,
        );

        const flushedState = {
          ...state,
          messages: flushedMessages,
          streamingText: undefined,
        };
        const assistant = ensureCurrentAssistantMessage(flushedState, timestamp);
        return startTextStreaming(assistant, timestamp);
      }

      const assistant = ensureCurrentAssistantMessage(state, timestamp);
      return startTextStreaming(assistant, timestamp);
    }

    case "text-delta": {
      if (state.streamingText) {
        return {
          streamingText: {
            ...state.streamingText,
            text: `${state.streamingText.text}${event.text}`,
          },
        };
      }

      const assistant = ensureCurrentAssistantMessage(state, timestamp);
      const started = startTextStreaming(assistant, timestamp);
      return {
        ...started,
        streamingText: {
          ...started.streamingText,
          text: event.text,
        },
      };
    }

    case "text-end": {
      if (!state.streamingText) return {};

      return {
        messages: updateMessagePart(
          state.messages,
          state.streamingText.messageId,
          state.streamingText.partId,
          (part) =>
            part.type === "text"
              ? { ...part, text: state.streamingText!.text, completedAt: timestamp }
              : part,
        ),
        streamingText: undefined,
      };
    }

    case "reasoning-start": {
      if (state.streamingReasoning) {
        const flushedMessages = updateMessagePart(
          state.messages,
          state.streamingReasoning.messageId,
          state.streamingReasoning.partId,
          (part) =>
            part.type === "reasoning"
              ? {
                  ...part,
                  text: state.streamingReasoning!.text,
                  completedAt: timestamp,
                }
              : part,
        );

        const flushedState = {
          ...state,
          messages: flushedMessages,
          streamingReasoning: undefined,
        };
        const assistant = ensureCurrentAssistantMessage(flushedState, timestamp);
        return startReasoningStreaming(assistant, timestamp);
      }

      const assistant = ensureCurrentAssistantMessage(state, timestamp);
      return startReasoningStreaming(assistant, timestamp);
    }

    case "reasoning-delta": {
      if (state.streamingReasoning) {
        return {
          streamingReasoning: {
            ...state.streamingReasoning,
            text: `${state.streamingReasoning.text}${event.text}`,
          },
        };
      }

      const assistant = ensureCurrentAssistantMessage(state, timestamp);
      const started = startReasoningStreaming(assistant, timestamp);
      return {
        ...started,
        streamingReasoning: {
          ...started.streamingReasoning,
          text: event.text,
        },
      };
    }

    case "reasoning-end": {
      if (!state.streamingReasoning) return {};

      return {
        messages: updateMessagePart(
          state.messages,
          state.streamingReasoning.messageId,
          state.streamingReasoning.partId,
          (part) =>
            part.type === "reasoning"
              ? {
                  ...part,
                  text: state.streamingReasoning!.text,
                  completedAt: timestamp,
                }
              : part,
        ),
        streamingReasoning: undefined,
      };
    }

    case "tool-input-start": {
      if (state.streamingTools[event.toolCallId]) return {};

      const assistant = ensureCurrentAssistantMessage(state, timestamp);
      const part: ToolPart = {
        type: "tool",
        id: crypto.randomUUID(),
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
        streamingTools: {
          ...state.streamingTools,
          [event.toolCallId]: {
            messageId: assistant.currentAssistantMessageId,
            partId: part.id,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          },
        },
      };
    }

    case "tool-call": {
      const streamingTool = state.streamingTools[event.toolCallId];

      if (streamingTool) {
        return {
          messages: updateMessagePart(
            state.messages,
            streamingTool.messageId,
            streamingTool.partId,
            (part) =>
              part.type === "tool"
                ? toRunningToolPart(part, event.input, timestamp)
                : part,
          ),
          streamingTools: {
            ...state.streamingTools,
            [event.toolCallId]: {
              ...streamingTool,
              input: event.input,
            },
          },
        };
      }

      const assistant = ensureCurrentAssistantMessage(state, timestamp);
      const part: RunningToolPart = {
        type: "tool",
        id: crypto.randomUUID(),
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
        streamingTools: {
          ...state.streamingTools,
          [event.toolCallId]: {
            messageId: assistant.currentAssistantMessageId,
            partId: part.id,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.input,
          },
        },
      };
    }

    case "tool-result": {
      const location =
        state.streamingTools[event.toolCallId] ??
        findToolPartByCallId(
          state.messages,
          state.currentAssistantMessageId,
          event.toolCallId,
        );

      if (!location) return {};

      const { [event.toolCallId]: _removedTool, ...streamingTools } =
        state.streamingTools;

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
        streamingTools,
      };
    }

    case "todo-write": {
      validateTodos(event.todos);
      const currentStepIndex = state.steps.length - 1;
      return {
        todos: [...event.todos],
        lastTodoWriteStepIndex: currentStepIndex >= 0 ? currentStepIndex : null,
      };
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
      const resetAssistantMessage =
        event.step > 0 ? undefined : state.currentAssistantMessageId;

      return {
        isStreamingModel: true,
        currentAssistantMessageId: resetAssistantMessage,
        steps: [
          ...state.steps,
          {
            id: crypto.randomUUID(),
            step: event.step,
            runId: state.currentRunId,
            startedAt: timestamp,
          },
        ],
      };
    }

    case "step-end": {
      return {
        isStreamingModel: false,
        steps: state.steps.map((step) =>
          step.step === event.step &&
          step.runId === state.currentRunId &&
          !step.completedAt
            ? {
                ...step,
                completedAt: timestamp,
                finishReason: event.finishReason,
                usage: event.usage,
              }
            : step,
        ),
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
            id: crypto.randomUUID(),
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

      const tailStartIndex = state.messages.findIndex((m) => m.id === tailStartId);
      const compactUpTo = tailStartIndex === -1 ? state.messages.length : tailStartIndex;

      const messages = state.messages.map((message, index) => {
        if (index < compactUpTo) {
          if (message.parts.some((p) => p.type === "compaction")) return message;
          return { ...message, compacted: true };
        }
        return message;
      });

      const existingCompactionIndex = messages.findIndex((m) =>
        m.parts.some((p) => p.type === "compaction"),
      );

      if (existingCompactionIndex !== -1) {
        const existingMessage = messages[existingCompactionIndex]!;
        const updatedParts: StoredPart[] = existingMessage.parts.map((part) => {
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
          id: crypto.randomUUID(),
          summary,
          tailStartId,
          compactedAt: timestamp,
        };

        const syntheticMessage: StoredMessage = {
          id: crypto.randomUUID(),
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

function validateTodos(todos: readonly StoredTodo[]): void {
  let inProgressCount = 0;

  for (const todo of todos) {
    if (!TODO_STATUSES.has(todo.status)) {
      throw new InvalidTodoStateError(
        `todo "${todo.id}" has invalid status "${String(todo.status)}"`,
      );
    }

    if (todo.status === "in_progress") {
      inProgressCount += 1;
    }
  }

  if (inProgressCount > 1) {
    throw new InvalidTodoStateError("only one todo can be in_progress");
  }
}

function isSubAgentReminder(reminder: { source: { type: string } }): boolean {
  return reminder.source.type.startsWith("subagent_");
}

function settleIncompleteState(
  state: SessionStoreState,
  timestamp: number,
): StoredMessage[] {
  let messages = state.messages;

  if (state.currentAssistantMessageId) {
    messages = messages.map((message) =>
      message.id === state.currentAssistantMessageId
        ? { ...message, completedAt: timestamp }
        : message,
    );
  }

  if (state.streamingText) {
    messages = updateMessagePart(
      messages,
      state.streamingText.messageId,
      state.streamingText.partId,
      (part) =>
        part.type === "text"
          ? { ...part, text: state.streamingText!.text, completedAt: timestamp }
          : part,
    );
  }

  if (state.streamingReasoning) {
    messages = updateMessagePart(
      messages,
      state.streamingReasoning.messageId,
      state.streamingReasoning.partId,
      (part) =>
        part.type === "reasoning"
          ? { ...part, text: state.streamingReasoning!.text, completedAt: timestamp }
          : part,
    );
  }

  for (const toolCallId of Object.keys(state.streamingTools)) {
    const streamingTool = state.streamingTools[toolCallId];
    messages = updateMessagePart(
      messages,
      streamingTool.messageId,
      streamingTool.partId,
      (part) =>
        part.type === "tool" && (part.state === "pending" || part.state === "running")
          ? {
              ...toRunningToolPart(part, "input" in part ? part.input : undefined, timestamp),
              state: "error",
              errorMessage: "Run ended before tool result",
              endedAt: timestamp,
            }
          : part,
    );
  }

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool" && (part.state === "pending" || part.state === "running")) {
        messages = updateMessagePart(
          messages,
          message.id,
          part.id,
          (p) =>
            p.type === "tool"
              ? {
                  ...toRunningToolPart(p, "input" in p ? p.input : undefined, timestamp),
                  state: "error",
                  errorMessage: "Run ended before tool result",
                  endedAt: timestamp,
                }
              : p,
        );
      }
    }
  }

  return messages;
}

function ensureCurrentAssistantMessage(
  state: SessionStoreState,
  timestamp: number,
): AssistantMessageResult {
  if (state.currentAssistantMessageId) {
    return {
      messages: state.messages,
      currentAssistantMessageId: state.currentAssistantMessageId,
    };
  }

  const message: StoredMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    parts: [],
    createdAt: timestamp,
    runId: state.currentRunId,
  };

  return {
    messages: [...state.messages, message],
    currentAssistantMessageId: message.id,
  };
}

function updateMessagePart(
  messages: StoredMessage[],
  messageId: string,
  partId: string,
  update: (part: StoredPart) => StoredPart,
): StoredMessage[] {
  return messages.map((message) => {
    if (message.id !== messageId) return message;

    return {
      ...message,
      parts: message.parts.map((part) => (part.id === partId ? update(part) : part)),
    };
  });
}

function findToolPartByCallId(
  messages: StoredMessage[],
  messageId: string | undefined,
  toolCallId: string,
): ToolPartLocation | undefined {
  if (!messageId) return undefined;

  const message = messages.find((item) => item.id === messageId);
  const part = message?.parts.find(
    (item) => item.type === "tool" && item.toolCallId === toolCallId,
  );

  return part ? { messageId, partId: part.id } : undefined;
}

function appendPartToMessage(
  messages: StoredMessage[],
  messageId: string,
  part: StoredPart,
): StoredMessage[] {
  return messages.map((message) =>
    message.id === messageId ? { ...message, parts: [...message.parts, part] } : message,
  );
}

function startTextStreaming(
  assistant: AssistantMessageResult,
  timestamp: number,
): Partial<SessionStoreState> & {
  streamingText: NonNullable<SessionStoreState["streamingText"]>;
} {
  const part: TextPart = {
    type: "text",
    id: crypto.randomUUID(),
    text: "",
    createdAt: timestamp,
  };

  return {
    messages: appendPartToMessage(
      assistant.messages,
      assistant.currentAssistantMessageId,
      part,
    ),
    currentAssistantMessageId: assistant.currentAssistantMessageId,
    streamingText: {
      messageId: assistant.currentAssistantMessageId,
      partId: part.id,
      text: "",
    },
  };
}

function startReasoningStreaming(
  assistant: AssistantMessageResult,
  timestamp: number,
): Partial<SessionStoreState> & {
  streamingReasoning: NonNullable<SessionStoreState["streamingReasoning"]>;
} {
  const part: ReasoningPart = {
    type: "reasoning",
    id: crypto.randomUUID(),
    text: "",
    createdAt: timestamp,
  };

  return {
    messages: appendPartToMessage(
      assistant.messages,
      assistant.currentAssistantMessageId,
      part,
    ),
    currentAssistantMessageId: assistant.currentAssistantMessageId,
    streamingReasoning: {
      messageId: assistant.currentAssistantMessageId,
      partId: part.id,
      text: "",
    },
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
  const runningPart = toRunningToolPart(
    part,
    "input" in part ? part.input : undefined,
    timestamp,
  );

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
