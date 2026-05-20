import { describe, expect, test } from "bun:test";
import {
  createRipgrepService,
  RipgrepNotFoundError,
} from "./service";
import type { DiscoverySeam } from "./service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSeam(overrides?: Partial<DiscoverySeam>): DiscoverySeam {
  return {
    which: () => null,
    exists: () => false,
    isExecutable: () => false,
    homeDir: () => "/home/testuser",
    platform: "darwin",
    arch: "arm64",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RipgrepService", () => {
  test("ensure() finds rg in PATH and returns the path", async () => {
    const seam = createMockSeam({
      which: (cmd) => (cmd === "rg" ? "/usr/local/bin/rg" : null),
    });
    const svc = createRipgrepService(seam);
    expect(await svc.ensure()).toBe("/usr/local/bin/rg");
  });

  test("ensure() memoizes the resolved path and does not search again", async () => {
    let callCount = 0;
    const seam = createMockSeam({
      which: (cmd) => {
        callCount++;
        return cmd === "rg" ? "/usr/bin/rg" : null;
      },
    });
    const svc = createRipgrepService(seam);

    // First call – should go through which().
    expect(await svc.ensure()).toBe("/usr/bin/rg");
    expect(callCount).toBe(1);

    // Second call – should use memoized value, which() NOT called again.
    expect(await svc.ensure()).toBe("/usr/bin/rg");
    expect(callCount).toBe(1);
  });

  test("ensure() falls back to cached binary when rg is not in PATH", async () => {
    const cachedPath = "/home/testuser/.specra/bin/darwin-arm64/rg";
    const seam = createMockSeam({
      which: () => null,
      exists: (p) => p === cachedPath,
      isExecutable: (p) => p === cachedPath,
    });
    const svc = createRipgrepService(seam);
    expect(await svc.ensure()).toBe(cachedPath);
  });

  test("ensure() throws RipgrepNotFoundError when rg is nowhere", async () => {
    const svc = createRipgrepService(createMockSeam());
    expect(svc.ensure()).rejects.toThrow(RipgrepNotFoundError);
  });

  test("error message includes install instructions", async () => {
    const svc = createRipgrepService(createMockSeam());
    try {
      await svc.ensure();
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RipgrepNotFoundError);
      const msg = (e as RipgrepNotFoundError).message;
      expect(msg).toContain("ripgrep");
      expect(msg).toContain("install");
    }
  });

  test("factory creates a service with default (real) seam", () => {
    const svc = createRipgrepService();
    expect(svc).toBeDefined();
    expect(typeof svc.ensure).toBe("function");
  });

  test("platform-specific cached path — linux-x64", async () => {
    const cachedPath = "/home/testuser/.specra/bin/linux-x64/rg";
    const seam = createMockSeam({
      which: () => null,
      exists: (p) => p === cachedPath,
      isExecutable: (p) => p === cachedPath,
      platform: "linux",
      arch: "x64",
    });
    const svc = createRipgrepService(seam);
    expect(await svc.ensure()).toBe(cachedPath);
  });

  test("platform-specific cached path — darwin-x64", async () => {
    const cachedPath = "/home/testuser/.specra/bin/darwin-x64/rg";
    const seam = createMockSeam({
      which: () => null,
      exists: (p) => p === cachedPath,
      isExecutable: (p) => p === cachedPath,
      platform: "darwin",
      arch: "x64",
    });
    const svc = createRipgrepService(seam);
    expect(await svc.ensure()).toBe(cachedPath);
  });

  test("platform-specific cached path — linux-arm64", async () => {
    const cachedPath = "/home/testuser/.specra/bin/linux-arm64/rg";
    const seam = createMockSeam({
      which: () => null,
      exists: (p) => p === cachedPath,
      isExecutable: (p) => p === cachedPath,
      platform: "linux",
      arch: "arm64",
    });
    const svc = createRipgrepService(seam);
    expect(await svc.ensure()).toBe(cachedPath);
  });

  test("cached binary not used when exists but not executable", async () => {
    const cachedPath = "/home/testuser/.specra/bin/darwin-arm64/rg";
    const seam = createMockSeam({
      which: () => null,
      exists: (p) => p === cachedPath,
      isExecutable: () => false,
    });
    const svc = createRipgrepService(seam);
    expect(svc.ensure()).rejects.toThrow(RipgrepNotFoundError);
  });

  test("cached binary not used when file does not exist", async () => {
    const seam = createMockSeam({
      which: () => null,
      exists: () => false,
      isExecutable: () => false,
    });
    const svc = createRipgrepService(seam);
    expect(svc.ensure()).rejects.toThrow(RipgrepNotFoundError);
  });
});
