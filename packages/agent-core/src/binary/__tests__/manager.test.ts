import { afterEach, describe, expect, mock, test } from "bun:test";
import { codeFromKind, formatToolError, kindFromCode } from "../../tools/errors";
import { setProcessRunnerForTest } from "../../process/runner";
import type { ProcessRunner, ProcessRunnerInput, ProcessRunnerResult } from "../../process/types";
import {
  BinaryChecksumMismatchError,
  BinaryDownloadError,
  BinaryInstallError,
  BinaryManager,
  BinaryNotFoundError,
  BinaryUnsupportedPlatformError,
  BinaryValidationError,
  createBinaryManager,
  createDefaultBinaryManagerSeam,
  type BinaryDownloadParams,
  type BinaryInstallParams,
  type BinaryManagerSeam,
} from "../manager";

afterEach(() => setProcessRunnerForTest(undefined));

describe("BinaryManager", () => {
  test("dedupes concurrent resolves for the same binary to one install", async () => {
    const seam = createSeam({
      install: async (params) => {
        await sleep(10);
        return params.cachePath;
      },
    });
    const manager = new BinaryManager(seam);

    const [first, second] = await Promise.all([manager.resolve("rg"), manager.resolve("rg")]);

    expect(first).toBe(second);
    expect(first).toEndWith("/rg");
    expect(seam.calls.download).toBe(1);
    expect(seam.calls.verifySha256).toBe(1);
    expect(seam.calls.install).toBe(1);
  });

  test("returns resolved cache hits without redownloading", async () => {
    const seam = createSeam();
    const manager = new BinaryManager(seam);

    const first = await manager.resolve("rg");
    const second = await manager.resolve("rg");

    expect(second).toBe(first);
    expect(seam.calls.download).toBe(1);
    expect(seam.calls.install).toBe(1);
    expect(seam.calls.which).toBe(1);
  });

  test("returns PATH hit without download after validation", async () => {
    const seam = createSeam({ pathHits: { rg: "/usr/local/bin/rg" } });
    const manager = new BinaryManager(seam);

    expect(manager.resolve("rg")).resolves.toBe("/usr/local/bin/rg");
    expect(seam.calls.download).toBe(0);
    expect(seam.calls.install).toBe(0);
    expect(seam.calls.validateBinary).toBe(1);
  });

  test("falls through to cache when PATH binary fails validation", async () => {
    const seam = createSeam({ pathHits: { "ast-grep": "/broken/ast-grep" }, validateBinaryResults: [false, true], cacheHit: true });
    const manager = new BinaryManager(seam);

    const resolved = await manager.resolve("ast-grep");
    expect(resolved).toEndWith("/ast-grep");
    expect(seam.calls.validateBinary).toBe(2);
    expect(seam.calls.exists).toBeGreaterThanOrEqual(1);
  });

  test("tries alternate binary name sg when ast-grep not on PATH", async () => {
    const seam = createSeam({ pathHits: { sg: "/usr/local/bin/sg" } });
    const manager = new BinaryManager(seam);

    const resolved = await manager.resolve("ast-grep");
    expect(resolved).toBe("/usr/local/bin/sg");
    expect(seam.calls.which).toBeGreaterThanOrEqual(1);
  });

  test("falls through to download when all PATH binaries fail validation", async () => {
    let downloadedVersion: string | undefined;
    const seam = createSeam({
      pathHits: { "ast-grep": "/broken/ast-grep", sg: "/broken/sg" },
      validateBinaryResults: [false, false, true],
      download: async ({ spec }) => {
        downloadedVersion = spec.version;
        return new Uint8Array([1, 2, 3]);
      },
    });
    const manager = new BinaryManager(seam);

    const resolved = await manager.resolve("ast-grep");
    expect(resolved).toEndWith("/ast-grep");
    expect(seam.calls.download).toBe(1);
    expect(seam.calls.validateBinary).toBe(3);
    expect(downloadedVersion).toBe("0.42.3");
  });

  test("returns executable cache hit without download", async () => {
    const seam = createSeam({ cacheHit: true });
    const manager = new BinaryManager(seam);

    const resolved = await manager.resolve("rg");

    expect(resolved).toEndWith("/rg");
    expect(seam.calls.exists).toBe(1);
    expect(seam.calls.isExecutable).toBe(1);
    expect(seam.calls.validateBinary).toBe(1);
    expect(seam.calls.download).toBe(0);
  });

  test("rejects an executable ast-grep cache candidate without json stream capability", async () => {
    const seam = createSeam({ cacheHit: true, validateBinaryResults: [false, false] });
    const manager = new BinaryManager(seam);

    const error = await expectRejects(() => manager.resolve("ast-grep"));

    expect(error).toBeInstanceOf(BinaryValidationError);
    expect(seam.calls.validateBinary).toBe(2);
    expect(seam.calls.download).toBe(1);
    expect(seam.calls.install).toBe(1);
  });

  test("probes the exact ast-grep json stream capability instead of trusting version text", async () => {
    let argv: readonly string[] = [];
    let stdin: unknown;
    setProcessRunnerForTest(mock((cmd: readonly [string, ...string[]], options: { stdin?: unknown }) => {
      argv = cmd;
      stdin = options.stdin;
      return {
        stdout: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"text":"foo"}\n')); controller.close(); } }),
        stderr: new ReadableStream({ start(controller) { controller.close(); } }),
        exited: Promise.resolve(0),
        exitCode: 0,
        signalCode: undefined,
        kill: mock(() => undefined),
      };
    }));

    const valid = await createDefaultBinaryManagerSeam().validateBinary!("/bin/ast-grep", "ast-grep");

    expect(valid).toBe(true);
    expect(argv).toEqual(["/bin/ast-grep", "run", "--pattern", "foo", "--lang", "JavaScript", "--stdin", "--json=stream"]);
    expect(stdin).toBe("foo");
  });

  test("throws unsupported platform as typed binary error", async () => {
    const seam = createSeam({ platform: "win32", arch: "x64" });
    const manager = new BinaryManager(seam);

    const error = await expectRejects(() => manager.resolve("rg"));

    expect(error).toBeInstanceOf(BinaryUnsupportedPlatformError);
    expect(error.name).toBe("BinaryUnsupportedPlatformError");
    expect((error as BinaryUnsupportedPlatformError).binaryId).toBe("rg");
    expect((error as BinaryUnsupportedPlatformError).platform).toBe("win32");
    expect(formatToolError((error as BinaryUnsupportedPlatformError).toToolError()).kind).toBe("binary-unsupported-platform");
  });

  test("wraps download failures as typed binary errors", async () => {
    const seam = createSeam({ download: async () => { throw new Error("network down"); } });
    const manager = new BinaryManager(seam);

    const error = await expectRejects(() => manager.resolve("rg"));

    expect(error).toBeInstanceOf(BinaryDownloadError);
    expect(error.name).toBe("BinaryDownloadError");
    expect((error as BinaryDownloadError).binaryId).toBe("rg");
    expect((error as BinaryDownloadError).url).toContain("github.com/BurntSushi/ripgrep");
    expect(formatToolError((error as BinaryDownloadError).toToolError()).kind).toBe("binary-download-failed");
  });

  test("throws checksum mismatch as typed binary error", async () => {
    const seam = createSeam({ checksumOk: false });
    const manager = new BinaryManager(seam);

    const error = await expectRejects(() => manager.resolve("rg"));

    expect(error).toBeInstanceOf(BinaryChecksumMismatchError);
    expect(error.name).toBe("BinaryChecksumMismatchError");
    expect((error as BinaryChecksumMismatchError).expectedSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(formatToolError((error as BinaryChecksumMismatchError).toToolError()).kind).toBe("binary-checksum-mismatch");
    expect(seam.calls.install).toBe(0);
  });

  test("wraps install failures as typed binary errors", async () => {
    const seam = createSeam({ install: async () => { throw new Error("permission denied"); } });
    const manager = new BinaryManager(seam);

    const error = await expectRejects(() => manager.resolve("rg"));

    expect(error).toBeInstanceOf(BinaryInstallError);
    expect(error.name).toBe("BinaryInstallError");
    expect((error as BinaryInstallError).cachePath).toEndWith("/rg");
    expect(formatToolError((error as BinaryInstallError).toToolError()).kind).toBe("binary-install-failed");
  });

  test("run resolves the binary and delegates to injected process runner", async () => {
    const runner = new RecordingRunner();
    const seam = createSeam({ pathHits: { rg: "/bin/rg" }, processRunner: runner });
    const manager = new BinaryManager(seam);

    const result = await manager.run("rg", ["--version"], { cwd: "/workspace", env: { A: "B" } });

    expect(result.kind).toBe("success");
    expect(runner.inputs).toHaveLength(1);
    expect(runner.inputs[0]).toMatchObject({ argv: ["/bin/rg", "--version"], cwd: "/workspace", env: { A: "B" } });
  });

  test("createBinaryManager returns a singleton without seam", () => {
    const a = createBinaryManager();
    const b = createBinaryManager();
    expect(a).toBe(b);
  });

  test("createBinaryManager creates fresh instance with seam", () => {
    const seam = createSeam();
    const a = createBinaryManager(seam);
    const b = createBinaryManager(seam);
    expect(a).not.toBe(b);
  });
});

