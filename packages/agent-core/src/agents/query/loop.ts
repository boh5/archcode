import type { ModelMessage, StreamTextResult, ToolSet } from "ai";
import { interruptIncompleteToolParts, TOOL_TOOL_SEARCH } from "@archcode/protocol";
import { sortJsonValue } from "@archcode/utils";
import type { StoreApi } from "zustand";
import type { SessionExecutionTerminalStatus } from "@archcode/protocol";
import type { Logger } from "../../logger";
import { toDurableToolInput } from "../../store/durable-tool-input";
import type { SessionStoreManager } from "../../store/session-store-manager";
import type { ExecutionEndEvent, SessionStoreState } from "../../store/types";
import type { SessionToolManualInspectionReason } from "../../store/types";
import { createToolExecutionContext } from "../../tools/index";
import type { RawToolResult, ToolCallLike, ToolExecutionContext } from "../../tools/index";
import type { ResolvedToolSet, ToolRegistry } from "../../tools/registry";
import { isDeterministicRepeatedToolErrorCode } from "../../tools/errors";
import { type QueryLoopOptions, type QueryLoopResult } from "./types";
import { classifyLlmError, runLlmStream } from "../../llm";
import { redactSensitiveValue, sanitizeProviderError, type SensitiveTextRedactor } from "../../llm/provider-error-sanitizer";
import { parseRetryAfter, realRetryScheduler, type RetryScheduler } from "../../llm/retry";
import type { BeforeModelBuildContext, BeforeModelCallContext } from "./loop-hooks";
import { SessionToolBatchScheduler, type SessionToolBatchAdvanceResult } from "../../execution/session-tool-batch-scheduler";
import { LiveToolOutputPublisher } from "../../tool-output/live-publisher";
import { sanitizeToolSearchInput } from "../../tools/builtins/tool-search";

export const DEFAULT_QUERY_MAX_STEPS = 50;
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
  stepId: string;
  store: StoreApi<SessionStoreState>;
  binding: QueryLoopOptions["binding"];
  systemPrompt: QueryLoopOptions["systemPrompt"];
  resolveSystemPrompt?: QueryLoopOptions["resolveSystemPrompt"];
  resolveModelBoundary?: QueryLoopOptions["resolveModelBoundary"];
  toolRegistry: ToolRegistry;
  allowedTools: readonly string[];
  abort: AbortSignal;
  logger: Logger;
  sessionId: string;
  agentName: string;
  projectContext: QueryLoopOptions["projectContext"];
  storeManager: QueryLoopOptions["storeManager"];
  attachmentProjector: QueryLoopOptions["attachmentProjector"];
  beforeModelBuild: HookList<BeforeModelBuildContext>;
  beforeModelCall: HookList<BeforeModelCallContext>;
  consumeSteers?: () => Promise<void>;
  prepareModelContext?: () => Promise<void>;
  settleUnfinalizedToolParts: () => Promise<void>;
}

type ModelAttemptResult =
  | {
      outcome: "success";
      stepId: string;
      finalized: FinalizedModelResult;
      tools: ResolvedToolSet;
      catalogDigest?: string;
    }
  | {
      outcome: "terminal";
      stepId: string;
      error: unknown;
      errorKind: string;
      message: string;
      finalizationKind?: FinalizationKind;
    }
  | {
      outcome: "retry";
      stepId: string;
      error: unknown;
      errorKind: string;
      message: string;
      hadDurableOutput: boolean;
    };

interface FinalizedModelResult {
  finishReason: string;
  usage: unknown;
  text: string;
  toolCalls?: ToolCallArray;
}

type FinalizationKind = "stream" | "result" | "toolCalls";

type RetryOrTerminalAttemptResult =
  | Omit<Extract<ModelAttemptResult, { outcome: "terminal" }>, "stepId">
  | Omit<Extract<ModelAttemptResult, { outcome: "retry" }>, "stepId">;

type ToolCallArray = Array<{
  toolCallId: string;
  toolName: string;
  input: unknown;
}>;

interface ToolBatchExecutionResult {
  readonly sessionCwdChanged: boolean;
  readonly executionCompleted?: boolean;
  readonly suspension?: Extract<import("@archcode/protocol").SessionExecutionSuspension, { kind: "hitl" | "child_dependency" }>;
  readonly manualInspectionReason?: string;
  readonly repeatedFailure?: RepeatedFailure;
}

interface RepeatedFailure {
  readonly toolName: string;
  readonly errorCode: string;
  readonly step: number;
  readonly stepId: string;
}

class RepeatedFailureTracker {
  constructor(
    private readonly store: StoreApi<SessionStoreState>,
    private readonly executionId: string,
  ) {}

  findThreshold(): RepeatedFailure | undefined {
    const counts = new Map<string, Map<string, number>>();
    const calls = this.store.getState().toolBatches
      .filter((batch) => batch.executionId === this.executionId)
      .flatMap((batch) => batch.calls.map((call) => ({ batch, call })))
      .filter(({ call }) => call.result !== undefined)
      .sort((left, right) => (
        left.batch.step - right.batch.step
        || left.call.ordinal - right.call.ordinal
      ));

    for (const { batch, call } of calls) {
      const callKey = `${call.toolName}\0${canonicalizeToolInput(call.input)}`;
      if (call.result!.isError === false) {
        counts.delete(callKey);
        continue;
      }
      const errorCode = call.result!.details?.error?.code;
      if (!isDeterministicRepeatedToolErrorCode(errorCode)) continue;
      const errorCounts = counts.get(callKey) ?? new Map<string, number>();
      const next = (errorCounts.get(errorCode!) ?? 0) + 1;
      errorCounts.set(errorCode!, next);
      counts.set(callKey, errorCounts);
      if (next >= 3) {
        return {
          toolName: call.toolName,
          errorCode: errorCode!,
          step: batch.step,
          stepId: batch.stepId,
        };
      }
    }
    return undefined;
  }
}

