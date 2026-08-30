import type {
  FinalizedToolResult,
  HitlDisplayPayload,
  HitlSource,
  JsonObject,
  ToolResultDetails,
  LoadedToolRef,
} from "@archcode/protocol";

export type OutputPreviewDirection = "head" | "head-tail";

export type ToolOutputPolicy =
  | { kind: "source"; previewDirection: "head" }
  | { kind: "artifact"; previewDirection: OutputPreviewDirection }
  | { kind: "inline"; previewDirection: OutputPreviewDirection };

export interface TextDraft {
  readonly kind: "text";
  readonly text: string;
}

export interface SourcePageDraft {
  readonly kind: "source";
  readonly text: string;
  readonly nextInput?: JsonObject;
}

/** Marker for the capture owned by the current Registry execution context. */
export interface CaptureDraft {
  readonly kind: "capture";
}

export type ToolOutputDraft = TextDraft | SourcePageDraft | CaptureDraft;

/** Details before final size and shape validation. */
export type RawToolDetails = ToolResultDetails;

/** Runtime-only effects. This object must never enter Session persistence or SSE. */
export interface ToolExecutionSidecar {
  readonly sessionCwdChanged?: true;
  /** Successful tool result is a terminal control boundary for the current Execution. */
  readonly executionCompleted?: true;
  /** Tool contracts loaded into the owning logical Execution after this result settles. */
  readonly loadedToolRefs?: readonly LoadedToolRef[];
}

export interface RawToolResult {
  readonly isError: boolean;
  readonly draft: ToolOutputDraft;
  readonly details?: RawToolDetails;
  readonly sidecar?: ToolExecutionSidecar;
}

/** Runtime-only durable identity for one synchronous child tool dependency. */
export interface ChildToolDependency {
  readonly parentExecutionId: string;
  readonly runOrdinal: number;
  readonly toolBatchId: string;
  readonly toolCallId: string;
  readonly childSessionId: string;
  readonly childExecutionId: string;
}

/** Descriptor-to-Registry control result. It never enters Raw-to-Finalized output. */
export interface ChildDeferredToolResult {
  readonly kind: "child_deferred";
  readonly dependency: ChildToolDependency;
}

export type ToolDescriptorExecutionResult = RawToolResult | ChildDeferredToolResult;

export interface AskUserToolBlockedRequest {
  readonly source: Extract<HitlSource, { type: "ask_user" }>;
  readonly displayPayload: HitlDisplayPayload;
}

export interface PermissionToolBlockedRequest {
  readonly source: Extract<HitlSource, { type: "tool_permission" }>;
  readonly displayPayload: HitlDisplayPayload;
  readonly permissionFingerprint: string;
  readonly persistentApprovalEligible: boolean;
  readonly permission: {
    readonly description: string;
    readonly reason?: string;
    readonly decisionDisplay?: string;
    readonly ruleId?: string;
  };
}

export type ToolBlockedRequest = AskUserToolBlockedRequest | PermissionToolBlockedRequest;

export type RegistryExecutionOutcome =
  | {
      readonly kind: "settled";
      readonly result: FinalizedToolResult;
      readonly sidecar?: ToolExecutionSidecar;
    }
  | {
      readonly kind: "blocked";
      readonly request: ToolBlockedRequest;
      readonly requestKey: string;
    }
  | {
      readonly kind: "child_deferred";
      readonly dependency: ChildToolDependency;
    };