describe("binary tool error taxonomy", () => {
  test("maps binary errors and ast-grep errors without string-only checks", () => {
    expect(codeFromKind("binary-not-found")).toBe("TOOL_BINARY_NOT_FOUND");
    expect(codeFromKind("binary-download-failed")).toBe("TOOL_BINARY_DOWNLOAD_FAILED");
    expect(codeFromKind("binary-checksum-mismatch")).toBe("TOOL_BINARY_CHECKSUM_MISMATCH");
    expect(codeFromKind("binary-install-failed")).toBe("TOOL_BINARY_INSTALL_FAILED");
    expect(codeFromKind("binary-unsupported-platform")).toBe("TOOL_BINARY_UNSUPPORTED_PLATFORM");
    expect(codeFromKind("binary-validation-failed")).toBe("TOOL_BINARY_VALIDATION_FAILED");
    expect(codeFromKind("ast-grep-error")).toBe("TOOL_AST_GREP_ERROR");

    expect(kindFromCode("TOOL_BINARY_NOT_FOUND")).toBe("binary-not-found");
    expect(kindFromCode("TOOL_BINARY_DOWNLOAD_FAILED")).toBe("binary-download-failed");
    expect(kindFromCode("TOOL_BINARY_CHECKSUM_MISMATCH")).toBe("binary-checksum-mismatch");
    expect(kindFromCode("TOOL_BINARY_INSTALL_FAILED")).toBe("binary-install-failed");
    expect(kindFromCode("TOOL_BINARY_UNSUPPORTED_PLATFORM")).toBe("binary-unsupported-platform");
    expect(kindFromCode("TOOL_BINARY_VALIDATION_FAILED")).toBe("binary-validation-failed");
    expect(kindFromCode("TOOL_AST_GREP_ERROR")).toBe("ast-grep-error");

    const notFound = new BinaryNotFoundError({ binaryId: "rg", binaryName: "rg" });
    expect(formatToolError(notFound.toToolError())).toMatchObject({ kind: "binary-not-found", code: "TOOL_BINARY_NOT_FOUND" });

    const validationErr = new BinaryValidationError({ binaryId: "ast-grep", path: "/broken/ast-grep" });
    expect(formatToolError(validationErr.toToolError())).toMatchObject({ kind: "binary-validation-failed", code: "TOOL_BINARY_VALIDATION_FAILED" });
  });
});

