import {
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  INSTALL_RECEIPT_FILE_NAME,
} from "./constants";
import { UpdateError } from "./errors";
import { sha256File } from "./hash";
import { parseCanonicalVersion } from "./manifest";
import { currentReleasePlatform } from "./platform";
import { writeJsonAtomic } from "./atomic-file";

const MAX_RECEIPT_BYTES = 64 * 1024;

const installReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.literal("archcode"),
  managedBy: z.literal("archcode-installer"),
  installPath: z.string().min(1),
  version: z.string().refine(
    (value) => parseCanonicalVersion(value) !== undefined,
    "Expected a canonical SemVer version",
  ),
  platform: z.enum(["macOS", "Linux"]),
  architecture: z.enum(["arm64", "x64"]),
  binarySha256: z.string().regex(/^[0-9a-f]{64}$/),
  installedAt: z.number().int().nonnegative(),
}).strict();

export type InstallReceipt = z.infer<typeof installReceiptSchema>;

export function parseInstallReceipt(value: unknown): InstallReceipt {
  const parsed = installReceiptSchema.safeParse(value);
  if (!parsed.success) {
    throw new UpdateError(
      "UPDATE_RECEIPT_MISMATCH",
      "The ArchCode installation receipt is invalid",
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

export type ManagedInstallInspection =
  | {
    managed: true;
    executablePath: string;
    receiptPath: string;
    receipt: InstallReceipt;
  }
  | {
    managed: false;
    reason: "missing_receipt" | "invalid_receipt" | "receipt_mismatch";
  };

export function installReceiptPath(executablePath: string): string {
  return join(dirname(executablePath), INSTALL_RECEIPT_FILE_NAME);
}

export async function inspectManagedInstall(
  executablePath: string,
  options: { verifyBinary?: boolean } = {},
): Promise<ManagedInstallInspection> {
  let normalizedExecutable: string;
  try {
    normalizedExecutable = await realpath(executablePath);
  } catch {
    return { managed: false, reason: "receipt_mismatch" };
  }
  const receiptPath = installReceiptPath(normalizedExecutable);
  let raw: unknown;
  try {
    const info = await stat(receiptPath);
    if (!info.isFile() || info.size > MAX_RECEIPT_BYTES) {
      return { managed: false, reason: "invalid_receipt" };
    }
    raw = JSON.parse(await readFile(receiptPath, "utf8")) as unknown;
  } catch (error) {
    if (isMissingFileError(error)) return { managed: false, reason: "missing_receipt" };
    return { managed: false, reason: "invalid_receipt" };
  }
  const parsed = installReceiptSchema.safeParse(raw);
  if (!parsed.success) return { managed: false, reason: "invalid_receipt" };

  let normalizedInstallPath: string;
  try {
    normalizedInstallPath = await normalizePlannedInstallPath(parsed.data.installPath);
  } catch {
    return { managed: false, reason: "receipt_mismatch" };
  }
  const platform = currentReleasePlatform();
  if (
    normalizedInstallPath !== normalizedExecutable
    || parsed.data.platform !== platform.platform
    || parsed.data.architecture !== platform.architecture
  ) {
    return { managed: false, reason: "receipt_mismatch" };
  }
  if (
    options.verifyBinary === true
    && await sha256File(normalizedExecutable) !== parsed.data.binarySha256
  ) {
    return { managed: false, reason: "receipt_mismatch" };
  }
  return {
    managed: true,
    executablePath: normalizedExecutable,
    receiptPath,
    receipt: parsed.data,
  };
}

export async function requireManagedInstall(
  executablePath: string,
): Promise<Extract<ManagedInstallInspection, { managed: true }>> {
  const inspection = await inspectManagedInstall(executablePath, {
    verifyBinary: true,
  });
  if (inspection.managed) return inspection;
  throw new UpdateError(
    inspection.reason === "missing_receipt"
      ? "UPDATE_UNMANAGED_INSTALL"
      : "UPDATE_RECEIPT_MISMATCH",
    inspection.reason === "missing_receipt"
      ? "Direct update requires an ArchCode installation created by the official installer"
      : "The ArchCode installation receipt does not match the installed executable",
  );
}

export async function createInstallReceipt(input: {
  binaryPath: string;
  installPath: string;
  version: string;
  installedAt?: number;
}): Promise<InstallReceipt> {
  const version = parseCanonicalVersion(input.version);
  if (version === undefined) {
    throw new UpdateError(
      "UPDATE_RECEIPT_MISMATCH",
      "Cannot create an install receipt for a non-canonical version",
    );
  }
  const info = await stat(input.binaryPath);
  if (!info.isFile()) {
    throw new UpdateError(
      "UPDATE_RECEIPT_MISMATCH",
      "Cannot create an install receipt for a non-file executable",
    );
  }
  const platform = currentReleasePlatform();
  return {
    schemaVersion: 1,
    name: "archcode",
    managedBy: "archcode-installer",
    installPath: await normalizePlannedInstallPath(input.installPath),
    version,
    platform: platform.platform,
    architecture: platform.architecture,
    binarySha256: await sha256File(input.binaryPath),
    installedAt: input.installedAt ?? Date.now(),
  };
}

export async function writeInstallReceipt(
  outputPath: string,
  receipt: InstallReceipt,
): Promise<void> {
  await writeJsonAtomic(outputPath, installReceiptSchema.parse(receipt));
}

async function normalizePlannedInstallPath(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Install path must be absolute");
  const directory = await realpath(dirname(resolve(path)));
  return join(directory, basename(path));
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}
