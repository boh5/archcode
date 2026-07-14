import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { silentLogger } from "../logger";
import { createProcessRunner } from "../process/runner";
import type { ProcessRunner } from "../process/types";
import { SessionCwdPathBarrierError, SessionCwdReferenceScanError } from "../store/errors";
import { SessionStoreManager } from "../store/session-store-manager";
import { getSessionDir, getSessionPath } from "../store/sessions-dir";
import { createTestTempRoot } from "../testing/test-temp-root";
import { WorktreeService } from "../worktrees";
import { SessionCwdReferenceMigrationService } from "./session-cwd-reference-migration";

const testTempRoot = createTestTempRoot("session-cwd-reference-migration");
let TMP_DIR = testTempRoot.path;
let PROJECT_ROOT = join(TMP_DIR, "project");
let WORKTREE_ROOT = join(TMP_DIR, "project.worktrees", "loop-retry");

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(testTempRoot.path, { recursive: true });
  TMP_DIR = await realpath(testTempRoot.path);
  PROJECT_ROOT = join(TMP_DIR, "project");
  WORKTREE_ROOT = join(TMP_DIR, "project.worktrees", "loop-retry");
  await mkdir(PROJECT_ROOT, { recursive: true });
  await mkdir(WORKTREE_ROOT, { recursive: true });
});

afterAll(async () => {
  await testTempRoot.cleanup().catch(() => {});
});

