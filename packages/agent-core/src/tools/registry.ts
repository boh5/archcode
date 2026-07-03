import type {
  AnyToolDescriptor,
  AiToolInputSchema,
  BeforeHook,
  AfterHook,
  ToolCallLike,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPermission,
  PermissionDecision,
} from "./types";
import type { Logger } from "../logger";
import { silentLogger } from "../logger";
import { DuplicateToolError, DestructiveToolPermissionError } from "./types";
import { createPermissionErrorResult } from "./permission";
import { redactString, redactValue } from "./security/redaction";
import {
  createToolErrorResult,
  extractCode,
  inferToolErrorKindFromResult,
  kindFromCode,
  normalizeToolErrorResult,
} from "./errors";

export class ToolRegistry {
  private _descriptors: Map<string, AnyToolDescriptor>;
  private _logger: Logger;

  globalHooks: { before: BeforeHook[]; after: AfterHook[] };
  globalPermissions: ToolPermission[];

  constructor(logger?: Logger) {
    this._descriptors = new Map();
    this._logger = logger ?? silentLogger;
    this.globalHooks = { before: [], after: [] };
    this.globalPermissions = [];
  }

  register(descriptor: AnyToolDescriptor): void {
    if (this._descriptors.has(descriptor.name)) {
      throw new DuplicateToolError(descriptor.name);
    }
    if (descriptor.traits.destructive && (!descriptor.permissions || descriptor.permissions.length === 0)) {
      throw new DestructiveToolPermissionError(descriptor.name);
    }
    this._descriptors.set(descriptor.name, descriptor);
  }

  registerAll(descriptors: AnyToolDescriptor[]): void {
    for (const desc of descriptors) {
      this.register(desc);
    }
  }

  get(name: string): AnyToolDescriptor | undefined {
    return this._descriptors.get(name);
  }

  getAll(): AnyToolDescriptor[] {
    return Array.from(this._descriptors.values());
  }

  listByPrefix(prefix: string): AnyToolDescriptor[] {
    const results: AnyToolDescriptor[] = [];
    for (const [name, desc] of this._descriptors) {
      if (name.startsWith(prefix)) {
        results.push(desc);
      }
    }
    return results;
  }

  resolveForAgent(toolNames?: readonly string[]): ResolvedToolSet {
    if (!toolNames || toolNames.length === 0) {
      return new ResolvedToolSet([]);
    }

    const resolved: AnyToolDescriptor[] = [];

    for (const name of toolNames) {
      const desc = this._descriptors.get(name);
      if (desc) {
        resolved.push(desc);
      } else {
        this._logger.warn("tool.resolve.unknown", {
          meta: { toolName: name },
        });
      }
    }

    return new ResolvedToolSet(resolved);
  }

  async execute(
    toolCall: ToolCallLike,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    ctx.toolName = toolCall.toolName;
    ctx.toolCallId = toolCall.toolCallId;
    ctx.input = toolCall.input;
    ctx.redactedInput = redactValue(toolCall.input);
    ctx.startedAt = Date.now();

    let result: ToolExecutionResult;

    const descriptor = this._descriptors.get(toolCall.toolName);
    if (!descriptor) {
      result = createPermissionErrorResult(
        "TOOL_UNKNOWN",
        `Tool "${toolCall.toolName}" is not registered`,
      );
      return this.runGlobalAfterHooks(result, ctx);
    }

    let rawInput = toolCall.input;
    if (descriptor.prepareInput) {
      try {
        rawInput = await descriptor.prepareInput(rawInput, ctx);
      } catch (err) {
        result = createPermissionErrorResult(
          "TOOL_PREPARE_INPUT_FAILED",
          errorMessage(err),
        );
        return this.runGlobalAfterHooks(result, ctx);
      }
    }

    let parsed = descriptor.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return this.runGlobalAfterHooks(
        createToolErrorResult({
          kind: "schema",
          zodError: parsed.error,
          expectedInput: `Tool "${descriptor.name}" input must match its registered Zod schema.`,
        }),
        ctx,
      );
    }
    let currentInput = parsed.data;
    ctx.redactedInput = redactValue(currentInput);

