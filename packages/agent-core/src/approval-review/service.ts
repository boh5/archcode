import type { NormalizedUsage } from "@archcode/protocol";
import { LlmObjectError, LlmSchemaValidationError, LLM_OBJECT_SINGLE_ATTEMPT_POLICY, runLlmObject } from "../llm";
import { silentLogger } from "../logger";
import { containsSecretPattern } from "../security";
import {
  APPROVAL_REVIEW_ACTION_BYTES,
  APPROVAL_REVIEW_MAX_OUTPUT_TOKENS,
  APPROVAL_REVIEW_SYSTEM_PROMPT,
  APPROVAL_REVIEW_TIMEOUT_MS,
  ApprovalReviewResultSchema,
  buildApprovalReviewPrompt,
  serializeApprovalScope,
  serializePendingAction,
  utf8Bytes,
} from "./prompt";
import type {
  ApprovalReviewer,
  ApprovalReviewDeferReason,
  ApprovalReviewLogRecord,
  ApprovalReviewOutcome,
  ApprovalReviewRequest,
  ApprovalReviewServiceOptions,
} from "./types";

const EMPTY_USAGE: NormalizedUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
});

export class ApprovalReviewService implements ApprovalReviewer {
  readonly #options: ApprovalReviewServiceOptions;

  constructor(options: ApprovalReviewServiceOptions) {
    this.#options = options;
  }

  async review(request: ApprovalReviewRequest): Promise<ApprovalReviewOutcome> {
    const startedAt = this.#now();
    let usage = EMPTY_USAGE;
    let bindingLog: ApprovalReviewLogRecord["binding"];
    const complete = (outcome: ApprovalReviewOutcome): ApprovalReviewOutcome => {
      this.#log({
        outcome: outcome.outcome,
        ...(outcome.outcome === "deferred" ? { deferReason: outcome.reason } : {}),
        latencyMs: Math.max(0, this.#now() - startedAt),
        ...(bindingLog === undefined ? {} : { binding: bindingLog }),
        usage: toLogUsage(usage),
      });
      return outcome;
    };

    if (request.context.abort.aborted) throw abortReason(request.context.abort);
    if (!this.#options.isEnabled()) return complete(deferred("disabled"));
    if (request.permission.outcome !== "ask") return complete(deferred("context_unavailable"));

    const pendingAction = serializePendingAction(request.context.toolName, request.input);
    if (pendingAction === undefined) return complete(deferred("context_unavailable"));
    const approvalScope = serializeApprovalScope(request.permission.approval?.scope);
    if (isSensitive(pendingAction, this.#options.redactionPolicy)
      || approvalScope !== undefined && isSensitive(approvalScope, this.#options.redactionPolicy)) {
      return complete(deferred("sensitive_input"));
    }
    if (utf8Bytes(pendingAction) > APPROVAL_REVIEW_ACTION_BYTES) {
      return complete(deferred("input_too_large"));
    }

    const promptResult = await buildApprovalReviewPrompt({
      context: request.context,
      permission: request.permission,
      pendingAction: { toolName: request.context.toolName, input: request.input },
    });
    if (promptResult.outcome === "deferred") return complete(deferred(promptResult.reason));
    if (isSensitive(promptResult.prompt, this.#options.redactionPolicy)) {
      return complete(deferred("sensitive_input"));
    }
    if (request.context.abort.aborted) throw abortReason(request.context.abort);

    let binding;
    try {
      const snapshot = this.#options.modelRuntime.current;
      binding = this.#options.modelSelectionResolver.resolve({ snapshot, profile: "fast" });
      bindingLog = {
        providerId: binding.summary.providerId,
        modelId: binding.summary.modelId,
        modelRuntimeRevision: binding.summary.modelRuntimeRevision,
      };
    } catch {
      return complete(deferred("model_unavailable"));
    }

    const modelOptions = {
      ...binding.options,
      maxOutputTokens: Math.min(binding.options?.maxOutputTokens ?? APPROVAL_REVIEW_MAX_OUTPUT_TOKENS, APPROVAL_REVIEW_MAX_OUTPUT_TOKENS),
      timeout: Math.min(binding.options?.timeout ?? APPROVAL_REVIEW_TIMEOUT_MS, APPROVAL_REVIEW_TIMEOUT_MS),
    };

    try {
      const result = await withDeadline(
        (reviewSignal) => runLlmObject({
          model: binding.modelInfo.model,
          modelOptions,
          system: APPROVAL_REVIEW_SYSTEM_PROMPT,
          prompt: promptResult.prompt,
          schema: ApprovalReviewResultSchema,
          schemaName: "approval_review",
          schemaDescription: "Submit exactly one decision: approve or ask_user. Do not include any other field",
          abortSignal: reviewSignal,
          redactSensitiveText: (text) => binding.modelInfo.redactSensitiveText(text),
          attemptPolicy: LLM_OBJECT_SINGLE_ATTEMPT_POLICY,
          onUsage: (normalized) => { usage = normalized; },
        }),
        modelOptions.timeout,
        request.context.abort,
      );
      return result.decision === "approve"
        ? complete({ outcome: "approved" })
        : complete(deferred("ask_user"));
    } catch (error) {
      if (request.context.abort.aborted) throw abortReason(request.context.abort);
      if (error instanceof ApprovalReviewTimeoutError) return complete(deferred("timeout"));
      if (error instanceof LlmSchemaValidationError || error instanceof LlmObjectError) {
        return complete(deferred("schema_error"));
      }
      return complete(deferred("provider_error"));
    }
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  #log(record: ApprovalReviewLogRecord): void {
    (this.#options.logger ?? silentLogger).info("approval_review.completed", { context: { ...record } });
  }
}

class ApprovalReviewTimeoutError extends Error {
  constructor() {
    super("Approval review timed out");
    this.name = "ApprovalReviewTimeoutError";
  }
}

function deferred(reason: ApprovalReviewDeferReason): ApprovalReviewOutcome {
  return { outcome: "deferred", reason };
}

function isSensitive(serialized: string, policy: ApprovalReviewServiceOptions["redactionPolicy"]): boolean {
  return containsSecretPattern(serialized).found || policy.redactString(serialized) !== serialized;
}

function toLogUsage(usage: NormalizedUsage): ApprovalReviewLogRecord["usage"] {
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    total: usage.totalTokens,
    reasoning: usage.reasoningTokens,
    cachedInput: usage.cachedInputTokens,
  };
}

async function withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, abortSignal: AbortSignal): Promise<T> {
  if (abortSignal.aborted) throw abortReason(abortSignal);
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const deadline = new AbortController();
    const operationSignal = AbortSignal.any([abortSignal, deadline.signal]);
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      abortSignal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortReason(abortSignal)));
    const timeout = setTimeout(() => {
      deadline.abort(new DOMException("Approval review timed out", "TimeoutError"));
      finish(() => reject(new ApprovalReviewTimeoutError()));
    }, timeoutMs);
    abortSignal.addEventListener("abort", onAbort, { once: true });
    operation(operationSignal).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}
