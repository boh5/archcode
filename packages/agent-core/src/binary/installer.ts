import { dirname, join } from "node:path";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { createProcessRunner } from "../process/runner";
import type { ProcessRunner, ProcessRunnerResult } from "../process/types";
import type { BinaryInstallParams } from "./manager";
import { BinaryDownloadError, BinaryInstallError } from "./manager";
import type { BinaryChecksumParams, BinaryDownloadParams } from "./manager";

export async function downloadBinaryArchive(params: BinaryDownloadParams): Promise<Uint8Array> {
  let response: Response;

  try {
    response = await fetch(params.url);
  } catch (error) {
    throw new BinaryDownloadError({ binaryId: params.spec.binaryId, url: params.url, cause: error });
  }

  if (!response.ok) {
    throw new BinaryDownloadError({
      binaryId: params.spec.binaryId,
      url: params.url,
      message: `Failed to download binary "${params.spec.binaryId}" from ${params.url}: HTTP ${response.status}.`,
    });
  }

  return new Uint8Array(await response.arrayBuffer());
}

export async function verifyBinarySha256(params: BinaryChecksumParams): Promise<boolean> {
  const digest = new Bun.CryptoHasher("sha256").update(params.archive).digest("hex");
  return digest === params.platform.sha256;
}

export async function installBinaryArchive(params: BinaryInstallParams, runner: ProcessRunner = createProcessRunner()): Promise<string> {
  const installRoot = dirname(params.cachePath);
  const tempRoot = `${installRoot}.tmp-${crypto.randomUUID()}`;
  const archivePath = join(tempRoot, params.platform.assetName);
  const extractRoot = join(tempRoot, "extract");

  try {
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(extractRoot, { recursive: true });
    await Bun.write(archivePath, params.archive);

    await extractArchive({ params, archivePath, extractRoot, runner });

    const extractedBinaryPath = join(extractRoot, params.platform.binaryPathInArchive);
    if (process.platform !== "win32") await chmod(extractedBinaryPath, 0o755);
    await removeMacosQuarantine(extractedBinaryPath, runner);

    await rm(installRoot, { recursive: true, force: true });
    await mkdir(installRoot, { recursive: true });
    await rename(extractedBinaryPath, params.cachePath);
    await rm(tempRoot, { recursive: true, force: true });

    return params.cachePath;
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof BinaryInstallError) throw error;
    throw new BinaryInstallError({ binaryId: params.spec.binaryId, cachePath: params.cachePath, cause: error });
  }
}

async function extractArchive(input: {
  readonly params: BinaryInstallParams;
  readonly archivePath: string;
  readonly extractRoot: string;
  readonly runner: ProcessRunner;
}): Promise<void> {
  const result = input.params.platform.archiveFormat === "tar.gz"
    ? await input.runner.run({ argv: ["tar", "-xzf", input.archivePath, "-C", input.extractRoot], maxOutputBytes: 64_000 })
    : await input.runner.run({ argv: ["unzip", "-q", input.archivePath, "-d", input.extractRoot], maxOutputBytes: 64_000 });

  assertProcessSuccess({
    result,
    binaryId: input.params.spec.binaryId,
    cachePath: input.params.cachePath,
    action: `extract ${input.params.platform.archiveFormat} archive`,
  });
}

async function removeMacosQuarantine(binaryPath: string, runner: ProcessRunner): Promise<void> {
  if (process.platform !== "darwin") return;
  await runner.run({ argv: ["xattr", "-d", "com.apple.quarantine", binaryPath], maxOutputBytes: 16_000 }).catch(() => undefined);
}

function assertProcessSuccess(params: {
  readonly result: ProcessRunnerResult;
  readonly binaryId: BinaryInstallParams["spec"]["binaryId"];
  readonly cachePath: string;
  readonly action: string;
}): void {
  if (params.result.kind === "success") return;

  throw new BinaryInstallError({
    binaryId: params.binaryId,
    cachePath: params.cachePath,
    message: `Failed to ${params.action} for binary "${params.binaryId}": ${processResultDetails(params.result)}`,
  });
}

function processResultDetails(result: ProcessRunnerResult): string {
  if (result.kind === "spawn-failure") return result.error.message;
  const output = result.output.stderr || result.output.stdout || result.output.combined;
  if (output) return output;
  if (result.kind === "nonzero") return `exit code ${result.exitCode}`;
  if (result.kind === "timeout") return `timed out after ${result.timeoutMs}ms`;
  if (result.kind === "aborted") return `aborted${result.reason ? `: ${result.reason}` : ""}`;
  if (result.kind === "signal") return `terminated by signal ${result.signal}`;
  return "completed successfully";
}
