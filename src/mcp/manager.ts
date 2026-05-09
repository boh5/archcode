import { McpConfigError, type ResolvedMcpServerConfig } from "../config/mcp";
import type { AnyToolDescriptor } from "../tools/types";
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

// ─── Manager ─────────────────────────────────────────────────────────────────

export class McpManager {
  private readonly clientFactories: McpClientFactories;
  private readonly connectedClients: ConnectedMcpClient[] = [];
  private readonly secrets: string[];

  constructor(
    private readonly builtinServers: Record<string, ResolvedMcpServerConfig>,
    private readonly userServers: Record<string, ResolvedMcpServerConfig>,
    clientFactories: McpClientFactories = createDefaultMcpClientFactories(),
  ) {
    this.clientFactories = clientFactories;
    this.secrets = collectSecrets(builtinServers, userServers);
  }

  async discover(): Promise<McpDiscoveryResult> {
    this.assertNoServerCollisions();

    const servers = this.mergedServers();
    const discoveries = await Promise.all(
      Object.entries(servers).map(([serverName, config]) =>
        this.discoverServer(serverName, config),
      ),
    );

    return discoveries.reduce<McpDiscoveryResult>(
      (acc, result) => {
        acc.descriptors.push(...result.descriptors);
        acc.warnings.push(...result.warnings);
        return acc;
      },
      { descriptors: [], warnings: [] },
    );
  }

  async closeAll(): Promise<McpWarning[]> {
    const results = await Promise.allSettled(
      this.connectedClients.map(async ({ serverName, client }) => {
        await client.close();
        return serverName;
      }),
    );

    const warnings: McpWarning[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") continue;

      const serverName = this.connectedClients[index].serverName;
      warnings.push({
        serverName,
        message: this.redactedMessage(
          `Failed to close MCP client for server "${serverName}": ${errorMessage(result.reason)}`,
        ),
      });
    }

    return warnings;
  }

  private async discoverServer(
    serverName: string,
    config: ResolvedMcpServerConfig,
  ): Promise<McpDiscoveryResult> {
    const client = new McpClient(serverName, config, this.clientFactories);

    try {
      await client.connect();
      this.connectedClients.push({ serverName, client });

      const tools = await client.listTools();
      if (tools.length === 0) {
        return {
          descriptors: [],
          warnings: [
            {
              serverName,
              message: this.redactedMessage(
                `MCP server "${serverName}" returned no tools`,
              ),
            },
          ],
        };
      }

      return this.adaptServerTools(serverName, client, tools);
    } catch (err) {
      return {
        descriptors: [],
        warnings: [
          {
            serverName,
            message: this.redactedMessage(
              `Failed to discover MCP server "${serverName}": ${errorMessage(err)}`,
            ),
          },
        ],
      };
    }
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
        descriptors.push(adaptMcpTool(tool, serverName, client, this.secrets));
      } catch (err) {
        warnings.push({
          serverName,
          toolName: tool.name,
          message: this.redactedMessage(errorMessage(err)),
        });
      }
    }

    return { descriptors, warnings };
  }

  private assertNoServerCollisions(): void {
    for (const serverName of Object.keys(this.builtinServers)) {
      if (serverName in this.userServers) {
        throw new McpConfigError(
          `MCP server "${serverName}" is configured both as a built-in server and a user server`,
          serverName,
        );
      }
    }
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
      if (!config.headers) continue;
      secrets.push(...Object.values(config.headers));
      // Include the full URL as a secret so URL-embedded tokens are redacted
      secrets.push(config.url);
    }
  }
  return secrets;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown MCP manager error";
}
