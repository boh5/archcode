export type HitlKind = "question" | "approval" | "review";

export type HitlResolutionStatus = "resolved" | "cancelled" | "timeout";

type HitlOption = {
  label: string;
  description?: string;
};

type LegacyHitlOption = HitlOption & {
  id?: string;
};

type HitlDisplayFields = {
  title?: string;
  message?: string;
  details?: Record<string, unknown>;
  options?: LegacyHitlOption[];
  recommendedOptionId?: string;
  rationale?: string;
};

export type HitlPayload = HitlDisplayFields & (
  | {
      kind: "question";
      options?: HitlOption[];
      multiple?: boolean;
      custom?: boolean;
      recommendedOption?: string;
      rationale?: string;
    }
  | {
      kind: "approval";
      action: string;
      context: Record<string, unknown>;
    }
  | {
      kind: "review";
      artifacts: Array<{ path: string; description: string }>;
    }
  | {
      kind?: undefined;
      title: string;
      message: string;
    }
);

export type HitlResponsePayload = {
  decision?: string;
  answers?: unknown;
  outcome?: "DONE" | "NOT_DONE";
  comment?: string;
  data?: Record<string, unknown>;
};

export interface HitlTrigger {
  projectSlug?: string;
  goalId?: string;
  loopId?: string;
  source?: string;
  approvalPoint?: string;
  toolCallId?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export interface HitlRequest {
  hitlId: string;
  sessionId: string;
  kind: HitlKind;
  payload: HitlPayload;
  trigger: Omit<HitlTrigger, "abortSignal">;
  createdAt: number;
  status?: "pending" | HitlResolutionStatus;
  displayPayload?: {
    title: string;
    summary?: string;
    fields?: Array<{ label: string; value: string }>;
    redacted: true;
  };
  approvalKey?: string;
}

export type HitlResponse =
  | {
      hitlId: string;
      kind: HitlKind;
      status: "resolved";
      response: HitlResponsePayload;
    }
  | {
      hitlId: string;
      kind: HitlKind;
      status: "cancelled" | "timeout";
      reason: string;
    };

export type HitlEvent =
  | ({ type: "hitl.request" } & HitlRequest)
  | ({
      type: "hitl.resolved";
      sessionId: string;
      resolvedAt: number;
    } & HitlResponse);

export interface HitlEventSubmitter {
  submitHitlEvent(sessionId: string, event: HitlEvent): void;
}
