import type { ModelMessage, StreamTextResult, ToolSet } from "ai";
import type { StoreApi } from "zustand";
import type { Logger } from "../../logger";
import type { ErrorToolPart, ExecutionEndEvent, SessionStoreState, StreamEvent } from "../../store/types";
import { createToolExecutionContext } from "../../tools/index";
import type { ToolRegistry } from "../../tools/registry";
import { partitionToolCalls } from "../../tools/concurrency/partition";
import { DOOM_LOOP_MESSAGE, type NormalizedToolCall, type QueryLoopOptions, type QueryLoopResult } from "./types";
import { redactValue } from "../../tools/security";
import { MissingProjectContextError } from "../errors";
import { classifyLlmError, runLlmStream } from "../../llm";
import type { BeforeModelBuildContext, BeforeModelCallContext } from "./loop-hooks";

const DEFAULT_MAX_STEPS = 50;
const ZERO_OUTPUT_SHORT_ATTEMPTS = 3;
const SESSION_RETRY_INITIAL_DELAY_MS = 2_000;
const SESSION_RETRY_FACTOR = 2;
const SESSION_RETRY_MAX_DELAY_MS = 30_000;

type TextStreamPart = StreamTextResult<ToolSet, never>["fullStream"] extends AsyncIterable<infer Part>
  ? Part
  : never;
type AnyStreamTextResult = StreamTextResult<any, never>;

type HookList<T> = Array<(ctx: T) => Promise<void>> | undefined;

interface ModelAttemptOptions {
  step: number;
  store: StoreApi<SessionStoreState>;
  modelInfo: QueryLoopOptions["modelInfo"];
  modelOptions: QueryLoopOptions["modelOptions"];
  systemPrompt: QueryLoopOptions["systemPrompt"];
  toolRegistry: ToolRegistry;
  allowedTools: readonly string[];
  abort: AbortSignal;
  logger: Logger;
  sessionId: string;
  agentName: string | undefined;
  beforeModelBuild: HookList<BeforeModelBuildContext>;
  beforeModelCall: HookList<BeforeModelCallContext>;
}

type ModelAttemptResult =
  | {
      outcome: "success";
      finalized: FinalizedModelResult;
      streamError?: unknown;
    }
  | {
      outcome: "terminal";
      error: unknown;
      errorKind: string;
      message: string;
      finalizationKind?: FinalizationKind;
    }
  | {
      outcome: "retry";
      error: unknown;
      errorKind: string;
      message: string;
      hadDurableOutput: boolean;
      recoveryAttempt: number;
    };

interface FinalizedModelResult {
  finishReason: string;
  usage: unknown;
  text: string;
  toolCalls?: ToolCallArray;
}

type FinalizationKind = "result" | "toolCalls";

type RetryOrTerminalAttemptResult = Exclude<ModelAttemptResult, { outcome: "success" }>;

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

