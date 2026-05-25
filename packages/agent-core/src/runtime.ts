import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { defaultAgentDefinitions, type Agent } from "./agents";
import { ConfiguredAgent } from "./agents/configured-agent";
import { SessionAgentManager } from "./agents/session-agent-manager";
import type { CommandResult } from "./commands/types";
import { loadConfig } from "./config/load";
import {
  resolveMcpConfig,
  type ResolvedMcpConfig,
  type ResolvedMcpServerConfig,
} from "./config/mcp";
import { registerBuiltinTools } from "./core/index";
import {
  BUILTIN_MCP_SERVERS,
  McpManager,
  redactMcpMessage,
  type McpDiscoveryResult,
  type McpWarning,
} from "./mcp/index";
import { createRegistry as createProviderRegistry, type Registry as ProviderRegistry } from "./provider/index";
import { ProjectContextResolver } from "./projects/context-resolver";
import { ProjectRegistry } from "./projects/registry";
import { SkillService } from "./skills";
import { createRegistry as createToolRegistry, DuplicateToolError, type ToolRegistry } from "./tools/index";

const DEFAULT_CONFIG_PATH = ".specra.json";

export interface SpecraRuntimeOptions {
  configPath?: string;
  workspaceRoot?: string;
  mcpManagerFactory?: (config: ResolvedMcpConfig) => McpManager;
  warn?: (warning: McpWarning) => void;
}

export interface SpecraRuntime {
  readonly sessionAgentManager: SessionAgentManager;
  readonly mcpManager: McpManager;
  readonly toolRegistry: ToolRegistry;
  readonly providerRegistry: ProviderRegistry;
  readonly skillService: SkillService;
  readonly warnings: McpWarning[];
  readonly projectRegistry: ProjectRegistry;
  readonly contextResolver: ProjectContextResolver;
  agentFor(workspaceRoot: string, sessionId: string): Promise<Agent>;
  dispatchCommand(workspaceRoot: string, sessionId: string, name: string, args?: string): Promise<CommandResult | null>;
}

export async function createSpecraRuntime(
  options: SpecraRuntimeOptions = {},
): Promise<SpecraRuntime> {
  const warnings: McpWarning[] = [];
  const config = await loadConfig(options.configPath ?? DEFAULT_CONFIG_PATH);
  const providerRegistry = createProviderRegistry(config.provider);
  const toolRegistry = createToolRegistry();
  registerBuiltinTools(toolRegistry);
  const skillService = new SkillService();

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

    await resolveWorkspaceRoot(options);
    const projectRegistry = new ProjectRegistry();
    const contextResolver = new ProjectContextResolver();
    const sessionAgentManager = new SessionAgentManager({
      definitions: defaultAgentDefinitions,
      providerRegistry,
      toolRegistry,
      skillService,
      config,
      projectContextResolver: contextResolver,
    });

    async function agentFor(workspaceRoot: string, sessionId: string): Promise<Agent> {
      return await sessionAgentManager.getOrCreate(workspaceRoot, sessionId);
    }

    async function dispatchCommand(
      workspaceRoot: string,
      sessionId: string,
      name: string,
      args?: string,
    ): Promise<CommandResult | null> {
      const agent = sessionAgentManager.get(workspaceRoot, sessionId);
      if (!(agent instanceof ConfiguredAgent)) {
        return null;
      }

      return await agent.dispatchCommand(name, args);
    }

    return {
      sessionAgentManager,
      mcpManager,
      toolRegistry,
      providerRegistry,
      skillService,
      warnings,
      projectRegistry,
      contextResolver,
      agentFor,
      dispatchCommand,
    };
  } catch (err) {
    await closeMcpManagerBestEffort(mcpManager, recordWarning);
    throw err;
  }
}

async function resolveWorkspaceRoot(options: SpecraRuntimeOptions): Promise<string> {
  if (options.workspaceRoot) return options.workspaceRoot;
  if (Bun.env.SPECRA_WORKSPACE_ROOT) return Bun.env.SPECRA_WORKSPACE_ROOT;

  return realpath(dirname(options.configPath ?? DEFAULT_CONFIG_PATH));
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`MCP discovery timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return await Promise.race([promise, timeout]).finally(() => {
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

export async function closeMcpManagerBestEffort(
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
