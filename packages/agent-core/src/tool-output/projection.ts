import {
  TOOL_OUTPUT_PREVIEW_MAX_BYTES,
  TOOL_OUTPUT_PREVIEW_MAX_LINES,
} from "./constants";
import type { ArtifactProjection } from "./artifact-types";
import {
  countUtf8Lines,
  decodeUtf8,
  headBoundary,
  tailBoundary,
  utf8ByteLength,
} from "./utf8";

const OMITTED_MARKER = "\n… output omitted …\n";

export interface ProjectionLimits {
  readonly maxBytes: number;
  readonly maxLines: number;
}

export function projectCanonicalText(
  bytes: Uint8Array,
  direction: "head" | "head-tail" = "head-tail",
  limits: ProjectionLimits = {
    maxBytes: TOOL_OUTPUT_PREVIEW_MAX_BYTES,
    maxLines: TOOL_OUTPUT_PREVIEW_MAX_LINES,
  },
): ArtifactProjection {
  if (bytes.byteLength <= limits.maxBytes && countUtf8Lines(bytes) <= limits.maxLines) {
    return {
      preview: decodeUtf8(bytes),
      completeness: "complete",
      previewBytes: bytes.byteLength,
      previewLines: countUtf8Lines(bytes),
      omittedBytes: 0,
    };
  }

  if (direction === "head") {
    const end = headBoundary(bytes, limits.maxBytes, limits.maxLines);
    const previewBytes = bytes.subarray(0, end);
    return {
      preview: decodeUtf8(previewBytes),
      completeness: "partial",
      previewBytes: previewBytes.byteLength,
      previewLines: countUtf8Lines(previewBytes),
      omittedBytes: bytes.byteLength - end,
    };
  }

  const markerBytes = utf8ByteLength(OMITTED_MARKER);
  if (limits.maxBytes <= markerBytes || limits.maxLines <= 2) {
    const end = headBoundary(bytes, limits.maxBytes, limits.maxLines);
    const previewBytes = bytes.subarray(0, end);
    return {
      preview: decodeUtf8(previewBytes),
      completeness: "partial",
      previewBytes: previewBytes.byteLength,
      previewLines: countUtf8Lines(previewBytes),
      omittedBytes: bytes.byteLength - end,
    };
  }

  const contentBudget = limits.maxBytes - markerBytes;
  const headByteBudget = Math.floor(contentBudget / 2);
  const tailByteBudget = contentBudget - headByteBudget;
  const headLineBudget = Math.floor((limits.maxLines - 2) / 2);
  const tailLineBudget = limits.maxLines - 2 - headLineBudget;
  const headEnd = headBoundary(bytes, headByteBudget, Math.max(1, headLineBudget));
  let tailStart = tailBoundary(bytes, tailByteBudget, Math.max(1, tailLineBudget));
  if (tailStart < headEnd) tailStart = headEnd;
  const preview = `${decodeUtf8(bytes.subarray(0, headEnd))}${OMITTED_MARKER}${decodeUtf8(bytes.subarray(tailStart))}`;
  return {
    preview,
    completeness: "partial",
    previewBytes: utf8ByteLength(preview),
    previewLines: countUtf8Lines(new TextEncoder().encode(preview)),
    omittedBytes: tailStart - headEnd,
  };
}
