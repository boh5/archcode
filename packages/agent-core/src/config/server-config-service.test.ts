import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ServerConfigEditableView, ServerConfigUpdate } from "@archcode/protocol";
import {
  BuiltinMcpConfigNameError,
  ConfigRevisionConflictError,
  ConfigSemanticValidationError,
  ServerConfigService,
  resolveServerConfigPath,
} from "./server-config-service";

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function config(): Record<string, unknown> {
  const agent = { model: "local:test-model" };
  return {
    provider: {
      local: {
        npm: "@ai-sdk/openai-compatible",
        name: "Local",
        options: {
          baseURL: "http://localhost:8090/v1",
          apiKey: "provider-secret",
          headers: { Authorization: "header-secret" },
          queryParams: { token: "query-secret" },
        },
        models: {
          "test-model": {
            name: "Test model",
            limit: { context: 128000, output: 8192 },
            modalities: { input: ["text"], output: ["text"] },
            variants: { fast: { maxOutputTokens: 2048 } },
          },
        },
      },
    },
    agents: {
      engineer: agent,
      goal_lead: agent,
      plan: agent,
      build: { ...agent, variant: "fast" },
      reviewer: agent,
      explore: agent,
      librarian: agent,
    },
    mcp: {
      servers: {
        custom: {
          url: "https://mcp.example.test",
          headers: { Authorization: "mcp-secret" },
        },
      },
    },
  };
}

function preserveSecrets(view: ServerConfigEditableView): ServerConfigUpdate {
  const update = structuredClone(view) as unknown as ServerConfigUpdate;
  update.provider.local.options.apiKey = { action: "preserve" };
  update.provider.local.options.headers = { Authorization: { action: "preserve" } };
  update.provider.local.options.queryParams = { token: { action: "preserve" } };
  update.mcp!.servers.custom.headers = { Authorization: { action: "preserve" } };
  return update;
}

async function createService(): Promise<ServerConfigService> {
  const homeDir = await mkdtemp(join(tmpdir(), "archcode-server-config-"));
  roots.push(homeDir);
  const path = resolveServerConfigPath(homeDir);
  await mkdir(join(homeDir, ".archcode"), { recursive: true });
  await writeFile(path, `${JSON.stringify(config(), null, 2)}\n`, { mode: 0o600 });
  const service = new ServerConfigService({ homeDir });
  await service.loadForStartup();
  return service;
}

async function createUnloadedService(): Promise<ServerConfigService> {
  const homeDir = await mkdtemp(join(tmpdir(), "archcode-server-config-"));
  roots.push(homeDir);
  return new ServerConfigService({ homeDir });
}

