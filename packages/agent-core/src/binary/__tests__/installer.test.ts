import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { access, mkdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import type { ProcessRunner, ProcessRunnerInput, ProcessRunnerResult } from "../../process/types";
import { BinaryDownloadError, BinaryInstallError, type BinaryInstallParams } from "../manager";
import { downloadBinaryArchive, installBinaryArchive, verifyBinarySha256 } from "../installer";
import { getBinarySpec } from "../manifest";

const tmpRoot = join(import.meta.dir, "..", "__test_tmp__", "installer");
const encoder = new TextEncoder();

describe("binary installer", () => {
  beforeEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
    await mkdir(tmpRoot, { recursive: true });
  });

  afterEach(async () => {
    setFetchForTest(undefined);
    await rm(tmpRoot, { recursive: true, force: true });
  });

  test("downloads archives with fetch and reports HTTP failures as binary errors", async () => {
    const body = new Uint8Array([1, 2, 3]);
    setFetchForTest(async () => new Response(body));

    const archive = await downloadBinaryArchive({ spec: getBinarySpec("rg"), platform: platformFor("rg"), url: "https://example.test/rg.tar.gz" });

    expect(Array.from(archive)).toEqual([1, 2, 3]);

    setFetchForTest(async () => new Response("nope", { status: 503 }));
    const error = await expectRejects(() => downloadBinaryArchive({ spec: getBinarySpec("rg"), platform: platformFor("rg"), url: "https://example.test/rg.tar.gz" }));
    expect(error).toBeInstanceOf(BinaryDownloadError);
    expect(error.name).toBe("BinaryDownloadError");
  });

  test("verifies archive bytes against pinned SHA256", async () => {
    const archive = encoder.encode("known archive bytes");
    const sha256 = new Bun.CryptoHasher("sha256").update(archive).digest("hex");
    const platform = { ...platformFor("rg"), sha256 };

    await expect(verifyBinarySha256({ spec: getBinarySpec("rg"), platform, archive })).resolves.toBe(true);
    await expect(verifyBinarySha256({ spec: getBinarySpec("rg"), platform: { ...platform, sha256: "0".repeat(64) }, archive })).resolves.toBe(false);
  });

  test("extracts tar.gz archives, chmods the binary, and atomically moves it to cache", async () => {
    const runner = new ExtractingRunner();
    const params = installParams("rg", join(tmpRoot, "cache", "rg"));

    const installed = await installBinaryArchive(params, runner);

    expect(installed).toBe(params.cachePath);
    await expect(access(installed, constants.X_OK)).resolves.toBeNull();
    expect(runner.inputs[0]?.argv).toEqual(["tar", "-xzf", expect.any(String), "-C", expect.any(String)]);
    await expect(access(`${dirname(params.cachePath)}.tmp-leftover`)).rejects.toThrow();
  });

  test("extracts zip archives with unzip and installs ast-grep", async () => {
    const runner = new ExtractingRunner();
    const params = installParams("ast-grep", join(tmpRoot, "cache", "ast-grep"));

    const installed = await installBinaryArchive(params, runner);

    expect(installed).toBe(params.cachePath);
    await expect(access(installed, constants.X_OK)).resolves.toBeNull();
    expect(runner.inputs[0]?.argv).toEqual(["unzip", "-q", expect.any(String), "-d", expect.any(String)]);
  });

  test("replaces an existing cache binary only after successful extraction", async () => {
    const cachePath = join(tmpRoot, "cache", "rg");
    await mkdir(dirname(cachePath), { recursive: true });
    await Bun.write(cachePath, "old binary");
    const runner = new ExtractingRunner({ failExtraction: true });

    const error = await expectRejects(() => installBinaryArchive(installParams("rg", cachePath), runner));

    expect(error).toBeInstanceOf(BinaryInstallError);
    expect(await Bun.file(cachePath).text()).toBe("old binary");
  });
});

function platformFor(binaryId: "rg" | "ast-grep") {
  return getBinarySpec(binaryId).platforms["aarch64-apple-darwin"];
}

function installParams(binaryId: "rg" | "ast-grep", cachePath: string): BinaryInstallParams {
  const spec = getBinarySpec(binaryId);
  return {
    spec,
    platform: platformFor(binaryId),
    archive: encoder.encode(`${binaryId} archive`),
    cachePath,
  };
}

class ExtractingRunner implements ProcessRunner {
  readonly inputs: ProcessRunnerInput[] = [];

  constructor(private readonly options: { failExtraction?: boolean } = {}) {}

  async run(input: ProcessRunnerInput): Promise<ProcessRunnerResult> {
    this.inputs.push(input);
    const executable = input.argv[0];
    if ((executable === "tar" || executable === "unzip") && this.options.failExtraction) return processResult(input, "nonzero", "extract failed");
    if (executable === "tar") await this.extractTar(input);
    if (executable === "unzip") await this.extractZip(input);
    return processResult(input, "success");
  }

  private async extractTar(input: ProcessRunnerInput): Promise<void> {
    const extractRoot = String(input.argv[input.argv.indexOf("-C") + 1]);
    const target = join(extractRoot, platformFor("rg").binaryPathInArchive);
    await mkdir(dirname(target), { recursive: true });
    await Bun.write(target, "rg binary");
  }

  private async extractZip(input: ProcessRunnerInput): Promise<void> {
    const extractRoot = String(input.argv[input.argv.indexOf("-d") + 1]);
    const target = join(extractRoot, platformFor("ast-grep").binaryPathInArchive);
    await mkdir(dirname(target), { recursive: true });
    await Bun.write(target, "ast-grep binary");
  }
}

function processResult(input: ProcessRunnerInput, kind: "success" | "nonzero", stderr = ""): ProcessRunnerResult {
  const base = {
    argv: input.argv,
    cwd: input.cwd,
    startedAt: 1,
    finishedAt: 2,
    durationMs: 1,
    output: {
      stdout: "",
      stderr,
      combined: stderr,
      stdoutTruncated: false,
      stderrTruncated: false,
      combinedTruncated: false,
    },
  };
  return kind === "success" ? { ...base, kind, exitCode: 0 } : { ...base, kind, exitCode: 1 };
}

async function expectRejects(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }

  throw new Error("Expected promise to reject");
}

function setFetchForTest(fn: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | undefined): void {
  globalThis.fetch = (fn ?? originalFetch) as typeof fetch;
}

const originalFetch = globalThis.fetch;
