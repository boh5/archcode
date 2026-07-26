import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInstallReceipt,
  inspectManagedInstall,
  installReceiptPath,
  writeInstallReceipt,
} from "./receipt";

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe("official install receipt", () => {
  test("binds direct-update authority to the exact installed executable digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "archcode-receipt-"));
    roots.push(root);
    const executablePath = join(root, "archcode");
    await Bun.write(executablePath, "signed executable bytes");
    const receipt = await createInstallReceipt({
      binaryPath: executablePath,
      installPath: executablePath,
      version: "1.2.3",
      installedAt: 123,
    });
    await writeInstallReceipt(installReceiptPath(executablePath), receipt);

    await expect(inspectManagedInstall(executablePath, {
      verifyBinary: true,
    })).resolves.toMatchObject({
      managed: true,
      receipt: {
        version: "1.2.3",
        installedAt: 123,
      },
    });

    await Bun.write(executablePath, "locally replaced bytes");
    await expect(inspectManagedInstall(executablePath, {
      verifyBinary: true,
    })).resolves.toEqual({
      managed: false,
      reason: "receipt_mismatch",
    });
  });
});
