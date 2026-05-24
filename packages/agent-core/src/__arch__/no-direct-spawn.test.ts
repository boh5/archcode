/**
 * Architecture regression test: production runtime code should not reintroduce
 * direct short-lived Bun.spawn calls outside the explicit migration allowlist.
 *
 * Allowed exceptions are documented in packages/agent-core/src/process/allowlist.ts:
 * - packages/agent-core/src/process/**: ProcessRunner owns the short-lived spawn boundary.
 * - packages/agent-core/src/lsp/transport.ts: long-lived JSON-RPC stdio process ownership.
 * - scripts/**: build-time tooling is not runtime code.
 * - test files: fixtures and assertions may spawn children.
 */

import { expect, test } from "bun:test";

const allowedPathPatterns = [
  /^packages\/agent-core\/src\/process\//,
  /^packages\/agent-core\/src\/lsp\/transport\.ts$/,
  /^scripts\//,
  /(^|\/)__tests__\//,
  /\.test\.ts$/,
  /\.test\.tsx$/,
] as const;

function findDirectSpawnViolations(scopeDir: string): string[] {
  const proc = Bun.spawnSync(["grep", "-rn", "--include=*.ts", "Bun.spawn(", scopeDir]);
  const stdout = proc.stdout.toString().trim();

  if (!stdout) return [];

  return stdout.split("\n").filter((line) => {
    const filePath = line.split(":")[0];
    if (!filePath || filePath.includes("__test_tmp__")) return false;
    return !allowedPathPatterns.some((pattern) => pattern.test(filePath));
  });
}

function expectNoDirectSpawnViolations(scopeDir: string, scopeLabel: string): void {
  const violations = findDirectSpawnViolations(scopeDir);
  const message =
    violations.length > 0
      ? `Found direct Bun.spawn in ${scopeLabel} runtime files:\n${violations.join("\n")}`
      : `no direct Bun.spawn in ${scopeLabel}`;
  expect(violations, message).toEqual([]);
}

test("agent-core runtime does not add direct Bun.spawn outside the allowlist", () => {
  expectNoDirectSpawnViolations("packages/agent-core/src/", "agent-core");
});

test("server runtime does not add direct Bun.spawn outside the allowlist", () => {
  expectNoDirectSpawnViolations("apps/server/src/", "server");
});
