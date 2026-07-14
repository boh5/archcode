import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Session lifecycle architecture", () => {
  test("generic execution manager uses injected lifecycle capabilities without direct Goal imports", () => {
    const source = readFileSync(resolve(import.meta.dir, "../execution/session-execution-manager.ts"), "utf8");

    expect(source).not.toMatch(/from\s+["']\.\.\/goals(?:\/|["'])/);
    expect(source).toContain("deletionLifecycle");
    expect(source).toContain("assertDeletable");
    expect(source).toContain("prepareForDeletion");
    expect(source).toContain("executionClaimCoordinator");
  });
});
