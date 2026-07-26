import { describe, expect, mock, test } from "bun:test";
import {
  AuthPasswordValidationError,
  AuthRateLimitError,
  InvalidAuthCredentialsError,
  ServerAuthService,
  type AuthSessionTimer,
  type AuthSessionTimerHandle,
} from "./server-auth-service";

function createService(options: {
  passwordHash?: string;
  now?: () => number;
  maxLoginFailures?: number;
  maxSessions?: number;
  sessionTtlMs?: number;
  sessionTimer?: AuthSessionTimer;
} = {}) {
  const updateAuthPasswordHash = mock(async (_hash: string | undefined) => undefined);
  return {
    service: new ServerAuthService({
      ...options,
      configWriter: { updateAuthPasswordHash },
    }),
    updateAuthPasswordHash,
  };
}

function createManualSessionTimer(): AuthSessionTimer & {
  fireScheduled(): void;
  pendingCount(): number;
} {
  let nextId = 1;
  const scheduled = new Map<number, () => void>();
  return {
    schedule: (_delayMs, callback) => {
      const id = nextId++;
      scheduled.set(id, callback);
      return { id };
    },
    cancel: (handle: AuthSessionTimerHandle) => {
      if (typeof handle.id === "number") scheduled.delete(handle.id);
    },
    fireScheduled: () => {
      const callbacks = [...scheduled.values()];
      scheduled.clear();
      for (const callback of callbacks) callback();
    },
    pendingCount: () => scheduled.size,
  };
}

