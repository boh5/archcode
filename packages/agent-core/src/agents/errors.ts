export class NoModelsConfiguredError extends Error {
  constructor() {
    super("No models configured in ~/.archcode/config.json");
    this.name = "NoModelsConfiguredError";
  }
}

export class AgentRunningError extends Error {
  constructor() {
    super("Agent is already running");
    this.name = "AgentRunningError";
  }
}

export class MissingProjectContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingProjectContextError";
  }
}

export class MissingAgentModelConfigError extends Error {
  constructor(
    public readonly agentName: string,
    public readonly availableAgents: string[],
  ) {
    super(`Agent "${agentName}" must define a model in config.agents.${agentName}.model. Available agents: ${availableAgents.join(", ")}`);
    this.name = "MissingAgentModelConfigError";
  }
}

export class UnknownModelVariantError extends Error {
  constructor(
    public readonly agentName: string,
    public readonly modelId: string,
    public readonly requestedVariant: string,
    public readonly availableVariants: string[],
  ) {
    super(
      `Agent "${agentName}" requested unknown variant "${requestedVariant}" for model "${modelId}". Available variants: ${availableVariants.join(", ")}`,
    );
    this.name = "UnknownModelVariantError";
  }
}

export class SubAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubAgentError";
  }
}

export class ConcurrentLimitError extends Error {
  constructor(public readonly activeCount: number) {
    super(`Maximum concurrent sub-agents reached: ${activeCount}`);
    this.name = "ConcurrentLimitError";
  }
}

export class ConcurrentSessionLimitError extends Error {
  constructor(
    public readonly workspaceRoot: string,
    public readonly current: number,
    public readonly max: number,
  ) {
    super(`Workspace "${workspaceRoot}" has ${current} active sessions (max: ${max})`);
    this.name = "ConcurrentSessionLimitError";
  }
}

export class DepthLimitError extends Error {
  constructor(public readonly currentDepth: number) {
    super(`Maximum sub-agent delegation depth reached: ${currentDepth}`);
    this.name = "DepthLimitError";
  }
}

export class DelegationToolNotAllowedError extends SubAgentError {
  constructor(
    public readonly parentAgentName: string,
    public readonly currentDepth: number,
  ) {
    super(`Agent "${parentAgentName}" is not allowed to delegate at depth ${currentDepth}: delegate tool is unavailable`);
    this.name = "DelegationToolNotAllowedError";
  }
}

export class DelegateTargetNotAllowedError extends SubAgentError {
  constructor(
    public readonly parentAgentName: string,
    public readonly targetAgentName: string,
    public readonly currentDepth: number,
  ) {
    super(`Agent "${parentAgentName}" cannot delegate to "${targetAgentName}" at depth ${currentDepth}`);
    this.name = "DelegateTargetNotAllowedError";
  }
}

export class AgentChildPolicyMissingError extends SubAgentError {
  constructor(public readonly parentAgentName: string) {
    super(`Agent "${parentAgentName}" does not define a child delegation policy`);
    this.name = "AgentChildPolicyMissingError";
  }
}

export class SkillNotAllowedError extends SubAgentError {
  constructor(
    public readonly targetAgentName: string,
    public readonly skillName: string,
    public readonly allowedSkills: readonly string[],
  ) {
    super(`Skill "${skillName}" is not allowed for delegated agent "${targetAgentName}"`);
    this.name = "SkillNotAllowedError";
  }
}

export class ChildSessionNotFoundError extends Error {
  constructor(
    public readonly workspaceRoot: string,
    public readonly sessionId: string,
  ) {
    super(`Child session "${sessionId}" was not found in workspace "${workspaceRoot}"`);
    this.name = "ChildSessionNotFoundError";
  }
}

export class ChildSessionAgentMismatchError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly expectedAgentName: string,
    public readonly actualAgentName: string,
  ) {
    super(
      `Child session "${sessionId}" was created with agent "${actualAgentName}" but resume requested agent "${expectedAgentName}"`,
    );
    this.name = "ChildSessionAgentMismatchError";
  }
}

