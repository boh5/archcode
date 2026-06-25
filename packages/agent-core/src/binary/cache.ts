import { join } from "node:path";
import type { BinarySpec, SupportedTargetTriple } from "./types";

export interface BinaryCacheEnv {
  XDG_CACHE_HOME?: string;
  HOME?: string;
}

function currentBinaryCacheEnv(): BinaryCacheEnv {
  return {
    XDG_CACHE_HOME: Bun.env.XDG_CACHE_HOME,
    HOME: Bun.env.HOME,
  };
}

export class UnsupportedBinaryPlatformError extends Error {
  readonly platform: string;
  readonly arch: string;

  constructor(params: { platform: string; arch: string }) {
    super(`Unsupported binary platform: ${params.platform}/${params.arch}`);
    this.name = "UnsupportedBinaryPlatformError";
    this.platform = params.platform;
    this.arch = params.arch;
  }
}

export function getBinaryCacheBaseDir(env: BinaryCacheEnv = currentBinaryCacheEnv()): string {
  const base = env.XDG_CACHE_HOME ?? (env.HOME ? join(env.HOME, ".cache") : import.meta.dir);
  return join(base, "archcode", "bin");
}

export function getBinaryCacheDir(params: {
  spec: Pick<BinarySpec, "binaryId" | "version">;
  targetTriple: SupportedTargetTriple;
  env?: BinaryCacheEnv;
}): string {
  return join(getBinaryCacheBaseDir(params.env), params.targetTriple, params.spec.binaryId, params.spec.version);
}

export function getBinaryCachePath(params: {
  spec: Pick<BinarySpec, "binaryId" | "version" | "binaryName">;
  targetTriple: SupportedTargetTriple;
  env?: BinaryCacheEnv;
}): string {
  return join(getBinaryCacheDir(params), params.spec.binaryName);
}

export function getCurrentTargetTriple(input: { platform?: string; arch?: string } = {}): SupportedTargetTriple {
  return targetTripleForPlatform(input.platform ?? process.platform, input.arch ?? process.arch);
}

export function targetTripleForPlatform(platform: string, arch: string): SupportedTargetTriple {
  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  if (platform === "linux" && arch === "arm64") return "aarch64-unknown-linux-gnu";
  if (platform === "linux" && arch === "x64") return "x86_64-unknown-linux-gnu";

  throw new UnsupportedBinaryPlatformError({ platform, arch });
}
