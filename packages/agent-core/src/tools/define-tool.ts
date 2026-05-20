import type { z } from "zod";
import type {
  AiToolInputSchema,
  ToolTraits,
  ToolDescriptor,
  ToolExecutionContext,
  MaybePromise,
  BeforeHook,
  AfterHook,
  ToolPermission,
  ToolExecutionResult,
} from "./types";

export type { ToolDescriptor } from "./types";

interface DefineToolConfig<T extends z.ZodTypeAny, O extends string | ToolExecutionResult> {
  name: string;
  description: string;
  inputSchema: T;
  aiInputSchema?: AiToolInputSchema;
  traits: ToolTraits;
  hooks?: {
    before?: BeforeHook[];
    after?: AfterHook[];
  };
  prepareInput?: (raw: unknown, ctx: ToolExecutionContext) => MaybePromise<unknown>;
  permissions?: ToolPermission[];
  execute: (input: z.infer<T>, ctx: ToolExecutionContext) => MaybePromise<O>;
}

export function defineTool<T extends z.ZodTypeAny, O extends string | ToolExecutionResult = string>(
  config: DefineToolConfig<T, O>,
): ToolDescriptor<z.infer<T>, O> {
  return {
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    ...(config.aiInputSchema !== undefined ? { aiInputSchema: config.aiInputSchema } : {}),
    traits: config.traits,
    hooks: config.hooks,
    prepareInput: config.prepareInput,
    permissions: config.permissions,
    execute: config.execute,
  };
}
