/**
 * Architecture regression test: prevent implicit current-working-directory lookup from reappearing
 * in non-test source files.
 *
 * M5 removed all implicit cwd fallbacks from:
 *   - src/main.ts         → workspaceRoot from config path
 *   - src/agents/query/loop.ts  → MissingProjectContextError
 *   - src/agents/configured-agent.ts → MissingProjectContextError
 *   - src/agents/query/hooks/title-generation.ts → explicit workspaceRoot arg
 *   - src/tools/builtins/bash.ts → ctx.workspaceRoot via ProjectContext
 *
 * This test locks in M5's win by failing if anyone reintroduces implicit cwd lookup
 * outside of .test.ts files or __test_tmp__/ test fixtures.
 */

import { test, expect } from "bun:test";

test("no implicit cwd lookup in non-test src/ files", () => {
  const proc = Bun.spawnSync([
    "grep",
    "-rn",
    "--include=*.ts",
    "process\\.cwd",
    "packages/agent-core/src/",
  ]);
  const stdout = proc.stdout.toString().trim();

  // No matches at all — clean
  if (!stdout) {
    expect(true).toBe(true);
    return;
  }

  // Filter out allowed locations: .test.ts files and __test_tmp__/ directories
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
