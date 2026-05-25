import { streamText as aiStreamText } from "ai";
import type { StreamTextResult, ToolSet } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { StoreApi } from "zustand";
import type { ModelCallOptions } from "../../config/provider";
import type { RunEndEvent, SessionStoreState, StreamEvent } from "../../store/types";
import { createToolExecutionContext, type ToolExecutionContext } from "../../tools/index";
import type { ToolRegistry } from "../../tools/registry";
import { partitionToolCalls } from "../../tools/concurrency/partition";
import { DOOM_LOOP_MESSAGE, type NormalizedToolCall, type QueryLoopOptions, type QueryLoopResult } from "./types";
import { redactValue } from "../../tools/security";
import { MissingProjectContextError } from "../errors";

const DEFAULT_MAX_STEPS = 50;

let _streamText: typeof aiStreamText = aiStreamText;

type SafeModelCallOptions = Omit<ModelCallOptions, "providerOptions"> & {
  providerOptions?: ProviderOptions;
};

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
    modelInfo,
    toolRegistry,
    allowedTools,
    confirmPermission,
    systemPrompt,
    maxSteps = DEFAULT_MAX_STEPS,
    store,
    currentDepth,
  } = options;
  const { beforeModelBuild, beforeModelCall, afterStepEnd, afterLoopEnd } = options.hooks ?? {};
  const abort = options.abort ?? new AbortController().signal;
  let resolvedWorkspaceRoot = options.workspaceRoot;

  let steps = 0;
  let lastText = "";
  let failed = false;
  let runEndStatus: RunEndEvent["status"] = "completed";
  const doomTracker = new DoomTracker();

  store.getState().append({ type: "run-start" });

  try {
    const commandResult = await maybeHandleCommand(options, userMessage, abort);
    if (commandResult.handled) {
      return { text: "", steps: 0 };
    }

    if (userMessage) {
      store.getState().append({ type: "user-message", content: userMessage });
    }

    while (steps < maxSteps) {
      if (abort.aborted) break;

      store.getState().append({ type: "step-start", step: steps });
      await runHooks(beforeModelBuild, { store, modelInfo, modelOptions: options.modelOptions, abort, systemPrompt });
      const messages = store.getState().toModelMessages();
      await runHooks(beforeModelCall, { store, modelInfo, modelOptions: options.modelOptions, abort, messages });
      const resolved = toolRegistry.resolveForAgent(allowedTools);

      const result = _streamText({
        model: modelInfo.model,
        ...pickModelCallOptions(options.modelOptions),
        messages,
        abortSignal: abort,
        ...(resolved.descriptors.length > 0 ? { tools: resolved.toAITools() } : {}),
        ...(systemPrompt ? { system: systemPrompt } : {}),
      });

      await consumeFullStream(result.fullStream, store, abort);

      if (abort.aborted) break;

      const finishReason = await result.finishReason;
      const usage = await result.usage;
      lastText = await result.text;

      store.getState().append({ type: "step-end", step: steps, finishReason, usage });
      await runHooks(afterStepEnd, { store, modelInfo, modelOptions: options.modelOptions, abort });

      if (finishReason !== "tool-calls") break;

      const toolCalls = await result.toolCalls;
      if (abort.aborted) break;
      if (resolvedWorkspaceRoot === undefined) {
        resolvedWorkspaceRoot = options.projectContext.project.workspaceRoot;
      }
      if (resolvedWorkspaceRoot === undefined) {
        throw new MissingProjectContextError("Query loop requires options.workspaceRoot before executing tools");
      }
      options.projectContext.project.workspaceRoot = resolvedWorkspaceRoot;
      await executeToolCalls(
        toolCalls,
        toolRegistry,
        store,
        steps,
        abort,
        allowedTools,
        options.projectContext,
        resolvedWorkspaceRoot,
        confirmPermission,
        options.askUser,
        options.agentFactory,
        options.agentName,
        currentDepth,
        doomTracker,
      );

      steps++;
    }

    if (steps >= maxSteps) {
      runEndStatus = "max_steps";
      store.getState().append({
        type: "loop-error",
        step: steps,
        error: `Max steps (${maxSteps}) reached`,
      });
    }

    return { text: lastText, steps };
  } catch (err) {
    failed = true;
    runEndStatus = abort.aborted ? "aborted" : "failed";
    store.getState().append({
      type: "loop-error",
      step: steps,
      error: errorMessage(err),
    });
    return { text: lastText, steps };
  } finally {
    if (abort.aborted && !failed && runEndStatus === "completed") {
      runEndStatus = "aborted";
    }

    store.getState().append({
      type: "run-end",
      status: runEndStatus,
      ...(failed ? { error: "Run failed" } : {}),
    });
    await runHooks(afterLoopEnd, { store, modelInfo, modelOptions: options.modelOptions, abort, loopEndStatus: runEndStatus });
  }
}

