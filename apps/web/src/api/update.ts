import type { UpdateStatus } from "@archcode/protocol";
import { apiFetch } from "./client";

export function getUpdateStatus(): Promise<UpdateStatus> {
  return apiFetch<UpdateStatus>("/api/update");
}

export function checkForUpdate(): Promise<UpdateStatus> {
  return apiFetch<UpdateStatus>("/api/update/check", { method: "POST" });
}

export function installUpdate(): Promise<UpdateStatus> {
  return apiFetch<UpdateStatus>("/api/update/install", { method: "POST" });
}

export function restartForUpdate(): Promise<UpdateStatus> {
  return apiFetch<UpdateStatus>("/api/update/restart", { method: "POST" });
}
