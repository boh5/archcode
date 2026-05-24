import { describe, expect, test } from "bun:test";
import {
  DIRECT_BUN_SPAWN_MIGRATION_ALLOWLIST,
  DIRECT_BUN_SPAWN_MIGRATION_ALLOWLIST_NOTE,
} from "../allowlist";
import {
  PROCESS_RUNNER_CONTRACT,
  PROCESS_RUNNER_RESULT_KINDS,
  createProcessRunnerContract,
} from "../contract";

describe("process runner contract", () => {
  test("defines explicit result kinds and input semantics", () => {
    expect(PROCESS_RUNNER_RESULT_KINDS).toEqual([
      "success",
      "nonzero",
      "timeout",
      "aborted",
      "signal",
      "spawn-failure",
    ]);

    expect(PROCESS_RUNNER_CONTRACT.name).toBe("ProcessRunner");
    expect(PROCESS_RUNNER_CONTRACT.input.argv).toContain("argv[0]");
    expect(PROCESS_RUNNER_CONTRACT.input.timeoutMs).toContain("milliseconds");
    expect(PROCESS_RUNNER_CONTRACT.output.combinedTruncated).toContain("maxOutputBytes");

    const clone = createProcessRunnerContract();
    expect(clone).toBe(PROCESS_RUNNER_CONTRACT);
  });

  test("keeps the migration allowlist explicit and documented", () => {
    expect(DIRECT_BUN_SPAWN_MIGRATION_ALLOWLIST).toEqual([
      "packages/agent-core/src/process/**",
      "packages/agent-core/src/lsp/transport.ts",
      "scripts/build.ts",
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/__tests__/**",
    ]);

    expect(DIRECT_BUN_SPAWN_MIGRATION_ALLOWLIST_NOTE).toContain("migration allowlist");
    expect(DIRECT_BUN_SPAWN_MIGRATION_ALLOWLIST_NOTE).toContain("direct Bun.spawn");
  });
});
