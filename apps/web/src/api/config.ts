import type {
  ConfigAgentSettings,
  ConfigMcpServerSettings,
  ConfigModelCallOptions,
  ConfigModelSettings,
  ConfigProviderSettings,
  ConfigSecretMutation,
  ConfiguredSecretView,
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

function secretToMutation(secret?: ConfiguredSecretView): ConfigSecretMutation | undefined {
  return secret ? { action: "preserve" } : undefined;
}

function secretRecordToMutation(record?: Record<string, ConfiguredSecretView>): Record<string, ConfigSecretMutation> | undefined {
  if (!record) return undefined;
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, secretToMutation(value)!]));
}

/** The sole view-to-mutation conversion: no component handles GET secret views. */
export function toConfigDraft(snapshot: ServerConfigSnapshotView): ServerConfigSnapshot {
  return {
    ...snapshot,
    config: {
      ...snapshot.config,
      provider: Object.fromEntries(Object.entries(snapshot.config.provider).map(([id, provider]) => [id, {
        ...provider,
        options: {
          ...provider.options,
          apiKey: secretToMutation(provider.options.apiKey),
          headers: secretRecordToMutation(provider.options.headers),
          queryParams: secretRecordToMutation(provider.options.queryParams),
        },
      }])),
      mcp: snapshot.config.mcp ? {
        servers: Object.fromEntries(Object.entries(snapshot.config.mcp.servers).map(([id, server]) => [id, {
          ...server,
          headers: secretRecordToMutation(server.headers),
        }])),
      } : undefined,
    },
  };
}

export async function getServerConfig(): Promise<ServerConfigSnapshot> {
  return toConfigDraft(await apiFetch<ServerConfigSnapshotView>("/api/config"));
}

export async function saveServerConfig(input: SaveServerConfigInput): Promise<ServerConfigSnapshot> {
  return toConfigDraft(await apiFetch<ServerConfigSnapshotView>("/api/config", {
    method: "PUT",
    body: input as unknown as Record<string, unknown>,
  }));
}
