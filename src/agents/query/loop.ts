import { streamText as aiStreamText } from "ai";
import type { StreamTextResult, ToolSet } from "ai";
import type { StoreApi } from "zustand";
import type { SessionStoreState, StreamEvent } from "../../store/types";
import type { QueryLoopOptions, QueryLoopResult } from "./types";

const DEFAULT_MAX_STEPS = 50;

let _streamText: typeof aiStreamText = aiStreamText;

export function __setStreamTextForTest(fn: typeof aiStreamText) {
  _streamText = fn;
}

type TextStreamPart = StreamTextResult<ToolSet, never>["fullStream"] extends AsyncIterable<infer Part>
  ? Part
  : never;

type ToolCallArray = Array<{
  toolCallId: string;
  toolName: string;
  input: unknown;
}>;

export async function runQueryLoop(
  options: QueryLoopOptions,
  userMessage: string,
): Promise<QueryLoopResult> {
  const {
    model,
    tools,
    toolExecutors,
    systemPrompt,
    maxSteps = DEFAULT_MAX_STEPS,
    store,
  } = options;

  let steps = 0;
  let lastText = "";
  let failed = false;

  store.getState().append({ type: "run-start" });

  try {
    store.getState().append({ type: "user-message", content: userMessage });

    while (steps < maxSteps) {
      store.getState().append({ type: "step-start", step: steps });
      const messages = store.getState().toModelMessages();

      const result = _streamText({
        model,
        messages,
        ...(Object.keys(tools).length > 0 ? { tools } : {}),
        ...(systemPrompt ? { system: systemPrompt } : {}),
      });

      await consumeFullStream(result.fullStream, store);
      const finishReason = await result.finishReason;
      const usage = await result.usage;
      lastText = await result.text;

      store.getState().append({ type: "step-end", step: steps, finishReason, usage });

      if (finishReason !== "tool-calls") break;

      const toolCalls = await result.toolCalls;
      await executeToolCalls(toolCalls, toolExecutors, store, steps);
      steps++;
    }

    if (steps >= maxSteps) {
      store.getState().append({
        type: "loop-error",
        step: steps,
        error: `Max steps (${maxSteps}) reached`,
      });
    }

    return { text: lastText, steps };
  } catch (err) {
    failed = true;
    store.getState().append({
      type: "loop-error",
      step: steps,
      error: errorMessage(err),
    });
    return { text: lastText, steps };
  } finally {
    store.getState().append({
      type: "run-end",
      status: failed ? "failed" : "completed",
      ...(failed ? { error: "Run failed" } : {}),
    });
  }
}

async function consumeFullStream(
  fullStream: AsyncIterable<TextStreamPart>,
  store: StoreApi<SessionStoreState>,
): Promise<void> {
  let textOpen = false;
  let reasoningOpen = false;

  try {
    for await (const chunk of fullStream) {
      if (chunk.type === "text-delta") {
        if (!textOpen) {
          store.getState().append({ type: "text-start" });
          textOpen = true;
        }
        store.getState().append({ type: "text-delta", text: chunk.text });
        continue;
      }

      if (chunk.type === "reasoning-delta") {
        if (!reasoningOpen) {
          store.getState().append({ type: "reasoning-start" });
          reasoningOpen = true;
        }
        store.getState().append({ type: "reasoning-delta", text: chunk.text });
        continue;
      }

      if (chunk.type === "tool-input-start") {
        store.getState().append({
          type: "tool-input-start",
          toolCallId: chunk.id,
          toolName: chunk.toolName,
        });
        continue;
      }

      if (chunk.type === "tool-call") {
        store.getState().append({
          type: "tool-call",
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          input: chunk.input,
        });
      }
    }
  } finally {
    // Flush open streams even on error so partial content reaches persistent layer
    if (textOpen) store.getState().append({ type: "text-end" });
    if (reasoningOpen) store.getState().append({ type: "reasoning-end" });
  }
}

async function executeToolCalls(
  toolCalls: ToolCallArray,
  toolExecutors: Record<string, (input: unknown) => Promise<string>>,
  store: StoreApi<SessionStoreState>,
  _step: number,
): Promise<void> {
  for (const toolCall of toolCalls) {
    const executor = toolExecutors[toolCall.toolName];

    if (!executor) {
      appendToolResult(store, toolCall, `No executor for tool: ${toolCall.toolName}`, true);
      continue;
    }

    try {
      const output = await executor(toolCall.input);
      appendToolResult(store, toolCall, output, false);
    } catch (err) {
      appendToolResult(store, toolCall, errorMessage(err), true);
    }
  }
}

function appendToolResult(
  store: StoreApi<SessionStoreState>,
  toolCall: ToolCallArray[number],
  output: string,
  isError: boolean,
): void {
  const event: StreamEvent = {
    type: "tool-result",
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    output,
    isError,
  };
  store.getState().append(event);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
