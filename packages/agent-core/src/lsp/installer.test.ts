import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import {
  LspInstallerError,
  resolveServerBinary,
  setInstallerProcessRunnerForTest,
  type ExecCommand,
} from "./installer";

const tmpDir = join(import.meta.dir, "__test_tmp__", "installer");

interface CallRecord {
  command: string[];
}

beforeEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
  Bun.env.XDG_CACHE_HOME = tmpDir;
  setInstallerProcessRunnerForTest(undefined);
});

afterAll(async () => {
  setInstallerProcessRunnerForTest(undefined);
  delete Bun.env.XDG_CACHE_HOME;
  await rm(tmpDir, { recursive: true, force: true });
});

describe("resolveServerBinary", () => {
  it("returns server binary from PATH without installing", async () => {
    const calls: CallRecord[] = [];
    setInstallerProcessRunnerForTest(createSpawnFromExec(async (command) => {
      calls.push({ command });
      if (command[0] === "which") {
        return { stdout: "/usr/local/bin/typescript-language-server\n", stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected command: ${command.join(" ")}`);
    }));

    const result = await resolveServerBinary("typescript");

    expect(result).toBe("/usr/local/bin/typescript-language-server");
    expect(calls.map((call) => call.command[0])).toEqual(["which"]);
  });

  it("installs npm-backed server when binary is not on PATH", async () => {
    const calls: CallRecord[] = [];
    setInstallerProcessRunnerForTest(createSpawnFromExec(createInstallingExec(calls)));

    const result = await resolveServerBinary("typescript");

    expect(result).toMatch(/archcode\/lsp-servers\/typescript\/bin\/typescript-language-server$/);
    expect(calls.map((call) => call.command.join(" "))).toEqual([
      "which typescript-language-server",
      expect.stringMatching(/^npm install -g --prefix .* typescript-language-server$/),
    ]);
  });

  it("caches resolved binary path for future calls", async () => {
    const calls: CallRecord[] = [];
    setInstallerProcessRunnerForTest(createSpawnFromExec(createInstallingExec(calls)));

    const first = await resolveServerBinary("typescript");
    const second = await resolveServerBinary("typescript");

    expect(second).toBe(first);
    expect(calls.filter((call) => call.command[0] === "npm")).toHaveLength(1);
    expect(calls.filter((call) => call.command[0] === "which")).toHaveLength(1);
  });

  it("returns actionable manual install error when server has no npmPackage", async () => {
    setInstallerProcessRunnerForTest(createSpawnFromExec(async () => ({ stdout: "", stderr: "missing", exitCode: 1 })));

    try {
      await resolveServerBinary("go");
      throw new Error("Expected resolveServerBinary to fail");
    } catch (error) {
      expect(error).toMatchObject({
        name: "LspInstallerError",
        serverId: "go",
        command: "go install golang.org/x/tools/gopls@latest",
      });
    }
  });

  it("deduplicates concurrent installs for the same server", async () => {
    const calls: CallRecord[] = [];
    let installCount = 0;
    setInstallerProcessRunnerForTest(createSpawnFromExec(async (command) => {
      calls.push({ command });
      if (command[0] === "which") return { stdout: "", stderr: "", exitCode: 1 };
      if (command[0] === "npm") {
        installCount += 1;
        await sleep(10);
        const prefix = command[4]!;
        await writeInstalledBinary(prefix, "typescript-language-server");
        return { stdout: "installed", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "unexpected", exitCode: 1 };
    }));

    const [first, second] = await Promise.all([
      resolveServerBinary("typescript"),
      resolveServerBinary("typescript"),
    ]);

    expect(first).toBe(second);
    expect(installCount).toBe(1);
    expect(calls.filter((call) => call.command[0] === "which")).toHaveLength(1);
  });

  it("cleans up and returns actionable error when install fails", async () => {
    setInstallerProcessRunnerForTest(createSpawnFromExec(async (command) => {
      if (command[0] === "which") return { stdout: "", stderr: "", exitCode: 1 };
      if (command[0] === "npm") return { stdout: "", stderr: "network unavailable", exitCode: 1 };
      return { stdout: "", stderr: "unexpected", exitCode: 1 };
    }));

    try {
      await resolveServerBinary("typescript");
      throw new Error("Expected resolveServerBinary to fail");
    } catch (error) {
      expect(error).toMatchObject({
        name: "LspInstallerError",
        serverId: "typescript",
        command: "npm install -g typescript-language-server",
        details: "network unavailable",
      });
    }

    const serverRoot = join(tmpDir, "archcode", "lsp-servers", "typescript");
    expect(await Bun.file(serverRoot).exists()).toBe(false);
  });

  it("times out npm install and cleans temporary install root", async () => {
    setInstallerProcessRunnerForTest((argv) => {
      const stdout = new ControlledReadableStream();
      const stderr = new ControlledReadableStream();
      let timeoutKill: (() => void) | undefined;
      const exited = argv[0] === "which"
        ? Promise.resolve().then(() => {
          stdout.close();
          stderr.close();
          return 1;
        })
        : new Promise<number>((resolve) => {
          const exit = () => {
            stdout.close();
            stderr.close();
            resolve(1);
          };
          timeoutKill = exit;
          setTimeout(exit, 20);
        });

      return {
        stdout: stdout.stream,
        stderr: stderr.stream,
        exited,
        exitCode: null,
        signalCode: null,
        kill: () => {
          timeoutKill?.();
        },
      };
    });

    try {
      await resolveServerBinary("typescript", { timeoutMs: 5 });
      throw new Error("Expected resolveServerBinary to time out");
    } catch (error) {
      expect(error).toMatchObject({
        name: "LspInstallerError",
        serverId: "typescript",
        command: "npm install -g typescript-language-server",
      });
      expect((error as Error).message).toContain("Timed out after 5ms");
    }

    const serverRoot = join(tmpDir, "archcode", "lsp-servers", "typescript");
    expect(await Bun.file(serverRoot).exists()).toBe(false);
  });

  it("aborts npm install with actionable error", async () => {
    const controller = new AbortController();
    setInstallerProcessRunnerForTest(createSpawnFromExec(async (command) => {
      if (command[0] === "which") return { stdout: "", stderr: "", exitCode: 1 };
      controller.abort("cancelled by test");
      return { stdout: "", stderr: "", exitCode: 1 };
    }));

    try {
      await resolveServerBinary("typescript", { signal: controller.signal });
      throw new Error("Expected resolveServerBinary to fail after abort");
    } catch (error) {
      expect(error).toMatchObject({
        name: "LspInstallerError",
        serverId: "typescript",
        command: "npm install -g typescript-language-server",
      });
    }
  });

  it("setInstallerProcessRunnerForTest resets mock injection and cached results", async () => {
    const firstCalls: CallRecord[] = [];
    setInstallerProcessRunnerForTest(createSpawnFromExec(async (command) => {
      firstCalls.push({ command });
      return { stdout: "/first/bin/typescript-language-server\n", stderr: "", exitCode: 0 };
    }));
    expect(await resolveServerBinary("typescript")).toBe("/first/bin/typescript-language-server");

    const secondCalls: CallRecord[] = [];
    setInstallerProcessRunnerForTest(createSpawnFromExec(async (command) => {
      secondCalls.push({ command });
      return { stdout: "/second/bin/typescript-language-server\n", stderr: "", exitCode: 0 };
    }));

    expect(await resolveServerBinary("typescript")).toBe("/second/bin/typescript-language-server");
    expect(firstCalls).toHaveLength(1);
    expect(secondCalls).toHaveLength(1);
  });

  it("throws named error for unknown server id", async () => {
    try {
      await resolveServerBinary("unknown-server");
      throw new Error("Expected resolveServerBinary to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(LspInstallerError);
    }
  });
});

function createInstallingExec(calls: CallRecord[]): ExecCommand {
  return async (command) => {
    calls.push({ command });
    if (command[0] === "which") return { stdout: "", stderr: "", exitCode: 1 };
    if (command[0] === "npm") {
      const prefix = command[4]!;
      await writeInstalledBinary(prefix, "typescript-language-server");
      return { stdout: "installed", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "unexpected", exitCode: 1 };
  };
}

async function writeInstalledBinary(prefix: string, binary: string): Promise<void> {
  const binDir = join(prefix, "bin");
  await mkdir(binDir, { recursive: true });
  await Bun.write(join(binDir, binary), "#!/usr/bin/env sh\n");
}

function createSpawnFromExec(exec: ExecCommand): Parameters<typeof setInstallerProcessRunnerForTest>[0] {
  return (argv) => {
    const stdout = new TransformStream<Uint8Array>();
    const stderr = new TransformStream<Uint8Array>();
    let exitCode: number | null = null;
    const exited = exec([...argv]).then(async (result) => {
      exitCode = result.exitCode;
      await writeText(stdout.writable, result.stdout);
      await writeText(stderr.writable, result.stderr);
      return result.exitCode;
    });

    return {
      stdout: stdout.readable,
      stderr: stderr.readable,
      exited,
      get exitCode() {
        return exitCode;
      },
      signalCode: null,
      kill: () => {},
    };
  };
}

class ControlledReadableStream {
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  private closed = false;

  readonly stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      this.controller = controller;
      if (this.closed) controller.close();
    },
  });

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller?.close();
  }
}

async function writeText(stream: WritableStream<Uint8Array>, text: string): Promise<void> {
  const writer = stream.getWriter();
  try {
    if (text) await writer.write(new TextEncoder().encode(text));
  } finally {
    await writer.close();
    writer.releaseLock();
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
