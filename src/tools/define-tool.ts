import type { z } from "zod";
import type {
  ToolTraits,
  ToolDescriptor,
  ToolExecutionContext,
  MaybePromise,
  BeforeHook,
  AfterHook,
  GuardHook,
  ToolExecutionResult,
} from "./types";

interface DefineToolConfig<T extends z.ZodTypeAny, O extends string | ToolExecutionResult> {
  name: string;
  description: string;
  inputSchema: T;
  traits: ToolTraits;
  hooks?: {
    before?: BeforeHook[];
    after?: AfterHook[];
  };
  prepareInput?: (raw: unknown, ctx: ToolExecutionContext) => MaybePromise<unknown>;
  guards?: GuardHook[];
  execute: (input: z.infer<T>, ctx: ToolExecutionContext) => MaybePromise<O>;
}

export function defineTool<T extends z.ZodTypeAny, O extends string | ToolExecutionResult = string>(
  config: DefineToolConfig<T, O>,
): ToolDescriptor<z.infer<T>, O> {
  return {
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    traits: config.traits,
    hooks: config.hooks,
    prepareInput: config.prepareInput,
    guards: config.guards,
    execute: config.execute,
  };
}
