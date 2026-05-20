import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import {
  LspInstallerError,
  resolveServerBinary,
  setExecCommandForTest,
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
  setExecCommandForTest(undefined);
});

afterAll(async () => {
  setExecCommandForTest(undefined);
  delete Bun.env.XDG_CACHE_HOME;
  await rm(tmpDir, { recursive: true, force: true });
});

describe("resolveServerBinary", () => {
  it("returns server binary from PATH without installing", async () => {
    const calls: CallRecord[] = [];
    setExecCommandForTest(async (command) => {
      calls.push({ command });
      if (command[0] === "which") {
        return { stdout: "/usr/local/bin/typescript-language-server\n", stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected command: ${command.join(" ")}`);
    });

    const result = await resolveServerBinary("typescript");

    expect(result).toBe("/usr/local/bin/typescript-language-server");
    expect(calls.map((call) => call.command[0])).toEqual(["which"]);
  });

  it("installs npm-backed server when binary is not on PATH", async () => {
    const calls: CallRecord[] = [];
    setExecCommandForTest(createInstallingExec(calls));

    const result = await resolveServerBinary("typescript");

    expect(result).toMatch(/specra\/lsp-servers\/typescript\/bin\/typescript-language-server$/);
    expect(calls.map((call) => call.command.join(" "))).toEqual([
      "which typescript-language-server",
      expect.stringMatching(/^npm install -g --prefix .* typescript-language-server$/),
    ]);
  });

  it("caches resolved binary path for future calls", async () => {
    const calls: CallRecord[] = [];
    setExecCommandForTest(createInstallingExec(calls));

    const first = await resolveServerBinary("typescript");
    const second = await resolveServerBinary("typescript");

    expect(second).toBe(first);
    expect(calls.filter((call) => call.command[0] === "npm")).toHaveLength(1);
    expect(calls.filter((call) => call.command[0] === "which")).toHaveLength(1);
  });

  it("returns actionable manual install error when server has no npmPackage", async () => {
    setExecCommandForTest(async () => ({ stdout: "", stderr: "missing", exitCode: 1 }));

    await expect(resolveServerBinary("go")).rejects.toMatchObject({
      name: "LspInstallerError",
      serverId: "go",
      command: "go install golang.org/x/tools/gopls@latest",
    });
  });

  it("deduplicates concurrent installs for the same server", async () => {
    const calls: CallRecord[] = [];
    let installCount = 0;
    setExecCommandForTest(async (command) => {
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
    });

    const [first, second] = await Promise.all([
      resolveServerBinary("typescript"),
      resolveServerBinary("typescript"),
    ]);

    expect(first).toBe(second);
    expect(installCount).toBe(1);
    expect(calls.filter((call) => call.command[0] === "which")).toHaveLength(1);
  });

  it("cleans up and returns actionable error when install fails", async () => {
    setExecCommandForTest(async (command) => {
      if (command[0] === "which") return { stdout: "", stderr: "", exitCode: 1 };
      if (command[0] === "npm") return { stdout: "", stderr: "network unavailable", exitCode: 1 };
      return { stdout: "", stderr: "unexpected", exitCode: 1 };
    });

    await expect(resolveServerBinary("typescript")).rejects.toMatchObject({
      name: "LspInstallerError",
      serverId: "typescript",
      command: "npm install -g typescript-language-server",
      details: "network unavailable",
    });

    const serverRoot = join(tmpDir, "specra", "lsp-servers", "typescript");
    expect(await Bun.file(serverRoot).exists()).toBe(false);
  });

  it("setExecCommandForTest resets mock injection and cached results", async () => {
    const firstCalls: CallRecord[] = [];
    setExecCommandForTest(async (command) => {
      firstCalls.push({ command });
      return { stdout: "/first/bin/typescript-language-server\n", stderr: "", exitCode: 0 };
    });
    expect(await resolveServerBinary("typescript")).toBe("/first/bin/typescript-language-server");

    const secondCalls: CallRecord[] = [];
    setExecCommandForTest(async (command) => {
      secondCalls.push({ command });
      return { stdout: "/second/bin/typescript-language-server\n", stderr: "", exitCode: 0 };
    });

    expect(await resolveServerBinary("typescript")).toBe("/second/bin/typescript-language-server");
    expect(firstCalls).toHaveLength(1);
    expect(secondCalls).toHaveLength(1);
  });

  it("throws named error for unknown server id", async () => {
    await expect(resolveServerBinary("unknown-server")).rejects.toBeInstanceOf(LspInstallerError);
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
