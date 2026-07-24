/// <reference types="bun" />

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "semver";

const rootDir = join(import.meta.dir, "..");
const packageJsonPath = join(rootDir, "package.json");
const changelogPath = join(rootDir, "CHANGELOG.md");
const workspacePackageJsonPaths = [
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/agent-core/package.json",
  "packages/protocol/package.json",
  "packages/utils/package.json",
] as const;
export const releaseTargets = [
  {
    assetBaseName: "archcode-macos-arm64",
    platform: "macOS",
    architecture: "arm64",
    target: "aarch64-apple-darwin",
  },
  {
    assetBaseName: "archcode-macos-x64",
    platform: "macOS",
    architecture: "x64",
    target: "x86_64-apple-darwin",
  },
  {
    assetBaseName: "archcode-linux-arm64",
    platform: "Linux",
    architecture: "arm64",
    target: "aarch64-unknown-linux-gnu",
  },
  {
    assetBaseName: "archcode-linux-x64",
    platform: "Linux",
    architecture: "x64",
    target: "x86_64-unknown-linux-gnu",
  },
] as const;

export function releaseBinaryAssetName(
  target: (typeof releaseTargets)[number],
  version: string,
): string {
  return `${target.assetBaseName}-v${parseReleaseVersion(version)}`;
}

export function releaseBinaryAssetNameForTarget(targetTriple: string, version: string): string {
  const target = releaseTargets.find((candidate) => candidate.target === targetTriple);
  if (!target) {
    throw new Error(`Unsupported release target: ${targetTriple}`);
  }
  return releaseBinaryAssetName(target, version);
}

export function releaseAssetNamesForVersion(version: string): string[] {
  return [
    ...releaseTargets.map((target) => releaseBinaryAssetName(target, version)),
    "SHA256SUMS",
    "release-manifest.json",
  ];
}

export interface ExistingReleaseMetadata {
  body: string;
  isDraft: boolean;
  isPrerelease: boolean;
  name: string;
  tagName: string;
}

export function parseReleaseVersion(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("package.json must contain a canonical SemVer version");
  }

  const parsed = parse(value);
  const canonical = parsed
    ? [
        `${parsed.major}.${parsed.minor}.${parsed.patch}`,
        parsed.prerelease.length > 0 ? `-${parsed.prerelease.join(".")}` : "",
        parsed.build.length > 0 ? `+${parsed.build.join(".")}` : "",
      ].join("")
    : undefined;
  if (canonical !== value) {
    throw new Error("package.json must contain a canonical SemVer version");
  }
  return value;
}

export function isPrereleaseVersion(value: string): boolean {
  parseReleaseVersion(value);
  return parse(value)!.prerelease.length > 0;
}

export function assertWorkspacePackageVersions(
  packages: ReadonlyArray<{ name?: unknown; version?: unknown }>,
  expectedVersion: string,
): void {
  for (const packageJson of packages) {
    const name = typeof packageJson.name === "string" ? packageJson.name : "(unknown package)";
    if (packageJson.version !== expectedVersion) {
      throw new Error(
        `${name} version ${JSON.stringify(packageJson.version)} does not match ${expectedVersion}`,
      );
    }
  }
}

export function classifyExistingRelease(
  metadata: ExistingReleaseMetadata,
  expected: {
    notes: string;
    prerelease: boolean;
    tag: string;
    title: string;
  },
): "draft" | "published" {
  if (metadata.tagName !== expected.tag) {
    throw new Error(
      `Release tag mismatch: expected ${expected.tag}, received ${metadata.tagName}`,
    );
  }
  if (metadata.isDraft) return "draft";
  if (metadata.isPrerelease !== expected.prerelease) {
    throw new Error("Published release prerelease state does not match package version");
  }
  if (metadata.name !== expected.title) {
    throw new Error(`Published release title does not match ${expected.title}`);
  }
  if (normalizeReleaseText(metadata.body) !== normalizeReleaseText(expected.notes)) {
    throw new Error("Published release notes do not match CHANGELOG.md");
  }
  return "published";
}

export async function readReleaseVersion(): Promise<string> {
  const packageJson = await Bun.file(packageJsonPath).json() as { version?: unknown };
  return parseReleaseVersion(packageJson.version);
}

export function extractReleaseNotes(changelog: string, version: string): string {
  const heading = `## [${version}]`;
  const start = changelog.indexOf(heading);
  if (start === -1) {
    throw new Error(`CHANGELOG.md is missing a ${heading} section`);
  }

  const nextSection = changelog.indexOf("\n## [", start + heading.length);
  const section = changelog.slice(start, nextSection === -1 ? undefined : nextSection).trim();
  if (!section.includes("\n")) {
    throw new Error(`CHANGELOG.md section ${heading} has no release notes`);
  }
  return `${section}\n`;
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) {
    hasher.update(chunk);
  }
  return hasher.digest("hex");
}

