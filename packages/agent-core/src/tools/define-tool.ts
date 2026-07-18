import type { z } from "zod";
import type { HitlResponse } from "@archcode/protocol";
import type {
  AiToolInputSchema,
  ToolTraits,
  ToolDescriptor,
  ToolExecutionContext,
  MaybePromise,
  BeforeHook,
  AfterHook,
  ToolPermission,
  RawToolResult,
  ToolOutputPolicy,
} from "./types";

export type { ToolDescriptor } from "./types";

interface DefineToolConfig<T extends z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: T;
  aiInputSchema?: AiToolInputSchema;
  traits: ToolTraits;
  outputPolicy: ToolOutputPolicy;
  hooks?: {
    before?: BeforeHook[];
    after?: AfterHook[];
  };
  prepareInput?: (raw: unknown, ctx: ToolExecutionContext) => MaybePromise<unknown>;
  prepareBlock?: (
    input: z.infer<T>,
    ctx: ToolExecutionContext,
  ) => MaybePromise<import("./types").ToolBlockedRequest>;
  resume?: (
    input: z.infer<T>,
    response: HitlResponse,
    ctx: ToolExecutionContext,
  ) => MaybePromise<RawToolResult>;
  permissions?: ToolPermission[];
  execute: (input: z.infer<T>, ctx: ToolExecutionContext) => MaybePromise<RawToolResult>;
}

export function defineTool<T extends z.ZodTypeAny>(
  config: DefineToolConfig<T>,
): ToolDescriptor<z.infer<T>> {
  return {
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    ...(config.aiInputSchema !== undefined ? { aiInputSchema: config.aiInputSchema } : {}),
    traits: config.traits,
    outputPolicy: config.outputPolicy,
    hooks: config.hooks,
    prepareInput: config.prepareInput,
    prepareBlock: config.prepareBlock,
    resume: config.resume,
    permissions: config.permissions,
    execute: config.execute,
  };
}
