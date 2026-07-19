import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ServerConfigService, resolveServerConfigPath } from "../config";
import { silentLogger } from "../logger";
import type { McpManager } from "../mcp";
import { createRuntime as createProductionRuntime } from "../runtime";
import type { StreamingTextRedactor } from "../security";
import { createTestArtifact } from "./artifact-store-fixture.test";
import {
  ToolOutputArtifactStore,
  computeProjectIdentity,
} from "./artifact-store";
import type {
  ArtifactOwner,
  ArtifactSearchRunner,
  OutputRef,
} from "./artifact-types";

const CURSOR_KEY = new Uint8Array(32).fill(19);
const roots = new Set<string>();
const stores = new Set<ToolOutputArtifactStore>();

type RuntimeTestOptions = NonNullable<Parameters<typeof createProductionRuntime>[0]> & {
  toolOutputStoreFactory?: (rootDir: string) => ToolOutputArtifactStore;
};

function identity(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function owner(
  producerSessionId: string,
  rootSessionId = "root-a",
): ArtifactOwner {
  return {
    projectIdentity: identity("project-a"),
    rootSessionId,
    producerSessionId,
  };
}

function identityRedactor(): StreamingTextRedactor {
  return { push: (text) => text, finish: () => "" };
}

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.add(root);
  return root;
}

function trackStore(store: ToolOutputArtifactStore): ToolOutputArtifactStore {
  stores.add(store);
  return store;
}

function makeStore(
  rootDir: string,
  options: Omit<ConstructorParameters<typeof ToolOutputArtifactStore>[0], "rootDir" | "limits"> & {
    limits?: ConstructorParameters<typeof ToolOutputArtifactStore>[0]["limits"];
  } = {},
): ToolOutputArtifactStore {
  return trackStore(new ToolOutputArtifactStore({
    ...options,
    rootDir,
    cursorKey: options.cursorKey ?? CURSOR_KEY,
    limits: {
      artifactMaxBytes: 64 * 1024,
      artifactHeadMaxBytes: 63 * 1024,
      artifactTailMaxBytes: 1024,
      bodyQuotaBytes: 1024 * 1024,
      bodyMaxActive: 100,
      ledgerMaxEntries: 1_000,
      ledgerMaxBytes: 1024 * 1024,
      bodyTtlMs: 60_000,
      tombstoneTtlMs: 60_000,
      cleanupIntervalMs: 60_000,
      staleTempMs: 100,
      ...options.limits,
    },
  }));
}

