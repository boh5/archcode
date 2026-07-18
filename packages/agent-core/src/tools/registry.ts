import type { FinalizedToolResult, HitlResponse } from "@archcode/protocol";
import type { Logger } from "../logger";
import { silentLogger } from "../logger";
import { HitlBoundaryCodec } from "../hitl/boundary-codec";
import { ToolOutputFinalizer } from "../tool-output/finalizer";
import type { PermissionToolBlockedRequest } from "../tool-output/types";
import { createToolErrorResult, extractCode, kindFromCode } from "./errors";
import { approvalFingerprint } from "./permission/approval-fingerprint";
import type {
  AfterHook,
  AiToolInputSchema,
  AnyToolDescriptor,
  BeforeHook,
  FinalizedResultHook,
  PermissionDecision,
  RawToolResult,
  RegistryExecutionOutcome,
  ToolBlockedRequest,
  ToolCallLike,
  ToolExecutionContext,
  ToolPermission,
} from "./types";
import {
  DestructiveToolPermissionError,
  DuplicateToolError,
} from "./types";
import { isStructuredResultSubmission } from "./structured-result-correction";

export interface ToolRegistryOptions {
  readonly finalizer: ToolOutputFinalizer;
  readonly hitlCodec: HitlBoundaryCodec;
  readonly logger?: Logger;
}

type PermissionResolution =
  | { readonly kind: "allow" }
  | {
      readonly kind: "blocked";
      readonly request: PermissionToolBlockedRequest;
      readonly approval?: NonNullable<PermissionDecision["approval"]>;
    }
  | { readonly kind: "settled"; readonly raw: RawToolResult };

interface ResumeExecution {
  readonly request: ToolBlockedRequest;
  readonly requestKey: string;
  readonly response: HitlResponse;
}

export class ToolRegistry {
  readonly #descriptors = new Map<string, AnyToolDescriptor>();
  readonly #logger: Logger;
  readonly #finalizer: ToolOutputFinalizer;
  readonly #hitlCodec: HitlBoundaryCodec;

  readonly globalHooks: {
    readonly before: BeforeHook[];
    readonly finalized: FinalizedResultHook[];
  } = { before: [], finalized: [] };
  readonly globalPermissions: ToolPermission[] = [];

  constructor(options: ToolRegistryOptions) {
    this.#logger = options.logger ?? silentLogger;
    this.#finalizer = options.finalizer;
    this.#hitlCodec = options.hitlCodec;
  }

