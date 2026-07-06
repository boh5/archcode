import { z } from "zod/v4";
import {
  TOOL_GOAL_ARTIFACT_READ,
  TOOL_GOAL_ARTIFACT_WRITE,
  type GoalArtifactName,
  type GoalPhase,
  type GoalState,
} from "@archcode/protocol";

import {
  GoalArtifactNameError,
  GoalArtifactPathError,
  GoalArtifactPlanLockedError,
  GoalArtifactSecretError,
} from "../../goals/artifacts";
import {
  GoalInvalidIdError,
  GoalNotFoundError,
  GoalPathError,
  GoalStateError,
  GoalUuidSchema,
  GoalArtifactNameSchema,
} from "../../goals/state";
import type { SessionRole } from "../../store/types";
import { defineTool } from "../define-tool";
import { createToolErrorResult } from "../errors";
import type { AnyToolDescriptor, ToolExecutionContext, ToolExecutionResult } from "../types";

const GoalArtifactReadInputSchema = z.strictObject({
  goalId: GoalUuidSchema.describe("Goal UUID whose canonical artifacts should be listed or read."),
  name: GoalArtifactNameSchema.optional().describe("Canonical artifact filename to read. Omit to list artifacts."),
});

const GoalArtifactWriteInputSchema = z.strictObject({
  goalId: GoalUuidSchema.describe("Goal UUID that owns the artifact."),
  name: GoalArtifactNameSchema.describe("Canonical current Markdown artifact filename to write."),
  content: z.string().min(1).describe("Markdown content for the current artifact file."),
});

type GoalArtifactReadInput = z.infer<typeof GoalArtifactReadInputSchema>;
type GoalArtifactWriteInput = z.infer<typeof GoalArtifactWriteInputSchema>;

type ArtifactAuthorizationCode =
  | "GOAL_CONTEXT_REQUIRED"
  | "GOAL_ARTIFACT_WRONG_SESSION"
  | "GOAL_ARTIFACT_ROLE_DENIED"
  | "GOAL_ARTIFACT_PHASE_DENIED";

class GoalArtifactAuthorizationError extends Error {
  constructor(
    public readonly code: ArtifactAuthorizationCode,
    message: string,
  ) {
    super(message);
    this.name = "GoalArtifactAuthorizationError";
  }
}

export function createGoalArtifactReadTool(): AnyToolDescriptor {
  return defineTool({
    name: TOOL_GOAL_ARTIFACT_READ,
    description: "List or read canonical current Markdown artifacts for one Goal.",
    inputSchema: GoalArtifactReadInputSchema,
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    execute: async (input: GoalArtifactReadInput, ctx: ToolExecutionContext): Promise<string | ToolExecutionResult> => {
      try {
        await ctx.projectContext.goalState.read(input.goalId);
        if (input.name === undefined) {
          return JSON.stringify({ artifacts: await ctx.projectContext.goalArtifacts.listArtifacts(input.goalId) }, null, 2);
        }

        const content = await ctx.projectContext.goalArtifacts.readArtifact(input.goalId, input.name);
        if (content === null) {
          return createToolErrorResult({
            kind: "file-not-found",
            code: "GOAL_ARTIFACT_NOT_FOUND",
            message: `Goal artifact not found: ${input.name}`,
          });
        }

        const artifact = (await ctx.projectContext.goalArtifacts.listArtifacts(input.goalId))
          .find((candidate) => candidate.name === input.name);
        return JSON.stringify({ artifact, content }, null, 2);
      } catch (error) {
        return goalArtifactToolErrorResult(error);
      }
    },
  });
}

export function createGoalArtifactWriteTool(): AnyToolDescriptor {
  return defineTool({
    name: TOOL_GOAL_ARTIFACT_WRITE,
    description: "Write one authorized canonical current Markdown artifact for the active Goal.",
    inputSchema: GoalArtifactWriteInputSchema,
    traits: { readOnly: false, destructive: false, concurrencySafe: false },
    execute: async (input: GoalArtifactWriteInput, ctx: ToolExecutionContext): Promise<string | ToolExecutionResult> => {
      try {
        const goal = await ctx.projectContext.goalState.read(input.goalId);
        assertGoalArtifactWriteAuthorized(goal, input.name, ctx);
        const artifact = await ctx.projectContext.goalArtifacts.writeArtifact(goal, input.name, input.content, {
          agentName: effectiveAgentName(ctx),
        });
        return JSON.stringify({ artifact }, null, 2);
      } catch (error) {
        return goalArtifactToolErrorResult(error);
      }
    },
  });
}

