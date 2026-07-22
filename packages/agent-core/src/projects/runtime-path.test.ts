import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { PROJECT_RUNTIME_DIR_NAME, PROJECT_STATE_DIR_NAME } from "@archcode/protocol";
import { projectRuntimePath } from "./runtime-path";

describe("PROJECT_RUNTIME_DIR_NAME", () => {
  it('equals "runtime"', () => {
    expect(PROJECT_RUNTIME_DIR_NAME).toBe("runtime");
  });
});

describe("projectRuntimePath", () => {
  const workspaceRoot = "/tmp/p";

  it("joins empty parts to the runtime root", () => {
    expect(projectRuntimePath(workspaceRoot)).toBe(
      join(workspaceRoot, PROJECT_STATE_DIR_NAME, PROJECT_RUNTIME_DIR_NAME),
    );
  });

  it("joins a single segment under runtime", () => {
    expect(projectRuntimePath(workspaceRoot, "sessions")).toBe(
      join(workspaceRoot, PROJECT_STATE_DIR_NAME, PROJECT_RUNTIME_DIR_NAME, "sessions"),
    );
  });

  it("joins multiple segments under runtime", () => {
    expect(projectRuntimePath(workspaceRoot, "todos", "state.json")).toBe(
      join(
        workspaceRoot,
        PROJECT_STATE_DIR_NAME,
        PROJECT_RUNTIME_DIR_NAME,
        "todos",
        "state.json",
      ),
    );
  });
});
