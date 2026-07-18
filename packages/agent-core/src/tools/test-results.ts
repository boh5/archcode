import type { FinalizedToolResult } from "@archcode/protocol";

import type { RawToolResult, RegistryExecutionOutcome } from "./types";

export function expectTextDraft(result: RawToolResult): string {
  if (result.draft.kind !== "text") throw new Error("Expected text RawToolResult draft");
  return result.draft.text;
}

export function expectSettledResult(outcome: RegistryExecutionOutcome): FinalizedToolResult {
  if (outcome.kind !== "settled") throw new Error("Expected settled Registry execution outcome");
  return outcome.result;
}

export function expectBlockedRequest(outcome: RegistryExecutionOutcome) {
  if (outcome.kind !== "blocked") throw new Error("Expected blocked Registry execution outcome");
  return outcome.request;
}

export function expectBlockedOutcome(outcome: RegistryExecutionOutcome): Extract<RegistryExecutionOutcome, { kind: "blocked" }> {
  if (outcome.kind !== "blocked") throw new Error("Expected blocked Registry execution outcome");
  return outcome;
}