  register(descriptor: AnyToolDescriptor): void {
    if (this.#descriptors.has(descriptor.name)) throw new DuplicateToolError(descriptor.name);
    if (descriptor.traits.destructive && (!descriptor.permissions || descriptor.permissions.length === 0)) {
      throw new DestructiveToolPermissionError(descriptor.name);
    }
    const hasPrepareBlock = descriptor.prepareBlock !== undefined;
    const hasResume = descriptor.resume !== undefined;
    if (hasPrepareBlock !== hasResume || (hasPrepareBlock && descriptor.name !== "ask_user")) {
      throw new TypeError("ask_user is the only suspendable descriptor and must declare both prepareBlock and resume");
    }
    this.#descriptors.set(descriptor.name, descriptor);
  }

  registerAll(descriptors: AnyToolDescriptor[]): void {
    for (const descriptor of descriptors) this.register(descriptor);
  }

  get(name: string): AnyToolDescriptor | undefined {
    return this.#descriptors.get(name);
  }

  getAll(): AnyToolDescriptor[] {
    return [...this.#descriptors.values()];
  }

  listByPrefix(prefix: string): AnyToolDescriptor[] {
    return [...this.#descriptors.entries()]
      .filter(([name]) => name.startsWith(prefix))
      .map(([, descriptor]) => descriptor);
  }

  resolveForAgent(toolNames?: readonly string[]): ResolvedToolSet {
    if (!toolNames || toolNames.length === 0) return new ResolvedToolSet([]);
    const descriptors: AnyToolDescriptor[] = [];
    for (const name of toolNames) {
      const descriptor = this.#descriptors.get(name);
      if (descriptor) {
        descriptors.push(descriptor);
      } else {
        this.#logger.warn("tool.resolve.unknown", { meta: { toolName: name } });
      }
    }
    return new ResolvedToolSet(descriptors);
  }

  execute(toolCall: ToolCallLike, context: ToolExecutionContext): Promise<RegistryExecutionOutcome> {
    return this.#execute(toolCall, context);
  }

  validateBlockedResponse(request: ToolBlockedRequest, response: unknown): HitlResponse {
    return this.#hitlCodec.parseResponseForRequest(
      this.#hitlCodec.parseBlockedRequest(request),
      response,
    );
  }

  async resumeBlocked(input: {
    readonly toolCall: ToolCallLike;
    readonly request: ToolBlockedRequest;
    readonly requestKey: string;
    readonly response: unknown;
    readonly context: ToolExecutionContext;
  }): Promise<RegistryExecutionOutcome> {
    try {
      const request = this.#hitlCodec.parseBlockedRequest(input.request);
      this.#hitlCodec.assertToolRequestKey({
        sessionId: input.context.store.getState().sessionId,
        toolCallId: input.toolCall.toolCallId,
        toolName: input.toolCall.toolName,
        requestKey: input.requestKey,
        request,
      });
      const response = this.#hitlCodec.parseResponseForRequest(request, input.response);
      return await this.#execute(input.toolCall, input.context, {
        request,
        requestKey: input.requestKey,
        response,
      });
    } catch {
      return await this.#invalidResume(input.toolCall, input.context);
    }
  }

  async settleSystem(
    toolCall: ToolCallLike,
    context: ToolExecutionContext,
    raw: RawToolResult,
  ): Promise<Extract<RegistryExecutionOutcome, { kind: "settled" }>> {
    this.#initializeContext(toolCall, context);
    let result: FinalizedToolResult;
    try {
      result = this.#finalizer.finalizeSystemRaw(raw);
    } catch (error) {
      this.#logFailure("tool.system-finalize.failed", toolCall.toolName, error);
      result = this.#finalizer.createSystemResult({
        isError: true,
        code: "TOOL_OUTPUT_UNAVAILABLE",
        message: "Tool output finalization failed",
        unknownResult: raw.details?.unknownResult,
      });
    }
    await this.#runFinalizedHooks(result, context);
    return {
      kind: "settled",
      result,
      ...(raw.sidecar === undefined ? {} : { sidecar: raw.sidecar }),
    };
  }

  async #execute(
    toolCall: ToolCallLike,
    context: ToolExecutionContext,
    resume?: ResumeExecution,
  ): Promise<RegistryExecutionOutcome> {
    this.#initializeContext(toolCall, context);
    const descriptor = this.#descriptors.get(toolCall.toolName);
    if (!descriptor) {
      return this.settleSystem(toolCall, context, createToolErrorResult({
        kind: "unknown-tool",
        code: "TOOL_UNKNOWN",
        message: `Tool "${toolCall.toolName}" is not registered`,
      }));
    }
    context.toolTraits = descriptor.traits;

    const prepared = await this.#prepareInput(descriptor, toolCall.input, context);
    if (prepared.kind === "error") return this.settleSystem(toolCall, context, prepared.raw);
    let currentInput = prepared.input;

    if (!context.allowedTools.has(toolCall.toolName)) {
      return this.settleSystem(toolCall, context, createToolErrorResult({
        kind: "not-allowed",
        code: "TOOL_NOT_ALLOWED",
        message: `Tool "${toolCall.toolName}" is not allowed for this execution context`,
      }));
    }

    const before = await this.#runBeforeHooks(descriptor, currentInput, context);
    if (before.kind === "error") return this.settleSystem(toolCall, context, before.raw);
    currentInput = before.input;

    const permission = await this.#resolvePermission(descriptor, currentInput, context);
    if (permission.kind === "settled") return this.settleSystem(toolCall, context, permission.raw);
    if (permission.kind === "blocked") {
      if (resume === undefined) return this.#createBlockedOutcome(toolCall, context, permission.request);
      if (!this.#hitlCodec.sameBlockedRequest(permission.request, resume.request)) {
        return this.#invalidResume(toolCall, context);
      }
      const permissionResponse = resume.response;
      if (permissionResponse.type === "cancel") {
        return this.#cancelledResume(toolCall, context, permissionResponse.reason);
      }
      if (permissionResponse.type !== "permission_decision") {
        return this.#invalidResume(toolCall, context);
      }
      if (permissionResponse.decision === "deny") {
        return this.settleSystem(toolCall, context, createToolErrorResult({
          kind: "permission-confirmation-denied",
          code: "TOOL_PERMISSION_CONFIRMATION_DENIED",
          message: `Tool "${permission.request.source.toolName}" permission denied`,
        }));
      }
      if (permissionResponse.decision === "approve_always") {
        const approval = permission.approval;
        if (
          permission.request.persistentApprovalEligible !== true
          || approval?.eligible !== true
          || approval.scope === undefined
        ) {
          return this.settleSystem(toolCall, context, createToolErrorResult({
            kind: "permission-confirmation-denied",
            code: "TOOL_PERMISSION_CONFIRMATION_DENIED",
            message: `Tool "${context.toolName}" is not eligible for persistent approval`,
          }));
        }
        try {
          await context.projectContext.approvals.addApproval(approval.scope, {
            display: approval.display,
            reason: approval.reason,
            grantedBy: {
              ...(context.agentName ? { agentName: context.agentName } : {}),
              ...(context.currentDepth === undefined ? {} : { depth: context.currentDepth }),
            },
          });
        } catch (error) {
          return this.settleSystem(toolCall, context, pipelineError("permission-denied", error, false));
        }
      }
      context.permissionOutcome = "allow";
    } else if (resume?.request.source.type === "tool_permission") {
      return this.#invalidResume(toolCall, context);
    }

    let resumeAskUser = false;
    const permissionResumeConsumed = permission.kind === "blocked" && resume !== undefined;
    if (descriptor.prepareBlock) {
      try {
        const request = this.#hitlCodec.parseBlockedRequest(
          await descriptor.prepareBlock(currentInput, context),
        );
        if (resume === undefined || permissionResumeConsumed) {
          return this.#createBlockedOutcome(toolCall, context, request);
        }
        if (!this.#hitlCodec.sameBlockedRequest(request, resume.request)) {
          return this.#invalidResume(toolCall, context);
        }
        if (resume.response.type === "cancel") {
          return this.#cancelledResume(toolCall, context, resume.response.reason);
        }
        if (resume.response.type !== "question_answer") {
          return this.#invalidResume(toolCall, context);
        }
        resumeAskUser = true;
      } catch (error) {
        if (resume !== undefined) return this.#invalidResume(toolCall, context);
        return this.settleSystem(toolCall, context, pipelineError("execution", error, false));
      }
    } else if (resume?.request.source.type === "ask_user") {
      return this.#invalidResume(toolCall, context);
    }

    let capture;
    try {
      capture = await this.#finalizer.beginCapture(descriptor, context);
      context.outputCapture = capture;
    } catch (error) {
      return this.settleSystem(toolCall, context, pipelineError("execution", error, false));
    }

    let attempted = false;
    let raw: RawToolResult;
    try {
      if (isEffectfulTool(descriptor)) {
        await context.onToolAttempt?.({
          attemptId: crypto.randomUUID(),
          toolCallId: toolCall.toolCallId,
          toolName: descriptor.name,
          timestamp: Date.now(),
          destructive: descriptor.traits.destructive,
        });
        attempted = true;
      }

      if (resumeAskUser) {
        if (!descriptor.resume) throw new Error("Blocked descriptor does not implement resume");
        raw = await descriptor.resume(currentInput, resume!.response, context);
      } else {
        raw = await descriptor.execute(currentInput, context);
      }
      raw = await this.#runAfterHooks(descriptor.hooks?.after ?? [], raw, context, attempted);
    } catch (error) {
      raw = pipelineError("execution", error, attempted);
    }
    context.durationMs = Date.now() - context.startedAt;

    let result: FinalizedToolResult;
    try {
      result = await this.#finalizer.finalize({
        descriptor,
        raw,
        context,
        capture,
        attempted,
      });
    } catch (error) {
      await capture?.abort().catch(() => undefined);
      this.#logFailure("tool.finalize.failed", descriptor.name, error);
      result = this.#finalizer.createSystemResult({
        isError: true,
        code: "TOOL_OUTPUT_UNAVAILABLE",
        message: "Tool output finalization failed",
        unknownResult: attempted,
      });
    }
    context.outputCapture = undefined;
    await this.#runFinalizedHooks(result, context);
    return {
      kind: "settled",
      result,
      ...(raw.sidecar === undefined ? {} : { sidecar: raw.sidecar }),
    };
  }

  async #prepareInput(
    descriptor: AnyToolDescriptor,
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<{ kind: "ok"; input: any } | { kind: "error"; raw: RawToolResult }> {
    let candidate = input;
    if (descriptor.prepareInput) {
      try {
        candidate = await descriptor.prepareInput(candidate, context);
      } catch (error) {
        return { kind: "error", raw: pipelineError("prepare-input", error, false) };
      }
    }
    const parsed = descriptor.inputSchema.safeParse(candidate);
    if (!parsed.success) {
      if (
        context.structuredResultCorrection !== undefined
        && isStructuredResultSubmission(
          descriptor.name,
          candidate,
          context.structuredResultCorrection.submission,
        )
      ) {
        const error = new Error(parsed.error.message);
        error.name = "StructuredResultSchemaError";
        return {
          kind: "error",
          raw: context.structuredResultCorrection.recordFailure(error),
        };
      }
      return {
        kind: "error",
        raw: createToolErrorResult({
          kind: "schema",
          code: "TOOL_SCHEMA_INVALID_INPUT",
          zodError: parsed.error,
          expectedInput: `Tool "${descriptor.name}" input must match its registered schema.`,
        }),
      };
    }
    context.redactedInput = this.#finalizer.redactValue(parsed.data);
    try {
      context.onInputResolved?.(context.redactedInput);
    } catch (error) {
      this.#logFailure("tool.onInputResolved.failed", descriptor.name, error);
    }
    return { kind: "ok", input: parsed.data };
  }

  async #runBeforeHooks(
    descriptor: AnyToolDescriptor,
    initialInput: unknown,
    context: ToolExecutionContext,
  ): Promise<{ kind: "ok"; input: any } | { kind: "error"; raw: RawToolResult }> {
    let currentInput = initialInput;
    for (const hook of [...this.globalHooks.before, ...(descriptor.hooks?.before ?? [])]) {
      try {
        const mutation = await hook(currentInput, context);
        if (mutation === undefined) continue;
        const parsed = descriptor.inputSchema.safeParse(mutation);
        if (!parsed.success) {
          return {
            kind: "error",
            raw: createToolErrorResult({
              kind: "before-hook-schema",
              code: "TOOL_BEFORE_HOOK_INVALID_INPUT",
              zodError: parsed.error,
              expectedInput: `Tool "${descriptor.name}" input must remain schema-valid after before hooks.`,
            }),
          };
        }
        currentInput = parsed.data;
        context.redactedInput = this.#finalizer.redactValue(currentInput);
      } catch (error) {
        return { kind: "error", raw: pipelineError("execution", error, false) };
      }
    }
    return { kind: "ok", input: currentInput };
  }

  async #runAfterHooks(
    hooks: readonly AfterHook[],
    initial: RawToolResult,
    context: ToolExecutionContext,
    attempted: boolean,
  ): Promise<RawToolResult> {
    let raw = initial;
    for (const hook of hooks) {
      try {
        raw = (await hook(raw, context)) ?? raw;
      } catch (error) {
        this.#logFailure("tool.after-hook.failed", context.toolName, error);
        return pipelineError("after-hook", error, attempted);
      }
    }
    return raw;
  }

  async #resolvePermission(
    descriptor: AnyToolDescriptor,
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<PermissionResolution> {
    try {
      return await this.#resolvePermissionUnsafe(descriptor, input, context);
    } catch (error) {
      return { kind: "settled", raw: pipelineError("permission-denied", error, false) };
    }
  }

  async #resolvePermissionUnsafe(
    descriptor: AnyToolDescriptor,
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<PermissionResolution> {
    const decisions: PermissionDecision[] = [];
    for (const permission of this.globalPermissions) {
      decisions.push(this.#redactDecision(await permission(input, context)));
    }
    for (const permission of descriptor.permissions ?? []) {
      decisions.push(this.#redactDecision(await permission(input, context)));
    }

    const denied = decisions.find((decision) => decision.outcome === "deny");
    if (denied) {
      context.permissionOutcome = "deny";
      return { kind: "settled", raw: denyResult(denied, context) };
    }

    const asks = decisions.filter((decision) => decision.outcome === "ask");
    const unsatisfied = await this.#firstUnsatisfiedAsk(asks, descriptor, context);
    if (!unsatisfied) {
      context.permissionOutcome = "allow";
      return { kind: "allow" };
    }
    context.permissionOutcome = "ask";

    const requestInput = {
      toolCallId: context.toolCallId,
      toolName: context.toolName,
      input: context.redactedInput,
      description: descriptor.description,
      reason: unsatisfied.prompt ?? unsatisfied.reason,
      decisionDisplay: unsatisfied.display,
      ruleId: unsatisfied.ruleId,
    };
    const fingerprint = unsatisfied.approval?.scope !== undefined
      ? approvalFingerprint(unsatisfied.approval.scope)
      : unsatisfied.approval?.fingerprint ?? approvalFingerprint(requestInput);
    const persistentApprovalEligible = unsatisfied.approval?.eligible === true
      && unsatisfied.approval.scope !== undefined;
    const request = this.#hitlCodec.createPermissionRequest({
      source: {
        type: "tool_permission",
        toolCallId: context.toolCallId,
        toolName: context.toolName,
      },
      displayPayload: permissionDisplayPayload(requestInput, this.#finalizer),
      permissionFingerprint: fingerprint,
      persistentApprovalEligible,
      permission: {
        description: descriptor.description,
        ...(requestInput.reason === undefined ? {} : { reason: requestInput.reason }),
        ...(requestInput.decisionDisplay === undefined ? {} : { decisionDisplay: requestInput.decisionDisplay }),
        ...(requestInput.ruleId === undefined ? {} : { ruleId: requestInput.ruleId }),
      },
    });

    return {
      kind: "blocked",
      request,
      ...(unsatisfied.approval === undefined ? {} : { approval: unsatisfied.approval }),
    };
  }

  async #firstUnsatisfiedAsk(
    decisions: readonly PermissionDecision[],
    descriptor: AnyToolDescriptor,
    context: ToolExecutionContext,
  ): Promise<PermissionDecision | undefined> {
    for (const decision of decisions) {
      const approval = decision.approval;
      if (
        approval?.eligible === true
        && approval.scope
        && shouldUseProjectApprovalForAsk(descriptor, context)
        && context.projectContext.approvals.hasApproval(approval.scope)
      ) {
        continue;
      }
      return decision;
    }
    return undefined;
  }

  async #runFinalizedHooks(
    result: FinalizedToolResult,
    context: ToolExecutionContext,
  ): Promise<void> {
    context.durationMs = Date.now() - context.startedAt;
    for (const hook of this.globalHooks.finalized) {
      try {
        await hook(result, context);
      } catch (error) {
        this.#logFailure("tool.finalized-hook.failed", context.toolName, error);
      }
    }
  }

  #initializeContext(toolCall: ToolCallLike, context: ToolExecutionContext): void {
    context.toolName = toolCall.toolName;
    context.toolCallId = toolCall.toolCallId;
    context.input = toolCall.input;
    context.redactedInput = this.#finalizer.redactValue(toolCall.input);
    context.startedAt = Date.now();
    context.outputCapture = undefined;
  }

  #redactDecision(decision: PermissionDecision): PermissionDecision {
    return this.#finalizer.redactValue(decision);
  }

  async #createBlockedOutcome(
    toolCall: ToolCallLike,
    context: ToolExecutionContext,
    request: ToolBlockedRequest,
  ): Promise<RegistryExecutionOutcome> {
    try {
      return {
        kind: "blocked",
        request,
        requestKey: this.#hitlCodec.createToolRequestKey({
          sessionId: context.store.getState().sessionId,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          request,
        }),
      };
    } catch (error) {
      return this.settleSystem(toolCall, context, pipelineError("execution", error, false));
    }
  }

  #cancelledResume(
    toolCall: ToolCallLike,
    context: ToolExecutionContext,
    reason: string,
  ): Promise<RegistryExecutionOutcome> {
    return this.settleSystem(toolCall, context, createToolErrorResult({
      kind: "cancelled",
      code: "TOOL_CANCELLED",
      message: reason,
    }));
  }

  #invalidResume(toolCall: ToolCallLike, context: ToolExecutionContext): Promise<RegistryExecutionOutcome> {
    return this.settleSystem(toolCall, context, createToolErrorResult({
      kind: "execution",
      code: "TOOL_BLOCKED_RESPONSE_INVALID",
      message: "Blocked tool response does not match the original request",
    }));
  }

  #logFailure(event: string, toolName: string, error: unknown): void {
    this.#logger.warn(event, {
      context: { tool: toolName },
      error: { name: error instanceof Error ? error.name : "NonErrorThrow" },
    });
  }
}

