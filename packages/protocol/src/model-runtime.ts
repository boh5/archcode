/** A concrete configured model and optional variant. `model` is provider-qualified. */
export interface ModelSelectionRef {
  model: string;
  variant?: string;
}

/** The only user-visible Session selection modes. */
export type ModelSelectionMode = "agent_default" | "session_override";

/** The selection shown by the Composer when a message was accepted. */
export interface RequestedModelSelection {
  mode: ModelSelectionMode;
  selection: ModelSelectionRef;
}

/** Durable Session-local selection state. Absence of override means Agent default. */
export interface SessionModelSelection {
  revision: number;
  override?: ModelSelectionRef;
}

/** How a new Execution obtained its actual model selection. */
export type ModelBindingResolution =
  | "requested"
  | "session_override"
  | "agent_default";

/**
 * Secret-free, durable identity for the model fixed to one Execution.
 *
 * Execution origin remains a separate Session execution field; `resolution`
 * describes model selection only.
 */
export interface ExecutionModelBindingSummary {
  selection: ModelSelectionRef;
  providerId: string;
  modelId: string;
  providerDisplayName: string;
  modelDisplayName: string;
  resolution: ModelBindingResolution;
  modelRuntimeRevision: string;
}

export type MessageModelAuditReason = "config_invalidated";

/** Per-message requested-versus-actual model audit. */
export interface MessageModelAudit {
  requested: RequestedModelSelection;
  actual: ModelSelectionRef;
  reason?: MessageModelAuditReason;
}

/** What the Composer must submit if a new Execution starts now. */
export interface SessionNextModelSelection {
  requested: RequestedModelSelection;
  resolved: ExecutionModelBindingSummary;
}

/** Complete Session model state returned by the selection GET/PATCH boundary. */
export interface SessionModelState {
  modelSelection: SessionModelSelection;
  nextModelSelection: SessionNextModelSelection;
  activeModelBinding?: ExecutionModelBindingSummary;
}

/** One configured model exposed by the secret-free runtime catalog. */
export interface ModelRuntimeModelDescriptor {
  id: string;
  qualifiedId: string;
  displayName: string;
  variants: readonly string[];
}

/** One configured Provider exposed by the secret-free runtime catalog. */
export interface ModelRuntimeProviderDescriptor {
  id: string;
  displayName: string;
  models: readonly ModelRuntimeModelDescriptor[];
}

/** Safe Composer-facing view of the currently published model runtime. */
export interface ModelRuntimeCatalog {
  revision: string;
  providers: readonly ModelRuntimeProviderDescriptor[];
  agentDefaults: Readonly<Record<string, ModelSelectionRef>>;
}

/** Secret-free Settings metadata for one common Provider factory option. */
export interface ProviderAdapterOptionDescriptor {
  path: string;
  label: string;
  kind: "string" | "url" | "number" | "boolean" | "json";
  required: boolean;
  secret: boolean;
}

/** One statically bundled AI SDK Provider adapter exposed to Settings. */
export interface ProviderAdapterDescriptor {
  npmPackage: string;
  displayName: string;
  fields: readonly ProviderAdapterOptionDescriptor[];
}

/** Safe Settings-facing Provider adapter catalog. */
export type ProviderAdapterCatalog = readonly ProviderAdapterDescriptor[];

/** Invalidates Web model catalog reads after an atomic runtime publish. */
export interface GlobalSSEModelRuntimeChangedEvent {
  type: "model_runtime.changed";
  revision: string;
  createdAt: number;
}
