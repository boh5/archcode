import { describe, expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";

import { createTestTempRoot } from "../../testing/test-temp-root";

describe("view_tool_output tool integration", () => {
  it("imports when the tool output directory does not exist", async () => {
    const freshHome = createTestTempRoot("view-tool-output-import");
    await mkdir(freshHome.path, { recursive: true });

    try {
      const process = Bun.spawn(
        ["bun", "-e", 'await import("./view-tool-output.ts")'],
        {
          cwd: import.meta.dir,
          env: { ...Bun.env, HOME: freshHome.path },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, stderr] = await Promise.all([
        process.exited,
        new Response(process.stderr).text(),
      ]);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
    } finally {
      await freshHome.cleanup();
    }
  });
});
