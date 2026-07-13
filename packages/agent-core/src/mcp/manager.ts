import type { ResolvedMcpServerConfig } from "../config/mcp";
import type { Logger } from "../logger";
import { silentLogger } from "../logger";
import type { AnyToolDescriptor } from "../tools/types";
import type { McpServerStatus } from "@archcode/protocol";
import {
  createDefaultMcpClientFactories,
  McpClient,
  type McpClientFactories,
  type McpToolLike,
} from "./client";
import {
  McpDuplicateToolError,
  type McpWarning,
  redactMcpMessage,
} from "./errors";
import { adaptMcpTool } from "./tool-adapter";
import { toMcpToolRegistryName, validateMcpNameSegment } from "./naming";

export interface McpDiscoveryResult {
  descriptors: AnyToolDescriptor[];
  warnings: McpWarning[];
}

interface ConnectedMcpClient {
  serverName: string;
  client: McpClient;
}

export type McpStatusListener = (serverName: string, status: McpServerStatus) => void;

export class BuiltinMcpServerCollisionError extends Error {
  constructor(public readonly serverName: string) {
    super(`User MCP server "${serverName}" conflicts with a reserved built-in server`);
    this.name = "BuiltinMcpServerCollisionError";
  }
}

type DescriptorSink = (descriptors: AnyToolDescriptor[]) => void;
type WarningSink = (warning: McpWarning) => void;

// ─── Manager ─────────────────────────────────────────────────────────────────

export class McpManager {
  readonly #logger: Logger;
  private readonly clientFactories: McpClientFactories;
  private readonly connectedClients: ConnectedMcpClient[] = [];
  private readonly secrets: string[];
  private readonly serverStatuses = new Map<string, McpServerStatus>();
  private readonly statusListeners = new Set<McpStatusListener>();
  #started = false;
  #closed = false;

  constructor(
    private readonly builtinServers: Record<string, ResolvedMcpServerConfig>,
    private readonly userServers: Record<string, ResolvedMcpServerConfig>,
    clientFactories: McpClientFactories = createDefaultMcpClientFactories(),
    logger: Logger = silentLogger,
  ) {
    const collision = Object.keys(userServers).find((name) => builtinServers[name] !== undefined);
    if (collision !== undefined) {
      throw new BuiltinMcpServerCollisionError(collision);
    }
    this.#logger = logger.child({ module: "mcp.manager" });
    this.clientFactories = clientFactories;
    this.secrets = collectSecrets(builtinServers, userServers);

    for (const serverName of Object.keys(builtinServers)) {
      this.serverStatuses.set(serverName, { state: "pending" });
    }
    for (const serverName of Object.keys(userServers)) {
      this.serverStatuses.set(serverName, { state: "pending" });
    }
  }

  getStatus(): Map<string, McpServerStatus> {
    return new Map(this.serverStatuses);
  }

