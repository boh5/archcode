export type HitlKind = "question" | "approval" | "review";

export type HitlResolutionStatus = "resolved" | "cancelled" | "timeout";

export type HitlPayload = {
  title: string;
  message: string;
  details?: Record<string, unknown>;
  options?: Array<{
    id: string;
    label: string;
    description?: string;
  }>;
  recommendedOptionId?: string;
  rationale?: string;
};

export type HitlResponsePayload = {
  decision?: string;
  answers?: unknown;
  verdict?: "approve" | "reject" | "request_changes";
  comment?: string;
  data?: Record<string, unknown>;
};

export interface HitlTrigger {
  projectSlug?: string;
  goalId?: string;
  loopId?: string;
  source?: string;
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
