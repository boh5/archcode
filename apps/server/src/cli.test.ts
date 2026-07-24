import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveCliInvocation } from "./cli";
import { readSourceProductVersion } from "./product-version";

describe("resolveCliInvocation", () => {
  test("starts the server when no arguments are provided", () => {
    expect(resolveCliInvocation([], "1.2.3")).toEqual({ kind: "start", port: 4096 });
  });

  test("uses ARCHCODE_PORT when no CLI port is provided", () => {
    expect(resolveCliInvocation([], "1.2.3", "5096")).toEqual({
      kind: "start",
      port: 5096,
    });
  });

  test.each([
    [["--port", "5096"], "5096"],
    [["--port=5096"], "6000"],
    [["-p", "5096"], undefined],
  ] as const)("accepts a CLI port and gives it precedence for %j", (args, environmentPort) => {
    expect(resolveCliInvocation(args, "1.2.3", environmentPort)).toEqual({
      kind: "start",
      port: 5096,
    });
  });

  test.each([
    [["--port", "0"], undefined],
    [["--port=65536"], undefined],
    [["-p", "12x"], undefined],
    [[], "0"],
    [[], "4096x"],
  ] as const)("rejects an invalid port for %j", (args, environmentPort) => {
    expect(resolveCliInvocation(args, "1.2.3", environmentPort)).toEqual({
      kind: "print",
      exitCode: 1,
      output: expect.stringContaining("expected an integer from 1 to 65535"),
      stream: "stderr",
    });
  });

  test.each(["--port", "-p"])("rejects a missing value for %s", (flag) => {
    expect(resolveCliInvocation([flag], "1.2.3")).toEqual({
      kind: "print",
      exitCode: 1,
      output: expect.stringContaining(`Missing value for ${flag}.`),
      stream: "stderr",
    });
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
      output: expect.stringContaining("-p, --port <port>"),
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

  test("the source bin rejects an invalid logging environment before startup", async () => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts")], {
      env: {
        ...Bun.env,
        ARCHCODE_LOG_LEVEL: "verbose",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Invalid ARCHCODE_LOG_LEVEL");
    expect(stderr).toContain("verbose");
    expect(stderr).toContain("expected debug, info, warn, or error");
  });

  test("version output does not depend on the logging environment", async () => {
    const version = await readSourceProductVersion();
    const proc = Bun.spawn(
      [process.execPath, join(import.meta.dir, "main.ts"), "--version"],
      {
        env: {
          ...Bun.env,
          ARCHCODE_ACCESS_LOG: "invalid",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
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
