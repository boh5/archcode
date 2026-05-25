import { access } from "node:fs/promises";
import { constants } from "node:fs";
import type { FormatToolErrorOptions, ToolErrorKind } from "../tools/errors";
import { createProcessRunner } from "../process/runner";
import type { ProcessRunner, ProcessRunnerInput, ProcessRunnerResult } from "../process/types";
import { getBinaryCachePath, getCurrentTargetTriple, UnsupportedBinaryPlatformError } from "./cache";
import { getBinaryReleaseUrl, getBinarySpec } from "./manifest";
import type { BinaryPlatformSpec, BinarySpec, SupportedBinaryId, SupportedTargetTriple } from "./types";

/** Alternate binary names to try on PATH before falling back to download. */
const ALTERNATE_BINARY_NAMES: Record<SupportedBinaryId, readonly string[]> = {
  rg: [],
  "ast-grep": ["sg"],
};

/** Substrings expected in `--version` output for each binary. */
const VALIDATION_PATTERNS: Record<SupportedBinaryId, string> = {
  rg: "ripgrep",
  "ast-grep": "ast-grep",
};

export type BinaryManagerRunOptions = Omit<ProcessRunnerInput, "argv">;

export interface BinaryManagerSeam {
  readonly processRunner?: ProcessRunner;
  readonly platform?: string;
  readonly arch?: string;
  which(binaryName: string): Promise<string | undefined> | string | undefined;
  exists(path: string): Promise<boolean> | boolean;
  isExecutable(path: string): Promise<boolean> | boolean;
  download(params: BinaryDownloadParams): Promise<Uint8Array>;
  verifySha256(params: BinaryChecksumParams): Promise<boolean> | boolean;
  install(params: BinaryInstallParams): Promise<string>;
  validateBinary?(path: string, binaryId: SupportedBinaryId): Promise<boolean>;
}

export interface BinaryDownloadParams {
  readonly spec: BinarySpec;
  readonly platform: BinaryPlatformSpec;
  readonly url: string;
}

export interface BinaryChecksumParams {
  readonly spec: BinarySpec;
  readonly platform: BinaryPlatformSpec;
  readonly archive: Uint8Array;
}

export interface BinaryInstallParams {
  readonly spec: BinarySpec;
  readonly platform: BinaryPlatformSpec;
  readonly archive: Uint8Array;
  readonly cachePath: string;
}

export class BinaryNotFoundError extends Error {
  readonly binaryId: SupportedBinaryId;
  readonly binaryName: string;

  constructor(params: { binaryId: SupportedBinaryId; binaryName: string; message?: string; cause?: unknown }) {
    super(params.message ?? `Binary "${params.binaryId}" (${params.binaryName}) was not found on PATH or in the binary cache.`, { cause: params.cause });
    this.name = "BinaryNotFoundError";
    this.binaryId = params.binaryId;
    this.binaryName = params.binaryName;
  }

  toToolError(): FormatToolErrorOptions {
    return binaryToolError(this, "binary-not-found", { binaryId: this.binaryId, binaryName: this.binaryName });
  }
}

export class BinaryDownloadError extends Error {
  readonly binaryId: SupportedBinaryId;
  readonly url: string;

  constructor(params: { binaryId: SupportedBinaryId; url: string; message?: string; cause?: unknown }) {
    super(params.message ?? `Failed to download binary "${params.binaryId}" from ${params.url}.`, { cause: params.cause });
    this.name = "BinaryDownloadError";
    this.binaryId = params.binaryId;
    this.url = params.url;
  }

  toToolError(): FormatToolErrorOptions {
    return binaryToolError(this, "binary-download-failed", { binaryId: this.binaryId, url: this.url });
  }
}

export class BinaryChecksumMismatchError extends Error {
  readonly binaryId: SupportedBinaryId;
  readonly expectedSha256: string;

  constructor(params: { binaryId: SupportedBinaryId; expectedSha256: string; message?: string; cause?: unknown }) {
    super(params.message ?? `Downloaded binary "${params.binaryId}" did not match the expected SHA-256 checksum.`, { cause: params.cause });
    this.name = "BinaryChecksumMismatchError";
    this.binaryId = params.binaryId;
    this.expectedSha256 = params.expectedSha256;
  }

  toToolError(): FormatToolErrorOptions {
    return binaryToolError(this, "binary-checksum-mismatch", { binaryId: this.binaryId, expectedSha256: this.expectedSha256 });
  }
}

