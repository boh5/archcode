import { copyFile, chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const STARTUP_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5_000;
const SSE_TIMEOUT_MS = 10_000;

interface RunningServer {
  readonly baseUrl: string;
  readonly process: ReturnType<typeof Bun.spawn>;
  readonly stdout: Promise<string>;
  readonly stderr: Promise<string>;
}

interface SseEvent {
  readonly event: string;
  readonly data: unknown;
}

class SseReader {
  readonly #abort: AbortController;
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  readonly #queued: SseEvent[] = [];
  #buffer = "";

  private constructor(response: Response, abort: AbortController) {
    if (response.body === null) throw new Error("Global SSE response did not include a body");
    this.#abort = abort;
    this.#reader = response.body.getReader();
  }

  static async connect(baseUrl: string): Promise<SseReader> {
    const abort = new AbortController();
    try {
      const response = await withTimeout(fetch(`${baseUrl}/api/events`, {
        headers: { accept: "text/event-stream" },
        signal: abort.signal,
      }), REQUEST_TIMEOUT_MS, "connecting to global SSE stream");
      if (!response.ok) throw new Error(`Global SSE endpoint returned HTTP ${response.status}`);
      return new SseReader(response, abort);
    } catch (error) {
      abort.abort();
      throw error;
    }
  }

  async waitFor(
    predicate: (event: SseEvent) => boolean,
    label: string,
  ): Promise<SseEvent> {
    const deadline = Date.now() + SSE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const event = await this.#next(deadline - Date.now());
      if (predicate(event)) return event;
    }
    throw new Error(`Timed out waiting for SSE event: ${label}`);
  }

  async close(): Promise<void> {
    this.#abort.abort();
    await this.#reader.cancel().catch(() => undefined);
  }

  async #next(timeoutMs: number): Promise<SseEvent> {
    while (this.#queued.length === 0) {
      const result = await withTimeout(this.#reader.read(), timeoutMs, "reading global SSE stream");
      if (result.done) throw new Error("Global SSE stream closed before the expected event");
      this.#buffer += this.#decoder.decode(result.value, { stream: true });
      this.#drainFrames();
    }
    return this.#queued.shift()!;
  }

  #drainFrames(): void {
    this.#buffer = this.#buffer.replaceAll("\r\n", "\n");
    while (true) {
      const boundary = this.#buffer.indexOf("\n\n");
      if (boundary === -1) return;
      const frame = this.#buffer.slice(0, boundary);
      this.#buffer = this.#buffer.slice(boundary + 2);
      const lines = frame.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
      const data = lines
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n");
      if (event === undefined || data.length === 0) continue;
      this.#queued.push({ event, data: JSON.parse(data) });
    }
  }
}

