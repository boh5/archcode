import { parse as parseSemver } from "semver";
import { z } from "zod";
import {
  MAX_ARCHIVE_BYTES,
  MAX_BINARY_BYTES,
} from "./constants";
import { UpdateError } from "./errors";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const safePositiveIntegerSchema = z.number().int().positive()
  .max(Number.MAX_SAFE_INTEGER);
const canonicalVersionSchema = z.string().refine(
  (value) => parseCanonicalVersion(value) !== undefined,
  "Expected a canonical SemVer version",
);

const binarySchema = z.object({
  name: z.literal("archcode"),
  sha256: sha256Schema,
  size: safePositiveIntegerSchema.max(MAX_BINARY_BYTES),
}).strict();

const archiveAssetSchema = z.object({
  name: z.string().min(1),
  kind: z.literal("archive"),
  platform: z.enum(["macOS", "Linux"]),
  architecture: z.enum(["arm64", "x64"]),
  archiveFormat: z.literal("tar.gz"),
  size: safePositiveIntegerSchema.max(MAX_ARCHIVE_BYTES),
  sha256: sha256Schema,
  binary: binarySchema,
}).strict();

const installerAssetSchema = z.object({
  name: z.literal("install.sh"),
  kind: z.literal("installer"),
  size: safePositiveIntegerSchema,
  sha256: sha256Schema,
}).strict();

export const releaseManifestSchema = z.object({
  schemaVersion: z.literal(3),
  name: z.literal("archcode"),
  version: canonicalVersionSchema,
  tag: z.string().min(1),
  minimumDirectUpdateFrom: canonicalVersionSchema,
  assets: z.array(z.discriminatedUnion("kind", [
    archiveAssetSchema,
    installerAssetSchema,
  ])).length(5),
}).strict().superRefine((manifest, context) => {
  if (manifest.tag !== `v${manifest.version}`) {
    context.addIssue({
      code: "custom",
      path: ["tag"],
      message: "Release tag must match the release version",
    });
  }
  const names = manifest.assets.map((asset) => asset.name);
  if (new Set(names).size !== names.length) {
    context.addIssue({
      code: "custom",
      path: ["assets"],
      message: "Release asset names must be unique",
    });
  }
  const version = parseSemver(manifest.version)!;
  const minimumDirectUpdateFrom = parseSemver(
    manifest.minimumDirectUpdateFrom,
  )!;
  if (minimumDirectUpdateFrom.compare(version) > 0) {
    context.addIssue({
      code: "custom",
      path: ["minimumDirectUpdateFrom"],
      message: "Minimum direct-update version cannot exceed release version",
    });
  }

  const expectedArchives = new Map([
    ["macOS:arm64", `archcode-macos-arm64-v${manifest.version}.tar.gz`],
    ["macOS:x64", `archcode-macos-x64-v${manifest.version}.tar.gz`],
    ["Linux:arm64", `archcode-linux-arm64-v${manifest.version}.tar.gz`],
    ["Linux:x64", `archcode-linux-x64-v${manifest.version}.tar.gz`],
  ]);
  const observedArchives = new Set<string>();
  let installerCount = 0;
  for (const [index, asset] of manifest.assets.entries()) {
    if (asset.kind === "installer") {
      installerCount += 1;
      continue;
    }
    const platformKey = `${asset.platform}:${asset.architecture}`;
    const expectedName = expectedArchives.get(platformKey);
    if (expectedName === undefined || asset.name !== expectedName) {
      context.addIssue({
        code: "custom",
        path: ["assets", index, "name"],
        message: `Archive name must match its signed platform and version (${expectedName ?? "unsupported platform"})`,
      });
    }
    if (observedArchives.has(platformKey)) {
      context.addIssue({
        code: "custom",
        path: ["assets", index],
        message: `Release platform appears more than once: ${platformKey}`,
      });
    }
    observedArchives.add(platformKey);
  }
  if (
    installerCount !== 1
    || observedArchives.size !== expectedArchives.size
    || [...expectedArchives.keys()].some(
      (platformKey) => !observedArchives.has(platformKey),
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["assets"],
      message: "Release must contain install.sh and exactly one archive for every supported platform",
    });
  }
});

export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;
export type ReleaseArchiveAsset = Extract<ReleaseManifest["assets"][number], { kind: "archive" }>;

export function parseReleaseManifest(value: unknown): ReleaseManifest {
  const parsed = releaseManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new UpdateError(
      "UPDATE_MANIFEST_INVALID",
      "The release manifest is invalid",
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

export function parseCanonicalVersion(value: string): string | undefined {
  const parsed = parseSemver(value);
  if (parsed === null) return undefined;
  const canonical = [
    `${parsed.major}.${parsed.minor}.${parsed.patch}`,
    parsed.prerelease.length > 0 ? `-${parsed.prerelease.join(".")}` : "",
    parsed.build.length > 0 ? `+${parsed.build.join(".")}` : "",
  ].join("");
  return canonical === value ? canonical : undefined;
}
