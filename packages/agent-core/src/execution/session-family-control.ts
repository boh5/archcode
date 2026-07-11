export interface AcquireSessionFamilyStopInput {
  readonly workspaceRoot: string;
  readonly rootSessionId: string;
  /** Current self-cancelling execution may finish through explicit execution control. */
  readonly exemptSessionId?: string;
}

export interface SessionFamilyStopLease {
  readonly rootSessionId: string;
  stopAndWait(): Promise<void>;
  release(): void;
}

export interface SessionFamilyController {
  acquireStop(input: AcquireSessionFamilyStopInput): SessionFamilyStopLease;
}

export class SessionFamilyStopInProgressError extends Error {
  readonly code = "SESSION_FAMILY_STOP_IN_PROGRESS";

  constructor(
    public readonly sessionId: string,
    public readonly rootSessionId: string,
  ) {
    super(`Session "${sessionId}" cannot start or transition while Session family "${rootSessionId}" is stopping`);
    this.name = "SessionFamilyStopInProgressError";
  }
}

export class SessionFamilyStopConflictError extends Error {
  readonly code = "SESSION_FAMILY_STOP_CONFLICT";

  constructor(
    public readonly rootSessionId: string,
    public readonly stuckSessionIds: readonly string[],
  ) {
    super(`Session family "${rootSessionId}" did not stop: ${stuckSessionIds.join(", ")}`);
    this.name = "SessionFamilyStopConflictError";
  }
}

export class SessionFamilyActiveError extends Error {
  readonly code = "SESSION_FAMILY_ACTIVE";

  constructor(
    public readonly sessionId: string,
    public readonly rootSessionId: string,
    public readonly activity: Exclude<SessionFamilyActivity, "idle">,
  ) {
    super(`Session "${sessionId}" cannot accept a user message while Session family "${rootSessionId}" is ${activity}`);
    this.name = "SessionFamilyActiveError";
  }
}

export class SessionFamilyIdentityUnavailableError extends Error {
  readonly code = "SESSION_FAMILY_IDENTITY_UNAVAILABLE";

  constructor(public readonly sessionId: string) {
    super(`Session "${sessionId}" must be loaded before claiming or stopping Session family ownership`);
    this.name = "SessionFamilyIdentityUnavailableError";
  }
}
import type { SessionFamilyActivity } from "@archcode/protocol";
