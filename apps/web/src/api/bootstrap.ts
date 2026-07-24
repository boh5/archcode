import type {
  BootstrapStatus,
  CompleteSetupRequest,
  CompleteSetupResponse,
  SetupProviderAdapterCatalogResponse,
} from "@archcode/protocol";
import { apiFetch } from "./client";

export function getBootstrapStatus(): Promise<BootstrapStatus> {
  return apiFetch<BootstrapStatus>("/api/bootstrap");
}

export function getSetupProviderAdapterCatalog(grant: string): Promise<SetupProviderAdapterCatalogResponse> {
  return apiFetch<SetupProviderAdapterCatalogResponse>("/api/setup/provider-adapters", {
    headers: { Authorization: `Bearer ${grant}` },
    authFailure: "ignore",
  });
}

export function completeSetup(grant: string, request: CompleteSetupRequest): Promise<CompleteSetupResponse> {
  return apiFetch<CompleteSetupResponse>("/api/setup", {
    method: "POST",
    headers: { Authorization: `Bearer ${grant}` },
    body: request as unknown as Record<string, unknown>,
    authFailure: "ignore",
  });
}
