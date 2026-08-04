import type { ProviderAdapterCatalog } from "./model-runtime";
import type { ServerConfigUpdate, ServerConfigValidationIssue } from "./types";

/** Public, redacted server state used before the workbench is allowed to mount. */
export type RuntimeStatus =
  | { state: "activating" }
  | { state: "ready" }
  | {
    state: "error";
    error: {
      message: string;
      /** False when a failed Runtime candidate could not be fully shut down. */
      recoveryAllowed: boolean;
    };
  };

export type BootstrapStatus =
  | { mode: "setup" }
  | {
    mode: "ready";
    authRequired: boolean;
    authenticated: boolean;
    runtime: RuntimeStatus;
  }
  | { mode: "config_error"; message: string };

/** Safe structural diagnostics and bounded manual recovery choices for an invalid global Config. */
export interface ConfigRecoveryStatus {
  configPath: string;
  issues: ServerConfigValidationIssue[];
  /** Current invalid-file revision used to reject stale selective removal. */
  revision?: string;
  removableItems: ConfigRecoveryRemovableItem[];
}

export interface ConfigRecoveryRemovableItem {
  /** Opaque server-derived identity; never contains a Config key or value. */
  id: string;
  label: string;
  path: string;
  impact: string;
}

export interface ConfigRecoveryActionResponse {
  status: BootstrapStatus;
  /** Present only when the Config remains invalid after a retry. */
  recovery?: ConfigRecoveryStatus;
}

export interface ResetInvalidConfigRequest {
  confirmation: "DELETE_INVALID_CONFIG";
}

export interface RemoveInvalidConfigItemsRequest {
  expectedRevision: string;
  itemIds: string[];
  confirmation: "REMOVE_SELECTED_INVALID_CONFIG_ITEMS";
}

/**
 * The setup grant is deliberately transported in an Authorization header, not
 * in this DTO. `config` uses the ordinary editable shape so the controlled
 * model editor has one draft representation in setup and Settings.
 */
export type CompleteSetupRequest =
  | {
    config: ServerConfigUpdate;
    requireLogin: true;
    /** Setup-only plaintext input. Never returned by an API. */
    password: string;
  }
  | {
    config: ServerConfigUpdate;
    requireLogin: false;
    password?: never;
  };

export interface CompleteSetupResponse {
  status: Extract<BootstrapStatus, { mode: "ready" }>;
}

/** Setup mode exposes only this static catalog; it exposes no Runtime state. */
export type SetupProviderAdapterCatalogResponse = ProviderAdapterCatalog;