interface TestSeam extends BinaryManagerSeam {
  readonly calls: Record<"which" | "exists" | "isExecutable" | "download" | "verifySha256" | "install" | "validateBinary", number>;
}

function createSeam(options: {
  pathHits?: Record<string, string | undefined>;
  cacheHit?: boolean;
  checksumOk?: boolean;
  platform?: string;
  arch?: string;
  processRunner?: ProcessRunner;
  download?: (params: BinaryDownloadParams) => Promise<Uint8Array>;
  install?: (params: BinaryInstallParams) => Promise<string>;
  validateBinaryResults?: boolean[];
} = {}): TestSeam {
  const calls = { which: 0, exists: 0, isExecutable: 0, download: 0, verifySha256: 0, install: 0, validateBinary: 0 };

  return {
    calls,
    processRunner: options.processRunner,
    platform: options.platform ?? "darwin",
    arch: options.arch ?? "arm64",
    which(binaryName) {
      calls.which++;
      return options.pathHits?.[binaryName];
    },
    exists() {
      calls.exists++;
      return options.cacheHit ?? false;
    },
    isExecutable() {
      calls.isExecutable++;
      return options.cacheHit ?? false;
    },
    async download(params) {
      calls.download++;
      return options.download ? options.download(params) : new Uint8Array([1, 2, 3]);
    },
    verifySha256() {
      calls.verifySha256++;
      return options.checksumOk ?? true;
    },
    async install(params) {
      calls.install++;
      return options.install ? options.install(params) : params.cachePath;
    },
    async validateBinary(_path: string, _binaryId: string) {
      calls.validateBinary++;
      return options.validateBinaryResults?.[calls.validateBinary - 1] ?? true;
    },
  };
}

class RecordingRunner implements ProcessRunner {
  readonly inputs: ProcessRunnerInput[] = [];

  async run(input: ProcessRunnerInput): Promise<ProcessRunnerResult> {
    this.inputs.push(input);
    return {
      kind: "success",
      exitCode: 0,
      argv: input.argv,
      cwd: input.cwd,
      startedAt: 1,
      finishedAt: 2,
      durationMs: 1,
      output: {
        stdout: "",
        stderr: "",
        combined: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        combinedTruncated: false,
        stdoutBytes: 0,
        stderrBytes: 0,
        sinkStatus: "unused",
      },
    };
  }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
