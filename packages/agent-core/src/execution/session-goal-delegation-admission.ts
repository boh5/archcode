import type { AgentName } from "../agents";
import type { ProjectContextResolver } from "../projects/context-resolver";
import type { SessionStoreState } from "../store/types";
import { withGoalExecutionClaimLock } from "../goals/execution-claim";
import { isGoalDelegationAllowed } from "./goal-session-phase-policy";
import {
  sessionGoalDelegationContext,
  type SessionGoalDelegationContext,
} from "./session-goal-delegation-context";

export class SessionGoalDelegationDeniedError extends Error {
  readonly code = "SESSION_GOAL_DELEGATION_DENIED";

  constructor(
    public readonly goalId: string,
    public readonly sessionId: string,
    public readonly targetAgentName: AgentName,
    message: string,
  ) {
    super(message);
    this.name = "SessionGoalDelegationDeniedError";
  }
}

export interface SessionGoalDelegationAdmissionInput {
  readonly workspaceRoot: string;
  readonly parent: Pick<SessionStoreState, "sessionId" | "rootSessionId" | "parentSessionId" | "goalId" | "agentName" | "sessionRole">;
  readonly isParentDescendantOfRoot?: boolean;
  readonly targetAgentName: AgentName;
}

export interface SessionGoalDelegationAdmission {
  run<T>(input: SessionGoalDelegationAdmissionInput, action: (context?: SessionGoalDelegationContext) => Promise<T>): Promise<T>;
}

export class RoleDrivenSessionGoalDelegationAdmission implements SessionGoalDelegationAdmission {
  constructor(private readonly projectContextResolver: Pick<ProjectContextResolver, "resolve">) {}

  async run<T>(
    input: SessionGoalDelegationAdmissionInput,
    action: (context?: SessionGoalDelegationContext) => Promise<T>,
  ): Promise<T> {
    const goalId = input.parent.goalId;
    if (goalId === undefined) return await action();
    return await withGoalExecutionClaimLock(goalId, async () => {
      const context = await this.projectContextResolver.resolve(input.workspaceRoot);
      const goal = await context.goalState.read(goalId);
      if (input.parent.goalId !== goal.id) throw denied(input, `Session is not in Goal ${goal.id}'s current family`);
      if (isGoalDelegationAllowed({
        goal,
        parent: { ...input.parent, isDescendantOfRoot: input.isParentDescendantOfRoot },
        targetAgentName: input.targetAgentName,
      })) return await action(sessionGoalDelegationContext(goal));

      throw denied(input, `Goal ${goal.id} does not allow ${input.targetAgentName} delegation from ${goal.status}`);
    });
  }
}

function denied(input: SessionGoalDelegationAdmissionInput, message: string): SessionGoalDelegationDeniedError {
  return new SessionGoalDelegationDeniedError(
    input.parent.goalId ?? "unknown",
    input.parent.sessionId,
    input.targetAgentName,
    message,
  );
}
