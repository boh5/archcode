import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import type { AgentName } from "../agents";
import { silentLogger } from "../logger";
import { ProjectContextResolver } from "../projects/context-resolver";
import { SessionStoreManager } from "../store/session-store-manager";
import type { SessionRole } from "../store/types";
import { createTestTempRoot } from "../testing/test-temp-root";
import { createTestProjectContext, createTestProjectContextResolverOptions } from "../tools/test-project-context";
import { WorktreeService } from "../worktrees";
import {
  SessionExecutionScopeConflictError,
  SessionExecutionScopeValidator,
  type SessionExecutionScopeSubject,
} from "./session-execution-scope-validator";

const testTempRoot = createTestTempRoot("session-execution-scope-validator");
let TMP_ROOT = testTempRoot.path;

beforeEach(async () => {
  await testTempRoot.cleanup();
  await mkdir(testTempRoot.path, { recursive: true });
  TMP_ROOT = await realpath(testTempRoot.path);
});

afterAll(async () => {
  await testTempRoot.cleanup();
});

describe("SessionExecutionScopeValidator worktrees", () => {
  test("allows only the root Session's own reserved worktree while keeping ordinary Git worktrees usable", async () => {
    const fixture = await createGitFixture("ordinary-worktree-owner");
    const service = new WorktreeService({ canonicalRoot: fixture.projectRoot });
    const own = await service.create({
      owner: { type: "session", id: "ordinary-root" },
      requireCleanCanonical: true,
    });

    await expect(fixture.validator.validate({
      projectRoot: fixture.projectRoot,
      subject: sessionSubject({ sessionId: "ordinary-root", cwd: own.worktreePath }),
      entry: { kind: "user_message" },
    })).resolves.toBeUndefined();
    await expect(fixture.validator.validate({
      projectRoot: fixture.projectRoot,
      subject: sessionSubject({
        sessionId: "ordinary-child",
        rootSessionId: "ordinary-root",
        parentSessionId: "ordinary-root",
        cwd: own.worktreePath,
      }),
      entry: { kind: "user_message" },
    })).resolves.toBeUndefined();

    const other = await service.create({
      owner: { type: "goal", id: crypto.randomUUID() },
      requireCleanCanonical: true,
    });
    await expectConflict(
      fixture.validator.validate({
        projectRoot: fixture.projectRoot,
        subject: sessionSubject({ sessionId: "ordinary-root", cwd: other.worktreePath }),
        entry: { kind: "user_message" },
      }),
      "SESSION_WORKTREE_OWNER_MISMATCH",
    );

    const ordinaryPath = join(TMP_ROOT, "ordinary-worktree-owner", "manual-worktree");
    await git(fixture.projectRoot, ["worktree", "add", "-b", "feature/manual-worktree", ordinaryPath]);
    await expect(fixture.validator.validate({
      projectRoot: fixture.projectRoot,
      subject: sessionSubject({ sessionId: "ordinary-root", cwd: ordinaryPath }),
      entry: { kind: "user_message" },
    })).resolves.toBeUndefined();
  });

  test("validates isolated Goal path, branch, and persisted base claim", async () => {
    const fixture = await createGitFixture("goal-worktree-valid");
    const mainSessionId = crypto.randomUUID();
    const goal = await fixture.context.goalState.commit({
      id: crypto.randomUUID(),
      projectId: "test-project",
      createdFromSessionId: crypto.randomUUID(),
      objective: "Use an isolated checkout",
      acceptanceCriteria: "The checkout is validated",
      useWorktree: true,
      mainSessionId,
    });
    const created = await new WorktreeService({ canonicalRoot: fixture.projectRoot }).create({
      owner: { type: "goal", id: goal.id },
      requireCleanCanonical: true,
    });
    await fixture.context.goalState.setWorktree(goal.id, {
      path: created.worktreePath,
      branchName: created.branchName,
      baseSha: created.baseSha,
      createdAt: new Date().toISOString(),
    });
    await expect(fixture.validator.validate({
      projectRoot: fixture.projectRoot,
      subject: sessionSubject({
        sessionId: mainSessionId,
        cwd: created.worktreePath,
        goalId: goal.id,
        sessionRole: "main",
      }),
      entry: { kind: "user_message" },
    })).resolves.toBeUndefined();
  });

  test("rejects a tampered isolated Goal base before execution", async () => {
    const fixture = await createGitFixture("goal-worktree-tampered-base");
    const mainSessionId = crypto.randomUUID();
    const goal = await fixture.context.goalState.commit({
      id: crypto.randomUUID(),
      projectId: "test-project",
      createdFromSessionId: crypto.randomUUID(),
      objective: "Use an isolated checkout",
      acceptanceCriteria: "Tampering is rejected",
      useWorktree: true,
      mainSessionId,
    });
    const created = await new WorktreeService({ canonicalRoot: fixture.projectRoot }).create({
      owner: { type: "goal", id: goal.id },
      requireCleanCanonical: true,
    });
    await fixture.context.goalState.setWorktree(goal.id, {
      path: created.worktreePath,
      branchName: created.branchName,
      baseSha: "0".repeat(40),
      createdAt: new Date().toISOString(),
    });
    await expectConflict(
      fixture.validator.validate({
        projectRoot: fixture.projectRoot,
        subject: sessionSubject({
          sessionId: mainSessionId,
          cwd: created.worktreePath,
          goalId: goal.id,
          sessionRole: "main",
        }),
        entry: { kind: "user_message" },
      }),
      "SESSION_GOAL_WORKTREE_CLAIM_INVALID",
    );
  });
});

async function createGitFixture(name: string) {
  const projectRoot = join(TMP_ROOT, name, "project");
  await mkdir(projectRoot, { recursive: true });
  const context = createTestProjectContext(projectRoot);
  const resolver = new ProjectContextResolver(
    createTestProjectContextResolverOptions(new SessionStoreManager({ logger: silentLogger })),
  );
  resolver.alias(projectRoot, context);
  await git(projectRoot, ["init", "--initial-branch=main"]);
  await git(projectRoot, ["config", "user.email", "scope-validator@example.com"]);
  await git(projectRoot, ["config", "user.name", "Scope Validator"]);
  await Bun.write(join(projectRoot, "README.md"), "# fixture\n");
  await git(projectRoot, ["add", "README.md"]);
  await git(projectRoot, ["commit", "-m", "initial"]);
  return {
    projectRoot,
    context,
    validator: new SessionExecutionScopeValidator({ projectContextResolver: resolver }),
  };
}

function sessionSubject(input: {
  readonly sessionId: string;
  readonly rootSessionId?: string;
  readonly parentSessionId?: string;
  readonly cwd: string;
  readonly goalId?: string;
  readonly sessionRole?: SessionRole;
}): SessionExecutionScopeSubject {
  return {
    sessionId: input.sessionId,
    rootSessionId: input.rootSessionId ?? input.sessionId,
    ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
    cwd: input.cwd,
    ...(input.goalId === undefined ? {} : { goalId: input.goalId }),
    ...(input.sessionRole === undefined ? {} : { sessionRole: input.sessionRole }),
    agentName: agentNameForRole(input.sessionRole),
  };
}

function agentNameForRole(role: SessionRole | undefined): AgentName {
  if (role === "main") return "goal_lead";
  return "engineer";
}

async function expectConflict(
  promise: Promise<void>,
  code: SessionExecutionScopeConflictError["code"],
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SessionExecutionScopeConflictError);
    expect((error as SessionExecutionScopeConflictError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(process.stderr).text();
  if (await process.exited !== 0) throw new Error(stderr);
}
