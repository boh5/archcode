/** Public authentication state. Password hashes and session identifiers stay server-only. */
export const MIN_AUTH_PASSWORD_LENGTH = 10;
/** Bound password hashing work before Argon2 receives untrusted input. */
export const MAX_AUTH_PASSWORD_BYTES = 1024;

export interface AuthStatus {
  required: boolean;
  authenticated: boolean;
}

export interface LoginRequest {
  password: string;
}

export type LoginResponse = AuthStatus;
export type LogoutResponse = AuthStatus;

/**
 * Password lifecycle is intentionally a closed union: a caller cannot smuggle
 * credential changes through the general Config update endpoint.
 */
export type PasswordChangeRequest =
  | { action: "set"; password: string }
  | { action: "change"; currentPassword: string; password: string }
  | { action: "remove"; currentPassword: string };

export type PasswordChangeResponse = AuthStatus;
