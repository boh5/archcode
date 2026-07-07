import { apiFetch } from "./client";
import type {
  CompressionBlockRef,
  CompressionBlockStatus,
  CompressionMessageRef,
  CompressionRangeSnapshot,
  CompressionStrategy,
  CompressionTrigger,
  SessionPart,
} from "@archcode/protocol";

// ─── Original-range response types ───
// These mirror the server's CompressionOriginalRangeResult success shape from
// agent-core. Web cannot depend on agent-core, so the types are defined locally
// and kept structurally compatible with the JSON returned by
// GET /api/projects/:slug/sessions/:sessionId/compression/:blockRef/original.

export interface PersistedOutputReference {
  readonly kind: "tool-output";
  readonly ref: string;
  readonly truncated: true;
  readonly preview: string;
}

export type OriginalRangePart = SessionPart & {
  persistedOutput?: PersistedOutputReference;
};

export interface OriginalRangeMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly parts: OriginalRangePart[];
  readonly createdAt: number;
  readonly completedAt?: number;
  readonly executionId?: string;
  readonly compacted?: boolean;
}

export interface CompressionOriginalRangeEntry {
  readonly ref: CompressionMessageRef;
  readonly message: OriginalRangeMessage;
}

export interface CompressionOriginalRangeSuccess {
  readonly ok: true;
  readonly blockRef: CompressionBlockRef;
  readonly blockId: string;
  readonly status: CompressionBlockStatus;
  readonly strategy: CompressionStrategy;
  readonly trigger: CompressionTrigger;
  readonly childBlockRefs: CompressionBlockRef[];
  readonly range: CompressionRangeSnapshot;
  readonly coveredRefs: CompressionMessageRef[];
  readonly coveredMessageIds: string[];
  readonly messages: CompressionOriginalRangeEntry[];
}

/**
 * Fetch the original covered range for a compression block.
 *
 * Calls `GET /api/projects/:slug/sessions/:sessionId/compression/:blockRef/original`
 * with URL-encoded parameters. Returns the success payload on HTTP 200; throws
 * `ApiError` on 404 (block not found), 422 (unsupported/legacy), or other errors.
 *
 * This is intentionally lazy — the caller (UI) should only invoke this when the
 * user explicitly requests the original range.
 */
export async function fetchCompressionOriginalRange(
  slug: string,
  sessionId: string,
  blockRef: string,
): Promise<CompressionOriginalRangeSuccess> {
  return apiFetch<CompressionOriginalRangeSuccess>(
    `/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/compression/${encodeURIComponent(blockRef)}/original`,
  );
}