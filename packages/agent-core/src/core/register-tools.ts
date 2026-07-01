import type { ToolRegistry } from "../tools/index";
import type { Logger } from "../logger";
import { createBuiltinToolDescriptors } from "../tools/builtins";
import {
  createAuditHook,
  createExecutionLogger,
  createOutputTruncator,
  createRedactionHook,
} from "../tools/hooks";
import { createMemoryReadTool } from "../tools/builtins/memory-read";
import { createMemoryWriteTool } from "../tools/builtins/memory-write";
import {
  createArtifactReadTool,
  createArtifactWriteTool,
  createWorkflowCreateTool,
  createWorkflowReadTool,
  createWorkflowProposeInteractionsTool,
  createWorkflowRequestInteractionsTool,
  createWorkflowTaskCheckTool,
  createWorkflowUpdateStageTool,
} from "../tools/builtins/workflow";
import {
  createGoalCreateTool,
  createGoalLockTool,
  createGoalRetryTool,
  createGoalRunTool,
} from "../tools/builtins/goal-tools";

export function registerBuiltinTools(
  registry: ToolRegistry,
  logger: Logger,
): void {
  const descriptors = createBuiltinToolDescriptors();
  registry.registerAll(descriptors);

  registry.register(createMemoryReadTool());
  registry.register(createMemoryWriteTool());

  registry.register(createWorkflowCreateTool());
  registry.register(createWorkflowReadTool());
  registry.register(createWorkflowUpdateStageTool());
  registry.register(createWorkflowProposeInteractionsTool());
  registry.register(createWorkflowRequestInteractionsTool());
  registry.register(createArtifactReadTool());
  registry.register(createArtifactWriteTool());
  registry.register(createWorkflowTaskCheckTool());

  registry.register(createGoalCreateTool());
  registry.register(createGoalLockTool());
  registry.register(createGoalRunTool());
  registry.register(createGoalRetryTool());

  registry.globalHooks.after.push(createRedactionHook());
  registry.globalHooks.after.push(createOutputTruncator({ logger: logger.child({ module: "tools.truncate" }) }));
  registry.globalHooks.after.push(createAuditHook());
  registry.globalHooks.after.push(createExecutionLogger(logger.child({ module: "tools.execution" })));
}
