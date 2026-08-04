import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ServerConfigEditableView, ServerConfigUpdate } from "@archcode/protocol";
import {
  BuiltinMcpConfigNameError,
  ConfigInitializationConflictError,
  ConfigRecoveryConflictError,
  ConfigRevisionConflictError,
  ConfigSemanticValidationError,
  InvalidConfigRemovalError,
  ServerConfigService,
  resolveServerConfigPath,
} from "./server-config-service";
import { providerAdapterCatalog, type ProviderAdapter } from "./provider-adapter-catalog";
import { ModelRuntime } from "../models";

const roots: string[] = [];
const PASSWORD_HASH = "$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA";

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function config(): Record<string, unknown> {
  const profile = { model: "local:test-model" };
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
    profiles: {
      principal: profile,
      deep: profile,
      fast: { ...profile, variant: "fast" },
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

function initialConfig(passwordHash?: string): Record<string, unknown> {
  const candidate = config() as Record<string, any>;
  candidate.provider.local.options.apiKey = { action: "replace", value: "provider-secret" };
  candidate.provider.local.options.headers = {
    Authorization: { action: "replace", value: "header-secret" },
  };
  candidate.provider.local.options.queryParams = {
    token: { action: "replace", value: "query-secret" },
  };
  candidate.mcp.servers.custom.headers = {
    Authorization: { action: "replace", value: "mcp-secret" },
  };
  if (passwordHash !== undefined) candidate.auth = { passwordHash };
  return candidate;
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
  await activateReady(service);
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
  const profile = { model: "local:test-model" };
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
          },
        },
      },
    },
    profiles: {
      principal: profile,
      deep: profile,
      fast: profile,
    },
  };
}

async function createAdapterService(adapter: ProviderAdapter): Promise<ServerConfigService> {
  const service = await createUnloadedService();
  await mkdir(join(service.homeDir, ".archcode"), { recursive: true });
  await writeFile(service.configPath, `${JSON.stringify(adapterConfig(adapter), null, 2)}\n`, { mode: 0o600 });
  await activateReady(service);
  return service;
}

