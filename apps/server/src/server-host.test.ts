import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import {
  createRuntime,
  createInMemoryLogger,
  ProjectRegistry,
  RuntimeDataService,
  ServerConfigService,
  resolveServerConfigPath,
  silentLogger,
  type AgentRuntime,
  type AgentRuntimeOptions,
  type Logger,
} from "@archcode/agent-core";
import type { CompleteSetupRequest, UpdateStatus } from "@archcode/protocol";
import {
  ArchCodeServerHost,
  type ServerHostOptions,
} from "./server-host";
import { ServerRestartController } from "./restart-controller";
import { UpdateService } from "./updater";
import { startServer } from "./listen";

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function createHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "archcode-server-host-"));
  roots.push(home);
  return home;
}

function setupConfig(): CompleteSetupRequest["config"] {
  const profile = { model: "local:test-model" };
  return {
    provider: {
      local: {
        npm: "@ai-sdk/openai-compatible",
        name: "Local",
        options: {
          baseURL: "http://localhost:8090/v1",
          apiKey: { action: "replace", value: "provider-secret" },
        },
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

function diskConfig() {
  const config = structuredClone(setupConfig()) as any;
  config.provider.local.options.apiKey = "provider-secret";
  return config;
}

function fakeRuntime(configService: ServerConfigService): AgentRuntime {
  return {
    configService,
    recoverSessionContinuations: mock(async () => undefined),
    startAutomationSchedulers: mock(async () => undefined),
    prepareForRestart: mock(() => ({ ready: true })),
    shutdown: mock(async () => undefined),
    notifyRuntimeShutdown: mock(() => undefined),
    listAgentDescriptors: mock(() => [{ name: "lead", displayName: "Lead" }]),
    subscribeSessionEvents: mock(() => () => undefined),
    subscribeHitlEvents: mock(() => () => undefined),
    subscribeSessionRuntimeChanges: mock(() => () => undefined),
    subscribeMcpStatusChanges: mock(() => () => undefined),
    subscribeModelRuntimeChanges: mock(() => () => undefined),
    subscribeResourceChanges: mock(() => () => undefined),
    getMcpServerStatus: mock(() => ({ servers: {} })),
    getMcpServerInventory: mock(() => ({ servers: {} })),
    applyMcpConfig: mock(async () => undefined),
    testMcpServerDraft: mock(async () => ({ tools: [], warnings: [] })),
    reconnectMcpServer: mock(async () => undefined),
    listSessionRuntimeEvents: mock(async () => []),
    listHitlSnapshotEvents: mock(async () => []),
  } as unknown as AgentRuntime;
}

function hostInfrastructure(home: string, logger: Logger = silentLogger) {
  const projectRegistry = new ProjectRegistry({ homeDir: home, logger });
  return {
    restartController: new ServerRestartController(),
    updateService: new UpdateService({
      currentVersion: "1.2.3",
      executablePath: process.execPath,
      restartSupported: false,
      autoCheckEnabled: false,
      homeDir: home,
      logger,
    }),
    projectRegistry,
    runtimeDataService: {
      inspect: mock(async () => ({ projects: [] })),
      delete: mock(async (projectSlugs: readonly string[]) => ({
        results: projectSlugs.map((projectSlug) => ({
          projectSlug,
          status: "deleted" as const,
        })),
      })),
    },
  };
}

async function createSetupHost(overrides: {
  createRuntime?: (options: AgentRuntimeOptions) => Promise<AgentRuntime>;
  embeddedWebAssets?: ReadonlyMap<string, string>;
  logger?: Logger;
  accessLog?: boolean;
  updateService?: ServerHostOptions["updateService"];
  restartController?: ServerRestartController;
  runtimeDataService?: ServerHostOptions["runtimeDataService"];
} = {}) {
  const home = await createHome();
  const configService = new ServerConfigService({ homeDir: home });
  const runtime = fakeRuntime(configService);
  const createRuntime = mock(overrides.createRuntime ?? (async () => runtime));
  const infrastructure = hostInfrastructure(home, overrides.logger ?? silentLogger);
  const host = await ArchCodeServerHost.create({
    configService,
    createRuntime,
    logger: overrides.logger ?? silentLogger,
    accessLog: overrides.accessLog,
    dev: false,
    embeddedWebAssets: overrides.embeddedWebAssets,
    version: "1.2.3",
    ...infrastructure,
    ...(overrides.updateService === undefined
      ? {}
      : { updateService: overrides.updateService }),
    ...(overrides.restartController === undefined
      ? {}
      : { restartController: overrides.restartController }),
    ...(overrides.runtimeDataService === undefined
      ? {}
      : { runtimeDataService: overrides.runtimeDataService }),
  });
  const setupUrl = host.terminalInstructions("http://localhost:4096")[0]!;
  const token = new URL(setupUrl.slice(setupUrl.indexOf("http"))).hash.slice("#token=".length);
  return { host, home, configService, runtime, createRuntime, token };
}

async function createConfigErrorHost(extraInvalid: Record<string, unknown> = {}) {
  const home = await createHome();
  await mkdir(join(home, ".archcode"), { recursive: true });
  await writeFile(resolveServerConfigPath(home), JSON.stringify({
    ...diskConfig(),
    unsupportedLegacyConfig: "raw-secret-sentinel",
    ...extraInvalid,
  }), { mode: 0o600 });
  const configService = new ServerConfigService({ homeDir: home });
  const runtime = fakeRuntime(configService);
  const createRuntime = mock(async () => runtime);
  const host = await ArchCodeServerHost.create({
    configService,
    createRuntime,
    logger: silentLogger,
    dev: false,
    version: "1.2.3",
    ...hostInfrastructure(home),
  });
  const instruction = host.terminalInstructions("http://localhost:4096")[0]!;
  const recoveryUrl = instruction.slice(instruction.indexOf("http"));
  const token = new URL(recoveryUrl).hash.slice("#token=".length);
  return { host, home, configService, runtime, createRuntime, token, recoveryUrl };
}

function configRecoveryRequest(
  token: string,
  method: "POST" = "POST",
  body?: Record<string, unknown>,
): RequestInit {
  return {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: "http://localhost",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

function setupRequest(
  token: string,
  input: CompleteSetupRequest,
): RequestInit {
  return {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Origin: "http://localhost",
    },
    body: JSON.stringify(input),
  };
}

describe("ArchCodeServerHost", () => {
  test("publishes the listener and control plane before a deferred Runtime settles", async () => {
    const home = await createHome();
    await mkdir(join(home, ".archcode"), { recursive: true });
    await writeFile(
      resolveServerConfigPath(home),
      `${JSON.stringify(diskConfig())}\n`,
      { mode: 0o600 },
    );
    const configService = new ServerConfigService({ homeDir: home });
    let runtimeEntered!: () => void;
    const entered = new Promise<void>((resolve) => { runtimeEntered = resolve; });
    let releaseRuntime!: () => void;
    const gate = new Promise<void>((resolve) => { releaseRuntime = resolve; });
    const candidate = fakeRuntime(configService);
    candidate.recoverSessionContinuations = mock(async () => {
      throw new Error("deferred recovery failed");
    });
    const createRuntime = mock(async () => {
      runtimeEntered();
      await gate;
      return candidate;
    });
    const indexPath = join(home, "index.html");
    await writeFile(indexPath, "<!doctype html><title>ArchCode</title>");
    const host = await ArchCodeServerHost.create({
      configService,
      createRuntime,
      logger: silentLogger,
      embeddedWebAssets: new Map([["/index.html", indexPath]]),
      ...hostInfrastructure(home),
    });

    expect(createRuntime).not.toHaveBeenCalled();
    const listener = await startServer(host.app, { hostname: "127.0.0.1", port: 0 });
    try {
      host.startRuntimeActivation();
      await entered;
      expect(await (await fetch(`${listener.url}/api/bootstrap`)).json()).toEqual({
        mode: "ready",
        authRequired: false,
        authenticated: true,
        runtime: { state: "activating" },
      });
      expect((await fetch(`${listener.url}/api/health`)).status).toBe(200);
      expect((await fetch(`${listener.url}/api/config`)).status).toBe(200);
      expect((await fetch(`${listener.url}/api/update`)).status).toBe(200);
      expect((await fetch(`${listener.url}/api/auth/status`)).status).toBe(200);
      expect((await fetch(`${listener.url}/api/agents`)).status).toBe(503);
      expect((await fetch(`${listener.url}/`)).status).toBe(200);
      releaseRuntime();
      await waitForRuntimeState(host, "error");
      expect(await (await fetch(`${listener.url}/api/bootstrap`)).json()).toMatchObject({
        mode: "ready",
        runtime: { state: "error" },
      });
      expect((await fetch(`${listener.url}/api/health`)).status).toBe(200);
      expect((await fetch(`${listener.url}/`)).status).toBe(200);
      expect(candidate.shutdown).toHaveBeenCalledTimes(1);
    } finally {
      listener.server.stop(true);
      await host.shutdown();
    }
  });

  test("applies structured access logging at the shared HTTP shell", async () => {
    const { logger, entries } = createInMemoryLogger();
    const { host } = await createSetupHost({ logger });

    expect((await host.app.request("/api/health")).status).toBe(200);
    expect(entries).toContainEqual(expect.objectContaining({
      level: "info",
      event: "http.request.completed",
      context: expect.objectContaining({
        method: "GET",
        path: "/api/health",
        status: 200,
      }),
    }));
  });

  test("can disable access logs without suppressing application failures", async () => {
    const { logger, entries } = createInMemoryLogger();
    const { host } = await createSetupHost({
      logger,
      accessLog: false,
    });
    host.app.get("/boom", () => {
      throw new Error("boom");
    });

    expect((await host.app.request("/boom")).status).toBe(500);
    expect(entries.map((entry) => entry.event)).toEqual([
      "http.request.failed",
    ]);
  });

  test("starts a restricted token-protected setup shell without a Runtime", async () => {
    const home = await createHome();
    const indexPath = join(home, "index.html");
    await writeFile(indexPath, "<!doctype html><title>Setup</title>");
    const { host, createRuntime, token } = await createSetupHost({
      embeddedWebAssets: new Map([["/index.html", indexPath]]),
    });

    expect(await (await host.app.request("/api/bootstrap")).json()).toEqual({
      mode: "setup",
    });
    expect((await host.app.request("/api/agents")).status).toBe(503);
    expect((await host.app.request("/api/setup/provider-adapters")).status).toBe(401);
    expect((await host.app.request("/api/setup/provider-adapters", {
      headers: { Authorization: `Bearer ${token}` },
    })).status).toBe(200);
    const setupPage = await host.app.request("/setup");
    expect(setupPage.headers.get("x-content-type-options")).toBe("nosniff");
    expect(setupPage.headers.get("referrer-policy")).toBe("no-referrer");
    expect(createRuntime).not.toHaveBeenCalled();
  });

  test("completes passwordless setup on the same app and never exposes auth to Runtime", async () => {
    const { host, createRuntime, token } = await createSetupHost();
    const response = await host.app.request("/api/setup", setupRequest(token, {
      config: setupConfig(),
      requireLogin: false,
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: {
        mode: "ready",
        authRequired: false,
        authenticated: true,
        runtime: { state: "ready" },
      },
    });
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect("auth" in createRuntime.mock.calls[0]![0].activation).toBe(false);
    expect((await host.app.request("/api/agents")).status).toBe(200);
    expect((await host.app.request("/api/setup/provider-adapters", {
      headers: { Authorization: `Bearer ${token}` },
    })).status).toBe(404);
  });

  test("restart waits for an entered write and then closes all later writes", async () => {
    const status: UpdateStatus = {
      currentVersion: "1.0.0",
      phase: "restart_pending",
      managed: true,
      restartSupported: true,
      updateAvailable: false,
      restartRequired: true,
    };
    let enterInstall!: () => void;
    const installEntered = new Promise<void>((resolve) => {
      enterInstall = resolve;
    });
    let releaseInstall!: () => void;
    const installReleased = new Promise<void>((resolve) => {
      releaseInstall = resolve;
    });
    const restartController = new ServerRestartController({
      schedule: () => undefined,
    });
    restartController.bind(async () => undefined);
    const { host, token } = await createSetupHost({
      restartController,
      updateService: {
        getStatus: async () => status,
        check: async () => status,
        install: async () => {
          enterInstall();
          await installReleased;
          return status;
        },
        stop: async () => undefined,
        closeAdmissionIfIdle: () => true,
        reopenAdmission: () => undefined,
      },
    });
    await host.app.request("/api/setup", setupRequest(token, {
      config: setupConfig(),
      requireLogin: false,
    }));

    const installing = host.app.request("/api/update/install", {
      method: "POST",
    });
    await installEntered;
    expect((await host.app.request("/api/update/restart", {
      method: "POST",
    })).status).toBe(409);

    releaseInstall();
    expect((await installing).status).toBe(200);
    expect((await host.app.request("/api/update/restart", {
      method: "POST",
    })).status).toBe(202);
    expect((await host.app.request("/api/update/check", {
      method: "POST",
    })).status).toBe(409);
  });

  test("blocks restart only during activation and allows it after Runtime failure", async () => {
    const home = await createHome();
    await mkdir(join(home, ".archcode"), { recursive: true });
    await writeFile(
      resolveServerConfigPath(home),
      `${JSON.stringify(diskConfig())}\n`,
      { mode: 0o600 },
    );
    const configService = new ServerConfigService({ homeDir: home });
    let entered!: () => void;
    const runtimeEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const status: UpdateStatus = {
      currentVersion: "1.2.3",
      phase: "restart_pending",
      managed: true,
      restartSupported: true,
      updateAvailable: false,
      restartRequired: true,
    };
    const updateService = {
      getStatus: mock(async () => status),
      check: mock(async () => status),
      install: mock(async () => status),
      stop: mock(async () => undefined),
      closeAdmissionIfIdle: mock(() => true),
      reopenAdmission: mock(() => undefined),
    };
    const restartController = new ServerRestartController({ schedule: () => undefined });
    restartController.bind(async () => undefined);
    const host = await ArchCodeServerHost.create({
      configService,
      createRuntime: async () => {
        entered();
        await gate;
        throw new Error("activation failed");
      },
      logger: silentLogger,
      ...hostInfrastructure(home),
      updateService,
      restartController,
    });
    host.startRuntimeActivation();
    await runtimeEntered;

    expect((await host.app.request("/api/update/restart", { method: "POST" })).status)
      .toBe(409);
    release();
    await waitForRuntimeState(host, "error");
    expect((await host.app.request("/api/update/restart", { method: "POST" })).status)
      .toBe(202);
  });

  test("rejects client-supplied authentication state without consuming Setup", async () => {
    const { host, token, configService } = await createSetupHost();
    const config = setupConfig() as CompleteSetupRequest["config"] & {
      auth: { passwordHash: string };
    };
    config.auth = {
      passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA",
    };

    const response = await host.app.request("/api/setup", setupRequest(token, {
      config,
      requireLogin: false,
    }));

    expect(response.status).toBe(400);
    expect((await configService.activateForStartup()).status).toBe("setup");
    expect((await host.app.request("/api/setup/provider-adapters", {
      headers: { Authorization: `Bearer ${token}` },
    })).status).toBe(200);
  });

  test("sets an HttpOnly session after password setup and protects Runtime APIs", async () => {
    const { host, token } = await createSetupHost();
    const response = await host.app.request("/api/setup", setupRequest(token, {
      config: setupConfig(),
      requireLogin: true,
      password: "correct horse battery",
    }));

    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain("archcode_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect((await host.app.request("/api/agents")).status).toBe(401);
    expect((await host.app.request("/api/update")).status).toBe(401);
    expect((await host.app.request("/api/agents", {
      headers: { Cookie: cookie.split(";")[0]! },
    })).status).toBe(200);
    const updateStatus = await host.app.request("/api/update", {
      headers: { Cookie: cookie.split(";")[0]! },
    });
    expect(updateStatus.status).toBe(200);
    expect(updateStatus.headers.get("cache-control")).toBe("no-store");
    expect((await host.app.request("/api/update/restart", {
      method: "POST",
      headers: { Cookie: cookie.split(";")[0]! },
    })).status).toBe(403);
    expect((await host.app.request("/api/update/restart", {
      method: "POST",
      headers: {
        Cookie: cookie.split(";")[0]!,
        Origin: "http://localhost",
      },
    })).status).toBe(422);
  });

  test("supports cookie login, same-origin logout and password rotation", async () => {
    const { host, token } = await createSetupHost();
    const setup = await host.app.request("/api/setup", setupRequest(token, {
      config: setupConfig(),
      requireLogin: true,
      password: "original password",
    }));
    const originalCookie = setup.headers.get("set-cookie")!.split(";")[0]!;

    expect((await host.app.request("/api/auth/logout", {
      method: "POST",
      headers: { Cookie: originalCookie },
    })).status).toBe(403);

    const login = await host.app.request("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost",
      },
      body: JSON.stringify({ password: "original password" }),
    });
    expect(login.status).toBe(200);
    const loginCookie = login.headers.get("set-cookie")!.split(";")[0]!;

    const rejectedChange = await host.app.request("/api/auth/password", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: loginCookie,
        Origin: "http://localhost",
      },
      body: JSON.stringify({
        action: "change",
        currentPassword: "wrong password",
        password: "replacement password",
      }),
    });
    expect(rejectedChange.status).toBe(403);
    expect(await rejectedChange.json()).toMatchObject({
      error: { code: "AUTH_CURRENT_PASSWORD_INVALID" },
    });
    expect((await host.app.request("/api/agents", {
      headers: { Cookie: loginCookie },
    })).status).toBe(200);

    const change = await host.app.request("/api/auth/password", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: loginCookie,
        Origin: "http://localhost",
      },
      body: JSON.stringify({
        action: "change",
        currentPassword: "original password",
        password: "replacement password",
      }),
    });
    expect(change.status).toBe(200);
    const replacementCookie = change.headers.get("set-cookie")!.split(";")[0]!;
    expect((await host.app.request("/api/agents", {
      headers: { Cookie: loginCookie },
    })).status).toBe(401);
    expect((await host.app.request("/api/agents", {
      headers: { Cookie: replacementCookie },
    })).status).toBe(200);

    const oldLogin = await host.app.request("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost",
      },
      body: JSON.stringify({ password: "original password" }),
    });
    expect(oldLogin.status).toBe(401);
    expect(oldLogin.headers.get("cache-control")).toBe("no-store");
    const newLogin = await host.app.request("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost",
      },
      body: JSON.stringify({ password: "replacement password" }),
    });
    expect(newLogin.status).toBe(200);
    expect(newLogin.headers.get("cache-control")).toBe("no-store");
  });

  test("admits only one concurrent setup submission", async () => {
    let releaseRuntime!: () => void;
    let signalRuntimeEntered!: () => void;
    const runtimeGate = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    const runtimeEntered = new Promise<void>((resolve) => {
      signalRuntimeEntered = resolve;
    });
    let runtime!: AgentRuntime;
    const fixture = await createSetupHost({
      createRuntime: async (options) => {
        signalRuntimeEntered();
        await runtimeGate;
        return runtime ??= fakeRuntime(options.configService);
      },
    });

    const first = fixture.host.app.request("/api/setup", setupRequest(fixture.token, {
      config: setupConfig(),
      requireLogin: false,
    }));
    await runtimeEntered;
    const second = await fixture.host.app.request("/api/setup", setupRequest(fixture.token, {
      config: setupConfig(),
      requireLogin: false,
    }));
    releaseRuntime();

    expect(second.status).toBe(404);
    expect((await first).status).toBe(200);
  });

  test("exposes token-protected, redacted Config Recovery without opening Setup", async () => {
    const { host, createRuntime, token, recoveryUrl } = await createConfigErrorHost();
    const bootstrap = await host.app.request("/api/bootstrap");

    expect(await bootstrap.json()).toEqual({
      mode: "config_error",
      message: "The global configuration is invalid. Open Config Recovery from the server terminal.",
    });
    expect(recoveryUrl).toMatch(/^http:\/\/localhost:4096\/config-recovery#token=/);
    expect((await host.app.request("/api/setup/provider-adapters")).status).toBe(404);
    expect((await host.app.request("/api/config-recovery")).status).toBe(401);
    const recovery = await host.app.request("/api/config-recovery", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(recovery.status).toBe(200);
    const recoveryText = await recovery.text();
    expect(recoveryText).not.toContain("raw-secret-sentinel");
    expect(recoveryText).not.toContain("unsupportedLegacyConfig");
    expect(JSON.parse(recoveryText)).toMatchObject({
      configPath: expect.stringContaining("/.archcode/config.json"),
      revision: expect.any(String),
      removableItems: [{
        id: expect.any(String),
        label: "Invalid configuration field",
        path: "configuration",
      }],
      issues: [{
        path: "configuration",
        message: "This value does not match the current ArchCode configuration format.",
      }],
    });
    expect((await host.app.request("/api/update")).status).toBe(401);
    expect((await host.app.request("/api/update", {
      headers: { Authorization: `Bearer ${token}` },
    })).status).toBe(200);
    expect(createRuntime).not.toHaveBeenCalled();
  });

  test("removes a selected invalid Config item while preserving valid settings", async () => {
    const { host, configService, createRuntime, token } = await createConfigErrorHost();
    const status = await (await host.app.request("/api/config-recovery", {
      headers: { Authorization: `Bearer ${token}` },
    })).json() as { revision: string; removableItems: Array<{ id: string }> };
    const removalBody = {
      expectedRevision: status.revision,
      itemIds: [status.removableItems[0]!.id],
      confirmation: "REMOVE_SELECTED_INVALID_CONFIG_ITEMS",
    };
    expect((await host.app.request("/api/config-recovery/remove-items", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify(removalBody),
    })).status).toBe(401);
    expect((await host.app.request("/api/config-recovery/remove-items", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Origin: "https://attacker.example",
      },
      body: JSON.stringify(removalBody),
    })).status).toBe(403);

    expect((await host.app.request("/api/config-recovery/remove-items", configRecoveryRequest(
      token,
      "POST",
      {
        expectedRevision: status.revision,
        itemIds: [status.removableItems[0]!.id],
        confirmation: true,
      },
    ))).status).toBe(400);
    const beforeUnknown = await readFile(configService.configPath, "utf8");
    expect((await host.app.request("/api/config-recovery/remove-items", configRecoveryRequest(
      token,
      "POST",
      { ...removalBody, itemIds: ["abcdefghijklmnopqrstuv"] },
    ))).status).toBe(409);
    expect(await readFile(configService.configPath, "utf8")).toBe(beforeUnknown);

    const removed = await host.app.request("/api/config-recovery/remove-items", configRecoveryRequest(
      token,
      "POST",
      removalBody,
    ));
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({
      status: { mode: "ready", runtime: { state: "activating" } },
    });
    const saved = JSON.parse(await readFile(configService.configPath, "utf8"));
    expect(saved.unsupportedLegacyConfig).toBeUndefined();
    expect(saved.provider.local.options.apiKey).toBe("provider-secret");
    expect(saved.profiles).toEqual(diskConfig().profiles);
    await waitForRuntimeState(host, "ready");
    expect(createRuntime).toHaveBeenCalledTimes(1);
  });

  test("rejects a partial invalid-item removal with zero Config mutation", async () => {
    const { host, configService, token } = await createConfigErrorHost({
      anotherLegacyConfig: "second-invalid-value",
    });
    const status = await (await host.app.request("/api/config-recovery", {
      headers: { Authorization: `Bearer ${token}` },
    })).json() as { revision: string; removableItems: Array<{ id: string }> };
    const before = await readFile(configService.configPath, "utf8");

    const response = await host.app.request("/api/config-recovery/remove-items", configRecoveryRequest(
      token,
      "POST",
      {
        expectedRevision: status.revision,
        itemIds: [status.removableItems[0]!.id],
        confirmation: "REMOVE_SELECTED_INVALID_CONFIG_ITEMS",
      },
    ));

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: {
        code: "CONFIG_VALIDATION_ERROR",
        message: "The selected removals would not leave a valid configuration. Nothing was changed.",
      },
    });
    expect(await readFile(configService.configPath, "utf8")).toBe(before);
  });

  test("retries a repaired Config in the same process and activates Runtime", async () => {
    const { host, configService, createRuntime, token } = await createConfigErrorHost();
    const stillInvalid = await host.app.request(
      "/api/config-recovery/retry",
      configRecoveryRequest(token),
    );
    expect(stillInvalid.status).toBe(200);
    expect(await stillInvalid.json()).toMatchObject({
      status: { mode: "config_error" },
      recovery: { issues: [{ path: "configuration" }] },
    });

    await writeFile(configService.configPath, `${JSON.stringify(diskConfig())}\n`, { mode: 0o600 });
    const repaired = await host.app.request(
      "/api/config-recovery/retry",
      configRecoveryRequest(token),
    );
    expect(repaired.status).toBe(200);
    expect(await repaired.json()).toMatchObject({
      status: {
        mode: "ready",
        authenticated: true,
        runtime: { state: "activating" },
      },
    });
    await waitForRuntimeState(host, "ready");
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect((await host.app.request("/api/config-recovery", {
      headers: { Authorization: `Bearer ${token}` },
    })).status).toBe(404);
  });

  test("resets only the invalid Config and carries the same terminal grant into Setup", async () => {
    const { host, configService, createRuntime, token } = await createConfigErrorHost();
    expect((await host.app.request("/api/config-recovery/reset", configRecoveryRequest(
      token,
      "POST",
      { confirmation: true },
    ))).status).toBe(400);
    expect((await configService.activateForStartup()).status).toBe("config_error");

    const reset = await host.app.request("/api/config-recovery/reset", configRecoveryRequest(
      token,
      "POST",
      { confirmation: "DELETE_INVALID_CONFIG" },
    ));
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ status: { mode: "setup" } });
    expect(await configService.activateForStartup()).toEqual({ status: "setup" });
    expect((await host.app.request("/api/setup/provider-adapters", {
      headers: { Authorization: `Bearer ${token}` },
    })).status).toBe(200);
    expect(createRuntime).not.toHaveBeenCalled();
  });

  test("fails closed on cross-origin recovery and never deletes a Config repaired concurrently", async () => {
    const { host, configService, token } = await createConfigErrorHost();
    expect((await host.app.request("/api/config-recovery/retry", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://attacker.example",
      },
    })).status).toBe(403);

    await writeFile(configService.configPath, `${JSON.stringify(diskConfig())}\n`, { mode: 0o600 });
    const before = await readFile(configService.configPath, "utf8");
    const reset = await host.app.request("/api/config-recovery/reset", configRecoveryRequest(
      token,
      "POST",
      { confirmation: "DELETE_INVALID_CONFIG" },
    ));
    expect(reset.status).toBe(409);
    expect(await readFile(configService.configPath, "utf8")).toBe(before);
  });

  test("publishes a ready control plane and cleans a failed Runtime candidate", async () => {
    const home = await createHome();
    await mkdir(join(home, ".archcode"), { recursive: true });
    await writeFile(
      resolveServerConfigPath(home),
      `${JSON.stringify(diskConfig())}\n`,
      { mode: 0o600 },
    );
    const configService = new ServerConfigService({ homeDir: home });
    const runtime = fakeRuntime(configService);
    runtime.recoverSessionContinuations = mock(async () => {
      throw new Error("recovery failed");
    });

    const host = await ArchCodeServerHost.create({
      configService,
      createRuntime: mock(async () => runtime),
      logger: silentLogger,
      ...hostInfrastructure(home),
    });

    expect(await (await host.app.request("/api/bootstrap")).json()).toEqual({
      mode: "ready",
      authRequired: false,
      authenticated: true,
      runtime: { state: "activating" },
    });
    expect((await host.app.request("/api/health")).status).toBe(200);
    host.startRuntimeActivation();
    await waitForRuntimeState(host, "error");

    expect(await (await host.app.request("/api/bootstrap")).json()).toEqual({
      mode: "ready",
      authRequired: false,
      authenticated: true,
      runtime: {
        state: "error",
        error: {
          message: "ArchCode Runtime could not start. Check Runtime Data or the server log, then retry.",
          recoveryAllowed: true,
        },
      },
    });
    expect(runtime.shutdown).toHaveBeenCalledTimes(1);
    for (const path of [
      "/api/projects",
      "/api/projects/test-project/sessions",
      "/api/projects/test-project/todos",
      "/api/projects/test-project/automations",
      "/api/projects/test-project/hitl",
      "/api/mcp/status",
      "/api/events",
    ]) {
      expect((await host.app.request(path)).status).toBe(503);
    }
  });

  test("fails closed when a failed Runtime candidate cannot be fully shut down", async () => {
    const home = await createHome();
    await mkdir(join(home, ".archcode"), { recursive: true });
    await writeFile(
      resolveServerConfigPath(home),
      `${JSON.stringify(diskConfig())}\n`,
      { mode: 0o600 },
    );
    const { logger, entries } = createInMemoryLogger();
    const configService = new ServerConfigService({ homeDir: home });
    const runtime = fakeRuntime(configService);
    runtime.recoverSessionContinuations = mock(async () => {
      throw new Error("candidate recovery failed", {
        cause: new Error("invalid session cause"),
      });
    });
    let shutdownAttempts = 0;
    runtime.shutdown = mock(async () => {
      shutdownAttempts += 1;
      if (shutdownAttempts === 1) {
        throw new Error("candidate cleanup exploded", {
          cause: new Error("cleanup transport cause"),
        });
      }
    });
    const createRuntime = mock(async () => runtime);
    const runtimeDataService = {
      inspect: mock(async () => ({ projects: [] })),
      delete: mock(async () => ({ results: [] })),
    };
    const host = await ArchCodeServerHost.create({
      configService,
      createRuntime,
      logger,
      ...hostInfrastructure(home, logger),
      runtimeDataService,
    });
    host.startRuntimeActivation();
    await waitForRuntimeState(host, "error");

    expect(host.getRuntimeStatus()).toEqual({
      state: "error",
      error: {
        message: "Runtime cleanup did not complete. Restart ArchCode before retrying or deleting Runtime data.",
        recoveryAllowed: false,
      },
    });
    expect(runtime.shutdown).toHaveBeenCalledTimes(1);
    expect(createRuntime).toHaveBeenCalledTimes(1);
    for (const request of [
      host.app.request("/api/runtime/retry", { method: "POST" }),
      host.app.request("/api/runtime-data", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectSlugs: ["alpha"] }),
      }),
    ]) {
      const response = await request;
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: "RUNTIME_CLEANUP_INCOMPLETE" },
      });
    }
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(runtimeDataService.delete).not.toHaveBeenCalled();
    for (const path of [
      "/api/health",
      "/api/auth/status",
      "/api/config",
      "/api/update",
      "/api/runtime-data",
    ]) {
      expect((await host.app.request(path)).status).toBe(200);
    }
    expect(entries.find((entry) => entry.event === "server.runtime.start_failed")?.error)
      .toMatchObject({
        name: "Error",
        message: "candidate recovery failed",
        stack: expect.any(String),
      });
    expect(entries.find((entry) => entry.event === "server.runtime.start_failed")?.meta)
      .toMatchObject({
        cause: {
          name: "Error",
          message: "invalid session cause",
          stack: expect.any(String),
        },
      });
    expect(entries.find((entry) => entry.event === "server.runtime.cleanup_failed")?.error)
      .toMatchObject({
        name: "Error",
        message: "candidate cleanup exploded",
        stack: expect.any(String),
      });
    expect(entries.find((entry) => entry.event === "server.runtime.cleanup_failed")?.meta)
      .toMatchObject({
        activationError: {
          name: "Error",
          message: "candidate recovery failed",
          stack: expect.any(String),
        },
        cause: {
          name: "Error",
          message: "cleanup transport cause",
          stack: expect.any(String),
        },
      });
    await host.shutdown();
    expect(runtime.shutdown).toHaveBeenCalledTimes(2);
  });

  test("retries only failed production Runtime cleanup during Host shutdown", async () => {
    const home = await createHome();
    await mkdir(join(home, ".archcode"), { recursive: true });
    await writeFile(
      resolveServerConfigPath(home),
      `${JSON.stringify(diskConfig())}\n`,
      { mode: 0o600 },
    );
    const workspaceRoot = join(home, "production-cleanup-project");
    await mkdir(workspaceRoot, { recursive: true });
    const projectRegistry = new ProjectRegistry({ homeDir: home, logger: silentLogger });
    const project = await projectRegistry.add({
      workspaceRoot,
      name: "Production Cleanup Project",
    });
    const invalidSessionPath = join(
      workspaceRoot,
      ".archcode",
      "runtime",
      "sessions",
      "broken",
      "session.json",
    );
    await mkdir(
      join(workspaceRoot, ".archcode", "runtime", "sessions", "broken"),
      { recursive: true },
    );
    await writeFile(invalidSessionPath, JSON.stringify({ id: "not-a-current-session" }));

    let executionShutdownAttempts = 0;
    const executionManagerShutdown = mock(async () => {
      executionShutdownAttempts += 1;
      if (executionShutdownAttempts === 1) {
        throw new Error("production execution cleanup failed once");
      }
    });
    const sessionAgentManagerDisposeAll = mock(() => undefined);
    const configService = new ServerConfigService({ homeDir: home });
    const createRuntimeFactory = mock(async (options: AgentRuntimeOptions) => {
      const internalOptions = {
        ...options,
        runtimeStorageHomeDir: home,
        executionManagerShutdown,
        sessionAgentManagerDisposeAll,
      };
      return await createRuntime(internalOptions);
    });
    const runtimeDataService = {
      inspect: mock(async () => ({ projects: [] })),
      delete: mock(async () => ({ results: [] })),
    };
    const host = await ArchCodeServerHost.create({
      configService,
      createRuntime: createRuntimeFactory,
      ...hostInfrastructure(home),
      projectRegistry,
      runtimeDataService,
      logger: silentLogger,
    });

    host.startRuntimeActivation();
    await waitForRuntimeState(host, "error");

    expect(host.getRuntimeStatus()).toEqual({
      state: "error",
      error: {
        message: "Runtime cleanup did not complete. Restart ArchCode before retrying or deleting Runtime data.",
        recoveryAllowed: false,
      },
    });
    expect(createRuntimeFactory).toHaveBeenCalledTimes(1);
    expect(executionManagerShutdown).toHaveBeenCalledTimes(1);
    expect(sessionAgentManagerDisposeAll).toHaveBeenCalledTimes(1);

    for (const request of [
      host.app.request("/api/runtime/retry", { method: "POST" }),
      host.app.request("/api/runtime-data", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectSlugs: [project.slug] }),
      }),
    ]) {
      const response = await request;
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: "RUNTIME_CLEANUP_INCOMPLETE" },
      });
    }
    expect(createRuntimeFactory).toHaveBeenCalledTimes(1);
    expect(runtimeDataService.delete).not.toHaveBeenCalled();

    await expect(host.shutdown()).resolves.toBeUndefined();
    expect(executionManagerShutdown).toHaveBeenCalledTimes(2);
    expect(sessionAgentManagerDisposeAll).toHaveBeenCalledTimes(1);
    expect(createRuntimeFactory).toHaveBeenCalledTimes(1);
  });

  test("keeps committed Setup, authentication and Settings APIs after Runtime failure", async () => {
    const updateStatus: UpdateStatus = {
      currentVersion: "1.2.3",
      phase: "idle",
      managed: false,
      restartSupported: false,
      updateAvailable: false,
      restartRequired: false,
    };
    const updateService = {
      getStatus: mock(async () => updateStatus),
      check: mock(async () => updateStatus),
      install: mock(async () => updateStatus),
      stop: mock(async () => undefined),
      closeAdmissionIfIdle: mock(() => true),
      reopenAdmission: mock(() => undefined),
    };
    const runtimeDataService = {
      inspect: mock(async () => ({ projects: [] })),
      delete: mock(async () => ({ results: [] })),
    };
    const fixture = await createSetupHost({
      createRuntime: async (options) => {
        const runtime = fakeRuntime(options.configService);
        runtime.startAutomationSchedulers = mock(async () => {
          throw new Error("scheduler failed");
        });
        return runtime;
      },
      updateService,
      runtimeDataService,
    });

    const response = await fixture.host.app.request("/api/setup", setupRequest(
      fixture.token,
      {
        config: setupConfig(),
        requireLogin: true,
        password: "correct horse battery",
      },
    ));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: {
        mode: "ready",
        authRequired: true,
        authenticated: true,
        runtime: { state: "error" },
      },
    });
    const committedConfig = await readFile(
      resolveServerConfigPath(fixture.home),
      "utf8",
    );
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    expect((await fixture.host.app.request("/api/setup/provider-adapters", {
      headers: { Authorization: `Bearer ${fixture.token}` },
    })).status).toBe(404);
    expect((await fixture.host.app.request("/api/config", {
      headers: { Cookie: cookie },
    })).status).toBe(200);
    expect((await fixture.host.app.request("/api/update", {
      headers: { Cookie: cookie },
    })).status).toBe(200);
    expect((await fixture.host.app.request("/api/update/check", {
      method: "POST",
      headers: { Cookie: cookie, Origin: "http://localhost" },
    })).status).toBe(200);
    expect((await fixture.host.app.request("/api/update/install", {
      method: "POST",
      headers: { Cookie: cookie, Origin: "http://localhost" },
    })).status).toBe(200);
    expect((await fixture.host.app.request("/api/config/provider-adapters", {
      headers: { Cookie: cookie },
    })).status).toBe(200);
    expect((await fixture.host.app.request("/api/config", {
      method: "PUT",
      headers: {
        Cookie: cookie,
        Origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    })).status).toBe(403);
    expect((await fixture.host.app.request("/api/agents")).status).toBe(401);
    expect((await fixture.host.app.request("/api/agents", {
      headers: { Cookie: cookie },
    })).status).toBe(503);
    expect((await fixture.host.app.request("/api/runtime-data")).status).toBe(401);
    expect((await fixture.host.app.request("/api/runtime/retry", {
      method: "POST",
    })).status).toBe(401);
    expect((await fixture.host.app.request("/api/runtime-data", {
      method: "DELETE",
      headers: {
        Cookie: cookie,
        Origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ projectSlugs: ["alpha"] }),
    })).status).toBe(403);
    expect(runtimeDataService.delete).not.toHaveBeenCalled();
    expect(updateService.check).toHaveBeenCalledTimes(1);
    expect(updateService.install).toHaveBeenCalledTimes(1);
    expect(await readFile(resolveServerConfigPath(fixture.home), "utf8"))
      .toBe(committedConfig);
  });

  test("retries with a fresh saved Config activation and atomically publishes Runtime", async () => {
    const home = await createHome();
    await mkdir(join(home, ".archcode"), { recursive: true });
    await writeFile(
      resolveServerConfigPath(home),
      `${JSON.stringify(diskConfig())}\n`,
      { mode: 0o600 },
    );
    const configService = new ServerConfigService({ homeDir: home });
    const activations: AgentRuntimeOptions["activation"][] = [];
    const createRuntime = mock(async (options: AgentRuntimeOptions) => {
      activations.push(options.activation);
      const runtime = fakeRuntime(configService);
      if (activations.length === 1) {
        runtime.recoverSessionContinuations = mock(async () => {
          throw new Error("first activation failed");
        });
      }
      return runtime;
    });
    const host = await ArchCodeServerHost.create({
      configService,
      createRuntime,
      logger: silentLogger,
      ...hostInfrastructure(home),
    });
    host.startRuntimeActivation();
    await waitForRuntimeState(host, "error");

    const snapshot = await (await host.app.request("/api/config")).json() as any;
    snapshot.config.provider.local.models["test-model"].name = "Changed model";
    snapshot.config.provider.local.options.apiKey = { action: "preserve" };
    const saved = await host.app.request("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: snapshot.revision,
        config: snapshot.config,
      }),
    });
    expect(saved.status).toBe(200);

    const retried = await host.app.request("/api/runtime/retry", { method: "POST" });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ state: "ready" });
    expect(createRuntime).toHaveBeenCalledTimes(2);
    expect(activations[1]).not.toBe(activations[0]);
    expect((activations[1] as any).runtimeConfig.provider.local.models["test-model"].name)
      .toBe("Changed model");
    expect((await host.app.request("/api/agents")).status).toBe(200);
    expect((await host.app.request("/api/runtime/retry", { method: "POST" })).status)
      .toBe(409);
    expect((await host.app.request("/api/runtime-data", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectSlugs: ["alpha"] }),
    })).status).toBe(409);
  });

  test("commits Config then hot-applies the exact resolved MCP config", async () => {
    const home = await createHome();
    await mkdir(join(home, ".archcode"), { recursive: true });
    await writeFile(resolveServerConfigPath(home), `${JSON.stringify(diskConfig())}\n`, { mode: 0o600 });
    const configService = new ServerConfigService({ homeDir: home });
    const runtime = fakeRuntime(configService);
    const host = await ArchCodeServerHost.create({
      configService,
      createRuntime: mock(async () => runtime),
      logger: silentLogger,
      ...hostInfrastructure(home),
    });
    host.startRuntimeActivation();
    await waitForRuntimeState(host, "ready");
    const snapshot = await (await host.app.request("/api/config")).json() as any;
    snapshot.config.provider.local.options.apiKey = { action: "preserve" };
    snapshot.config.mcp = {
      disabledBuiltins: ["exa"],
      servers: {
        docs: { type: "http", enabled: true, url: "https://docs.test/mcp" },
      },
    };

    const response = await host.app.request("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: snapshot.revision, config: snapshot.config }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mcpApply: { state: "applied", status: { servers: {} } } });
    expect(runtime.applyMcpConfig).toHaveBeenCalledWith({
      disabledBuiltins: ["exa"],
      servers: {
        docs: {
          type: "http",
          enabled: true,
          url: "https://docs.test/mcp",
          headers: undefined,
          connectTimeoutMs: 10_000,
          discoveryTimeoutMs: 30_000,
          callTimeoutMs: 60_000,
        },
      },
    });
  });

  test("keeps a committed Config when MCP hot-apply fails", async () => {
    const home = await createHome();
    await mkdir(join(home, ".archcode"), { recursive: true });
    await writeFile(resolveServerConfigPath(home), `${JSON.stringify(diskConfig())}\n`, { mode: 0o600 });
    const configService = new ServerConfigService({ homeDir: home });
    const runtime = fakeRuntime(configService);
    runtime.applyMcpConfig = mock(async () => { throw new Error("secret transport failure"); });
    const host = await ArchCodeServerHost.create({
      configService,
      createRuntime: mock(async () => runtime),
      logger: silentLogger,
      ...hostInfrastructure(home),
    });
    host.startRuntimeActivation();
    await waitForRuntimeState(host, "ready");
    const snapshot = await (await host.app.request("/api/config")).json() as any;
    snapshot.config.provider.local.options.apiKey = { action: "preserve" };
    snapshot.config.provider.local.models["test-model"].name = "Committed despite MCP failure";

    const response = await host.app.request("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: snapshot.revision, config: snapshot.config }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.mcpApply).toEqual({
      state: "failed",
      error: "Configuration was saved, but MCP live apply failed",
      status: { servers: {} },
    });
    expect(JSON.stringify(body)).not.toContain("secret transport failure");
    expect((await configService.getSnapshot()).config.provider.local.models["test-model"].name)
      .toBe("Committed despite MCP failure");
  });

  test("serializes concurrent Config save before delete and retry recovery mutations", async () => {
    for (const recovery of ["delete", "retry"] as const) {
      const home = await createHome();
      await mkdir(join(home, ".archcode"), { recursive: true });
      await writeFile(
        resolveServerConfigPath(home),
        `${JSON.stringify(diskConfig())}\n`,
        { mode: 0o600 },
      );
      const configService = new ServerConfigService({ homeDir: home });
      const order: string[] = [];
      let activationAttempts = 0;
      const createRuntime = mock(async (options: AgentRuntimeOptions) => {
        activationAttempts += 1;
        const modelName = (options.activation as any).runtimeConfig
          .provider.local.models["test-model"].name;
        order.push(`activate:${modelName}`);
        const runtime = fakeRuntime(configService);
        if (activationAttempts === 1) {
          runtime.recoverSessionContinuations = mock(async () => {
            throw new Error("initial failure");
          });
        }
        return runtime;
      });
      const runtimeDataService = {
        delete: mock(async () => {
          order.push("delete");
          return {
            results: [{ projectSlug: "alpha", status: "deleted" as const }],
          };
        }),
        inspect: mock(async () => {
          order.push("inspect");
          return { projects: [] };
        }),
      };
      const host = await ArchCodeServerHost.create({
        configService,
        createRuntime,
        logger: silentLogger,
        ...hostInfrastructure(home),
        runtimeDataService,
      });
      host.startRuntimeActivation();
      await waitForRuntimeState(host, "error");
      order.length = 0;

      const originalSave = configService.saveWithRuntimeConfig.bind(configService);
      let signalSaveEntered!: () => void;
      const saveEntered = new Promise<void>((resolve) => { signalSaveEntered = resolve; });
      let releaseSave!: () => void;
      const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
      configService.saveWithRuntimeConfig = mock(async (request) => {
        order.push("save:start");
        signalSaveEntered();
        await saveGate;
        const response = await originalSave(request);
        order.push("save:end");
        return response;
      });
      const snapshot = await (await host.app.request("/api/config")).json() as any;
      const changedName = `Changed ${recovery}`;
      snapshot.config.provider.local.models["test-model"].name = changedName;
      snapshot.config.provider.local.options.apiKey = { action: "preserve" };
      const saving = host.app.request("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: snapshot.revision,
          config: snapshot.config,
        }),
      });
      await saveEntered;
      const recovering = recovery === "retry"
        ? host.app.request("/api/runtime/retry", { method: "POST" })
        : host.app.request("/api/runtime-data", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectSlugs: ["alpha"] }),
        });
      await Bun.sleep(1);
      expect(order).toEqual(["save:start"]);
      if (recovery === "delete") {
        expect((await host.app.request("/api/runtime/retry", { method: "POST" })).status)
          .toBe(409);
      }
      releaseSave();
      expect((await saving).status).toBe(200);
      expect((await recovering).status).toBe(200);
      expect(order).toEqual(recovery === "retry"
        ? ["save:start", "save:end", `activate:${changedName}`]
        : ["save:start", "save:end", "delete", `activate:${changedName}`]);
      expect(host.getRuntimeStatus()).toEqual({ state: "ready" });
      await host.shutdown();
    }
  });

  test("activates once after complete Runtime data deletion and never after partial failure", async () => {
    for (const deletionSucceeded of [true, false]) {
      const home = await createHome();
      await mkdir(join(home, ".archcode"), { recursive: true });
      await writeFile(
        resolveServerConfigPath(home),
        `${JSON.stringify(diskConfig())}\n`,
        { mode: 0o600 },
      );
      const configService = new ServerConfigService({ homeDir: home });
      let attempts = 0;
      const order: string[] = [];
      const createRuntime = mock(async () => {
        attempts += 1;
        order.push("activate");
        const runtime = fakeRuntime(configService);
        if (attempts === 1) {
          runtime.recoverSessionContinuations = mock(async () => {
            throw new Error("initial failure");
          });
        }
        return runtime;
      });
      const runtimeDataService = {
        inspect: mock(async () => {
          order.push("inspect");
          return { projects: [] };
        }),
        delete: mock(async () => {
          order.push("delete");
          return {
            results: [{
              projectSlug: "alpha",
              ...(deletionSucceeded
                ? { status: "deleted" as const }
                : {
                  status: "error" as const,
                  error: { code: "delete_failed" as const, message: "failed" },
                }),
            }],
          };
        }),
      };
      const host = await ArchCodeServerHost.create({
        configService,
        createRuntime,
        logger: silentLogger,
        ...hostInfrastructure(home),
        runtimeDataService,
      });
      host.startRuntimeActivation();
      await waitForRuntimeState(host, "error");
      order.length = 0;

      const response = await host.app.request("/api/runtime-data", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectSlugs: ["alpha"] }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject(deletionSucceeded
        ? {
          results: [{ projectSlug: "alpha", status: "deleted" }],
          runtime: { state: "ready" },
        }
        : {
          results: [{ projectSlug: "alpha", status: "error" }],
          runtime: {
            state: "error",
            error: { recoveryAllowed: true },
          },
        });
      expect(attempts).toBe(deletionSucceeded ? 2 : 1);
      expect(host.getRuntimeStatus().state).toBe(deletionSucceeded ? "ready" : "error");
      expect(runtimeDataService.inspect).not.toHaveBeenCalled();
      expect(order).toEqual(deletionSucceeded
        ? ["delete", "activate"]
        : ["delete"]);
    }
  });

  test("returns the final Runtime error when automatic post-delete activation fails", async () => {
    const home = await createHome();
    await mkdir(join(home, ".archcode"), { recursive: true });
    await writeFile(
      resolveServerConfigPath(home),
      `${JSON.stringify(diskConfig())}\n`,
      { mode: 0o600 },
    );
    const configService = new ServerConfigService({ homeDir: home });
    let attempts = 0;
    const createRuntime = mock(async () => {
      attempts += 1;
      const runtime = fakeRuntime(configService);
      runtime.recoverSessionContinuations = mock(async () => {
        throw new Error(`activation ${attempts} failed`);
      });
      return runtime;
    });
    const host = await ArchCodeServerHost.create({
      configService,
      createRuntime,
      logger: silentLogger,
      ...hostInfrastructure(home),
      runtimeDataService: {
        delete: mock(async () => ({
          results: [{ projectSlug: "alpha", status: "deleted" as const }],
        })),
        inspect: mock(async () => ({ projects: [] })),
      },
    });
    host.startRuntimeActivation();
    await waitForRuntimeState(host, "error");

    const response = await host.app.request("/api/runtime-data", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectSlugs: ["alpha"] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      results: [{ projectSlug: "alpha", status: "deleted" }],
      runtime: {
        state: "error",
        error: {
          message: "ArchCode Runtime could not start. Check Runtime Data or the server log, then retry.",
          recoveryAllowed: true,
        },
      },
    });
    expect(attempts).toBe(2);
  });

  test("recovers in process with the real Runtime data service while preserving healthy project data", async () => {
    const home = await createHome();
    await mkdir(join(home, ".archcode"), { recursive: true });
    await writeFile(
      resolveServerConfigPath(home),
      `${JSON.stringify(diskConfig())}\n`,
      { mode: 0o600 },
    );
    const badWorkspace = join(home, "bad-project");
    const healthyWorkspace = join(home, "healthy-project");
    await mkdir(badWorkspace, { recursive: true });
    await mkdir(healthyWorkspace, { recursive: true });
    const projectRegistry = new ProjectRegistry({ homeDir: home, logger: silentLogger });
    const badProject = await projectRegistry.add({
      workspaceRoot: badWorkspace,
      name: "Bad Project",
    });
    const healthyProject = await projectRegistry.add({
      workspaceRoot: healthyWorkspace,
      name: "Healthy Project",
    });
    const badRuntime = join(badWorkspace, ".archcode", "runtime");
    const badSession = join(badRuntime, "sessions", "broken", "session.json");
    await mkdir(join(badRuntime, "sessions", "broken"), { recursive: true });
    await writeFile(badSession, JSON.stringify({ id: "broken" }));
    const healthySentinel = join(
      healthyWorkspace,
      ".archcode",
      "runtime",
      "attachments",
      "sentinel.bin",
    );
    await mkdir(join(healthyWorkspace, ".archcode", "runtime", "attachments"), {
      recursive: true,
    });
    const healthyBytes = "healthy-runtime-sentinel\n";
    await writeFile(healthySentinel, healthyBytes);

    const configService = new ServerConfigService({ homeDir: home });
    const runtimeDataService = new RuntimeDataService({ projectRegistry });
    let activationAttempts = 0;
    let observedDeletedRuntime = false;
    const createRuntime = mock(async (options: AgentRuntimeOptions) => {
      expect(options.projectRegistry).toBe(projectRegistry);
      activationAttempts += 1;
      const badSessionExists = await readFile(badSession).then(
        () => true,
        () => false,
      );
      const runtime = fakeRuntime(configService);
      if (badSessionExists) {
        runtime.recoverSessionContinuations = mock(async () => {
          throw new Error("invalid durable Session");
        });
      } else {
        observedDeletedRuntime = true;
        await mkdir(badRuntime, { recursive: true });
      }
      return runtime;
    });
    const host = await ArchCodeServerHost.create({
      configService,
      createRuntime,
      logger: silentLogger,
      ...hostInfrastructure(home),
      projectRegistry,
      runtimeDataService,
    });
    host.startRuntimeActivation();
    await waitForRuntimeState(host, "error");

    const inspection = await (await host.app.request("/api/runtime-data")).json() as any;
    expect(inspection.projects.find((project: any) => project.projectSlug === badProject.slug).issues)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          relativePath: "sessions/broken/session.json",
          reason: "invalid_current_schema",
        }),
      ]));
    expect(inspection.projects.find((project: any) => project.projectSlug === healthyProject.slug).issues)
      .toEqual([]);

    const deletion = await host.app.request("/api/runtime-data", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectSlugs: [badProject.slug] }),
    });
    expect(deletion.status).toBe(200);
    expect(await deletion.json()).toEqual({
      results: [{ projectSlug: badProject.slug, status: "deleted" }],
      runtime: { state: "ready" },
    });
    expect(host.getRuntimeStatus()).toEqual({ state: "ready" });
    expect(activationAttempts).toBe(2);
    expect(observedDeletedRuntime).toBe(true);
    expect((await projectRegistry.list()).map((project) => project.slug).sort())
      .toEqual([badProject.slug, healthyProject.slug].sort());
    expect(await readFile(badSession).then(() => true, () => false)).toBe(false);
    expect((await stat(badRuntime)).isDirectory()).toBe(true);
    expect(await readFile(healthySentinel, "utf8")).toBe(healthyBytes);
    await host.shutdown();
  });

  test("recovers an authenticated production Runtime through the embedded control-plane shell", async () => {
    const home = await createHome();
    const badWorkspace = join(home, "production-bad-project");
    const healthyWorkspace = join(home, "production-healthy-project");
    await mkdir(badWorkspace, { recursive: true });
    await mkdir(healthyWorkspace, { recursive: true });
    const projectRegistry = new ProjectRegistry({ homeDir: home, logger: silentLogger });
    const badProject = await projectRegistry.add({
      workspaceRoot: badWorkspace,
      name: "Production Bad Project",
    });
    const healthyProject = await projectRegistry.add({
      workspaceRoot: healthyWorkspace,
      name: "Production Healthy Project",
    });
    const badSession = join(
      badWorkspace,
      ".archcode",
      "runtime",
      "sessions",
      "broken",
      "session.json",
    );
    await mkdir(join(badWorkspace, ".archcode", "runtime", "sessions", "broken"), {
      recursive: true,
    });
    await writeFile(badSession, JSON.stringify({ id: "not-a-current-session" }));
    const healthySentinel = join(
      healthyWorkspace,
      ".archcode",
      "runtime",
      "attachments",
      "sentinel.bin",
    );
    await mkdir(join(healthyWorkspace, ".archcode", "runtime", "attachments"), {
      recursive: true,
    });
    const healthyBytes = "production-healthy-sentinel\n";
    await writeFile(healthySentinel, healthyBytes);
    const indexPath = join(home, "index.html");
    await writeFile(indexPath, "<!doctype html><title>ArchCode recovery</title>");

    const configService = new ServerConfigService({ homeDir: home });
    const runtimeDataService = new RuntimeDataService({ projectRegistry });
    const host = await ArchCodeServerHost.create({
      configService,
      createRuntime: async (options) => await createRuntime({
        ...options,
        runtimeStorageHomeDir: home,
      }),
      ...hostInfrastructure(home),
      projectRegistry,
      runtimeDataService,
      logger: silentLogger,
      embeddedWebAssets: new Map([["/index.html", indexPath]]),
    });
    const setupUrl = host.terminalInstructions("http://localhost:4096")[0]!;
    const token = new URL(setupUrl.slice(setupUrl.indexOf("http"))).hash
      .slice("#token=".length);

    try {
      const setup = await host.app.request("/api/setup", setupRequest(token, {
        config: setupConfig(),
        requireLogin: true,
        password: "production recovery password",
      }));
      expect(setup.status).toBe(200);
      const cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
      expect(await setup.json()).toMatchObject({
        status: {
          mode: "ready",
          authenticated: true,
          runtime: {
            state: "error",
            error: { recoveryAllowed: true },
          },
        },
      });
      expect((await host.app.request("/")).status).toBe(200);
      expect(await (await host.app.request("/api/bootstrap", {
        headers: { Cookie: cookie },
      })).json()).toMatchObject({
        mode: "ready",
        authenticated: true,
        runtime: { state: "error" },
      });
      const inspection = await (await host.app.request("/api/runtime-data", {
        headers: { Cookie: cookie },
      })).json() as any;
      expect(inspection.projects.find((project: any) => project.projectSlug === badProject.slug).issues)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({
            relativePath: "sessions/broken/session.json",
            reason: "invalid_current_schema",
          }),
        ]));

      const deletion = await host.app.request("/api/runtime-data", {
        method: "DELETE",
        headers: {
          Cookie: cookie,
          Origin: "http://localhost",
          "content-type": "application/json",
        },
        body: JSON.stringify({ projectSlugs: [badProject.slug] }),
      });
      expect(deletion.status).toBe(200);
      expect(await deletion.json()).toEqual({
        results: [{ projectSlug: badProject.slug, status: "deleted" }],
        runtime: { state: "ready" },
      });
      expect((await projectRegistry.list()).map((project) => project.slug).sort())
        .toEqual([badProject.slug, healthyProject.slug].sort());
      expect(await readFile(badSession).then(() => true, () => false)).toBe(false);
      expect(await readFile(healthySentinel, "utf8")).toBe(healthyBytes);
      const sessions = await host.app.request(
        `/api/projects/${badProject.slug}/sessions`,
        { headers: { Cookie: cookie } },
      );
      expect(sessions.status).toBe(200);
      expect(await sessions.json()).toEqual({ sessions: [] });
    } finally {
      await host.shutdown();
    }
  });

});

async function waitForRuntimeState(
  host: ArchCodeServerHost,
  state: "activating" | "ready" | "error",
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (host.getRuntimeStatus().state === state) return;
    await Bun.sleep(1);
  }
  throw new Error(`Runtime did not reach ${state}`);
}
