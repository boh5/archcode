import type {
  ExecutionModelBindingSummary,
  ModelBindingResolution,
  ModelSelectionRef,
  RequestedModelSelection,
} from "@archcode/protocol";
import type { ModelCallOptions } from "../config";
import type { ExecutionModelBinding } from "./execution-model-binding";
import { cloneAndFreeze, deepFreeze } from "./immutable";
import type {
  ModelRuntimeSnapshot,
  ResolvedSnapshotSelection,
} from "./model-runtime-snapshot";

export interface ResolveExecutionModelBindingInput {
  readonly snapshot: ModelRuntimeSnapshot;
  readonly agentName: string;
  readonly requested?: RequestedModelSelection;
  readonly sessionOverride?: ModelSelectionRef;
}

export class ModelSelectionResolutionError extends Error {
  constructor(
    public readonly agentName: string,
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
    const agentOptions = input.snapshot.getAgentOptions(input.agentName);
    const variantOptions = candidate.resolved.selection.variant === undefined
      ? undefined
      : candidate.resolved.modelConfig.variants?.[candidate.resolved.selection.variant];
    const options = mergeModelCallOptions(
      candidate.resolved.modelConfig.options,
      variantOptions,
      agentOptions,
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
} {
  if (input.requested) {
    const requested = input.snapshot.tryResolveSelection(input.requested.selection);
    if (requested) return { resolved: requested, resolution: "requested" };
  }

  if (input.sessionOverride) {
    const sessionOverride = input.snapshot.tryResolveSelection(input.sessionOverride);
    if (sessionOverride) {
      return { resolved: sessionOverride, resolution: "session_override" };
    }
  }

  const agentDefault = input.snapshot.getAgentDefault(input.agentName);
  if (!agentDefault) {
    throw new ModelSelectionResolutionError(
      input.agentName,
      `Agent "${input.agentName}" does not have a configured default model`,
    );
  }
  const resolvedDefault = input.snapshot.tryResolveSelection(agentDefault);
  if (!resolvedDefault) {
    throw new ModelSelectionResolutionError(
      input.agentName,
      `Agent "${input.agentName}" has an invalid default model selection`,
    );
  }

  return { resolved: resolvedDefault, resolution: "agent_default" };
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
