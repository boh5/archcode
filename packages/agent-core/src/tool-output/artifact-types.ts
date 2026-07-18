export type OutputRef = string & { readonly __outputRef: unique symbol };

export interface ArtifactAuthorizationScope {
  readonly projectIdentity: string;
  readonly rootSessionId: string;
}

export interface ArtifactOwner extends ArtifactAuthorizationScope {
  readonly producerSessionId: string;
}

export type ArtifactCompleteness = "complete" | "partial";
export type ArtifactSegmentKind = "full" | "head" | "tail";

export interface ArtifactSegmentMetadata {
  readonly kind: ArtifactSegmentKind;
  readonly fileName: "body.txt" | "head.txt" | "tail.txt";
  readonly canonicalStart: number;
  readonly canonicalEnd: number;
  readonly bytes: number;
  readonly lines: number;
}

export interface ArtifactMetadata {
  readonly version: 1;
  readonly outputRef: OutputRef;
  readonly owner: ArtifactOwner;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly lastAccessedAt: number;
  readonly completeness: ArtifactCompleteness;
  readonly observed: { readonly bytes: number; readonly lines: number };
  readonly canonical: { readonly bytes: number; readonly lines: number };
  readonly stored: { readonly bytes: number; readonly lines: number };
  readonly omitted: { readonly bytes: number; readonly lines: number };
  readonly segments: readonly ArtifactSegmentMetadata[];
}

export interface ArtifactPublicMetadata {
  readonly outputRef: OutputRef;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly completeness: ArtifactCompleteness;
  readonly observed: ArtifactMetadata["observed"];
  readonly canonical: ArtifactMetadata["canonical"];
  readonly stored: ArtifactMetadata["stored"];
  readonly omitted: ArtifactMetadata["omitted"];
}

export interface ArtifactProjection {
  readonly preview: string;
  readonly completeness: ArtifactCompleteness;
  readonly previewBytes: number;
  readonly previewLines: number;
  readonly omittedBytes: number;
}

export interface CreateArtifactInput {
  readonly owner: ArtifactOwner;
  /** Canonical text that has already passed the Runtime redaction policy. */
  readonly canonical: string | Uint8Array;
  readonly observedBytes?: number;
  readonly observedLines?: number;
  readonly previewDirection?: "head" | "head-tail";
}

export interface CreatedArtifact {
  readonly outputRef: OutputRef;
  readonly metadata: ArtifactPublicMetadata;
  readonly projection: ArtifactProjection;
}

export interface OutputReadInput extends ArtifactAuthorizationScope {
  readonly outputRef: string;
  readonly cursor?: string;
  readonly limit?: number;
  /** Internal response-content budget; never exposed in the model/API schema. */
  readonly maxContentBytes?: number;
}

export interface OutputReadRecord {
  readonly segment: ArtifactSegmentKind;
  readonly canonicalStart: number;
  readonly canonicalEnd: number;
  readonly text: string;
  readonly continuedFromPrevious: boolean;
  readonly continuesNext: boolean;
}

export interface OutputReadPage {
  readonly outputRef: OutputRef;
  readonly completeness: ArtifactCompleteness;
  readonly records: readonly OutputReadRecord[];
  readonly nextCursor?: string;
  readonly gap?: { readonly canonicalStart: number; readonly canonicalEnd: number };
}

export interface ArtifactSearchSegment {
  readonly kind: ArtifactSegmentKind;
  /** Internal-only storage path. It must never be returned by a Tool/API surface. */
  readonly path: string;
  readonly canonicalStart: number;
  readonly canonicalEnd: number;
}

export interface ArtifactSearchRunnerMatch {
  readonly segment: ArtifactSegmentKind;
  readonly canonicalStart: number;
  readonly canonicalEnd: number;
  readonly snippet: string;
}

export interface ArtifactSearchRunner {
  search(input: {
    readonly segments: readonly ArtifactSearchSegment[];
    readonly pattern: string;
    readonly cursor?: string;
    readonly limit: number;
    readonly maxContentBytes: number;
    readonly deadlineAt: number;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly matches: readonly ArtifactSearchRunnerMatch[];
    readonly nextCursor?: string;
  }>;
}

export interface OutputSearchInput extends ArtifactAuthorizationScope {
  readonly outputRef?: string;
  readonly pattern: string;
  readonly cursor?: string;
  readonly limit?: number;
  /** Internal response-content budget; never exposed in the model/API schema. */
  readonly maxContentBytes?: number;
}

export interface OutputSearchPage {
  readonly outputRef?: OutputRef;
  readonly matches: readonly OutputSearchMatch[];
  readonly nextCursor?: string;
  readonly searchCompleteness: "complete" | "partial_artifact";
}

export interface OutputSearchMatch extends ArtifactSearchRunnerMatch {
  readonly outputRef: OutputRef;
}

export type ArtifactTombstoneReason = "expired" | "evicted";

export interface ArtifactTombstone {
  readonly version: 1;
  readonly outputRef: OutputRef;
  readonly owner: ArtifactOwner;
  readonly deletedAt: number;
  readonly expiresAt: number;
  readonly reason: ArtifactTombstoneReason;
}
