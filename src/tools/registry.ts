import type { ZodTypeAny } from "zod";
import type {
  ToolDescriptor,
  AnyToolDescriptor,
  AiToolInputSchema,
  Logger,
  BeforeHook,
  AfterHook,
  ToolCallLike,
  ToolExecutionContext,
  ToolExecutionResult,
  GuardHook,
  GuardDecision,
  PermissionErrorCode,
} from "./types";
import { DuplicateToolError } from "./types";
import {
  combineGuardDecisions,
  createPermissionErrorResult,
} from "./hooks/permission";
import { redactString, redactValue } from "./hooks/redact";
import {
  createToolErrorResult,
  extractCode,
  inferToolErrorKindFromResult,
  kindFromCode,
  normalizeToolErrorResult,
} from "./errors";

export class ToolRegistry {
  private _descriptors: Map<string, AnyToolDescriptor>;
  private _logger: Logger | undefined;

  globalHooks: { before: BeforeHook[]; after: AfterHook[] };
  globalGuards: GuardHook[];

  constructor(logger?: Logger) {
    this._descriptors = new Map();
    this._logger = logger;
    this.globalHooks = { before: [], after: [] };
    this.globalGuards = [];
  }

  register(descriptor: AnyToolDescriptor): void {
    if (this._descriptors.has(descriptor.name)) {
      throw new DuplicateToolError(descriptor.name);
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
        this._logger?.warn?.(`Unknown tool "${name}" requested by agent`);
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

        try {
          const output = await descriptor.execute(currentInput, ctx);
          result = normalizeExecuteOutput(output);
        } catch (err) {
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
              result = createToolErrorResult({ kind: "after-hook", error: err });
            }
          }
        }
      } catch (err) {
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
    const decisions: GuardDecision[] = [];

    try {
      for (const guard of this.globalGuards) {
        decisions.push(redactDecision(await guard(input, ctx)));
      }

      if (descriptor.guards) {
        for (const guard of descriptor.guards) {
          decisions.push(redactDecision(await guard(input, ctx)));
        }
      }
    } catch (err) {
      return createPermissionErrorResult(
        "TOOL_PERMISSION_DENIED",
        errorMessage(err),
      );
    }

    const decision = combineGuardDecisions(decisions);
    ctx.permissionOutcome = decision.outcome;
    if (decision.outcome === "allow") {
      return undefined;
    }

    if (decision.outcome === "deny") {
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

    if (!ctx.confirmPermission) {
      return createPermissionErrorResult(
        "TOOL_PERMISSION_CONFIRMATION_UNAVAILABLE",
        decision.reason ?? `Tool "${ctx.toolName}" requires confirmation`,
      );
    }

    try {
      const confirmation = await ctx.confirmPermission({
        toolName: ctx.toolName,
        toolCallId: ctx.toolCallId,
        input: ctx.redactedInput ?? redactValue(input),
        description: descriptor.description,
        reason: decision.prompt ?? decision.reason,
      });

      if (confirmation === "approve") {
        return undefined;
      }

      const code: PermissionErrorCode =
        confirmation === "timeout"
          ? "TOOL_PERMISSION_CONFIRMATION_TIMEOUT"
          : "TOOL_PERMISSION_CONFIRMATION_DENIED";
      return createPermissionErrorResult(
        code,
        decision.reason ?? `Tool "${ctx.toolName}" confirmation ${confirmation}`,
      );
    } catch (err) {
      return createPermissionErrorResult(
        "TOOL_PERMISSION_CONFIRMATION_FAILED",
        errorMessage(err),
      );
    }
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

function redactDecision(decision: GuardDecision): GuardDecision {
  return {
    outcome: decision.outcome,
    ...(decision.reason ? { reason: redactString(decision.reason) } : {}),
    ...(decision.prompt ? { prompt: redactString(decision.prompt) } : {}),
    ...(decision.errorKind ? { errorKind: decision.errorKind } : {}),
    ...(decision.errorCode ? { errorCode: decision.errorCode } : {}),
  };
}

function isAllowedTool(ctx: ToolExecutionContext, name: string): boolean {
  return ctx.allowedTools.has(name);
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
