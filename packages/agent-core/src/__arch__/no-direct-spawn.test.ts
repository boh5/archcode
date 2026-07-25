import { expect, test } from "bun:test";

const subprocessOwners = [
  /^packages\/agent-core\/src\/process\/runner\.ts$/,
  /^packages\/agent-core\/src\/lsp\/transport\.ts$/,
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
    return !subprocessOwners.some((pattern) => pattern.test(filePath));
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

test("agent-core runtime centralizes subprocess ownership", () => {
  expectNoDirectSpawnViolations("packages/agent-core/src/", "agent-core");
});

test("server runtime delegates subprocess ownership to agent-core", () => {
  expectNoDirectSpawnViolations("apps/server/src/", "server");
});
