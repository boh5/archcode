import type { ProviderAdapterCatalog } from "./model-runtime";
import type { ServerConfigUpdate } from "./types";

/** Public, redacted server state used before the workbench is allowed to mount. */
export type BootstrapStatus =
  | { mode: "setup" }
  | { mode: "activating" }
  | { mode: "ready"; authRequired: boolean; authenticated: boolean }
  | { mode: "config_error"; message: string }
  | { mode: "startup_error"; message: string };

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