    if (ctx.onInputResolved) {
      try {
        ctx.onInputResolved(ctx.redactedInput);
      } catch (err) {
        this._logger.warn("tool.onInputResolved.error", {
          context: { tool: descriptor.name },
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (!isAllowedTool(ctx, toolCall.toolName)) {
      result = createPermissionErrorResult(
        "TOOL_NOT_ALLOWED",
        `Tool "${toolCall.toolName}" is not allowed for this execution context`,
      );
      return this.runGlobalAfterHooks(result, ctx);
    }

    const permissionResult = await this.resolvePermission(
      descriptor,
      currentInput,
      ctx,
    );
    if (permissionResult) {
      return this.runGlobalAfterHooks(permissionResult, ctx);
    }

    result = { output: "", isError: false };

    pipeline: {
      try {
        for (const hook of this.globalHooks.before) {
          const mutation = await hook(currentInput, ctx);
          if (mutation !== undefined) {
            parsed = descriptor.inputSchema.safeParse(mutation);
            if (!parsed.success) {
              result = createToolErrorResult({
                kind: "before-hook-schema",
                zodError: parsed.error,
                expectedInput: `Tool "${descriptor.name}" input must still match its registered Zod schema after global before hooks.`,
              });
              break pipeline;
            }
            currentInput = parsed.data;
            ctx.redactedInput = redactValue(currentInput);
          }
        }

        if (descriptor.hooks?.before) {
          for (const hook of descriptor.hooks.before) {
            const mutation = await hook(currentInput, ctx);
            if (mutation !== undefined) {
              parsed = descriptor.inputSchema.safeParse(mutation);
              if (!parsed.success) {
                result = createToolErrorResult({
                  kind: "before-hook-schema",
                  zodError: parsed.error,
                  expectedInput: `Tool "${descriptor.name}" input must still match its registered Zod schema after tool before hooks.`,
                });
                break pipeline;
              }
              currentInput = parsed.data;
              ctx.redactedInput = redactValue(currentInput);
            }
          }
        }

        if (isEffectfulTool(descriptor)) {
          ctx.onToolAttempt?.({
            attemptId: crypto.randomUUID(),
            toolCallId: toolCall.toolCallId,
            toolName: descriptor.name,
            timestamp: Date.now(),
            destructive: descriptor.traits.destructive,
          });
        }

        try {
          const output = await descriptor.execute(currentInput, ctx);
          result = normalizeExecuteOutput(output);
        } catch (err) {
          this._logger.warn("tool.execute.failed", {
            context: { tool: descriptor.name },
            error: String(err),
          });
          result = createToolErrorResult({ kind: "execution", error: err });
        }
        ctx.durationMs = Date.now() - ctx.startedAt;

        if (descriptor.hooks?.after) {
          for (const hook of descriptor.hooks.after) {
            try {
              const mutated = await hook(result, ctx);
              if (mutated !== undefined) {
                result = mutated;
              }
            } catch (err) {
              this._logger.warn("tool.after-hook.failed", {
                context: { tool: descriptor.name },
                error: String(err),
              });
              result = createToolErrorResult({ kind: "after-hook", error: err });
            }
          }
        }
      } catch (err) {
        this._logger.warn("tool.pipeline.failed", {
          context: { tool: descriptor.name },
          error: String(err),
        });
        result = createToolErrorResult({ kind: "execution", error: err });
      }
    }

    return this.runGlobalAfterHooks(result, ctx);
  }

  private async resolvePermission(
    descriptor: AnyToolDescriptor,
    input: unknown,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult | undefined> {
    const decisions: PermissionDecision[] = [];

    try {
      for (const permission of this.globalPermissions) {
        decisions.push(redactDecision(await permission(input, ctx)));
      }

      if (descriptor.permissions) {
        for (const permission of descriptor.permissions) {
          decisions.push(redactDecision(await permission(input, ctx)));
        }
      }
    } catch (err) {
      return createPermissionErrorResult(
        "TOOL_PERMISSION_DENIED",
        errorMessage(err),
      );
    }

    const denyDecision = decisions.find((decision) => decision.outcome === "deny");
    if (denyDecision) {
      ctx.permissionOutcome = "deny";
      return createDenyResult(denyDecision, ctx);
    }

    const askDecisions = decisions.filter((decision) => decision.outcome === "ask");
    if (askDecisions.length === 0) {
      ctx.permissionOutcome = "allow";
      return undefined;
    }

    ctx.permissionOutcome = "ask";

    const unsatisfiedAsk = await this.findFirstUnsatisfiedAsk(askDecisions, descriptor, ctx);
    if (!unsatisfiedAsk) {
      return undefined;
    }

    if (!ctx.confirmPermission) {
      return createPermissionErrorResult(
        "TOOL_PERMISSION_CONFIRMATION_UNAVAILABLE",
        unsatisfiedAsk.reason ?? `Tool "${ctx.toolName}" requires confirmation`,
      );
    }

    if (ctx.abort.aborted) {
      return createPermissionErrorResult(
        "TOOL_PERMISSION_CONFIRMATION_TIMEOUT",
        unsatisfiedAsk.reason ?? `Tool "${ctx.toolName}" confirmation timeout`,
      );
    }

    try {
      const confirmation = await ctx.confirmPermission({
        toolName: ctx.toolName,
        toolCallId: ctx.toolCallId,
        input: ctx.redactedInput ?? redactValue(input),
        description: descriptor.description,
        reason: unsatisfiedAsk.prompt ?? unsatisfiedAsk.reason,
        ...(unsatisfiedAsk.approval ? { approval: unsatisfiedAsk.approval } : {}),
        ...(ctx.agentName ? { agentName: ctx.agentName } : {}),
        ...(ctx.currentDepth !== undefined ? { currentDepth: ctx.currentDepth } : {}),
        ...(unsatisfiedAsk.display ? { decisionDisplay: unsatisfiedAsk.display } : {}),
        ...(unsatisfiedAsk.ruleId ? { ruleId: unsatisfiedAsk.ruleId } : {}),
        ...(ctx.origin ? { origin: ctx.origin } : {}),
      }, ctx.abort);

      if (ctx.abort.aborted || confirmation === "timeout") {
        return createPermissionErrorResult(
          "TOOL_PERMISSION_CONFIRMATION_TIMEOUT",
          unsatisfiedAsk.reason ?? `Tool "${ctx.toolName}" confirmation timeout`,
        );
      }

      if (confirmation === "approve" || confirmation === "approve_once") {
        return undefined;
      }

      if (confirmation === "approve_always") {
        const approval = unsatisfiedAsk.approval;
        if (approval?.eligible === true && approval.scope) {
          await ctx.projectContext.approvals.addApproval(approval.scope, {
            display: approval.display,
            reason: approval.reason,
            grantedBy: {
              ...(ctx.agentName ? { agentName: ctx.agentName } : {}),
              ...(ctx.currentDepth !== undefined ? { depth: ctx.currentDepth } : {}),
            },
          });
        }
        return undefined;
      }

      return createPermissionErrorResult(
        "TOOL_PERMISSION_CONFIRMATION_DENIED",
        unsatisfiedAsk.reason ?? `Tool "${ctx.toolName}" confirmation ${confirmation}`,
      );
    } catch (err) {
      return createPermissionErrorResult(
        "TOOL_PERMISSION_CONFIRMATION_FAILED",
        errorMessage(err),
      );
    }
  }

  private async findFirstUnsatisfiedAsk(
    askDecisions: PermissionDecision[],
    descriptor: AnyToolDescriptor,
    ctx: ToolExecutionContext,
  ): Promise<PermissionDecision | undefined> {
    for (const decision of askDecisions) {
      const approval = decision.approval;
      if (approval?.eligible === true && approval.scope) {
        if (shouldUseProjectApprovalForAsk(descriptor, ctx) && ctx.projectContext.approvals.hasApproval(approval.scope)) {
          continue;
        }
      }
      return decision;
    }

    return undefined;
  }

  private async runGlobalAfterHooks(
    initialResult: ToolExecutionResult,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    let result = initialResult;
    ctx.durationMs = Date.now() - ctx.startedAt;

    for (const hook of this.globalHooks.after) {
      try {
        const mutated = await hook(result, ctx);
        if (mutated !== undefined) {
          result = mutated;
        }
      } catch (err) {
        this._logger.warn("tool.global-after-hook.failed", {
          error: String(err),
        });
        result = createToolErrorResult({ kind: "after-hook", error: err });
      }
    }

    return normalizeToolErrorResult(result, {
      kind: inferToolErrorKindFromResult(result) ?? "execution",
    });
  }
}

function normalizeExecuteOutput(output: string | ToolExecutionResult): ToolExecutionResult {
  if (typeof output === "string") {
    return { output, isError: false };
  }

  if (
    output &&
    typeof output === "object" &&
    typeof output.output === "string" &&
    typeof output.isError === "boolean"
  ) {
    return normalizeToolErrorResult(output, {
      kind: inferToolErrorKindFromResult(output) ?? "execution",
    });
  }

  return createToolErrorResult({
    kind: "execution",
    error: output,
    message: "Tool returned an invalid result shape",
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function redactDecision(decision: PermissionDecision): PermissionDecision {
  return {
    outcome: decision.outcome,
    ...(decision.reason ? { reason: redactString(decision.reason) } : {}),
    ...(decision.prompt ? { prompt: redactString(decision.prompt) } : {}),
    ...(decision.errorKind ? { errorKind: decision.errorKind } : {}),
    ...(decision.errorCode ? { errorCode: decision.errorCode } : {}),
    ...(decision.approval ? {
      approval: {
        ...decision.approval,
        display: redactString(decision.approval.display),
        reason: redactString(decision.approval.reason),
      },
    } : {}),
    ...(decision.source ? { source: decision.source } : {}),
    ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
    ...(decision.display ? { display: redactString(decision.display) } : {}),
  };
}

function createDenyResult(
  decision: PermissionDecision,
  ctx: ToolExecutionContext,
): ToolExecutionResult {
  const extractedCode = extractCode(decision.reason ?? "");
  const code = decision.errorCode ?? extractedCode ?? "TOOL_PERMISSION_DENIED";
  if (decision.errorKind || decision.errorCode || extractedCode) {
    return createToolErrorResult({
      kind: decision.errorKind ?? kindFromCode(code) ?? "permission-denied",
      code,
      message: decision.reason ?? `Tool "${ctx.toolName}" permission denied`,
      meta: {
        permissionErrorCode: code,
        skippedExecution: true,
      },
    });
  }

  return createPermissionErrorResult(
    "TOOL_PERMISSION_DENIED",
    decision.reason ?? `Tool "${ctx.toolName}" permission denied`,
  );
}

function isAllowedTool(ctx: ToolExecutionContext, name: string): boolean {
  return ctx.allowedTools.has(name);
}

function isEffectfulTool(descriptor: AnyToolDescriptor): boolean {
  return descriptor.traits.destructive || !descriptor.traits.readOnly;
}

function shouldUseProjectApprovalForAsk(
  descriptor: AnyToolDescriptor,
  ctx: ToolExecutionContext,
): boolean {
  const origin = ctx.origin;
  if (origin?.kind === "loop" && origin.mode === "act" && isEffectfulTool(descriptor)) {
    return false;
  }

  return true;
}

export class ResolvedToolSet {
  readonly descriptors: readonly AnyToolDescriptor[];

  constructor(descriptors: readonly AnyToolDescriptor[]) {
    this.descriptors = descriptors;
  }

  has(name: string): boolean {
    return this.descriptors.some((d) => d.name === name);
  }

  get(name: string): AnyToolDescriptor | undefined {
    return this.descriptors.find((d) => d.name === name);
  }

  toAITools(): Record<string, { description: string; inputSchema: AiToolInputSchema }> {
    const result: Record<
      string,
      { description: string; inputSchema: AiToolInputSchema }
    > = {};

    for (const desc of this.descriptors) {
      result[desc.name] = {
        description: desc.description,
        inputSchema: desc.aiInputSchema ?? desc.inputSchema,
      };
    }

    return result;
  }
}

export function createRegistry(
  descriptors?: AnyToolDescriptor[],
  logger?: Logger,
): ToolRegistry {
  const registry = new ToolRegistry(logger);
  if (descriptors) {
    registry.registerAll(descriptors);
  }
  return registry;
}