class ProviderOutputSecretError extends Error {
  readonly statusCode = 400;

  constructor(field: "toolCallId" | "toolName" | "textBlockId" | "reasoningBlockId") {
    super(`Provider output contained a configured secret in ${field}`);
    this.name = "ProviderOutputSecretError";
  }
}

class MalformedProviderStreamError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "MalformedProviderStreamError";
  }
}

class ModelAttemptPreparationError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ModelAttemptPreparationError";
  }
}

async function runModelAttempt(options: ModelAttemptOptions): Promise<ModelAttemptResult> {
  const {
    step,
    stepId,
    store,
    binding,
    systemPrompt: staticSystemPrompt,
    resolveSystemPrompt,
    resolveModelBoundary,
    toolRegistry,
    allowedTools,
    abort,
    logger,
    sessionId,
    agentName,
    projectContext,
    storeManager,
    attachmentProjector,
    beforeModelBuild,
    beforeModelCall,
    consumeSteers,
    prepareModelContext,
    settleUnfinalizedToolParts,
  } = options;
  const redactProviderSecrets: SensitiveTextRedactor = (text) => binding.modelInfo.redactSensitiveText(text);

  let messages: ModelMessage[];
  let tools: ToolSet | undefined;
  let resolvedTools: ResolvedToolSet;
  let catalogDigest: string | undefined;
  let systemPrompt = staticSystemPrompt;
  let stepStarted = false;

  try {
    await consumeSteers?.();
    await prepareModelContext?.();
    const modelBoundary = await resolveModelBoundary?.();
    systemPrompt = modelBoundary?.systemPrompt
      ?? (resolveSystemPrompt === undefined ? staticSystemPrompt : await resolveSystemPrompt());
    resolvedTools = modelBoundary?.tools ?? toolRegistry.resolveForAgent(allowedTools);
    catalogDigest = modelBoundary?.catalogDigest;
    await runHooks("beforeModelBuild", beforeModelBuild, { store, binding, logger, abort, systemPrompt }, logger, { sessionId, agentName });
    await prepareModelContext?.();
    const projection = store.getState().toModelMessagesProjection();
    messages = projection.messages;
    await runHooks("beforeModelCall", beforeModelCall, { store, binding, logger, abort, messages, projectContext }, logger, { sessionId, agentName });
    await attachmentProjector.project({
      messages,
      attachmentSlots: projection.attachmentSlots,
      workspaceRoot: projectContext.project.workspaceRoot,
      rootSessionId: store.getState().rootSessionId,
      supportsImages: binding.modelInfo.modalities.input.includes("image"),
    });
    tools = resolvedTools.descriptors.length > 0 ? resolvedTools.toAITools() : undefined;
    store.getState().append({ type: "step-start", stepId, step });
    stepStarted = true;
    await storeManager.flushSession(sessionId, projectContext.project.workspaceRoot);
  } catch (err) {
    if (stepStarted) {
      store.getState().append({ type: "step-end", stepId, step, finishReason: "error" });
      throw err;
    }
    throw new ModelAttemptPreparationError(err);
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

    const { streamError, hasStreamError } = await consumeFullStream(
      result.fullStream as AsyncIterable<TextStreamPart>,
      store,
      binding,
      stepId,
      abort,
    );
    const finalized = await finalizeModelResult(
      result,
      streamError,
      hasStreamError,
      store,
      stepId,
      step,
      abort,
      redactProviderSecrets,
    );
    if (finalized.outcome !== "success") {
      if (finalized.outcome === "retry") await settleUnfinalizedToolParts();
      return { ...finalized, stepId };
    }
    return {
      outcome: "success",
      stepId,
      finalized: finalized.finalized,
      tools: resolvedTools,
      ...(catalogDigest === undefined ? {} : { catalogDigest }),
    };
  } catch (err) {
    await settleModelResultPromises(result, abort);
    if (classifyLlmError(err, { boundary: "provider-request" }).kind === "abort") {
      if (isStepOpen(store, stepId)) {
        store.getState().append({ type: "step-end", stepId, step, finishReason: "interrupted" });
      }
      await settleUnfinalizedToolParts();
      throw sanitizeProviderError(err, redactProviderSecrets);
    }
    const failure = buildRetryOrTerminalFailure(err, store, stepId, step, abort, redactProviderSecrets);
    store.getState().append({
      type: "step-end",
      stepId,
      step,
      finishReason: failure.outcome === "retry" ? "interrupted" : "error",
    });
    if (failure.outcome === "retry") await settleUnfinalizedToolParts();
    return { ...failure, stepId };
  }
}

async function settleModelResultPromises(
  result: AnyStreamTextResult | undefined,
  abort?: AbortSignal,
): Promise<void> {
  if (!result) return;
  if (abort?.aborted) return;
  try {
    await raceAbort(
      Promise.allSettled([
        Promise.resolve(result.finishReason),
        Promise.resolve(result.usage),
        Promise.resolve(result.text),
        Promise.resolve(result.toolCalls),
      ]).then(() => undefined),
      abort,
    );
  } catch {
  }
}

async function raceAbort<T>(promise: Promise<T>, abort?: AbortSignal): Promise<T> {
  if (!abort) return await promise;
  if (abort.aborted) throw createAbortError(abort);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(createAbortError(abort));
    };
    const cleanup = () => {
      abort.removeEventListener("abort", onAbort);
    };
    abort.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function createAbortError(signal?: AbortSignal): DOMException {
  const reason = signal?.reason;
  if (reason instanceof DOMException) return reason;
  if (reason instanceof Error) return new DOMException(reason.message, "AbortError");
  return new DOMException("The operation was aborted.", "AbortError");
}

