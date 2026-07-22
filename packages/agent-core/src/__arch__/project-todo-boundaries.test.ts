import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "../../../..");
const agentCoreRoot = join(projectRoot, "packages/agent-core/src");
const todosRoot = join(agentCoreRoot, "todos");

function productionSources(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return productionSources(path);
    return entry.endsWith(".ts") && !entry.endsWith(".test.ts") ? [path] : [];
  });
}

describe("Project Todo architecture boundaries", () => {
  test("keeps the Todo domain independent from orchestration implementations and presentation", () => {
    const forbiddenImport = /from\s+["'](?:\.\.\/(?:agents|automations|goals|prompt|projects(?!\/runtime-path)|store)|[^"']*(?:apps\/server|apps\/web))/;
    const violations = productionSources(todosRoot)
      .filter((path) => forbiddenImport.test(readFileSync(path, "utf8")))
      .map((path) => relative(projectRoot, path));

    expect(violations).toEqual([]);
  });

  test("keeps persistence free of Session creation and the service capability-only", () => {
    const state = readFileSync(join(todosRoot, "state-manager.ts"), "utf8");
    const service = readFileSync(join(todosRoot, "service.ts"), "utf8");

    expect(state).not.toMatch(/SessionExecutionManager|SessionStoreManager|ensureRootSession|ensureExecution/);
    expect(service).toContain("ProjectTodoSessionCapability");
    expect(service).toContain("ProjectTodoProvenanceCapability");
    expect(service).not.toMatch(/new\s+(?:SessionExecutionManager|GoalStateManager|AutomationStateManager)/);
  });

  test("does not reuse Session Todo contracts or introduce legacy Todo aliases", () => {
    const todoSurfaceFiles = [
      ...productionSources(todosRoot),
      join(projectRoot, "packages/protocol/src/project-todos.ts"),
      join(projectRoot, "apps/server/src/routes/todos.ts"),
      join(projectRoot, "apps/web/src/routes/project-todos.tsx"),
    ];
    const source = todoSurfaceFiles.map((path) => readFileSync(path, "utf8")).join("\n");

    expect(source).not.toMatch(/SessionTodo|todo_write|Backlog|WorkItem|Idea Library/);
    expect(readFileSync(join(projectRoot, "packages/protocol/src/project-todos.ts"), "utf8"))
      .toContain('export type ProjectTodoStatus = "idea" | "ready" | "done" | "rejected"');
  });

  test("adapts HTTP through ProjectContext and keeps Web on Protocol DTOs", () => {
    const route = readFileSync(join(projectRoot, "apps/server/src/routes/todos.ts"), "utf8");
    const webTypes = readFileSync(join(projectRoot, "apps/web/src/api/types.ts"), "utf8");

    expect(route).toContain("runtime.contextResolver.resolve");
    expect(route).toContain("context.todos");
    expect(route).not.toMatch(/new\s+ProjectTodo(?:Service|StateManager)/);
    expect(webTypes).toMatch(/ProjectTodo.*from\s+["']@archcode\/protocol["']/s);
    expect(webTypes).not.toContain("@archcode/agent-core");
  });
});
