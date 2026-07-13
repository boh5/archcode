import type { ToolRegistry } from "../tools/index";
import type { Logger } from "../logger";
import type { GithubIntegrationConfig } from "../config";
import { createGitHubConnector } from "../integrations/github";
import { createBuiltinToolDescriptors } from "../tools/builtins";
import {
  createAuditHook,
  createExecutionLogger,
  createOutputTruncator,
  createRedactionHook,
} from "../tools/hooks";
import { createMemoryReadTool } from "../tools/builtins/memory-read";
import { createMemoryWriteTool } from "../tools/builtins/memory-write";
import { goalCreateTool, goalManageTool } from "../tools/builtins/goal-tools";
import { automationCreateTool } from "../tools/builtins/automation-create";
import { createGitHubToolDescriptors } from "../tools/github";

export interface RegisterBuiltinToolsOptions {
  readonly github?: GithubIntegrationConfig;
}

export function registerBuiltinTools(
  registry: ToolRegistry,
  logger: Logger,
  options: RegisterBuiltinToolsOptions = {},
): void {
  const descriptors = createBuiltinToolDescriptors();
  registry.registerAll(descriptors);

  registry.register(createMemoryReadTool());
  registry.register(createMemoryWriteTool());

  registry.register(goalCreateTool);
  registry.register(goalManageTool);
  registry.register(automationCreateTool);

  registry.registerAll(createGitHubToolDescriptors({
    connector: () => createGitHubConnector(
      options.github === undefined ? {} : { config: options.github },
    ),
  }));

  registry.globalHooks.after.push(createRedactionHook());
  registry.globalHooks.after.push(createOutputTruncator({ logger: logger.child({ module: "tools.truncate" }) }));
  registry.globalHooks.after.push(createAuditHook());
  registry.globalHooks.after.push(createExecutionLogger(logger.child({ module: "tools.execution" })));
}
