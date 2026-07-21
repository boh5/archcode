import type { ModelMessage, StreamTextResult, ToolSet } from "ai";
import type { StoreApi } from "zustand";
import type { Logger } from "../../logger";
import { toDurableToolInput } from "../../store/durable-tool-input";
import type { ExecutionEndEvent, SessionStoreState } from "../../store/types";
import type { SessionToolManualInspectionReason } from "../../store/types";
import { createToolExecutionContext } from "../../tools/index";
import type { RawToolResult, ToolCallLike, ToolExecutionContext } from "../../tools/index";
import type { ToolRegistry } from "../../tools/registry";
import { createToolErrorResult } from "../../tools/errors";
import { DOOM_LOOP_MESSAGE, type NormalizedToolCall, type QueryLoopOptions, type QueryLoopResult } from "./types";
import { redactValue } from "../../security";
import { classifyLlmError, runLlmStream } from "../../llm";
import { redactSensitiveValue, sanitizeProviderError, type SensitiveTextRedactor } from "../../llm/provider-error-sanitizer";
import { parseRetryAfter, realRetryScheduler, type RetryScheduler } from "../../llm/retry";
import type { BeforeModelBuildContext, BeforeModelCallContext } from "./loop-hooks";
import { SessionToolBatchScheduler, type SessionToolBatchAdvanceResult } from "../../execution/session-tool-batch-scheduler";

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
  binding: QueryLoopOptions["binding"];
  systemPrompt: QueryLoopOptions["systemPrompt"];
  toolRegistry: ToolRegistry;
  allowedTools: readonly string[];
  abort: AbortSignal;
  logger: Logger;
  sessionId: string;
  agentName: string;
  projectContext: QueryLoopOptions["projectContext"];
  beforeModelBuild: HookList<BeforeModelBuildContext>;
  beforeModelCall: HookList<BeforeModelCallContext>;
  consumeSteers?: () => Promise<void>;
  settleUnfinalizedToolParts: () => Promise<void>;
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

interface ToolBatchExecutionResult {
  readonly sessionCwdChanged: boolean;
  readonly executionCompleted?: boolean;
  readonly waitingForHuman?: boolean;
  readonly manualInspectionReason?: string;
}

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

class ProviderOutputSecretError extends Error {
  readonly statusCode = 400;

  constructor(field: "toolCallId" | "toolName") {
    super(`Provider output contained a configured secret in ${field}`);
    this.name = "ProviderOutputSecretError";
  }
}

async function runModelAttempt(options: ModelAttemptOptions): Promise<ModelAttemptResult> {
  const {
    step,
    store,
    binding,
    systemPrompt,
    toolRegistry,
    allowedTools,
    abort,
    logger,
    sessionId,
    agentName,
    projectContext,
    beforeModelBuild,
    beforeModelCall,
    consumeSteers,
    settleUnfinalizedToolParts,
  } = options;
  const redactProviderSecrets: SensitiveTextRedactor = (text) => binding.modelInfo.redactSensitiveText(text);

  store.getState().append({ type: "step-start", step });

  let messages: ModelMessage[];
  let tools: ToolSet | undefined;

  try {
    await consumeSteers?.();
    await runHooks("beforeModelBuild", beforeModelBuild, { store, binding, logger, abort, systemPrompt }, logger, { sessionId, agentName });
    messages = store.getState().toModelMessages();
    await runHooks("beforeModelCall", beforeModelCall, { store, binding, logger, abort, messages, projectContext }, logger, { sessionId, agentName });
    const resolved = toolRegistry.resolveForAgent(allowedTools);
    tools = resolved.descriptors.length > 0 ? resolved.toAITools() : undefined;
  } catch (err) {
    store.getState().append({ type: "step-end", step, finishReason: "error" });
    throw err;
  }

  let result: AnyStreamTextResult | undefined;
  try {
    result = runLlmStream({
      model: binding.modelInfo.model,
      modelOptions: binding.options,
      messages,
      abortSignal: abort,
      ...(tools ? { tools } : {}),
      ...(systemPrompt ? { system: systemPrompt } : {}),
    });

    const { streamError } = await consumeFullStream(
      result.fullStream as AsyncIterable<TextStreamPart>,
      store,
      binding,
      abort,
    );
    const finalized = await finalizeModelResult(result, streamError, store, step, abort, redactProviderSecrets);
    if (finalized.outcome !== "success") {
      if (finalized.outcome === "retry") await settleUnfinalizedToolParts();
      return finalized;
    }
    return { outcome: "success", finalized: finalized.finalized, streamError };
  } catch (err) {
    await settleModelResultPromises(result);
    const failure = buildRetryOrTerminalFailure(err, store, step, abort, redactProviderSecrets);
    store.getState().append({
      type: "step-end",
      step,
      finishReason: failure.outcome === "retry" ? "interrupted" : "error",
    });
    if (failure.outcome === "retry") await settleUnfinalizedToolParts();
    return failure;
  }
}