async function main(): Promise<void> {
  const repositoryRoot = resolve(import.meta.dir, "../..");
  const binaryOverride = process.env.ARCHCODE_SMOKE_BINARY?.trim();
  const expectedVersion = process.env.ARCHCODE_SMOKE_EXPECTED_VERSION?.trim();
  const binaryPath = binaryOverride === undefined || binaryOverride.length === 0
    ? join(repositoryRoot, "dist", "archcode")
    : resolve(binaryOverride);
  const configFixture = join(repositoryRoot, ".github", "fixtures", "smoke-config.json");
  const root = await mkdtemp(join(tmpdir(), "archcode-compiled-smoke-"));
  const homeDir = join(root, "home");
  const workspaceRoot = join(root, "workspace");
  let server: RunningServer | undefined;
  let events: SseReader | undefined;

  try {
    await mkdir(join(homeDir, ".archcode"), { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });
    const configPath = join(homeDir, ".archcode", "config.json");
    await copyFile(configFixture, configPath);
    await chmod(configPath, 0o600);

    server = await startServer(binaryPath, homeDir);
    const initialHealth = await assertBootstrapReady(server.baseUrl);
    assertExpectedVersion(initialHealth, expectedVersion);
    await assertEmbeddedWebUi(server.baseUrl);

    const initialProjects = asRecord(await requestJson(server.baseUrl, "/api/projects"));
    assert(Array.isArray(initialProjects.projects) && initialProjects.projects.length === 0,
      "Expected an isolated empty project registry");

    const project = asRecord(await requestJson(server.baseUrl, "/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceRoot, name: "Compiled Smoke" }),
    }, 201));
    assert(typeof project.slug === "string" && project.slug.length > 0, "Project response did not include a slug");
    assert(project.workspaceRoot === workspaceRoot, "Project response did not preserve the workspace root");
    const slug = encodeURIComponent(project.slug);

    events = await SseReader.connect(server.baseUrl);
    await events.waitFor((event) => {
      const data = asOptionalRecord(event.data);
      return event.event === "session.runtime.snapshot"
        && Array.isArray(data?.projectSlugs)
        && data.projectSlugs.includes(project.slug);
    }, "initial Session runtime snapshot");
    await events.waitFor((event) => {
      const data = asOptionalRecord(event.data);
      return event.event === "hitl.snapshot"
        && Array.isArray(data?.projectSlugs)
        && data.projectSlugs.includes(project.slug)
        && Array.isArray(data?.entries);
    }, "initial HITL snapshot");

    const renamedProject = asRecord(await requestJson(server.baseUrl, `/api/projects/${slug}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Compiled Smoke Renamed" }),
    }));
    assert(renamedProject.name === "Compiled Smoke Renamed", "Project rename did not return the updated name");
    await events.waitFor((event) => {
      const data = asOptionalRecord(event.data);
      return event.event === "project.catalog_changed"
        && data?.type === "project.catalog_changed"
        && typeof data?.createdAt === "number";
    }, "live project catalog change");

    const hitl = asRecord(await requestJson(server.baseUrl, `/api/projects/${slug}/hitl?status=all`));
    assert(Array.isArray(hitl.hitl) && hitl.hitl.length === 0, "Expected a new project to have no HITL records");

    const createdTodoResponse = asRecord(await requestJson(server.baseUrl, `/api/projects/${slug}/todos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Compiled smoke Todo" }),
    }, 201));
    const createdTodo = asRecord(createdTodoResponse.todo);
    assert(typeof createdTodo.id === "string", "Todo response did not include an id");
    assert(createdTodo.status === "idea" && createdTodo.revision === 1, "Todo was not created in its initial state");

    await events.waitFor((event) => {
      const data = asOptionalRecord(event.data);
      return event.event === "resource.changed"
        && data?.projectSlug === project.slug
        && data?.resourceType === "todo"
        && data?.resourceId === createdTodo.id;
    }, "live Todo resource change");

    const updatedTodoResponse = asRecord(await requestJson(
      server.baseUrl,
      `/api/projects/${slug}/todos/${encodeURIComponent(String(createdTodo.id))}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: 1, status: "ready" }),
      },
    ));
    const updatedTodo = asRecord(updatedTodoResponse.todo);
    assert(updatedTodo.status === "ready" && updatedTodo.revision === 2, "Todo mutation was not persisted");

    const session = asRecord(await requestJson(server.baseUrl, `/api/projects/${slug}/sessions`, {
      method: "POST",
    }, 201));
    assert(typeof session.sessionId === "string" && session.sessionId.length > 0,
      "Session response did not include an id");
    assert(session.rootSessionId === session.sessionId && session.agentName === "lead",
      "Direct Session identity was not created correctly");
    assert(Array.isArray(session.messages) && session.messages.length === 0,
      "New direct Session should have an empty transcript");
    const sessionId = encodeURIComponent(session.sessionId);

    await assertPersistedApiState(server.baseUrl, slug, "Compiled Smoke Renamed", createdTodo.id, sessionId);

    await events.close();
    events = undefined;
    await stopServer(server);
    server = undefined;

    server = await startServer(binaryPath, homeDir);
    const restartedHealth = await assertBootstrapReady(server.baseUrl);
    assertExpectedVersion(restartedHealth, expectedVersion);
    await assertPersistedApiState(server.baseUrl, slug, "Compiled Smoke Renamed", createdTodo.id, sessionId);
    await assertEmbeddedWebUi(server.baseUrl);

    console.log("Compiled binary smoke passed: bootstrap, project catalog SSE, HITL snapshot, Todo, Session, and restart persistence.");
  } catch (error) {
    if (server !== undefined) {
      await stopServer(server).catch(() => undefined);
      const [stdout, stderr] = await Promise.all([server.stdout, server.stderr]);
      if (stdout.length > 0) console.error(`\n--- archcode stdout ---\n${stdout}`);
      if (stderr.length > 0) console.error(`\n--- archcode stderr ---\n${stderr}`);
    }
    throw error;
  } finally {
    await events?.close().catch(() => undefined);
    if (server !== undefined) await stopServer(server).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

async function assertBootstrapReady(baseUrl: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastObservation = "server did not respond";
  while (Date.now() < deadline) {
    try {
      const health = asRecord(await requestJson(baseUrl, "/api/health"));
      assert(health.ok === true, "Health endpoint did not report ok");
      const bootstrap = asRecord(await requestJson(baseUrl, "/api/bootstrap"));
      const runtime = asOptionalRecord(bootstrap.runtime);
      lastObservation = JSON.stringify(bootstrap);
      if (bootstrap.mode === "ready"
        && bootstrap.authRequired === false
        && bootstrap.authenticated === true
        && runtime?.state === "ready") return health;
      if (runtime?.state === "error") throw new Error(`Runtime activation failed: ${lastObservation}`);
    } catch (error) {
      lastObservation = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(100);
  }
  throw new Error(`Compiled binary did not become ready within ${STARTUP_TIMEOUT_MS}ms: ${lastObservation}`);
}

function assertExpectedVersion(
  health: Record<string, unknown>,
  expectedVersion: string | undefined,
): void {
  if (expectedVersion === undefined || expectedVersion.length === 0) return;
  assert(
    health.version === expectedVersion,
    `Health endpoint reported version ${String(health.version)}; expected ${expectedVersion}`,
  );
}

async function assertEmbeddedWebUi(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const html = await response.text();
  assert(response.status === 200, `Embedded Web UI returned HTTP ${response.status}`);
  assert(html.includes('<div id="root"></div>'), "Embedded Web UI did not include the React root");
}

async function assertPersistedApiState(
  baseUrl: string,
  slug: string,
  projectName: string,
  todoId: unknown,
  sessionId: string,
): Promise<void> {
  const projects = asRecord(await requestJson(baseUrl, "/api/projects"));
  assert(Array.isArray(projects.projects)
    && projects.projects.some((candidate) => {
      const project = asOptionalRecord(candidate);
      return project?.slug === decodeURIComponent(slug) && project?.name === projectName;
    }),
  "Registered project was not readable");

  const todos = asRecord(await requestJson(baseUrl, `/api/projects/${slug}/todos`));
  assert(Array.isArray(todos.todos)
    && todos.todos.some((candidate) => {
      const todo = asOptionalRecord(candidate);
      return todo?.id === todoId && todo?.status === "ready" && todo?.revision === 2;
    }),
  "Mutated Todo was not readable");

  const session = asRecord(await requestJson(baseUrl, `/api/projects/${slug}/sessions/${sessionId}`));
  assert(encodeURIComponent(String(session.sessionId)) === sessionId, "Created Session was not readable");

  const inventory = asRecord(await requestJson(baseUrl, `/api/projects/${slug}/sessions`));
  assert(Array.isArray(inventory.sessions)
    && inventory.sessions.some((candidate) => {
      const item = asOptionalRecord(candidate);
      return asOptionalRecord(item?.session)?.sessionId === session.sessionId;
    }),
  "Created Session was missing from project inventory");

  const tree = asRecord(await requestJson(baseUrl, `/api/projects/${slug}/sessions/${sessionId}/tree`));
  assert(asOptionalRecord(asOptionalRecord(tree.root)?.session)?.sessionId === session.sessionId,
    "Created Session was missing from the Agent Tree projection");

  const hitl = asRecord(await requestJson(baseUrl, `/api/projects/${slug}/hitl?status=all`));
  assert(Array.isArray(hitl.hitl) && hitl.hitl.length === 0, "Unexpected HITL records after restart");
}

async function startServer(binaryPath: string, homeDir: string): Promise<RunningServer> {
  const port = await reservePort();
  const child = Bun.spawn([binaryPath], {
    env: {
      ...process.env,
      HOME: homeDir,
      ARCHCODE_PORT: String(port),
      ARCHCODE_LOG_LEVEL: "info",
      ARCHCODE_ACCESS_LOG: "off",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    process: child,
    stdout: child.stdout instanceof ReadableStream ? new Response(child.stdout).text() : Promise.resolve(""),
    stderr: child.stderr instanceof ReadableStream ? new Response(child.stderr).text() : Promise.resolve(""),
  };
}

async function stopServer(server: RunningServer): Promise<void> {
  if (server.process.exitCode !== null) return;
  server.process.kill("SIGTERM");
  try {
    await withTimeout(server.process.exited, 15_000, "compiled binary shutdown");
  } catch (error) {
    if (server.process.exitCode === null) server.process.kill("SIGKILL");
    await withTimeout(server.process.exited, 5_000, "forced compiled binary shutdown").catch(() => undefined);
    throw error;
  }
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert(address !== null && typeof address === "object", "Could not reserve a local port");
  const port = address.port;
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return port;
}

async function requestJson(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
  expectedStatus = 200,
): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`${init.method ?? "GET"} ${path} returned HTTP ${response.status}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${init.method ?? "GET"} ${path} did not return JSON: ${text}`);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out while ${label}`)), Math.max(timeoutMs, 1));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  const record = asOptionalRecord(value);
  if (record === undefined) throw new Error(`Expected an object, received ${JSON.stringify(value)}`);
  return record;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