function pickModelCallOptions(modelOptions: QueryLoopOptions["modelOptions"]): SafeModelCallOptions | undefined {
  if (!modelOptions) return undefined;

  const {
    maxOutputTokens,
    temperature,
    topP,
    topK,
    presencePenalty,
    frequencyPenalty,
    stopSequences,
    seed,
    maxRetries,
    timeout,
    providerOptions,
  } = modelOptions;

  return {
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(topK !== undefined ? { topK } : {}),
    ...(presencePenalty !== undefined ? { presencePenalty } : {}),
    ...(frequencyPenalty !== undefined ? { frequencyPenalty } : {}),
    ...(stopSequences !== undefined ? { stopSequences } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(providerOptions !== undefined ? { providerOptions: providerOptions as ProviderOptions } : {}),
  };
}

async function maybeHandleCommand(
  options: QueryLoopOptions,
  userMessage: string,
  abort: AbortSignal,
): Promise<{ handled: boolean }> {
  const { commandRegistry, store, modelInfo, modelOptions } = options;
  const parsed = commandRegistry?.parse(userMessage);
  if (!parsed) return { handled: false };

  const descriptor = commandRegistry?.get(parsed.command);
  if (!descriptor) {
    store.getState().append({
      type: "system-notice",
      message: `Unknown command: /${parsed.command}`,
    });
    return { handled: true };
  }

  if (parsed.command === "compact" && parsed.args.trim() !== "") {
    return { handled: false };
  }

  const result = await descriptor.handler({ store, modelInfo, modelOptions, abort }, parsed.args);
  store.getState().append({ type: "system-notice", message: result.message });
  return { handled: true };
}

async function runHooks<T>(
  hooks: Array<(ctx: T) => Promise<void>> | undefined,
  ctx: T,
): Promise<void> {
  if (!hooks?.length) return;

  for (const hook of hooks) {
    try {
      await hook(ctx);
    } catch (err) {
      // AbortError must propagate — user cancelled or signal fired
      if ((err instanceof DOMException && err.name === "AbortError") || (err != null && typeof err === "object" && "name" in err && err.name === "AbortError")) {
        throw err;
      }
      console.warn("Loop hook failed:", err instanceof Error ? err.message : String(err));
    }
  }
}

async function consumeFullStream(
  fullStream: AsyncIterable<TextStreamPart>,
  store: StoreApi<SessionStoreState>,
  abort?: AbortSignal,
): Promise<void> {
  let textOpen = false;
  let reasoningOpen = false;

  try {
    for await (const chunk of fullStream) {
      if (abort?.aborted) break;

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
  projectContext: QueryLoopOptions["projectContext"],
  workspaceRoot: string,
  confirmPermission: QueryLoopOptions["confirmPermission"],
  askUser?: QueryLoopOptions["askUser"],
  agentFactory?: NonNullable<QueryLoopOptions["agentFactory"]>,
  agentName?: string,
  currentDepth?: number,
  doomTracker?: DoomTracker,
): Promise<void> {
  const executableToolCalls: ToolCallArray = [];

  for (const toolCall of toolCalls) {
    if (doomTracker?.check(toolCall)) {
      appendToolResult(store, toolCall, DOOM_LOOP_MESSAGE, true, undefined);
    } else {
      executableToolCalls.push(toolCall);
    }
  }

  const batches = partitionToolCalls(executableToolCalls, registry);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];

    if (abort.aborted) {
      for (let j = i; j < batches.length; j++) {
        const remaining = batches[j];
        const calls = remaining.type === "parallel" ? remaining.calls : [remaining.call];
        for (const tc of calls) {
          appendToolResult(store, tc, "Aborted", true, undefined);
        }
      }
      break;
    }

    if (batch.type === "parallel") {
      await Promise.all(
        batch.calls.map(async (toolCall) => {
          if (abort.aborted) {
            appendToolResult(store, toolCall, "Aborted", true, undefined);
            return;
          }
          const ctx = createToolExecutionContext({
            store,
            toolName: toolCall.toolName,
            toolCallId: toolCall.toolCallId,
            input: toolCall.input,
            redactedInput: redactValue(toolCall.input),
            step,
            abort,
            startedAt: Date.now(),
            allowedTools: new Set(allowedTools),
            projectContext,
            ...(confirmPermission ? { confirmPermission } : {}),
            ...(askUser ? { askUser } : {}),
            ...(agentFactory ? { agentFactory } : {}),
            ...(agentName ? { agentName } : {}),
            ...(currentDepth !== undefined ? { currentDepth } : {}),
          });
          const result = await registry.execute(toolCall, ctx);
          appendToolResult(store, toolCall, result.output, result.isError, result.meta);
        }),
      );
    } else {
      if (abort.aborted) {
        appendToolResult(store, batch.call, "Aborted", true, undefined);
        for (let j = i + 1; j < batches.length; j++) {
          const remaining = batches[j];
          const calls = remaining.type === "parallel" ? remaining.calls : [remaining.call];
          for (const tc of calls) {
            appendToolResult(store, tc, "Aborted", true, undefined);
          }
        }
        break;
      }
      const toolCall = batch.call;
      const ctx = createToolExecutionContext({
        store,
        toolName: toolCall.toolName,
        toolCallId: toolCall.toolCallId,
        input: toolCall.input,
        redactedInput: redactValue(toolCall.input),
        step,
        abort,
        startedAt: Date.now(),
        allowedTools: new Set(allowedTools),
        projectContext,
        ...(confirmPermission ? { confirmPermission } : {}),
        ...(askUser ? { askUser } : {}),
        ...(agentFactory ? { agentFactory } : {}),
        ...(agentName ? { agentName } : {}),
        ...(currentDepth !== undefined ? { currentDepth } : {}),
      });
      const result = await registry.execute(toolCall, ctx);
      appendToolResult(store, toolCall, result.output, result.isError, result.meta);
    }
  }
}

function appendToolResult(
  store: StoreApi<SessionStoreState>,
  toolCall: ToolCallArray[number],
  output: string,
  isError: boolean,
  meta?: Record<string, unknown>,
): void {
  const event: StreamEvent = {
    type: "tool-result",
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    output,
    isError,
    ...(meta ? { meta } : {}),
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
