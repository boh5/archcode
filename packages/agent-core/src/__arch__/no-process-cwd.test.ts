import { test, expect } from "bun:test";

test("production code receives cwd from an explicit owner", () => {
  const proc = Bun.spawnSync([
    "grep",
    "-rn",
    "--include=*.ts",
    "process\\.cwd",
    "packages/agent-core/src/",
  ]);
  const stdout = proc.stdout.toString().trim();

  if (!stdout) {
    expect(true).toBe(true);
    return;
  }

  const violations = stdout.split("\n").filter((line) => {
    const filePath = line.split(":")[0];
    return !filePath.endsWith(".test.ts") && !filePath.includes("__test_tmp__");
  });

  const message =
    violations.length > 0
      ? `Found implicit cwd lookup in non-test files:\n${violations.join("\n")}`
      : "no violations (all matches are in test files or fixtures)";
  expect(violations, message).toEqual([]);
});