function pipelineError(
  kind: "prepare-input" | "permission-denied" | "execution" | "after-hook",
  error: unknown,
  unknownResult: boolean,
): RawToolResult {
  const raw = createToolErrorResult({ kind, error });
  if (!unknownResult) return raw;
  return {
    ...raw,
    details: { ...raw.details, unknownResult: true },
  };
}

function denyResult(decision: PermissionDecision, context: ToolExecutionContext): RawToolResult {
  const extractedCode = extractCode(decision.reason ?? "");
  const code = decision.errorCode ?? extractedCode ?? "TOOL_PERMISSION_DENIED";
  const raw = createToolErrorResult({
    kind: decision.errorKind ?? kindFromCode(code) ?? "permission-denied",
    code,
    message: decision.reason ?? `Tool "${context.toolName}" permission denied`,
  });
  return decision.executionControl === undefined
    ? raw
    : { ...raw, sidecar: { executionControl: decision.executionControl } };
}

function permissionDisplayPayload(
  request: {
    readonly toolName: string;
    readonly input: unknown;
    readonly description: string;
    readonly reason?: string;
    readonly decisionDisplay?: string;
  },
  finalizer: ToolOutputFinalizer,
) {
  const safe = (value: string) => finalizer.redactString(value);
  return {
    title: safe(`Approve ${request.toolName}`),
    summary: safe(request.reason ?? request.description),
    fields: [
      { label: "Tool", value: safe(request.toolName) },
      { label: "Input", value: safe(JSON.stringify(finalizer.redactValue(request.input))) },
      ...(request.decisionDisplay === undefined
        ? []
        : [{ label: "Decision", value: safe(request.decisionDisplay) }]),
    ],
    redacted: true as const,
  };
}

