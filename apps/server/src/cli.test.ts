import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveCliInvocation } from "./cli";
import { readSourceProductVersion } from "./product-version";

describe("resolveCliInvocation", () => {
  test("starts the server when no arguments are provided", () => {
    expect(resolveCliInvocation([], "1.2.3")).toEqual({ kind: "start" });
  });

  test.each(["--version", "-V"])("prints the version for %s", (flag) => {
    expect(resolveCliInvocation([flag], "1.2.3")).toEqual({
      kind: "print",
      exitCode: 0,
      output: "archcode 1.2.3\n",
      stream: "stdout",
    });
  });

  test.each(["--help", "-h"])("prints help for %s", (flag) => {
    expect(resolveCliInvocation([flag], "1.2.3")).toEqual({
      kind: "print",
      exitCode: 0,
      output: expect.stringContaining("Usage: archcode [options]"),
      stream: "stdout",
    });
  });

  test("rejects unsupported arguments", () => {
    expect(resolveCliInvocation(["--unknown"], "1.2.3")).toEqual({
      kind: "print",
      exitCode: 1,
      output: expect.stringContaining("Unknown option: --unknown"),
      stream: "stderr",
    });
  });

  test("the source bin reports the root product version", async () => {
    const version = await readSourceProductVersion();
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts"), "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toBe(`archcode ${version}\n`);
  });
});
