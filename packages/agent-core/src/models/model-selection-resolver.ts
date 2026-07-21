import type {
  ExecutionModelBindingSummary,
  ModelBindingResolution,
  ModelSelectionRef,
  RequestedModelSelection,
} from "@archcode/protocol";
import type { ModelCallOptions, ProfileName } from "../config";
import type { ExecutionModelBinding } from "./execution-model-binding";
import { cloneAndFreeze, deepFreeze } from "./immutable";
import type {
  ModelRuntimeSnapshot,
  ResolvedSnapshotSelection,
} from "./model-runtime-snapshot";

export interface ResolveExecutionModelBindingInput {
  readonly snapshot: ModelRuntimeSnapshot;
  readonly profile: ProfileName;
  readonly requested?: RequestedModelSelection;
  readonly sessionOverride?: ModelSelectionRef;
}

export class ModelSelectionResolutionError extends Error {
  constructor(
    public readonly profile: ProfileName,
    message: string,
  ) {
    super(message);
    this.name = "ModelSelectionResolutionError";
  }
}

/** Sole domain owner for resolving and freezing a new Execution model binding. */
export class ModelSelectionResolver {
  resolve(input: ResolveExecutionModelBindingInput): ExecutionModelBinding {
    const candidate = selectCandidate(input);
    const variantOptions = candidate.resolved.selection.variant === undefined
      ? undefined
      : candidate.resolved.modelConfig.variants?.[candidate.resolved.selection.variant];
    const options = mergeModelCallOptions(
      candidate.resolved.modelConfig.options,
      variantOptions,
      candidate.applyProfileOptions ? input.snapshot.getProfileOptions(input.profile) : undefined,
    );
    const summary: ExecutionModelBindingSummary = deepFreeze({
      selection: candidate.resolved.selection,
      providerId: candidate.resolved.modelInfo.providerId,
      modelId: candidate.resolved.modelInfo.modelId,
      providerDisplayName: input.snapshot.getProviderDisplayName(
        candidate.resolved.modelInfo.providerId,
      ),
      modelDisplayName: candidate.resolved.modelInfo.displayName,
      resolution: candidate.resolution,
      modelRuntimeRevision: input.snapshot.revision,
    });

    return Object.freeze({
      modelInfo: candidate.resolved.modelInfo,
      options,
      summary,
    });
  }
}

function selectCandidate(input: ResolveExecutionModelBindingInput): {
  readonly resolved: ResolvedSnapshotSelection;
  readonly resolution: ModelBindingResolution;
  readonly applyProfileOptions: boolean;
} {
  if (input.requested) {
    if (input.requested.mode === "profile_default") {
      return resolveProfileDefault(input);
    }
    const requested = input.snapshot.tryResolveSelection(input.requested.selection);
    if (requested) return { resolved: requested, resolution: "requested", applyProfileOptions: false };
  }

  if (input.sessionOverride) {
    const sessionOverride = input.snapshot.tryResolveSelection(input.sessionOverride);
    if (sessionOverride) {
      return { resolved: sessionOverride, resolution: "session_override", applyProfileOptions: false };
    }
  }

  return resolveProfileDefault(input);
}

function resolveProfileDefault(input: ResolveExecutionModelBindingInput): {
  readonly resolved: ResolvedSnapshotSelection;
  readonly resolution: "profile_default";
  readonly applyProfileOptions: true;
} {
  const profileDefault = input.snapshot.getProfileDefault(input.profile);
  const resolvedDefault = input.snapshot.tryResolveSelection(profileDefault);
  if (!resolvedDefault) {
    throw new ModelSelectionResolutionError(
      input.profile,
      `Profile "${input.profile}" has an invalid default model selection`,
    );
  }

  return { resolved: resolvedDefault, resolution: "profile_default", applyProfileOptions: true };
}

function mergeModelCallOptions(
  ...layers: Array<ModelCallOptions | undefined>
): Readonly<ModelCallOptions> | undefined {
  let merged: ModelCallOptions | undefined;

  for (const layer of layers) {
    if (layer === undefined) continue;
    merged = { ...merged, ...layer };
  }

  return merged === undefined ? undefined : cloneAndFreeze(merged);
}
