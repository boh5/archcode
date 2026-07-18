import type {
  ConfigAgentSettings,
  ConfigMcpServerSettings,
  ConfigModelCallOptions,
  ConfigModelSettings,
  ConfigProviderSettings,
  ConfigSecretMutation,
  ConfiguredSecretView,
  ModelRuntimeCatalog,
  ProviderAdapterCatalog,
  ServerConfigSnapshot as ServerConfigSnapshotView,
  ServerConfigUpdate,
  UpdateServerConfigRequest,
} from "@archcode/protocol";
import { apiFetch } from "./client";

/** Local modal draft. It is a PUT mutation, never the GET secret view. */
export type ServerConfig = ServerConfigUpdate;
export type ModelCallOptions = ConfigModelCallOptions;
export type ServerModelConfig = ConfigModelSettings;
export type ServerProviderConfig = ConfigProviderSettings<ConfigSecretMutation>;
export type ServerMcpConfig = ConfigMcpServerSettings<ConfigSecretMutation>;
export type ServerAgentName = keyof ServerConfig["agents"];
export type ServerConfigSnapshot = Omit<ServerConfigSnapshotView, "config"> & { config: ServerConfig };
export type SaveServerConfigInput = UpdateServerConfigRequest;

function isConfiguredSecret(value: unknown): value is ConfiguredSecretView {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && (value as { configured?: unknown }).configured === true;
}

function secretViewsToMutations(value: unknown): unknown {
  if (isConfiguredSecret(value)) return { action: "preserve" } satisfies ConfigSecretMutation;
  if (Array.isArray(value)) return value.map(secretViewsToMutations);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretViewsToMutations(item)]));
}

function getPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function setExistingPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  const final = segments.pop();
  if (!final) return;
  let current = target;
  for (const segment of segments) {
    const child = current[segment];
    if (child === null || typeof child !== "object" || Array.isArray(child)) return;
    current = child as Record<string, unknown>;
  }
  if (Object.prototype.hasOwnProperty.call(current, final)) current[final] = value;
}

/** Convert only catalog-declared Provider secrets and MCP headers. Generic JSON stays byte-for-byte semantic. */
export function toConfigDraft(
  snapshot: ServerConfigSnapshotView,
  adapterCatalog: ProviderAdapterCatalog,
): ServerConfigSnapshot {
  const config = structuredClone(snapshot.config) as unknown as ServerConfig;
  for (const provider of Object.values(config.provider)) {
    const adapter = adapterCatalog.find((entry) => entry.npmPackage === provider.npm);
    if (!adapter) continue;
    const options = provider.options as unknown as Record<string, unknown>;
    for (const field of adapter.fields) {
      if (!field.secret) continue;
      const value = getPath(options, field.path);
      if (value !== undefined) {
        setExistingPath(options, field.path, secretViewsToMutations(value));
      }
    }
  }
  for (const server of Object.values(config.mcp?.servers ?? {})) {
    if (server.headers !== undefined) {
      server.headers = secretViewsToMutations(server.headers) as typeof server.headers;
    }
  }
  return {
    ...snapshot,
    config,
  };
}

export async function getServerConfig(): Promise<ServerConfigSnapshotView> {
  return apiFetch<ServerConfigSnapshotView>("/api/config");
}

export async function saveServerConfig(input: SaveServerConfigInput): Promise<ServerConfigSnapshotView> {
  return apiFetch<ServerConfigSnapshotView>("/api/config", {
    method: "PUT",
    body: input as unknown as Record<string, unknown>,
  });
}

export async function getProviderAdapterCatalog(): Promise<ProviderAdapterCatalog> {
  return apiFetch<ProviderAdapterCatalog>("/api/config/provider-adapters");
}

export async function getModelRuntimeCatalog(): Promise<ModelRuntimeCatalog> {
  return apiFetch<ModelRuntimeCatalog>("/api/config/model-runtime");
}
