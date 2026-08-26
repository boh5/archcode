import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";

import { defineTool } from "../tools/define-tool";
import { createTextToolResult } from "../tools/results";
import { createTestMcpRuntime } from "./test-mcp-runtime";

function descriptor(name: string) {
  return defineTool({
    name,
    description: name,
    inputSchema: z.object({}).strict(),
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    outputPolicy: { kind: "inline", previewDirection: "head" },
    execute: async () => createTextToolResult(name),
  });
}

describe("createTestMcpRuntime", () => {
  test("projects every user descriptor and only requested builtin servers", () => {
    const user = descriptor("mcp__user__read");
    const context7 = descriptor("mcp__context7__read");
    const exa = descriptor("mcp__exa__read");
    const runtime = createTestMcpRuntime({
      descriptors: new Map([[user.name, user]]),
      builtinDescriptors: {
        context7: new Map([[context7.name, context7]]),
        exa: new Map([[exa.name, exa]]),
      },
      statuses: {
        servers: {
          user: { state: "ready", toolCount: 1, warningCount: 0, connectedAt: 1 },
          context7: { state: "ready", toolCount: 1, warningCount: 0, connectedAt: 1 },
          exa: { state: "ready", toolCount: 1, warningCount: 0, connectedAt: 1 },
        },
      },
    });

    expect([...runtime.snapshotTools({ builtinServerNames: [] }).tools.keys()]).toEqual([user.name]);
    expect(Object.keys(runtime.snapshotTools({ builtinServerNames: [] }).statuses.servers)).toEqual(["user"]);
    expect([...runtime.snapshotTools({ builtinServerNames: ["context7"] }).tools.keys()]).toEqual([
      user.name,
      context7.name,
    ]);
    expect(runtime.snapshotTools({ builtinServerNames: ["context7"] }).tools.get(context7.name)).toMatchObject({
      descriptor: context7,
      serverName: "context7",
      source: "builtin",
    });
    expect(Object.keys(runtime.snapshotTools({ builtinServerNames: ["context7"] }).statuses.servers).sort()).toEqual([
      "context7",
      "user",
    ]);
  });

  test("derives user MCP namespaces from the formal registry alias parser", () => {
    const docs = descriptor("mcp__docs__lookup");
    const runtime = createTestMcpRuntime({
      descriptors: new Map([[docs.name, docs]]),
      statuses: {
        servers: {
          docs: { state: "ready", toolCount: 1, warningCount: 0, connectedAt: 1 },
        },
      },
    });

    expect(runtime.snapshotTools({ builtinServerNames: [] }).tools.get(docs.name)).toMatchObject({
      serverName: "docs",
      source: "user",
    });
  });

  test("does not project descriptors from disabled, connecting, or failed servers", () => {
    const disabled = descriptor("mcp__disabled__lookup");
    const connecting = descriptor("mcp__connecting__lookup");
    const failed = descriptor("mcp__failed__lookup");
    const runtime = createTestMcpRuntime({
      descriptors: new Map([
        [disabled.name, disabled],
        [connecting.name, connecting],
        [failed.name, failed],
      ]),
      statuses: {
        servers: {
          disabled: { state: "disabled", updatedAt: 1 },
          connecting: { state: "connecting", startedAt: 1 },
          failed: { state: "failed", error: "offline", failedAt: 1 },
        },
      },
    });

    expect([...runtime.snapshotTools({ builtinServerNames: [] }).tools.keys()]).toEqual([]);
  });
});
