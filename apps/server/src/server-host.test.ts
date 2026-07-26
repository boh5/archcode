import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import {
  createInMemoryLogger,
  ServerConfigService,
  resolveServerConfigPath,
  silentLogger,
  type AgentRuntime,
  type AgentRuntimeOptions,
  type Logger,
} from "@archcode/agent-core";
import type { CompleteSetupRequest } from "@archcode/protocol";
import { ArchCodeServerHost } from "./server-host";

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
    recoverProjectTodos: mock(async () => undefined),
    startAutomationSchedulers: mock(async () => undefined),
    shutdown: mock(async () => undefined),
    notifyRuntimeShutdown: mock(() => undefined),
    listAgentDescriptors: mock(() => [{ name: "lead", displayName: "Lead" }]),
    subscribeSessionEvents: mock(() => () => undefined),
    subscribeHitlEvents: mock(() => () => undefined),
    subscribeSessionRuntimeChanges: mock(() => () => undefined),
    subscribeMcpStatusChanges: mock(() => () => undefined),
    subscribeModelRuntimeChanges: mock(() => () => undefined),
    subscribeResourceChanges: mock(() => () => undefined),
    getMcpServerStatuses: mock(() => new Map()),
    listSessionRuntimeEvents: mock(async () => []),
    listHitlSnapshotEvents: mock(async () => []),
  } as unknown as AgentRuntime;
}

async function createSetupHost(overrides: {
  createRuntime?: (options: AgentRuntimeOptions) => Promise<AgentRuntime>;
  embeddedWebAssets?: ReadonlyMap<string, string>;
  logger?: Logger;
  accessLog?: boolean;
} = {}) {
  const home = await createHome();
  const configService = new ServerConfigService({ homeDir: home });
  const runtime = fakeRuntime(configService);
  const createRuntime = mock(overrides.createRuntime ?? (async () => runtime));
  const host = await ArchCodeServerHost.create({
    configService,
    createRuntime,
    logger: overrides.logger ?? silentLogger,
    accessLog: overrides.accessLog,
    dev: false,
    embeddedWebAssets: overrides.embeddedWebAssets,
    version: "1.2.3",
  });
  const setupUrl = host.setupInstructions("http://localhost:4096")[0]!;
  const token = new URL(setupUrl.slice(setupUrl.indexOf("http"))).hash.slice("#token=".length);
  return { host, home, configService, runtime, createRuntime, token };
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
      },
    });
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect("auth" in createRuntime.mock.calls[0]![0].activation).toBe(false);
    expect((await host.app.request("/api/agents")).status).toBe(200);
    expect((await host.app.request("/api/setup/provider-adapters", {
      headers: { Authorization: `Bearer ${token}` },
    })).status).toBe(404);
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
    expect((await host.app.request("/api/agents", {
      headers: { Cookie: cookie.split(";")[0]! },
    })).status).toBe(200);
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

    expect(second.status).toBe(409);
    expect((await first).status).toBe(200);
  });

  test("shows config_error for an existing invalid Config and never opens Setup", async () => {
    const home = await createHome();
    await mkdir(join(home, ".archcode"), { recursive: true });
    await writeFile(resolveServerConfigPath(home), "{invalid", { mode: 0o600 });
    const configService = new ServerConfigService({ homeDir: home });
    const createRuntime = mock(async () => fakeRuntime(configService));

    const host = await ArchCodeServerHost.create({
      configService,
      createRuntime,
      logger: silentLogger,
    });
    const bootstrap = await host.app.request("/api/bootstrap");

    expect(await bootstrap.json()).toEqual({
      mode: "config_error",
      message: "The global configuration is invalid. Repair it and restart ArchCode.",
    });
    expect((await host.app.request("/api/setup/provider-adapters")).status).toBe(404);
    expect(createRuntime).not.toHaveBeenCalled();
  });

  test("cleans a partially started Runtime and exposes startup_error", async () => {
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
    });

    expect(await (await host.app.request("/api/bootstrap")).json()).toEqual({
      mode: "startup_error",
      message: "The saved configuration is valid, but ArchCode could not start. Check the server log and restart.",
    });
    expect(runtime.shutdown).toHaveBeenCalledTimes(1);
    expect((await host.app.request("/api/agents")).status).toBe(503);
  });
});
