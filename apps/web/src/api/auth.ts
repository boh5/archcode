import type {
  AuthStatus,
  LoginRequest,
  LoginResponse,
  LogoutResponse,
  PasswordChangeRequest,
  PasswordChangeResponse,
} from "@archcode/protocol";
import { apiFetch } from "./client";

export function getAuthStatus(): Promise<AuthStatus> {
  return apiFetch<AuthStatus>("/api/auth/status");
}

export function login(request: LoginRequest): Promise<LoginResponse> {
  return apiFetch<LoginResponse>("/api/auth/login", { method: "POST", body: request as unknown as Record<string, unknown>, authFailure: "ignore" });
}

export function logout(): Promise<LogoutResponse> {
  return apiFetch<LogoutResponse>("/api/auth/logout", { method: "POST" });
}

export function changePassword(request: PasswordChangeRequest): Promise<PasswordChangeResponse> {
  return apiFetch<PasswordChangeResponse>("/api/auth/password", { method: "PUT", body: request as unknown as Record<string, unknown> });
}