export async function runQueryLoop(
  options: QueryLoopOptions,
  retryScheduler: RetryScheduler = realRetryScheduler,
): Promise<QueryLoopResult> {
  const {
    executionId,
    runOrdinal,
    initialStep,
    binding,
    toolRegistry,
    allowedTools,
    maxSteps = DEFAULT_QUERY_MAX_STEPS,
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

  let toolBatchScheduler!: SessionToolBatchScheduler;
  let steps = initialStep;
  let lastText = "";
  let finalOutputStepId: string | undefined;
  let latestStepId: string | undefined;
  let failed = false;
  let runEndStatus: SessionExecutionTerminalStatus = "completed";
  let runEndError: string | undefined;
  let runSuspension: ToolBatchExecutionResult["suspension"];
  let recoveredFromFailure = false;
  let zeroOutputShortAttempt = 0;
  let sessionRetryAttempt = 0;
  let partialOutputRecoveryAttempt = 0;
  let lastRecoveryAttempt = 0;
  let recoveryNoticeStepId: string | undefined;
  const repeatedFailureTracker = new RepeatedFailureTracker(store, executionId);
  const createContext = async (toolCall: ToolCallLike, step: number): Promise<ToolExecutionContext> => {
    const attachmentReadPaths = await options.resolveAttachmentReadPaths();
    const batch = toolBatchScheduler.activeBatch()
      ?? (() => { throw new Error("Tool execution has no active Tool Batch"); })();
    const persistedAllowedTools = new Set(batch.allowedTools);
    const persistedSkills = new Set(batch.agentSkills);
    const liveToolOutput = toolCall.toolName === "bash"
      ? new LiveToolOutputPublisher({ store, toolCallId: toolCall.toolCallId })
      : undefined;
    return createToolExecutionContext({
      store,
      toolName: toolCall.toolName,
      toolCallId: toolCall.toolCallId,
      input: toolCall.input,
      step,
      executionId,
      runOrdinal,
      toolBatchId: batch.batchId,
      abort,
      startedAt: Date.now(),
      allowedTools: persistedAllowedTools,
      projectContext: options.projectContext,
      ...(options.sessionGoalService === undefined ? {} : { sessionGoalService: options.sessionGoalService }),
      cwd: executionCwd,
      attachmentReadPaths,
      agentSkills: options.agentSkills.filter((skill) => persistedSkills.has(skill)),
      skillService: options.skillService,
      ...(options.resolveSkillListTargetSkills === undefined
        ? {}
        : { resolveSkillListTargetSkills: options.resolveSkillListTargetSkills }),
      ...(options.executionSkillSnapshots === undefined
        ? {}
        : { executionSkillSnapshots: options.executionSkillSnapshots }),
      storeManager: options.storeManager,
      outputArtifacts: options.toolOutputAccess,
      ...(options.resolveToolSearch === undefined ? {} : { resolveToolSearch: options.resolveToolSearch }),
      ...(liveToolOutput === undefined ? {} : { liveToolOutput }),
      ...(options.startChildExecution === undefined ? {} : {
        startChildExecution: async (request) => {
          if (!request.request.background) await toolBatchScheduler.prepareChildLaunch(request);
          return await options.startChildExecution!(request);
        },
      }),
      ...(options.cancelDescendantSession === undefined ? {} : {
        cancelDescendantSession: options.cancelDescendantSession,
      }),
      ...(options.sendMessageToChild === undefined ? {} : {
        sendMessageToChild: options.sendMessageToChild,
      }),
      ...(options.resumeChildSession === undefined ? {} : {
        resumeChildSession: async (workspaceRoot, request) => {
          if (!request.background) {
            await toolBatchScheduler.prepareChildLaunch({
              ...request,
              childSessionId: request.sessionId,
            });
          }
          return await options.resumeChildSession!(workspaceRoot, request);
        },
      }),
      ...(options.acquireSessionCwdTransition === undefined ? {} : { acquireSessionCwdTransition: options.acquireSessionCwdTransition }),
      ...(options.getAgentTreeProjection === undefined ? {} : {
        getAgentTreeProjection: options.getAgentTreeProjection,
      }),
      agentName: options.agentName,
      ...(currentDepth === undefined ? {} : { currentDepth }),
      onInputResolved(input) {
        store.getState().append({ type: "tool-input-resolved", toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, input });
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
  };
  toolBatchScheduler = new SessionToolBatchScheduler({
    executionId,
    runOrdinal,
    store,
    storeManager: options.storeManager,
    workspaceRoot: options.projectContext.project.workspaceRoot,
    registry: toolRegistry,
    hitlQueue: options.projectContext.hitl,
    agentName: store.getState().agentName,
    allowedTools,
    agentSkills: options.agentSkills,
    logger: options.logger,
    createContext,
  });

  try {
    if (toolBatchScheduler.activeBatch() !== undefined) {
      const startupBatch = await toolBatchScheduler.recoverInterruptedBatch();
      if (startupBatch === undefined) throw new Error("Active tool batch disappeared during recovery");
      if (toolBatchIsFullySettled(startupBatch)) {
        const repeatedFailure = repeatedFailureTracker.findThreshold();
        if (repeatedFailure !== undefined) {
          const terminal = finishRepeatedFailure(repeatedFailure, store, lastText, steps);
          runEndStatus = terminal.runEndStatus;
          return terminal.result;
        }
      }
      const startupResult = finishToolBatchAdvance(startupBatch, executionCwd, store, lastText, steps);
      if (startupResult !== undefined) {
        runEndStatus = startupResult.runEndStatus;
        if (startupResult.result.outcome === "suspended") {
          runSuspension = startupResult.result.suspension;
        }
        return startupResult.result;
      }
    } else {
      await interruptUnfinalizedToolParts(
        store,
        options.storeManager,
        options.projectContext.project.workspaceRoot,
      );
      await options.storeManager.flushSession(sessionId, options.projectContext.project.workspaceRoot);
      const repeatedFailure = repeatedFailureTracker.findThreshold();
      if (repeatedFailure !== undefined) {
        const terminal = finishRepeatedFailure(repeatedFailure, store, lastText, steps);
        runEndStatus = terminal.runEndStatus;
        return terminal.result;
      }
    }

    while (steps < maxSteps) {
      if (abort.aborted) {
        const err = abort.reason ?? new DOMException("Aborted", "AbortError");
        const classification = classifyLlmError(err);
        appendTerminalLlmFailureNotice(store, err, classification.kind, {
          steps,
          ...(recoveryNoticeStepId === undefined ? {} : { stepId: recoveryNoticeStepId }),
          recoveredFromFailure,
          sessionRetryAttempt,
          zeroOutputShortAttempt,
          lastRecoveryAttempt,
        });
        break;
      }

      const activeBatch = toolBatchScheduler.activeBatch();
      const continuingBatch = activeBatch !== undefined;
      const stepId = crypto.randomUUID();
      latestStepId = stepId;

      const attempt = await runModelAttempt({
        step: steps,
        stepId,
        store,
        binding,
        systemPrompt: options.systemPrompt,
        resolveSystemPrompt: options.resolveSystemPrompt,
        resolveModelBoundary: options.resolveModelBoundary,
        toolRegistry,
        allowedTools,
        abort,
        logger,
        sessionId,
        agentName,
        projectContext: options.projectContext,
        storeManager: options.storeManager,
        attachmentProjector: options.attachmentProjector,
        beforeModelBuild,
        beforeModelCall,
        consumeSteers: options.consumeSteers,
        prepareModelContext: options.prepareModelContext,
        settleUnfinalizedToolParts: async () => {
          await interruptUnfinalizedToolParts(
            store,
            options.storeManager,
            options.projectContext.project.workspaceRoot,
          );
          await options.storeManager.flushSession(sessionId, options.projectContext.project.workspaceRoot);
        },
      });

      if (attempt.outcome === "retry") {
        recoveredFromFailure = true;
        if (attempt.hadDurableOutput) {
          zeroOutputShortAttempt = 0;
          sessionRetryAttempt = 0;
          partialOutputRecoveryAttempt++;
          lastRecoveryAttempt = partialOutputRecoveryAttempt;
          recoveryNoticeStepId ??= attempt.stepId;
          const delayMs = computeSessionRetryDelayMs(partialOutputRecoveryAttempt, attempt.error, retryScheduler);
          const nextRetryAt = retryScheduler.now() + delayMs;
          store.getState().append({
            type: "llm-retry",
            scope: "session",
            visibility: "session",
            profile: "partial-output-recovery",
            attempt: partialOutputRecoveryAttempt,
            errorKind: attempt.errorKind,
            message: `Model stream was interrupted after partial output. Continuing with recovery attempt ${partialOutputRecoveryAttempt}.`,
            nextRetryAt,
            stepId: recoveryNoticeStepId,
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
            stepId: attempt.stepId,
          });
          continue;
        }

        sessionRetryAttempt++;
        lastRecoveryAttempt = sessionRetryAttempt;
        recoveryNoticeStepId ??= attempt.stepId;
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
          stepId: recoveryNoticeStepId,
        });
        await retryScheduler.sleep(delayMs, abort);
        continue;
      }

      if (attempt.outcome === "terminal") {
        if (attempt.finalizationKind) {
          appendPostStreamTerminalFailure(store, attempt.error, attempt.stepId, steps, attempt.finalizationKind);
          await interruptUnfinalizedToolParts(
            store,
            options.storeManager,
            options.projectContext.project.workspaceRoot,
          );
          await options.storeManager.flushSession(sessionId, options.projectContext.project.workspaceRoot);
          markCurrentAssistantModelOutputDiscardedFromContext(store);
        } else {
          store.getState().append({
            type: "execution-error",
            step: steps,
            stepId: attempt.stepId,
            error: attempt.message,
          });
          appendTerminalLlmFailureNotice(store, attempt.error, attempt.errorKind, {
            steps,
            stepId: recoveryNoticeStepId ?? attempt.stepId,
            recoveredFromFailure,
            sessionRetryAttempt,
            zeroOutputShortAttempt,
            lastRecoveryAttempt,
          }, { terminalNoRetry: true });
        }
        failed = true;
        runEndStatus = "failed";
        runEndError = attempt.message;
        return { outcome: "terminal", text: lastText, steps, status: runEndStatus, error: runEndError };
      }

      const { finalized } = attempt;

      if (continuingBatch) {
        await toolBatchScheduler.completeContinuation();
      }

      if (recoveredFromFailure) {
        const recoveredPartialOutput = partialOutputRecoveryAttempt > 0;
        store.getState().append({
          type: "llm-recovery",
          scope: sessionRetryAttempt > 0 || recoveredPartialOutput ? "session" : "short",
          visibility: sessionRetryAttempt > 0 || zeroOutputShortAttempt === 0 ? "session" : "internal",
          profile: sessionRetryAttempt > 0
            ? "zero-output-session"
            : recoveredPartialOutput
              ? "partial-output-recovery"
              : "zero-output-short",
          attempt: recoveredPartialOutput
            ? partialOutputRecoveryAttempt
            : Math.max(sessionRetryAttempt, zeroOutputShortAttempt, 1),
          message: "Model stream recovered and resumed.",
          stepId: recoveryNoticeStepId ?? attempt.stepId,
        });
        recoveredFromFailure = false;
        zeroOutputShortAttempt = 0;
        sessionRetryAttempt = 0;
        partialOutputRecoveryAttempt = 0;
        lastRecoveryAttempt = 0;
        recoveryNoticeStepId = undefined;
      }

      if (abort.aborted) {
        const err = abort.reason ?? new DOMException("Aborted", "AbortError");
        const classification = classifyLlmError(err);
        if (isStepOpen(store, attempt.stepId)) {
          store.getState().append({
            type: "step-end",
            stepId: attempt.stepId,
            step: steps,
            finishReason: "interrupted",
          });
        }
        appendTerminalLlmFailureNotice(store, err, classification.kind, {
          steps,
          stepId: attempt.stepId,
          recoveredFromFailure,
          sessionRetryAttempt,
          zeroOutputShortAttempt,
          lastRecoveryAttempt,
        });
        break;
      }

      lastText = finalized.text;

      const completedStep = steps;

      store.getState().append({
        type: "step-end",
        stepId: attempt.stepId,
        step: completedStep,
        finishReason: finalized.finishReason,
        usage: finalized.usage,
      });
      finalOutputStepId = finalized.finishReason === "stop"
        && hasTrustedOutputForStep(store, attempt.stepId)
        ? attempt.stepId
        : undefined;
      await runHooks("afterStepEnd", afterStepEnd, { store, binding, logger, abort, projectContext: options.projectContext }, logger, { sessionId, agentName });

      // `steps` is the cursor for the next model round, not the index of the
      // most recently completed one. A final text round consumes a step too.
      steps++;

      if (finalized.finishReason !== "tool-calls") break;

      const toolCalls = finalized.toolCalls ?? [];
      if (abort.aborted) break;
      const toolExecution = await executeToolCalls(
        toolCalls,
        toolBatchScheduler,
        attempt.stepId,
        completedStep,
        repeatedFailureTracker,
        attempt.tools,
        attempt.catalogDigest,
      );

      if (toolExecution.repeatedFailure !== undefined) {
        const terminal = finishRepeatedFailure(toolExecution.repeatedFailure, store, lastText, steps);
        runEndStatus = terminal.runEndStatus;
        runEndError = terminal.result.error;
        return terminal.result;
      }
      if (toolExecution.sessionCwdChanged) {
        return {
          outcome: "terminal",
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
        return { outcome: "terminal", text: lastText, steps, status: "completed" };
      }
      if (toolExecution.suspension !== undefined) {
        runSuspension = toolExecution.suspension;
        return {
          outcome: "suspended",
          text: lastText,
          steps,
          suspension: toolExecution.suspension,
        };
      }
      if (toolExecution.manualInspectionReason !== undefined) {
        runEndStatus = "failed";
        runEndError = toolExecution.manualInspectionReason;
        store.getState().append({
          type: "execution-error",
          step: completedStep,
          stepId: attempt.stepId,
          error: runEndError,
        });
        return { outcome: "terminal", text: lastText, steps, status: runEndStatus, error: runEndError };
      }
    }

    if (steps >= maxSteps) {
      runEndStatus = "max_steps";
      runEndError = `Max steps (${maxSteps}) reached`;
      store.getState().append({
        type: "execution-error",
        error: runEndError,
      });
    }

    if (abort.aborted && runEndStatus === "completed") runEndStatus = "aborted";
    return {
      outcome: "terminal",
      text: lastText,
      steps,
      status: runEndStatus,
      ...(runEndStatus === "completed" && finalOutputStepId !== undefined ? { finalOutputStepId } : {}),
      ...(runEndError === undefined ? {} : { error: runEndError }),
    };
  } catch (err) {
    const preparationFailed = err instanceof ModelAttemptPreparationError;
    const safeError = sanitizeProviderError(err, (text) => binding.modelInfo.redactSensitiveText(text));
    failed = true;
    runEndStatus = abort.aborted ? "aborted" : "failed";
    runEndError = safeError.message;
    if (abort.aborted) {
      logger.debug("query.loop.aborted", {
        context: { step: steps, sessionId, agentName },
      });
    } else {
      logger.error("query.loop.fatal", {
        error: safeError,
        context: { step: steps, sessionId, agentName },
      });
    }
    store.getState().append(preparationFailed
      ? {
          type: "execution-error",
          error: safeError.message,
        }
      : latestStepId === undefined ? {
          type: "execution-error",
          error: safeError.message,
        } : {
          type: "execution-error",
          step: steps,
          stepId: latestStepId,
          error: safeError.message,
        });
    // Model-call failures are finalized inside runModelAttempt. Reaching this
    // catch without an active recovery means an outer loop/tool failure, which
    // must not be mislabeled as an LLM failure in the transcript.
    if (abort.aborted || recoveredFromFailure) {
      const classification = classifyLlmError(safeError);
      appendTerminalLlmFailureNotice(store, safeError, classification.kind, {
        steps,
        ...((recoveryNoticeStepId ?? latestStepId) === undefined
          ? {}
          : { stepId: recoveryNoticeStepId ?? latestStepId }),
        recoveredFromFailure,
        sessionRetryAttempt,
        zeroOutputShortAttempt,
        lastRecoveryAttempt,
      });
    }
    return { outcome: "terminal", text: lastText, steps, status: runEndStatus, error: runEndError };
  } finally {
    if (abort.aborted && !failed && runEndStatus === "completed") {
      runEndStatus = "aborted";
    }

    await runHooks("afterLoopEnd", afterLoopEnd, {
      store,
      binding,
      logger,
      abort,
      loopOutcome: runSuspension === undefined
        ? { kind: "terminal", status: runEndStatus }
        : { kind: "suspended", suspension: runSuspension },
      projectContext: options.projectContext,
    }, logger, { sessionId, agentName });
  }
}

function hasTrustedOutputForStep(store: StoreApi<SessionStoreState>, stepId: string): boolean {
  const message = store.getState().messages.find(
    (candidate) => candidate.role === "assistant" && candidate.stepId === stepId,
  );
  const outputs = message?.parts.filter((part) => part.type === "assistant-output") ?? [];
  return outputs.length > 0
    && outputs.every((part) => (
      part.completedAt !== undefined
      && part.meta?.interrupted !== true
      && part.meta?.discardedFromContext !== true
    ))
    && outputs.some((part) => part.text.trim().length > 0);
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
  stepId: string,
  abort?: AbortSignal,
): Promise<{ streamError?: unknown; hasStreamError: boolean }> {
  let streamError: unknown;
  let hasStreamError = false;
  type OpenProviderBlock = {
    redactor: ReturnType<typeof binding.modelInfo.createSensitiveTextStream>;
  };
  const textBlocks = new Map<string, OpenProviderBlock>();
  const reasoningBlocks = new Map<string, OpenProviderBlock>();
  const seenTextBlockIds = new Set<string>();
  const seenReasoningBlockIds = new Set<string>();
  const appendText = (blockId: string, block: OpenProviderBlock, text: string): void => {
    if (text.length === 0) return;
    store.getState().append({ type: "text-delta", stepId, blockId, text });
  };
  const appendReasoning = (blockId: string, block: OpenProviderBlock, text: string): void => {
    if (text.length === 0) return;
    store.getState().append({ type: "reasoning-delta", stepId, blockId, text });
  };

  try {
    await raceAbort((async () => {
      for await (const chunk of fullStream) {
        if (abort?.aborted) break;

        if (chunk.type === "error") {
          hasStreamError = true;
          streamError = chunk.error;
          continue;
        }

        if (chunk.type === "text-start") {
          assertProviderBlockId(chunk.id, "text", binding);
          if (seenTextBlockIds.has(chunk.id)) {
            throw new MalformedProviderStreamError(`Duplicate text block start: ${chunk.id}`);
          }
          seenTextBlockIds.add(chunk.id);
          textBlocks.set(chunk.id, {
            redactor: binding.modelInfo.createSensitiveTextStream(),
          });
          store.getState().append({ type: "text-start", stepId, blockId: chunk.id });
          continue;
        }

        if (chunk.type === "text-delta") {
          assertProviderBlockId(chunk.id, "text", binding);
          const block = textBlocks.get(chunk.id);
          if (block === undefined) throw new MalformedProviderStreamError(`Text delta without open block: ${chunk.id}`);
          appendText(chunk.id, block, block.redactor.push(chunk.text));
          continue;
        }

        if (chunk.type === "text-end") {
          assertProviderBlockId(chunk.id, "text", binding);
          const block = textBlocks.get(chunk.id);
          if (block === undefined) throw new MalformedProviderStreamError(`Text end without open block: ${chunk.id}`);
          appendText(chunk.id, block, block.redactor.flush());
          store.getState().append({ type: "text-end", stepId, blockId: chunk.id });
          textBlocks.delete(chunk.id);
          continue;
        }

        if (chunk.type === "reasoning-start") {
          assertProviderBlockId(chunk.id, "reasoning", binding);
          if (seenReasoningBlockIds.has(chunk.id)) {
            throw new MalformedProviderStreamError(`Duplicate reasoning block start: ${chunk.id}`);
          }
          seenReasoningBlockIds.add(chunk.id);
          reasoningBlocks.set(chunk.id, {
            redactor: binding.modelInfo.createSensitiveTextStream(),
          });
          store.getState().append({ type: "reasoning-start", stepId, blockId: chunk.id });
          continue;
        }

        if (chunk.type === "reasoning-delta") {
          assertProviderBlockId(chunk.id, "reasoning", binding);
          const block = reasoningBlocks.get(chunk.id);
          if (block === undefined) throw new MalformedProviderStreamError(`Reasoning delta without open block: ${chunk.id}`);
          appendReasoning(chunk.id, block, block.redactor.push(chunk.text));
          continue;
        }

        if (chunk.type === "reasoning-end") {
          assertProviderBlockId(chunk.id, "reasoning", binding);
          const block = reasoningBlocks.get(chunk.id);
          if (block === undefined) throw new MalformedProviderStreamError(`Reasoning end without open block: ${chunk.id}`);
          appendReasoning(chunk.id, block, block.redactor.flush());
          store.getState().append({ type: "reasoning-end", stepId, blockId: chunk.id });
          reasoningBlocks.delete(chunk.id);
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
            input: chunk.toolName === TOOL_TOOL_SEARCH
              ? sanitizeToolSearchInput(binding.modelInfo.redactSensitiveValue(chunk.input))
              : binding.modelInfo.redactSensitiveValue(chunk.input),
          });
        }
      }
    })(), abort);
    if (textBlocks.size > 0 || reasoningBlocks.size > 0) {
      throw new MalformedProviderStreamError("Provider stream ended with open text or reasoning blocks");
    }
  } finally {
    for (const [blockId, block] of textBlocks) {
      appendText(blockId, block, block.redactor.flush());
      store.getState().append({ type: "text-end", stepId, blockId });
    }
    for (const [blockId, block] of reasoningBlocks) {
      appendReasoning(blockId, block, block.redactor.flush());
      store.getState().append({ type: "reasoning-end", stepId, blockId });
    }
  }

  return { streamError, hasStreamError };
}

async function finalizeModelResult(
  result: AnyStreamTextResult,
  streamError: unknown,
  hasStreamError: boolean,
  store: StoreApi<SessionStoreState>,
  stepId: string,
  step: number,
  abort: AbortSignal,
  redactProviderSecrets: SensitiveTextRedactor,
): Promise<{ outcome: "success"; finalized: FinalizedModelResult } | RetryOrTerminalAttemptResult> {
  let finishReason: string;
  let usage: unknown;
  let text: string;

  try {
    const settled = await raceAbort(
      Promise.all([
        Promise.resolve(result.finishReason),
        Promise.resolve(result.usage),
        Promise.resolve(result.text),
      ]),
      abort,
    );
    finishReason = settled[0];
    usage = settled[1];
    text = redactProviderSecrets(settled[2]);
  } catch (err) {
    return handleFinalizationFailure(preferStreamError(streamError, err), store, stepId, step, abort, "result", redactProviderSecrets);
  }

  if (hasStreamError) {
    return handleFinalizationFailure(streamError, store, stepId, step, abort, "stream", redactProviderSecrets);
  }

  if (finishReason !== "tool-calls") {
    return { outcome: "success", finalized: { finishReason, usage, text } };
  }

  try {
    const rawToolCalls = await raceAbort(Promise.resolve(result.toolCalls), abort);
    const toolCalls = rawToolCalls.map((toolCall) => {
      assertSafeProviderToolIdentifier(toolCall.toolCallId, "toolCallId", redactProviderSecrets);
      assertSafeProviderToolIdentifier(toolCall.toolName, "toolName", redactProviderSecrets);
      return {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        input: toolCall.toolName === TOOL_TOOL_SEARCH
          ? sanitizeToolSearchInput(redactSensitiveValue(toolCall.input, redactProviderSecrets))
          : redactSensitiveValue(toolCall.input, redactProviderSecrets),
      };
    });
    return { outcome: "success", finalized: { finishReason, usage, text, toolCalls } };
  } catch (err) {
    return handleFinalizationFailure(preferStreamError(streamError, err), store, stepId, step, abort, "toolCalls", redactProviderSecrets);
  }
}

function assertProviderBlockId(
  value: string,
  channel: "text" | "reasoning",
  binding: QueryLoopOptions["binding"],
): void {
  if (value.trim().length === 0) {
    throw new MalformedProviderStreamError(`Provider emitted a blank ${channel} block id`);
  }
  if (binding.modelInfo.redactSensitiveText(value) !== value) {
    throw new ProviderOutputSecretError(`${channel}BlockId`);
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
  stepId: string,
  step: number,
  abort: AbortSignal,
  kind: FinalizationKind,
  redactProviderSecrets: SensitiveTextRedactor,
): RetryOrTerminalAttemptResult {
  const failure = buildRetryOrTerminalFailure(err, store, stepId, step, abort, redactProviderSecrets);

  if (failure.outcome === "retry") {
    if (isStepOpen(store, stepId)) {
      store.getState().append({ type: "step-end", stepId, step, finishReason: "interrupted" });
    }
    return failure;
  }

  return { ...failure, finalizationKind: kind };
}

function buildRetryOrTerminalFailure(
  err: unknown,
  store: StoreApi<SessionStoreState>,
  stepId: string,
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
    if (part.type === "assistant-output" || part.type === "reasoning") return part.text.length > 0;
    if (part.type === "recovery-notice" || part.type === "system-notice" || part.type === "compaction") return false;
    return true;
  });
}

