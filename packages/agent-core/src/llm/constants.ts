export interface LlmRetryProfile {
  readonly totalAttempts: number;
  readonly baseDelayMs: number;
  readonly factor: number;
  readonly jitterRatio: number;
  readonly maxDelayMs: number;
}

export const LLM_SHORT_RETRY_PROFILE: LlmRetryProfile = {
  totalAttempts: 3,
  baseDelayMs: 500,
  factor: 2,
  jitterRatio: 0.2,
  maxDelayMs: 10_000,
};

export const LLM_OBJECT_SCHEMA_REPAIR_ATTEMPTS = 2;
export const AI_SDK_MANAGED_MAX_RETRIES = 0;
