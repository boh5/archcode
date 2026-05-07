import type { StoreApi } from "zustand";
import type { SessionStoreState } from "../store/index";
import type { ZodTypeAny } from "zod";

// ─── Utility ───

export type MaybePromise<T> = T | Promise<T>;

// ─── Capabilities ───

export interface ToolCapabilities {
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

// ─── Descriptor ───

export interface ToolDescriptor<I = any> {
  name: string;
  description: string;
  inputSchema: ZodTypeAny;
  capabilities: ToolCapabilities;
  hooks?: {
    before?: BeforeHook[];
    after?: AfterHook[];
  };
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
