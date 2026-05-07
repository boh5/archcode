import type { ZodTypeAny } from "zod";
import type {
  ToolDescriptor,
  Logger,
  BeforeHook,
  AfterHook,
  ToolCallLike,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types.js";
import { DuplicateToolError } from "./types.js";

export class ToolRegistry {
  private _descriptors: Map<string, ToolDescriptor>;
  private _logger: Logger | undefined;

  globalHooks: { before: BeforeHook[]; after: AfterHook[] };

  constructor(logger?: Logger) {
    this._descriptors = new Map();
    this._logger = logger;
    this.globalHooks = { before: [], after: [] };
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

    const descriptor = this._descriptors.get(toolCall.toolName);
    if (!descriptor) {
      return {
        output: `Tool "${toolCall.toolName}" is not registered`,
        isError: true,
      };
    }

    let parsed = descriptor.inputSchema.safeParse(toolCall.input);
    if (!parsed.success) {
      return { output: parsed.error.message, isError: true };
    }
    let currentInput = parsed.data;

    let result: ToolExecutionResult = { output: "", isError: false };

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
            output: err instanceof Error ? err.message : String(err),
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
                output: err instanceof Error ? err.message : String(err),
                isError: true,
              };
            }
          }
        }
      } catch (err) {
        result = {
          output: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    }

    for (const hook of this.globalHooks.after) {
      try {
        const mutated = await hook(result, ctx);
        if (mutated !== undefined) {
          result = mutated;
        }
      } catch (err) {
        result = {
          output: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    }

    return result;
  }
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