function assertGoalArtifactWriteAuthorized(
  goal: GoalState,
  name: GoalArtifactName,
  ctx: ToolExecutionContext,
): void {
  const session = ctx.store.getState();
  if (!session.goalId || !session.sessionRole) {
    throw new GoalArtifactAuthorizationError(
      "GOAL_CONTEXT_REQUIRED",
      "goal_artifact_write requires an active Goal-scoped session",
    );
  }
  if (session.goalId !== goal.id) {
    throw new GoalArtifactAuthorizationError(
      "GOAL_ARTIFACT_WRONG_SESSION",
      `Session is scoped to Goal ${session.goalId}, not ${goal.id}`,
    );
  }

  const agentName = effectiveAgentName(ctx);
  const sessionRole = session.sessionRole;
  if (isPlanArtifactWrite(goal.phase, name, agentName, sessionRole)) return;
  if (isBuildArtifactWrite(goal.phase, name, agentName, sessionRole)) return;
  if (isReviewerArtifactWrite(goal, name, agentName, sessionRole)) return;

  if (!phaseAllowsArtifact(goal.phase, name)) {
    throw new GoalArtifactAuthorizationError(
      "GOAL_ARTIFACT_PHASE_DENIED",
      `${name} cannot be written during the ${goal.phase} phase`,
    );
  }

  throw new GoalArtifactAuthorizationError(
    "GOAL_ARTIFACT_ROLE_DENIED",
    `${agentName}/${sessionRole} is not allowed to write ${name}`,
  );
}

function effectiveAgentName(ctx: ToolExecutionContext): string {
  return ctx.agentName ?? ctx.store.getState().agentName;
}

function isPlanArtifactWrite(
  phase: GoalPhase,
  name: GoalArtifactName,
  agentName: string,
  sessionRole: SessionRole,
): boolean {
  return phase === "plan" && name === "plan.md" && agentName === "plan" && sessionRole === "plan";
}

function isBuildArtifactWrite(
  phase: GoalPhase,
  name: GoalArtifactName,
  agentName: string,
  sessionRole: SessionRole,
): boolean {
  return phase === "build" && name === "build.md" && agentName === "build" && sessionRole === "build";
}

function isReviewerArtifactWrite(
  goal: GoalState,
  name: GoalArtifactName,
  agentName: string,
  sessionRole: SessionRole,
): boolean {
  return goal.phase === "review"
    && (name === "review.md" || name === "spec-compliance.md")
    && agentName === goal.reviewerAgent
    && sessionRole === "review";
}

function phaseAllowsArtifact(phase: GoalPhase, name: GoalArtifactName): boolean {
  if (name === "plan.md") return phase === "plan";
  if (name === "build.md") return phase === "build";
  if (name === "review.md" || name === "spec-compliance.md") return phase === "review";
  return true;
}

function goalArtifactToolErrorResult(error: unknown): ToolExecutionResult {
  if (error instanceof GoalNotFoundError) {
    return createToolErrorResult({ kind: "workspace", code: "GOAL_NOT_FOUND", message: error.message });
  }
  if (error instanceof GoalArtifactAuthorizationError) {
    return createToolErrorResult({ kind: "permission-denied", code: error.code, message: error.message });
  }
  if (error instanceof GoalArtifactPlanLockedError) {
    return createToolErrorResult({ kind: "permission-denied", code: "GOAL_ARTIFACT_PLAN_LOCKED", message: error.message });
  }
  if (error instanceof GoalArtifactSecretError) {
    return createToolErrorResult({ kind: "permission-denied", code: "GOAL_ARTIFACT_SECRET_DETECTED", message: error.message });
  }
  if (error instanceof GoalArtifactNameError) {
    return createToolErrorResult({ kind: "workspace", code: "GOAL_ARTIFACT_INVALID_NAME", message: error.message });
  }
  if (error instanceof GoalArtifactPathError || error instanceof GoalPathError || error instanceof GoalInvalidIdError) {
    return createToolErrorResult({ kind: "workspace", code: "GOAL_INVALID_ID", message: error.message });
  }
  if (error instanceof GoalStateError) {
    return createToolErrorResult({ kind: "workspace", code: "GOAL_INVALID_STATE", message: error.message });
  }
  return createToolErrorResult({ kind: "execution", error: error instanceof Error ? error : new Error(String(error)) });
}

export { GoalArtifactReadInputSchema, GoalArtifactWriteInputSchema };