describe("ServerConfigService", () => {
  test("owns the fixed user config path and returns a redacted snapshot", async () => {
    const service = await createService();
    const snapshot = await service.getSnapshot();

    expect(snapshot.configPath).toBe(resolveServerConfigPath(service.homeDir));
    expect(snapshot.restartRequired).toBe(false);
    expect(snapshot.config.provider.local.options).toEqual({
      baseURL: "http://localhost:8090/v1",
      apiKey: { configured: true },
      headers: { Authorization: { configured: true } },
      queryParams: { token: { configured: true } },
    });
    expect(snapshot.config.mcp?.servers.custom.headers).toEqual({ Authorization: { configured: true } });
  });

  test("rejects a stale revision without touching the config file", async () => {
    const service = await createService();
    const before = await readFile(service.configPath, "utf8");
    const snapshot = await service.getSnapshot();

    await expect(service.save({ expectedRevision: "stale", config: preserveSecrets(snapshot.config) })).rejects.toBeInstanceOf(ConfigRevisionConflictError);
    expect(await readFile(service.configPath, "utf8")).toBe(before);
  });

  test("preserves masked and omitted secrets while applying explicit replacements", async () => {
    const service = await createService();
    const snapshot = await service.getSnapshot();
    const edited = preserveSecrets(snapshot.config);
    edited.provider.local.options.apiKey = { action: "preserve" };
    edited.provider.local.options.headers = { Authorization: { action: "replace", value: "replacement" } };
    delete edited.provider.local.options.queryParams;
    edited.mcp!.servers.custom.headers = { Authorization: { action: "preserve" } };

    await service.save({ expectedRevision: snapshot.revision, config: edited });
    const disk = JSON.parse(await readFile(service.configPath, "utf8")) as Record<string, any>;

    expect(disk.provider.local.options.apiKey).toBe("provider-secret");
    expect(disk.provider.local.options.headers).toEqual({ Authorization: "replacement" });
    expect(disk.provider.local.options.queryParams).toEqual({ token: "query-secret" });
    expect(disk.mcp?.servers.custom.headers).toEqual({ Authorization: "mcp-secret" });
  });

  test("requires explicit delete mutations for configured secret fields and records", async () => {
    const service = await createService();
    const snapshot = await service.getSnapshot();
    const edited = preserveSecrets(snapshot.config);
    edited.provider.local.name = "Changed";
    delete edited.provider.local.options.apiKey;
    delete edited.provider.local.options.headers;
    edited.provider.local.options.queryParams = {};
    delete edited.mcp!.servers.custom.headers;

    await service.save({ expectedRevision: snapshot.revision, config: edited });
    const disk = JSON.parse(await readFile(service.configPath, "utf8")) as Record<string, any>;

    expect(disk.provider.local.options.apiKey).toBe("provider-secret");
    expect(disk.provider.local.options.headers).toEqual({ Authorization: "header-secret" });
    expect(disk.provider.local.options.queryParams).toEqual({ token: "query-secret" });
    expect(disk.mcp.servers.custom.headers).toEqual({ Authorization: "mcp-secret" });
  });

  test("validates semantic cross-references before atomically writing a 0600 config", async () => {
    const service = await createService();
    const snapshot = await service.getSnapshot();
    const invalid = preserveSecrets(snapshot.config);
    invalid.agents.engineer.model = "missing:model";
    const before = await readFile(service.configPath, "utf8");

    await expect(service.save({ expectedRevision: snapshot.revision, config: invalid })).rejects.toBeInstanceOf(ConfigSemanticValidationError);
    expect(await readFile(service.configPath, "utf8")).toBe(before);

    const valid = preserveSecrets(snapshot.config);
    valid.provider.local.name = "Changed";
    const saved = await service.save({ expectedRevision: snapshot.revision, config: valid });
    const contents = await readFile(service.configPath, "utf8");
    expect(contents).toEndWith("\n");
    expect(contents).toContain('\n  "agents":');
    expect((await stat(service.configPath)).mode & 0o777).toBe(0o600);
    expect(saved.restartRequired).toBe(true);
  });

  test("rejects removed fixed config fields without touching preserved secrets", async () => {
    for (const mutate of [
      (draft: Record<string, any>) => { draft.$schema = "https://archcode.dev/schema.json"; },
      (draft: Record<string, any>) => { draft.mcp.servers.custom.transport = "http"; },
      (draft: Record<string, any>) => { draft.integrations = { github: { enabled: false, apiBaseUrl: "https://api.github.com" } }; },
    ]) {
      const service = await createService();
      const snapshot = await service.getSnapshot();
      const before = await readFile(service.configPath, "utf8");
      const invalid = preserveSecrets(snapshot.config) as unknown as Record<string, any>;
      mutate(invalid);

      await expect(service.save({
        expectedRevision: snapshot.revision,
        config: invalid as ServerConfigUpdate,
      })).rejects.toBeInstanceOf(ConfigSemanticValidationError);
      expect(await readFile(service.configPath, "utf8")).toBe(before);
    }
  });

  test("rejects unsupported provider packages, unknown variants, and invalid MCP URLs before writing", async () => {
    for (const mutate of [
      (draft: ServerConfigUpdate) => { draft.provider.local.npm = "unsupported"; },
      (draft: ServerConfigUpdate) => { draft.agents.engineer.variant = "missing"; },
      (draft: ServerConfigUpdate) => { draft.mcp!.servers.custom.url = "file:///not-http"; },
    ]) {
      const service = await createService();
      const snapshot = await service.getSnapshot();
      const before = await readFile(service.configPath, "utf8");
      const invalid = preserveSecrets(snapshot.config);
      mutate(invalid);
      await expect(service.save({ expectedRevision: snapshot.revision, config: invalid })).rejects.toBeInstanceOf(ConfigSemanticValidationError);
      expect(await readFile(service.configPath, "utf8")).toBe(before);
    }
  });

  test("rejects built-in MCP names before writing", async () => {
    const service = await createService();
    const snapshot = await service.getSnapshot();
    const invalid = preserveSecrets(snapshot.config);
    invalid.mcp!.servers.context7 = { url: "https://example.test" };

    await expect(service.save({ expectedRevision: snapshot.revision, config: invalid })).rejects.toBeInstanceOf(BuiltinMcpConfigNameError);
  });

  test("serializes same-revision saves so only one writer can succeed", async () => {
    const service = await createService();
    const snapshot = await service.getSnapshot();
    const first = preserveSecrets(snapshot.config);
    first.provider.local.name = "First";
    const second = preserveSecrets(snapshot.config);
    second.provider.local.name = "Second";

    const results = await Promise.allSettled([
      service.save({ expectedRevision: snapshot.revision, config: first }),
      service.save({ expectedRevision: snapshot.revision, config: second }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(ConfigRevisionConflictError);
  });

  test("rejects preservation for a secret that does not exist on disk", async () => {
    const service = await createService();
    const snapshot = await service.getSnapshot();
    const invalid = preserveSecrets(snapshot.config);
    invalid.provider.local.options.headers!.NewSecret = { action: "preserve" };

    await expect(service.save({ expectedRevision: snapshot.revision, config: invalid })).rejects.toMatchObject({
      issues: [{ path: "provider.local.options.headers.NewSecret" }],
    });
  });

  test("rejects untrusted secret mutations before they can delete stored secrets", async () => {
    for (const [target, value, path] of [
      ["apiKey", "raw-secret", "provider.local.options.apiKey"],
      ["apiKey", null, "provider.local.options.apiKey"],
      ["apiKey", { action: "unknown" }, "provider.local.options.apiKey"],
      ["header", "raw-secret", "provider.local.options.headers.Authorization"],
      ["header", null, "provider.local.options.headers.Authorization"],
      ["header", { action: "unknown" }, "provider.local.options.headers.Authorization"],
    ] as const) {
      const service = await createService();
      const snapshot = await service.getSnapshot();
      const before = await readFile(service.configPath, "utf8");
      const invalid = preserveSecrets(snapshot.config) as any;
      if (target === "apiKey") invalid.provider.local.options.apiKey = value;
      else invalid.provider.local.options.headers.Authorization = value;

      await expect(service.save({ expectedRevision: snapshot.revision, config: invalid })).rejects.toMatchObject({ issues: [{ path }] });
      expect(await readFile(service.configPath, "utf8")).toBe(before);
    }
  });

  test("defers empty replacement rules to the schema for each secret field", async () => {
    const service = await createService();
    const snapshot = await service.getSnapshot();
    const apiKeyEmpty = preserveSecrets(snapshot.config);
    apiKeyEmpty.provider.local.options.apiKey = { action: "replace", value: "" };
    await expect(service.save({ expectedRevision: snapshot.revision, config: apiKeyEmpty })).rejects.toMatchObject({
      issues: [{ path: "provider.local.options.apiKey" }],
    });

    const headerEmpty = preserveSecrets(snapshot.config);
    headerEmpty.provider.local.options.headers = { Authorization: { action: "replace", value: "" } };
    await expect(service.save({ expectedRevision: snapshot.revision, config: headerEmpty })).resolves.toMatchObject({ restartRequired: true });
  });

  test("fails startup only at the absolute global path and never falls back to a legacy local file", async () => {
    const service = await createUnloadedService();
    await writeFile(join(service.homeDir, ".archcode.json"), JSON.stringify(config()));

    await expect(service.loadForStartup()).rejects.toMatchObject({
      message: expect.stringContaining(service.configPath),
      issues: [{ path: service.configPath }],
    });
  });

  test("reports the absolute global path for invalid JSON and schema at startup", async () => {
    const invalidJson = await createUnloadedService();
    await mkdir(join(invalidJson.homeDir, ".archcode"), { recursive: true });
    await writeFile(invalidJson.configPath, "{");
    await expect(invalidJson.loadForStartup()).rejects.toMatchObject({ message: expect.stringContaining(invalidJson.configPath) });

    const invalidSchema = await createUnloadedService();
    await mkdir(join(invalidSchema.homeDir, ".archcode"), { recursive: true });
    await writeFile(invalidSchema.configPath, JSON.stringify({ provider: {} }));
    await expect(invalidSchema.loadForStartup()).rejects.toMatchObject({ message: expect.stringContaining(invalidSchema.configPath) });
  });

  test("reports the absolute global path when the config location is unreadable", async () => {
    const service = await createUnloadedService();
    await mkdir(service.configPath, { recursive: true });

    await expect(service.loadForStartup()).rejects.toMatchObject({
      message: expect.stringContaining(service.configPath),
      issues: [{ path: service.configPath }],
    });
  });

  test("does not write or require a restart for a no-op save, and a new startup clears restartRequired", async () => {
    const service = await createService();
    const snapshot = await service.getSnapshot();
    const unchanged = await service.save({ expectedRevision: snapshot.revision, config: preserveSecrets(snapshot.config) });
    expect(unchanged.revision).toBe(snapshot.revision);
    expect(unchanged.restartRequired).toBe(false);

    const changed = preserveSecrets(snapshot.config);
    changed.provider.local.name = "Changed";
    await service.save({ expectedRevision: snapshot.revision, config: changed });
    const restarted = new ServerConfigService({ homeDir: service.homeDir });
    await restarted.loadForStartup();
    expect((await restarted.getSnapshot()).restartRequired).toBe(false);
  });

  test("applies replace and delete explicitly for every secret location", async () => {
    const service = await createService();
    const before = await service.getSnapshot();
    const replace = preserveSecrets(before.config);
    replace.provider.local.options.apiKey = { action: "replace", value: "api-2" };
    replace.provider.local.options.headers = { Authorization: { action: "replace", value: "header-2" } };
    replace.provider.local.options.queryParams = { token: { action: "replace", value: "query-2" } };
    replace.mcp!.servers.custom.headers = { Authorization: { action: "replace", value: "mcp-2" } };
    const replaced = await service.save({ expectedRevision: before.revision, config: replace });
    const deleteAll = preserveSecrets(replaced.config);
    deleteAll.provider.local.options.apiKey = { action: "delete" };
    deleteAll.provider.local.options.headers = { Authorization: { action: "delete" } };
    deleteAll.provider.local.options.queryParams = { token: { action: "delete" } };
    deleteAll.mcp!.servers.custom.headers = { Authorization: { action: "delete" } };
    await service.save({ expectedRevision: replaced.revision, config: deleteAll });
    const disk = JSON.parse(await readFile(service.configPath, "utf8")) as Record<string, any>;
    expect(disk.provider.local.options.apiKey).toBeUndefined();
    expect(disk.provider.local.options.headers).toBeUndefined();
    expect(disk.provider.local.options.queryParams).toBeUndefined();
    expect(disk.mcp.servers.custom.headers).toBeUndefined();
  });
});
