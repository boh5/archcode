import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { ProjectContextResolver } from "../projects/context-resolver";
import { silentLogger } from "../logger";
import { SessionStoreManager } from "../store/session-store-manager";
import type { SessionRole } from "../store/types";
import type { AgentName } from "../agents";
import { createTestProjectContext, createTestProjectContextResolverOptions } from "../tools/test-project-context";
import { WorktreeService } from "../worktrees";
import {
  SessionExecutionScopeConflictError,
  SessionExecutionScopeValidator,
  type SessionExecutionScopeSubject,
} from "./session-execution-scope-validator";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "session-execution-scope-validator");
beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe("SessionExecutionScopeValidator", () => {
  test("leaves an ordinary Session unaffected without resolving project state", async () => {
    const sessions = new SessionStoreManager({ logger: silentLogger });
    const resolver = new ProjectContextResolver({
      ...createTestProjectContextResolverOptions(sessions),
      projectInfoFactory: () => {
        throw new Error("ordinary Session must not resolve project execution owners");
      },
    });
    const validator = new SessionExecutionScopeValidator({
      projectContextResolver: resolver,
    });

    await expect(validator.validate({
      projectRoot: join(TMP_ROOT, "ordinary"),
      subject: sessionSubject({ sessionId: "ordinary", cwd: join(TMP_ROOT, "ordinary") }),
      entry: { kind: "user_message" },
    })).resolves.toBeUndefined();

    await expectConflict(
      validator.validate({
        projectRoot: join(TMP_ROOT, "ordinary"),
        subject: sessionSubject({ sessionId: "ordinary", cwd: join(TMP_ROOT, "outside") }),
        entry: { kind: "user_message" },
      }),
      "SESSION_CWD_INVALID",
    );
  });

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

  test("allows a claimed running Goal Session in the canonical checkout", async () => {
    const fixture = await createFixture("goal-valid");
    const goal = await createRunningGoal(fixture, { mainSessionId: "goal-main" });

    await expect(fixture.validator.validate({
      projectRoot: fixture.projectRoot,
      subject: sessionSubject({ sessionId: "goal-main", cwd: fixture.projectRoot, goalId: goal.id, sessionRole: "main" }),
      entry: { kind: "user_message" },
    })).resolves.toBeUndefined();

  });

  test("rejects non-isolated Goal Sessions outside the canonical checkout", async () => {
    const fixture = await createFixture("goal-canonical-cwd");
    const goal = await createRunningGoal(fixture, { mainSessionId: "goal-main" });

    await expectConflict(
      fixture.validator.validate({
        projectRoot: fixture.projectRoot,
        subject: sessionSubject({
          sessionId: "goal-main",
          cwd: join(TMP_ROOT, "foreign-worktree"),
          goalId: goal.id,
          sessionRole: "main",
        }),
        entry: { kind: "user_message" },
      }),
      "SESSION_GOAL_CWD_MISMATCH",
    );
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

  test("enforces Goal status and reviewer role", async () => {
    const fixture = await createFixture("goal-status");
    const mainSessionId = crypto.randomUUID();
    const goal = await fixture.context.goalState.commit({
      id: crypto.randomUUID(),
      projectId: "test-project",
      createdFromSessionId: crypto.randomUUID(),
      objective: "Review state",
      acceptanceCriteria: "Only the right role can run",
      mainSessionId,
    });
    const main = sessionSubject({ sessionId: mainSessionId, cwd: fixture.projectRoot, goalId: goal.id, sessionRole: "main" });

    await fixture.context.goalState.beginReview(goal.id);
    await expect(fixture.validator.validate({
      projectRoot: fixture.projectRoot,
      subject: main,
      entry: { kind: "user_message" },
    })).resolves.toBeUndefined();
    await expectConflict(fixture.validator.validate({
      projectRoot: fixture.projectRoot,
      subject: { ...main, agentName: "engineer" },
      entry: { kind: "user_message" },
    }), "SESSION_GOAL_REVIEWER_REQUIRED");
    await fixture.context.goalState.addChildSession(goal.id, "review-child");
    await expect(fixture.validator.validate({
      projectRoot: fixture.projectRoot,
      subject: sessionSubject({
        sessionId: "review-child",
        rootSessionId: mainSessionId,
        parentSessionId: mainSessionId,
        isDescendantOfRoot: true,
        cwd: fixture.projectRoot,
        goalId: goal.id,
        sessionRole: "review",
      }),
      entry: { kind: "user_message" },
    })).resolves.toBeUndefined();

  });

  test("allows not_done continuation only on the current Goal Lead main Session", async () => {
    const fixture = await createFixture("goal-not-done");
    const goal = await createRunningGoal(fixture, { mainSessionId: "goal-main" });
    await fixture.context.goalState.beginReview(goal.id);
    await fixture.context.goalState.finalizeReview(goal.id, {
      expectedReviewGeneration: 1,
      verdict: "NOT_DONE",
      summary: "More work remains",
      evidenceRefs: [],
      unresolvedItems: ["fix it"],
      authorization: {
        agentName: "reviewer",
        sessionRole: "review",
        sessionGoalId: goal.id,
        reviewerSessionId: "reviewer",
      },
    });
    const main = sessionSubject({
      sessionId: "goal-main",
      cwd: fixture.projectRoot,
      goalId: goal.id,
      sessionRole: "main",
    });
    await expect(fixture.validator.validate({
      projectRoot: fixture.projectRoot,
      subject: main,
      entry: { kind: "user_message" },
    })).resolves.toBeUndefined();
    await expectConflict(fixture.validator.validate({
      projectRoot: fixture.projectRoot,
      subject: sessionSubject({
        sessionId: "review-child",
        rootSessionId: "goal-main",
        parentSessionId: "goal-main",
        isDescendantOfRoot: true,
        cwd: fixture.projectRoot,
        goalId: goal.id,
        sessionRole: "review",
      }),
      entry: { kind: "user_message" },
    }), "SESSION_GOAL_NOT_EXECUTABLE");
  });

  test("rejects a Session outside the current main Session claim", async () => {
    const fixture = await createFixture("goal-old-attempt");
    const goal = await createRunningGoal(fixture, { mainSessionId: "current-main" });

    await expectConflict(
      fixture.validator.validate({
        projectRoot: fixture.projectRoot,
        subject: sessionSubject({
          sessionId: "old-main",
          cwd: fixture.projectRoot,
          goalId: goal.id,
          sessionRole: "main",
        }),
        entry: { kind: "user_message" },
      }),
      "SESSION_GOAL_OWNER_MISMATCH",
    );

    await expectConflict(
      fixture.validator.validate({
        projectRoot: fixture.projectRoot,
        subject: sessionSubject({
          sessionId: "old-child",
          rootSessionId: "old-main",
          parentSessionId: "old-main",
          isDescendantOfRoot: true,
          cwd: fixture.projectRoot,
          goalId: goal.id,
          sessionRole: "build",
        }),
        entry: { kind: "user_message" },
      }),
      "SESSION_GOAL_OWNER_MISMATCH",
    );

    await expect(fixture.validator.validate({
      projectRoot: fixture.projectRoot,
      subject: sessionSubject({
        sessionId: "current-main",
        cwd: fixture.projectRoot,
        goalId: goal.id,
        sessionRole: "main",
      }),
      entry: { kind: "user_message" },
    })).resolves.toBeUndefined();
  });

  test("rejects a forged child even when it names the current Goal and root", async () => {
    const fixture = await createFixture("goal-forged-child");
    const goal = await createRunningGoal(fixture, { mainSessionId: "goal-main" });

    await expectConflict(
      fixture.validator.validate({
        projectRoot: fixture.projectRoot,
        subject: sessionSubject({
          sessionId: "forged-child",
          rootSessionId: "goal-main",
          parentSessionId: "goal-main",
          isDescendantOfRoot: false,
          cwd: fixture.projectRoot,
          goalId: goal.id,
          sessionRole: "build",
        }),
        entry: { kind: "user_message" },
      }),
      "SESSION_GOAL_OWNER_MISMATCH",
    );

    await expect(fixture.validator.validate({
      projectRoot: fixture.projectRoot,
      subject: sessionSubject({
        sessionId: "real-child",
        rootSessionId: "goal-main",
        parentSessionId: "goal-main",
        isDescendantOfRoot: true,
        cwd: fixture.projectRoot,
        goalId: goal.id,
        sessionRole: "build",
      }),
      entry: { kind: "user_message" },
    })).resolves.toBeUndefined();
  });

  test("rejects stale Goal HITL after the Goal becomes terminal", async () => {
    const fixture = await createFixture("goal-terminal-hitl");
    const goal = await createRunningGoal(fixture, { mainSessionId: "goal-main" });
    await fixture.context.goalState.cancel(goal.id, "stop");

    await expectConflict(
      fixture.validator.validate({
        projectRoot: fixture.projectRoot,
        subject: sessionSubject({
          sessionId: "goal-main",
          cwd: fixture.projectRoot,
          goalId: goal.id,
          sessionRole: "main",
        }),
        entry: { kind: "hitl_replay" },
      }),
      "SESSION_GOAL_NOT_EXECUTABLE",
    );
  });

  test("keeps Goal lifecycle running while its HITL gate denies Session execution", async () => {
    const fixture = await createFixture("goal-blocked-hitl");
    const goal = await createRunningGoal(fixture, { mainSessionId: "goal-main" });
    await fixture.context.goalState.attachHitlBlocker(goal.id, {
      blocker: {
        kind: "question",
        summary: "Need an answer",
        hitlId: "hitl-1",
      },
      approvalRef: "hitl-1",
    });
    const subject = sessionSubject({
      sessionId: "goal-main",
      cwd: fixture.projectRoot,
      goalId: goal.id,
      sessionRole: "main",
    });

    expect((await fixture.context.goalState.read(goal.id)).status).toBe("running");
    await expectConflict(
      fixture.validator.validate({
        projectRoot: fixture.projectRoot,
        subject,
        entry: { kind: "hitl_replay" },
      }),
      "SESSION_GOAL_NOT_EXECUTABLE",
    );
    await expectConflict(
      fixture.validator.validate({
        projectRoot: fixture.projectRoot,
        subject,
        entry: { kind: "user_message" },
      }),
      "SESSION_GOAL_NOT_EXECUTABLE",
    );
  });
});

async function createFixture(name: string) {
  const projectRoot = join(TMP_ROOT, name, "project");
  await mkdir(projectRoot, { recursive: true });
  const context = createTestProjectContext(projectRoot);
  const resolver = new ProjectContextResolver(
    createTestProjectContextResolverOptions(new SessionStoreManager({ logger: silentLogger })),
  );
  resolver.alias(projectRoot, context);
  return {
    projectRoot,
    context,
    resolver,
    validator: new SessionExecutionScopeValidator({
      projectContextResolver: resolver,
    }),
  };
}

async function createGitFixture(name: string) {
  const fixture = await createFixture(name);
  await git(fixture.projectRoot, ["init", "--initial-branch=main"]);
  await git(fixture.projectRoot, ["config", "user.email", "scope-validator@example.com"]);
  await git(fixture.projectRoot, ["config", "user.name", "Scope Validator"]);
  await Bun.write(join(fixture.projectRoot, "README.md"), "# fixture\n");
  await git(fixture.projectRoot, ["add", "README.md"]);
  await git(fixture.projectRoot, ["commit", "-m", "initial"]);
  return fixture;
}

async function createRunningGoal(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  input: { readonly mainSessionId: string },
) {
  const goal = await fixture.context.goalState.commit({
    id: crypto.randomUUID(),
    projectId: "test-project",
    createdFromSessionId: crypto.randomUUID(),
    objective: "Run safely",
    acceptanceCriteria: "Execution is scoped",
    mainSessionId: input.mainSessionId,
  });
  return goal;
}

function sessionSubject(input: {
  readonly sessionId: string;
  readonly rootSessionId?: string;
  readonly parentSessionId?: string;
  readonly isDescendantOfRoot?: boolean;
  readonly cwd: string;
  readonly goalId?: string;
  readonly sessionRole?: SessionRole;
  readonly agentName?: AgentName;
}): SessionExecutionScopeSubject {
  return {
    sessionId: input.sessionId,
    rootSessionId: input.rootSessionId ?? input.sessionId,
    ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
    ...(input.isDescendantOfRoot === undefined ? {} : { isDescendantOfRoot: input.isDescendantOfRoot }),
    cwd: input.cwd,
    ...(input.goalId === undefined ? {} : { goalId: input.goalId }),
    ...(input.sessionRole === undefined ? {} : { sessionRole: input.sessionRole }),
    agentName: input.agentName ?? agentNameForRole(input.sessionRole),
  };
}

function agentNameForRole(role: SessionRole | undefined): AgentName {
  if (role === "main") return "goal_lead";
  if (role === "plan") return "plan";
  if (role === "build") return "build";
  if (role === "review") return "reviewer";
  if (role === "explore") return "explore";
  if (role === "librarian") return "librarian";
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