export class BinaryInstallError extends Error {
  readonly binaryId: SupportedBinaryId;
  readonly cachePath: string;

  constructor(params: { binaryId: SupportedBinaryId; cachePath: string; message?: string; cause?: unknown }) {
    super(params.message ?? `Failed to install binary "${params.binaryId}" into ${params.cachePath}.`, { cause: params.cause });
    this.name = "BinaryInstallError";
    this.binaryId = params.binaryId;
    this.cachePath = params.cachePath;
  }

  toToolError(): FormatToolErrorOptions {
    return binaryToolError(this, "binary-install-failed", { binaryId: this.binaryId, cachePath: this.cachePath });
  }
}

export class BinaryUnsupportedPlatformError extends Error {
  readonly binaryId: SupportedBinaryId;
  readonly platform: string;
  readonly arch: string;

  constructor(params: { binaryId: SupportedBinaryId; platform: string; arch: string; message?: string; cause?: unknown }) {
    super(params.message ?? `Binary "${params.binaryId}" is not supported on ${params.platform}/${params.arch}.`, { cause: params.cause });
    this.name = "BinaryUnsupportedPlatformError";
    this.binaryId = params.binaryId;
    this.platform = params.platform;
    this.arch = params.arch;
  }

  toToolError(): FormatToolErrorOptions {
    return binaryToolError(this, "binary-unsupported-platform", { binaryId: this.binaryId, platform: this.platform, arch: this.arch });
  }
}

export class BinaryValidationError extends Error {
  readonly binaryId: SupportedBinaryId;
  readonly path: string;

  constructor(params: { binaryId: SupportedBinaryId; path: string; message?: string; cause?: unknown }) {
    super(params.message ?? `Binary "${params.binaryId}" at "${params.path}" failed validation.`, { cause: params.cause });
    this.name = "BinaryValidationError";
    this.binaryId = params.binaryId;
    this.path = params.path;
  }

  toToolError(): FormatToolErrorOptions {
    return binaryToolError(this, "binary-validation-failed", { binaryId: this.binaryId, path: this.path });
  }
}

export class BinaryManager {
  private readonly seam: BinaryManagerSeam;
  private readonly installLocks = new Map<SupportedBinaryId, Promise<string>>();
  private readonly resolvedBinaryCache = new Map<SupportedBinaryId, string>();

  constructor(seam: BinaryManagerSeam = createDefaultBinaryManagerSeam()) {
    this.seam = seam;
  }

  async resolve(binaryId: SupportedBinaryId): Promise<string> {
    const cached = this.resolvedBinaryCache.get(binaryId);
    if (cached) return cached;

    const existingLock = this.installLocks.get(binaryId);
    if (existingLock) return existingLock;

    const promise = this.resolveUncached(binaryId);
    this.installLocks.set(binaryId, promise);

    try {
      const binaryPath = await promise;
      this.resolvedBinaryCache.set(binaryId, binaryPath);
      return binaryPath;
    } finally {
      this.installLocks.delete(binaryId);
    }
  }

  async run(binaryId: SupportedBinaryId, args: string[], options: BinaryManagerRunOptions = {}): Promise<ProcessRunnerResult> {
    const binaryPath = await this.resolve(binaryId);
    const runner = this.seam.processRunner ?? createProcessRunner();
    return runner.run({ ...options, argv: [binaryPath, ...args] });
  }

  private async resolveUncached(binaryId: SupportedBinaryId): Promise<string> {
    const spec = getBinarySpec(binaryId);
    const pathBinary = await this.resolveValidPathBinary(binaryId, spec);
    if (pathBinary) return pathBinary;

    const platform = this.resolvePlatform(binaryId, spec);
    const cachePath = getBinaryCachePath({ spec, targetTriple: platform.targetTriple });
    if ((await this.seam.exists(cachePath)) && (await this.seam.isExecutable(cachePath))) return cachePath;

    return this.downloadAndInstall(spec, platform, cachePath);
  }

  private async resolveValidPathBinary(binaryId: SupportedBinaryId, spec: BinarySpec): Promise<string | undefined> {
    const names = [spec.binaryName, ...ALTERNATE_BINARY_NAMES[binaryId]];
    for (const name of names) {
      const path = await this.seam.which(name);
      if (!path) continue;
      if (await this.validateBinary(path, binaryId)) {
        return path;
      }
    }
    return undefined;
  }

