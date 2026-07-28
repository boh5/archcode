import type { CompressionStateSnapshot } from "@archcode/protocol";
import { compressionStateSnapshot } from "../compression/dynamic-range";
import type { CompressionState } from "../compression";

/**
 * Converts the persisted runtime compression model into the public Session
 * read projection. Persistence keeps the structured summary while the Web
 * boundary receives the rendered authoritative Protocol snapshot.
 */
export function projectSessionCompression(
  state: CompressionState,
): CompressionStateSnapshot {
  return compressionStateSnapshot(state);
}
