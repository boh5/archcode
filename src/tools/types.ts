import type { StoreApi } from "zustand";
import type { SessionStoreState } from "../store/index";
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
  step: number;
  abort: AbortSignal;
  agentName?: string;
  startedAt: number;
  durationMs?: number;
  allowedTools: ReadonlySet<string>;
  workspaceRoot: string;
  confirmPermission?: ToolConfirmationCallback;
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

// ─── Descriptor ───

export interface ToolDescriptor<I = any> {
  name: string;
  description: string;
  inputSchema: ZodTypeAny;
  traits: ToolTraits;
  hooks?: {
    before?: BeforeHook[];
    after?: AfterHook[];
  };
  prepareInput?: (raw: unknown, ctx: ToolExecutionContext) => MaybePromise<unknown>;
  guards?: GuardHook[];
  execute: (input: I, ctx: ToolExecutionContext) => MaybePromise<string>;
}

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
