import {
  chmod,
  copyFile,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  UPDATE_PENDING_BINARY_FILE_NAME,
  UPDATE_TRANSACTION_FILE_NAME,
} from "./constants";
import { syncDirectory } from "./atomic-file";
import { UpdateError } from "./errors";
import { acquireUpdateLock } from "./lock";
import {
  createInstallReceipt,
  inspectManagedInstall,
  installReceiptPath,
  writeInstallReceipt,
  type InstallReceipt,
} from "./receipt";
import {
  recoverInterruptedInstall,
  replaceManagedInstall,
} from "./transaction";

/**
 * The official installer delegates its only write boundary to the packaged
 * candidate so installer bootstrap and later direct updates share one lock and
 * one managed-install transaction.
 */
export async function installManagedCandidate(input: {
  candidatePath: string;
  installPath: string;
  version: string;
}): Promise<InstallReceipt> {
  const receipt = await createInstallReceipt({
    binaryPath: input.candidatePath,
    installPath: input.installPath,
    version: input.version,
  });
  const executablePath = receipt.installPath;
  const lock = await acquireUpdateLock(executablePath);
  try {
    if (
      await Bun.file(join(
        dirname(executablePath),
        UPDATE_TRANSACTION_FILE_NAME,
      )).exists()
    ) {
      await recoverInterruptedInstall(executablePath);
    }
    const current = await inspectManagedInstall(executablePath, {
      verifyBinary: true,
    });
    if (current.managed) {
      await replaceManagedInstall({
        current,
        stagedBinaryPath: input.candidatePath,
        receipt,
      });
      return receipt;
    }

    const directory = dirname(executablePath);
    const pendingPath = join(directory, UPDATE_PENDING_BINARY_FILE_NAME);
    await rm(pendingPath, { force: true });
    await copyFile(input.candidatePath, pendingPath);
    await chmod(pendingPath, 0o755);
    const pending = await open(pendingPath, "r");
    try {
      await pending.sync();
    } finally {
      await pending.close();
    }
    lock.assertOwned();
    await rename(pendingPath, executablePath);
    await syncDirectory(directory);
    await writeInstallReceipt(installReceiptPath(executablePath), receipt);
    return receipt;
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    throw new UpdateError(
      "UPDATE_INSTALL_FAILED",
      "The official installer could not commit the managed ArchCode installation",
      { cause: error },
    );
  } finally {
    await lock.release();
  }
}
