import type { z } from "zod";
import type {
  ToolCapabilities,
  ToolDescriptor,
  ToolExecutionContext,
  MaybePromise,
  BeforeHook,
  AfterHook,
} from "./types.js";

interface DefineToolConfig<T extends z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: T;
  capabilities: ToolCapabilities;
  hooks?: {
    before?: BeforeHook[];
    after?: AfterHook[];
  };
  execute: (input: z.infer<T>, ctx: ToolExecutionContext) => MaybePromise<string>;
}

export function defineTool<T extends z.ZodTypeAny>(
  config: DefineToolConfig<T>,
): ToolDescriptor<z.infer<T>> {
  return {
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    capabilities: config.capabilities,
    hooks: config.hooks,
    execute: config.execute,
  };
}
