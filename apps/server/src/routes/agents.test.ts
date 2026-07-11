import { describe, expect, test } from "bun:test";
import type { AgentRuntime } from "@archcode/agent-core";

import { createAgentsRoutes } from "./agents";

describe("GET /api/agents", () => {
  test("returns runtime-owned Agent display metadata", async () => {
    const app = createAgentsRoutes({
      listAgentDescriptors: () => [
        { name: "engineer", displayName: "Engineer" },
        { name: "goal_lead", displayName: "Goal Lead" },
      ],
    } as Pick<AgentRuntime, "listAgentDescriptors">);

    const response = await app.request("/");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      agents: [
        { name: "engineer", displayName: "Engineer" },
        { name: "goal_lead", displayName: "Goal Lead" },
      ],
    });
  });
});
