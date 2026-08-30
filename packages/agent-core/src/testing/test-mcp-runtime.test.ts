import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";

import { toMcpToolRegistryName } from "../mcp/naming";
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
      tools: new Map([
        [user.name, { descriptor: user, serverName: "user", source: "user" }],
        [context7.name, { descriptor: context7, serverName: "context7", source: "builtin" }],
        [exa.name, { descriptor: exa, serverName: "exa", source: "builtin" }],
      ]),
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

  test("preserves an explicit user MCP server identity instead of parsing the provider alias", () => {
    const docs = descriptor(toMcpToolRegistryName("grep.app", "lookup"));
    const runtime = createTestMcpRuntime({
      tools: new Map([[
        docs.name,
        { descriptor: docs, serverName: "grep.app", source: "user" },
      ]]),
      statuses: {
        servers: {
          "grep.app": { state: "ready", toolCount: 1, warningCount: 0, connectedAt: 1 },
        },
      },
    });

    expect(runtime.snapshotTools({ builtinServerNames: [] }).tools.get(docs.name)).toMatchObject({
      serverName: "grep.app",
      source: "user",
    });
  });

  test("does not project explicit dotted, long, connecting, or failed server identities", () => {
    const longServerName = "long-server-name-that-provider-aliases-must-truncate";
    const disabled = descriptor(toMcpToolRegistryName("grep.app", "lookup"));
    const connecting = descriptor("mcp__connecting__lookup");
    const failed = descriptor(toMcpToolRegistryName(longServerName, "lookup"));
    const runtime = createTestMcpRuntime({
      tools: new Map([
        [disabled.name, { descriptor: disabled, serverName: "grep.app", source: "user" }],
        [connecting.name, { descriptor: connecting, serverName: "connecting", source: "user" }],
        [failed.name, { descriptor: failed, serverName: longServerName, source: "user" }],
      ]),
      statuses: {
        servers: {
          "grep.app": { state: "disabled", updatedAt: 1 },
          connecting: { state: "connecting", startedAt: 1 },
          [longServerName]: { state: "failed", error: "offline", failedAt: 1 },
        },
      },
    });

    expect([...runtime.snapshotTools({ builtinServerNames: [] }).tools.keys()]).toEqual([]);
  });
});