export class ChildSessionParentMismatchError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly expectedParentSessionId: string,
    public readonly actualParentSessionId: string | undefined,
  ) {
    super(
      `Child session "${sessionId}" has parent "${actualParentSessionId ?? "<none>"}" but resume expected parent "${expectedParentSessionId}"`,
    );
    this.name = "ChildSessionParentMismatchError";
  }
}

export class ChildSessionCwdMismatchError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly parentSessionId: string,
    public readonly expectedCwd: string,
    public readonly actualCwd: string,
  ) {
    super(
      `Child session "${sessionId}" uses working directory "${actualCwd}", but parent session "${parentSessionId}" now uses "${expectedCwd}". Create a new child session in the parent's current working directory instead of resuming this one.`,
    );
    this.name = "ChildSessionCwdMismatchError";
  }
}

export class SessionCwdTransitionConflictError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly activeDescendantSessionIds: readonly string[],
  ) {
    super(
      `Session "${sessionId}" cannot change working directory while descendant sessions are starting or running: ${activeDescendantSessionIds.join(", ")}. Wait for or cancel those sessions before changing worktrees.`,
    );
    this.name = "SessionCwdTransitionConflictError";
  }
}

export class SessionCwdTransitionInProgressError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly rootSessionId: string,
  ) {
    super(
      `Session "${sessionId}" cannot start or resume while root session "${rootSessionId}" is changing working directory. Retry after the worktree transition finishes.`,
    );
    this.name = "SessionCwdTransitionInProgressError";
  }
}

export class SessionHitlResumeInProgressError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly rootSessionId: string,
  ) {
    super(
      `Session "${sessionId}" cannot start or resume while its durable human-in-the-loop continuation is already running in root family "${rootSessionId}".`,
    );
    this.name = "SessionHitlResumeInProgressError";
  }
}

export class SessionHitlBlockedError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly hitlIds: readonly string[],
  ) {
    super(
      `Session "${sessionId}" is waiting for a human-in-the-loop response: ${hitlIds.join(", ")}. Respond to or cancel the pending request before sending another message.`,
    );
    this.name = "SessionHitlBlockedError";
  }
}

export class SessionHitlResumeConflictError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly conflictingSessionIds: readonly string[],
  ) {
    super(
      `Session "${sessionId}" cannot continue a durable human-in-the-loop response while the same Session is starting or running.`,
    );
    this.name = "SessionHitlResumeConflictError";
  }
}

export class SessionHitlResumeLeaseExpiredError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly rootSessionId: string,
  ) {
    super(
      `Durable human-in-the-loop continuation ownership for session "${sessionId}" is no longer active for root session "${rootSessionId}".`,
    );
    this.name = "SessionHitlResumeLeaseExpiredError";
  }
}

export class SessionHitlResumeIdentityMismatchError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly expectedRootSessionId: string,
    public readonly actualRootSessionId: string | undefined,
  ) {
    super(
      `Durable human-in-the-loop continuation for session "${sessionId}" belongs to root "${expectedRootSessionId}", but the loaded Session belongs to "${actualRootSessionId ?? "missing"}".`,
    );
    this.name = "SessionHitlResumeIdentityMismatchError";
  }
}

export class SessionHitlResumeLeaseNotActivatedError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly rootSessionId: string,
  ) {
    super(`Durable human-in-the-loop continuation for session "${sessionId}" has not validated root "${rootSessionId}" yet.`);
    this.name = "SessionHitlResumeLeaseNotActivatedError";
  }
}

export class SessionHitlCancelOnlyLeaseError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly rootSessionId: string,
  ) {
    super(
      `Cancel-only durable human-in-the-loop ownership for session "${sessionId}" cannot change the working directory of root session "${rootSessionId}".`,
    );
    this.name = "SessionHitlCancelOnlyLeaseError";
  }
}

export class ChildSessionNotDescendantError extends Error {
  constructor(
    public readonly parentSessionId: string,
    public readonly childSessionId: string,
  ) {
    super(`Session "${childSessionId}" is not a descendant of "${parentSessionId}"`);
    this.name = "ChildSessionNotDescendantError";
  }
}