async function disposeStore(store: ToolOutputArtifactStore): Promise<void> {
  stores.delete(store);
  await store.dispose();
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for lifecycle condition");
    await Bun.sleep(5);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function writeConfig(homeDir: string): Promise<ServerConfigService> {
  const path = resolveServerConfigPath(homeDir);
  await mkdir(join(homeDir, ".archcode"), { recursive: true });
  const provider = {
    local: {
      npm: "@ai-sdk/openai-compatible",
      name: "Local LLM",
      options: { baseURL: "http://localhost:8090/v1", apiKey: "test-key" },
      models: {
        "test-model": {
          name: "Test Model",
          limit: { context: 128_000, output: 8_192 },
          modalities: { input: ["text"], output: ["text"] },
        },
      },
    },
  };
  const agents = Object.fromEntries(
    ["engineer", "goal_lead", "plan", "build", "reviewer", "explore", "librarian", "shaper"]
      .map((name) => [name, { model: "local:test-model" }]),
  );
  await writeFile(path, JSON.stringify({ provider, agents }));
  return new ServerConfigService({ homeDir });
}

function fakeMcpManager(): McpManager {
  return {
    startBackgroundDiscovery() {},
    async closeAll() { return []; },
    getStatus() { return new Map(); },
    onStatusChange() { return () => undefined; },
  } as unknown as McpManager;
}

async function createRuntime(options: RuntimeTestOptions) {
  return createProductionRuntime(options as Parameters<typeof createProductionRuntime>[0]);
}

afterEach(async () => {
  await Promise.allSettled([...stores].map((store) => store.dispose()));
  stores.clear();
  await Promise.allSettled([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("Tool Output AC-05 lifecycle acceptance", () => {
  test("Project unregister preserves the Session and ref across slug reuse and re-registration", async () => {
    const homeDir = await makeRoot("archcode-output-unregister-home-");
    const originalWorkspace = await makeRoot("archcode-output-unregister-original-");
    const occupyingWorkspace = await makeRoot("archcode-output-unregister-occupier-");
    let artifactStore: ToolOutputArtifactStore | undefined;
    const runtime = await createRuntime({
      configService: await writeConfig(homeDir),
      projectRegistryHomeDir: homeDir,
      toolOutputRootDir: join(homeDir, "tool-output"),
      mcpManagerFactory: () => fakeMcpManager(),
      logger: silentLogger,
      toolOutputStoreFactory: (rootDir) => {
        artifactStore = makeStore(rootDir);
        return artifactStore;
      },
    });

    try {
      const firstRegistration = await runtime.projectRegistry.add({
        workspaceRoot: originalWorkspace,
        name: "Shared Project",
      });
      expect(firstRegistration.slug).toBe("shared-project");
      const session = await runtime.createSession(originalWorkspace, {
        agentName: "engineer",
        title: "Retained Session",
      });
      const canonicalRoot = await realpath(originalWorkspace);
      const expectedIdentity = createHash("sha256").update(canonicalRoot, "utf8").digest("hex");
      const identityBefore = await computeProjectIdentity(originalWorkspace);
      expect(identityBefore).toBe(expectedIdentity);
      if (!artifactStore) throw new Error("Runtime did not initialize the Tool Output store");
      const artifact = await createTestArtifact(artifactStore, {
        owner: {
          projectIdentity: identityBefore,
          rootSessionId: session.sessionId,
          producerSessionId: session.sessionId,
        },
        canonical: "retained artifact body",
      });

      const removed = await runtime.removeProject(firstRegistration.slug);
      expect(removed?.project).toEqual(firstRegistration);
      expect(await runtime.projectRegistry.get(firstRegistration.slug)).toBeUndefined();
      expect((await runtime.getSessionFile(originalWorkspace, session.sessionId)).title)
        .toBe("Retained Session");

      const occupier = await runtime.projectRegistry.add({
        workspaceRoot: occupyingWorkspace,
        name: "Shared Project",
      });
      expect(occupier.slug).toBe(firstRegistration.slug);
      const reRegistered = await runtime.projectRegistry.add({
        workspaceRoot: originalWorkspace,
        name: "Shared Project",
      });
      expect(reRegistered.slug).toBe("shared-project-2");
      expect(await computeProjectIdentity(originalWorkspace)).toBe(identityBefore);

      const page = await runtime.readToolOutput(
        originalWorkspace,
        session.sessionId,
        { outputRef: artifact.outputRef },
      );
      expect(page.records.map((record) => record.text).join(""))
        .toBe("retained artifact body");
      expect((await runtime.getSessionFile(originalWorkspace, session.sessionId)).sessionId)
        .toBe(session.sessionId);
    } finally {
      await runtime.shutdown();
      if (artifactStore) stores.delete(artifactStore);
    }
  });

  test("the periodic cleanup timer expires bodies without a read or manual cleanup call", async () => {
    const root = await makeRoot("archcode-output-periodic-cleanup-");
    const store = makeStore(root, {
      limits: { bodyTtlMs: 20, cleanupIntervalMs: 5 },
    });
    const scope = owner("producer-a");
    const artifact = await createTestArtifact(store, { owner: scope, canonical: "expires by timer" });
    expect((await store.stats()).active).toBe(1);

    await waitFor(async () => (await store.stats()).active === 0);

    await expect(store.read({ ...scope, outputRef: artifact.outputRef })).rejects.toMatchObject({
      code: "TOOL_OUTPUT_EXPIRED",
    });
  });

  test("startup cleanup expires persisted bodies and removes stale redacted temp directories", async () => {
    const root = await makeRoot("archcode-output-startup-cleanup-");
    let now = 0;
    const scope = owner("producer-a");
    const first = makeStore(root, {
      now: () => now,
      limits: { bodyTtlMs: 10, staleTempMs: 5 },
    });
    const artifact = await createTestArtifact(first, { owner: scope, canonical: "startup expiry" });
    await disposeStore(first);

    const staleTemp = join(root, ".tmp-stale-redacted");
    await mkdir(staleTemp);
    await writeFile(join(staleTemp, "body.part"), "[REDACTED]");
    await utimes(staleTemp, new Date(0), new Date(0));
    now = 11;

    const restarted = makeStore(root, {
      now: () => now,
      limits: { bodyTtlMs: 10, staleTempMs: 5 },
    });
    await restarted.ready();

    expect(await pathExists(staleTemp)).toBe(false);
    expect(await restarted.stats()).toMatchObject({ active: 0, tombstones: 1 });
    await expect(restarted.read({ ...scope, outputRef: artifact.outputRef })).rejects.toMatchObject({
      code: "TOOL_OUTPUT_EXPIRED",
    });
  });

  test("quota cleanup protects a producing capture and finalize enforces quota immediately", async () => {
    const root = await makeRoot("archcode-output-producing-quota-");
    const scope = owner("producer-a");
    const store = makeStore(root, { limits: { bodyMaxActive: 1 } });
    const capture = await store.beginCapture({ owner: scope, redactor: identityRedactor() });
    await capture.write(`HEAD\n${"x".repeat(60 * 1024)}\nTAIL`);
    const activeTemp = (await readdir(root)).find((entry) => entry.startsWith(".tmp-"));
    expect(activeTemp).toBeDefined();
    if (!activeTemp) throw new Error("Expected an active capture temp directory");

    const first = await createTestArtifact(store, { owner: scope, canonical: "first body" });
    const second = await createTestArtifact(store, { owner: scope, canonical: "second body" });
    await store.cleanup();

    expect(capture.state).toBe("accepting");
    expect(await pathExists(join(root, activeTemp))).toBe(true);
    await expect(store.read({ ...scope, outputRef: first.outputRef })).rejects.toMatchObject({
      code: "TOOL_OUTPUT_EVICTED",
    });
    const completed = await capture.complete();
    expect(completed.artifactRequired).toBe(true);
    const finalized = await capture.commit(completed);

    expect(capture.state).toBe("finalized");
    expect(await pathExists(join(root, activeTemp))).toBe(false);
    await expect(store.read({ ...scope, outputRef: second.outputRef })).rejects.toMatchObject({
      code: "TOOL_OUTPUT_EVICTED",
    });
    expect((await store.stats()).active).toBe(1);
    expect((await store.read({ ...scope, outputRef: finalized.outputRef })).records.length)
      .toBeGreaterThan(0);
  });

  test("concurrent production capture commits serialize ledger admission", async () => {
    const root = await makeRoot("archcode-output-concurrent-commit-");
    const scope = owner("producer-a");
    const store = makeStore(root, { limits: { ledgerMaxEntries: 1 } });
    const captures = await Promise.all([
      store.beginCapture({ owner: scope, redactor: identityRedactor() }),
      store.beginCapture({ owner: scope, redactor: identityRedactor() }),
    ]);
    await Promise.all(captures.map((capture, index) => (
      capture.write(`${index}:${"x".repeat(60 * 1024)}`)
    )));
    const completed = await Promise.all(captures.map((capture) => capture.complete()));
    expect(completed.every((output) => output.artifactRequired)).toBe(true);

    const results = await Promise.allSettled(
      captures.map((capture, index) => capture.commit(completed[index]!)),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")?.reason).toMatchObject({
      code: "TOOL_OUTPUT_UNAVAILABLE",
    });
    expect(await store.stats()).toMatchObject({ active: 1, tombstones: 0 });
    expect((await readdir(root)).filter((entry) => entry.startsWith(".tmp-"))).toEqual([]);
  });

  test("dispose stops cleanup, aborts the active writer, and releases query leases", async () => {
    const root = await makeRoot("archcode-output-dispose-");
    let now = 0;
    const runner: ArtifactSearchRunner = {
      async search(input) {
        const segment = input.segments[0]!;
        return {
          matches: [{
            segment: segment.kind,
            canonicalStart: segment.canonicalStart,
            canonicalEnd: segment.canonicalStart + 1,
            snippet: "x",
          }],
        };
      },
    };
    const scope = owner("producer-a");
    const store = makeStore(root, {
      now: () => now,
      searchRunner: runner,
      limits: { bodyTtlMs: 10, cleanupIntervalMs: 5 },
    });
    await createTestArtifact(store, { owner: scope, canonical: "first" });
    await createTestArtifact(store, { owner: scope, canonical: "second" });
    const search = await store.search({ ...scope, pattern: "x", limit: 1 });
    expect(search.nextCursor).toBeDefined();
    let markWriterStarted!: () => void;
    let redactorAborted = false;
    const writerStarted = new Promise<void>((resolve) => {
      markWriterStarted = resolve;
    });
    const blockedWriter = new Promise<string>(() => undefined);
    const capture = await store.beginCapture({
      owner: scope,
      redactor: {
        push() {
          markWriterStarted();
          return blockedWriter;
        },
        finish: () => "",
        abort() {
          redactorAborted = true;
        },
      },
    });
    await capture.write("active writer");
    await writerStarted;
    const activeTemp = (await readdir(root)).find((entry) => entry.startsWith(".tmp-"));
    expect(activeTemp).toBeDefined();

    const internals = store as unknown as {
      cleanupTimer?: ReturnType<typeof setInterval>;
      leases: Map<string, unknown>;
      pinnedRefs: Map<OutputRef, number>;
    };
    expect(internals.leases.size).toBe(1);
    expect(internals.pinnedRefs.size).toBe(2);
    await disposeStore(store);

    expect(capture.state).toBe("aborted");
    expect(capture.signal.aborted).toBe(true);
    expect(redactorAborted).toBe(true);
    expect(internals.cleanupTimer).toBeUndefined();
    expect(internals.leases.size).toBe(0);
    expect(internals.pinnedRefs.size).toBe(0);
    if (activeTemp) expect(await pathExists(join(root, activeTemp))).toBe(false);

    now = 100;
    await Bun.sleep(25);
    expect((await readdir(join(root, "artifacts"))).length).toBe(2);

    const restarted = makeStore(root, {
      now: () => 0,
      searchRunner: runner,
      limits: { bodyTtlMs: 10 },
    });
    await expect(restarted.search({
      ...scope,
      pattern: "x",
      cursor: search.nextCursor,
      limit: 1,
    })).rejects.toMatchObject({ code: "TOOL_OUTPUT_INVALID_CURSOR" });
  });

  test("child-subtree deletion preserves siblings and root-family deletion removes the rest", async () => {
    const root = await makeRoot("archcode-output-family-delete-");
    const store = makeStore(root);
    const scope = owner("root", "family-a");
    const rootArtifact = await createTestArtifact(store, { owner: scope, canonical: "root" });
    const childArtifact = await createTestArtifact(store, {
      owner: { ...scope, producerSessionId: "child" },
      canonical: "child",
    });
    const grandchildArtifact = await createTestArtifact(store, {
      owner: { ...scope, producerSessionId: "grandchild" },
      canonical: "grandchild",
    });
    const siblingArtifact = await createTestArtifact(store, {
      owner: { ...scope, producerSessionId: "sibling" },
      canonical: "sibling",
    });
    const otherFamily = owner("other-root", "family-b");
    const otherArtifact = await createTestArtifact(store, {
      owner: otherFamily,
      canonical: "other family",
    });

    expect(await store.deleteProducerSessions(scope, new Set(["child", "grandchild"]))).toBe(2);
    for (const outputRef of [childArtifact.outputRef, grandchildArtifact.outputRef]) {
      await expect(store.read({ ...scope, outputRef })).rejects.toMatchObject({
        code: "TOOL_OUTPUT_NOT_FOUND",
      });
    }
    expect((await store.read({ ...scope, outputRef: rootArtifact.outputRef })).records[0]?.text)
      .toBe("root");
    expect((await store.read({ ...scope, outputRef: siblingArtifact.outputRef })).records[0]?.text)
      .toBe("sibling");

    expect(await store.deleteRootFamily(scope)).toBe(2);
    for (const outputRef of [rootArtifact.outputRef, siblingArtifact.outputRef]) {
      await expect(store.read({ ...scope, outputRef })).rejects.toMatchObject({
        code: "TOOL_OUTPUT_NOT_FOUND",
      });
    }
    expect((await store.read({ ...otherFamily, outputRef: otherArtifact.outputRef })).records[0]?.text)
      .toBe("other family");
  });
});
