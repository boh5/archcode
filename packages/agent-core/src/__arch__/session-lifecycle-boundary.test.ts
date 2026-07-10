import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Session lifecycle architecture", () => {
  test("generic execution manager uses injected lifecycle capabilities instead of Goal or Loop imports", () => {
    const source = readFileSync(resolve(import.meta.dir, "../execution/session-execution-manager.ts"), "utf8");

    expect(source).not.toMatch(/from\s+["']\.\.\/(?:goals|loops)(?:\/|["'])/);
    expect(source).toContain("deletionPreflight");
    expect(source).toContain("executionClaimCoordinator");
  });
});