function appendTerminalLlmFailureNotice(
  store: StoreApi<SessionStoreState>,
  err: unknown,
  errorKind: string,
  attempts: {
    steps: number;
    stepId?: string;
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
    ...(attempts.stepId === undefined ? {} : { stepId: attempts.stepId }),
  });
}

function appendPostStreamTerminalFailure(
  store: StoreApi<SessionStoreState>,
  err: unknown,
  stepId: string,
  step: number,
  kind: FinalizationKind,
): void {
  const message = errorMessage(err);
  const classification = classifyLlmError(err);

  if (isStepOpen(store, stepId)) {
    store.getState().append({ type: "step-end", stepId, step, finishReason: "error" });
  }

  store.getState().append({
    type: "execution-error",
    step,
    stepId,
    error: message,
  });

  appendTerminalLlmFailureNotice(store, err, classification.kind, {
    steps: step,
    stepId,
    recoveredFromFailure: false,
    sessionRetryAttempt: 0,
    zeroOutputShortAttempt: 0,
    lastRecoveryAttempt: 0,
  }, {
    terminalNoRetry: true,
    profile: "post-stream-terminal",
    message: kind === "stream"
      ? `Model stream failed: ${message}`
      : `${kind === "toolCalls" ? "Model tool call" : "Model result"} finalization failed: ${message}`,
  });
}

