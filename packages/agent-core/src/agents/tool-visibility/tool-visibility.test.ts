import { afterAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import type { AnyToolDescriptor, ToolOutputPolicy, ToolTraits } from "../../tools/types";
import { registerBuiltinTools } from "../../core/register-tools";
import { silentLogger } from "../../logger";
import { createTestToolRegistryFixture } from "../../tools/test-registry";
import { createTextToolResult } from "../../tools/results";
import { defineTool } from "../../tools/define-tool";
import { createTestMcpRuntime } from "../../testing/test-mcp-runtime";
import { toMcpToolRegistryName } from "../../mcp/naming";
import { agentDefinitions } from "../definitions";
import { buildToolCatalog } from "./catalog";
import { buildToolNamespaceSummary, MAX_NAMESPACE_SUMMARY_BYTES, MAX_NAMESPACE_SUMMARY_ITEM_BYTES } from "./namespace-summary";
import { projectVisibleTools } from "./projection";
import { buildToolSearchIndex, searchToolCatalog } from "./search";
import { NO_STATE_DEFERRED_BUILTINS, TOOL_SEARCH_EVAL_CASES } from "./search-eval-cases";

const traits: ToolTraits = { readOnly: true, destructive: false, concurrencySafe: true };
const outputPolicy: ToolOutputPolicy = { kind: "inline", previewDirection: "head" };

function descriptor(name: string, description = `Capability ${name}`): AnyToolDescriptor {
  return {
    name,
    description,
    inputSchema: z.object({ value: z.string().describe("input value").optional() }),
    traits,
    outputPolicy,
    execute: () => ({ isError: false, draft: { kind: "text", text: "ok" } }),
  };
}

async function catalog(names: readonly string[], namespace = "builtin") {
  return buildToolCatalog(names.map((name) => ({
    sourceKind: namespace === "builtin" ? "builtin" as const : "mcp" as const,
    namespace,
    registryName: name,
    descriptor: descriptor(name),
  })));
}

function mcpFixture(serverName: string, toolName: string, description: string): AnyToolDescriptor {
  return defineTool({
    name: toMcpToolRegistryName(serverName, toolName),
    description,
    inputSchema: z.object({
      documentKind: z.enum(["api", "guide", "migration"]).describe("Documentation category to inspect."),
      release: z.enum(["stable", "nightly"]).describe("Release channel whose indexed contract should be returned."),
    }).strict(),
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    outputPolicy: { kind: "inline", previewDirection: "head" },
    execute: async () => createTextToolResult("fixture result"),
  });
}

const productionBuiltinFixture = createTestToolRegistryFixture();
registerBuiltinTools(productionBuiltinFixture.registry, silentLogger, { github: { enabled: false } });

afterAll(async () => {
  await productionBuiltinFixture.dispose();
});

describe("tool catalog", () => {
  test("canonical digest is stable across enumeration and schema key order", async () => {
    const a = descriptor("alpha");
    const b = { ...a, inputSchema: z.object({ value: z.string().describe("input value").optional() }) };
    const first = await buildToolCatalog([
      { sourceKind: "builtin", namespace: "zeta", registryName: "alpha", descriptor: a },
      { sourceKind: "builtin", namespace: "alpha", registryName: "beta", descriptor: descriptor("beta") },
    ]);
    const second = await buildToolCatalog([
      { sourceKind: "builtin", namespace: "alpha", registryName: "beta", descriptor: descriptor("beta") },
      { sourceKind: "builtin", namespace: "zeta", registryName: "alpha", descriptor: b },
    ]);
    expect(first.digest).toBe(second.digest);
    expect(first.entries.map((entry) => `${entry.namespace}/${entry.registryName}`)).toEqual([
      "alpha/beta", "zeta/alpha",
    ]);
  });

  test("descriptor digest covers every locked model contract field", async () => {
    const base = descriptor("alpha");
    const original = (await buildToolCatalog([{ sourceKind: "builtin", namespace: "local", registryName: "alpha", descriptor: base }])).entries[0]!;
    const variants = [
      { sourceKind: "mcp" as const, namespace: "local", descriptor: base },
      { sourceKind: "builtin" as const, namespace: "other", descriptor: base },
      { sourceKind: "builtin" as const, namespace: "local", descriptor: { ...base, description: "changed" } },
      { sourceKind: "builtin" as const, namespace: "local", descriptor: { ...base, inputSchema: z.object({ other: z.number() }) } },
      { sourceKind: "builtin" as const, namespace: "local", descriptor: { ...base, traits: { ...traits, readOnly: false } } },
      { sourceKind: "builtin" as const, namespace: "local", descriptor: { ...base, outputPolicy: { kind: "artifact" as const, previewDirection: "head" as const } } },
    ];
    for (const variant of variants) {
      const changed = (await buildToolCatalog([{ ...variant, registryName: "alpha" }])).entries[0]!;
      expect(changed.descriptorDigest).not.toBe(original.descriptorDigest);
    }
    const renamed = (await buildToolCatalog([{
      sourceKind: "builtin",
      namespace: "local",
      registryName: "beta",
      descriptor: descriptor("beta"),
    }])).entries[0]!;
    expect(renamed.descriptorDigest).not.toBe(original.descriptorDigest);
  });
});

describe("tool search", () => {
  test("excludes tool_search, respects namespace and limit, and uses a stable tie break", async () => {
    const fixture = await buildToolCatalog(["tool_search", "bravo", "alpha"].map((name) => ({
      sourceKind: "builtin" as const,
      namespace: "builtin",
      registryName: name,
      descriptor: descriptor(name, "shared ability"),
    })));
    const results = searchToolCatalog(buildToolSearchIndex(fixture), { query: "capability", namespace: "builtin", limit: 99 });
    expect(results.map((result) => result.name)).toEqual(["alpha", "bravo"]);
    expect(searchToolCatalog(buildToolSearchIndex(fixture), { query: "shared", namespace: "builtin", limit: 99 })
      .map((result) => result.name)).toEqual(["alpha", "bravo"]);
    expect(results).toHaveLength(2);
  });

  test("exact and prefix names receive boosts while typo trigrams remain searchable", async () => {
    const fixture = await catalog(["output_search", "output_read", "memory_read"]);
    const index = buildToolSearchIndex(fixture);
    expect(searchToolCatalog(index, { query: "output_search" })[0]?.name).toBe("output_search");
    expect(searchToolCatalog(index, { query: "output_sear" })[0]?.name).toBe("output_search");
    expect(searchToolCatalog(index, { query: "output_seacrh" })[0]?.name).toBe("output_search");
  });

  test("locked no-state corpora achieve Recall@5=100% and satisfy fixture invariants", async () => {
    expect(Object.keys(NO_STATE_DEFERRED_BUILTINS).sort()).toEqual([
      "analyst", "build", "discussion", "explore", "lead", "librarian",
    ]);
    for (const definition of agentDefinitions) {
      const agent = definition.name;
      const names = NO_STATE_DEFERRED_BUILTINS[agent];
      expect(names).not.toContain("tool_search");
      expect(new Set(names).size).toBe(names.length);
      const authorized = productionBuiltinFixture.registry.resolveForAgent(definition.tools.authorized).descriptors;
      const fixture = await buildToolCatalog(authorized.map((tool) => ({
        sourceKind: "builtin" as const,
        namespace: "builtin",
        registryName: tool.name,
        descriptor: tool,
      })));
      const projected = projectVisibleTools({
        catalog: fixture,
        core: definition.tools.core,
        state: [],
        loaded: [],
      });
      expect(projected.deferred.map((entry) => entry.registryName).sort(), agent)
        .toEqual([...names].sort());
      const index = buildToolSearchIndex({ digest: fixture.digest, entries: projected.deferred });
      const cases = TOOL_SEARCH_EVAL_CASES.filter((item) => item.agent === agent);
      expect(cases).toHaveLength(names.length * 3);
      for (const name of names) {
        expect(cases.filter((item) => item.expectedTool === name).map((item) => item.kind).sort()).toEqual([
          "capability", "synonym", "typo",
        ]);
      }
      for (const item of cases) {
        expect(names as readonly string[]).toContain(item.expectedTool);
        if (item.kind !== "typo") {
          const registryTokens = item.expectedTool.split("_");
          expect(registryTokens.some((token) => item.query.toLowerCase().includes(token))).toBe(false);
        }
        const results = searchToolCatalog(index, {
          query: item.query,
          namespace: item.namespace,
          limit: 5,
        });
        expect(results.map((result) => result.name)).toContain(item.expectedTool);
      }
    }
  });

  test("locks Top5 for similar local MCP tools while excluding unauthorized or unavailable servers", async () => {
    const docsLookup = mcpFixture(
      "docs",
      "lookup",
      "Look up archived API reference entries by release, programming language, and document kind. This local documentation index returns the exact versioned passage, source location, and compatibility notes for a selected contract without executing the remote service.",
    );
    const docsCacheLookup = mcpFixture(
      "docs-cache",
      "lookup",
      "Search cached API reference entries by release, programming language, and document kind. This local documentation cache keeps immutable snapshots of imported contracts, marks stale results, and returns the matching versioned passage with compatibility notes.",
    );
    const disabledLookup = mcpFixture(
      "offline-vault",
      "lookup",
      "Look up disabled vault records for a private API reference and release channel.",
    );
    const connectingLookup = mcpFixture(
      "loading-vault",
      "lookup",
      "Look up connecting vault records for a private API reference and release channel.",
    );
    const failedLookup = mcpFixture(
      "broken-vault",
      "lookup",
      "Look up failed vault records for a private API reference and release channel.",
    );
    const context7Lookup = mcpFixture(
      "context7",
      "lookup",
      "Look up context7 API reference records for a selected release channel.",
    );
    const exaLookup = mcpFixture(
      "exa",
      "lookup",
      "Look up exa API reference records for a selected release channel.",
    );
    const runtime = createTestMcpRuntime({
      descriptors: new Map([
        [docsLookup.name, docsLookup],
        [docsCacheLookup.name, docsCacheLookup],
        [disabledLookup.name, disabledLookup],
        [connectingLookup.name, connectingLookup],
        [failedLookup.name, failedLookup],
      ]),
      builtinDescriptors: {
        context7: new Map([[context7Lookup.name, context7Lookup]]),
        exa: new Map([[exaLookup.name, exaLookup]]),
      },
      statuses: {
        servers: {
          docs: { state: "ready", toolCount: 1, warningCount: 0, connectedAt: 1 },
          "docs-cache": { state: "ready", toolCount: 1, warningCount: 0, connectedAt: 1 },
          "offline-vault": { state: "disabled", updatedAt: 1 },
          "loading-vault": { state: "connecting", startedAt: 1 },
          "broken-vault": { state: "failed", error: "offline", failedAt: 1 },
          context7: { state: "ready", toolCount: 1, warningCount: 0, connectedAt: 1 },
          exa: { state: "ready", toolCount: 1, warningCount: 0, connectedAt: 1 },
        },
      },
    });
    const discussion = agentDefinitions.find((definition) => definition.name === "discussion")!;
    const snapshot = runtime.snapshotTools({ builtinServerNames: discussion.builtinMcpServers });
    expect(snapshot.tools.has(exaLookup.name)).toBe(false);
    expect(snapshot.tools.has(context7Lookup.name)).toBe(false);
    expect(snapshot.tools.has(disabledLookup.name)).toBe(false);
    expect(snapshot.tools.has(connectingLookup.name)).toBe(false);
    expect(snapshot.tools.has(failedLookup.name)).toBe(false);
    expect(snapshot.tools.get(docsLookup.name)?.serverName).toBe("docs");
    expect(snapshot.tools.get(docsCacheLookup.name)?.serverName).toBe("docs-cache");
    expect(docsLookup.description.length).toBeGreaterThan(200);
    expect(docsCacheLookup.description.length).toBeGreaterThan(200);
    expect(JSON.stringify(z.toJSONSchema(docsLookup.inputSchema))).toContain("enum");
    expect(JSON.stringify(z.toJSONSchema(docsCacheLookup.inputSchema))).toContain("enum");

    const authorized = productionBuiltinFixture.registry.resolveForAgent(discussion.tools.authorized).descriptors;
    const fixture = await buildToolCatalog([
      ...authorized.map((tool) => ({
        sourceKind: "builtin" as const,
        namespace: "builtin",
        registryName: tool.name,
        descriptor: tool,
      })),
      ...[...snapshot.tools].map(([registryName, entry]) => ({
        sourceKind: "mcp" as const,
        namespace: entry.serverName,
        registryName,
        descriptor: entry.descriptor,
      })),
    ]);
    const projected = projectVisibleTools({
      catalog: fixture,
      core: discussion.tools.core,
      state: [],
      loaded: [],
    });
    const index = buildToolSearchIndex({ digest: fixture.digest, entries: projected.deferred });
    const top5 = searchToolCatalog(index, {
      query: "lookup API reference entries by release and programming language",
      limit: 5,
    });
    expect(top5.map((result) => result.name)).toEqual([
      docsLookup.name,
      docsCacheLookup.name,
      "lsp_diagnostics",
      "lsp_find_references",
      "lsp_goto_definition",
    ]);
    expect(top5.map((result) => result.namespace)).toEqual([
      "docs",
      "docs-cache",
      "builtin",
      "builtin",
      "builtin",
    ]);
    for (const forbidden of [disabledLookup, connectingLookup, failedLookup, context7Lookup, exaLookup]) {
      expect(top5.map((result) => result.name)).not.toContain(forbidden.name);
    }
  });
});

describe("visible projection", () => {
  test("combines core, state, valid loads and deferred without accepting invalid refs", async () => {
    const fixture = await catalog(["tool_search", "core", "state", "loaded", "deferred"]);
    const loadedEntry = fixture.entries.find((entry) => entry.registryName === "loaded")!;
    const result = projectVisibleTools({
      catalog: fixture,
      core: ["core", "not_authorized"],
      state: ["state"],
      loaded: [
        { name: "loaded", descriptorDigest: loadedEntry.descriptorDigest },
        { name: "deferred", descriptorDigest: "stale" },
        { name: "missing", descriptorDigest: "none" },
        { name: "tool_search", descriptorDigest: "bad" },
      ],
    });
    expect(result.visible.map((entry) => entry.registryName)).toEqual(["core", "loaded", "state", "tool_search"]);
    expect(result.deferred.map((entry) => entry.registryName)).toEqual(["deferred"]);
    expect(result.invalidLoadedRefs.map((ref) => ref.reason)).toEqual([
      "digest_changed", "missing", "tool_search_excluded",
    ]);
  });

  test("does not expose an empty tool_search shell", async () => {
    const fixture = await catalog(["tool_search", "core"]);
    const result = projectVisibleTools({ catalog: fixture, core: ["core"], state: [], loaded: [] });
    expect(result.toolSearchVisible).toBe(false);
    expect(result.visible.map((entry) => entry.registryName)).toEqual(["core"]);
  });
});

describe("namespace summary", () => {
  test("bounds each item to 120 UTF-8 bytes and total output to 4 KiB using server ids", async () => {
    const inputs = Array.from({ length: 100 }, (_, index) => {
      const namespace = `server-${index.toString().padStart(3, "0")}`;
      return { sourceKind: "mcp" as const, namespace, registryName: `mcp_tool_${index}`, descriptor: descriptor(`mcp_tool_${index}`) };
    });
    const fixture = await buildToolCatalog(inputs);
    const descriptions = Object.fromEntries(inputs.map(({ namespace }) => [namespace, "远程能力".repeat(100)]));
    const summary = buildToolNamespaceSummary({ catalog: fixture, descriptions });
    expect(new TextEncoder().encode(summary).byteLength).toBeLessThanOrEqual(MAX_NAMESPACE_SUMMARY_BYTES);
    for (const line of summary.split("\n").filter((line) => !line.startsWith("..."))) {
      expect(new TextEncoder().encode(line).byteLength).toBeLessThanOrEqual(MAX_NAMESPACE_SUMMARY_ITEM_BYTES);
    }
    expect(summary).toContain("server-000");
    expect(summary).not.toContain("Remote Display Name");
  });
});
