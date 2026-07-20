import type { ToolRegistry } from "../tools/index";
import type { Logger } from "../logger";
import type { ResolvedGithubIntegrationConfig } from "../config";
import { createGitHubConnector } from "../integrations/github";
import { createBuiltinToolDescriptors } from "../tools/builtins";
import {
  createAuditHook,
  createExecutionLogger,
} from "../tools/hooks";
import { createMemoryReadTool } from "../tools/builtins/memory-read";
import { createMemoryWriteTool } from "../tools/builtins/memory-write";
import { createGoalTool, getGoalTool, updateGoalTool } from "../tools/builtins/session-goal";
import { automationCreateTool } from "../tools/builtins/automation-create";
import { createGitHubToolDescriptors } from "../tools/github";

export interface RegisterBuiltinToolsOptions {
  readonly github: ResolvedGithubIntegrationConfig;
}

export function registerBuiltinTools(
  registry: ToolRegistry,
  logger: Logger,
  options: RegisterBuiltinToolsOptions,
): void {
  const descriptors = createBuiltinToolDescriptors();
  registry.registerAll(descriptors);

  registry.register(createMemoryReadTool());
  registry.register(createMemoryWriteTool());

  registry.register(createGoalTool);
  registry.register(getGoalTool);
  registry.register(updateGoalTool);
  registry.register(automationCreateTool);

  const githubConnector = createGitHubConnector({ resolvedConfig: options.github });
  registry.registerAll(createGitHubToolDescriptors({ connector: githubConnector }));

  registry.globalHooks.finalized.push(createAuditHook());
  registry.globalHooks.finalized.push(createExecutionLogger(logger.child({ module: "tools.execution" })));
}