function isStepOpen(store: StoreApi<SessionStoreState>, stepId: string): boolean {
  return store.getState().steps.some((candidate) =>
    candidate.id === stepId && candidate.completedAt === undefined,
  );
}

function markCurrentAssistantModelOutputDiscardedFromContext(store: StoreApi<SessionStoreState>): void {
  const currentAssistantMessageId = store.getState().currentAssistantMessageId;
  if (!currentAssistantMessageId) return;

  store.setState((state) => {
    let changed = false;
    const messages = state.messages.map((message) => {
      if (message.id !== currentAssistantMessageId || message.role !== "assistant") return message;

      const parts = message.parts.map((part) => {
        if ((part.type !== "assistant-output" && part.type !== "reasoning") || part.text.length === 0) return part;
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

async function interruptUnfinalizedToolParts(
  store: StoreApi<SessionStoreState>,
  storeManager: SessionStoreManager,
  workspaceRoot: string,
): Promise<void> {
  await storeManager.commitDurableSessionMutation(
    store.getState().sessionId,
    workspaceRoot,
    (state) => {
      const messages = interruptIncompleteToolParts(state.messages, Date.now());
      return {
        result: undefined,
        ...(messages === state.messages ? {} : { patch: { messages } }),
      };
    },
  );
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
  stepId: string,
  step: number,
  repeatedFailureTracker: RepeatedFailureTracker,
  resolvedTools: ResolvedToolSet,
  catalogDigest?: string,
): Promise<ToolBatchExecutionResult> {
  if (toolCalls.length === 0) return { sessionCwdChanged: false };
  await scheduler.createBatch(toolCalls, stepId, step, resolvedTools.descriptors, catalogDigest);
  const advance = await scheduler.advance();
  const result = toolBatchExecutionResult(advance);
  if (!toolBatchIsFullySettled(advance)) return result;
  const repeatedFailure = repeatedFailureTracker.findThreshold();
  return repeatedFailure === undefined ? result : { ...result, repeatedFailure };
}

function toolBatchIsFullySettled(result: SessionToolBatchAdvanceResult): boolean {
  // A threshold cannot terminate the Execution until every sibling has its
  // one real finalized result and the Scheduler has closed the batch.
  return result.status === "ready_for_continuation" || result.status === "execution_completed";
}

function finishRepeatedFailure(
  failure: RepeatedFailure,
  store: StoreApi<SessionStoreState>,
  text: string,
  steps: number,
): { runEndStatus: "failed"; result: Extract<QueryLoopResult, { outcome: "terminal" }> } {
  const error = `Repeated deterministic tool failure: ${failure.toolName} returned ${failure.errorCode} 3 times for the same input`;
  store.getState().append({
    type: "execution-error",
    step: failure.step,
    stepId: failure.stepId,
    error,
  });
  return {
    runEndStatus: "failed",
    result: { outcome: "terminal", text, steps, status: "failed", error },
  };
}

function toolBatchExecutionResult(result: SessionToolBatchAdvanceResult): ToolBatchExecutionResult {
  if (result.status === "manual_inspection_required") {
    return { sessionCwdChanged: false, manualInspectionReason: manualInspectionMessage(result.reason) };
  }
  return {
    sessionCwdChanged: result.sessionCwdChanged,
    ...(result.status === "execution_completed" ? { executionCompleted: true } : {}),
    ...(result.status === "suspended_hitl" ? {
      suspension: {
        kind: "hitl" as const,
        toolBatchId: result.toolBatchId,
        blockerIds: result.hitlIds,
      },
    } : {}),
    ...(result.status === "waiting_for_child" ? {
      suspension: {
        kind: "child_dependency" as const,
        toolBatchId: result.toolBatchId,
        toolCallId: result.toolCallId,
        childSessionId: result.childSessionId,
        childExecutionId: result.childExecutionId,
      },
    } : {}),
  };
}

function finishToolBatchAdvance(
  result: SessionToolBatchAdvanceResult,
  executionCwd: string,
  store: StoreApi<SessionStoreState>,
  text: string,
  steps: number,
): { runEndStatus: SessionExecutionTerminalStatus; result: QueryLoopResult } | undefined {
  if (result.status === "manual_inspection_required") {
    const reason = manualInspectionMessage(result.reason);
    const stepId = store.getState().toolBatches.find((batch) => batch.archivedAt === undefined)?.stepId;
    store.getState().append(stepId === undefined
      ? { type: "execution-error", error: reason }
      : { type: "execution-error", step: steps, stepId, error: reason });
    return { runEndStatus: "failed", result: { outcome: "terminal", text, steps, status: "failed", error: reason } };
  }
  if (result.sessionCwdChanged) {
    return {
      runEndStatus: "completed",
      result: {
        outcome: "terminal",
        text,
        steps,
        status: "completed",
        cwdChanged: { previousCwd: executionCwd, cwd: store.getState().cwd },
      },
    };
  }
  if (result.status === "execution_completed") {
    return { runEndStatus: "completed", result: { outcome: "terminal", text, steps, status: "completed" } };
  }
  if (result.status === "suspended_hitl") {
    return {
      runEndStatus: "completed",
      result: {
        outcome: "suspended",
        text,
        steps,
        suspension: {
          kind: "hitl",
          toolBatchId: result.toolBatchId,
          blockerIds: result.hitlIds,
        },
      },
    };
  }
  if (result.status === "waiting_for_child") {
    return {
      runEndStatus: "completed",
      result: {
        outcome: "suspended",
        text,
        steps,
        suspension: {
          kind: "child_dependency",
          toolBatchId: result.toolBatchId,
          toolCallId: result.toolCallId,
          childSessionId: result.childSessionId,
          childExecutionId: result.childExecutionId,
        },
      },
    };
  }
  return undefined;
}

function manualInspectionMessage(reason: SessionToolManualInspectionReason): string {
  return reason.kind === "effectful_cancelled_unknown"
    ? `Effectful tool ${reason.toolName} (${reason.toolCallId}) was interrupted during cancellation; its outcome requires manual inspection`
    : `Effectful tool ${reason.toolName} (${reason.toolCallId}) has an unknown outcome and requires manual inspection`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function canonicalizeToolInput(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}