  onStatusChange(listener: McpStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private setStatus(serverName: string, status: McpServerStatus): void {
    this.serverStatuses.set(serverName, status);
    for (const listener of this.statusListeners) {
      try {
        listener(serverName, status);
      } catch (err) {
        this.#logger.warn("mcp.status.listener.failed", {
          context: { serverId: serverName },
          error: logError(err),
        });
      }
    }
  }

  startBackgroundDiscovery(onDescriptors: DescriptorSink, onWarning: WarningSink): void {
    if (this.#started) {
      throw new Error("MCP background discovery already started");
    }
    this.#started = true;
    void this.discoverBackground(onDescriptors, onWarning);
  }

  private async discoverBackground(
    onDescriptors: DescriptorSink,
    onWarning: WarningSink,
  ): Promise<void> {
    try {
      const servers = this.mergedServers();
      await Promise.all(
        Object.entries(servers).map(([serverName, config]) =>
          this.discoverServerBackground(serverName, config, onDescriptors, onWarning),
        ),
      );
    } catch (err) {
      this.#logger.warn("mcp.discovery.toplevel.failed", {
        error: logError(err),
      });
      const message = this.redactedMessage(
        `MCP background discovery failed: ${errorMessage(err)}`,
      );
      for (const [serverName, status] of this.serverStatuses) {
        if (status.state === "pending") {
          onWarning({ serverName, message });
          this.setStatus(serverName, { state: "failed", error: message });
        }
      }
    }
  }

  private async discoverServerBackground(
    serverName: string,
    config: ResolvedMcpServerConfig,
    onDescriptors: DescriptorSink,
    onWarning: WarningSink,
  ): Promise<void> {
    if (this.#closed) return;

    const client = new McpClient(
      serverName,
      config,
      this.clientFactories,
      this.#logger.child({ module: "mcp.client", context: { serverId: serverName } }),
    );

    try {
      await client.connect();
      if (this.#closed) {
        await client.close();
        return;
      }
      this.connectedClients.push({ serverName, client });

      const tools = await client.listTools();
      if (this.#closed) {
        await client.close();
        return;
      }
      if (tools.length === 0) {
        onWarning({
          serverName,
          message: this.redactedMessage(
            `MCP server "${serverName}" returned no tools`,
          ),
        });
        this.setStatus(serverName, { state: "ready", toolCount: 0 });
        return;
      }

      const result = this.adaptServerTools(serverName, client, tools);
      if (this.#closed) {
        await client.close();
        return;
      }
      for (const warning of result.warnings) {
        onWarning(warning);
      }
      onDescriptors(result.descriptors);
      this.setStatus(serverName, { state: "ready", toolCount: result.descriptors.length });
    } catch (err) {
      if (this.#closed) {
        try {
          await client.close();
        } catch {
          // best-effort cleanup during shutdown
        }
        return;
      }
      this.#logger.warn("mcp.discovery.server.failed", {
        context: { serverId: serverName },
        error: logError(err),
      });
      onWarning({
        serverName,
        message: this.redactedMessage(
          `Failed to discover MCP server "${serverName}": ${errorMessage(err)}`,
        ),
      });
      this.setStatus(serverName, {
        state: "failed",
        error: this.redactedMessage(
          `Failed to discover MCP server "${serverName}": ${errorMessage(err)}`,
        ),
      });
    }
  }

  async closeAll(): Promise<McpWarning[]> {
    this.#closed = true;
    const clients = [...this.connectedClients];
    this.connectedClients.length = 0;

    const results = await Promise.allSettled(
      clients.map(async ({ serverName, client }) => {
        await client.close();
        return serverName;
      }),
    );

    const warnings: McpWarning[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") continue;

      const serverName = clients[index].serverName;
      warnings.push({
        serverName,
        message: this.redactedMessage(
          `Failed to close MCP client for server "${serverName}": ${errorMessage(result.reason)}`,
        ),
      });
    }

    return warnings;
  }

  private adaptServerTools(
    serverName: string,
    client: McpClient,
    tools: McpToolLike[],
  ): McpDiscoveryResult {
    const descriptors: AnyToolDescriptor[] = [];
    const warnings: McpWarning[] = [];
    const seenRegistryNames = new Set<string>();

    for (const tool of tools) {
      try {
        validateMcpNameSegment(tool.name, "tool");
        const registryName = toMcpToolRegistryName(serverName, tool.name);

        if (seenRegistryNames.has(registryName)) {
          throw new McpDuplicateToolError(serverName, tool.name, registryName);
        }

        seenRegistryNames.add(registryName);
        descriptors.push(
          adaptMcpTool(
            tool,
            serverName,
            client,
            this.secrets,
            this.#logger.child({
              module: "mcp.tool-adapter",
              context: { serverId: serverName },
            }),
          ),
        );
      } catch (err) {
        this.#logger.warn("mcp.adapt.tools.failed", {
          context: { serverId: serverName, toolName: tool.name },
          error: logError(err),
        });
        warnings.push({
          serverName,
          toolName: tool.name,
          message: this.redactedMessage(errorMessage(err)),
        });
      }
    }

    return { descriptors, warnings };
  }

  private mergedServers(): Record<string, ResolvedMcpServerConfig> {
    return { ...this.builtinServers, ...this.userServers };
  }

  private redactedMessage(message: string): string {
    return redactMcpMessage(message, this.secrets);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function collectSecrets(
  ...serverGroups: Array<Record<string, ResolvedMcpServerConfig>>
): string[] {
  const secrets: string[] = [];
  for (const servers of serverGroups) {
    for (const config of Object.values(servers)) {
      if (config.headers) {
        secrets.push(...Object.values(config.headers));
        // Only redact URL when server has auth headers — URL may contain
        // embedded credentials (e.g. tokens in query params) that should not
        // leak into error messages alongside the auth headers.
        secrets.push(config.url);
      }
      // Public servers without auth headers have no secrets to redact;
      // their URLs are safe to show in error messages.
    }
  }
  return secrets;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown MCP manager error";
}

function logError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name || "Error", message: error.message };
  }

  return { name: typeof error, message: String(error) };
}
