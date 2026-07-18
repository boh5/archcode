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
import { providerAdapterCatalog, type ProviderAdapter } from "./provider-adapter-catalog";

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
            capabilities: { multiToolCallEmission: "parallel", structuredToolCalls: "strict", instructionTier: "standard" },
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
      shaper: agent,
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

function setNested(target: Record<string, any>, path: string, value: unknown): void {
  const segments = path.split(".");
  const final = segments.pop()!;
  let current = target;
  for (const segment of segments) current = current[segment] ??= {};
  current[final] = value;
}

function getNested(target: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) =>
    current !== null && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)[segment]
      : undefined, target);
}

function adapterConfig(adapter: ProviderAdapter): Record<string, any> {
  const options: Record<string, any> = adapter.npmPackage === "@ai-sdk/open-responses"
    ? { url: "https://responses.example.test/v1" }
    : adapter.npmPackage === "@ai-sdk/openai-compatible"
      ? { baseURL: "https://compatible.example.test/v1" }
      : adapter.npmPackage === "@ai-sdk/google-vertex"
        ? { project: "test-project", location: "us-central1" }
      : {};
  for (const secretPath of adapter.secretPaths) {
    if (secretPath.endsWith(".*")) {
      setNested(options, secretPath.slice(0, -2), { value: `original:${adapter.npmPackage}:${secretPath}` });
    } else {
      setNested(options, secretPath, `original:${adapter.npmPackage}:${secretPath}`);
    }
  }
  const agent = { model: "local:test-model" };
  return {
    provider: {
      local: {
        npm: adapter.npmPackage,
        name: adapter.displayName,
        options,
        models: {
          "test-model": {
            name: "Test model",
            limit: { context: 128000, output: 8192 },
            modalities: { input: ["text"], output: ["text"] },
            capabilities: { multiToolCallEmission: "parallel", structuredToolCalls: "strict", instructionTier: "standard" },
          },
        },
      },
    },
    agents: {
      engineer: agent,
      goal_lead: agent,
      plan: agent,
      build: agent,
      reviewer: agent,
      explore: agent,
      librarian: agent,
      shaper: agent,
    },
  };
}

async function createAdapterService(adapter: ProviderAdapter): Promise<ServerConfigService> {
  const service = await createUnloadedService();
  await mkdir(join(service.homeDir, ".archcode"), { recursive: true });
  await writeFile(service.configPath, `${JSON.stringify(adapterConfig(adapter), null, 2)}\n`, { mode: 0o600 });
  await service.loadForStartup();
  return service;
}

function secretMutationUpdate(
  view: ServerConfigEditableView,
  adapter: ProviderAdapter,
  action: "preserve" | "replace" | "delete",
): ServerConfigUpdate {
  const update = structuredClone(view) as unknown as ServerConfigUpdate;
  const options = update.provider.local.options as Record<string, any>;
  for (const secretPath of adapter.secretPaths) {
    if (secretPath.endsWith(".*")) {
      const path = secretPath.slice(0, -2);
      const names = Object.keys((getNested(options, path) as Record<string, unknown> | undefined) ?? {});
      setNested(options, path, Object.fromEntries(names.map((name) => [name,
        action === "replace"
          ? { action, value: `replacement:${adapter.npmPackage}:${secretPath}:${name}` }
          : { action },
      ])));
    } else {
      setNested(options, secretPath, action === "replace"
        ? { action, value: `replacement:${adapter.npmPackage}:${secretPath}` }
        : { action });
    }
  }
  return update;
}

function setRawSecretMutation(update: ServerConfigUpdate, secretPath: string): void {
  const options = update.provider.local.options as Record<string, any>;
  if (secretPath.endsWith(".*")) {
    setNested(options, secretPath.slice(0, -2), { value: "raw-secret-mutation" });
  } else {
    setNested(options, secretPath, "raw-secret-mutation");
  }
}

