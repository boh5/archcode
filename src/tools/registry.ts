import type { ZodTypeAny } from "zod";
import type {
  ToolDescriptor,
  Logger,
  BeforeHook,
  AfterHook,
  ToolCallLike,
  ToolExecutionContext,
  ToolExecutionResult,
  GuardHook,
  GuardDecision,
  PermissionErrorCode,
} from "./types.js";
import { DuplicateToolError } from "./types.js";
import {
  combineGuardDecisions,
  createPermissionErrorResult,
} from "./hooks/permission.js";

export class ToolRegistry {
  private _descriptors: Map<string, ToolDescriptor>;
  private _logger: Logger | undefined;

  globalHooks: { before: BeforeHook[]; after: AfterHook[] };
  globalGuards: GuardHook[];

  constructor(logger?: Logger) {
    this._descriptors = new Map();
    this._logger = logger;
    this.globalHooks = { before: [], after: [] };
    this.globalGuards = [];
  }

  register(descriptor: ToolDescriptor): void {
    if (this._descriptors.has(descriptor.name)) {
      throw new DuplicateToolError(descriptor.name);
    }
    this._descriptors.set(descriptor.name, descriptor);
  }

  registerAll(descriptors: ToolDescriptor[]): void {
    for (const desc of descriptors) {
      this.register(desc);
    }
  }

  get(name: string): ToolDescriptor | undefined {
    return this._descriptors.get(name);
  }

  getAll(): ToolDescriptor[] {
    return Array.from(this._descriptors.values());
  }

  resolveForAgent(toolNames?: readonly string[]): ResolvedToolSet {
    if (!toolNames || toolNames.length === 0) {
      return new ResolvedToolSet([]);
    }

    const resolved: ToolDescriptor[] = [];

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
      return { output: parsed.error.message, isError: true };
    }
    let currentInput = parsed.data;

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
              result = { output: parsed.error.message, isError: true };
              break pipeline;
            }
            currentInput = parsed.data;
          }
        }

        if (descriptor.hooks?.before) {
          for (const hook of descriptor.hooks.before) {
            const mutation = await hook(currentInput, ctx);
            if (mutation !== undefined) {
              parsed = descriptor.inputSchema.safeParse(mutation);
              if (!parsed.success) {
                result = { output: parsed.error.message, isError: true };
                break pipeline;
              }
              currentInput = parsed.data;
            }
          }
        }

        try {
          const output = await descriptor.execute(currentInput, ctx);
          result = { output, isError: false };
        } catch (err) {
          result = {
            output: errorMessage(err),
            isError: true,
          };
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
              result = {
                output: errorMessage(err),
                isError: true,
              };
            }
          }
        }
      } catch (err) {
        result = {
          output: errorMessage(err),
          isError: true,
        };
      }
    }

    return this.runGlobalAfterHooks(result, ctx);
  }

  private async resolvePermission(
    descriptor: ToolDescriptor,
    input: unknown,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult | undefined> {
    const decisions: GuardDecision[] = [];

    try {
      for (const guard of this.globalGuards) {
        decisions.push(await guard(input, ctx));
      }

      if (descriptor.guards) {
        for (const guard of descriptor.guards) {
          decisions.push(await guard(input, ctx));
        }
      }
    } catch (err) {
      return createPermissionErrorResult(
        "TOOL_PERMISSION_DENIED",
        errorMessage(err),
      );
    }

    const decision = combineGuardDecisions(decisions);
    if (decision.outcome === "allow") {
      return undefined;
    }

    if (decision.outcome === "deny") {
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
        input,
        description: descriptor.description,
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
        result = {
          output: errorMessage(err),
          isError: true,
        };
      }
    }

    return result;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAllowedTool(ctx: ToolExecutionContext, name: string): boolean {
  return ctx.allowedTools.has(name);
}

export class ResolvedToolSet {
  readonly descriptors: readonly ToolDescriptor[];

  constructor(descriptors: readonly ToolDescriptor[]) {
    this.descriptors = descriptors;
  }

  has(name: string): boolean {
    return this.descriptors.some((d) => d.name === name);
  }

  get(name: string): ToolDescriptor | undefined {
    return this.descriptors.find((d) => d.name === name);
  }

  toAITools(): Record<string, { description: string; inputSchema: ZodTypeAny }> {
    const result: Record<
      string,
      { description: string; inputSchema: ZodTypeAny }
    > = {};

    for (const desc of this.descriptors) {
      result[desc.name] = {
        description: desc.description,
        inputSchema: desc.inputSchema,
      };
    }

    return result;
  }
}

export function createRegistry(
  descriptors?: ToolDescriptor[],
  logger?: Logger,
): ToolRegistry {
  const registry = new ToolRegistry(logger);
  if (descriptors) {
    registry.registerAll(descriptors);
  }
  return registry;
}