async function settleModelResultPromises(result: AnyStreamTextResult | undefined): Promise<void> {
  if (!result) return;
  await Promise.allSettled([
    result.finishReason,
    result.usage,
    result.text,
    result.toolCalls,
  ]);
}

export async function runQueryLoop(
  options: QueryLoopOptions,
  retryScheduler: RetryScheduler = realRetryScheduler,
): Promise<QueryLoopResult> {
  const {
    binding,
    toolRegistry,
    allowedTools,
    systemPrompt,
    maxSteps = DEFAULT_MAX_STEPS,
    store,
    currentDepth,
  } = options;
  const { beforeModelBuild, beforeModelCall, afterStepEnd, afterLoopEnd } = options.hooks ?? {};
  const abort = options.abort ?? new AbortController().signal;
  const executionCwd = options.cwd;
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
  let runEndError: string | undefined;
  let recoveredFromFailure = false;
  let zeroOutputShortAttempt = 0;
  let sessionRetryAttempt = 0;
  let lastRecoveryAttempt = 0;
  let continuationClaimed = false;
  const doomTracker = new DoomTracker();
  const createContext = async (toolCall: ToolCallLike, step: number): Promise<ToolExecutionContext> => createToolExecutionContext({
    store,
    toolName: toolCall.toolName,
    toolCallId: toolCall.toolCallId,
    input: toolCall.input,
    redactedInput: redactValue(toolCall.input),
    step,
    abort,
    startedAt: Date.now(),
    allowedTools: new Set(allowedTools),
    projectContext: options.projectContext,
    ...(options.sessionGoalService === undefined ? {} : { sessionGoalService: options.sessionGoalService }),
    ...(options.consumeFreshUserInput === undefined ? {} : { consumeFreshUserInput: options.consumeFreshUserInput }),
    cwd: executionCwd,
    agentSkills: options.agentSkills,
    skillService: options.skillService,
    storeManager: options.storeManager,
    outputArtifacts: options.toolOutputAccess,
    ...(options.startChildExecution === undefined ? {} : { startChildExecution: options.startChildExecution }),
    ...(options.cancelChildSession === undefined ? {} : { cancelChildSession: options.cancelChildSession }),
    ...(options.resumeChildSession === undefined ? {} : { resumeChildSession: options.resumeChildSession }),
    ...(options.acquireSessionCwdTransition === undefined ? {} : { acquireSessionCwdTransition: options.acquireSessionCwdTransition }),
    agentName: options.agentName,
    ...(currentDepth === undefined ? {} : { currentDepth }),
    onInputResolved(redactedInput) {
      store.getState().append({ type: "tool-input-resolved", toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, input: redactedInput });
    },
    async onToolAttempt(attempt) {
      store.getState().append({
        type: "tool-attempt",
        toolCallId: attempt.toolCallId,
        toolName: attempt.toolName,
        attemptId: attempt.attemptId,
        timestamp: attempt.timestamp,
        destructive: attempt.destructive,
      });
      await options.storeManager.flushSession(sessionId, options.projectContext.project.workspaceRoot);
    },
  });
  const toolBatchScheduler = new SessionToolBatchScheduler({
    store,
    storeManager: options.storeManager,
    workspaceRoot: options.projectContext.project.workspaceRoot,
    registry: toolRegistry,
    hitlQueue: options.projectContext.hitl,
    agentName: store.getState().agentName,
    allowedTools,
    agentSkills: options.agentSkills,
    createContext,
  });

  try {
    if (toolBatchScheduler.activeBatch() !== undefined) {
      const startupBatch = await toolBatchScheduler.recoverInterruptedBatch();
      if (startupBatch === undefined) throw new Error("Active tool batch disappeared during recovery");
      const startupResult = finishToolBatchAdvance(startupBatch, executionCwd, store, lastText, steps);
      if (startupResult !== undefined) {
        runEndStatus = startupResult.runEndStatus;
        return startupResult.result;
      }
    } else {
      await settleUnfinalizedToolPartsForRecovery(store, toolRegistry, createContext, steps);
      await options.storeManager.flushSession(sessionId, options.projectContext.project.workspaceRoot);
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

      const activeBatch = toolBatchScheduler.activeBatch();
      const continuingBatch = activeBatch !== undefined;
      if (activeBatch !== undefined) {
        if (!continuationClaimed) continuationClaimed = await toolBatchScheduler.claimContinuation();
        if (!continuationClaimed) {
          runEndStatus = "failed";
          runEndError = `Tool batch ${activeBatch.batchId} already started its one allowed LLM continuation`;
          store.getState().append({
            type: "execution-error",
            step: steps,
            error: runEndError,
          });
          return { text: lastText, steps, status: runEndStatus, error: runEndError };
        }
      }

      const systemPrompt = options.resolveSystemPrompt === undefined
        ? options.systemPrompt
        : await options.resolveSystemPrompt();
      const attempt = await runModelAttempt({
        step: steps,
        store,
        binding,
        systemPrompt,
        toolRegistry,
        allowedTools,
        abort,
        logger,
        sessionId,
        agentName,
        projectContext: options.projectContext,
        beforeModelBuild,
        beforeModelCall,
        consumeSteers: options.consumeSteers,
        settleUnfinalizedToolParts: async () => {
          await settleUnfinalizedToolPartsForRecovery(store, toolRegistry, createContext, steps);
          await options.storeManager.flushSession(sessionId, options.projectContext.project.workspaceRoot);
        },
      });

      if (attempt.outcome === "retry") {
        recoveredFromFailure = true;
        lastRecoveryAttempt = attempt.recoveryAttempt;
        if (attempt.hadDurableOutput) {
          zeroOutputShortAttempt = 0;
          sessionRetryAttempt = 0;
          const delayMs = computeSessionRetryDelayMs(attempt.recoveryAttempt, attempt.error, retryScheduler);
          const nextRetryAt = retryScheduler.now() + delayMs;
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
          await retryScheduler.sleep(delayMs, abort);
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
        const delayMs = computeSessionRetryDelayMs(sessionRetryAttempt, attempt.error, retryScheduler);
        const nextRetryAt = retryScheduler.now() + delayMs;
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
        await retryScheduler.sleep(delayMs, abort);
        continue;
      }

      if (attempt.outcome === "terminal") {
        if (attempt.finalizationKind) {
          appendPostStreamTerminalFailure(store, attempt.error, steps, attempt.finalizationKind);
          await settleUnfinalizedToolPartsForRecovery(store, toolRegistry, createContext, steps);
          await options.storeManager.flushSession(sessionId, options.projectContext.project.workspaceRoot);
          markCurrentAssistantModelOutputDiscardedFromContext(store);
        } else {
          store.getState().append({
            type: "execution-error",
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
        runEndError = attempt.message;
        return { text: lastText, steps, status: runEndStatus, error: runEndError };
      }

      const { finalized } = attempt;

      if (continuingBatch) {
        await toolBatchScheduler.completeContinuation();
        continuationClaimed = false;
      }

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
      await runHooks("afterStepEnd", afterStepEnd, { store, binding, logger, abort, projectContext: options.projectContext }, logger, { sessionId, agentName });

      if (finalized.finishReason !== "tool-calls") break;

      const toolCalls = finalized.toolCalls ?? [];
      if (abort.aborted) break;
      const toolExecution = await executeToolCalls(
        toolCalls,
        toolBatchScheduler,
        steps,
        doomTracker,
      );

      steps++;
      if (toolExecution.sessionCwdChanged) {
        return {
          text: lastText,
          steps,
          status: runEndStatus,
          cwdChanged: {
            previousCwd: executionCwd,
            cwd: store.getState().cwd,
          },
        };
      }
      if (toolExecution.executionCompleted) {
        return { text: lastText, steps, status: "completed" };
      }
      if (toolExecution.waitingForHuman) {
        runEndStatus = "waiting_for_human";
        return { text: lastText, steps, status: runEndStatus };
      }
      if (toolExecution.manualInspectionReason !== undefined) {
        runEndStatus = "failed";
        runEndError = toolExecution.manualInspectionReason;
        store.getState().append({ type: "execution-error", step: steps, error: runEndError });
        return { text: lastText, steps, status: runEndStatus, error: runEndError };
      }
    }

    if (steps >= maxSteps) {
      runEndStatus = "max_steps";
      runEndError = `Max steps (${maxSteps}) reached`;
      store.getState().append({
        type: "execution-error",
        step: steps,
        error: runEndError,
      });
    }

    if (abort.aborted && runEndStatus === "completed") runEndStatus = "aborted";
    return {
      text: lastText,
      steps,
      status: runEndStatus,
      ...(runEndError === undefined ? {} : { error: runEndError }),
    };
  } catch (err) {
    const safeError = sanitizeProviderError(err, (text) => binding.modelInfo.redactSensitiveText(text));
    failed = true;
    runEndStatus = abort.aborted ? "aborted" : "failed";
    runEndError = safeError.message;
    logger.error("query.loop.fatal", {
      error: safeError,
      context: { step: steps, sessionId, agentName },
    });
    store.getState().append({
      type: "execution-error",
      step: steps,
      error: safeError.message,
    });
    // Model-call failures are finalized inside runModelAttempt. Reaching this
    // catch without an active recovery means an outer loop/tool failure, which
    // must not be mislabeled as an LLM failure in the transcript.
    if (abort.aborted || recoveredFromFailure) {
      const classification = classifyLlmError(safeError);
      appendTerminalLlmFailureNotice(store, safeError, classification.kind, {
        steps,
        recoveredFromFailure,
        sessionRetryAttempt,
        zeroOutputShortAttempt,
        lastRecoveryAttempt,
      });
    }
    return { text: lastText, steps, status: runEndStatus, error: runEndError };
  } finally {
    if (abort.aborted && !failed && runEndStatus === "completed") {
      runEndStatus = "aborted";
    }

    await runHooks("afterLoopEnd", afterLoopEnd, { store, binding, logger, abort, loopEndStatus: runEndStatus, projectContext: options.projectContext }, logger, { sessionId, agentName });
  }
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
  binding: QueryLoopOptions["binding"],
  abort?: AbortSignal,
): Promise<{ streamError?: unknown }> {
  let textOpen = false;
  let reasoningOpen = false;
  let streamError: unknown;
  const textRedactor = binding.modelInfo.createSensitiveTextStream();
  const reasoningRedactor = binding.modelInfo.createSensitiveTextStream();

  const appendText = (text: string): void => {
    if (text.length === 0) return;
    if (!textOpen) {
      store.getState().append({ type: "text-start" });
      textOpen = true;
    }
    store.getState().append({ type: "text-delta", text });
  };
  const appendReasoning = (text: string): void => {
    if (text.length === 0) return;
    if (!reasoningOpen) {
      store.getState().append({ type: "reasoning-start" });
      reasoningOpen = true;
    }
    store.getState().append({ type: "reasoning-delta", text });
  };

  try {
    for await (const chunk of fullStream) {
      if (abort?.aborted) break;

      if (chunk.type === "error") {
        streamError = chunk.error;
        continue;
      }

      if (chunk.type === "text-delta") {
        appendText(textRedactor.push(chunk.text));
        continue;
      }

      if (chunk.type === "reasoning-delta") {
        appendReasoning(reasoningRedactor.push(chunk.text));
        continue;
      }

      if (chunk.type === "tool-input-start") {
        assertSafeProviderToolIdentifier(chunk.id, "toolCallId", binding);
        assertSafeProviderToolIdentifier(chunk.toolName, "toolName", binding);
        store.getState().append({
          type: "tool-input-start",
          toolCallId: chunk.id,
          toolName: chunk.toolName,
        });
        continue;
      }

      if (chunk.type === "tool-call") {
        assertSafeProviderToolIdentifier(chunk.toolCallId, "toolCallId", binding);
        assertSafeProviderToolIdentifier(chunk.toolName, "toolName", binding);
        store.getState().append({
          type: "tool-call",
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          input: redactValue(binding.modelInfo.redactSensitiveValue(chunk.input)),
        });
      }
    }
  } finally {
    appendText(textRedactor.flush());
    appendReasoning(reasoningRedactor.flush());
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
  redactProviderSecrets: SensitiveTextRedactor,
): Promise<{ outcome: "success"; finalized: FinalizedModelResult } | RetryOrTerminalAttemptResult> {
  let finishReason: string;
  let usage: unknown;
  let text: string;

  try {
    finishReason = await result.finishReason;
    usage = await result.usage;
    text = redactProviderSecrets(await result.text);
  } catch (err) {
    return handleFinalizationFailure(preferStreamError(streamError, err), store, step, abort, "result", redactProviderSecrets);
  }

  if (finishReason !== "tool-calls") {
    return { outcome: "success", finalized: { finishReason, usage, text } };
  }

  try {
    const toolCalls = (await result.toolCalls).map((toolCall) => {
      assertSafeProviderToolIdentifier(toolCall.toolCallId, "toolCallId", redactProviderSecrets);
      assertSafeProviderToolIdentifier(toolCall.toolName, "toolName", redactProviderSecrets);
      return {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        input: redactSensitiveValue(toolCall.input, redactProviderSecrets),
      };
    });
    return { outcome: "success", finalized: { finishReason, usage, text, toolCalls } };
  } catch (err) {
    return handleFinalizationFailure(preferStreamError(streamError, err), store, step, abort, "toolCalls", redactProviderSecrets);
  }
}

function assertSafeProviderToolIdentifier(
  value: string,
  field: "toolCallId" | "toolName",
  bindingOrRedactor: QueryLoopOptions["binding"] | SensitiveTextRedactor,
): void {
  const redacted = typeof bindingOrRedactor === "function"
    ? bindingOrRedactor(value)
    : bindingOrRedactor.modelInfo.redactSensitiveText(value);
  if (redacted !== value) throw new ProviderOutputSecretError(field);
}

function handleFinalizationFailure(
  err: unknown,
  store: StoreApi<SessionStoreState>,
  step: number,
  abort: AbortSignal,
  kind: FinalizationKind,
  redactProviderSecrets: SensitiveTextRedactor,
): RetryOrTerminalAttemptResult {
  const failure = buildRetryOrTerminalFailure(err, store, step, abort, redactProviderSecrets);

  if (failure.outcome === "retry") {
    if (isStepOpen(store, step)) {
      store.getState().append({ type: "step-end", step, finishReason: "interrupted" });
    }
    return failure;
  }

  return { ...failure, finalizationKind: kind };
}

function buildRetryOrTerminalFailure(
  err: unknown,
  store: StoreApi<SessionStoreState>,
  step: number,
  abort: AbortSignal,
  redactProviderSecrets: SensitiveTextRedactor,
): RetryOrTerminalAttemptResult {
  const classification = classifyLlmError(err, { boundary: "provider-request" });
  const safeError = sanitizeProviderError(err, redactProviderSecrets);
  if (classification.kind === "abort") throw safeError;

  if (classification.retryable && !abort.aborted) {
    return {
      outcome: "retry",
      error: safeError,
      errorKind: classification.kind,
      message: safeError.message,
      hadDurableOutput: hasCurrentStepDurableOutput(store),
      recoveryAttempt: countRecoveryAttempts(store, step) + 1,
    };
  }

  return {
    outcome: "terminal",
    error: safeError,
    errorKind: classification.kind,
    message: safeError.message,
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
    type: "execution-error",
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

async function settleUnfinalizedToolPartsForRecovery(
  store: StoreApi<SessionStoreState>,
  registry: ToolRegistry,
  createContext: (call: ToolCallLike, step: number) => Promise<ToolExecutionContext>,
  step: number,
): Promise<void> {
  const parts = store.getState().messages.flatMap((message) => message.parts.filter(
    (part) => part.type === "tool" && (part.state === "pending" || part.state === "running"),
  ));
  for (const part of parts) {
    const hasAttempt = part.attemptId !== undefined;
    const call: ToolCallLike = {
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      input: toDurableToolInput("input" in part ? part.input : undefined),
    };
    const raw = createToolErrorResult({
      kind: "execution",
      code: hasAttempt ? "TOOL_RESULT_UNKNOWN" : "TOOL_NOT_EXECUTED",
      message: hasAttempt
        ? "Tool execution result is unknown because execution was interrupted"
        : "Execution ended before the tool ran",
    });
    const outcome = await registry.settleSystem(call, await createContext(call, step), hasAttempt
      ? { ...raw, details: { ...raw.details, unknownResult: true } }
      : raw);
    if (outcome.kind !== "settled") throw new Error("Recovery system result unexpectedly blocked");
    store.getState().append({
      type: "tool-result",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      result: outcome.result,
    });
  }
}

function hasRecoveryAttempts(attempts: {
  recoveredFromFailure: boolean;
  sessionRetryAttempt: number;
  zeroOutputShortAttempt: number;
  lastRecoveryAttempt: number;
}): boolean {
  return attempts.recoveredFromFailure || attempts.sessionRetryAttempt > 0 || attempts.zeroOutputShortAttempt > 0 || attempts.lastRecoveryAttempt > 0;
}

function computeSessionRetryDelayMs(attempt: number, error: unknown, retryScheduler: RetryScheduler): number {
  const retryAfterMs = parseRetryAfter(error, retryScheduler);
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, SESSION_RETRY_MAX_DELAY_MS);
  const exponential = SESSION_RETRY_INITIAL_DELAY_MS * SESSION_RETRY_FACTOR ** Math.max(0, attempt - 1);
  return Math.min(exponential, SESSION_RETRY_MAX_DELAY_MS);
}

async function executeToolCalls(
  toolCalls: ToolCallArray,
  scheduler: SessionToolBatchScheduler,
  step: number,
  doomTracker?: DoomTracker,
): Promise<ToolBatchExecutionResult> {
  const doomCallIds = new Set<string>();
  for (const toolCall of toolCalls) {
    if (doomTracker?.check(toolCall)) doomCallIds.add(toolCall.toolCallId);
  }
  if (toolCalls.length === 0) return { sessionCwdChanged: false };
  await scheduler.createBatch(toolCalls, step);
  for (const toolCallId of doomCallIds) {
    await scheduler.settleQueuedCall(toolCallId, createToolErrorResult({
      kind: "execution",
      code: "TOOL_DOOM_LOOP",
      message: DOOM_LOOP_MESSAGE,
    }));
  }
  return toolBatchExecutionResult(await scheduler.advance());
}

function toolBatchExecutionResult(result: SessionToolBatchAdvanceResult): ToolBatchExecutionResult {
  if (result.status === "manual_inspection_required") {
    return { sessionCwdChanged: false, manualInspectionReason: manualInspectionMessage(result.reason) };
  }
  return {
    sessionCwdChanged: result.sessionCwdChanged,
    ...(result.status === "execution_completed" ? { executionCompleted: true } : {}),
    ...(result.status === "waiting_for_human" ? { waitingForHuman: true } : {}),
  };
}

function finishToolBatchAdvance(
  result: SessionToolBatchAdvanceResult,
  executionCwd: string,
  store: StoreApi<SessionStoreState>,
  text: string,
  steps: number,
): { runEndStatus: ExecutionEndEvent["status"]; result: QueryLoopResult } | undefined {
  if (result.status === "manual_inspection_required") {
    const reason = manualInspectionMessage(result.reason);
    store.getState().append({ type: "execution-error", step: steps, error: reason });
    return { runEndStatus: "failed", result: { text, steps, status: "failed", error: reason } };
  }
  if (result.sessionCwdChanged) {
    return {
      runEndStatus: "completed",
      result: { text, steps, status: "completed", cwdChanged: { previousCwd: executionCwd, cwd: store.getState().cwd } },
    };
  }
  if (result.status === "execution_completed") {
    return { runEndStatus: "completed", result: { text, steps, status: "completed" } };
  }
  if (result.status === "waiting_for_human") {
    return { runEndStatus: "waiting_for_human", result: { text, steps, status: "waiting_for_human" } };
  }
  return undefined;
}

function manualInspectionMessage(reason: SessionToolManualInspectionReason): string {
  if (reason.kind === "continuation_interrupted") {
    return `LLM continuation for tool batch ${reason.batchId} was interrupted`;
  }
  return reason.kind === "effectful_cancelled_unknown"
    ? `Effectful tool ${reason.toolName} (${reason.toolCallId}) was interrupted during cancellation; its outcome requires manual inspection`
    : `Effectful tool ${reason.toolName} (${reason.toolCallId}) has an unknown outcome and requires manual inspection`;
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
