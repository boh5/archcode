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
        runCount: state.runCount + 1,
      };
    }

    case "run-end": {
      return {
        messages: settleIncompleteState(state.messages, state.currentAssistantMessageId, timestamp),
        isRunning: false,
        isStreamingModel: false,
        currentRunId: undefined,
        currentAssistantMessageId: undefined,
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
      const assistant = ensureCurrentAssistantMessage(state, timestamp);
      const messages = finalizeLastIncompletePartOfType(
        assistant.messages,
        assistant.currentAssistantMessageId,
        "text",
        timestamp,
      );

      return appendTextPart(messages, assistant.currentAssistantMessageId, timestamp, "");
    }

    case "text-delta": {
      const assistant = ensureCurrentAssistantMessage(state, timestamp);
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
        };
      }

      return appendTextPart(
        assistant.messages,
        assistant.currentAssistantMessageId,
        timestamp,
        event.text,
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
      const assistant = ensureCurrentAssistantMessage(state, timestamp);
      const messages = finalizeLastIncompletePartOfType(
        assistant.messages,
        assistant.currentAssistantMessageId,
        "reasoning",
        timestamp,
      );

      return appendReasoningPart(messages, assistant.currentAssistantMessageId, timestamp, "");
    }

    case "reasoning-delta": {
      const assistant = ensureCurrentAssistantMessage(state, timestamp);
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
        };
      }

      return appendReasoningPart(
        assistant.messages,
        assistant.currentAssistantMessageId,
        timestamp,
        event.text,
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
      const assistant = ensureCurrentAssistantMessage(state, timestamp);
      const existing = findToolPartByCallId(
        assistant.messages,
        assistant.currentAssistantMessageId,
        event.toolCallId,
      );

      if (existing) return {};

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

        return {
          messages: updateMessagePart(
            state.messages,
            location.messageId,
            location.partId,
            (part) => (part.type === "tool" ? toRunningToolPart(part, event.input, timestamp) : part),
          ),
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
      };
    }

    case "tool-result": {
      const location = findToolPartByCallId(
        state.messages,
        state.currentAssistantMessageId,
        event.toolCallId,
      );

      if (!location) return {};

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
      const resetAssistantMessage = event.step > 0 ? undefined : state.currentAssistantMessageId;

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
          step.step === event.step && step.runId === state.currentRunId && !step.completedAt
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
  messages: StoredMessage[],
  currentAssistantMessageId: string | undefined,
  timestamp: number,
): StoredMessage[] {
  return messages.map((message) => {
    const parts: StoredPart[] = message.parts.map((part): StoredPart => {
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

function isIncompletePart(part: StoredPart): boolean {
  if (part.type === "text" || part.type === "reasoning" || part.type === "system-notice") {
    return part.completedAt === undefined;
  }

  return part.type === "tool" && (part.state === "pending" || part.state === "running");
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

function appendPartToMessage(
  messages: StoredMessage[],
  messageId: string,
  part: StoredPart,
): StoredMessage[] {
  return messages.map((message) =>
    message.id === messageId ? { ...message, parts: [...message.parts, part] } : message,
  );
}

function finalizeLastIncompletePartOfType(
  messages: StoredMessage[],
  messageId: string,
  partType: "text" | "reasoning",
  timestamp: number,
): StoredMessage[] {
  const location = findLatestIncompletePartLocation(messages, messageId, partType);
  if (!location) return messages;

  return updateMessagePart(messages, location.messageId, location.partId, (part) => {
    if (part.type !== partType) return part;
    return { ...part, completedAt: timestamp };
  });
}

function findLatestIncompletePartLocation(
  messages: StoredMessage[],
  messageId: string | undefined,
  partType: "text" | "reasoning",
): ToolPartLocation | undefined {
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
  messages: StoredMessage[],
  messageId: string | undefined,
  toolCallId: string,
): ToolPartLocation | undefined {
  if (!messageId) return undefined;

  const message = messages.find((item) => item.id === messageId);
  const part = message?.parts.find((item) => item.type === "tool" && item.toolCallId === toolCallId);

  return part ? { messageId, partId: part.id } : undefined;
}

function getToolPartAtLocation(
  messages: StoredMessage[],
  messageId: string,
  partId: string,
): ToolPart | undefined {
  const message = messages.find((item) => item.id === messageId);
  const part = message?.parts.find((item) => item.id === partId);
  return part?.type === "tool" ? part : undefined;
}

function appendTextPart(
  messages: StoredMessage[],
  messageId: string,
  timestamp: number,
  text: string,
): Partial<SessionStoreState> {
  const part: TextPart = {
    type: "text",
    id: crypto.randomUUID(),
    text,
    createdAt: timestamp,
  };

  return {
    messages: appendPartToMessage(messages, messageId, part),
    currentAssistantMessageId: messageId,
  };
}

function appendReasoningPart(
  messages: StoredMessage[],
  messageId: string,
  timestamp: number,
  text: string,
): Partial<SessionStoreState> {
  const part: ReasoningPart = {
    type: "reasoning",
    id: crypto.randomUUID(),
    text,
    createdAt: timestamp,
  };

  return {
    messages: appendPartToMessage(messages, messageId, part),
    currentAssistantMessageId: messageId,
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
