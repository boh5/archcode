import { open } from "node:fs/promises";
import {
  MAX_ARCHIVE_BYTES,
  MAX_ATTESTATION_BYTES,
  MAX_MANIFEST_BYTES,
  RELEASE_ATTESTATION_ASSET_NAME,
  RELEASE_BASE_URL,
  RELEASE_MANIFEST_ASSET_NAME,
} from "./constants";
import { UpdateError } from "./errors";
import {
  parseReleaseManifest,
  type ReleaseArchiveAsset,
  type ReleaseManifest,
} from "./manifest";
import { verifyReleaseAttestation } from "./trust";

const METADATA_TIMEOUT_MS = 30_000;
const ARCHIVE_TIMEOUT_MS = 10 * 60 * 1000;
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

export interface VerifiedRelease {
  manifest: ReleaseManifest;
  releaseUrl: string;
}

export interface ReleaseClientOptions {
  fetch?: typeof globalThis.fetch;
}

export interface ReleaseClientPort {
  fetchLatest(): Promise<VerifiedRelease>;
  downloadArchive(input: {
    manifest: ReleaseManifest;
    asset: ReleaseArchiveAsset;
    destinationPath: string;
    onProgress?: (downloadedBytes: number, totalBytes?: number) => void;
  }): Promise<void>;
}

export class ReleaseClient implements ReleaseClientPort {
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: ReleaseClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async fetchLatest(): Promise<VerifiedRelease> {
    const manifestBytes = await this.#fetchBytes(
      `${RELEASE_BASE_URL}/latest/download/${RELEASE_MANIFEST_ASSET_NAME}`,
      MAX_MANIFEST_BYTES,
      METADATA_TIMEOUT_MS,
    );
    let rawManifest: unknown;
    try {
      rawManifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown;
    } catch (error) {
      throw new UpdateError(
        "UPDATE_MANIFEST_INVALID",
        "The latest release manifest is not valid JSON",
        { cause: error },
      );
    }
    const manifest = parseReleaseManifest(rawManifest);
    const bundleBytes = await this.#fetchBytes(
      releaseAssetUrl(manifest.tag, RELEASE_ATTESTATION_ASSET_NAME),
      MAX_ATTESTATION_BYTES,
      METADATA_TIMEOUT_MS,
    );
    let bundle: unknown;
    try {
      bundle = JSON.parse(new TextDecoder().decode(bundleBytes)) as unknown;
    } catch (error) {
      throw new UpdateError(
        "UPDATE_ATTESTATION_INVALID",
        "The release attestation is not valid JSON",
        { cause: error },
      );
    }
    verifyReleaseAttestation({
      bundle,
      manifest,
      manifestBytes,
    });
    return {
      manifest,
      releaseUrl: `${RELEASE_BASE_URL}/tag/${manifest.tag}`,
    };
  }

  async downloadArchive(input: {
    manifest: ReleaseManifest;
    asset: ReleaseArchiveAsset;
    destinationPath: string;
    onProgress?: (downloadedBytes: number, totalBytes?: number) => void;
  }): Promise<void> {
    if (input.asset.size > MAX_ARCHIVE_BYTES) {
      throw new UpdateError(
        "UPDATE_ARCHIVE_INVALID",
        `Release archive ${input.asset.name} exceeds the direct-update size limit`,
      );
    }
    const response = await this.#request(
      releaseAssetUrl(input.manifest.tag, input.asset.name),
      ARCHIVE_TIMEOUT_MS,
    );
    const declaredLength = parseContentLength(response.headers.get("content-length"));
    if (
      declaredLength !== undefined
      && (declaredLength !== input.asset.size || declaredLength > MAX_ARCHIVE_BYTES)
    ) {
      throw new UpdateError(
        "UPDATE_ARCHIVE_INVALID",
        `Release archive ${input.asset.name} has an unexpected size`,
      );
    }
    if (response.body === null) {
      throw new UpdateError(
        "UPDATE_DOWNLOAD_FAILED",
        `Release archive ${input.asset.name} has no response body`,
      );
    }

    const file = await open(input.destinationPath, "wx", 0o600);
    let downloadedBytes = 0;
    try {
      const reader = response.body.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        downloadedBytes += chunk.value.byteLength;
        if (
          downloadedBytes > input.asset.size
          || downloadedBytes > MAX_ARCHIVE_BYTES
        ) {
          await reader.cancel();
          throw new UpdateError(
            "UPDATE_ARCHIVE_INVALID",
            `Release archive ${input.asset.name} exceeds its signed size`,
          );
        }
        let offset = 0;
        while (offset < chunk.value.byteLength) {
          const result = await file.write(
            chunk.value,
            offset,
            chunk.value.byteLength - offset,
          );
          offset += result.bytesWritten;
        }
        input.onProgress?.(
          downloadedBytes,
          declaredLength ?? input.asset.size,
        );
      }
      if (downloadedBytes !== input.asset.size) {
        throw new UpdateError(
          "UPDATE_ARCHIVE_INVALID",
          `Release archive ${input.asset.name} does not match its signed size`,
        );
      }
      await file.sync();
    } finally {
      await file.close();
    }
  }

  async #fetchBytes(
    url: string,
    maximumBytes: number,
    timeoutMs: number,
  ): Promise<Uint8Array> {
    const response = await this.#request(url, timeoutMs);
    const declaredLength = parseContentLength(response.headers.get("content-length"));
    if (declaredLength !== undefined && declaredLength > maximumBytes) {
      throw new UpdateError(
        "UPDATE_DOWNLOAD_FAILED",
        "Release metadata exceeds the allowed size",
      );
    }
    if (response.body === null) {
      throw new UpdateError(
        "UPDATE_DOWNLOAD_FAILED",
        "Release metadata has no response body",
      );
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new UpdateError(
          "UPDATE_DOWNLOAD_FAILED",
          "Release metadata exceeds the allowed size",
        );
      }
      chunks.push(chunk.value);
    }
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }

  async #request(url: string, timeoutMs: number): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: {
          Accept: "application/octet-stream",
          "User-Agent": "ArchCode-Updater",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new UpdateError(
        "UPDATE_DOWNLOAD_FAILED",
        "Unable to download ArchCode release metadata",
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new UpdateError(
        "UPDATE_DOWNLOAD_FAILED",
        `ArchCode release download failed with HTTP ${response.status}`,
      );
    }
    const finalUrl = new URL(response.url || url);
    if (finalUrl.protocol !== "https:" || !ALLOWED_DOWNLOAD_HOSTS.has(finalUrl.hostname)) {
      throw new UpdateError(
        "UPDATE_DOWNLOAD_FAILED",
        "ArchCode release download redirected to an untrusted host",
      );
    }
    return response;
  }
}

export function releaseAssetUrl(tag: string, assetName: string): string {
  return `${RELEASE_BASE_URL}/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
