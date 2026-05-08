import { streamText as aiStreamText } from "ai";
import type { StreamTextResult, ToolSet } from "ai";
import { realpath } from "node:fs/promises";
import type { StoreApi } from "zustand";
import type { SessionStoreState, StreamEvent } from "../../store/types";
import type { ToolExecutionContext } from "../../tools/index";
import type { ToolRegistry } from "../../tools/registry";
import { partitionToolCalls } from "../../tools/concurrency/partition";
import { DOOM_LOOP_MESSAGE, type NormalizedToolCall, type QueryLoopOptions, type QueryLoopResult } from "./types";
import { redactValue } from "../../tools/hooks/redact";

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

class DoomTracker {
  private previous?: NormalizedToolCall;
  private count = 0;

  check(toolCall: ToolCallArray[number]): boolean {
    const current: NormalizedToolCall = {
      toolName: toolCall.toolName,
      canonicalInput: canonicalizeToolInput(toolCall.input),
    };

    if (
      this.previous?.toolName === current.toolName &&
      this.previous.canonicalInput === current.canonicalInput
    ) {
      this.count += 1;
    } else {
      this.previous = current;
      this.count = 1;
    }

    return this.count >= 3;
  }
}

export async function runQueryLoop(
  options: QueryLoopOptions,
  userMessage: string,
): Promise<QueryLoopResult> {
  const {
    model,
    toolRegistry,
    allowedTools,
    confirmPermission,
    systemPrompt,
    maxSteps = DEFAULT_MAX_STEPS,
    store,
  } = options;
  const abort = options.abort ?? new AbortController().signal;
  let resolvedWorkspaceRoot = options.workspaceRoot;

  let steps = 0;
  let lastText = "";
  let failed = false;
  const doomTracker = new DoomTracker();

  store.getState().append({ type: "run-start" });

  try {
    store.getState().append({ type: "user-message", content: userMessage });

    while (steps < maxSteps) {
      store.getState().append({ type: "step-start", step: steps });
      const messages = store.getState().toModelMessages();
      const resolved = toolRegistry.resolveForAgent(allowedTools);

      const result = _streamText({
        model,
        messages,
        abortSignal: abort,
        ...(resolved.descriptors.length > 0 ? { tools: resolved.toAITools() } : {}),
        ...(systemPrompt ? { system: systemPrompt } : {}),
      });

      await consumeFullStream(result.fullStream, store);
      const finishReason = await result.finishReason;
      const usage = await result.usage;
      lastText = await result.text;

      store.getState().append({ type: "step-end", step: steps, finishReason, usage });

      if (finishReason !== "tool-calls") break;

      const toolCalls = await result.toolCalls;
      resolvedWorkspaceRoot ??= await realpath(process.cwd());
      await executeToolCalls(
        toolCalls,
        toolRegistry,
        store,
        steps,
        abort,
        allowedTools,
        resolvedWorkspaceRoot,
        confirmPermission,
        options.askUser,
        doomTracker,
      );
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
          input: redactValue(chunk.input),
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
  registry: ToolRegistry,
  store: StoreApi<SessionStoreState>,
  step: number,
  abort: AbortSignal,
  allowedTools: readonly string[],
  workspaceRoot: string,
  confirmPermission: QueryLoopOptions["confirmPermission"],
  askUser?: QueryLoopOptions["askUser"],
  doomTracker?: DoomTracker,
): Promise<void> {
  const executableToolCalls: ToolCallArray = [];

  for (const toolCall of toolCalls) {
    if (doomTracker?.check(toolCall)) {
      appendToolResult(store, toolCall, DOOM_LOOP_MESSAGE, true);
    } else {
      executableToolCalls.push(toolCall);
    }
  }

  const batches = partitionToolCalls(executableToolCalls, registry);

  for (const batch of batches) {
    if (batch.type === "parallel") {
      await Promise.all(
        batch.calls.map(async (toolCall) => {
          const ctx: ToolExecutionContext = {
            store,
            toolName: toolCall.toolName,
            toolCallId: toolCall.toolCallId,
            input: toolCall.input,
            redactedInput: redactValue(toolCall.input),
            step,
            abort,
            startedAt: Date.now(),
            allowedTools: new Set(allowedTools),
            workspaceRoot,
            ...(confirmPermission ? { confirmPermission } : {}),
            ...(askUser ? { askUser } : {}),
          };
          const result = await registry.execute(toolCall, ctx);
          appendToolResult(store, toolCall, result.output, result.isError);
        }),
      );
    } else {
      const toolCall = batch.call;
      const ctx: ToolExecutionContext = {
        store,
        toolName: toolCall.toolName,
        toolCallId: toolCall.toolCallId,
        input: toolCall.input,
        redactedInput: redactValue(toolCall.input),
        step,
        abort,
        startedAt: Date.now(),
        allowedTools: new Set(allowedTools),
        workspaceRoot,
        ...(confirmPermission ? { confirmPermission } : {}),
        ...(askUser ? { askUser } : {}),
      };
      const result = await registry.execute(toolCall, ctx);
      appendToolResult(store, toolCall, result.output, result.isError);
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

function canonicalizeToolInput(value: unknown): string {
  return JSON.stringify(toCanonicalJsonValue(value));
}

function toCanonicalJsonValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;

  const valueType = typeof value;
  if (valueType === "string" || valueType === "number" || valueType === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => {
      const canonicalItem = toCanonicalJsonValue(item);
      return canonicalItem === undefined ? null : canonicalItem;
    });
  }

  if (valueType === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    const canonicalObject: Record<string, unknown> = {};

    for (const [key, objectValue] of entries) {
      const canonicalObjectValue = toCanonicalJsonValue(objectValue);
      if (canonicalObjectValue !== undefined) {
        canonicalObject[key] = canonicalObjectValue;
      }
    }

    return canonicalObject;
  }

  return value;
}
