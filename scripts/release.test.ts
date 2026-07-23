import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertWorkspacePackageVersions,
  classifyExistingRelease,
  compareReleaseAssetDirectories,
  extractReleaseNotes,
  isPrereleaseVersion,
  parseReleaseVersion,
  releaseAssetNames,
  releaseTargets,
} from "./release";

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

  test("defines one stable archive name per supported target", () => {
    expect(releaseTargets.map((target) => target.archive)).toEqual([
      "archcode-aarch64-apple-darwin.tar.gz",
      "archcode-x86_64-apple-darwin.tar.gz",
      "archcode-aarch64-unknown-linux-gnu.tar.gz",
      "archcode-x86_64-unknown-linux-gnu.tar.gz",
    ]);
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
      { name: "@archcode/server", version: "0.0.1" },
      { name: "@archcode/web", version: "0.0.1" },
    ], "0.0.1")).not.toThrow();
    expect(() => assertWorkspacePackageVersions([
      { name: "@archcode/server", version: "0.0.1" },
      { name: "@archcode/web", version: "0.1.0" },
    ], "0.0.1")).toThrow("@archcode/web version \"0.1.0\" does not match 0.0.1");
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
});
