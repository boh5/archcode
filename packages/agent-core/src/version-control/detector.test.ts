import { describe, expect, test } from "bun:test";
import type {
  ProcessRunner,
  ProcessRunnerInput,
  ProcessRunnerResult,
} from "../process/types";
import { createVersionControlDetector } from "./detector";

function successResult(stdout: string): ProcessRunnerResult {
  return {
    kind: "success",
    argv: ["git", "rev-parse", "--is-inside-work-tree"],
    cwd: "/workspace",
    exitCode: 0,
    startedAt: 0,
    finishedAt: 1,
    durationMs: 1,
    output: {
      stdout,
      stderr: "",
      combined: stdout,
      stdoutTruncated: false,
      stderrTruncated: false,
      combinedTruncated: false,
    },
  };
}

function createRunner(
  result: ProcessRunnerResult,
  onRun?: (input: ProcessRunnerInput) => void,
): ProcessRunner {
  return {
    async run(input) {
      onRun?.(input);
      return result;
    },
  };
}

describe("createVersionControlDetector", () => {
  test("detects a Git working tree using the canonical rev-parse probe", async () => {
    let received: ProcessRunnerInput | undefined;
    const detect = createVersionControlDetector(createRunner(successResult("true\n"), (input) => {
      received = input;
    }));

    expect(await detect("/workspace")).toBe("git");
    expect(received?.argv).toEqual(["git", "rev-parse", "--is-inside-work-tree"]);
    expect(received?.cwd).toBe("/workspace");
    expect(received?.env?.GIT_OPTIONAL_LOCKS).toBe("0");
  });

  test("returns none when rev-parse reports a non-working-tree repository", async () => {
    const detect = createVersionControlDetector(createRunner(successResult("false\n")));

    expect(await detect("/workspace")).toBe("none");
  });

  test("returns none when the Git probe fails", async () => {
    const detect = createVersionControlDetector(createRunner({
      kind: "spawn-failure",
      argv: ["git", "rev-parse", "--is-inside-work-tree"],
      cwd: "/workspace",
      error: { name: "Error", message: "git not found" },
    }));

    expect(await detect("/workspace")).toBe("none");
  });

  test("passes the execution abort signal to the Git probe", async () => {
    const controller = new AbortController();
    let received: ProcessRunnerInput | undefined;
    const detect = createVersionControlDetector(createRunner(successResult("true\n"), (input) => {
      received = input;
    }));

    await detect("/workspace", controller.signal);

    expect(received?.signal).toBe(controller.signal);
  });
});
