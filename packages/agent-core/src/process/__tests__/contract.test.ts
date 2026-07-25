import { describe, expect, test } from "bun:test";
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
    expect(PROCESS_RUNNER_CONTRACT.input.maxOutputBytes).toContain("per stdout/stderr stream");
    expect(PROCESS_RUNNER_CONTRACT.input.outputSink).toContain("cannot prevent");

    const clone = createProcessRunnerContract();
    expect(clone).toBe(PROCESS_RUNNER_CONTRACT);
  });
});
