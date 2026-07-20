import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "../../../..");
const agentCoreRoot = join(projectRoot, "packages/agent-core/src");
const automationRoot = join(agentCoreRoot, "automations");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) return sourceFiles(path);
    return /\.ts$/.test(entry) && !/\.test\.ts$/.test(entry) ? [path] : [];
  });
}

describe("Automation architecture boundaries", () => {
  test("removes Loop production and route surfaces", () => {
    const loopRoot = join(agentCoreRoot, "loops");
    expect(existsSync(loopRoot)).toBe(false);
    expect(existsSync(join(projectRoot, "apps/server/src/routes/loops.ts"))).toBe(false);
    expect(existsSync(join(projectRoot, "apps/web/src/routes/loops.tsx"))).toBe(false);
  });

  test("dispatches Automations only through the Session gateway", () => {
    const violations = sourceFiles(automationRoot)
      .filter((path) => /from\s+["'][^"']*(?:loops|goals|hitl|tools\/github)/.test(readFileSync(path, "utf8")))
      .map((path) => relative(projectRoot, path));
    const dispatcher = readFileSync(join(automationRoot, "dispatcher.ts"), "utf8");

    expect(violations).toEqual([]);
    expect(dispatcher).toContain("SessionDispatchGateway");
    expect(dispatcher).toContain("gateway.dispatch");
  });

  test("keeps schedule, persistence, dispatch, and server transport dependencies one-way", () => {
    const schedule = readFileSync(join(automationRoot, "schedule.ts"), "utf8");
    const state = readFileSync(join(automationRoot, "state-manager.ts"), "utf8");
    const dispatcher = readFileSync(join(automationRoot, "dispatcher.ts"), "utf8");
    const scheduler = readFileSync(join(automationRoot, "scheduler.ts"), "utf8");
    const boot = readFileSync(join(projectRoot, "apps/server/src/boot.ts"), "utf8");
    const runtime = readFileSync(join(agentCoreRoot, "runtime.ts"), "utf8");
    const sessionRecovery = runtime.slice(
      runtime.indexOf("async function recoverSessionContinuations"),
      runtime.indexOf("async function recoverProjectTodos"),
    );
    const todoRecovery = runtime.slice(
      runtime.indexOf("async function recoverProjectTodos"),
      runtime.indexOf("async function reconcileRegisteredProject"),
    );
    const familyIdleReconciliation = runtime.slice(
      runtime.indexOf("executionManager.subscribeSessionRuntimeChanges"),
      runtime.indexOf("type AutomationRuntimeServices"),
    );

    expect(schedule).not.toMatch(/from\s+["']\.\/(?:state-manager|dispatcher|scheduler|runtime-session-gateway)["']/);
    expect(state).not.toMatch(/from\s+["']\.\/(?:dispatcher|scheduler|runtime-session-gateway)["']/);
    expect(dispatcher).not.toMatch(/from\s+["']\.\/(?:scheduler|runtime-session-gateway)["']/);
    expect(scheduler).not.toContain("runtime-session-gateway");
    expect(sourceFiles(automationRoot).map((path) => readFileSync(path, "utf8")).join("\n"))
      .not.toContain("AutomationRunner");
    expect(boot).not.toContain("setManagedSessionExecutionForwarder");
    expect(boot).not.toContain("forwardSessionExecution");
    expect(boot.indexOf("recoverSessionContinuations")).toBeLessThan(boot.indexOf("recoverProjectTodos"));
    expect(boot.indexOf("recoverProjectTodos")).toBeLessThan(boot.indexOf("startAutomationSchedulers"));
    expect(boot.indexOf("startAutomationSchedulers")).toBeLessThan(boot.indexOf("startServer(app"));
    expect(sessionRecovery).toContain("reconcileAnsweredHitl");
    expect(sessionRecovery).toContain("continueRunnableToolBatches");
    expect(sessionRecovery).not.toContain("context.todos.reconcileAll()");
    expect(todoRecovery).toContain("context.todos.reconcileAll()");
    expect(todoRecovery).not.toContain("goalLifecycle");
    expect(todoRecovery).not.toContain("reconcileAnsweredHitl");
    expect(todoRecovery).not.toContain("continuationService");
    expect(runtime).not.toContain("directSessionToolBatchExecutor");
    expect(runtime).not.toContain("activeSessionToolBatchExecutor");
    expect(runtime).toContain("reconcileAllActiveGoals");
    expect(runtime).toContain("reconcileActiveGoal");
    // Root and child terminals both release the same root-family activity to
    // idle; this listener is their single Goal continuation trigger.
    expect(familyIdleReconciliation).toContain('if (change.activity === "idle")');
    expect(familyIdleReconciliation).toContain("await reconcileActiveGoal({");
    expect(sessionRecovery).toContain("await reconcileAllActiveGoals");
    expect(runtime).not.toContain("sessionGoalCoordinator");
    expect(runtime).not.toContain("startCheckedExecutionWithinGoalClaim");
    expect(runtime).not.toContain('input.origin === "goal_claim"');
  });
});
