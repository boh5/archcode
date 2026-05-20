import type { ToolRegistry } from "../tools/index";
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
  createWorkflowTaskCheckTool,
  createWorkflowUpdateStageTool,
} from "../tools/builtins/workflow";

export function registerBuiltinTools(
  registry: ToolRegistry,
): void {
  const descriptors = createBuiltinToolDescriptors();
  registry.registerAll(descriptors);

  registry.register(createMemoryReadTool());
  registry.register(createMemoryWriteTool());

  registry.register(createWorkflowCreateTool());
  registry.register(createWorkflowReadTool());
  registry.register(createWorkflowUpdateStageTool());
  registry.register(createArtifactReadTool());
  registry.register(createArtifactWriteTool());
  registry.register(createWorkflowTaskCheckTool());

  registry.globalHooks.after.push(createRedactionHook());
  registry.globalHooks.after.push(createOutputTruncator());
  registry.globalHooks.after.push(createAuditHook());
  registry.globalHooks.after.push(createExecutionLogger());
}
