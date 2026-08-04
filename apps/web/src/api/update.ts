import type { UpdateStatus } from "@archcode/protocol";
import { apiFetch } from "./client";

function updateHeaders(authorizationToken?: string): HeadersInit | undefined {
  return authorizationToken === undefined
    ? undefined
    : { Authorization: `Bearer ${authorizationToken}` };
}

export function getUpdateStatus(authorizationToken?: string): Promise<UpdateStatus> {
  return apiFetch<UpdateStatus>("/api/update", {
    headers: updateHeaders(authorizationToken),
    authFailure: authorizationToken === undefined ? "invalidate" : "ignore",
  });
}

export function checkForUpdate(authorizationToken?: string): Promise<UpdateStatus> {
  return apiFetch<UpdateStatus>("/api/update/check", {
    method: "POST",
    headers: updateHeaders(authorizationToken),
    authFailure: authorizationToken === undefined ? "invalidate" : "ignore",
  });
}

export function installUpdate(authorizationToken?: string): Promise<UpdateStatus> {
  return apiFetch<UpdateStatus>("/api/update/install", {
    method: "POST",
    headers: updateHeaders(authorizationToken),
    authFailure: authorizationToken === undefined ? "invalidate" : "ignore",
  });
}

export function restartForUpdate(authorizationToken?: string): Promise<UpdateStatus> {
  return apiFetch<UpdateStatus>("/api/update/restart", {
    method: "POST",
    headers: updateHeaders(authorizationToken),
    authFailure: authorizationToken === undefined ? "invalidate" : "ignore",
  });
}