async function runModelAttempt(options: ModelAttemptOptions): Promise<ModelAttemptResult> {
  const {
    step,
    store,
    modelInfo,
    modelOptions,
    systemPrompt,
    toolRegistry,
    allowedTools,
    abort,
    logger,
    sessionId,
    agentName,
    beforeModelBuild,
    beforeModelCall,
  } = options;

  store.getState().append({ type: "step-start", step });

  let messages: ModelMessage[];
  let tools: ToolSet | undefined;

  try {
    await runHooks("beforeModelBuild", beforeModelBuild, { store, modelInfo, logger, modelOptions, abort, systemPrompt }, logger, { sessionId, agentName });
    messages = store.getState().toModelMessages();
    await runHooks("beforeModelCall", beforeModelCall, { store, modelInfo, logger, modelOptions, abort, messages }, logger, { sessionId, agentName });
    const resolved = toolRegistry.resolveForAgent(allowedTools);
    tools = resolved.descriptors.length > 0 ? resolved.toAITools() : undefined;
  } catch (err) {
    store.getState().append({ type: "step-end", step, finishReason: "error" });
    throw err;
  }

  try {
    const result = runLlmStream({
      model: modelInfo.model,
      modelOptions,
      messages,
      abortSignal: abort,
      ...(tools ? { tools } : {}),
      ...(systemPrompt ? { system: systemPrompt } : {}),
    });

    const { streamError } = await consumeFullStream(result.fullStream as AsyncIterable<TextStreamPart>, store, abort);
    const finalized = await finalizeModelResult(result as AnyStreamTextResult, streamError, store, step, abort);
    if (finalized.outcome !== "success") return finalized;
    return { outcome: "success", finalized: finalized.finalized, streamError };
  } catch (err) {
    const failure = buildRetryOrTerminalFailure(err, store, step, abort);
    store.getState().append({
      type: "step-end",
      step,
      finishReason: failure.outcome === "retry" ? "interrupted" : "error",
    });
    if (failure.outcome === "retry") settleUnfinalizedToolPartsForRecovery(store);
    return failure;
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
  const sessionId = store.getState().sessionId;
  const agentName = options.agentName;
  const logger = options.logger.child({
    module: "query.loop",
    context: { sessionId, agentName },
  });

  let steps = 0;
  let lastText = "";
  let failed = false;
  let runEndStatus: ExecutionEndEvent["status"] = "completed";
  let recoveredFromFailure = false;
  let zeroOutputShortAttempt = 0;
  let sessionRetryAttempt = 0;
  let lastRecoveryAttempt = 0;
  const doomTracker = new DoomTracker();

  if (!store.getState().isRunning) {
    store.getState().append({ type: "execution-start" });
  }

  try {
    const commandResult = await maybeHandleCommand(options, userMessage, abort);
    if (commandResult.handled) {
      return { text: "", steps: 0 };
    }

    const activeUserMessage = commandResult.userMessage ?? userMessage;

    if (activeUserMessage) {
      store.getState().append({ type: "user-message", content: activeUserMessage });
    }

    while (steps < maxSteps) {
      if (abort.aborted) {
        const err = abort.reason ?? new DOMException("Aborted", "AbortError");
        const classification = classifyLlmError(err);
        appendTerminalLlmFailureNotice(store, err, classification.kind, {
          steps,
          recoveredFromFailure,
          sessionRetryAttempt,
          zeroOutputShortAttempt,
          lastRecoveryAttempt,
        });
        break;
      }

      const attempt = await runModelAttempt({
        step: steps,
        store,
        modelInfo,
        modelOptions: options.modelOptions,
        systemPrompt,
        toolRegistry,
        allowedTools,
        abort,
        logger,
        sessionId,
        agentName,
        beforeModelBuild,
        beforeModelCall,
      });

      if (attempt.outcome === "retry") {
        recoveredFromFailure = true;
        lastRecoveryAttempt = attempt.recoveryAttempt;
        if (attempt.hadDurableOutput) {
          zeroOutputShortAttempt = 0;
          sessionRetryAttempt = 0;
          const delayMs = computeSessionRetryDelayMs(attempt.recoveryAttempt, attempt.error);
          const nextRetryAt = Date.now() + delayMs;
          store.getState().append({
            type: "llm-retry",
            scope: "session",
            visibility: "session",
            profile: "partial-output-recovery",
            attempt: attempt.recoveryAttempt,
            errorKind: attempt.errorKind,
            message: `Model stream was interrupted after partial output. Continuing with recovery attempt ${attempt.recoveryAttempt}.`,
            nextRetryAt,
            stepId: `step-${steps}`,
          });
          await sleepAbortable(delayMs, abort);
          continue;
        }

        if (zeroOutputShortAttempt < ZERO_OUTPUT_SHORT_ATTEMPTS) {
          zeroOutputShortAttempt++;
          lastRecoveryAttempt = zeroOutputShortAttempt;
          store.getState().append({
            type: "llm-retry",
            scope: "short",
            visibility: "internal",
            profile: "zero-output-short",
            attempt: zeroOutputShortAttempt,
            errorKind: attempt.errorKind,
            message: `Zero-output model attempt failed: ${attempt.message}`,
            stepId: `step-${steps}`,
          });
          continue;
        }

        sessionRetryAttempt++;
        lastRecoveryAttempt = sessionRetryAttempt;
        const delayMs = computeSessionRetryDelayMs(sessionRetryAttempt, attempt.error);
        const nextRetryAt = Date.now() + delayMs;
        store.getState().append({
          type: "llm-retry",
          scope: "session",
          visibility: "session",
          profile: "zero-output-session",
          attempt: sessionRetryAttempt,
          errorKind: attempt.errorKind,
          message: `Model request is still failing before output. Retrying in ${Math.ceil(delayMs / 1000)}s: ${attempt.message}`,
          nextRetryAt,
          stepId: `step-${steps}`,
        });
        await sleepAbortable(delayMs, abort);
        continue;
      }

      if (attempt.outcome === "terminal") {
        if (attempt.finalizationKind) {
          appendPostStreamTerminalFailure(store, attempt.error, steps, attempt.finalizationKind);
          markCurrentAssistantModelOutputDiscardedFromContext(store);
        } else {
          store.getState().append({
            type: "loop-error",
            step: steps,
            error: attempt.message,
          });
          appendTerminalLlmFailureNotice(store, attempt.error, attempt.errorKind, {
            steps,
            recoveredFromFailure,
            sessionRetryAttempt,
            zeroOutputShortAttempt,
            lastRecoveryAttempt,
          }, { terminalNoRetry: true });
        }
        failed = true;
        runEndStatus = "failed";
        return { text: lastText, steps };
      }

      const { finalized } = attempt;

      if (recoveredFromFailure) {
        store.getState().append({
          type: "llm-recovery",
          scope: sessionRetryAttempt > 0 ? "session" : "short",
          visibility: sessionRetryAttempt > 0 || zeroOutputShortAttempt === 0 ? "session" : "internal",
          profile: sessionRetryAttempt > 0 ? "zero-output-session" : zeroOutputShortAttempt > 0 ? "zero-output-short" : "partial-output-recovery",
          attempt: Math.max(sessionRetryAttempt, zeroOutputShortAttempt, 1),
          message: "Model stream recovered and resumed.",
          stepId: `step-${steps}`,
        });
        recoveredFromFailure = false;
        zeroOutputShortAttempt = 0;
        sessionRetryAttempt = 0;
        lastRecoveryAttempt = 0;
      }

      if (abort.aborted) {
        const err = abort.reason ?? new DOMException("Aborted", "AbortError");
        const classification = classifyLlmError(err);
        appendTerminalLlmFailureNotice(store, err, classification.kind, {
          steps,
          recoveredFromFailure,
          sessionRetryAttempt,
          zeroOutputShortAttempt,
          lastRecoveryAttempt,
        });
        break;
      }

      lastText = finalized.text;

      store.getState().append({ type: "step-end", step: steps, finishReason: finalized.finishReason, usage: finalized.usage });
      await runHooks("afterStepEnd", afterStepEnd, { store, modelInfo, logger, modelOptions: options.modelOptions, abort }, logger, { sessionId, agentName });

      if (finalized.finishReason !== "tool-calls") break;

      const toolCalls = finalized.toolCalls ?? [];
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
        confirmPermission,
        options.askUser,
        options.startChildExecution,
        options.agentName,
        options.agentSkills,
        options.skillService,
        options.storeManager,
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
    logger.error("query.loop.fatal", {
      error: errorMessage(err),
      context: { step: steps, sessionId, agentName },
    });
    store.getState().append({
      type: "loop-error",
      step: steps,
      error: errorMessage(err),
    });
    const classification = classifyLlmError(err);
    appendTerminalLlmFailureNotice(store, err, classification.kind, {
      steps,
      recoveredFromFailure,
      sessionRetryAttempt,
      zeroOutputShortAttempt,
      lastRecoveryAttempt,
    });
    return { text: lastText, steps };
  } finally {
    if (abort.aborted && !failed && runEndStatus === "completed") {
      runEndStatus = "aborted";
    }

    if (store.getState().isRunning) {
      store.getState().append({
        type: "execution-end",
        status: runEndStatus,
        ...(failed ? { error: "Execution failed" } : {}),
      });
    }
    await runHooks("afterLoopEnd", afterLoopEnd, { store, modelInfo, logger, modelOptions: options.modelOptions, abort, loopEndStatus: runEndStatus }, logger, { sessionId, agentName });
  }
}

export async function maybeHandleCommand(
  options: QueryLoopOptions,
  userMessage: string,
  abort: AbortSignal,
): Promise<{ handled: boolean; userMessage?: string }> {
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

  const result = await descriptor.handler({
    store,
    modelInfo,
    logger: options.logger,
    modelOptions,
    abort,
    workspaceRoot: options.workspaceRoot,
    agentName: options.agentName,
    agentSkills: options.agentSkills,
    skillService: options.skillService,
  }, parsed.args);
  store.getState().append({ type: "system-notice", message: result.message });
  if (result.continueAsMessage) {
    return { handled: false, userMessage: result.continueAsMessage };
  }
  return { handled: true };
}

async function runHooks<T>(
  phase: string,
  hooks: Array<(ctx: T) => Promise<void>> | undefined,
  ctx: T,
  logger: Logger,
  logContext: Record<string, unknown>,
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
      logger.warn("query.loop.hook.failed", {
        error: err,
        context: logContext,
        meta: { phase },
      });
    }
  }
}

