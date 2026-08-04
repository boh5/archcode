import type {
  ConfigRecoveryActionResponse,
  ConfigRecoveryStatus,
  RemoveInvalidConfigItemsRequest,
  ResetInvalidConfigRequest,
} from "@archcode/protocol";
import { apiFetch } from "./client";

function recoveryHeaders(grant: string): HeadersInit {
  return { Authorization: `Bearer ${grant}` };
}

export function getConfigRecoveryStatus(grant: string): Promise<ConfigRecoveryStatus> {
  return apiFetch<ConfigRecoveryStatus>("/api/config-recovery", {
    headers: recoveryHeaders(grant),
    authFailure: "ignore",
  });
}

export function retryConfigRecovery(grant: string): Promise<ConfigRecoveryActionResponse> {
  return apiFetch<ConfigRecoveryActionResponse>("/api/config-recovery/retry", {
    method: "POST",
    headers: recoveryHeaders(grant),
    authFailure: "ignore",
  });
}

export function resetInvalidConfig(grant: string): Promise<ConfigRecoveryActionResponse> {
  const body: ResetInvalidConfigRequest = { confirmation: "DELETE_INVALID_CONFIG" };
  return apiFetch<ConfigRecoveryActionResponse>("/api/config-recovery/reset", {
    method: "POST",
    headers: recoveryHeaders(grant),
    body: body as unknown as Record<string, unknown>,
    authFailure: "ignore",
  });
}

export function removeInvalidConfigItems(
  grant: string,
  expectedRevision: string,
  itemIds: readonly string[],
): Promise<ConfigRecoveryActionResponse> {
  const body: RemoveInvalidConfigItemsRequest = {
    expectedRevision,
    itemIds: [...itemIds],
    confirmation: "REMOVE_SELECTED_INVALID_CONFIG_ITEMS",
  };
  return apiFetch<ConfigRecoveryActionResponse>("/api/config-recovery/remove-items", {
    method: "POST",
    headers: recoveryHeaders(grant),
    body: body as unknown as Record<string, unknown>,
    authFailure: "ignore",
  });
}
