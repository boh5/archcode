import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import type { StoreApi } from "zustand";
import { createStore } from "zustand/vanilla";
import { toModelMessagesFromStoredMessages } from "./projection";
import {
  BusyError,
  type CompletedToolPart,
  type ErrorToolPart,
  type ReasoningPart,
  type RunningToolPart,
  type SessionStoreState,
  type StoredMessage,
  type StoredPart,
  type StreamEvent,
  type TextPart,
  type ToolPart,
} from "./types";

const sessionRegistry = new Map<string, StoreApi<SessionStoreState>>();

interface AssistantMessageResult {
  messages: StoredMessage[];
  currentAssistantMessageId: string;
}

interface ToolPartLocation {
  messageId: string;
  partId: string;
}

export function createSessionStore(
  sessionId: string,
): StoreApi<SessionStoreState> {
  const existing = sessionRegistry.get(sessionId);
  if (existing) return existing;

  const store = createStore<SessionStoreState>((set, get) => ({
    sessionId,
    createdAt: Date.now(),
    messages: [],
    steps: [],
    isRunning: false,
    isStreamingModel: false,
    streamingTools: {},
    append: (event: StreamEvent) => {
      set((state) => reduceStreamEvent(state, event));
    },
    toModelMessages: (): ModelMessage[] =>
      toModelMessagesFromStoredMessages(get().messages),
  }));

  sessionRegistry.set(sessionId, store);
  return store;
}

export function getSessionStore(
  sessionId: string,
): StoreApi<SessionStoreState> | undefined {
  return sessionRegistry.get(sessionId);
}

function reduceStreamEvent(
  state: SessionStoreState,
  event: StreamEvent,
): Partial<SessionStoreState> {
  const timestamp = Date.now();

  switch (event.type) {
    case "run-start": {
      if (state.isRunning) throw new BusyError(state.sessionId);

      return {
        isRunning: true,
        currentRunId: event.runId ?? randomUUID(),
        currentAssistantMessageId: undefined,
        isStreamingModel: false,
        streamingText: undefined,
        streamingReasoning: undefined,
        streamingTools: {},
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
        id: randomUUID(),
        text: event.content,
        createdAt: timestamp,
        completedAt: timestamp,
      };
      const message: StoredMessage = {
        id: randomUUID(),
        role: "user",
        parts: [part],
        createdAt: timestamp,
        completedAt: timestamp,
        runId: state.currentRunId,
      };

      return { messages: [...state.messages, message] };
    }

    case "text-start": {
      // If already streaming text, finalize the previous one first
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

        const flushedState = { ...state, messages: flushedMessages, streamingText: undefined };
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
                ? { ...part, text: state.streamingReasoning!.text, completedAt: timestamp }
                : part,
          );

        const flushedState = { ...state, messages: flushedMessages, streamingReasoning: undefined };
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
      // Skip duplicate tool-input-start for same toolCallId
      if (state.streamingTools[event.toolCallId]) return {};

      const assistant = ensureCurrentAssistantMessage(state, timestamp);
      const part: ToolPart = {
        type: "tool",
        id: randomUUID(),
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
        id: randomUUID(),
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
              ? toSettledToolPart(part, event.output, event.isError, timestamp)
              : part,
        ),
        streamingTools,
      };
    }

    case "step-start": {
      // Each model call step needs its own assistant message;
      // resetting on step > 0 prevents merging multi-step responses
      const resetAssistantMessage = event.step > 0
        ? undefined
        : state.currentAssistantMessageId;

      return {
        isStreamingModel: true,
        currentAssistantMessageId: resetAssistantMessage,
        steps: [
          ...state.steps,
          {
            id: randomUUID(),
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
            id: randomUUID(),
            step: event.step ?? state.steps.length,
            runId: state.currentRunId,
            startedAt: timestamp,
            error: event.error,
          },
        ],
      };
    }
  }
}

function settleIncompleteState(
  state: SessionStoreState,
  timestamp: number,
): StoredMessage[] {
  let messages = state.messages;

  // Complete current assistant message if present
  if (state.currentAssistantMessageId) {
    messages = messages.map((message) =>
      message.id === state.currentAssistantMessageId
        ? { ...message, completedAt: timestamp }
        : message,
    );
  }

  // Persist streaming text into its part before clearing
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

  // Persist streaming reasoning into its part before clearing
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

  // Settle any pending/running tool parts as error
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

  // Also settle any pending/running tool parts not tracked in streamingTools
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
    id: randomUUID(),
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
      parts: message.parts.map((part) =>
        part.id === partId ? update(part) : part,
      ),
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
    message.id === messageId
      ? { ...message, parts: [...message.parts, part] }
      : message,
  );
}

function startTextStreaming(
  assistant: AssistantMessageResult,
  timestamp: number,
): Partial<SessionStoreState> & { streamingText: NonNullable<SessionStoreState["streamingText"]> } {
  const part: TextPart = {
    type: "text",
    id: randomUUID(),
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
    id: randomUUID(),
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
    };
  }

  return {
    ...runningPart,
    state: "completed",
    output,
    endedAt: timestamp,
  };
}