async function listReleaseAssetNames(assetDir: string): Promise<string[]> {
  const entries = await readdir(assetDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

export async function verifyReleaseAssetDirectory(
  assetDir: string,
  version?: string,
): Promise<void> {
  const resolvedVersion = version ?? await readReleaseVersion();
  const actual = await listReleaseAssetNames(assetDir);
  const expected = releaseAssetNamesForVersion(resolvedVersion)
    .sort((a, b) => a.localeCompare(b));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Release asset set mismatch. Expected ${expected.join(", ")}; received ${actual.join(", ") || "(none)"}`,
    );
  }
}

export async function compareReleaseAssetDirectories(
  expectedDir: string,
  actualDir: string,
): Promise<void> {
  const version = await readReleaseVersion();
  const assetNames = releaseAssetNamesForVersion(version);
  await Promise.all([
    verifyReleaseAssetDirectory(expectedDir, version),
    verifyReleaseAssetDirectory(actualDir, version),
  ]);

  for (const name of assetNames) {
    const expectedPath = join(expectedDir, name);
    const actualPath = join(actualDir, name);
    const [expectedFile, actualFile] = [Bun.file(expectedPath), Bun.file(actualPath)];
    if (expectedFile.size !== actualFile.size) {
      throw new Error(`Release asset size mismatch for ${name}`);
    }
    const [expectedHash, actualHash] = await Promise.all([
      sha256(expectedPath),
      sha256(actualPath),
    ]);
    if (expectedHash !== actualHash) {
      throw new Error(`Release asset digest mismatch for ${name}`);
    }
  }
}

async function runPreflight(tag: string | undefined): Promise<void> {
  const version = await readReleaseVersion();
  const workspacePackages = await Promise.all(
    workspacePackageJsonPaths.map(
      (path) => Bun.file(join(rootDir, path)).json() as Promise<{
        name?: unknown;
        version?: unknown;
      }>,
    ),
  );
  assertWorkspacePackageVersions(workspacePackages, version);
  extractReleaseNotes(await Bun.file(changelogPath).text(), version);

  if (tag && tag !== `v${version}`) {
    throw new Error(`Tag ${tag} does not match package version v${version}`);
  }

  console.log(`Release metadata is consistent for v${version}`);
}

async function writeNotes(outputPath: string): Promise<void> {
  const version = await readReleaseVersion();
  const notes = extractReleaseNotes(await Bun.file(changelogPath).text(), version);
  await Bun.write(outputPath, notes);
}

async function readExistingReleaseState(
  metadataPath: string,
  notesPath: string,
): Promise<"draft" | "published"> {
  const version = await readReleaseVersion();
  const metadata = parseExistingReleaseMetadata(await Bun.file(metadataPath).json());
  return classifyExistingRelease(metadata, {
    notes: await Bun.file(notesPath).text(),
    prerelease: isPrereleaseVersion(version),
    tag: `v${version}`,
    title: `ArchCode v${version}`,
  });
}

async function writeBundleMetadata(assetDir: string): Promise<void> {
  const version = await readReleaseVersion();
  const assets = [];

  for (const target of releaseTargets) {
    const name = releaseBinaryAssetName(target, version);
    const path = join(assetDir, name);
    const file = Bun.file(path);
    if (!await file.exists()) {
      throw new Error(`Missing release asset: ${name}`);
    }
    assets.push({
      name,
      platform: target.platform,
      architecture: target.architecture,
      size: file.size,
      sha256: await sha256(path),
    });
  }

  const checksumText = assets
    .map((asset) => `${asset.sha256}  ${asset.name}`)
    .join("\n");
  await Bun.write(join(assetDir, "SHA256SUMS"), `${checksumText}\n`);
  await Bun.write(join(assetDir, "release-manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    name: "archcode",
    version,
    tag: `v${version}`,
    assets,
  }, null, 2)}\n`);
  await verifyReleaseAssetDirectory(assetDir, version);
}

function requireArgument(value: string | undefined, usage: string): string {
  if (!value) {
    throw new Error(`Missing argument. Usage: ${usage}`);
  }
  return value;
}

function parseExistingReleaseMetadata(value: unknown): ExistingReleaseMetadata {
  if (!value || typeof value !== "object") {
    throw new Error("GitHub release metadata must be an object");
  }
  const metadata = value as Record<string, unknown>;
  if (
    typeof metadata.body !== "string" ||
    typeof metadata.isDraft !== "boolean" ||
    typeof metadata.isPrerelease !== "boolean" ||
    typeof metadata.name !== "string" ||
    typeof metadata.tagName !== "string"
  ) {
    throw new Error("GitHub release metadata is incomplete");
  }
  return metadata as unknown as ExistingReleaseMetadata;
}

function normalizeReleaseText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

async function run(): Promise<void> {
  const [, , command, ...args] = Bun.argv;
  switch (command) {
    case "version":
      console.log(await readReleaseVersion());
      return;
    case "preflight":
      await runPreflight(args[0] || undefined);
      return;
    case "prerelease":
      console.log(isPrereleaseVersion(await readReleaseVersion()));
      return;
    case "assets":
      console.log(releaseAssetNamesForVersion(await readReleaseVersion()).join("\n"));
      return;
    case "asset":
      console.log(releaseBinaryAssetNameForTarget(
        requireArgument(args[0], "bun run scripts/release.ts asset <target-triple>"),
        await readReleaseVersion(),
      ));
      return;
    case "notes":
      await writeNotes(requireArgument(args[0], "bun run scripts/release.ts notes <output-path>"));
      return;
    case "state":
      console.log(await readExistingReleaseState(
        requireArgument(
          args[0],
          "bun run scripts/release.ts state <metadata-path> <notes-path>",
        ),
        requireArgument(
          args[1],
          "bun run scripts/release.ts state <metadata-path> <notes-path>",
        ),
      ));
      return;
    case "bundle":
      await writeBundleMetadata(requireArgument(args[0], "bun run scripts/release.ts bundle <asset-dir>"));
      return;
    case "compare":
      await compareReleaseAssetDirectories(
        requireArgument(args[0], "bun run scripts/release.ts compare <expected-dir> <actual-dir>"),
        requireArgument(args[1], "bun run scripts/release.ts compare <expected-dir> <actual-dir>"),
      );
      return;
    default:
      throw new Error(
        `Unknown command ${JSON.stringify(command)}. ` +
        "Expected version, preflight, prerelease, asset, assets, notes, state, bundle, or compare.",
      );
  }
}

if (import.meta.main) {
  await run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
