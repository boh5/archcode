import { afterAll, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UPDATE_PENDING_BINARY_FILE_NAME,
  UPDATE_TRANSACTION_FILE_NAME,
} from "./constants";
import {
  createInstallReceipt,
  installReceiptPath,
  inspectManagedInstall,
  writeInstallReceipt,
} from "./receipt";
import { recoverInterruptedInstall } from "./transaction";
import { silentLogger } from "@archcode/agent-core";
import { UpdateService } from "./service";

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe("managed install transaction recovery", () => {
  test("completes the new receipt after a crash committed the new binary", async () => {
    const fixture = await createFixture();
    await Bun.write(fixture.executablePath, await Bun.file(fixture.newBinary).bytes());
    await chmod(fixture.executablePath, 0o755);
    await writeJournal(fixture);

    const service = new UpdateService({
      currentVersion: "1.2.4",
      executablePath: fixture.executablePath,
      restartSupported: false,
      autoCheckEnabled: false,
      homeDir: fixture.directory,
      logger: silentLogger,
    });
    await service.start();
    await service.stop();
    const inspection = await inspectManagedInstall(fixture.executablePath, {
      verifyBinary: true,
    });
    expect(inspection).toMatchObject({
      managed: true,
      receipt: { version: "1.2.4" },
    });
    expect(await Bun.file(fixture.journalPath).exists()).toBe(false);
  });

  test("restores the old receipt when a crash happened before binary commit", async () => {
    const fixture = await createFixture();
    await writeInstallReceipt(
      installReceiptPath(fixture.executablePath),
      fixture.to,
    );
    await Bun.write(
      join(fixture.directory, UPDATE_PENDING_BINARY_FILE_NAME),
      await Bun.file(fixture.newBinary).bytes(),
    );
    await writeJournal(fixture);

    expect(await recoverInterruptedInstall(fixture.executablePath)).toBe("rolled_back");
    const inspection = await inspectManagedInstall(fixture.executablePath, {
      verifyBinary: true,
    });
    expect(inspection).toMatchObject({
      managed: true,
      receipt: { version: "1.2.3" },
    });
    expect(
      await Bun.file(join(fixture.directory, UPDATE_PENDING_BINARY_FILE_NAME)).exists(),
    ).toBe(false);
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "archcode-update-transaction-"));
  roots.push(root);
  const directory = join(root, "bin");
  await mkdir(directory);
  const executablePath = join(directory, "archcode");
  const newBinary = join(root, "archcode-new");
  await writeVersionExecutable(executablePath, "1.2.3");
  await writeVersionExecutable(newBinary, "1.2.4");
  const from = await createInstallReceipt({
    binaryPath: executablePath,
    installPath: executablePath,
    version: "1.2.3",
    installedAt: 1,
  });
  const to = await createInstallReceipt({
    binaryPath: newBinary,
    installPath: executablePath,
    version: "1.2.4",
    installedAt: 2,
  });
  await writeInstallReceipt(installReceiptPath(executablePath), from);
  return {
    directory,
    executablePath,
    newBinary,
    from,
    to,
    journalPath: join(directory, UPDATE_TRANSACTION_FILE_NAME),
  };
}

async function writeJournal(fixture: Awaited<ReturnType<typeof createFixture>>) {
  await Bun.write(fixture.journalPath, `${JSON.stringify({
    schemaVersion: 1,
    from: fixture.from,
    to: fixture.to,
  })}\n`);
}

async function writeVersionExecutable(path: string, version: string): Promise<void> {
  await Bun.write(path, [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then",
    `  printf 'archcode ${version}\\n'`,
    "  exit 0",
    "fi",
    "exit 1",
    "",
  ].join("\n"));
  await chmod(path, 0o755);
}
