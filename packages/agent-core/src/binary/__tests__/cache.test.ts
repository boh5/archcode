import { describe, expect, test } from "bun:test";
import {
  getBinaryCacheBaseDir,
  getBinaryCacheDir,
  getBinaryCachePath,
  getCurrentTargetTriple,
  targetTripleForPlatform,
  UnsupportedBinaryPlatformError,
} from "../cache";
import { getBinarySpec } from "../manifest";

describe("binary cache layout", () => {
  test("uses XDG_CACHE_HOME when present", () => {
    expect(getBinaryCacheBaseDir({ XDG_CACHE_HOME: "/xdg/cache", HOME: "/home/specra" })).toBe("/xdg/cache/specra/bin");
  });

  test("falls back to HOME .cache", () => {
    expect(getBinaryCacheBaseDir({ HOME: "/home/specra" })).toBe("/home/specra/.cache/specra/bin");
  });

  test("builds versioned target-specific binary paths", () => {
    const rg = getBinarySpec("rg");

    expect(getBinaryCacheDir({ spec: rg, targetTriple: "aarch64-apple-darwin", env: { XDG_CACHE_HOME: "/cache" } })).toBe(
      "/cache/specra/bin/aarch64-apple-darwin/rg/15.1.0",
    );
    expect(getBinaryCachePath({ spec: rg, targetTriple: "aarch64-apple-darwin", env: { XDG_CACHE_HOME: "/cache" } })).toBe(
      "/cache/specra/bin/aarch64-apple-darwin/rg/15.1.0/rg",
    );
  });

  test("maps supported process platform and arch pairs to Rust targets", () => {
    expect(targetTripleForPlatform("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(targetTripleForPlatform("darwin", "x64")).toBe("x86_64-apple-darwin");
    expect(targetTripleForPlatform("linux", "arm64")).toBe("aarch64-unknown-linux-gnu");
    expect(targetTripleForPlatform("linux", "x64")).toBe("x86_64-unknown-linux-gnu");
    expect(getCurrentTargetTriple({ platform: "darwin", arch: "arm64" })).toBe("aarch64-apple-darwin");
  });

  test("rejects unsupported platforms with a typed error", () => {
    expect(() => targetTripleForPlatform("win32", "x64")).toThrow(UnsupportedBinaryPlatformError);

    try {
      targetTripleForPlatform("win32", "x64");
      throw new Error("expected targetTripleForPlatform to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedBinaryPlatformError);
      expect((error as UnsupportedBinaryPlatformError).name).toBe("UnsupportedBinaryPlatformError");
      expect((error as UnsupportedBinaryPlatformError).platform).toBe("win32");
      expect((error as UnsupportedBinaryPlatformError).arch).toBe("x64");
    }
  });
});
