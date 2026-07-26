import { randomBytes } from "node:crypto";
import {
  MAX_AUTH_PASSWORD_BYTES,
  MIN_AUTH_PASSWORD_LENGTH,
} from "@archcode/protocol";

const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOGIN_WINDOW_MS = 60 * 1000;
const DEFAULT_MAX_LOGIN_FAILURES = 5;
const DEFAULT_MAX_SESSIONS = 128;

export interface AuthConfigWriter {
  updateAuthPasswordHash(passwordHash: string | undefined): Promise<unknown>;
}

export interface ServerAuthServiceOptions {
  passwordHash?: string;
  configWriter: AuthConfigWriter;
  now?: () => number;
  sessionTtlMs?: number;
  loginWindowMs?: number;
  maxLoginFailures?: number;
  maxSessions?: number;
  passwordHasher?: (password: string) => Promise<string>;
  passwordVerifier?: (password: string, hash: string) => Promise<boolean>;
  sessionTimer?: AuthSessionTimer;
}

export interface AuthSessionTimerHandle {
  readonly id?: unknown;
}

export interface AuthSessionTimer {
  schedule(delayMs: number, callback: () => void): AuthSessionTimerHandle;
  cancel(handle: AuthSessionTimerHandle): void;
}

const systemAuthSessionTimer: AuthSessionTimer = {
  schedule(delayMs, callback) {
    const id = setTimeout(callback, delayMs);
    return { id };
  },
  cancel(handle) {
    if (handle.id !== undefined) clearTimeout(handle.id as Timer);
  },
};

export interface AuthSession {
  readonly token: string;
  readonly expiresAt: number;
}

export interface AuthSessionStreamLease {
  readonly signal: AbortSignal;
  release(): void;
}

interface AuthSessionRecord {
  readonly expiresAt: number;
  readonly streams: Map<AbortController, AuthSessionTimerHandle>;
}

export class InvalidAuthCredentialsError extends Error {
  readonly code = "INVALID_AUTH_CREDENTIALS";

  constructor(message: string = "Invalid password") {
    super(message);
    this.name = "InvalidAuthCredentialsError";
  }
}

export class AuthRateLimitError extends Error {
  readonly code = "AUTH_RATE_LIMITED";

  constructor(public readonly retryAfterSeconds: number) {
    super("Too many failed login attempts. Try again later.");
    this.name = "AuthRateLimitError";
  }
}

export class AuthPasswordValidationError extends Error {
  readonly code = "AUTH_PASSWORD_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "AuthPasswordValidationError";
  }
}

/**
 * Sole owner of password verification and process-local authenticated sessions.
 * Config persistence stays behind the narrow AuthConfigWriter boundary.
 */
export class ServerAuthService {
  private passwordHash: string | undefined;
  private credentialGeneration = 0;
  private readonly sessions = new Map<string, AuthSessionRecord>();
  private failedLoginTimes: number[] = [];
  private loginTail: Promise<void> = Promise.resolve();
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly configWriter: AuthConfigWriter;
  private readonly now: () => number;
  private readonly sessionTtlMs: number;
  private readonly loginWindowMs: number;
  private readonly maxLoginFailures: number;
  private readonly maxSessions: number;
  private readonly passwordHasher: (password: string) => Promise<string>;
  private readonly passwordVerifier: (password: string, hash: string) => Promise<boolean>;
  private readonly sessionTimer: AuthSessionTimer;

  constructor(options: ServerAuthServiceOptions) {
    this.passwordHash = options.passwordHash;
    this.configWriter = options.configWriter;
    this.now = options.now ?? Date.now;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.loginWindowMs = options.loginWindowMs ?? DEFAULT_LOGIN_WINDOW_MS;
    this.maxLoginFailures = options.maxLoginFailures ?? DEFAULT_MAX_LOGIN_FAILURES;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.passwordHasher = options.passwordHasher ?? hashPassword;
    this.passwordVerifier = options.passwordVerifier ?? verifyPassword;
    this.sessionTimer = options.sessionTimer ?? systemAuthSessionTimer;
  }

  get authRequired(): boolean {
    return this.passwordHash !== undefined;
  }

  async hashPassword(password: string): Promise<string> {
    validateNewPassword(password);
    return await this.passwordHasher(password);
  }

  activateCredential(passwordHash: string | undefined): void {
    this.revokeAllSessions();
    this.passwordHash = passwordHash;
    this.credentialGeneration += 1;
    this.failedLoginTimes = [];
  }

