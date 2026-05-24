import { z } from "zod";

export const SupportedBinaryIdSchema = z.enum(["rg", "ast-grep"]);

export const SupportedTargetTripleSchema = z.enum([
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "aarch64-unknown-linux-gnu",
  "x86_64-unknown-linux-gnu",
]);

export const ArchiveFormatSchema = z.enum(["tar.gz", "zip"]);

export const GithubRepoSchema = z
  .object({
    owner: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

export const BinaryPlatformSpecSchema = z
  .object({
    targetTriple: SupportedTargetTripleSchema,
    assetName: z.string().min(1),
    archiveFormat: ArchiveFormatSchema,
    binaryPathInArchive: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const BinarySpecSchema = z
  .object({
    binaryId: SupportedBinaryIdSchema,
    version: z.string().min(1),
    github: GithubRepoSchema,
    assetNameTemplate: z.string().min(1),
    binaryName: z.string().min(1),
    platforms: z.record(SupportedTargetTripleSchema, BinaryPlatformSpecSchema),
  })
  .strict();

export const BinaryManifestSchema = z.record(SupportedBinaryIdSchema, BinarySpecSchema);

export type SupportedBinaryId = z.infer<typeof SupportedBinaryIdSchema>;
export type SupportedTargetTriple = z.infer<typeof SupportedTargetTripleSchema>;
export type ArchiveFormat = z.infer<typeof ArchiveFormatSchema>;
export type GithubRepo = z.infer<typeof GithubRepoSchema>;
export type BinaryPlatformSpec = z.infer<typeof BinaryPlatformSpecSchema>;
export type BinarySpec = z.infer<typeof BinarySpecSchema>;
export type BinaryManifest = z.infer<typeof BinaryManifestSchema>;
