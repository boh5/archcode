import type { ToolRegistry } from "../tools/index";
import type { Logger } from "../logger";
import { createBuiltinToolDescriptors } from "../tools/builtins";
import {
  createAuditHook,
  createExecutionLogger,
  createOutputTruncator,
  createRedactionHook,
} from "../tools/hooks";
import { createLoopBudgetToolPermission } from "../loops/budget-tool-guard";
import { createLoopCollisionToolPermission, createLoopCollisionToolReleaseHook } from "../loops/collision-tool-guard";
import { createMemoryReadTool } from "../tools/builtins/memory-read";
import { createMemoryWriteTool } from "../tools/builtins/memory-write";
import { goalManageTool } from "../tools/builtins/goal-tools";
import { createGitHubToolDescriptors } from "../tools/github";

export function registerBuiltinTools(
  registry: ToolRegistry,
  logger: Logger,
): void {
  const descriptors = createBuiltinToolDescriptors();
  registry.registerAll(descriptors);

  registry.register(createMemoryReadTool());
  registry.register(createMemoryWriteTool());

  registry.register(goalManageTool);

  registry.registerAll(createGitHubToolDescriptors());

  registry.globalPermissions.push(createLoopCollisionToolPermission());
  registry.globalPermissions.push(createLoopBudgetToolPermission());

  registry.globalHooks.after.push(createLoopCollisionToolReleaseHook());
  registry.globalHooks.after.push(createRedactionHook());
  registry.globalHooks.after.push(createOutputTruncator({ logger: logger.child({ module: "tools.truncate" }) }));
  registry.globalHooks.after.push(createAuditHook());
  registry.globalHooks.after.push(createExecutionLogger(logger.child({ module: "tools.execution" })));
}