describe("ServerConfigService", () => {
  test("owns the fixed user config path and returns a redacted snapshot", async () => {
    const service = await createService();
    const snapshot = await service.getSnapshot();

    expect(snapshot.configPath).toBe(resolveServerConfigPath(service.homeDir));
    expect(snapshot.modelRuntimeRevision).toBe(snapshot.revision);
    expect(snapshot.restartRequiredSections).toEqual([]);
    expect(snapshot.config.provider.local.options).toEqual({
      baseURL: "http://localhost:8090/v1",
      apiKey: { configured: true },
      headers: { Authorization: { configured: true } },
      queryParams: { token: { configured: true } },
    });
    expect(snapshot.config.mcp?.servers.custom.headers).toEqual({ Authorization: { configured: true } });
  });

  test("redacts and mutates every declared secret path for every adapter", async () => {
    for (const adapter of providerAdapterCatalog.list()) {
      const service = await createAdapterService(adapter);
      const snapshot = await service.getSnapshot();
      const serialized = JSON.stringify(snapshot);
      expect(serialized).not.toContain(`original:${adapter.npmPackage}`);

      const originalBytes = await readFile(service.configPath, "utf8");
      for (const secretPath of adapter.secretPaths) {
        const invalid = secretMutationUpdate(snapshot.config, adapter, "preserve");
        setRawSecretMutation(invalid, secretPath);
        await expect(service.save({ expectedRevision: snapshot.revision, config: invalid })).rejects.toBeInstanceOf(ConfigSemanticValidationError);
        expect(await readFile(service.configPath, "utf8")).toBe(originalBytes);
      }

      const preserved = await service.save({
        expectedRevision: snapshot.revision,
        config: secretMutationUpdate(snapshot.config, adapter, "preserve"),
      });
      expect(await readFile(service.configPath, "utf8")).toBe(originalBytes);

      const replaced = await service.save({
        expectedRevision: preserved.revision,
        config: secretMutationUpdate(preserved.config, adapter, "replace"),
      });
      expect(JSON.stringify(replaced)).not.toContain(`replacement:${adapter.npmPackage}`);
      expect(JSON.stringify(await service.getSnapshot())).not.toContain(`replacement:${adapter.npmPackage}`);
      const replacementDisk = JSON.parse(await readFile(service.configPath, "utf8")) as Record<string, any>;
      for (const secretPath of adapter.secretPaths) {
        if (secretPath.endsWith(".*")) {
          expect(getNested(replacementDisk.provider.local.options, secretPath.slice(0, -2))).toEqual({
            value: `replacement:${adapter.npmPackage}:${secretPath}:value`,
          });
        } else {
          expect(getNested(replacementDisk.provider.local.options, secretPath)).toBe(`replacement:${adapter.npmPackage}:${secretPath}`);
        }
      }

      await service.save({
        expectedRevision: replaced.revision,
        config: secretMutationUpdate(replaced.config, adapter, "delete"),
      });
      const deletedDisk = JSON.parse(await readFile(service.configPath, "utf8")) as Record<string, any>;
      for (const secretPath of adapter.secretPaths) {
        const path = secretPath.endsWith(".*") ? secretPath.slice(0, -2) : secretPath;
        expect(getNested(deletedDisk.provider.local.options, path)).toBeUndefined();
      }
    }
  }, 30_000);

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
    const beforeRuntime = service.modelRuntime.current;

    await expect(service.save({ expectedRevision: snapshot.revision, config: invalid })).rejects.toBeInstanceOf(ConfigSemanticValidationError);
    expect(await readFile(service.configPath, "utf8")).toBe(before);
    expect(service.modelRuntime.current).toBe(beforeRuntime);

    const valid = preserveSecrets(snapshot.config);
    valid.provider.local.name = "Changed";
    const saved = await service.save({ expectedRevision: snapshot.revision, config: valid });
    const contents = await readFile(service.configPath, "utf8");
    expect(contents).toEndWith("\n");
    expect(contents).toContain('\n  "agents":');
    expect((await stat(service.configPath)).mode & 0o777).toBe(0o600);
    expect(saved.modelRuntimeRevision).toBe(saved.revision);
    expect(saved.restartRequiredSections).toEqual([]);
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
    ((invalid.provider.local.options.headers ??= {}) as Record<string, unknown>).NewSecret = { action: "preserve" };

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
    await expect(service.save({ expectedRevision: snapshot.revision, config: headerEmpty })).resolves.toMatchObject({ restartRequiredSections: [] });
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

  test("rejects singular and plural undeclared credential options during startup and GET", async () => {
    for (const key of [
      "accessToken",
      "credentials",
      "accessKeyId",
      "secretAccessKey",
      "authorizationHeader",
      "credentialProvider",
    ] as const) {
      const service = await createUnloadedService();
      const invalid = config() as Record<string, any>;
      invalid.provider.local.npm = "@ai-sdk/openai";
      delete invalid.provider.local.options.queryParams;
      invalid.provider.local.options[key] = "must-never-reach-a-view";
      await mkdir(join(service.homeDir, ".archcode"), { recursive: true });
      await writeFile(service.configPath, `${JSON.stringify(invalid, null, 2)}\n`);

      await expect(service.loadForStartup()).rejects.toMatchObject({
        issues: [{ path: `provider.local.options.${key}` }],
      });
      await expect(service.getSnapshot()).rejects.toMatchObject({
        issues: [{ path: `provider.local.options.${key}` }],
      });
    }
  });

  test("rejects a scalar credential container even when an adapter declares a nested secret", async () => {
    const service = await createUnloadedService();
    const invalid = adapterConfig(providerAdapterCatalog.get("@ai-sdk/google-vertex")!);
    invalid.provider.local.options.googleAuthOptions.credentials = "must-never-reach-a-view";
    await mkdir(join(service.homeDir, ".archcode"), { recursive: true });
    await writeFile(service.configPath, `${JSON.stringify(invalid, null, 2)}\n`);

    await expect(service.loadForStartup()).rejects.toMatchObject({
      issues: [{ path: "provider.local.options.googleAuthOptions.credentials" }],
    });
    await expect(service.getSnapshot()).rejects.toMatchObject({
      issues: [{ path: "provider.local.options.googleAuthOptions.credentials" }],
    });
  });

  test("rejects Provider secret values copied into display or Advanced fields", async () => {
    const unloaded = await createUnloadedService();
    const invalid = config() as Record<string, any>;
    invalid.provider.local.name = "header-secret";
    invalid.provider.local.options.advanced = {
      mirroredProvider: "provider-secret",
      mirroredMcp: "mcp-secret",
    };
    invalid.provider.local.models["test-model"].name = "query-secret";
    await mkdir(join(unloaded.homeDir, ".archcode"), { recursive: true });
    await writeFile(unloaded.configPath, `${JSON.stringify(invalid, null, 2)}\n`);

    const expectedIssues = [
      { path: "provider.local.name" },
      { path: "provider.local.options.advanced.mirroredProvider" },
      { path: "provider.local.options.advanced.mirroredMcp" },
      { path: "provider.local.models.test-model.name" },
    ];
    await expect(unloaded.loadForStartup()).rejects.toMatchObject({ issues: expectedIssues });
    await expect(unloaded.getSnapshot()).rejects.toMatchObject({ issues: expectedIssues });

    const service = await createService();
    const snapshot = await service.getSnapshot();
    const update = preserveSecrets(snapshot.config);
    update.provider.local.options.advanced = {
      mirroredProvider: "provider-secret",
      mirroredMcp: "mcp-secret",
    };
    const before = await readFile(service.configPath, "utf8");
    await expect(service.save({ expectedRevision: snapshot.revision, config: update })).rejects.toMatchObject({
      issues: [
        { path: "provider.local.options.advanced.mirroredProvider" },
        { path: "provider.local.options.advanced.mirroredMcp" },
      ],
    });
    expect(await readFile(service.configPath, "utf8")).toBe(before);
    expect(service.modelRuntime.current.revision).toBe(snapshot.modelRuntimeRevision);
  });

  test("rejects a supplied invalid optional Provider URL at its exact field path", async () => {
    const startup = await createUnloadedService();
    const invalid = config() as Record<string, any>;
    invalid.provider.local.npm = "@ai-sdk/openai";
    delete invalid.provider.local.options.queryParams;
    invalid.provider.local.options.baseURL = "not-a-url";
    await mkdir(join(startup.homeDir, ".archcode"), { recursive: true });
    await writeFile(startup.configPath, `${JSON.stringify(invalid, null, 2)}\n`);
    await expect(startup.loadForStartup()).rejects.toMatchObject({
      issues: [{ path: "provider.local.options.baseURL" }],
    });

    const service = await createService();
    const snapshot = await service.getSnapshot();
    const update = preserveSecrets(snapshot.config);
    update.provider.local.options.baseURL = "not-a-url";
    const before = await readFile(service.configPath, "utf8");
    await expect(service.save({ expectedRevision: snapshot.revision, config: update })).rejects.toMatchObject({
      issues: [{ path: "provider.local.options.baseURL" }],
    });
    expect(await readFile(service.configPath, "utf8")).toBe(before);
  });

  test("rejects Provider URL credentials, query parameters, and fragments across startup, GET, and PUT", async () => {
    for (const unsafeUrl of [
      "https://user:password@provider.example/v1",
      "https://provider.example/v1?api_key=url-secret",
      "https://provider.example/v1#url-secret",
    ]) {
      const unloaded = await createUnloadedService();
      const invalid = config() as Record<string, any>;
      invalid.provider.local.options.baseURL = unsafeUrl;
      await mkdir(join(unloaded.homeDir, ".archcode"), { recursive: true });
      await writeFile(unloaded.configPath, `${JSON.stringify(invalid, null, 2)}\n`);

      await expect(unloaded.loadForStartup()).rejects.toMatchObject({
        issues: [{ path: "provider.local.options.baseURL" }],
      });
      await expect(unloaded.getSnapshot()).rejects.toMatchObject({
        issues: [{ path: "provider.local.options.baseURL" }],
      });

      const service = await createService();
      const snapshot = await service.getSnapshot();
      const update = preserveSecrets(snapshot.config);
      update.provider.local.options.baseURL = unsafeUrl;
      const beforeDisk = await readFile(service.configPath, "utf8");
      const beforeRuntime = service.modelRuntime.current;

      await expect(service.save({ expectedRevision: snapshot.revision, config: update })).rejects.toMatchObject({
        issues: [{ path: "provider.local.options.baseURL" }],
      });
      expect(await readFile(service.configPath, "utf8")).toBe(beforeDisk);
      expect(service.modelRuntime.current).toBe(beforeRuntime);
    }
  });

  test("rejects credential-bearing URLs in undeclared Advanced fields", async () => {
    for (const unsafeUrl of [
      "https://user:password@advanced.example/v1",
      "https://advanced.example/v1?token=advanced-secret",
      "https://advanced.example/v1#advanced-secret",
    ]) {
      const unloaded = await createUnloadedService();
      const invalid = config() as Record<string, any>;
      invalid.provider.local.options.endpoint = unsafeUrl;
      await mkdir(join(unloaded.homeDir, ".archcode"), { recursive: true });
      await writeFile(unloaded.configPath, `${JSON.stringify(invalid, null, 2)}\n`);

      await expect(unloaded.loadForStartup()).rejects.toMatchObject({
        issues: [{ path: "provider.local.options.endpoint" }],
      });
      await expect(unloaded.getSnapshot()).rejects.toMatchObject({
        issues: [{ path: "provider.local.options.endpoint" }],
      });

      const service = await createService();
      const snapshot = await service.getSnapshot();
      const update = preserveSecrets(snapshot.config);
      update.provider.local.options.endpoint = unsafeUrl;
      const beforeDisk = await readFile(service.configPath, "utf8");
      const beforeRuntime = service.modelRuntime.current;

      await expect(service.save({ expectedRevision: snapshot.revision, config: update })).rejects.toMatchObject({
        issues: [{ path: "provider.local.options.endpoint" }],
      });
      expect(await readFile(service.configPath, "utf8")).toBe(beforeDisk);
      expect(service.modelRuntime.current).toBe(beforeRuntime);
    }
  });

  test("rejects Advanced name when Provider ID owns the SDK namespace", async () => {
    const unloaded = await createUnloadedService();
    const invalid = config() as Record<string, any>;
    invalid.provider.local.options.name = "shadow-namespace";
    await mkdir(join(unloaded.homeDir, ".archcode"), { recursive: true });
    await writeFile(unloaded.configPath, `${JSON.stringify(invalid, null, 2)}\n`);

    await expect(unloaded.loadForStartup()).rejects.toMatchObject({
      issues: [{ path: "provider.local.options.name" }],
    });
    await expect(unloaded.getSnapshot()).rejects.toMatchObject({
      issues: [{ path: "provider.local.options.name" }],
    });

    const service = await createService();
    const snapshot = await service.getSnapshot();
    const update = preserveSecrets(snapshot.config);
    update.provider.local.options.name = "shadow-namespace";
    const beforeDisk = await readFile(service.configPath, "utf8");
    const beforeRuntime = service.modelRuntime.current;

    await expect(service.save({ expectedRevision: snapshot.revision, config: update })).rejects.toMatchObject({
      issues: [{ path: "provider.local.options.name" }],
    });
    expect(await readFile(service.configPath, "utf8")).toBe(beforeDisk);
    expect(service.modelRuntime.current).toBe(beforeRuntime);
  });

  test("rejects queryParams for Providers whose SDK factory does not support them", async () => {
    const unloaded = await createUnloadedService();
    const invalid = config() as Record<string, any>;
    invalid.provider.local.npm = "@ai-sdk/openai";
    invalid.provider.local.options.queryParams = { opaque: "query-secret-sentinel" };
    await mkdir(join(unloaded.homeDir, ".archcode"), { recursive: true });
    await writeFile(unloaded.configPath, `${JSON.stringify(invalid, null, 2)}\n`);

    await expect(unloaded.loadForStartup()).rejects.toMatchObject({
      issues: [{ path: "provider.local.options.queryParams" }],
    });
    await expect(unloaded.getSnapshot()).rejects.toMatchObject({
      issues: [{ path: "provider.local.options.queryParams" }],
    });

    const service = await createUnloadedService();
    const validOpenAi = config() as Record<string, any>;
    validOpenAi.provider.local.npm = "@ai-sdk/openai";
    delete validOpenAi.provider.local.options.queryParams;
    await mkdir(join(service.homeDir, ".archcode"), { recursive: true });
    await writeFile(service.configPath, `${JSON.stringify(validOpenAi, null, 2)}\n`);
    await service.loadForStartup();
    const snapshot = await service.getSnapshot();
    const update = preserveSecrets(snapshot.config);
    update.provider.local.options.queryParams = { opaque: "query-value" } as never;
    const beforeDisk = await readFile(service.configPath, "utf8");
    const beforeRuntime = service.modelRuntime.current;

    await expect(service.save({ expectedRevision: snapshot.revision, config: update })).rejects.toMatchObject({
      issues: [{ path: "provider.local.options.queryParams" }],
    });
    expect(await readFile(service.configPath, "utf8")).toBe(beforeDisk);
    expect(service.modelRuntime.current).toBe(beforeRuntime);
  });

  test("reports the absolute global path when the config location is unreadable", async () => {
    const service = await createUnloadedService();
    await mkdir(service.configPath, { recursive: true });

    await expect(service.loadForStartup()).rejects.toMatchObject({
      message: expect.stringContaining(service.configPath),
      issues: [{ path: service.configPath }],
    });
  });

  test("publishes a no-op save and reports restart-required non-model sections", async () => {
    const service = await createService();
    const snapshot = await service.getSnapshot();
    const unchanged = await service.save({ expectedRevision: snapshot.revision, config: preserveSecrets(snapshot.config) });
    expect(unchanged.revision).toBe(snapshot.revision);
    expect(unchanged.modelRuntimeRevision).toBe(snapshot.revision);
    expect(unchanged.restartRequiredSections).toEqual([]);

    const changed = preserveSecrets(snapshot.config);
    changed.provider.local.name = "Changed";
    await service.save({ expectedRevision: snapshot.revision, config: changed });
    const restarted = new ServerConfigService({ homeDir: service.homeDir });
    await restarted.loadForStartup();
    expect((await restarted.getSnapshot()).restartRequiredSections).toEqual([]);
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

  test("publishes the disk revision after an external edit even when PUT is a no-op", async () => {
    const service = await createService();
    const beforeRevision = service.modelRuntime.current.revision;
    const externallyEdited = config() as Record<string, any>;
    externallyEdited.provider.local.name = "Edited outside the service";
    const externalText = `${JSON.stringify(externallyEdited, null, 2)}\n`;
    await writeFile(service.configPath, externalText);

    const snapshot = await service.getSnapshot();
    expect(snapshot.modelRuntimeRevision).toBe(beforeRevision);
    const saved = await service.save({
      expectedRevision: snapshot.revision,
      config: preserveSecrets(snapshot.config),
    });

    expect(saved.modelRuntimeRevision).toBe(snapshot.revision);
    expect(await readFile(service.configPath, "utf8")).toBe(externalText);
  });

  test("does not preserve secrets across a provider package switch", async () => {
    const service = await createService();
    const snapshot = await service.getSnapshot();
    const switched = preserveSecrets(snapshot.config);
    switched.provider.local.npm = "@ai-sdk/openai";
    delete switched.provider.local.options.queryParams;

    await expect(service.save({ expectedRevision: snapshot.revision, config: switched })).rejects.toMatchObject({
      issues: [{ path: "provider.local.options.apiKey" }],
    });
  });

  test("rejects secret-bearing provider keys not declared by the selected adapter", async () => {
    for (const key of [
      "accessToken",
      "credentials",
      "accessKeyId",
      "secretAccessKey",
      "authorizationHeader",
      "credentialProvider",
    ] as const) {
      const service = await createService();
      const snapshot = await service.getSnapshot();
      const invalid = preserveSecrets(snapshot.config);
      invalid.provider.local.options[key] = { action: "replace", value: "secret" };
      const before = await readFile(service.configPath, "utf8");

      await expect(service.save({ expectedRevision: snapshot.revision, config: invalid })).rejects.toMatchObject({
        issues: [{ path: `provider.local.options.${key}` }],
      });
      expect(await readFile(service.configPath, "utf8")).toBe(before);
    }
  });

  test("applies models live while reporting every mixed non-model restart section", async () => {
    const service = await createService();
    const snapshot = await service.getSnapshot();
    const update = preserveSecrets(snapshot.config);
    update.provider.local.models["new-model"] = {
      name: "New model",
      limit: { context: 64_000, output: 4_096 },
      modalities: { input: ["text"], output: ["text"] },
      capabilities: { multiToolCallEmission: "parallel", structuredToolCalls: "strict", instructionTier: "standard" },
    };
    update.mcp!.servers.custom.url = "https://changed.example.test";
    update.memory = { enabled: false };
    update.integrations = { github: { enabled: false } };

    const saved = await service.save({ expectedRevision: snapshot.revision, config: update });
    expect(saved.modelRuntimeRevision).toBe(saved.revision);
    expect(service.modelRuntime.current.revision).toBe(saved.revision);
    expect(service.modelRuntime.current.tryResolveSelection({ model: "local:new-model" })).toBeDefined();
    expect(saved.restartRequiredSections).toEqual(["mcp", "memory", "integrations.github"]);
  });
});
