import { join } from "node:path";
import { homedir } from "node:os";
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
import { WorkflowArtifactManager, WorkflowStateManager } from "../agents/workflow";
import { MemoryFileManager } from "../memory/file-manager";
import { ProjectApprovalManager } from "../tools/permission";

export function registerBuiltinTools(
  registry: ToolRegistry,
): void {
  registry.setProjectApprovalManager(new ProjectApprovalManager());

  const descriptors = createBuiltinToolDescriptors();
  registry.registerAll(descriptors);

  const memoryRoots = {
    project: join(process.cwd(), ".specra", "memory"),
    user: join(homedir(), ".specra", "memory"),
  };
  const fileManager = new MemoryFileManager(memoryRoots);
  registry.register(createMemoryReadTool(fileManager));
  registry.register(createMemoryWriteTool(fileManager));

  const workflowStateManager = new WorkflowStateManager(process.cwd());
  const workflowArtifactManager = new WorkflowArtifactManager(process.cwd(), workflowStateManager);
  registry.register(createWorkflowCreateTool(workflowStateManager));
  registry.register(createWorkflowReadTool(workflowStateManager));
  registry.register(createWorkflowUpdateStageTool(workflowStateManager, workflowArtifactManager));
  registry.register(createArtifactReadTool(workflowArtifactManager));
  registry.register(createArtifactWriteTool(workflowArtifactManager));
  registry.register(createWorkflowTaskCheckTool(workflowStateManager, workflowArtifactManager));

  registry.globalHooks.after.push(createRedactionHook());
  registry.globalHooks.after.push(createOutputTruncator());
  registry.globalHooks.after.push(createAuditHook());
  registry.globalHooks.after.push(createExecutionLogger());
}
