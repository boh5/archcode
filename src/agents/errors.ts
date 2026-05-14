export class NoModelsConfiguredError extends Error {
  constructor() {
    super("No models configured in .specra.json");
    this.name = "NoModelsConfiguredError";
  }
}

export class AgentRunningError extends Error {
  constructor() {
    super("Agent is already running");
    this.name = "AgentRunningError";
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
