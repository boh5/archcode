import { z } from "zod";
import type { StoreApi } from "zustand";
import type { SessionStoreState } from "../store/types";
import type { Registry as ProviderRegistry } from "../provider/index";
import type { ToolRegistry } from "../tools/index";
import { ExplorerAgent } from "./roles/explorer-agent";
import type { Agent } from "./types";

/**
 * Zod enum for delegatable sub-agent types.
 * Only "explore" is supported in V1.
 * OrchestratorAgent is the root agent — never in this registry.
 */
export const AgentType = z.enum(["explore"]);

export type AgentType = z.infer<typeof AgentType>;

/**
 * Options passed to AgentFactory when creating a sub-agent instance.
 * These represent the minimal context needed to bootstrap a delegatable agent.
 */
export interface AgentCreateOptions {
  store: StoreApi<SessionStoreState>;
  providerRegistry: ProviderRegistry;
  toolRegistry: ToolRegistry;
  workspaceRoot: string;
  abortSignal?: AbortSignal;
  depth?: number;
}

/**
 * Factory function signature for creating Agent instances.
 * Implementations receive AgentCreateOptions and return a fully wired Agent.
 */
export type AgentFactory = (options: AgentCreateOptions) => Agent;

/**
 * Registry for delegatable sub-agent types.
 *
 * V1 only supports "explore" as a delegatable type.
 * OrchestratorAgent is the root — it is never registered here.
 * Concrete factory mappings (e.g. createExplorerAgent) are added in T12.
 */
export interface AgentRegistry {
  /** Returns all registered agent type names. */
  list(): string[];

  /**
   * Returns the factory for the given agent type.
   * @throws {Error} if the agent type is not registered.
   */
  getFactory(agentType: string): AgentFactory;
}

export function createExplorerAgent(options: AgentCreateOptions): Agent {
  return new ExplorerAgent({
    providerRegistry: options.providerRegistry,
    toolRegistry: options.toolRegistry,
    workspaceRoot: options.workspaceRoot,
    store: options.store,
    depth: options.depth,
  });
}

export function createAgentRegistry(): AgentRegistry {
  const factories: Record<AgentType, AgentFactory> = {
    explore: createExplorerAgent,
  };

  return {
    list(): string[] {
      return ["explore"];
    },
    getFactory(agentType: string): AgentFactory {
      const parsed = AgentType.safeParse(agentType);
      if (!parsed.success) {
        throw new Error(`Unknown agent type: ${agentType}`);
      }

      return factories[parsed.data];
    },
  };
}
