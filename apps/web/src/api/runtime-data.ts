import type {
  RuntimeDataDeleteRequest,
  RuntimeDataDeleteResponse,
  RuntimeDataInspectionResponse,
  RuntimeStatus,
} from "@archcode/protocol";
import { apiFetch } from "./client";

export function inspectRuntimeData(): Promise<RuntimeDataInspectionResponse> {
  return apiFetch<RuntimeDataInspectionResponse>("/api/runtime-data");
}

export function deleteRuntimeData(
  request: RuntimeDataDeleteRequest,
): Promise<RuntimeDataDeleteResponse> {
  return apiFetch<RuntimeDataDeleteResponse>("/api/runtime-data", {
    method: "DELETE",
    body: request as unknown as Record<string, unknown>,
  });
}

export function retryRuntime(): Promise<RuntimeStatus> {
  return apiFetch<RuntimeStatus>("/api/runtime/retry", { method: "POST" });
}
