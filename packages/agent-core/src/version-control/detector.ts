import { createProcessRunner } from "../process/runner";
import type { ProcessRunner } from "../process/types";

export type VersionControl = "git" | "none";

export type VersionControlDetector = (
  cwd: string,
  signal?: AbortSignal,
) => Promise<VersionControl>;

export function createVersionControlDetector(
  processRunner: ProcessRunner = createProcessRunner(),
): VersionControlDetector {
  return async (cwd, signal) => {
    const result = await processRunner.run({
      argv: ["git", "rev-parse", "--is-inside-work-tree"],
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      ...(signal === undefined ? {} : { signal }),
    });

    return result.kind === "success" && result.output.stdout.trim() === "true"
      ? "git"
      : "none";
  };
}

export const detectVersionControl = createVersionControlDetector();
