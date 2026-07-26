import { UpdateError } from "./errors";
import type { ReleaseArchiveAsset, ReleaseManifest } from "./manifest";

export interface ReleasePlatform {
  platform: "macOS" | "Linux";
  architecture: "arm64" | "x64";
}

export function currentReleasePlatform(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): ReleasePlatform {
  const normalizedPlatform = platform === "darwin"
    ? "macOS"
    : platform === "linux"
      ? "Linux"
      : undefined;
  const normalizedArchitecture = architecture === "arm64"
    ? "arm64"
    : architecture === "x64"
      ? "x64"
      : undefined;
  if (normalizedPlatform === undefined || normalizedArchitecture === undefined) {
    throw new UpdateError(
      "UPDATE_UNSUPPORTED_PLATFORM",
      `Direct updates are not available on ${platform}/${architecture}`,
    );
  }
  return {
    platform: normalizedPlatform,
    architecture: normalizedArchitecture,
  };
}

export function selectReleaseArchive(
  manifest: ReleaseManifest,
  platform: ReleasePlatform = currentReleasePlatform(),
): ReleaseArchiveAsset {
  const asset = manifest.assets.find(
    (candidate): candidate is ReleaseArchiveAsset => (
      candidate.kind === "archive"
      && candidate.platform === platform.platform
      && candidate.architecture === platform.architecture
    ),
  );
  if (asset === undefined) {
    throw new UpdateError(
      "UPDATE_UNSUPPORTED_PLATFORM",
      `Release v${manifest.version} has no archive for ${platform.platform}/${platform.architecture}`,
    );
  }
  return asset;
}