  private async validateBinary(path: string, binaryId: SupportedBinaryId): Promise<boolean> {
    if (this.seam.validateBinary) {
      return this.seam.validateBinary(path, binaryId);
    }
    return defaultValidateBinary(path, binaryId);
  }

  private resolvePlatform(binaryId: SupportedBinaryId, spec: BinarySpec): BinaryPlatformSpec {
    let targetTriple: SupportedTargetTriple;

    try {
      targetTriple = getCurrentTargetTriple({ platform: this.seam.platform, arch: this.seam.arch });
    } catch (error) {
      if (error instanceof UnsupportedBinaryPlatformError) {
        throw new BinaryUnsupportedPlatformError({ binaryId, platform: error.platform, arch: error.arch, cause: error });
      }
      throw error;
    }

    const platform = spec.platforms[targetTriple];
    if (!platform) {
      throw new BinaryUnsupportedPlatformError({
        binaryId,
        platform: this.seam.platform ?? process.platform,
        arch: this.seam.arch ?? process.arch,
      });
    }
    return platform;
  }

  private async downloadAndInstall(spec: BinarySpec, platform: BinaryPlatformSpec, cachePath: string): Promise<string> {
    const url = getBinaryReleaseUrl(spec, platform.assetName);
    let archive: Uint8Array;

    try {
      archive = await this.seam.download({ spec, platform, url });
    } catch (error) {
      if (error instanceof BinaryDownloadError) throw error;
      throw new BinaryDownloadError({ binaryId: spec.binaryId, url, cause: error });
    }

    const checksumOk = await this.seam.verifySha256({ spec, platform, archive });
    if (!checksumOk) {
      throw new BinaryChecksumMismatchError({ binaryId: spec.binaryId, expectedSha256: platform.sha256 });
    }

    try {
      return await this.seam.install({ spec, platform, archive, cachePath });
    } catch (error) {
      if (error instanceof BinaryInstallError) throw error;
      throw new BinaryInstallError({ binaryId: spec.binaryId, cachePath, cause: error });
    }
  }
}

let binaryManagerForTest: BinaryManager | undefined;

/** Default singleton instance — resolved paths are cached across calls. */
let defaultManager: BinaryManager | undefined;

export function createBinaryManager(seam?: BinaryManagerSeam): BinaryManager {
  if (seam) return new BinaryManager(seam);
  if (binaryManagerForTest) return binaryManagerForTest;
  if (!defaultManager) defaultManager = new BinaryManager();
  return defaultManager;
}

export function setBinaryManagerForTest(manager: BinaryManager | undefined): void {
  binaryManagerForTest = manager;
}

export function createDefaultBinaryManagerSeam(): BinaryManagerSeam {
  const processRunner = createProcessRunner();

  return {
    processRunner,
    platform: process.platform,
    arch: process.arch,
    which(binaryName) {
      return Bun.which(binaryName) ?? undefined;
    },
    async exists(path) {
      return access(path).then(() => true, () => false);
    },
    async isExecutable(path) {
      return access(path, constants.X_OK).then(() => true, () => false);
    },
    async download(params) {
      const { downloadBinaryArchive } = await import("./installer");
      return downloadBinaryArchive(params);
    },
    async verifySha256(params) {
      const { verifyBinarySha256 } = await import("./installer");
      return verifyBinarySha256(params);
    },
    async install(params) {
      const { installBinaryArchive } = await import("./installer");
      return installBinaryArchive(params, processRunner);
    },
    validateBinary: defaultValidateBinary,
  };
}

async function defaultValidateBinary(path: string, binaryId: SupportedBinaryId): Promise<boolean> {
  const pattern = VALIDATION_PATTERNS[binaryId];
  if (!pattern) return true;
  const runner = createProcessRunner();
  try {
    const result = await runner.run({ argv: [path, "--version"], timeoutMs: 5000, maxOutputBytes: 65536 });
    if (result.kind === "success") {
      const output = `${result.output.stdout} ${result.output.stderr}`.toLowerCase();
      return output.includes(pattern);
    }
    return false;
  } catch {
    return false;
  }
}

function binaryToolError(error: Error, kind: ToolErrorKind, details: Record<string, unknown>): FormatToolErrorOptions {
  return { error, kind, details };
}
