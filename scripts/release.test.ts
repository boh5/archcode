import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertReleaseReadyToPublish,
  assertWorkspacePackageVersions,
  classifyExistingRelease,
  compareReleaseAssetDirectories,
  extractReleaseNotes,
  isPrereleaseVersion,
  parseReleaseVersion,
  releaseArchiveAssetName,
  releaseArchiveAssetNameForTarget,
  releaseAssetNamesForVersion,
  releaseTargets,
  renderReleaseInstaller,
  writeBundleMetadata,
} from "./release";

async function run(
  command: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
  } = {},
): Promise<{
  exitCode: number;
  stderr: string;
  stdout: string;
}> {
  const process = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env ? { ...Bun.env, ...options.env } : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

async function writeTestArchive(
  outputPath: string,
  version: string,
): Promise<void> {
  const stagingDir = await mkdtemp(join(tmpdir(), "archcode-release-staging-"));
  try {
    const binaryPath = join(stagingDir, "archcode");
    await Bun.write(binaryPath, [
      "#!/bin/sh",
      `if [ "$1" = "--version" ]; then printf 'archcode ${version}\\n'; exit 0; fi`,
      "if [ \"$1\" = \"__install-managed\" ]; then",
      "  cp \"$0\" \"$3\" && chmod 755 \"$3\"",
      "  printf '{\"schemaVersion\":1,\"name\":\"archcode\",\"managedBy\":\"archcode-installer\",\"installPath\":\"%s\",\"version\":\"" + version + "\",\"platform\":\"macOS\",\"architecture\":\"arm64\",\"binarySha256\":\"" + "0".repeat(64) + "\",\"installedAt\":1}\\n' \"$3\" > \"$(dirname \"$3\")/.archcode-install-receipt.json\"",
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"));
    await chmod(binaryPath, 0o755);
    const result = await run([
      "tar",
      "-czf",
      outputPath,
      "-C",
      stagingDir,
      "archcode",
    ]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr);
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

describe("release metadata", () => {
  test("extracts only the requested changelog section", () => {
    const changelog = [
      "# Changelog",
      "",
      "## [1.2.0] - 2026-01-02",
      "",
      "- Current release.",
      "",
      "## [1.1.0] - 2026-01-01",
      "",
      "- Previous release.",
      "",
    ].join("\n");

    expect(extractReleaseNotes(changelog, "1.2.0")).toBe(
      "## [1.2.0] - 2026-01-02\n\n- Current release.\n",
    );
  });

  test("defines one friendly versioned archive name per supported target", () => {
    expect(releaseTargets.map((target) => releaseArchiveAssetName(target, "1.2.3"))).toEqual([
      "archcode-macos-arm64-v1.2.3.tar.gz",
      "archcode-macos-x64-v1.2.3.tar.gz",
      "archcode-linux-arm64-v1.2.3.tar.gz",
      "archcode-linux-x64-v1.2.3.tar.gz",
    ]);
    expect(releaseArchiveAssetNameForTarget(
      "aarch64-unknown-linux-gnu",
      "1.2.3",
    )).toBe("archcode-linux-arm64-v1.2.3.tar.gz");
    expect(() => releaseArchiveAssetNameForTarget(
      "x86_64-pc-windows-msvc",
      "1.2.3",
    )).toThrow("Unsupported release target");
  });

  test("renders an immutable installer for the release version", () => {
    const rendered = renderReleaseInstaller(
      'INSTALLER_VERSION="__ARCHCODE_VERSION__"\n',
      "1.2.3",
    );
    expect(rendered).toBe('INSTALLER_VERSION="1.2.3"\n');
    expect(rendered).not.toContain("__ARCHCODE_VERSION__");
    expect(() => renderReleaseInstaller("no placeholder", "1.2.3"))
      .toThrow("exactly once");
  });

  test.each([
    "0.1.0",
    "1.2.3-beta.1",
    "1.2.3+build.4",
    "1.2.3-rc.2+build.4",
  ])("accepts canonical SemVer %s", (version) => {
    expect(parseReleaseVersion(version)).toBe(version);
  });

  test("distinguishes prereleases from build metadata", () => {
    expect(isPrereleaseVersion("1.2.3-beta.1+build.7")).toBe(true);
    expect(isPrereleaseVersion("1.2.3+build-7")).toBe(false);
  });

  test("requires every private workspace package to match the product version", () => {
    expect(() => assertWorkspacePackageVersions([
      { name: "@archcode/server", version: "0.0.3" },
      { name: "@archcode/web", version: "0.0.3" },
    ], "0.0.3")).not.toThrow();
    expect(() => assertWorkspacePackageVersions([
      { name: "@archcode/server", version: "0.0.3" },
      { name: "@archcode/web", version: "0.1.0" },
    ], "0.0.3")).toThrow("@archcode/web version \"0.1.0\" does not match 0.0.3");
  });

  test("classifies existing drafts as recoverable and exact published releases as complete", () => {
    const expected = {
      notes: "## [1.2.3]\n\n- Fixed.\n",
      prerelease: false,
      tag: "v1.2.3",
      title: "ArchCode v1.2.3",
    };
    expect(classifyExistingRelease({
      body: "stale",
      isDraft: true,
      isPrerelease: true,
      name: "stale",
      tagName: "v1.2.3",
    }, expected)).toBe("draft");
    expect(classifyExistingRelease({
      body: "## [1.2.3]\r\n\r\n- Fixed.",
      isDraft: false,
      isPrerelease: false,
      name: "ArchCode v1.2.3",
      tagName: "v1.2.3",
    }, expected)).toBe("published");
  });

  test.each([
    ["tag", { tagName: "v1.2.4" }],
    ["prerelease state", { isPrerelease: true }],
    ["title", { name: "Other" }],
    ["notes", { body: "Other" }],
  ])("rejects a published release with mismatched %s", (_field, patch) => {
    expect(() => classifyExistingRelease({
      body: "Release notes",
      isDraft: false,
      isPrerelease: false,
      name: "ArchCode v1.2.3",
      tagName: "v1.2.3",
      ...patch,
    }, {
      notes: "Release notes",
      prerelease: false,
      tag: "v1.2.3",
      title: "ArchCode v1.2.3",
    })).toThrow();
  });

  test("requires exact draft metadata immediately before publication", () => {
    const expected = {
      notes: "## [1.2.3]\n\n- Fixed.\n",
      tag: "v1.2.3",
      title: "ArchCode v1.2.3",
    };
    const draft = {
      body: "## [1.2.3]\r\n\r\n- Fixed.",
      isDraft: true,
      isPrerelease: false,
      name: "ArchCode v1.2.3",
      tagName: "v1.2.3",
    };
    expect(() => assertReleaseReadyToPublish(draft, expected)).not.toThrow();
    expect(() => assertReleaseReadyToPublish({
      ...draft,
      body: "tampered",
    }, expected)).toThrow("notes");
    expect(() => assertReleaseReadyToPublish({
      ...draft,
      isDraft: false,
    }, expected)).toThrow("no longer a draft");
  });

  test.each([
    "v1.2.3",
    "01.2.3",
    "1.2.3-01",
    "1.2",
    "",
  ])("rejects non-canonical SemVer %s", (version) => {
    expect(() => parseReleaseVersion(version)).toThrow("canonical SemVer");
  });

  test("compares complete release asset directories by content", async () => {
    const expectedDir = await mkdtemp(join(tmpdir(), "archcode-release-expected-"));
    const actualDir = await mkdtemp(join(tmpdir(), "archcode-release-actual-"));
    const releaseAssetNames = releaseAssetNamesForVersion("0.0.3");
    try {
      for (const name of releaseAssetNames) {
        await Promise.all([
          Bun.write(join(expectedDir, name), `asset:${name}`),
          Bun.write(join(actualDir, name), `asset:${name}`),
        ]);
      }
      await expect(compareReleaseAssetDirectories(expectedDir, actualDir)).resolves.toBeUndefined();

      await Bun.write(join(actualDir, releaseAssetNames[0]), "changed");
      await expect(compareReleaseAssetDirectories(expectedDir, actualDir))
        .rejects.toThrow(/mismatch/);
    } finally {
      await Promise.all([
        rm(expectedDir, { recursive: true, force: true }),
        rm(actualDir, { recursive: true, force: true }),
      ]);
    }
  });

  test("generates checksums and a manifest for archives and the installer", async () => {
    const assetDir = await mkdtemp(join(tmpdir(), "archcode-release-bundle-"));
    try {
      for (const target of releaseTargets) {
        await writeTestArchive(
          join(assetDir, releaseArchiveAssetName(target, "0.0.3")),
          "0.0.3",
        );
      }
      const template = await Bun.file(join(import.meta.dir, "install.sh")).text();
      await Bun.write(
        join(assetDir, "install.sh"),
        renderReleaseInstaller(template, "0.0.3"),
      );

      await writeBundleMetadata(assetDir);

      const checksums = await Bun.file(join(assetDir, "SHA256SUMS")).text();
      expect(checksums.trim().split("\n")).toHaveLength(5);
      expect(checksums).toContain("  install.sh\n");

      const manifest = await Bun.file(join(assetDir, "release-manifest.json")).json() as {
        schemaVersion: number;
        minimumDirectUpdateFrom: string;
        assets: Array<Record<string, unknown>>;
      };
      expect(manifest.schemaVersion).toBe(3);
      expect(manifest.minimumDirectUpdateFrom).toBe("0.0.3");
      expect(manifest.assets).toHaveLength(5);
      expect(manifest.assets[0]).toMatchObject({
        archiveFormat: "tar.gz",
        binary: {
          name: "archcode",
          size: expect.any(Number),
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        kind: "archive",
      });
      expect(manifest.assets[4]).toMatchObject({
        kind: "installer",
        name: "install.sh",
      });
    } finally {
      await rm(assetDir, { recursive: true, force: true });
    }
  });

  test("installer verifies and atomically installs the matching archive", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "archcode-installer-fixture-"));
    const prefix = join(fixtureRoot, "prefix");
    const releaseDir = join(fixtureRoot, "releases", "v0.0.3");
    try {
      await mkdir(releaseDir, { recursive: true });
      const platform = process.platform === "darwin" ? "macos" : "linux";
      const architecture = process.arch === "arm64" ? "arm64" : "x64";
      const assetName = `archcode-${platform}-${architecture}-v0.0.3.tar.gz`;
      const archivePath = join(releaseDir, assetName);
      await writeTestArchive(archivePath, "0.0.3");
      const digest = new Bun.CryptoHasher("sha256")
        .update(await readFile(archivePath))
        .digest("hex");
      const checksumsPath = join(releaseDir, "SHA256SUMS");
      await Bun.write(checksumsPath, `${digest}  ${assetName}\n`);

      const template = await Bun.file(join(import.meta.dir, "install.sh")).text();
      const installerPath = join(fixtureRoot, "install.sh");
      await Bun.write(installerPath, renderReleaseInstaller(template, "0.0.3"));
      const environment = {
        ARCHCODE_RELEASE_BASE_URL: `file://${join(fixtureRoot, "releases")}`,
      };
      const result = await run(
        ["sh", installerPath, "--prefix", prefix],
        { env: environment },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Installed ArchCode v0.0.3");
      const installedPath = join(prefix, "bin", "archcode");
      const installed = await run([installedPath, "--version"]);
      expect(installed).toMatchObject({
        exitCode: 0,
        stdout: "archcode 0.0.3\n",
      });
      expect((await stat(installedPath)).mode & 0o777).toBe(0o755);
      const receipt = await Bun.file(
        join(prefix, "bin", ".archcode-install-receipt.json"),
      ).json() as { installPath: string };
      expect(receipt.installPath).toBe(installedPath);

      await Bun.write(installedPath, "previous installation\n");
      await Bun.write(checksumsPath, `${"0".repeat(64)}  ${assetName}\n`);
      const failedUpdate = await run(
        ["sh", installerPath, "--prefix", prefix],
        { env: environment },
      );
      expect(failedUpdate.exitCode).toBe(1);
      expect(failedUpdate.stderr).toContain("checksum verification failed");
      expect(await Bun.file(installedPath).text()).toBe("previous installation\n");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
