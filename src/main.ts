import React from "react";
import { render } from "ink";
import { loadConfig } from "./config/load";
import {
  resolveMcpConfig,
  type ResolvedMcpConfig,
  type ResolvedMcpServerConfig,
} from "./config/mcp";
import { OrchestratorAgent } from "./agents";
import {
  createRegistry as createProviderRegistry,
  type Registry as ProviderRegistry,
} from "./provider/index";
import {
  createRegistry as createToolRegistry,
  DuplicateToolError,
  type ToolRegistry,
} from "./tools/index";
import { registerBuiltinTools } from "./core/index";
import { App } from "./tui/App";
import {
  BUILTIN_MCP_SERVERS,
  McpManager,
  redactMcpMessage,
  type McpDiscoveryResult,
  type McpWarning,
} from "./mcp/index";

const DEFAULT_CONFIG_PATH = ".specra.json";

export interface SpecraRuntimeOptions {
  configPath?: string;
  mcpManagerFactory?: (config: ResolvedMcpConfig) => McpManager;
  warn?: (warning: McpWarning) => void;
}

export interface SpecraRuntime {
  agent: OrchestratorAgent;
  mcpManager: McpManager;
  toolRegistry: ToolRegistry;
  providerRegistry: ProviderRegistry;
  warnings: McpWarning[];
}

export async function createSpecraRuntime(
  options: SpecraRuntimeOptions = {},
): Promise<SpecraRuntime> {
  const warnings: McpWarning[] = [];
  const config = await loadConfig(options.configPath ?? DEFAULT_CONFIG_PATH);
  const providerRegistry = createProviderRegistry(config.provider);
  const toolRegistry = createToolRegistry();
  registerBuiltinTools(toolRegistry);

  const resolvedMcpConfig = resolveMcpConfig(config.mcp);
  const mcpManager = options.mcpManagerFactory
    ? options.mcpManagerFactory(resolvedMcpConfig)
    : new McpManager(BUILTIN_MCP_SERVERS, resolvedMcpConfig.servers);
  const secrets = collectMcpSecrets(
    BUILTIN_MCP_SERVERS,
    resolvedMcpConfig.servers,
  );

  const recordWarning = (warning: McpWarning): void => {
    warnings.push(warning);
    options.warn?.(warning);
  };

  try {
    const discovery = await discoverMcpTools(
      mcpManager,
      resolveMcpDiscoveryTimeout(resolvedMcpConfig),
      secrets,
      recordWarning,
    );
    for (const warning of discovery.warnings) {
      recordWarning(warning);
    }

    for (const descriptor of discovery.descriptors) {
      if (toolRegistry.get(descriptor.name)) {
        recordWarning({
          toolName: descriptor.name,
          message: `Duplicate MCP tool descriptor "${descriptor.name}" skipped during startup`,
        });
        continue;
      }

      try {
        toolRegistry.register(descriptor);
      } catch (err) {
        if (err instanceof DuplicateToolError) {
          recordWarning({
            toolName: descriptor.name,
            message: `Duplicate MCP tool descriptor "${descriptor.name}" skipped during startup`,
          });
          continue;
        }
        throw err;
      }
    }

    const agent = new OrchestratorAgent({ providerRegistry, toolRegistry, config });
    return { agent, mcpManager, toolRegistry, providerRegistry, warnings };
  } catch (err) {
    await closeMcpManagerBestEffort(mcpManager, recordWarning);
    throw err;
  }
}

async function discoverMcpTools(
  mcpManager: McpManager,
  timeoutMs: number,
  secrets: readonly string[],
  warn: (warning: McpWarning) => void,
): Promise<McpDiscoveryResult> {
  try {
    return await withTimeout(mcpManager.discover(), timeoutMs);
  } catch (err) {
    warn({
      message: redactMcpMessage(
        `Failed to discover MCP tools during startup: ${errorMessage(err)}`,
        secrets,
      ),
    });
    return { descriptors: [], warnings: [] };
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`MCP discovery timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function resolveMcpDiscoveryTimeout(config: ResolvedMcpConfig): number {
  const serverTimeouts = Object.values(config.servers).map(
    (server) => server.timeout,
  );
  return Math.max(30000, ...serverTimeouts);
}

function collectMcpSecrets(
  ...serverGroups: Array<Record<string, ResolvedMcpServerConfig>>
): string[] {
  const secrets: string[] = [];
  for (const servers of serverGroups) {
    for (const server of Object.values(servers)) {
      if (server.headers) {
        secrets.push(...Object.values(server.headers));
        // Only redact URL when server has auth headers — URL may contain
        // embedded credentials (e.g. tokens in query params) that should not
        // leak into error messages alongside the auth headers.
        secrets.push(server.url);
      }
      // Public servers without auth headers have no secrets to redact;
      // their URLs are safe to show in error messages.
    }
  }
  return secrets;
}

async function closeMcpManagerBestEffort(
  mcpManager: McpManager,
  warn?: (warning: McpWarning) => void,
): Promise<void> {
  try {
    const closeWarnings = await mcpManager.closeAll();
    for (const warning of closeWarnings) {
      warn?.(warning);
    }
  } catch (err) {
    warn?.({
      message: `Failed to close MCP manager during shutdown: ${errorMessage(err)}`,
    });
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}

function logMcpWarning(warning: McpWarning): void {
  console.warn(`MCP warning: ${warning.message}`);
}

async function main() {
  const runtime = await createSpecraRuntime({ warn: logMcpWarning });

  const close = () => {
    void closeMcpManagerBestEffort(runtime.mcpManager, logMcpWarning);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);

  render(React.createElement(App, { agent: runtime.agent }));
}

// Only run main() when this module is the entry point
if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
