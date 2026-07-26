import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
  INSTALL_RECEIPT_FILE_NAME,
  UPDATE_PENDING_BINARY_FILE_NAME,
  UPDATE_TRANSACTION_FILE_NAME,
} from "./constants";
import { syncDirectory, writeJsonAtomic } from "./atomic-file";
import { UpdateError } from "./errors";
import { sha256File } from "./hash";
import {
  parseInstallReceipt,
  writeInstallReceipt,
  type InstallReceipt,
} from "./receipt";

const MAX_TRANSACTION_BYTES = 128 * 1024;
const transactionEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  from: z.unknown(),
  to: z.unknown(),
}).strict();

export interface ManagedInstallTransactionInput {
  current: {
    executablePath: string;
    receiptPath: string;
    receipt: InstallReceipt;
  };
  stagedBinaryPath: string;
  receipt: InstallReceipt;
}

export async function replaceManagedInstall(
  input: ManagedInstallTransactionInput,
): Promise<void> {
  const directory = dirname(input.current.executablePath);
  const binaryName = basename(input.current.executablePath);
  const suffix = `${process.pid}.${randomUUID()}`;
  const pendingBinary = join(directory, UPDATE_PENDING_BINARY_FILE_NAME);
  const journalPath = join(directory, UPDATE_TRANSACTION_FILE_NAME);
  const previousArchive = join(directory, `${binaryName}.previous.tar`);
  const stagedPreviousDirectory = join(directory, `.archcode-previous.${suffix}`);
  const stagedPreviousArchive = join(directory, `.${binaryName}.${suffix}.previous.tar`);

  try {
    await rm(pendingBinary, { force: true });
    await mkdir(stagedPreviousDirectory, { mode: 0o700 });
    const stagedPreviousBinary = join(stagedPreviousDirectory, binaryName);
    const stagedPreviousReceipt = join(
      stagedPreviousDirectory,
      INSTALL_RECEIPT_FILE_NAME,
    );
    await copyFile(input.current.executablePath, stagedPreviousBinary);
    await chmod(stagedPreviousBinary, 0o755);
    await syncFile(stagedPreviousBinary);
    await copyFile(input.current.receiptPath, stagedPreviousReceipt);
    await chmod(stagedPreviousReceipt, 0o600);
    await syncFile(stagedPreviousReceipt);
    await createBackupArchive({
      outputPath: stagedPreviousArchive,
      directory: stagedPreviousDirectory,
      binaryName,
    });
    await syncFile(stagedPreviousArchive);
    await rename(stagedPreviousArchive, previousArchive);

    await copyFile(input.stagedBinaryPath, pendingBinary);
    await chmod(pendingBinary, 0o755);
    await syncFile(pendingBinary);
    await writeJsonAtomic(journalPath, {
      schemaVersion: 1,
      from: input.current.receipt,
      to: input.receipt,
    });

    try {
      await rename(pendingBinary, input.current.executablePath);
      await syncDirectory(directory);
      await writeInstallReceipt(input.current.receiptPath, input.receipt);
      await finishTransaction(directory, journalPath, pendingBinary);
    } catch (error) {
      let recovery: InterruptedInstallRecovery;
      try {
        recovery = await recoverInterruptedInstall(input.current.executablePath);
      } catch (recoveryError) {
        throw new UpdateError(
          "UPDATE_INSTALL_FAILED",
          "ArchCode could not recover the interrupted executable transaction",
          { cause: new AggregateError([error, recoveryError]) },
        );
      }
      if (recovery === "completed") return;
      throw error;
    }
  } finally {
    await rm(stagedPreviousDirectory, { recursive: true, force: true })
      .catch(() => undefined);
    await rm(stagedPreviousArchive, { force: true }).catch(() => undefined);
  }
}

export type InterruptedInstallRecovery =
  | "none"
  | "rolled_back"
  | "completed";

/**
 * Recovers only a journal created in the executable's own directory. The
 * current binary digest is the commit marker: old digest rolls back, new
 * digest completes the matching receipt, and every other state fails closed.
 */
export async function recoverInterruptedInstall(
  executablePath: string,
): Promise<InterruptedInstallRecovery> {
  const normalizedExecutablePath = await realpath(executablePath);
  const directory = dirname(normalizedExecutablePath);
  const journalPath = join(directory, UPDATE_TRANSACTION_FILE_NAME);
  const pendingBinary = join(directory, UPDATE_PENDING_BINARY_FILE_NAME);
  let raw: unknown;
  try {
    const info = await stat(journalPath);
    if (!info.isFile() || info.size > MAX_TRANSACTION_BYTES) {
      throw new Error("Update transaction journal has an invalid size");
    }
    raw = JSON.parse(await readFile(journalPath, "utf8")) as unknown;
  } catch (error) {
    if (isMissingFileError(error)) return "none";
    throw new UpdateError(
      "UPDATE_INSTALL_FAILED",
      "The interrupted ArchCode update journal is invalid",
      { cause: error },
    );
  }

  const envelope = transactionEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    throw new UpdateError(
      "UPDATE_INSTALL_FAILED",
      "The interrupted ArchCode update journal is invalid",
      { cause: envelope.error },
    );
  }
  const from = parseInstallReceipt(envelope.data.from);
  const to = parseInstallReceipt(envelope.data.to);
  if (
    from.installPath !== normalizedExecutablePath
    || to.installPath !== normalizedExecutablePath
    || from.platform !== to.platform
    || from.architecture !== to.architecture
  ) {
    throw new UpdateError(
      "UPDATE_INSTALL_FAILED",
      "The interrupted update journal does not match this executable",
    );
  }

  const currentDigest = await sha256File(normalizedExecutablePath);
  const receiptPath = join(directory, INSTALL_RECEIPT_FILE_NAME);
  if (currentDigest === to.binarySha256) {
    await writeInstallReceipt(receiptPath, to);
    await finishTransaction(directory, journalPath, pendingBinary);
    return "completed";
  }
  if (currentDigest === from.binarySha256) {
    await writeInstallReceipt(receiptPath, from);
    await finishTransaction(directory, journalPath, pendingBinary);
    return "rolled_back";
  }
  throw new UpdateError(
    "UPDATE_INSTALL_FAILED",
    "The installed executable matches neither side of the interrupted update transaction",
  );
}

async function finishTransaction(
  directory: string,
  journalPath: string,
  pendingBinary: string,
): Promise<void> {
  await rm(pendingBinary, { force: true });
  await rm(journalPath, { force: true });
  await syncDirectory(directory);
}

async function syncFile(path: string): Promise<void> {
  const file = await open(path, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

async function createBackupArchive(input: {
  outputPath: string;
  directory: string;
  binaryName: string;
}): Promise<void> {
  const child = Bun.spawn([
    "tar",
    "-cf",
    input.outputPath,
    "-C",
    input.directory,
    input.binaryName,
    INSTALL_RECEIPT_FILE_NAME,
  ], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new UpdateError(
      "UPDATE_INSTALL_FAILED",
      `ArchCode could not create the previous-install backup: ${stderr.trim()}`,
    );
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}
