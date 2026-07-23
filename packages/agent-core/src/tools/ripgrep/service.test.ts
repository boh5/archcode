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
  return { which: () => undefined,
  exists: () => false,
  isExecutable: () => false,
  platform: "darwin",
  arch: "arm64", ...overrides,  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RipgrepService", () => {
  test("ensure() finds rg in PATH and returns the path", async () => {
    const seam = createMockSeam({
      which: (cmd) => (cmd === "rg" ? "/usr/local/bin/rg" : undefined),
    });
    const svc = createRipgrepService(seam);
    expect(await svc.ensure()).toBe("/usr/local/bin/rg");
  });

  test("ensure() reuses a still-executable BinaryManager path", async () => {
    let callCount = 0;
    const seam = createMockSeam({
      which: (cmd) => {
        callCount++;
        return cmd === "rg" ? "/usr/bin/rg" : undefined;
      },
      exists: (path) => path === "/usr/bin/rg",
      isExecutable: (path) => path === "/usr/bin/rg",
    });
    const svc = createRipgrepService(seam);

    expect(await svc.ensure()).toBe("/usr/bin/rg");
    expect(callCount).toBe(1);
    expect(await svc.ensure()).toBe("/usr/bin/rg");
    expect(callCount).toBe(1);
  });

  test("ensure() does not hide a stale BinaryManager path", async () => {
    let path = "/managed/rg-v1";
    const executablePaths = new Set([path]);
    const seam = createMockSeam({
      which: (cmd) => (cmd === "rg" ? path : undefined),
      exists: (candidate) => executablePaths.has(candidate),
      isExecutable: (candidate) => executablePaths.has(candidate),
    });
    const svc = createRipgrepService(seam);

    expect(await svc.ensure()).toBe("/managed/rg-v1");
    executablePaths.delete(path);
    path = "/managed/rg-v2";
    executablePaths.add(path);

    expect(await svc.ensure()).toBe("/managed/rg-v2");
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

  test("delegates resolution to BinaryManager seam with cached fallback removed", async () => {
    const seam = createMockSeam({
      which: () => undefined,
      exists: () => true,
      isExecutable: () => true,
      platform: "linux",
      arch: "x64",
    });
    const svc = createRipgrepService(seam);
    expect(await svc.ensure()).toBeDefined();
  });
});
