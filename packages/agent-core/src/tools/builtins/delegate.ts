import { z } from "zod/v4";
import type {
  SessionExecutionRecord,
  SessionExecutionTerminalStatus,
} from "@archcode/protocol";
import {
  AgentChildPolicyMissingError,
  DelegateTargetNotAllowedError,
  DepthLimitError,
  SkillNotAllowedError,
} from "../../agents/errors";
import { DelegationRequestSchema } from "../../delegation/schema";
import type { ChildExecutionHandle, ChildExecutionOutcome } from "../../delegation/types";
import { SkillNotFoundError, SkillValidationError } from "../../skills";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import { createTextToolResult } from "../results";
import type {
  ChildDeferredToolResult,
  ToolDescriptorExecutionResult,
  ToolExecutionContext,
} from "../types";

export const DelegateInputSchema = DelegationRequestSchema;

export type DelegateInput = z.output<typeof DelegateInputSchema>;

export interface DelegateErrorOutput {
  ok: false;
  session_id: string;
  error: { name: string; message: string };
  target_agent?: string;
  rejected_skill?: string;
  allowed_skills?: readonly string[];
}

export async function executeDelegate(
  input: DelegateInput,
  ctx: ToolExecutionContext,
): Promise<ToolDescriptorExecutionResult> {
  if (ctx.startChildExecution === undefined) {
    return createToolErrorResult({
      kind: "execution",
      code: "TOOL_DELEGATE_EXECUTOR_UNAVAILABLE",
      name: "SubAgentError",
      message: "Child execution is not available in this execution context",
    });
  }

  let handle: ChildExecutionHandle;
  try {
    const childSessionId = crypto.randomUUID();
    handle = await ctx.startChildExecution({
      parentStore: ctx.store,
      parentSessionId: ctx.store.getState().sessionId,
      parentExecutionId: ctx.executionId,
      parentRunOrdinal: ctx.runOrdinal,
      parentToolBatchId: ctx.toolBatchId,
      parentToolCallId: ctx.toolCallId,
      childSessionId,
      childExecutionId: crypto.randomUUID(),
      toolName: "delegate",
      request: input,
      parentAbort: ctx.abort,
    });
  } catch (error) {
    const safeError = error instanceof Error ? error : new Error(String(error));
    return createToolErrorResult({
      kind: "execution",
      code: delegateStartErrorCode(error),
      message: safeError.message,
      name: safeError.name,
      error: safeError,
    });
  }

  if (input.background) {
    return createTextToolResult(formatAsyncChildOutput(handle));
  }

  const outcome = await waitForChildOutcome(handle);
  if (outcome.outcome === "suspended") return childDeferredResult(ctx, handle);
  return createTextToolResult(formatSyncChildOutput({
    sessionId: handle.sessionId,
    agentName: handle.store.getState().agentName,
  }, outcome));
}

function delegateStartErrorCode(error: unknown): string {
  if (
    error instanceof DelegateTargetNotAllowedError
    || error instanceof AgentChildPolicyMissingError
    || error instanceof DepthLimitError
  ) {
    return "TOOL_DELEGATE_TARGET_NOT_ALLOWED";
  }

  if (hasErrorCode(error, "DELEGATION_PROFILE_NOT_ALLOWED")) {
    return "TOOL_DELEGATE_PROFILE_NOT_ALLOWED";
  }

  if (error instanceof SkillNotFoundError) return "TOOL_DELEGATE_SKILL_NOT_FOUND";
  if (error instanceof SkillValidationError) return "TOOL_DELEGATE_SKILL_INVALID";
  if (error instanceof SkillNotAllowedError) return "TOOL_DELEGATE_SKILL_NOT_ALLOWED";
  return "TOOL_DELEGATE_FAILED";
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { readonly code?: unknown }).code === code;
}

export function formatAsyncChildOutput(handle: ChildExecutionHandle): string {
  return JSON.stringify({
    session_id: handle.sessionId,
    agent_type: handle.store.getState().agentName,
    execution_status: "running",
  });
}

export function formatSyncChildOutput(
  child: { readonly sessionId: string; readonly agentName: string },
  outcome: Extract<ChildExecutionOutcome, { outcome: "terminal" }>,
): string {
  return JSON.stringify({
    session_id: child.sessionId,
    agent_type: child.agentName,
    execution_status: outcome.executionStatus,
    ...(outcome.output === undefined ? {} : { output: outcome.output }),
    ...(errorMessage(outcome.terminalError) === undefined ? {} : { error: errorMessage(outcome.terminalError) }),
  });
}

export async function waitForChildOutcome(handle: ChildExecutionHandle): Promise<ChildExecutionOutcome> {
  try {
    return await handle.result;
  } catch (error) {
    const state = handle.store.getState();
    const run = state.executions.at(-1);
    return {
      outcome: "terminal",
      executionId: handle.executionId,
      executionStatus: terminalStatus(run, error),
      terminalError: error,
    };
  }
}

function terminalStatus(
  run: SessionExecutionRecord | undefined,
  terminalError: unknown,
): SessionExecutionTerminalStatus {
  if (run !== undefined && run.status !== "running" && run.status !== "suspended") return run.status;
  const message = terminalError instanceof Error ? terminalError.message : String(terminalError);
  if (/timed out/i.test(message)) return "timed_out";
  if (/aborted/i.test(message)) return "aborted";
  if (/cancelled|canceled/i.test(message)) return "cancelled";
  if (/max steps/i.test(message)) return "max_steps";
  return "failed";
}

export function childDeferredResult(
  ctx: ToolExecutionContext,
  handle: ChildExecutionHandle,
): ChildDeferredToolResult {
  return {
    kind: "child_deferred",
    dependency: {
      parentExecutionId: ctx.executionId,
      runOrdinal: ctx.runOrdinal,
      toolBatchId: ctx.toolBatchId,
      toolCallId: ctx.toolCallId,
      childSessionId: handle.sessionId,
      childExecutionId: handle.executionId,
    },
  };
}

function errorMessage(error: unknown): string | undefined {
  if (error === undefined) return undefined;
  return error instanceof Error ? error.message : String(error);
}

export const delegateTool = defineTool({
  name: "delegate",
  description: [
    "Create one direct child Session from a strict DelegationRequest.",
    "Provide the delegated Agent, Profile, and only the workflow Skills it needs. Current parent/depth capability admission authorizes the selected Agent/Profile pair before child creation.",
    "A fresh child receives its own runtime-provided system context and visible tools, but does not inherit the parent conversation or prior tool results.",
    "Write objective as the minimum self-contained task-specific handoff: state the requested outcome or question, material parent-local facts or decisions, scope or non-goals, expected final output or evidence, and verification when applicable.",
    "Do not rely on the child to reconstruct parent-local understanding, and do not repeat generic context already supplied by the runtime.",
    "The child returns a normal final response. Use resume_session for corrections or follow-up on the same responsibility.",
    "background=false waits and returns the completed execution's final output. background=true returns the Session ID; wait for its terminal reminder, then use background_output.",
  ].join("\n"),
  inputSchema: DelegateInputSchema,
  traits: { readOnly: false, destructive: false, concurrencySafe: false },
  outputPolicy: { kind: "artifact", previewDirection: "head-tail" },
  execute: executeDelegate,
  resumeChildDependency: async (_input, dependency, outcome, ctx) => {
    const child = await ctx.storeManager.getOrLoad(
      dependency.childSessionId,
      ctx.projectContext.project.workspaceRoot,
    );
    return createTextToolResult(formatSyncChildOutput({
      sessionId: dependency.childSessionId,
      agentName: child.getState().agentName,
    }, outcome));
  },
});
