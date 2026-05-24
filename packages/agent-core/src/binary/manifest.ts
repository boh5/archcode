import type { BinaryManifest, BinarySpec, SupportedBinaryId } from "./types";
import { BinaryManifestSchema } from "./types";

export const BINARY_MANIFEST = BinaryManifestSchema.parse({
  rg: {
    binaryId: "rg",
    version: "15.1.0",
    github: { owner: "BurntSushi", name: "ripgrep" },
    assetNameTemplate: "ripgrep-{version}-{targetTriple}.tar.gz",
    binaryName: "rg",
    platforms: {
      "aarch64-apple-darwin": {
        targetTriple: "aarch64-apple-darwin",
        assetName: "ripgrep-15.1.0-aarch64-apple-darwin.tar.gz",
        archiveFormat: "tar.gz",
        binaryPathInArchive: "ripgrep-15.1.0-aarch64-apple-darwin/rg",
        sha256: "378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715",
      },
      "x86_64-apple-darwin": {
        targetTriple: "x86_64-apple-darwin",
        assetName: "ripgrep-15.1.0-x86_64-apple-darwin.tar.gz",
        archiveFormat: "tar.gz",
        binaryPathInArchive: "ripgrep-15.1.0-x86_64-apple-darwin/rg",
        sha256: "64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882",
      },
      "aarch64-unknown-linux-gnu": {
        targetTriple: "aarch64-unknown-linux-gnu",
        assetName: "ripgrep-15.1.0-aarch64-unknown-linux-gnu.tar.gz",
        archiveFormat: "tar.gz",
        binaryPathInArchive: "ripgrep-15.1.0-aarch64-unknown-linux-gnu/rg",
        sha256: "2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e",
      },
      "x86_64-unknown-linux-gnu": {
        targetTriple: "x86_64-unknown-linux-gnu",
        assetName: "ripgrep-15.1.0-x86_64-unknown-linux-musl.tar.gz",
        archiveFormat: "tar.gz",
        binaryPathInArchive: "ripgrep-15.1.0-x86_64-unknown-linux-musl/rg",
        sha256: "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599",
      },
    },
  },
  "ast-grep": {
    binaryId: "ast-grep",
    version: "0.42.3",
    github: { owner: "ast-grep", name: "ast-grep" },
    assetNameTemplate: "app-{targetTriple}.zip",
    binaryName: "ast-grep",
    platforms: {
      "aarch64-apple-darwin": {
        targetTriple: "aarch64-apple-darwin",
        assetName: "app-aarch64-apple-darwin.zip",
        archiveFormat: "zip",
        binaryPathInArchive: "ast-grep",
        sha256: "12a870c414c90208f338649b0b53d9659b724b680edaf9da9c151275dad3e41a",
      },
      "x86_64-apple-darwin": {
        targetTriple: "x86_64-apple-darwin",
        assetName: "app-x86_64-apple-darwin.zip",
        archiveFormat: "zip",
        binaryPathInArchive: "ast-grep",
        sha256: "af5a04a43c062974634296f692ab93c03755e5b6f33e70e226a434cde1355a1f",
      },
      "aarch64-unknown-linux-gnu": {
        targetTriple: "aarch64-unknown-linux-gnu",
        assetName: "app-aarch64-unknown-linux-gnu.zip",
        archiveFormat: "zip",
        binaryPathInArchive: "ast-grep",
        sha256: "46f7ffedb5f770f58bf59bd8792009dc71ec34c94e0bd1b4575ba639f32a9889",
      },
      "x86_64-unknown-linux-gnu": {
        targetTriple: "x86_64-unknown-linux-gnu",
        assetName: "app-x86_64-unknown-linux-gnu.zip",
        archiveFormat: "zip",
        binaryPathInArchive: "ast-grep",
        sha256: "4191ac4247d183c502778e740a68b7cf45fe477b6423c43b8b8d6e732ba3b333",
      },
    },
  },
} satisfies BinaryManifest);

export function getBinarySpec(binaryId: SupportedBinaryId): BinarySpec {
  return BINARY_MANIFEST[binaryId];
}

export function getBinaryReleaseUrl(spec: BinarySpec, assetName: string): string {
  return `https://github.com/${spec.github.owner}/${spec.github.name}/releases/download/${spec.version}/${assetName}`;
}
