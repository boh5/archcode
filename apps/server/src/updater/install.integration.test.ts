import { afterAll, describe, expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentReleasePlatform } from "./platform";
import {
  createInstallReceipt,
  installReceiptPath,
  writeInstallReceipt,
} from "./receipt";
import { sha256File } from "./hash";
import { installVerifiedRelease } from "./install";
import type {
  ReleaseClientPort,
  VerifiedRelease,
} from "./release-client";
import { installManagedCandidate } from "./managed-installer";
import { inspectManagedInstall } from "./receipt";

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe("direct update installation", () => {
  test("the official installer commits one managed binary and receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "archcode-managed-install-"));
    roots.push(root);
    const installDirectory = join(root, "bin");
    await mkdir(installDirectory);
    const candidatePath = join(root, "candidate");
    const executablePath = join(installDirectory, "archcode");
    await writeVersionExecutable(candidatePath, "1.2.3");

    await installManagedCandidate({
      candidatePath,
      installPath: executablePath,
      version: "1.2.3",
    });

    expect(await inspectManagedInstall(executablePath, {
      verifyBinary: true,
    })).toMatchObject({
      managed: true,
      receipt: { version: "1.2.3" },
    });
  });

  test("verifies, backs up, and atomically replaces an installer-managed executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "archcode-update-install-"));
    roots.push(root);
    const installDirectory = join(root, "bin");
    await mkdir(installDirectory);
    const executablePath = join(installDirectory, "archcode");
    await writeVersionExecutable(executablePath, "1.2.3");
    const currentReceipt = await createInstallReceipt({
      binaryPath: executablePath,
      installPath: executablePath,
      version: "1.2.3",
      installedAt: 1,
    });
    await writeInstallReceipt(
      installReceiptPath(executablePath),
      currentReceipt,
    );

    const packageDirectory = join(root, "package");
    await mkdir(packageDirectory);
    const packagedBinary = join(packageDirectory, "archcode");
    await writeVersionExecutable(packagedBinary, "1.2.4");
    const archivePath = join(root, "archcode.tar.gz");
    await run(["tar", "-czf", archivePath, "-C", packageDirectory, "archcode"]);
    const archive = Bun.file(archivePath);
    const binary = Bun.file(packagedBinary);
    const platform = currentReleasePlatform();
    const release: VerifiedRelease = {
      releaseUrl: "https://github.com/boh5/archcode/releases/tag/v1.2.4",
      manifest: {
        schemaVersion: 3,
        name: "archcode",
        version: "1.2.4",
        tag: "v1.2.4",
        minimumDirectUpdateFrom: "1.2.3",
        assets: [
          {
            name: "archcode-test-v1.2.4.tar.gz",
            kind: "archive",
            platform: platform.platform,
            architecture: platform.architecture,
            archiveFormat: "tar.gz",
            size: archive.size,
            sha256: await sha256File(archivePath),
            binary: {
              name: "archcode",
              size: binary.size,
              sha256: await sha256File(packagedBinary),
            },
          },
          {
            name: "install.sh",
            kind: "installer",
            size: 1,
            sha256: "0".repeat(64),
          },
        ],
      },
    };
    const releaseClient: ReleaseClientPort = {
      fetchLatest: async () => release,
      downloadArchive: async ({ destinationPath, onProgress }) => {
        await copyFile(archivePath, destinationPath);
        onProgress?.(archive.size, archive.size);
      },
    };
    const phases: string[] = [];

    const installedReceipt = await installVerifiedRelease({
      currentVersion: "1.2.3",
      executablePath,
      release,
      releaseClient,
      installedAt: 2,
      onProgress: (phase) => phases.push(phase),
    });

    expect(installedReceipt.version).toBe("1.2.4");
    expect((await run([executablePath, "--version"])).stdout).toBe(
      "archcode 1.2.4\n",
    );
    const backupDirectory = join(root, "backup");
    await mkdir(backupDirectory);
    await run([
      "tar",
      "-xf",
      join(installDirectory, "archcode.previous.tar"),
      "-C",
      backupDirectory,
    ]);
    expect((await run([
      join(backupDirectory, "archcode"),
      "--version",
    ])).stdout).toBe("archcode 1.2.3\n");
    expect(
      await Bun.file(join(
        backupDirectory,
        ".archcode-install-receipt.json",
      )).json(),
    ).toMatchObject({ version: "1.2.3" });
    expect(phases).toEqual([
      "downloading",
      "downloading",
      "verifying",
      "installing",
    ]);
  });

  test("rejects an archive that expands beyond the signed binary size", async () => {
    const root = await mkdtemp(join(tmpdir(), "archcode-update-oversize-"));
    roots.push(root);
    const installDirectory = join(root, "bin");
    await mkdir(installDirectory);
    const executablePath = join(installDirectory, "archcode");
    await writeVersionExecutable(executablePath, "1.2.3");
    await writeInstallReceipt(
      installReceiptPath(executablePath),
      await createInstallReceipt({
        binaryPath: executablePath,
        installPath: executablePath,
        version: "1.2.3",
        installedAt: 1,
      }),
    );

    const packageDirectory = join(root, "package");
    await mkdir(packageDirectory);
    const packagedBinary = join(packageDirectory, "archcode");
    await writeVersionExecutable(packagedBinary, "1.2.4");
    const archivePath = join(root, "archcode.tar.gz");
    await run(["tar", "-czf", archivePath, "-C", packageDirectory, "archcode"]);
    const archive = Bun.file(archivePath);
    const binary = Bun.file(packagedBinary);
    const platform = currentReleasePlatform();
    const release: VerifiedRelease = {
      releaseUrl: "https://github.com/boh5/archcode/releases/tag/v1.2.4",
      manifest: {
        schemaVersion: 3,
        name: "archcode",
        version: "1.2.4",
        tag: "v1.2.4",
        minimumDirectUpdateFrom: "1.2.3",
        assets: [
          {
            name: "archcode-test-v1.2.4.tar.gz",
            kind: "archive",
            platform: platform.platform,
            architecture: platform.architecture,
            archiveFormat: "tar.gz",
            size: archive.size,
            sha256: await sha256File(archivePath),
            binary: {
              name: "archcode",
              size: binary.size - 1,
              sha256: await sha256File(packagedBinary),
            },
          },
          {
            name: "install.sh",
            kind: "installer",
            size: 1,
            sha256: "0".repeat(64),
          },
        ],
      },
    };
    const releaseClient: ReleaseClientPort = {
      fetchLatest: async () => release,
      downloadArchive: async ({ destinationPath }) => {
        await copyFile(archivePath, destinationPath);
      },
    };

    await expect(installVerifiedRelease({
      currentVersion: "1.2.3",
      executablePath,
      release,
      releaseClient,
      installedAt: 2,
    })).rejects.toMatchObject({ code: "UPDATE_ARCHIVE_INVALID" });
    expect((await run([executablePath, "--version"])).stdout).toBe(
      "archcode 1.2.3\n",
    );
  });
});

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

async function run(command: string[]): Promise<{
  exitCode: number;
  stderr: string;
  stdout: string;
}> {
  const child = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return { exitCode, stderr, stdout };
}