function isEffectfulTool(descriptor: AnyToolDescriptor): boolean {
  return descriptor.traits.destructive || !descriptor.traits.readOnly;
}

function shouldUseProjectApprovalForAsk(
  _descriptor: AnyToolDescriptor,
  _context: ToolExecutionContext,
): boolean {
  return true;
}

export class ResolvedToolSet {
  readonly descriptors: readonly AnyToolDescriptor[];

  constructor(descriptors: readonly AnyToolDescriptor[]) {
    this.descriptors = descriptors;
  }

  has(name: string): boolean {
    return this.descriptors.some((descriptor) => descriptor.name === name);
  }

  get(name: string): AnyToolDescriptor | undefined {
    return this.descriptors.find((descriptor) => descriptor.name === name);
  }

  toAITools(): Record<string, { description: string; inputSchema: AiToolInputSchema }> {
    return Object.fromEntries(this.descriptors.map((descriptor) => [
      descriptor.name,
      {
        description: descriptor.description,
        inputSchema: descriptor.aiInputSchema ?? descriptor.inputSchema,
      },
    ]));
  }
}

export function createRegistry(
  options: ToolRegistryOptions,
  descriptors: AnyToolDescriptor[] = [],
): ToolRegistry {
  const registry = new ToolRegistry(options);
  registry.registerAll(descriptors);
  return registry;
}