describe("SessionCwdReferenceMigrationService", () => {
  test("real worktree removal migrates crash-old and retry-new Sessions before Git cleanup", async () => {
    await initializeGitRepo(PROJECT_ROOT);
    const worktrees = new WorktreeService({ canonicalRoot: PROJECT_ROOT });
    const created = await worktrees.create({
      owner: { type: "session", id: "crash-retry-e2e" },
      label: "cleanup",
      uniqueId: "crash-retry-job-123456",
    });
    const writer = new SessionStoreManager({ logger: silentLogger });
    const oldSessionId = crypto.randomUUID();
    const retrySessionId = crypto.randomUUID();
    await persistAtCwd(writer, oldSessionId, created.worktreePath);
    await persistAtCwd(writer, retrySessionId, created.worktreePath);
    const stores = new SessionStoreManager({ logger: silentLogger });
    const migration = new SessionCwdReferenceMigrationService({
      storeManager: stores,
      acquireIdleSessionFamilyCwdTransitions: () => () => undefined,
    });

    const result = await migration.migrateForRemoval({
      projectRoot: PROJECT_ROOT,
      fromCwd: created.worktreePath,
      toCwd: PROJECT_ROOT,
    }, async (lifecycle) => ({
      removed: (await worktrees.remove({
        path: created.worktreePath,
        branchName: created.branchName,
        baseSha: created.baseSha,
        ...lifecycle,
      })).detached,
    }));

    expect(result.removed).toBe(true);
    expect(await pathExists(created.worktreePath)).toBe(false);
    const observer = new SessionStoreManager({ logger: silentLogger });
    expect((await observer.getSessionFile(PROJECT_ROOT, oldSessionId)).cwd).toBe(PROJECT_ROOT);
    expect((await observer.getSessionFile(PROJECT_ROOT, retrySessionId)).cwd).toBe(PROJECT_ROOT);
  });

  test("pre-detach failure capability rolls Sessions back while the worktree lifecycle lock is owned", async () => {
    await initializeGitRepo(PROJECT_ROOT);
    const worktrees = new WorktreeService({ canonicalRoot: PROJECT_ROOT });
    const created = await worktrees.create({
      owner: { type: "session", id: "rollback-e2e" },
      label: "cleanup",
      uniqueId: "rollback-job-123456",
    });
    const stores = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();
    await persistAtCwd(stores, sessionId, created.worktreePath);
    const migration = new SessionCwdReferenceMigrationService({
      storeManager: stores,
      acquireIdleSessionFamilyCwdTransitions: () => () => undefined,
    });

    await expect(migration.migrateForRemoval({
      projectRoot: PROJECT_ROOT,
      fromCwd: created.worktreePath,
      toCwd: PROJECT_ROOT,
    }, async (lifecycle) => {
      await lifecycle.beforeRemove();
      await lifecycle.onRemoveFailureBeforeDetach();
      throw new Error("simulated Git removal failure");
    })).rejects.toThrow("simulated Git removal failure");

    expect((await stores.getSessionFile(PROJECT_ROOT, sessionId)).cwd).toBe(created.worktreePath);
    expect(await pathExists(created.worktreePath)).toBe(true);
    expect(await worktrees.validate(created.worktreePath)).toMatchObject({ branchName: created.branchName });
  });

  test("real git detach failure rolls Session migration back through the in-lock failure capability", async () => {
    await initializeGitRepo(PROJECT_ROOT);
    const creator = new WorktreeService({ canonicalRoot: PROJECT_ROOT });
    const created = await creator.create({
      owner: { type: "session", id: "detach-failure-e2e" },
      uniqueId: "detach-failure-job-123456",
    });
    const delegate = createProcessRunner();
    const runner: ProcessRunner = {
      async run(input) {
        if (input.argv[0] === "git" && input.argv[1] === "worktree" && input.argv[2] === "remove") {
          return await delegate.run({
            ...input,
            argv: ["git", "worktree", "remove", join(TMP_DIR, "missing-worktree")],
          });
        }
        return await delegate.run(input);
      },
    };
    const remover = new WorktreeService({ canonicalRoot: PROJECT_ROOT, git: runner });
    const stores = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();
    await persistAtCwd(stores, sessionId, created.worktreePath);
    const migration = new SessionCwdReferenceMigrationService({
      storeManager: stores,
      acquireIdleSessionFamilyCwdTransitions: () => () => undefined,
    });

    await expect(migration.migrateForRemoval({
      projectRoot: PROJECT_ROOT,
      fromCwd: created.worktreePath,
      toCwd: PROJECT_ROOT,
    }, async (lifecycle) => ({
      removed: (await remover.remove({
        path: created.worktreePath,
        branchName: created.branchName,
        baseSha: created.baseSha,
        ...lifecycle,
      })).detached,
    }))).rejects.toMatchObject({ code: "GIT_COMMAND_FAILED" });
    expect((await stores.getSessionFile(PROJECT_ROOT, sessionId)).cwd).toBe(created.worktreePath);
    expect(await pathExists(created.worktreePath)).toBe(true);
  });

  test("branch deletion failure after detach keeps Session cwd canonical", async () => {
    await initializeGitRepo(PROJECT_ROOT);
    const creator = new WorktreeService({ canonicalRoot: PROJECT_ROOT });
    const created = await creator.create({
      owner: { type: "session", id: "branch-delete-failure-e2e" },
      uniqueId: "branch-delete-failure-job-123456",
    });
    await git(PROJECT_ROOT, ["commit", "--allow-empty", "-m", "advance canonical"]);
    const advancedSha = await git(PROJECT_ROOT, ["rev-parse", "HEAD"]);
    const delegate = createProcessRunner();
    let advanced = false;
    const runner: ProcessRunner = {
      async run(input) {
        if (!advanced && input.argv[0] === "git" && input.argv[1] === "worktree" && input.argv[2] === "remove") {
          advanced = true;
          await git(PROJECT_ROOT, ["update-ref", `refs/heads/${created.branchName}`, advancedSha, created.baseSha]);
        }
        return await delegate.run(input);
      },
    };
    const remover = new WorktreeService({ canonicalRoot: PROJECT_ROOT, git: runner });
    const stores = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();
    await persistAtCwd(stores, sessionId, created.worktreePath);
    const migration = new SessionCwdReferenceMigrationService({
      storeManager: stores,
      acquireIdleSessionFamilyCwdTransitions: () => () => undefined,
    });

    const result = await migration.migrateForRemoval({
      projectRoot: PROJECT_ROOT,
      fromCwd: created.worktreePath,
      toCwd: PROJECT_ROOT,
    }, async (lifecycle) => ({
      removed: (await remover.remove({
        path: created.worktreePath,
        branchName: created.branchName,
        baseSha: created.baseSha,
        ...lifecycle,
      })).detached,
    }));

    expect(result.removed).toBe(true);
    expect(await pathExists(created.worktreePath)).toBe(false);
    expect((await stores.getSessionFile(PROJECT_ROOT, sessionId)).cwd).toBe(PROJECT_ROOT);
    expect(await git(PROJECT_ROOT, ["rev-parse", `refs/heads/${created.branchName}`])).toBe(advancedSha);
  });

  test("cold-start cleanup migrates every old and retried Session reference before removal", async () => {
    const writer = new SessionStoreManager({ logger: silentLogger });
    const oldRootId = crypto.randomUUID();
    const oldChildId = crypto.randomUUID();
    const retryRootId = crypto.randomUUID();
    await persistAtCwd(writer, oldRootId, WORKTREE_ROOT);
    await persistAtCwd(writer, oldChildId, WORKTREE_ROOT, {
      rootSessionId: oldRootId,
      parentSessionId: oldRootId,
    });
    await persistAtCwd(writer, retryRootId, WORKTREE_ROOT);

    const stores = new SessionStoreManager({ logger: silentLogger });
    const releasedAgents: string[] = [];
    const leaseEvents: string[] = [];
    let familyLeaseHeld = false;
    const acquireFamilies = mock((_projectRoot: string, rootSessionIds: readonly string[]) => {
      expect(rootSessionIds).toEqual([oldRootId, retryRootId].sort());
      familyLeaseHeld = true;
      leaseEvents.push("acquire");
      return () => {
        leaseEvents.push("release");
        familyLeaseHeld = false;
      };
    });
    const migration = new SessionCwdReferenceMigrationService({
      storeManager: stores,
      acquireIdleSessionFamilyCwdTransitions: acquireFamilies,
      releaseSessionAgent: (_projectRoot, sessionId) => releasedAgents.push(sessionId),
    });

    const result = await migration.migrateForRemoval({
      projectRoot: PROJECT_ROOT,
      fromCwd: WORKTREE_ROOT,
      toCwd: PROJECT_ROOT,
    }, async (lifecycle) => {
      expect(familyLeaseHeld).toBe(true);
      await lifecycle.beforeRemove();
      expect(familyLeaseHeld).toBe(true);
      expect(() => stores.create(crypto.randomUUID(), PROJECT_ROOT, { cwd: WORKTREE_ROOT, agentName: "engineer" }))
        .toThrow(SessionCwdPathBarrierError);
      const observer = new SessionStoreManager({ logger: silentLogger });
      for (const sessionId of [oldRootId, oldChildId, retryRootId]) {
        expect((await observer.getSessionFile(PROJECT_ROOT, sessionId)).cwd).toBe(PROJECT_ROOT);
      }
      await lifecycle.onRemoveDetached();
      return { removed: true, marker: "removed" as const };
    });

    expect(result).toEqual({ removed: true, marker: "removed" });
    expect(leaseEvents).toEqual(["acquire", "release"]);
    expect(releasedAgents.sort()).toEqual([oldRootId, oldChildId, retryRootId].sort());
    expect(stores.create(crypto.randomUUID(), PROJECT_ROOT, { cwd: WORKTREE_ROOT, agentName: "engineer" }).getState().cwd).toBe(WORKTREE_ROOT);
  });

  test("rolls every migrated Session back when removal fails while the worktree still exists", async () => {
    const stores = new SessionStoreManager({ logger: silentLogger });
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    await persistAtCwd(stores, firstId, WORKTREE_ROOT);
    await persistAtCwd(stores, secondId, WORKTREE_ROOT);
    const releaseFamilies = mock(() => undefined);
    const migration = new SessionCwdReferenceMigrationService({
      storeManager: stores,
      acquireIdleSessionFamilyCwdTransitions: () => releaseFamilies,
    });

    await expect(migration.migrateForRemoval({
      projectRoot: PROJECT_ROOT,
      fromCwd: WORKTREE_ROOT,
      toCwd: PROJECT_ROOT,
    }, async (lifecycle) => {
      await lifecycle.beforeRemove();
      await lifecycle.onRemoveFailureBeforeDetach();
      throw new Error("git worktree remove failed");
    })).rejects.toThrow("git worktree remove failed");

    expect(releaseFamilies).toHaveBeenCalledTimes(1);
    expect((await stores.getSessionFile(PROJECT_ROOT, firstId)).cwd).toBe(WORKTREE_ROOT);
    expect((await stores.getSessionFile(PROJECT_ROOT, secondId)).cwd).toBe(WORKTREE_ROOT);
  });

  test("does not roll back to a reused path when failure omits both lifecycle outcomes", async () => {
    const stores = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();
    await persistAtCwd(stores, sessionId, WORKTREE_ROOT);
    const migration = new SessionCwdReferenceMigrationService({
      storeManager: stores,
      acquireIdleSessionFamilyCwdTransitions: () => () => undefined,
    });

    await expect(migration.migrateForRemoval({
      projectRoot: PROJECT_ROOT,
      fromCwd: WORKTREE_ROOT,
      toCwd: PROJECT_ROOT,
    }, async (lifecycle) => {
      await lifecycle.beforeRemove();
      await rm(WORKTREE_ROOT, { recursive: true, force: true });
      await mkdir(WORKTREE_ROOT, { recursive: true });
      await writeFile(join(WORKTREE_ROOT, "replacement.txt"), "different checkout identity\n");
      throw new Error("remove failed after unregistering the worktree");
    })).rejects.toThrow("contract violated");

    expect((await stores.getSessionFile(PROJECT_ROOT, sessionId)).cwd).toBe(PROJECT_ROOT);
    expect(await Bun.file(join(WORKTREE_ROOT, "replacement.txt")).text()).toBe("different checkout identity\n");
  });

  test("rolls back an earlier CAS when a later Session migration fails before removal", async () => {
    const stores = new SessionStoreManager({ logger: silentLogger });
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    await persistAtCwd(stores, firstId, WORKTREE_ROOT);
    await persistAtCwd(stores, secondId, WORKTREE_ROOT);
    const originalUpdate = stores.updateCwdForMigration.bind(stores);
    let updateCount = 0;
    stores.updateCwdForMigration = async (...args: Parameters<SessionStoreManager["updateCwdForMigration"]>) => {
      updateCount += 1;
      if (updateCount === 2) throw new Error("second Session CAS failed");
      return await originalUpdate(...args);
    };
    let removeStarted = false;
    const migration = new SessionCwdReferenceMigrationService({
      storeManager: stores,
      acquireIdleSessionFamilyCwdTransitions: () => () => undefined,
    });

    await expect(migration.migrateForRemoval({
      projectRoot: PROJECT_ROOT,
      fromCwd: WORKTREE_ROOT,
      toCwd: PROJECT_ROOT,
    }, async (lifecycle) => {
      await lifecycle.beforeRemove();
      removeStarted = true;
      await lifecycle.onRemoveDetached();
      return { removed: true };
    })).rejects.toThrow("second Session CAS failed");

    expect(removeStarted).toBe(false);
    expect((await stores.getSessionFile(PROJECT_ROOT, firstId)).cwd).toBe(WORKTREE_ROOT);
    expect((await stores.getSessionFile(PROJECT_ROOT, secondId)).cwd).toBe(WORKTREE_ROOT);
  });

  test("fails closed before leasing or removal when any persisted Session file is invalid", async () => {
    const stores = new SessionStoreManager({ logger: silentLogger });
    const validId = crypto.randomUUID();
    const invalidId = crypto.randomUUID();
    await persistAtCwd(stores, validId, WORKTREE_ROOT);
    await mkdir(join(PROJECT_ROOT, ".archcode", "sessions", invalidId), { recursive: true });
    await Bun.write(getSessionPath(PROJECT_ROOT, invalidId), "{ definitely-not-json");
    const acquireFamilies = mock(() => () => undefined);
    const operation = mock(async () => ({ removed: true }));
    const migration = new SessionCwdReferenceMigrationService({
      storeManager: stores,
      acquireIdleSessionFamilyCwdTransitions: acquireFamilies,
    });

    await expect(migration.migrateForRemoval({
      projectRoot: PROJECT_ROOT,
      fromCwd: WORKTREE_ROOT,
      toCwd: PROJECT_ROOT,
    }, operation)).rejects.toBeInstanceOf(SessionCwdReferenceScanError);

    expect(acquireFamilies).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
    expect((await stores.getSessionFile(PROJECT_ROOT, validId)).cwd).toBe(WORKTREE_ROOT);
  });

  test("fails closed when one referenced root family is active and releases earlier family leases", async () => {
    const stores = new SessionStoreManager({ logger: silentLogger });
    const firstRoot = crypto.randomUUID();
    const activeRoot = crypto.randomUUID();
    await persistAtCwd(stores, firstRoot, WORKTREE_ROOT);
    await persistAtCwd(stores, activeRoot, WORKTREE_ROOT);
    const operation = mock(async () => ({ removed: true }));
    const migration = new SessionCwdReferenceMigrationService({
      storeManager: stores,
      acquireIdleSessionFamilyCwdTransitions: () => {
        throw new Error("Session family is active");
      },
    });

    await expect(migration.migrateForRemoval({
      projectRoot: PROJECT_ROOT,
      fromCwd: WORKTREE_ROOT,
      toCwd: PROJECT_ROOT,
    }, operation)).rejects.toThrow("Session family is active");

    expect(operation).not.toHaveBeenCalled();
    expect((await stores.getSessionFile(PROJECT_ROOT, firstRoot)).cwd).toBe(WORKTREE_ROOT);
    expect((await stores.getSessionFile(PROJECT_ROOT, activeRoot)).cwd).toBe(WORKTREE_ROOT);
  });

  test("final rescan migrates a newly persisted reference in an already leased root family", async () => {
    const stores = new SessionStoreManager({ logger: silentLogger });
    const rootId = crypto.randomUUID();
    const lateChildId = crypto.randomUUID();
    await persistAtCwd(stores, rootId, WORKTREE_ROOT);
    const migration = new SessionCwdReferenceMigrationService({
      storeManager: stores,
      acquireIdleSessionFamilyCwdTransitions: (_projectRoot, rootSessionIds) => {
        expect(rootSessionIds).toEqual([rootId]);
        return () => undefined;
      },
    });

    await migration.migrateForRemoval({
      projectRoot: PROJECT_ROOT,
      fromCwd: WORKTREE_ROOT,
      toCwd: PROJECT_ROOT,
    }, async (lifecycle) => {
      const externalWriter = new SessionStoreManager({ logger: silentLogger });
      await persistAtCwd(externalWriter, lateChildId, WORKTREE_ROOT, {
        rootSessionId: rootId,
        parentSessionId: rootId,
      });
      await lifecycle.beforeRemove();
      await lifecycle.onRemoveDetached();
      return { removed: true };
    });

    const observer = new SessionStoreManager({ logger: silentLogger });
    expect((await observer.getSessionFile(PROJECT_ROOT, rootId)).cwd).toBe(PROJECT_ROOT);
    expect((await observer.getSessionFile(PROJECT_ROOT, lateChildId)).cwd).toBe(PROJECT_ROOT);
  });

  test("final rescan fails closed when a new unleased root family appears", async () => {
    const stores = new SessionStoreManager({ logger: silentLogger });
    const rootId = crypto.randomUUID();
    const lateRootId = crypto.randomUUID();
    await persistAtCwd(stores, rootId, WORKTREE_ROOT);
    let removeStarted = false;
    const migration = new SessionCwdReferenceMigrationService({
      storeManager: stores,
      acquireIdleSessionFamilyCwdTransitions: () => () => undefined,
    });

    await expect(migration.migrateForRemoval({
      projectRoot: PROJECT_ROOT,
      fromCwd: WORKTREE_ROOT,
      toCwd: PROJECT_ROOT,
    }, async (lifecycle) => {
      const externalWriter = new SessionStoreManager({ logger: silentLogger });
      await persistAtCwd(externalWriter, lateRootId, WORKTREE_ROOT);
      await lifecycle.beforeRemove();
      removeStarted = true;
      await lifecycle.onRemoveDetached();
      return { removed: true };
    })).rejects.toThrow("New Session root families appeared");

    expect(removeStarted).toBe(false);
    expect((await stores.getSessionFile(PROJECT_ROOT, rootId)).cwd).toBe(WORKTREE_ROOT);
    expect((await stores.getSessionFile(PROJECT_ROOT, lateRootId)).cwd).toBe(WORKTREE_ROOT);
  });

  test("rejects a removal result that bypasses the before-remove capability", async () => {
    const stores = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();
    await persistAtCwd(stores, sessionId, WORKTREE_ROOT);
    const migration = new SessionCwdReferenceMigrationService({
      storeManager: stores,
      acquireIdleSessionFamilyCwdTransitions: () => () => undefined,
    });

    await expect(migration.migrateForRemoval({
      projectRoot: PROJECT_ROOT,
      fromCwd: WORKTREE_ROOT,
      toCwd: PROJECT_ROOT,
    }, async () => ({ removed: true }))).rejects.toThrow("without invoking");

    expect((await stores.getSessionFile(PROJECT_ROOT, sessionId)).cwd).toBe(WORKTREE_ROOT);
  });

  test("strict scan includes a live-only Session and flushes pending persistence", async () => {
    const stores = new SessionStoreManager({ logger: silentLogger });
    const liveOnlyId = crypto.randomUUID();
    const pendingId = crypto.randomUUID();
    await persistAtCwd(stores, liveOnlyId, WORKTREE_ROOT);
    await rm(getSessionDir(PROJECT_ROOT, liveOnlyId), { recursive: true, force: true });
    const pending = stores.create(pendingId, PROJECT_ROOT, { cwd: WORKTREE_ROOT, agentName: "engineer" });
    pending.getState().setTitle("pending persistence must settle");

    const references = await stores.scanCwdReferencesStrict(PROJECT_ROOT, WORKTREE_ROOT);

    expect(references.map((reference) => reference.sessionId).sort()).toEqual([liveOnlyId, pendingId].sort());
    expect(JSON.parse(await Bun.file(getSessionPath(PROJECT_ROOT, pendingId)).text())).toMatchObject({
      cwd: WORKTREE_ROOT,
      title: "pending persistence must settle",
    });
  });

  test("uses each scanned cwd spelling as the CAS expectation", async () => {
    const stores = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();
    const equivalentSpelling = `${join(TMP_DIR, "project.worktrees", "alias")}/../loop-retry`;
    await persistAtCwd(stores, sessionId, equivalentSpelling);
    const migration = new SessionCwdReferenceMigrationService({
      storeManager: stores,
      acquireIdleSessionFamilyCwdTransitions: () => () => undefined,
    });

    await migration.migrateForRemoval({
      projectRoot: PROJECT_ROOT,
      fromCwd: WORKTREE_ROOT,
      toCwd: PROJECT_ROOT,
    }, async (lifecycle) => {
      await lifecycle.beforeRemove();
      await lifecycle.onRemoveDetached();
      return { removed: true };
    });

    expect((await stores.getSessionFile(PROJECT_ROOT, sessionId)).cwd).toBe(PROJECT_ROOT);
  });

  test("path barrier rejects new references but permits capability-owned CAS and becomes stale on release", async () => {
    const stores = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();
    await persistAtCwd(stores, sessionId, WORKTREE_ROOT);
    const barrier = stores.acquireCwdPathBarrier(WORKTREE_ROOT);

    expect(() => stores.create(crypto.randomUUID(), PROJECT_ROOT, { cwd: WORKTREE_ROOT, agentName: "engineer" }))
      .toThrow(SessionCwdPathBarrierError);
    await expect(stores.updateCwd(crypto.randomUUID(), PROJECT_ROOT, WORKTREE_ROOT))
      .rejects.toBeInstanceOf(SessionCwdPathBarrierError);
    await stores.updateCwdForMigration(sessionId, PROJECT_ROOT, PROJECT_ROOT, WORKTREE_ROOT, barrier);
    await stores.updateCwdForMigration(sessionId, PROJECT_ROOT, WORKTREE_ROOT, PROJECT_ROOT, barrier);
    barrier.release();

    await expect(stores.updateCwdForMigration(sessionId, PROJECT_ROOT, PROJECT_ROOT, WORKTREE_ROOT, barrier))
      .rejects.toBeInstanceOf(SessionCwdPathBarrierError);
  });

  test("restart rolls a durably migrated Session back when the worktree is preserved", async () => {
    const writer = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();
    await persistAtCwd(writer, sessionId, WORKTREE_ROOT);
    await writer.updateCwd(sessionId, PROJECT_ROOT, PROJECT_ROOT, WORKTREE_ROOT);
    const migration = new SessionCwdReferenceMigrationService({
      storeManager: new SessionStoreManager({ logger: silentLogger }),
      acquireIdleSessionFamilyCwdTransitions: () => () => undefined,
    });
    const input = { projectRoot: PROJECT_ROOT, fromCwd: WORKTREE_ROOT, toCwd: PROJECT_ROOT };
    const journalPath = await migration.__journalPathForTest(input);
    await mkdir(dirname(journalPath), { recursive: true });
    await Bun.write(journalPath, `${JSON.stringify({
      version: 1,
      projectRoot: PROJECT_ROOT,
      fromCwd: WORKTREE_ROOT,
      toCwd: PROJECT_ROOT,
      phase: "migrated",
      references: [{ sessionId, rootSessionId: sessionId, cwd: WORKTREE_ROOT }],
    })}\n`);

    const result = await migration.migrateForRemoval(input, async () => ({ removed: false }));

    expect(result.removed).toBe(false);
    expect((await new SessionStoreManager({ logger: silentLogger }).getSessionFile(PROJECT_ROOT, sessionId)).cwd).toBe(WORKTREE_ROOT);
    expect(await Bun.file(journalPath).exists()).toBe(false);
  });
});

async function persistAtCwd(
  manager: SessionStoreManager,
  sessionId: string,
  cwd: string,
  identity: { readonly rootSessionId?: string; readonly parentSessionId?: string } = {},
): Promise<void> {
  manager.create(sessionId, PROJECT_ROOT, { ...identity, agentName: "engineer" });
  await manager.updateCwd(sessionId, PROJECT_ROOT, cwd, PROJECT_ROOT);
}

async function initializeGitRepo(cwd: string): Promise<void> {
  await git(cwd, ["init", "--initial-branch=main"]);
  await git(cwd, ["config", "user.email", "session-migration@example.test"]);
  await git(cwd, ["config", "user.name", "Session Migration Test"]);
  await writeFile(join(cwd, "README.md"), "# session migration\n");
  await git(cwd, ["add", "README.md"]);
  await git(cwd, ["commit", "-m", "initial commit"]);
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