describe("ServerAuthService", () => {
  test("stores Argon2id only and verifies an opaque process session", async () => {
    const { service } = createService();
    const hash = await service.hashPassword("correct horse battery");
    expect(hash).toStartWith("$argon2id$");

    service.activateCredential(hash);
    const session = await service.login("correct horse battery");

    expect(service.authenticate(session.token)).toBe(true);
    expect(service.authenticate("wrong")).toBe(false);
    service.logout(session.token);
    expect(service.authenticate(session.token)).toBe(false);
  });

  test("rejects short passwords", async () => {
    const { service } = createService();
    await expect(service.hashPassword("short")).rejects.toBeInstanceOf(
      AuthPasswordValidationError,
    );
  });

  test("expires process-local sessions at their absolute deadline", async () => {
    let now = 1_000;
    const { service } = createService({ now: () => now, sessionTtlMs: 100 });
    const hash = await service.hashPassword("correct horse battery");
    service.activateCredential(hash);
    const session = service.issueSession();

    now = session.expiresAt;

    expect(service.authenticate(session.token)).toBe(false);
  });

  test("actively aborts bound streams on logout and a triggered absolute expiry", async () => {
    let now = 1_000;
    const sessionTimer = createManualSessionTimer();
    const { service } = createService({
      now: () => now,
      sessionTtlMs: 40,
      sessionTimer,
    });
    const hash = await service.hashPassword("correct horse battery");
    service.activateCredential(hash);

    const loggedOut = service.issueSession();
    const logoutStream = service.openSessionStream(loggedOut.token);
    expect(logoutStream?.signal.aborted).toBe(false);
    service.logout(loggedOut.token);
    expect(logoutStream?.signal.aborted).toBe(true);

    const expiring = service.issueSession();
    const expiryStream = service.openSessionStream(expiring.token);
    expect(expiryStream?.signal.aborted).toBe(false);
    expect(sessionTimer.pendingCount()).toBe(1);
    now = expiring.expiresAt;
    sessionTimer.fireScheduled();
    expect(expiryStream?.signal.aborted).toBe(true);
    expect(service.authenticate(expiring.token)).toBe(false);
  });

  test("bounds process-local sessions by evicting the oldest", async () => {
    const { service } = createService({ maxSessions: 2 });
    const hash = await service.hashPassword("correct horse battery");
    service.activateCredential(hash);
    const first = service.issueSession();
    const firstStream = service.openSessionStream(first.token);
    const second = service.issueSession();
    const third = service.issueSession();

    expect(service.authenticate(first.token)).toBe(false);
    expect(firstStream?.signal.aborted).toBe(true);
    expect(service.authenticate(second.token)).toBe(true);
    expect(service.authenticate(third.token)).toBe(true);
  });

  test("rate limits repeated invalid login attempts", async () => {
    const { service } = createService({ maxLoginFailures: 2 });
    const hash = await service.hashPassword("correct horse battery");
    service.activateCredential(hash);

    await expect(service.login("bad password")).rejects.toBeInstanceOf(
      InvalidAuthCredentialsError,
    );
    await expect(service.login("bad password")).rejects.toBeInstanceOf(
      InvalidAuthCredentialsError,
    );
    await expect(service.login("correct horse battery")).rejects.toBeInstanceOf(
      AuthRateLimitError,
    );
  });

  test("serializes concurrent verification before admitting more Argon2 work", async () => {
    let activeVerifications = 0;
    let maximumConcurrentVerifications = 0;
    const releases: Array<() => void> = [];
    const entries: Array<() => void> = [];
    const service = new ServerAuthService({
      passwordHash: "test-hash",
      maxLoginFailures: 2,
      configWriter: { updateAuthPasswordHash: mock(async () => undefined) },
      passwordVerifier: async () => {
        activeVerifications += 1;
        maximumConcurrentVerifications = Math.max(
          maximumConcurrentVerifications,
          activeVerifications,
        );
        entries.shift()?.();
        await new Promise<void>((resolve) => releases.push(resolve));
        activeVerifications -= 1;
        return false;
      },
    });

    const firstEntered = new Promise<void>((resolve) => entries.push(resolve));
    const resultsPromise = Promise.allSettled([
      service.login("bad password 1"),
      service.login("bad password 2"),
      service.login("bad password 3"),
      service.login("bad password 4"),
    ]);
    await firstEntered;
    expect(activeVerifications).toBe(1);

    const secondEntered = new Promise<void>((resolve) => entries.push(resolve));
    releases.shift()?.();
    await secondEntered;
    expect(activeVerifications).toBe(1);
    releases.shift()?.();

    const results = await resultsPromise;
    expect(maximumConcurrentVerifications).toBe(1);
    expect(results.filter(
      (result) => result.status === "rejected"
        && result.reason instanceof InvalidAuthCredentialsError,
    )).toHaveLength(2);
    expect(results.filter(
      (result) => result.status === "rejected"
        && result.reason instanceof AuthRateLimitError,
    )).toHaveLength(2);
  });

  test("commits password changes before replacing credentials and sessions", async () => {
    const { service, updateAuthPasswordHash } = createService();
    const originalHash = await service.hashPassword("original password");
    service.activateCredential(originalHash);
    const oldSession = await service.login("original password");

    const newSession = await service.updatePassword({
      currentPassword: "original password",
      newPassword: "replacement password",
    });

    expect(updateAuthPasswordHash).toHaveBeenCalledTimes(1);
    expect(String(updateAuthPasswordHash.mock.calls[0]?.[0])).toStartWith("$argon2id$");
    expect(service.authenticate(oldSession.token)).toBe(false);
    expect(service.authenticate(newSession?.token)).toBe(true);
    await expect(service.login("original password")).rejects.toBeInstanceOf(
      InvalidAuthCredentialsError,
    );
  });

  test("does not change in-memory credentials when persistence fails", async () => {
    const originalHash = await Bun.password.hash("original password", "argon2id");
    const service = new ServerAuthService({
      passwordHash: originalHash,
      configWriter: {
        updateAuthPasswordHash: mock(async () => {
          throw new Error("disk unavailable");
        }),
      },
    });

    await expect(service.updatePassword({
      currentPassword: "original password",
      newPassword: "replacement password",
    })).rejects.toThrow("disk unavailable");

    expect((await service.login("original password")).token).toBeString();
  });

  test("bounds the current password before verification", async () => {
    const originalHash = await Bun.password.hash("original password", "argon2id");
    const service = new ServerAuthService({
      passwordHash: originalHash,
      configWriter: { updateAuthPasswordHash: mock(async () => undefined) },
      passwordVerifier: mock(async () => true),
    });

    await expect(service.updatePassword({
      currentPassword: "x".repeat(1025),
      newPassword: "replacement password",
    })).rejects.toBeInstanceOf(AuthPasswordValidationError);
  });

  test("does not issue a session from a credential changed during verification", async () => {
    let releaseVerify!: () => void;
    const verificationBlocked = new Promise<void>((resolve) => {
      releaseVerify = resolve;
    });
    const originalHash = await Bun.password.hash("original password", "argon2id");
    const service = new ServerAuthService({
      passwordHash: originalHash,
      configWriter: { updateAuthPasswordHash: mock(async () => undefined) },
      passwordVerifier: async (password, hash) => {
        await verificationBlocked;
        return await Bun.password.verify(password, hash);
      },
    });
    const login = service.login("original password");
    service.activateCredential(await Bun.password.hash("replacement password", "argon2id"));
    releaseVerify();
    await expect(login).rejects.toBeInstanceOf(InvalidAuthCredentialsError);
  });
});
