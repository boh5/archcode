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
