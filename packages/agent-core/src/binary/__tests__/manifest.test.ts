import { describe, expect, test } from "bun:test";
import { BINARY_MANIFEST, getBinaryReleaseUrl, getBinarySpec } from "../manifest";
import { BinaryManifestSchema, BinarySpecSchema, SupportedTargetTripleSchema, type SupportedTargetTriple } from "../types";

const TARGET_TRIPLES = SupportedTargetTripleSchema.options;

describe("binary manifest", () => {
  test("is strict and parseable", () => {
    expect(() => BinaryManifestSchema.parse(BINARY_MANIFEST)).not.toThrow();
    expect(() => BinarySpecSchema.parse({ ...BINARY_MANIFEST.rg, extra: true })).toThrow();
  });

  test("pins ripgrep v15.1.0 release metadata", () => {
    const rg = getBinarySpec("rg");

    expect(rg.version).toBe("15.1.0");
    expect(rg.github).toEqual({ owner: "BurntSushi", name: "ripgrep" });
    expect(rg.assetNameTemplate).toBe("ripgrep-{version}-{targetTriple}.tar.gz");
    expect(rg.binaryName).toBe("rg");

    expect(rg.platforms["aarch64-apple-darwin"].assetName).toBe("ripgrep-15.1.0-aarch64-apple-darwin.tar.gz");
    expect(rg.platforms["x86_64-apple-darwin"].assetName).toBe("ripgrep-15.1.0-x86_64-apple-darwin.tar.gz");
    expect(rg.platforms["aarch64-unknown-linux-gnu"].assetName).toBe("ripgrep-15.1.0-aarch64-unknown-linux-gnu.tar.gz");
    expect(rg.platforms["x86_64-unknown-linux-gnu"].assetName).toBe("ripgrep-15.1.0-x86_64-unknown-linux-musl.tar.gz");

    expect(rg.platforms["aarch64-apple-darwin"].sha256).toBe("378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715");
    expect(rg.platforms["x86_64-apple-darwin"].sha256).toBe("64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882");
    expect(rg.platforms["aarch64-unknown-linux-gnu"].sha256).toBe("2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e");
    expect(rg.platforms["x86_64-unknown-linux-gnu"].sha256).toBe("1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599");
  });

  test("pins ast-grep v0.42.3 release metadata", () => {
    const astGrep = getBinarySpec("ast-grep");

    expect(astGrep.version).toBe("0.42.3");
    expect(astGrep.github).toEqual({ owner: "ast-grep", name: "ast-grep" });
    expect(astGrep.assetNameTemplate).toBe("app-{targetTriple}.zip");
    expect(astGrep.binaryName).toBe("ast-grep");

    expect(astGrep.platforms["aarch64-apple-darwin"].assetName).toBe("app-aarch64-apple-darwin.zip");
    expect(astGrep.platforms["x86_64-apple-darwin"].assetName).toBe("app-x86_64-apple-darwin.zip");
    expect(astGrep.platforms["aarch64-unknown-linux-gnu"].assetName).toBe("app-aarch64-unknown-linux-gnu.zip");
    expect(astGrep.platforms["x86_64-unknown-linux-gnu"].assetName).toBe("app-x86_64-unknown-linux-gnu.zip");

    for (const platform of Object.values(astGrep.platforms)) {
      expect(platform.archiveFormat).toBe("zip");
      expect(platform.binaryPathInArchive).toBe("ast-grep");
    }
  });

  test("covers every supported target and builds GitHub release URLs", () => {
    for (const spec of Object.values(BINARY_MANIFEST)) {
      expect(Object.keys(spec.platforms).sort()).toEqual([...TARGET_TRIPLES].sort());

      for (const [targetTriple, platform] of Object.entries(spec.platforms) as [SupportedTargetTriple, typeof spec.platforms[SupportedTargetTriple]][]) {
        expect(platform.targetTriple).toBe(targetTriple);
        expect(platform.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(getBinaryReleaseUrl(spec, platform.assetName)).toBe(
          `https://github.com/${spec.github.owner}/${spec.github.name}/releases/download/${spec.version}/${platform.assetName}`,
        );
      }
    }
  });
});
