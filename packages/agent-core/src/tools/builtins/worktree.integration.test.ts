import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { access, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { SkillService } from "../../skills";
import { SessionStoreManager } from "../../store/session-store-manager";
import { silentLogger } from "../../logger";
import { SessionCwdTransitionConflictError } from "../../agents/errors";
import { WorktreeService } from "../../worktrees";
import { createTestProjectContext } from "../test-project-context";
import { expectTextDraft } from "../test-results";
import { createToolExecutionContext } from "../types";
import {
  executeWorktreeEnter,
  executeWorktreeExit,
} from "./worktree";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "worktree-tool", crypto.randomUUID());

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

describe("worktree Session tools", () => {
  test("enters a managed worktree, persists Session.cwd canonically, then exits without removing it", async () => {
    const projectRoot = await createGitRepo("enter-exit");
    const manager = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();
    const store = manager.create(sessionId, projectRoot, { agentName: "lead" });
    const ctx = createToolExecutionContext({
      store,
      storeManager: manager,
      toolName: "worktree_enter",
      toolCallId: "enter-1",
      input: {},
      step: 0,
      abort: new AbortController().signal,
      startedAt: Date.now(),
      allowedTools: new Set(["worktree_enter"]),
      agentSkills: [],
      skillService: new SkillService({ builtinSkills: {} }),
      projectContext: createTestProjectContext(projectRoot),
      cwd: projectRoot,
      agentName: "lead",
      currentDepth: 0,
      acquireSessionCwdTransition: () => () => undefined,
    });

    const entered = await executeWorktreeEnter({ name: "feature" }, ctx);
    if (typeof entered === "string") throw new Error("Expected structured enter result");
    const worktreeCwd = store.getState().cwd;

    expect(entered.isError).toBe(false);
    expect(worktreeCwd).not.toBe(projectRoot);
    expect(await Bun.file(join(worktreeCwd, "README.md")).exists()).toBe(true);
    expect((await manager.getSessionFile(projectRoot, sessionId)).cwd).toBe(worktreeCwd);
    expect(await Bun.file(join(worktreeCwd, ".archcode", "sessions", sessionId, "session.json")).exists()).toBe(false);

    const exited = await executeWorktreeExit({}, { ...ctx, toolName: "worktree_exit", cwd: worktreeCwd });
    if (typeof exited === "string") throw new Error("Expected structured exit result");
    expect(exited.isError).toBe(false);
    expect(store.getState().cwd).toBe(projectRoot);
    await access(worktreeCwd);

    const reentered = await executeWorktreeEnter({}, ctx);
    if (typeof reentered === "string") throw new Error("Expected structured re-enter result");
    expect(reentered.isError).toBe(false);
    expect(store.getState().cwd).toBe(worktreeCwd);
    expect(JSON.parse(expectTextDraft(reentered))).toMatchObject({ cwd: worktreeCwd, created: false });
  });

  test("fails closed before creating a worktree when a descendant execution is active", async () => {
    const projectRoot = await createGitRepo("active-descendant");
    const manager = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();
    const childSessionId = crypto.randomUUID();
    const store = manager.create(sessionId, projectRoot, { agentName: "lead" });
    const ctx = createToolExecutionContext({
      store,
      storeManager: manager,
      toolName: "worktree_enter",
      toolCallId: "enter-active-descendant",
      input: {},
      step: 0,
      abort: new AbortController().signal,
      startedAt: Date.now(),
      allowedTools: new Set(["worktree_enter"]),
      agentSkills: [],
      skillService: new SkillService({ builtinSkills: {} }),
      projectContext: createTestProjectContext(projectRoot),
      cwd: projectRoot,
      agentName: "lead",
      currentDepth: 0,
      acquireSessionCwdTransition: () => {
        throw new SessionCwdTransitionConflictError(sessionId, [childSessionId]);
      },
    });

    const result = await executeWorktreeEnter({}, ctx);

    if (typeof result === "string") throw new Error("Expected structured error result");
    expect(result).toMatchObject({
      isError: true,
      details: { error: { code: "WORKTREE_ACTIVE_DESCENDANTS" } },
    });
    expect(store.getState().cwd).toBe(projectRoot);
    expect(await new WorktreeService({ canonicalRoot: projectRoot }).findManaged({ owner: { id: sessionId } })).toBeUndefined();
  });

  test("rejects an explicit canonical target without changing Session cwd", async () => {
    const projectRoot = await createGitRepo("canonical-target");
    const manager = new SessionStoreManager({ logger: silentLogger });
    const store = manager.create(crypto.randomUUID(), projectRoot, { agentName: "lead" });
    const ctx = createToolExecutionContext({
      store,
      storeManager: manager,
      toolName: "worktree_enter",
      toolCallId: "enter-canonical",
      input: { path: projectRoot },
      step: 0,
      abort: new AbortController().signal,
      startedAt: Date.now(),
      allowedTools: new Set(["worktree_enter"]),
      agentSkills: [],
      skillService: new SkillService({ builtinSkills: {} }),
      projectContext: createTestProjectContext(projectRoot),
      cwd: projectRoot,
      agentName: "lead",
      currentDepth: 0,
      acquireSessionCwdTransition: () => () => undefined,
    });

    const result = await executeWorktreeEnter({ path: projectRoot }, ctx);

    if (typeof result === "string") throw new Error("Expected structured error result");
    expect(result).toMatchObject({ isError: true, details: { error: { code: "WORKTREE_TARGET_IS_PROJECT" } } });
    expect(store.getState().cwd).toBe(projectRoot);
  });

  test("rejects a symlink alias of the canonical project target", async () => {
    const realProjectRoot = await createGitRepo("canonical-target-real");
    const projectRoot = resolve(TMP_DIR, "canonical-target-alias");
    await symlink(realProjectRoot, projectRoot, "dir");
    const manager = new SessionStoreManager({ logger: silentLogger });
    const store = manager.create(crypto.randomUUID(), projectRoot, { agentName: "lead" });
    const ctx = createToolExecutionContext({
      store,
      storeManager: manager,
      toolName: "worktree_enter",
      toolCallId: "enter-canonical-alias",
      input: { path: projectRoot },
      step: 0,
      abort: new AbortController().signal,
      startedAt: Date.now(),
      allowedTools: new Set(["worktree_enter"]),
      agentSkills: [],
      skillService: new SkillService({ builtinSkills: {} }),
      projectContext: createTestProjectContext(projectRoot),
      cwd: projectRoot,
      agentName: "lead",
      currentDepth: 0,
      acquireSessionCwdTransition: () => () => undefined,
    });

    const result = await executeWorktreeEnter({ path: projectRoot }, ctx);

    if (typeof result === "string") throw new Error("Expected structured error result");
    expect(result).toMatchObject({ isError: true, details: { error: { code: "WORKTREE_TARGET_IS_PROJECT" } } });
    expect(store.getState().cwd).toBe(projectRoot);
  });

  test("rejects explicit foreign ArchCode-managed Session worktrees", async () => {
    const projectRoot = await createGitRepo("reject-foreign-managed-targets");
    const manager = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();
    const store = manager.create(sessionId, projectRoot, { agentName: "lead" });
    const ctx = createToolExecutionContext({
      store,
      storeManager: manager,
      toolName: "worktree_enter",
      toolCallId: "enter-foreign-managed",
      input: {},
      step: 0,
      abort: new AbortController().signal,
      startedAt: Date.now(),
      allowedTools: new Set(["worktree_enter"]),
      agentSkills: [],
      skillService: new SkillService({ builtinSkills: {} }),
      projectContext: createTestProjectContext(projectRoot),
      cwd: projectRoot,
      agentName: "lead",
      currentDepth: 0,
      acquireSessionCwdTransition: () => () => undefined,
    });
    const service = new WorktreeService({ canonicalRoot: projectRoot });
    const foreignTargets = await Promise.all([
      service.create({ owner: { id: crypto.randomUUID() } }),
      service.create({ owner: { id: crypto.randomUUID() }, uniqueId: crypto.randomUUID() }),
      service.create({ owner: { id: crypto.randomUUID() } }),
    ]);

    for (const target of foreignTargets) {
      const result = await executeWorktreeEnter({ path: target.worktreePath }, ctx);

      if (typeof result === "string") throw new Error("Expected structured error result");
      expect(result).toMatchObject({
        isError: true,
        details: { error: { code: "WORKTREE_TARGET_NOT_OWNED" } },
      });
      expect(store.getState().cwd).toBe(projectRoot);
    }
  });

  test("allows the Session's deterministic managed worktree by explicit path", async () => {
    const projectRoot = await createGitRepo("allow-own-managed-target");
    const manager = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();
    const store = manager.create(sessionId, projectRoot, { agentName: "lead" });
    const own = await new WorktreeService({ canonicalRoot: projectRoot }).create({
      owner: { id: sessionId },
    });
    const ctx = createToolExecutionContext({
      store,
      storeManager: manager,
      toolName: "worktree_enter",
      toolCallId: "enter-own-managed",
      input: { path: own.worktreePath },
      step: 0,
      abort: new AbortController().signal,
      startedAt: Date.now(),
      allowedTools: new Set(["worktree_enter"]),
      agentSkills: [],
      skillService: new SkillService({ builtinSkills: {} }),
      projectContext: createTestProjectContext(projectRoot),
      cwd: projectRoot,
      agentName: "lead",
      currentDepth: 0,
      acquireSessionCwdTransition: () => () => undefined,
    });

    const result = await executeWorktreeEnter({ path: own.worktreePath }, ctx);

    if (typeof result === "string") throw new Error("Expected structured result");
    expect(result.isError).toBe(false);
    expect(store.getState().cwd).toBe(own.worktreePath);
  });

  test("allows an explicitly named non-ArchCode registered worktree", async () => {
    const projectRoot = await createGitRepo("allow-external-target");
    const externalPath = resolve(TMP_DIR, "allow-external-target-checkout");
    await git(projectRoot, ["worktree", "add", "-b", "user/external-target", externalPath, "HEAD"]);
    const manager = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();
    const store = manager.create(sessionId, projectRoot, { agentName: "lead" });
    const ctx = createToolExecutionContext({
      store,
      storeManager: manager,
      toolName: "worktree_enter",
      toolCallId: "enter-external",
      input: { path: externalPath },
      step: 0,
      abort: new AbortController().signal,
      startedAt: Date.now(),
      allowedTools: new Set(["worktree_enter"]),
      agentSkills: [],
      skillService: new SkillService({ builtinSkills: {} }),
      projectContext: createTestProjectContext(projectRoot),
      cwd: projectRoot,
      agentName: "lead",
      currentDepth: 0,
      acquireSessionCwdTransition: () => () => undefined,
    });

    const result = await executeWorktreeEnter({ path: externalPath }, ctx);

    if (typeof result === "string") throw new Error("Expected structured result");
    expect(result.isError).toBe(false);
    expect(store.getState().cwd).toBe(externalPath);
  });

  test("enforces Lead eligibility at the execution boundary", async () => {
    const projectRoot = await createGitRepo("agent-boundary");
    const manager = new SessionStoreManager({ logger: silentLogger });
    const store = manager.create(crypto.randomUUID(), projectRoot, { agentName: "lead" });
    const ctx = createToolExecutionContext({
      store,
      storeManager: manager,
      toolName: "worktree_enter",
      toolCallId: "enter-explorer",
      input: {},
      step: 0,
      abort: new AbortController().signal,
      startedAt: Date.now(),
      allowedTools: new Set(["worktree_enter"]),
      agentSkills: [],
      skillService: new SkillService({ builtinSkills: {} }),
      projectContext: createTestProjectContext(projectRoot),
      cwd: projectRoot,
      agentName: "explore",
      currentDepth: 0,
      acquireSessionCwdTransition: () => () => undefined,
    });

    const result = await executeWorktreeEnter({}, ctx);

    if (typeof result === "string") throw new Error("Expected structured error result");
    expect(result).toMatchObject({ isError: true, details: { error: { code: "WORKTREE_SESSION_NOT_ELIGIBLE" } } });
  });

});

async function createGitRepo(name: string): Promise<string> {
  const repo = resolve(TMP_DIR, name);
  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "worktree-tool@example.com"]);
  await git(repo, ["config", "user.name", "Worktree Tool"]);
  await writeFile(join(repo, "README.md"), `# ${name}\n`);
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial commit"]);
  return repo;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const stderr = await new Response(proc.stderr).text();
  if (await proc.exited !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
}