async function consumeFullStream(
  fullStream: AsyncIterable<TextStreamPart>,
  store: StoreApi<SessionStoreState>,
  abort?: AbortSignal,
): Promise<{ streamError?: unknown }> {
  let textOpen = false;
  let reasoningOpen = false;
  let streamError: unknown;

  try {
    for await (const chunk of fullStream) {
      if (abort?.aborted) break;

      if (chunk.type === "error") {
        streamError = chunk.error;
        continue;
      }

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

  return { streamError };
}

async function finalizeModelResult(
  result: AnyStreamTextResult,
  streamError: unknown,
  store: StoreApi<SessionStoreState>,
  step: number,
  abort: AbortSignal,
): Promise<{ outcome: "success"; finalized: FinalizedModelResult } | RetryOrTerminalAttemptResult> {
  let finishReason: string;
  let usage: unknown;
  let text: string;

  try {
    finishReason = await result.finishReason;
    usage = await result.usage;
    text = await result.text;
  } catch (err) {
    return handleFinalizationFailure(preferStreamError(streamError, err), store, step, abort, "result");
  }

  if (finishReason !== "tool-calls") {
    return { outcome: "success", finalized: { finishReason, usage, text } };
  }

  try {
    const toolCalls = await result.toolCalls;
    return { outcome: "success", finalized: { finishReason, usage, text, toolCalls } };
  } catch (err) {
    return handleFinalizationFailure(preferStreamError(streamError, err), store, step, abort, "toolCalls");
  }
}

function handleFinalizationFailure(
  err: unknown,
  store: StoreApi<SessionStoreState>,
  step: number,
  abort: AbortSignal,
  kind: FinalizationKind,
): RetryOrTerminalAttemptResult {
  const failure = buildRetryOrTerminalFailure(err, store, step, abort);

  if (failure.outcome === "retry") {
    if (isStepOpen(store, step)) {
      store.getState().append({ type: "step-end", step, finishReason: "interrupted" });
    }
    settleUnfinalizedToolPartsForRecovery(store);
    return failure;
  }

  return { ...failure, finalizationKind: kind };
}

function buildRetryOrTerminalFailure(
  err: unknown,
  store: StoreApi<SessionStoreState>,
  step: number,
  abort: AbortSignal,
): RetryOrTerminalAttemptResult {
  const classification = classifyLlmError(err, { boundary: "provider-request" });
  if (classification.kind === "abort") throw err;

  if (classification.retryable && !abort.aborted) {
    return {
      outcome: "retry",
      error: err,
      errorKind: classification.kind,
      message: errorMessage(err),
      hadDurableOutput: hasCurrentStepDurableOutput(store),
      recoveryAttempt: countRecoveryAttempts(store, step) + 1,
    };
  }

  return {
    outcome: "terminal",
    error: err,
    errorKind: classification.kind,
    message: errorMessage(err),
  };
}

function preferStreamError(streamError: unknown, fallback: unknown): unknown {
  if (streamError != null) {
    const streamClass = classifyLlmError(streamError, { boundary: "provider-request" });
    const fallbackClass = classifyLlmError(fallback, { boundary: "provider-request" });
    if (streamClass.statusCode !== undefined || streamClass.kind !== "unknown") return streamError;
    if (fallbackClass.kind !== "unknown") return fallback;
  }
  return fallback;
}

function hasCurrentStepDurableOutput(store: StoreApi<SessionStoreState>): boolean {
  const currentAssistantId = store.getState().currentAssistantMessageId;
  if (!currentAssistantId) return false;
  const message = store.getState().messages.find((candidate) => candidate.id === currentAssistantId);
  if (!message) return false;

  return message.parts.some((part) => {
    if (part.type === "text" || part.type === "reasoning") return part.text.length > 0;
    if (part.type === "recovery-notice" || part.type === "system-notice" || part.type === "compaction") return false;
    return true;
  });
}

function countRecoveryAttempts(store: StoreApi<SessionStoreState>, step: number): number {
  const stepId = `step-${step}`;
  return store.getState().events.filter((event) =>
    (event.payload.type === "llm-retry" || event.payload.type === "llm-recovery") && event.payload.stepId === stepId,
  ).length;
}

function appendTerminalLlmFailureNotice(
  store: StoreApi<SessionStoreState>,
  err: unknown,
  errorKind: string,
  attempts: {
    steps: number;
    recoveredFromFailure: boolean;
    sessionRetryAttempt: number;
    zeroOutputShortAttempt: number;
    lastRecoveryAttempt: number;
  },
  options: { terminalNoRetry?: boolean; profile?: string; message?: string } = {},
): void {
  const hadRecoveryAttempts = hasRecoveryAttempts(attempts);
  if (errorKind === "abort" && !hadRecoveryAttempts) return;
  if (!hadRecoveryAttempts && options.terminalNoRetry !== true) return;

  const message = options.message ?? errorMessage(err);
  const classification = classifyLlmError(err);
  const recoveryExhausted = hadRecoveryAttempts;
  store.getState().append({
    type: "llm-recovery-failed",
    scope: "session",
    visibility: "session",
    profile: recoveryExhausted ? "recovery-exhausted" : options.profile ?? "terminal-failure",
    attempt: recoveryExhausted ? Math.max(attempts.sessionRetryAttempt, attempts.zeroOutputShortAttempt, attempts.lastRecoveryAttempt, 1) : 0,
    errorKind,
    statusCode: classification.statusCode,
    message: recoveryExhausted ? `Recovery failed: ${message}` : options.message ?? `Model call failed: ${message}`,
    stepId: `step-${attempts.steps}`,
  });
}

function appendPostStreamTerminalFailure(
  store: StoreApi<SessionStoreState>,
  err: unknown,
  step: number,
  kind: "result" | "toolCalls",
): void {
  const message = errorMessage(err);
  const classification = classifyLlmError(err);

  if (isStepOpen(store, step)) {
    store.getState().append({ type: "step-end", step, finishReason: "error" });
  }

  store.getState().append({
    type: "loop-error",
    step,
    error: message,
  });

  appendTerminalLlmFailureNotice(store, err, classification.kind, {
    steps: step,
    recoveredFromFailure: false,
    sessionRetryAttempt: 0,
    zeroOutputShortAttempt: 0,
    lastRecoveryAttempt: 0,
  }, {
    terminalNoRetry: true,
    profile: "post-stream-terminal",
    message: `${kind === "toolCalls" ? "Model tool call" : "Model result"} finalization failed: ${message}`,
  });
}

function isStepOpen(store: StoreApi<SessionStoreState>, step: number): boolean {
  const currentExecutionId = store.getState().currentExecutionId;
  return store.getState().steps.some((candidate) =>
    candidate.step === step && candidate.executionId === currentExecutionId && candidate.completedAt === undefined,
  );
}

function markCurrentAssistantModelOutputDiscardedFromContext(store: StoreApi<SessionStoreState>): void {
  const currentAssistantMessageId = store.getState().currentAssistantMessageId;
  if (!currentAssistantMessageId) return;

  store.setState((state) => {
    let changed = false;
    const messages = state.messages.map((message) => {
      if (message.id !== currentAssistantMessageId) return message;

      const parts = message.parts.map((part) => {
        if ((part.type !== "text" && part.type !== "reasoning") || part.text.length === 0) return part;
        if (part.meta?.interrupted === true && part.meta?.discardedFromContext === true) return part;

        changed = true;
        return {
          ...part,
          meta: { ...(part.meta ?? {}), interrupted: true, discardedFromContext: true },
        };
      });

      return changed ? { ...message, parts } : message;
    });

    return changed ? { messages } : {};
  });
}

function settleUnfinalizedToolPartsForRecovery(store: StoreApi<SessionStoreState>): void {
  const currentAssistantMessageId = store.getState().currentAssistantMessageId;
  if (!currentAssistantMessageId) return;
  const timestamp = Date.now();

  store.setState((state) => {
    let changed = false;
    const messages = state.messages.map((message) => {
      if (message.id !== currentAssistantMessageId) return message;

      const parts = message.parts.map((part) => {
        if (part.type !== "tool" || (part.state !== "pending" && part.state !== "running")) return part;

        changed = true;
        const hasAttempt = part.attemptId !== undefined;
        const settledPart: ErrorToolPart = {
          type: "tool",
          id: part.id,
          state: "error",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: "input" in part ? part.input : undefined,
          errorMessage: hasAttempt
            ? "Tool execution result unknown: execution was interrupted"
            : "Execution ended before tool result",
          createdAt: part.createdAt,
          startedAt: "startedAt" in part ? part.startedAt : timestamp,
          endedAt: timestamp,
          ...(hasAttempt ? { meta: { unknownResult: true } } : {}),
          ...(part.attemptId !== undefined ? { attemptId: part.attemptId } : {}),
          ...(part.attemptTimestamp !== undefined ? { attemptTimestamp: part.attemptTimestamp } : {}),
          ...(part.attemptDestructive !== undefined ? { attemptDestructive: part.attemptDestructive } : {}),
        };
        return settledPart;
      });

      return changed ? { ...message, parts } : message;
    });

    return changed ? { messages } : {};
  });
}

function hasRecoveryAttempts(attempts: {
  recoveredFromFailure: boolean;
  sessionRetryAttempt: number;
  zeroOutputShortAttempt: number;
  lastRecoveryAttempt: number;
}): boolean {
  return attempts.recoveredFromFailure || attempts.sessionRetryAttempt > 0 || attempts.zeroOutputShortAttempt > 0 || attempts.lastRecoveryAttempt > 0;
}

function computeSessionRetryDelayMs(attempt: number, error: unknown): number {
  const retryAfterMs = getRetryAfterMs(error);
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, SESSION_RETRY_MAX_DELAY_MS);
  const exponential = SESSION_RETRY_INITIAL_DELAY_MS * SESSION_RETRY_FACTOR ** Math.max(0, attempt - 1);
  return Math.min(exponential, SESSION_RETRY_MAX_DELAY_MS);
}

function getRetryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  const headers = record.headers;
  const candidates = [record.retryAfter, record.retryAfterMs];
  if (headers && typeof headers === "object") {
    const headerRecord = headers as Record<string, unknown> & { get?: (name: string) => unknown };
    candidates.push(headerRecord["retry-after"], headerRecord["Retry-After"], headerRecord.get?.("retry-after"));
  }

  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate > 1_000 ? candidate : candidate * 1_000;
    }
    if (typeof candidate === "string") {
      const seconds = Number(candidate);
      if (Number.isFinite(seconds)) return seconds * 1_000;
      const dateMs = Date.parse(candidate);
      if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
    }
  }

  return undefined;
}

