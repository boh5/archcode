import { describe, expect, test } from "bun:test";
import { parseReleaseManifest } from "./manifest";

describe("release manifest v3", () => {
  test("accepts only the exact bounded platform matrix", () => {
    expect(parseReleaseManifest(manifestFixture())).toEqual(manifestFixture());
  });

  test("rejects path traversal and platform-name mismatches", () => {
    const manifest = manifestFixture();
    manifest.assets[0]!.name = "../../archcode.tar.gz";

    expect(() => parseReleaseManifest(manifest)).toThrow(
      "The release manifest is invalid",
    );
  });

  test("rejects duplicate platforms and a compatibility floor above the release", () => {
    const duplicatePlatform = manifestFixture();
    const first = duplicatePlatform.assets[0]!;
    const second = duplicatePlatform.assets[1]!;
    if (first.kind !== "archive" || second.kind !== "archive") {
      throw new Error("Expected archive fixtures");
    }
    second.platform = first.platform;
    second.architecture = first.architecture;
    second.name = `${first.name}.duplicate`;
    expect(() => parseReleaseManifest(duplicatePlatform)).toThrow(
      "The release manifest is invalid",
    );

    const incompatible = manifestFixture();
    incompatible.minimumDirectUpdateFrom = "1.1.0";
    expect(() => parseReleaseManifest(incompatible)).toThrow(
      "The release manifest is invalid",
    );
  });
});

function manifestFixture() {
  const archive = (
    platform: "macOS" | "Linux",
    architecture: "arm64" | "x64",
  ) => ({
    name: `archcode-${platform === "macOS" ? "macos" : "linux"}-${architecture}-v1.0.0.tar.gz`,
    kind: "archive" as const,
    platform,
    architecture,
    archiveFormat: "tar.gz" as const,
    size: 100,
    sha256: "1".repeat(64),
    binary: {
      name: "archcode" as const,
      size: 200,
      sha256: "2".repeat(64),
    },
  });
  return {
    schemaVersion: 3 as const,
    name: "archcode" as const,
    version: "1.0.0",
    tag: "v1.0.0",
    minimumDirectUpdateFrom: "1.0.0",
    assets: [
      archive("macOS", "arm64"),
      archive("macOS", "x64"),
      archive("Linux", "arm64"),
      archive("Linux", "x64"),
      {
        name: "install.sh" as const,
        kind: "installer" as const,
        size: 100,
        sha256: "3".repeat(64),
      },
    ],
  };
}
