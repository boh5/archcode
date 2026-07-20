import type { Schema as AiSchema } from "ai";
import type { HitlResponse } from "@archcode/protocol";
import type { FinalizedToolResult } from "@archcode/protocol";
import type { StoreApi } from "zustand";
import type { SessionStoreState } from "../store/index";
import type { SessionStoreManager } from "../store/session-store-manager";
import type { ToolErrorKind } from "./errors";
import type { ZodTypeAny } from "zod";
import type { ChildExecutionHandle, ChildExecutionRequest, ResumeChildRequest } from "../delegation/types";
import type { PermissionApprovalRequest } from "./permission/policy-types";
import type { ProjectContext } from "../projects/types";
import type { SkillService } from "../skills";
import type {
  RawToolResult,
  ToolBlockedRequest,
  ToolExecutionControl,
  ToolOutputPolicy,
} from "../tool-output/types";
import type { ToolOutputCapture } from "../tool-output/capture";
import type { ToolOutputAccessService } from "../tool-output/access-service";
import type { SessionGoalService } from "../session-goal";

export type {
  RawToolResult,
  RegistryExecutionOutcome,
  ToolBlockedRequest,
  ToolExecutionControl,
  ToolExecutionSidecar,
  ToolOutputPolicy,
} from "../tool-output/types";

export type MaybePromise<T> = T | Promise<T>;

export interface ToolTraits {
  readOnly: boolean;
  destructive: boolean;
  concurrencySafe: boolean;
}

export interface ToolAttemptMetadata {
  attemptId: string;
  toolCallId: string;
  toolName: string;
  timestamp: number;
  destructive: boolean;
}

export type SessionGoalFreshUserAction =
  | "create"
  | "edit"
  | "pause"
  | "resume"
  | "clear"
  | "set_budget";

export interface ConsumeFreshUserInputRequest {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly toolCallId: string;
  readonly action: SessionGoalFreshUserAction;
  /** Runs synchronously inside the one-use consumption critical section. */
  readonly validate?: (grant: FreshUserInputGrant) => void;
}

/**
 * A single-use capability minted by the execution runtime for one actual user
 * input. The text is immutable provenance, not model-supplied Goal content.
 */
export interface FreshUserInputGrant {
  readonly text: string;
}

export interface StructuredResultCorrectionGate {
  readonly submission: "submit_child_result";
  recordFailure(error: Error): RawToolResult;
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
  /** Runtime-wide Session Goal owner. Tools never mutate Session state directly. */
  sessionGoalService?: SessionGoalService;
  /** Runtime-owned one-use capability minted from current direct/queue/steer input. */
  consumeFreshUserInput?: (input: ConsumeFreshUserInputRequest) => MaybePromise<FreshUserInputGrant>;
  /** Current Session execution directory. This may be a worktree and is independent of the canonical project context. */
  readonly cwd: string;
  /** Registry-owned capture for artifact-policy tools. Descriptors may only write; Registry owns finalize/abort. */
  outputCapture?: ToolOutputCapture;
  /** Scope-bound artifact accessor. Descriptors never receive project/root authorization fields. */
  outputArtifacts?: ToolOutputAccessService;
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
  /** Execution-scoped correction gate for the canonical structured result submission. */
  structuredResultCorrection?: StructuredResultCorrectionGate;
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
  result: RawToolResult,
  ctx: ToolExecutionContext,
) => MaybePromise<RawToolResult | void>;

export type FinalizedResultHook = (
  result: FinalizedToolResult,
  ctx: ToolExecutionContext,
) => MaybePromise<void>;

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

export interface ToolDescriptor<I = any> {
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
  outputPolicy: ToolOutputPolicy;
  hooks?: {
    before?: BeforeHook[];
    after?: AfterHook[];
  };
  prepareInput?: (raw: unknown, ctx: ToolExecutionContext) => MaybePromise<unknown>;
  prepareBlock?: (input: I, ctx: ToolExecutionContext) => MaybePromise<ToolBlockedRequest>;
  resume?: (
    input: I,
    response: HitlResponse,
    ctx: ToolExecutionContext,
  ) => MaybePromise<RawToolResult>;
  permissions?: ToolPermission[];
  execute: (input: I, ctx: ToolExecutionContext) => MaybePromise<RawToolResult>;
}

export type AnyToolDescriptor = ToolDescriptor<any>;

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
