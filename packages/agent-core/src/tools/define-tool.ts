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
  ChildToolDependency,
  ToolDescriptorExecutionResult,
  ToolOutputPolicy,
} from "./types";
import type { ChildExecutionOutcome } from "../delegation/types";

export type { ToolDescriptor } from "./types";

interface DefineToolConfig<
  T extends z.ZodTypeAny,
  O extends ToolDescriptorExecutionResult,
> {
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
  resumeChildDependency?: (
    input: z.infer<T>,
    dependency: ChildToolDependency,
    outcome: Extract<ChildExecutionOutcome, { outcome: "terminal" }>,
    ctx: ToolExecutionContext,
  ) => MaybePromise<RawToolResult>;
  permissions?: ToolPermission[];
  execute: (input: z.infer<T>, ctx: ToolExecutionContext) => MaybePromise<O>;
}

export function defineTool<T extends z.ZodTypeAny>(
  config: DefineToolConfig<T, RawToolResult>,
): ToolDescriptor<z.infer<T>, RawToolResult>;
export function defineTool<
  T extends z.ZodTypeAny,
  O extends ToolDescriptorExecutionResult,
>(
  config: DefineToolConfig<T, O>,
): ToolDescriptor<z.infer<T>, O>;
export function defineTool<
  T extends z.ZodTypeAny,
  O extends ToolDescriptorExecutionResult,
>(
  config: DefineToolConfig<T, O>,
): ToolDescriptor<z.infer<T>, O> {
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
    resumeChildDependency: config.resumeChildDependency,
    permissions: config.permissions,
    execute: config.execute,
  };
}
