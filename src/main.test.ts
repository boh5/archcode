import { afterAll, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { ResolvedMcpConfig } from "./config/mcp";
import type { McpDiscoveryResult, McpManager, McpWarning } from "./mcp/index";
import { createSessionStore } from "./store/store";
import { defineTool, REDACTION_MARKER, type ToolExecutionContext } from "./tools/index";
import type { AnyToolDescriptor } from "./tools/types";
import { createSpecraRuntime } from "./main";

mock.module("ink", () => ({
  render: mock(() => ({
    clear: mock(() => {}),
    unmount: mock(() => {}),
    waitUntilExit: mock(async () => {}),
  })),
}));

const tmpRoots: string[] = [];

afterAll(() => {
  for (const root of tmpRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeProviderConfig() {
  return {
    local: {
      npm: "@ai-sdk/openai-compatible",
      name: "Local LLM",
      options: {
        baseURL: "http://localhost:8090/v1",
        apiKey: "test-key",
      },
      models: {
        "test-model": {
          name: "Test Model",
          limit: { context: 128000, output: 8192 },
          modalities: { input: ["text"], output: ["text"] },
        },
      },
    },
  };
}

async function writeConfig(config: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "specra-main-"));
  tmpRoots.push(root);
  const configPath = join(root, ".specra.json");
  await Bun.write(configPath, JSON.stringify(config));
  return configPath;
}

function makeConfig(mcp?: Record<string, unknown>): Record<string, unknown> {
  return mcp === undefined
    ? { provider: makeProviderConfig() }
    : { provider: makeProviderConfig(), mcp };
}

function makeMcpDescriptor(name = "mcp__context7__lookup"): AnyToolDescriptor {
  return defineTool({
    name,
    description: "Fake MCP lookup tool",
    inputSchema: z.object({}).catchall(z.unknown()),
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    execute: async () => "mcp output with sk_test_main_secret",
  });
}

function makeFakeMcpManager(result: McpDiscoveryResult | Error): McpManager {
  return {
    discover: mock(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
    closeAll: mock(async () => []),
  } as unknown as McpManager;
}

function makeContext(toolName: string, input: unknown): ToolExecutionContext {
  return {
    store: createSessionStore(`main-test-${crypto.randomUUID()}`),
    toolName,
    toolCallId: `${toolName}-call`,
    input,
    step: 0,
    abort: new AbortController().signal,
    startedAt: 0,
    allowedTools: new Set([toolName]),
    workspaceRoot: process.cwd(),
  };
}

describe("createSpecraRuntime", () => {
  test("registers MCP descriptors before the agent run snapshot without calling run", async () => {
    const configPath = await writeConfig(makeConfig({ servers: {} }));
    const mcpDescriptor = makeMcpDescriptor();
    const manager = makeFakeMcpManager({ descriptors: [mcpDescriptor], warnings: [] });
    const runtime = await createSpecraRuntime({
      configPath,
      mcpManagerFactory: () => manager,
    });
    const runSpy = mock(() => Promise.resolve({ text: "", steps: 0 }));

    expect(runtime.toolRegistry.get(mcpDescriptor.name)).toBe(mcpDescriptor);
    expect(runtime.agent.run).not.toBe(runSpy);

    runtime.agent.run = runSpy as unknown as typeof runtime.agent.run;
    const namesAtRun = runtime.toolRegistry.getAll().map((descriptor) => descriptor.name);

    expect(namesAtRun).toContain(mcpDescriptor.name);
    expect(runSpy).not.toHaveBeenCalled();
  });

  test("starts with no mcp config", async () => {
    const configPath = await writeConfig(makeConfig());
    let resolvedConfig: ResolvedMcpConfig | undefined;
    const manager = makeFakeMcpManager({ descriptors: [], warnings: [] });

    const runtime = await createSpecraRuntime({
      configPath,
      mcpManagerFactory: (config) => {
        resolvedConfig = config;
        return manager;
      },
    });

    expect(resolvedConfig).toEqual({ servers: {} });
    expect(runtime.agent).toBeDefined();
    expect(runtime.warnings).toEqual([]);
  });

  test("starts with mcp.servers as an empty object", async () => {
    const configPath = await writeConfig(makeConfig({ servers: {} }));
    let resolvedConfig: ResolvedMcpConfig | undefined;
    const manager = makeFakeMcpManager({ descriptors: [], warnings: [] });

    const runtime = await createSpecraRuntime({
      configPath,
      mcpManagerFactory: (config) => {
        resolvedConfig = config;
        return manager;
      },
    });

    expect(resolvedConfig).toEqual({ servers: {} });
    expect(runtime.agent).toBeDefined();
    expect(runtime.warnings).toEqual([]);
  });

  test("records a redacted discovery failure warning and still constructs the agent", async () => {
    const secret = "sk_test_main_secret";
    const configPath = await writeConfig(
      makeConfig({
        servers: {
          context7: {
            transport: "http",
            url: "https://mcp.example.test",
            headers: { Authorization: secret },
          },
        },
      }),
    );
    const warned: McpWarning[] = [];
    const manager = makeFakeMcpManager(new Error(`boom ${secret}`));

    const runtime = await createSpecraRuntime({
      configPath,
      mcpManagerFactory: () => manager,
      warn: (warning) => warned.push(warning),
    });

    expect(runtime.agent).toBeDefined();
    expect(runtime.warnings).toHaveLength(1);
    expect(warned).toEqual(runtime.warnings);
    expect(runtime.warnings[0].message).toContain(REDACTION_MARKER);
    expect(runtime.warnings[0].message).not.toContain(secret);
  });

  test("records a duplicate MCP descriptor warning and still constructs the agent", async () => {
    const configPath = await writeConfig(makeConfig({ servers: {} }));
    const duplicateBuiltin = makeMcpDescriptor("file_read");
    const manager = makeFakeMcpManager({
      descriptors: [duplicateBuiltin],
      warnings: [],
    });

    const runtime = await createSpecraRuntime({
      configPath,
      mcpManagerFactory: () => manager,
    });

    expect(runtime.agent).toBeDefined();
    expect(runtime.toolRegistry.get("file_read")).not.toBe(duplicateBuiltin);
    expect(runtime.warnings).toEqual([
      {
        toolName: "file_read",
        message: 'Duplicate MCP tool descriptor "file_read" skipped during startup',
      },
    ]);
  });

  test("keeps builtin tools registered alongside MCP tools", async () => {
    const configPath = await writeConfig(makeConfig({ servers: {} }));
    const mcpDescriptor = makeMcpDescriptor();
    const manager = makeFakeMcpManager({ descriptors: [mcpDescriptor], warnings: [] });

    const runtime = await createSpecraRuntime({
      configPath,
      mcpManagerFactory: () => manager,
    });

    expect(runtime.toolRegistry.get("file_read")).toBeDefined();
    expect(runtime.toolRegistry.get("grep")).toBeDefined();
    expect(runtime.toolRegistry.get("web_fetch")).toBeDefined();
    expect(runtime.toolRegistry.get(mcpDescriptor.name)).toBeDefined();
  });

  test("runs MCP tools through registry global after-hooks", async () => {
    const configPath = await writeConfig(makeConfig({ servers: {} }));
    const mcpDescriptor = makeMcpDescriptor();
    const manager = makeFakeMcpManager({ descriptors: [mcpDescriptor], warnings: [] });

    const runtime = await createSpecraRuntime({
      configPath,
      mcpManagerFactory: () => manager,
    });
    const result = await runtime.toolRegistry.execute(
      {
        toolName: mcpDescriptor.name,
        toolCallId: "mcp-call",
        input: {},
      },
      makeContext(mcpDescriptor.name, {}),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain(REDACTION_MARKER);
    expect(result.output).not.toContain("sk_test_main_secret");
  });
});
