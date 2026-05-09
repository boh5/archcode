import type { Schema as AiSchema } from "ai";
import type { StoreApi } from "zustand";
import type { SessionStoreState } from "../store/index";
import type { ToolErrorKind } from "./errors";
import type { ZodTypeAny } from "zod";

// ─── Utility ───

export type MaybePromise<T> = T | Promise<T>;

// ─── Traits ───

export interface ToolTraits {
  readOnly: boolean;
  destructive: boolean;
  concurrencySafe: boolean;
}

// ─── Execution ───

export interface ToolExecutionResult {
  output: string;
  isError: boolean;
  meta?: Record<string, unknown>;
}

export interface ToolExecutionContext {
  store: StoreApi<SessionStoreState>;
  toolName: string;
  toolCallId: string;
  input: unknown;
  redactedInput?: unknown;
  permissionOutcome?: "allow" | "deny" | "ask";
  step: number;
  abort: AbortSignal;
  agentName?: string;
  startedAt: number;
  durationMs?: number;
  allowedTools: ReadonlySet<string>;
  workspaceRoot: string;
  confirmPermission?: ToolConfirmationCallback;
  askUser?: AskUserCallback;
}

// ─── Logger ───

export interface Logger {
  debug?(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
}

// ─── Hooks ───

export type BeforeHook = (
  input: unknown,
  ctx: ToolExecutionContext,
) => MaybePromise<unknown | void>;

export type AfterHook = (
  result: ToolExecutionResult,
  ctx: ToolExecutionContext,
) => MaybePromise<ToolExecutionResult | void>;

// ─── Guards & Permissions ───

export type GuardDecision = {
  outcome: "allow" | "deny" | "ask";
  reason?: string;
  prompt?: string;
  errorKind?: ToolErrorKind;
  errorCode?: string;
};

export type GuardHook = (
  input: unknown,
  ctx: ToolExecutionContext,
) => MaybePromise<GuardDecision>;

export interface ToolConfirmationRequest {
  toolName: string;
  toolCallId: string;
  input: unknown;
  description: string;
  reason?: string;
}

export type ToolConfirmationCallback = (
  request: ToolConfirmationRequest,
) => Promise<"approve" | "deny" | "timeout">;

// ─── Ask User ───

export interface AskUserQuestionOption {
  label: string;
  description: string;
}

export interface AskUserQuestion {
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multiple?: boolean;
  custom: boolean;
}

export interface AskUserRequest {
  toolName: string;
  toolCallId: string;
  questions: AskUserQuestion[];
  abortSignal?: AbortSignal;
}

export type AskUserAnswer = string[];

export type AskUserCallback = (
  request: AskUserRequest,
) => Promise<{ answers: AskUserAnswer[] } | { isError: true; reason: string }>;

export type PermissionErrorCode =
  | "TOOL_UNKNOWN"
  | "TOOL_NOT_ALLOWED"
  | "TOOL_PERMISSION_DENIED"
  | "TOOL_PERMISSION_CONFIRMATION_DENIED"
  | "TOOL_PERMISSION_CONFIRMATION_TIMEOUT"
  | "TOOL_PERMISSION_CONFIRMATION_UNAVAILABLE"
  | "TOOL_PERMISSION_CONFIRMATION_FAILED"
  | "TOOL_PREPARE_INPUT_FAILED"
  | "TOOL_FILE_OUTSIDE_WORKSPACE"
  | "TOOL_FILE_ALREADY_EXISTS"
  | "TOOL_FILE_NOT_READ_FIRST"
  | "TOOL_FILE_WRITE_CONFLICT";

// ─── AI Tool Schema ───

/**
 * Schema type accepted by AI SDK's `streamText({ tools })` for tool input
 * definitions. This can be a Zod schema (for builtin tools) or an AI SDK
 * `Schema` object (for MCP tools whose inputSchema comes from JSON Schema).
 *
 * When `aiInputSchema` is set on a `ToolDescriptor`, it takes precedence over
 * `inputSchema` when presenting the tool to the LLM. This allows MCP tools to
 * expose their real JSON Schema parameter definitions to the model while still
 * using a loose Zod schema for Specra's internal validation pipeline.
 */
export type AiToolInputSchema = ZodTypeAny | AiSchema<unknown>;

// ─── Descriptor ───

export interface ToolDescriptor<I = any, O extends string | ToolExecutionResult = string> {
  name: string;
  description: string;
  /**
   * Zod schema used by Specra's internal validation pipeline (`safeParse`).
   * For builtin tools this is a precise schema; for MCP tools it's a loose
   * `z.object({}).catchall(z.unknown())` that accepts any object — real
   * validation is delegated to the MCP server.
   */
  inputSchema: ZodTypeAny;
  /**
   * Optional schema for the LLM. When set, this is used instead of
   * `inputSchema` when presenting the tool definition to the AI model via
   * `toAITools()`. This allows MCP tools to expose their real JSON Schema
   * parameter definitions so the model knows what arguments to pass, while
   * keeping the loose Zod `inputSchema` for Specra's execution pipeline.
   *
   * Builtin tools leave this undefined — their Zod `inputSchema` serves both
   * roles.
   */
  aiInputSchema?: AiToolInputSchema;
  traits: ToolTraits;
  hooks?: {
    before?: BeforeHook[];
    after?: AfterHook[];
  };
  prepareInput?: (raw: unknown, ctx: ToolExecutionContext) => MaybePromise<unknown>;
  guards?: GuardHook[];
  execute: (input: I, ctx: ToolExecutionContext) => MaybePromise<O>;
}

export type AnyToolDescriptor = ToolDescriptor<any, string | ToolExecutionResult>;

// ─── Tool Call ───

export interface ToolCallLike {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

// ─── Errors ───

export class DuplicateToolError extends Error {
  constructor(toolName: string) {
    super(`Duplicate tool "${toolName}" is already registered`);
    this.name = "DuplicateToolError";
  }
}