async function sleepAbortable(ms: number, abort: AbortSignal): Promise<void> {
  if (ms <= 0 || abort.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(done, ms);
    function done() {
      clearTimeout(timeout);
      abort.removeEventListener("abort", done);
      resolve();
    }
    abort.addEventListener("abort", done, { once: true });
  });
}

async function executeToolCalls(
  toolCalls: ToolCallArray,
  registry: ToolRegistry,
  store: StoreApi<SessionStoreState>,
  step: number,
  abort: AbortSignal,
  allowedTools: readonly string[],
  projectContext: QueryLoopOptions["projectContext"],
  confirmPermission: QueryLoopOptions["confirmPermission"],
  askUser: QueryLoopOptions["askUser"] | undefined,
  startChildExecution: NonNullable<QueryLoopOptions["startChildExecution"]> | undefined,
  agentName: string | undefined,
  agentSkills: QueryLoopOptions["agentSkills"],
  skillService: QueryLoopOptions["skillService"],
  storeManager: QueryLoopOptions["storeManager"],
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
            agentSkills,
            skillService,
            storeManager,
            ...(confirmPermission ? { confirmPermission } : {}),
            ...(askUser ? { askUser } : {}),
            ...(startChildExecution ? { startChildExecution } : {}),
            ...(agentName ? { agentName } : {}),
            ...(currentDepth !== undefined ? { currentDepth } : {}),
            onInputResolved(redactedInput) {
              store.getState().append({
                type: "tool-input-resolved",
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                input: redactedInput,
              });
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
        agentSkills,
        skillService,
        storeManager,
        ...(confirmPermission ? { confirmPermission } : {}),
        ...(askUser ? { askUser } : {}),
        ...(startChildExecution ? { startChildExecution } : {}),
        ...(agentName ? { agentName } : {}),
        ...(currentDepth !== undefined ? { currentDepth } : {}),
        onInputResolved(redactedInput) {
          store.getState().append({
            type: "tool-input-resolved",
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            input: redactedInput,
          });
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
