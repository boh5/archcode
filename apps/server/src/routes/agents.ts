import { Hono } from "hono";
import type { AgentRuntime } from "@archcode/agent-core";
import type { AgentDescriptor } from "@archcode/protocol";

export interface AgentsResponse {
  agents: readonly AgentDescriptor[];
}

/** Runtime agent catalog used by the Web UI for product-facing role names. */
export function createAgentsRoutes(runtime: Pick<AgentRuntime, "listAgentDescriptors">): Hono {
  const app = new Hono();

  app.get("/", (c) => c.json({ agents: runtime.listAgentDescriptors() } satisfies AgentsResponse));

  return app;
}
