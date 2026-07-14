import type { Schema as AiSchema } from "ai";
import type { StoreApi } from "zustand";
import type { SessionStoreState } from "../store/index";
import type { SessionStoreManager } from "../store/session-store-manager";
import type { ToolErrorKind } from "./errors";
import type { ZodTypeAny } from "zod";
import type { ChildExecutionHandle, ChildExecutionRequest, ResumeChildRequest } from "../delegation/types";
import type { PermissionApprovalRequest } from "./permission/policy-types";
import type { ProjectContext } from "../projects/types";
import type { SkillService } from "../skills";

export interface ToolHitlJournalContext {
  readonly toolCalls: readonly ToolCallLike[];
  readonly completedToolResults: readonly ToolExecutionResultWithCall[];
  readonly pendingToolCalls: readonly ToolCallLike[];
  readonly blockedToolIndex: number;
  readonly assistantMessageId?: string;
}

export interface ToolExecutionResultWithCall extends ToolExecutionResult {
  readonly toolCallId: string;
  readonly toolName: string;
}

export type MaybePromise<T> = T | Promise<T>;

export interface ToolTraits {
  readOnly: boolean;
  destructive: boolean;
  concurrencySafe: boolean;
}

export interface ToolExecutionResult {
  output: string;
  isError: boolean;
  meta?: Record<string, unknown>;
}

export interface ToolAttemptMetadata {
  attemptId: string;
  toolCallId: string;
  toolName: string;
  timestamp: number;
  destructive: boolean;
}

export interface ToolExecutionControl {
  readonly action: "stop_session_family";
  readonly reason: "goal_cancelled";
}

export interface ToolExecutionContext {
  store: StoreApi<SessionStoreState>;
  storeManager: SessionStoreManager;
  toolName: string;
  toolCallId: string;
  input: unknown;
  redactedInput?: unknown;
  toolTraits?: ToolTraits;
  permissionOutcome?: "allow" | "deny" | "ask";
  step: number;
  abort: AbortSignal;
  agentName?: string;
  startedAt: number;
  durationMs?: number;
  allowedTools: ReadonlySet<string>;
  /** Agent definition Skill allow-list used for Skill permission decisions. */
  agentSkills?: readonly string[];
  /** Shared Skill service for agent-scoped skill lookup. */
  skillService?: SkillService;
  projectContext: ProjectContext;
  /** Current Session execution directory. This may be a worktree and is independent of the canonical project context. */
  readonly cwd: string;
  confirmPermission?: ToolConfirmationCallback;
  askUser?: AskUserCallback;
  startChildExecution?: (request: ChildExecutionRequest) => Promise<ChildExecutionHandle>;
  cancelChildSession?: (workspaceRoot: string, parentSessionId: string, childSessionId: string) => boolean;
  resumeChildSession?: (workspaceRoot: string, request: ResumeChildRequest) => Promise<ChildExecutionHandle>;
  /** Acquires a root-scoped cwd-transition lease; callers must always release it. */
  acquireSessionCwdTransition?: (workspaceRoot: string, sessionId: string) => () => void;
  currentDepth?: number;
  /** Called once after prepareInput + safeParse succeeds, with the resolved (defaults-filled, redacted) input. */
  onInputResolved?: (redactedInput: unknown) => void;
  /** Called immediately before an effectful tool's execute() can perform side effects. */
  onToolAttempt?: (attempt: ToolAttemptMetadata) => MaybePromise<void>;
  /** Current ordered model tool-call batch details recorded in the Session HITL journal. */
  hitlJournal?: ToolHitlJournalContext;
}

type ToolExecutionContextInput = ToolExecutionContext;

export function createToolExecutionContext(
  base: ToolExecutionContextInput,
): ToolExecutionContext {
  return base;
}

export type BeforeHook = (
  input: unknown,
  ctx: ToolExecutionContext,
) => MaybePromise<unknown | void>;

export type AfterHook = (
  result: ToolExecutionResult,
  ctx: ToolExecutionContext,
) => MaybePromise<ToolExecutionResult | void>;

export type PermissionDecision = {
  outcome: "allow" | "deny" | "ask";
  reason?: string;
  prompt?: string;
  errorKind?: ToolErrorKind;
  errorCode?: string;
  approval?: PermissionApprovalRequest;
  source?: "builtin-policy" | "tool-guard" | "project-approval" | "mcp";
  ruleId?: string;
  display?: string;
  executionControl?: ToolExecutionControl;
};

export type ToolPermission = (
  input: unknown,
  ctx: ToolExecutionContext,
) => MaybePromise<PermissionDecision>;

export interface ToolConfirmationRequest {
  toolName: string;
  toolCallId: string;
  input: unknown;
  description: string;
  reason?: string;
  approval?: PermissionApprovalRequest;
  agentName?: string;
  currentDepth?: number;
  decisionDisplay?: string;
  ruleId?: string;
}

export type ToolConfirmationResult =
  | "approve_once"
  | "approve_always"
  | "approve"
  | "deny"
  | "timeout";

export type ToolConfirmationCallback = (
  request: ToolConfirmationRequest,
  abortSignal?: AbortSignal,
) => Promise<ToolConfirmationResult>;

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
  questionType?: "decision" | "approval" | "clarification";
  context?: Record<string, unknown>;
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

/**
 * Schema type accepted by AI SDK's `streamText({ tools })` for tool input
 * definitions. This can be a Zod schema (for builtin tools) or an AI SDK
 * `Schema` object (for MCP tools whose inputSchema comes from JSON Schema).
 *
 * When `aiInputSchema` is set on a `ToolDescriptor`, it takes precedence over
 * `inputSchema` when presenting the tool to the LLM. This allows MCP tools to
 * expose their real JSON Schema parameter definitions to the model while still
 * using a loose Zod schema for ArchCode's internal validation pipeline.
 */
export type AiToolInputSchema = ZodTypeAny | AiSchema<unknown>;

export interface ToolDescriptor<I = any, O extends string | ToolExecutionResult = string> {
  name: string;
  description: string;
  /**
   * Zod schema used by ArchCode's internal validation pipeline (`safeParse`).
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
   * keeping the loose Zod `inputSchema` for ArchCode's execution pipeline.
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
  permissions?: ToolPermission[];
  execute: (input: I, ctx: ToolExecutionContext) => MaybePromise<O>;
}

export type AnyToolDescriptor = ToolDescriptor<any, string | ToolExecutionResult>;

export interface ToolCallLike {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export class DuplicateToolError extends Error {
  constructor(toolName: string) {
    super(`Duplicate tool "${toolName}" is already registered`);
    this.name = "DuplicateToolError";
  }
}

export class DestructiveToolPermissionError extends Error {
  constructor(toolName: string) {
    super(`Destructive tool "${toolName}" must declare at least one permission`);
    this.name = "DestructiveToolPermissionError";
  }
}