async function activateReady(service: ServerConfigService) {
  const result = await service.activateForStartup();
  if (result.status !== "ready") throw new Error(`Expected ready config, received ${result.status}`);
  return result.activation;
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
  test("classifies only a missing config as setup", async () => {
    const missing = await createUnloadedService();
    expect(await missing.activateForStartup()).toEqual({ status: "setup" });

    const unreadable = await createUnloadedService();
    await mkdir(unreadable.configPath, { recursive: true });
    expect(await unreadable.activateForStartup()).toMatchObject({
      status: "config_error",
      error: { issues: [{ path: unreadable.configPath }] },
    });
  });

  test("classifies a dangling Config symlink as config_error, not setup", async () => {
    const service = await createUnloadedService();
    await mkdir(join(service.homeDir, ".archcode"), { recursive: true });
    await symlink(
      join(service.homeDir, "missing-config-target.json"),
      service.configPath,
    );

    const result = await service.activateForStartup();

    expect(result.status).toBe("config_error");
    if (result.status === "config_error") {
      expect(result.error.issues[0]?.path).toBe(service.configPath);
    }
  });

  test("initializes once with OS-level no-replace and separated auth projection", async () => {
    const first = await createUnloadedService();
    const homeDir = first.homeDir;
    const second = new ServerConfigService({ homeDir });

    const results = await Promise.allSettled([
      first.initialize(initialConfig(PASSWORD_HASH)),
      second.initialize(initialConfig(PASSWORD_HASH)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : undefined)
      .toBeInstanceOf(ConfigInitializationConflictError);

    const activationResult = await new ServerConfigService({ homeDir }).activateForStartup();
    expect(activationResult.status).toBe("ready");
    if (activationResult.status !== "ready") return;
    expect(activationResult.auth).toEqual({ passwordHash: PASSWORD_HASH });
    expect(activationResult.activation).not.toHaveProperty("auth");
    expect(activationResult.activation.runtimeConfig).not.toHaveProperty("auth");
    expect(JSON.stringify(activationResult.activation.runtimeConfig)).not.toContain(PASSWORD_HASH);
    expect((await stat(join(homeDir, ".archcode"))).mode & 0o777).toBe(0o700);
    expect((await stat(resolveServerConfigPath(homeDir))).mode & 0o777).toBe(0o600);
  });

  test("requires replace actions for every initial secret", async () => {
    for (const action of ["preserve", "delete"] as const) {
      const service = await createUnloadedService();
      const candidate = initialConfig() as Record<string, any>;
      candidate.provider.local.options.apiKey = { action };
      await expect(service.initialize(candidate)).rejects.toMatchObject({
        issues: [{
          path: "provider.local.options.apiKey",
          message: "Initial secret must use a replace action",
        }],
      });
      expect(await service.activateForStartup()).toEqual({ status: "setup" });
    }
  });

  test("keeps auth out of editable config and preserves it across generic saves", async () => {
    const service = await createUnloadedService();
    await service.initialize(initialConfig(PASSWORD_HASH));
    const snapshot = await service.getSnapshot();
    expect(snapshot.config).not.toHaveProperty("auth");
    expect(JSON.stringify(snapshot)).not.toContain(PASSWORD_HASH);

    const update = preserveSecrets(snapshot.config);
    update.provider.local.name = "Updated";
    await service.save({ expectedRevision: snapshot.revision, config: update });
    expect(JSON.parse(await readFile(service.configPath, "utf8")).auth)
      .toEqual({ passwordHash: PASSWORD_HASH });

    const malicious = preserveSecrets((await service.getSnapshot()).config) as unknown as Record<string, any>;
    malicious.auth = { passwordHash: "$argon2id$v=19$m=1,t=1,p=1$ZXZpbA$ZXZpbA" };
    const current = await service.getSnapshot();
    await service.save({
      expectedRevision: current.revision,
      config: malicious as ServerConfigUpdate,
    });
    expect(JSON.parse(await readFile(service.configPath, "utf8")).auth)
      .toEqual({ passwordHash: PASSWORD_HASH });
  });

  test("updates auth without preparing or publishing the model runtime", async () => {
    const service = await createUnloadedService();
    await service.initialize(initialConfig());
    const beforeRuntime = service.modelRuntime.current;
    let publications = 0;
    const unsubscribe = service.modelRuntime.subscribe(() => {
      publications += 1;
    });
    await expect(service.updateAuthPasswordHash("plaintext")).rejects.toMatchObject({
      issues: [{ path: "auth.passwordHash" }],
    });
    const enabled = await service.updateAuthPasswordHash(PASSWORD_HASH);
    expect(enabled.credential).toEqual({ passwordHash: PASSWORD_HASH });
    expect(JSON.parse(await readFile(service.configPath, "utf8")).auth)
      .toEqual({ passwordHash: PASSWORD_HASH });
    const authSnapshot = await service.getSnapshot();
    await service.save({
      expectedRevision: authSnapshot.revision,
      config: preserveSecrets(authSnapshot.config),
    });
    const disabled = await service.updateAuthPasswordHash(undefined);
    expect(disabled.credential).toBeUndefined();
    expect(JSON.parse(await readFile(service.configPath, "utf8")).auth).toBeUndefined();
    expect(service.modelRuntime.current).toBe(beforeRuntime);
    expect(publications).toBe(0);
    unsubscribe();
  });

  test("keeps the auth-free model revision stable across different password hashes", async () => {
    const first = await createUnloadedService();
    const second = await createUnloadedService();
    await first.initialize(initialConfig(PASSWORD_HASH));
    await second.initialize(initialConfig(
      "$argon2id$v=19$m=65536,t=3,p=1$c2FsdDI$aGFzaDI",
    ));

    expect(first.modelRuntime.current.revision)
      .toBe(second.modelRuntime.current.revision);
    expect((await first.getSnapshot()).revision)
      .not.toBe((await second.getSnapshot()).revision);
  });

  test("rejects foreign and stale Runtime activations", async () => {
    const service = await createUnloadedService();
    const initialized = await service.initialize(initialConfig());
    const foreign = new ServerConfigService({ homeDir: service.homeDir });
    expect(() => foreign.resolveRuntimeConfig(initialized.activation))
      .toThrow("belongs to a different ServerConfigService");

    await service.updateAuthPasswordHash(PASSWORD_HASH);
    expect(service.resolveRuntimeConfig(initialized.activation))
      .toBe(initialized.activation.runtimeConfig);
  });

  test("owns the fixed user config path and returns a redacted snapshot", async () => {
    const service = await createService();
    const snapshot = await service.getSnapshot();

    expect(snapshot.configPath).toBe(resolveServerConfigPath(service.homeDir));
    expect(snapshot.modelRuntimeRevision).toBe(service.modelRuntime.current.revision);
    expect(snapshot.restartRequiredSections).toEqual([]);
    expect(snapshot.config.provider.local.options).toEqual({
      baseURL: "http://localhost:8090/v1",
      apiKey: { configured: true },
      headers: { Authorization: { configured: true } },
      queryParams: { token: { configured: true } },
    });
    expect(snapshot.config.mcp?.servers.custom.headers).toEqual({ Authorization: { configured: true } });
  });

  for (const adapter of providerAdapterCatalog.list()) {
    test(`redacts and mutates every declared secret path for ${adapter.npmPackage}`, async () => {
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
    });
  }

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
    invalid.profiles.principal.model = "missing:model";
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
    expect(contents).toContain('\n  "profiles":');
    expect((await stat(service.configPath)).mode & 0o777).toBe(0o600);
    expect(saved.modelRuntimeRevision).toBe(saved.revision);
    expect(saved.restartRequiredSections).toEqual([]);
  });

  test("preserves the file when strict validation rejects an unknown field", async () => {
    const service = await createService();
    const snapshot = await service.getSnapshot();
    const before = await readFile(service.configPath, "utf8");
    const invalid = preserveSecrets(snapshot.config) as unknown as Record<string, any>;
    invalid.unexpectedField = true;

    await expect(service.save({
      expectedRevision: snapshot.revision,
      config: invalid as ServerConfigUpdate,
    })).rejects.toBeInstanceOf(ConfigSemanticValidationError);
    expect(await readFile(service.configPath, "utf8")).toBe(before);
  });

  test("rejects unsupported provider packages and invalid MCP URLs before writing", async () => {
    for (const mutate of [
      (draft: ServerConfigUpdate) => { draft.provider.local.npm = "unsupported"; },
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

  test("saves a missing Profile variant and publishes its model-default fallback", async () => {
    const service = await createService();
    const snapshot = await service.getSnapshot();
    const update = preserveSecrets(snapshot.config);
    update.profiles.fast.variant = "removed";

    const saved = await service.save({
      expectedRevision: snapshot.revision,
      config: update,
    });

    expect(saved.config.profiles.fast.variant).toBe("removed");
    expect(service.modelRuntime.current.getProfileDefault("fast")).toEqual({
      model: "local:test-model",
    });
    expect(service.modelRuntime.current.catalog.profileDefaults.fast).toEqual({
      model: "local:test-model",
    });
    expect(JSON.parse(await readFile(service.configPath, "utf8")).profiles.fast.variant).toBe("removed");
  });

  test("normalizes an empty Profile variant to the model default on save", async () => {
    const service = await createService();
    const snapshot = await service.getSnapshot();
    const update = preserveSecrets(snapshot.config);
    update.profiles.fast.variant = "";

    const saved = await service.save({
      expectedRevision: snapshot.revision,
      config: update,
    });

    expect(saved.config.profiles.fast.variant).toBeUndefined();
    expect(service.modelRuntime.current.getProfileDefault("fast")).toEqual({
      model: "local:test-model",
    });
    expect(JSON.parse(await readFile(service.configPath, "utf8")).profiles.fast).not.toHaveProperty("variant");
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

  test("classifies a missing canonical config as setup", async () => {
    const service = await createUnloadedService();

    expect(await service.activateForStartup()).toMatchObject({
      status: "setup",
    });
  });

  test("reports the absolute global path for invalid JSON and schema at startup", async () => {
    const invalidJson = await createUnloadedService();
    await mkdir(join(invalidJson.homeDir, ".archcode"), { recursive: true });
    await writeFile(invalidJson.configPath, "{");
    const invalidJsonResult = await invalidJson.activateForStartup();
    expect(invalidJsonResult).toMatchObject({
      status: "config_error",
      error: { message: expect.stringContaining(invalidJson.configPath) },
    });
    if (invalidJsonResult.status !== "config_error") throw new Error("Expected invalid JSON");
    expect(invalidJson.invalidConfigRemovalPlan(invalidJsonResult.error)).toEqual({ items: [] });

    const invalidSchema = await createUnloadedService();
    await mkdir(join(invalidSchema.homeDir, ".archcode"), { recursive: true });
    await writeFile(invalidSchema.configPath, JSON.stringify({ provider: {} }));
    const invalidSchemaResult = await invalidSchema.activateForStartup();
    expect(invalidSchemaResult).toMatchObject({
      status: "config_error",
      error: { message: expect.stringContaining(invalidSchema.configPath) },
    });
    if (invalidSchemaResult.status !== "config_error") throw new Error("Expected invalid schema");
    expect(invalidSchema.invalidConfigRemovalPlan(invalidSchemaResult.error).items).toEqual([]);
  });

  test("discards only an invalid canonical Config and refuses a valid one", async () => {
    const invalid = await createUnloadedService();
    await mkdir(join(invalid.homeDir, ".archcode"), { recursive: true });
    await writeFile(invalid.configPath, "{", { mode: 0o600 });

    await invalid.discardInvalidConfig();
    expect(await invalid.activateForStartup()).toEqual({ status: "setup" });
    await expect(invalid.discardInvalidConfig()).resolves.toBeUndefined();

    const valid = await createService();
    const before = await readFile(valid.configPath, "utf8");
    await expect(valid.discardInvalidConfig()).rejects.toBeInstanceOf(
      ConfigRecoveryConflictError,
    );
    expect(await readFile(valid.configPath, "utf8")).toBe(before);
  });

  test("removes only selected invalid fields after validating the complete remaining Config", async () => {
    const service = await createUnloadedService();
    const invalid = config() as Record<string, unknown>;
    invalid.unsupportedLegacyConfig = { secretSentinel: "must-stay-private" };
    await mkdir(join(service.homeDir, ".archcode"), { recursive: true });
    await writeFile(service.configPath, `${JSON.stringify(invalid, null, 2)}\n`, { mode: 0o600 });

    const startup = await service.activateForStartup();
    expect(startup.status).toBe("config_error");
    if (startup.status !== "config_error") throw new Error("Expected invalid Config");
    const plan = service.invalidConfigRemovalPlan(startup.error);
    expect(plan.revision).toBeString();
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.id).not.toContain("unsupportedLegacyConfig");
    expect(plan.items[0]!.id).not.toContain("must-stay-private");

    const secondService = await createUnloadedService();
    await mkdir(join(secondService.homeDir, ".archcode"), { recursive: true });
    await writeFile(secondService.configPath, `${JSON.stringify(invalid, null, 2)}\n`, { mode: 0o600 });
    const secondStartup = await secondService.activateForStartup();
    if (secondStartup.status !== "config_error") throw new Error("Expected second invalid Config");
    expect(secondService.invalidConfigRemovalPlan(secondStartup.error).items[0]!.id)
      .not.toBe(plan.items[0]!.id);

    const result = await service.removeInvalidConfigItems(
      plan.revision!,
      [plan.items[0]!.id],
    );

    expect(result.status).toBe("ready");
    expect(JSON.parse(await readFile(service.configPath, "utf8"))).toEqual(config());
    expect((await stat(service.configPath)).mode & 0o777).toBe(0o600);
  });

  test("leaves the invalid Config byte-for-byte unchanged when selected removals are insufficient", async () => {
    const service = await createUnloadedService();
    const invalid = config() as Record<string, unknown>;
    invalid.firstLegacyField = true;
    invalid.secondLegacyField = true;
    await mkdir(join(service.homeDir, ".archcode"), { recursive: true });
    const before = `${JSON.stringify(invalid, null, 2)}\n`;
    await writeFile(service.configPath, before, { mode: 0o600 });

    const startup = await service.activateForStartup();
    if (startup.status !== "config_error") throw new Error("Expected invalid Config");
    const plan = service.invalidConfigRemovalPlan(startup.error);
    expect(plan.items).toHaveLength(2);

    await expect(service.removeInvalidConfigItems(
      plan.revision!,
      [plan.items[0]!.id],
    )).rejects.toBeInstanceOf(InvalidConfigRemovalError);
    expect(await readFile(service.configPath, "utf8")).toBe(before);

    await expect(service.removeInvalidConfigItems(
      plan.revision!,
      plan.items.map((item) => item.id),
    )).resolves.toMatchObject({ status: "ready" });
  });

  test("removes only the failing MCP server and preserves healthy MCP secrets", async () => {
    const service = await createUnloadedService();
    const invalid = config() as Record<string, any>;
    invalid.mcp.servers.broken = {
      url: "file:///must-not-be-accepted",
      headers: { Authorization: "broken-server-secret" },
    };
    await mkdir(join(service.homeDir, ".archcode"), { recursive: true });
    await writeFile(service.configPath, `${JSON.stringify(invalid, null, 2)}\n`, { mode: 0o600 });

    const startup = await service.activateForStartup();
    if (startup.status !== "config_error") throw new Error("Expected invalid MCP Config");
    const plan = service.invalidConfigRemovalPlan(startup.error);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.path).toEqual(["mcp", "servers", "broken"]);

    await expect(service.removeInvalidConfigItems(
      plan.revision!,
      [plan.items[0]!.id],
    )).resolves.toMatchObject({ status: "ready" });
    const saved = JSON.parse(await readFile(service.configPath, "utf8"));
    expect(saved.mcp.servers).toEqual({
      custom: {
        url: "https://mcp.example.test",
        headers: { Authorization: "mcp-secret" },
      },
    });
  });

  test("preserves dotted MCP server identifiers as one selective-removal path segment", async () => {
    const service = await createUnloadedService();
    const invalid = config() as Record<string, any>;
    invalid.mcp.servers.foo = {
      url: "https://healthy.example.test",
      headers: { Authorization: "healthy-dotted-neighbor-secret" },
    };
    invalid.mcp.servers["foo.bar"] = {
      url: "file:///must-not-be-accepted",
    };
    await mkdir(join(service.homeDir, ".archcode"), { recursive: true });
    await writeFile(service.configPath, `${JSON.stringify(invalid, null, 2)}\n`, { mode: 0o600 });

    const startup = await service.activateForStartup();
    if (startup.status !== "config_error") throw new Error("Expected invalid dotted MCP Config");
    const plan = service.invalidConfigRemovalPlan(startup.error);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.path).toEqual(["mcp", "servers", "foo.bar"]);

    await expect(service.removeInvalidConfigItems(
      plan.revision!,
      [plan.items[0]!.id],
    )).resolves.toMatchObject({ status: "ready" });
    const saved = JSON.parse(await readFile(service.configPath, "utf8"));
    expect(saved.mcp.servers.foo).toEqual({
      url: "https://healthy.example.test",
      headers: { Authorization: "healthy-dotted-neighbor-secret" },
    });
    expect(saved.mcp.servers["foo.bar"]).toBeUndefined();
  });

  test("preserves dotted Provider identifiers as one selective-removal path segment", async () => {
    const service = await createUnloadedService();
    const invalid = config() as Record<string, any>;
    invalid.provider["broken.provider"] = {
      npm: "@ai-sdk/openai",
      name: "Broken dotted provider",
      options: {
        apiKey: "dotted-provider-secret",
        queryParams: { unsupported: "true" },
      },
      models: structuredClone(invalid.provider.local.models),
    };
    await mkdir(join(service.homeDir, ".archcode"), { recursive: true });
    await writeFile(service.configPath, `${JSON.stringify(invalid, null, 2)}\n`, { mode: 0o600 });

    const startup = await service.activateForStartup();
    if (startup.status !== "config_error") throw new Error("Expected invalid dotted Provider Config");
    const plan = service.invalidConfigRemovalPlan(startup.error);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.path).toEqual([
      "provider",
      "broken.provider",
      "options",
      "queryParams",
    ]);

    await expect(service.removeInvalidConfigItems(
      plan.revision!,
      [plan.items[0]!.id],
    )).resolves.toMatchObject({ status: "ready" });
    const saved = JSON.parse(await readFile(service.configPath, "utf8"));
    expect(saved.provider.local).toEqual((config() as any).provider.local);
    expect(saved.provider["broken.provider"]).toEqual({
      npm: "@ai-sdk/openai",
      name: "Broken dotted provider",
      options: { apiKey: "dotted-provider-secret" },
      models: structuredClone((config() as any).provider.local.models),
    });
  });

  test("rejects stale, duplicate, and non-removable invalid Config selections without mutation", async () => {
    const service = await createUnloadedService();
    const invalid = config() as Record<string, any>;
    invalid.unsupportedLegacyConfig = true;
    await mkdir(join(service.homeDir, ".archcode"), { recursive: true });
    await writeFile(service.configPath, `${JSON.stringify(invalid, null, 2)}\n`, { mode: 0o600 });

    const startup = await service.activateForStartup();
    if (startup.status !== "config_error") throw new Error("Expected invalid Config");
    const plan = service.invalidConfigRemovalPlan(startup.error);
    const itemId = plan.items[0]!.id;
    const before = await readFile(service.configPath, "utf8");
    await expect(service.removeInvalidConfigItems(plan.revision!, [itemId, itemId]))
      .rejects.toBeInstanceOf(InvalidConfigRemovalError);
    expect(await readFile(service.configPath, "utf8")).toBe(before);
    await expect(service.removeInvalidConfigItems(
      plan.revision!,
      ["abcdefghijklmnopqrstuv"],
    )).rejects.toBeInstanceOf(ConfigRevisionConflictError);
    expect(await readFile(service.configPath, "utf8")).toBe(before);

    invalid.anotherLegacyField = true;
    const changed = `${JSON.stringify(invalid, null, 2)}\n`;
    await writeFile(service.configPath, changed, { mode: 0o600 });
    await expect(service.removeInvalidConfigItems(plan.revision!, [itemId]))
      .rejects.toBeInstanceOf(ConfigRevisionConflictError);
    expect(await readFile(service.configPath, "utf8")).toBe(changed);

    delete invalid.unsupportedLegacyConfig;
    delete invalid.anotherLegacyField;
    invalid.profiles.principal.model = "missing:model";
    const profileError = `${JSON.stringify(invalid, null, 2)}\n`;
    await writeFile(service.configPath, profileError, { mode: 0o600 });
    const profileStartup = await service.activateForStartup();
    if (profileStartup.status !== "config_error") throw new Error("Expected invalid Profile");
    expect(service.invalidConfigRemovalPlan(profileStartup.error).items).toEqual([]);
    expect(await readFile(service.configPath, "utf8")).toBe(profileError);
  });

  test("never overwrites an external Config created during selective recovery validation", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "archcode-server-config-"));
    roots.push(homeDir);
    const configPath = resolveServerConfigPath(homeDir);
    await mkdir(join(homeDir, ".archcode"), { recursive: true });
    const invalid = config() as Record<string, unknown>;
    invalid.unsupportedLegacyConfig = true;
    await writeFile(configPath, `${JSON.stringify(invalid, null, 2)}\n`, { mode: 0o600 });
    const external = config() as Record<string, any>;
    external.provider.local.name = "Externally repaired Config";
    const externalBytes = `${JSON.stringify(external, null, 2)}\n`;
    class RacingModelRuntime extends ModelRuntime {
      override prepare(...args: Parameters<ModelRuntime["prepare"]>) {
        writeFileSync(configPath, externalBytes, { mode: 0o600 });
        return super.prepare(...args);
      }
    }
    const service = new ServerConfigService({
      homeDir,
      modelRuntime: new RacingModelRuntime(),
    });
    const startup = await service.activateForStartup();
    if (startup.status !== "config_error") throw new Error("Expected invalid Config");
    const plan = service.invalidConfigRemovalPlan(startup.error);

    await expect(service.removeInvalidConfigItems(
      plan.revision!,
      [plan.items[0]!.id],
    )).rejects.toBeInstanceOf(ConfigRevisionConflictError);
    expect(await readFile(configPath, "utf8")).toBe(externalBytes);
  });

  test("preserves a valid Config replaced during Reset validation", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "archcode-server-config-"));
    roots.push(homeDir);
    await mkdir(join(homeDir, ".archcode"), { recursive: true });
    const configPath = resolveServerConfigPath(homeDir);
    const repaired = config() as Record<string, any>;
    repaired.provider.local.name = "Externally repaired";
    const repairedBytes = `${JSON.stringify(repaired, null, 2)}\n`;
    await writeFile(configPath, `${JSON.stringify(config(), null, 2)}\n`, { mode: 0o600 });

    class RacingModelRuntime extends ModelRuntime {
      private preparations = 0;

      override prepare(
        candidate: Parameters<ModelRuntime["prepare"]>[0],
        revision: string,
      ): ReturnType<ModelRuntime["prepare"]> {
        this.preparations += 1;
        if (this.preparations === 2) {
          writeFileSync(configPath, repairedBytes, { mode: 0o600 });
        }
        if (this.preparations <= 2) throw new Error("provider preparation sentinel");
        return super.prepare(candidate, revision);
      }
    }
    const service = new ServerConfigService({
      homeDir,
      modelRuntime: new RacingModelRuntime(),
    });

    expect(await service.activateForStartup()).toMatchObject({ status: "config_error" });
    await expect(service.discardInvalidConfig()).rejects.toBeInstanceOf(
      ConfigRecoveryConflictError,
    );
    expect(await readFile(configPath, "utf8")).toBe(repairedBytes);
    expect(await service.activateForStartup()).toMatchObject({ status: "ready" });
  });

  test("unlinks an invalid Config symlink without touching its target", async () => {
    const service = await createUnloadedService();
    await mkdir(join(service.homeDir, ".archcode"), { recursive: true });
    const target = join(service.homeDir, "invalid-target.json");
    await writeFile(target, "{secret-sentinel", { mode: 0o600 });
    await symlink(target, service.configPath);

    await service.discardInvalidConfig();

    expect(await readFile(target, "utf8")).toBe("{secret-sentinel");
    expect(await service.activateForStartup()).toEqual({ status: "setup" });
  });

  test("discards a Config that fails model runtime preparation", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "archcode-server-config-"));
    roots.push(homeDir);
    await mkdir(join(homeDir, ".archcode"), { recursive: true });
    await writeFile(resolveServerConfigPath(homeDir), `${JSON.stringify(config())}\n`, { mode: 0o600 });
    class FailingModelRuntime extends ModelRuntime {
      override prepare(): never {
        throw new Error("provider preparation sentinel");
      }
    }
    const service = new ServerConfigService({
      homeDir,
      modelRuntime: new FailingModelRuntime(),
    });

    expect(await service.activateForStartup()).toMatchObject({
      status: "config_error",
    });
    await service.discardInvalidConfig();
    expect(await service.activateForStartup()).toEqual({ status: "setup" });
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

      expect(await service.activateForStartup()).toMatchObject({
        status: "config_error",
        error: { issues: [{ path: `provider.local.options.${key}` }] },
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

    expect(await service.activateForStartup()).toMatchObject({
      status: "config_error",
      error: { issues: [{ path: "provider.local.options.googleAuthOptions.credentials" }] },
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
    expect(await unloaded.activateForStartup()).toMatchObject({
      status: "config_error",
      error: { issues: expectedIssues },
    });
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
    expect(await startup.activateForStartup()).toMatchObject({
      status: "config_error",
      error: { issues: [{ path: "provider.local.options.baseURL" }] },
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

      expect(await unloaded.activateForStartup()).toMatchObject({
        status: "config_error",
        error: { issues: [{ path: "provider.local.options.baseURL" }] },
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

      expect(await unloaded.activateForStartup()).toMatchObject({
        status: "config_error",
        error: { issues: [{ path: "provider.local.options.endpoint" }] },
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

    expect(await unloaded.activateForStartup()).toMatchObject({
      status: "config_error",
      error: { issues: [{ path: "provider.local.options.name" }] },
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

    expect(await unloaded.activateForStartup()).toMatchObject({
      status: "config_error",
      error: { issues: [{ path: "provider.local.options.queryParams" }] },
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
    await activateReady(service);
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

    expect(await service.activateForStartup()).toMatchObject({
      status: "config_error",
      error: {
        message: expect.stringContaining(service.configPath),
        issues: [{ path: service.configPath }],
      },
    });
  });

  test("does not republish a semantic no-op and reports restart-required sections", async () => {
    const service = await createService();
    const snapshot = await service.getSnapshot();
    const beforeRuntime = service.modelRuntime.current;
    const unchanged = await service.save({ expectedRevision: snapshot.revision, config: preserveSecrets(snapshot.config) });
    expect(unchanged.revision).toBe(snapshot.revision);
    expect(unchanged.modelRuntimeRevision).toBe(snapshot.modelRuntimeRevision);
    expect(service.modelRuntime.current).toBe(beforeRuntime);
    expect(unchanged.restartRequiredSections).toEqual([]);

    const changed = preserveSecrets(snapshot.config);
    changed.provider.local.name = "Changed";
    await service.save({ expectedRevision: snapshot.revision, config: changed });
    const restarted = new ServerConfigService({ homeDir: service.homeDir });
    await activateReady(restarted);
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

  test("publishes an externally changed runtime config on a generic no-op save", async () => {
    const service = await createService();
    const beforeRuntime = service.modelRuntime.current;
    const externallyEdited = config() as Record<string, any>;
    externallyEdited.provider.local.name = "Edited outside the service";
    const externalText = `${JSON.stringify(externallyEdited, null, 2)}\n`;
    await writeFile(service.configPath, externalText);

    const snapshot = await service.getSnapshot();
    expect(snapshot.modelRuntimeRevision).toBe(beforeRuntime.revision);
    const saved = await service.save({
      expectedRevision: snapshot.revision,
      config: preserveSecrets(snapshot.config),
    });

    expect(saved.modelRuntimeRevision).not.toBe(beforeRuntime.revision);
    expect(service.modelRuntime.current).not.toBe(beforeRuntime);
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
