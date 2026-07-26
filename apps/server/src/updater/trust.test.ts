import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseReleaseManifest } from "./manifest";
import { verifyReleaseAttestation } from "./trust";

const fixtureDirectory = join(import.meta.dir, "fixtures");

describe("release attestation trust", () => {
  test("verifies the real v0.0.3 release workflow identity and signed subjects", async () => {
    const manifestText = await Bun.file(
      join(fixtureDirectory, "release-v0.0.3-manifest.json"),
    ).text();
    const original = JSON.parse(manifestText) as Record<string, unknown>;
    const manifest = parseReleaseManifest({
      ...original,
      schemaVersion: 3,
      minimumDirectUpdateFrom: "0.0.3",
    });
    const bundle = await Bun.file(
      join(fixtureDirectory, "release-v0.0.3-attestation.json"),
    ).json();

    const verified = verifyReleaseAttestation({
      bundle,
      manifest,
      manifestBytes: new TextEncoder().encode(manifestText),
    });

    expect(verified.sha256ByName.get("release-manifest.json")).toBe(
      "bcebd7467b91f5e3cf7e656ab3d16f928bb2964e3ce536072f67c749f5334d69",
    );
    for (const asset of manifest.assets) {
      expect(verified.sha256ByName.get(asset.name)).toBe(asset.sha256);
    }
  });

  test("rejects tampered metadata and a different workflow tag identity", async () => {
    const manifestText = await Bun.file(
      join(fixtureDirectory, "release-v0.0.3-manifest.json"),
    ).text();
    const original = JSON.parse(manifestText) as Record<string, unknown>;
    const manifest = parseReleaseManifest({
      ...original,
      schemaVersion: 3,
      minimumDirectUpdateFrom: "0.0.3",
    });
    const bundle = await Bun.file(
      join(fixtureDirectory, "release-v0.0.3-attestation.json"),
    ).json();

    expect(() => verifyReleaseAttestation({
      bundle,
      manifest,
      manifestBytes: new TextEncoder().encode(`${manifestText} `),
    })).toThrow("official ArchCode release workflow");
    expect(() => verifyReleaseAttestation({
      bundle,
      manifest: { ...manifest, tag: "v0.0.4" },
      manifestBytes: new TextEncoder().encode(manifestText),
    })).toThrow("official ArchCode release workflow");
  });
});