  async login(password: string): Promise<AuthSession> {
    validatePasswordSize(password);
    return await this.withLoginLock(async () => {
      const now = this.now();
      this.pruneFailures(now);
      if (this.failedLoginTimes.length >= this.maxLoginFailures) {
        const retryAt = this.failedLoginTimes[0]! + this.loginWindowMs;
        throw new AuthRateLimitError(Math.max(1, Math.ceil((retryAt - now) / 1000)));
      }

      const hash = this.passwordHash;
      const credentialGeneration = this.credentialGeneration;
      const valid = hash !== undefined && await this.passwordVerifier(password, hash);
      if (
        credentialGeneration !== this.credentialGeneration
        || hash !== this.passwordHash
      ) {
        throw new InvalidAuthCredentialsError();
      }
      if (!valid) {
        this.failedLoginTimes.push(now);
        throw new InvalidAuthCredentialsError();
      }

      this.failedLoginTimes = [];
      return this.issueSession();
    });
  }

  issueSession(): AuthSession {
    if (!this.authRequired) {
      throw new Error("Cannot issue an authenticated session when login is disabled");
    }
    this.pruneSessions();
    while (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.revokeSession(oldest);
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + this.sessionTtlMs;
    this.sessions.set(token, { expiresAt, streams: new Map() });
    return { token, expiresAt };
  }

  authenticate(token: string | undefined): boolean {
    if (!this.authRequired) return true;
    if (token === undefined) return false;
    const session = this.sessions.get(token);
    if (session === undefined) return false;
    if (session.expiresAt <= this.now()) {
      this.revokeSession(token);
      return false;
    }
    return true;
  }

  logout(token: string | undefined): void {
    if (token !== undefined) this.revokeSession(token);
  }

  openSessionStream(token: string | undefined): AuthSessionStreamLease | undefined {
    if (!this.authRequired) return undefined;
    if (!this.authenticate(token) || token === undefined) return undefined;
    const session = this.sessions.get(token);
    if (session === undefined) return undefined;

    const controller = new AbortController();
    const expiresIn = Math.max(0, session.expiresAt - this.now());
    const expiryTimer = this.sessionTimer.schedule(expiresIn, () => {
      this.revokeSession(token);
    });
    session.streams.set(controller, expiryTimer);
    let released = false;
    return {
      signal: controller.signal,
      release: () => {
        if (released) return;
        released = true;
        this.sessionTimer.cancel(expiryTimer);
        session.streams.delete(controller);
      },
    };
  }

  async updatePassword(input: {
    readonly currentPassword?: string;
    readonly newPassword?: string;
  }): Promise<AuthSession | undefined> {
    return await this.withMutationLock(async () => {
      const currentHash = this.passwordHash;
      if (currentHash !== undefined) {
        if (input.currentPassword !== undefined) {
          validatePasswordSize(input.currentPassword);
        }
        const valid = input.currentPassword !== undefined
          && await this.passwordVerifier(input.currentPassword, currentHash);
        if (!valid) throw new InvalidAuthCredentialsError("Current password is incorrect");
      } else if (input.currentPassword !== undefined) {
        throw new AuthPasswordValidationError(
          "There is no current password to change or remove",
        );
      }

      const nextHash = input.newPassword === undefined
        ? undefined
        : await this.hashPassword(input.newPassword);
      await this.configWriter.updateAuthPasswordHash(nextHash);

      this.activateCredential(nextHash);
      return nextHash === undefined ? undefined : this.issueSession();
    });
  }

  private pruneFailures(now: number): void {
    const cutoff = now - this.loginWindowMs;
    this.failedLoginTimes = this.failedLoginTimes.filter((attempt) => attempt > cutoff);
  }

  private pruneSessions(): void {
    const now = this.now();
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.revokeSession(token);
    }
  }

  private revokeSession(token: string): void {
    const session = this.sessions.get(token);
    if (session === undefined) return;
    this.sessions.delete(token);
    for (const [controller, expiryTimer] of session.streams) {
      this.sessionTimer.cancel(expiryTimer);
      controller.abort();
    }
    session.streams.clear();
  }

  private revokeAllSessions(): void {
    for (const token of [...this.sessions.keys()]) this.revokeSession(token);
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async withLoginLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.loginTail;
    let release!: () => void;
    this.loginTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function validateNewPassword(password: string): void {
  validatePasswordSize(password);
  if (password.length < MIN_AUTH_PASSWORD_LENGTH) {
    throw new AuthPasswordValidationError(
      `Password must be at least ${MIN_AUTH_PASSWORD_LENGTH} characters`,
    );
  }
}

function validatePasswordSize(password: string): void {
  if (Buffer.byteLength(password, "utf8") > MAX_AUTH_PASSWORD_BYTES) {
    throw new AuthPasswordValidationError(
      `Password must not exceed ${MAX_AUTH_PASSWORD_BYTES} UTF-8 bytes`,
    );
  }
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

async function hashPassword(password: string): Promise<string> {
  return await Bun.password.hash(password, {
    algorithm: "argon2id",
    memoryCost: 65_536,
    timeCost: 3,
  });
}
