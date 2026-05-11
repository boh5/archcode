import { join } from "node:path";
import { homedir } from "node:os";
import type { ToolRegistry } from "../tools/index";
import { createBuiltinToolDescriptors } from "../tools/builtins";
import { createAuditHook } from "../tools/hooks/audit";
import { createExecutionLogger } from "../tools/hooks/logger";
import { createRedactionHook } from "../tools/hooks/redact";
import { createOutputTruncator } from "../tools/hooks/truncate";
import { createMemoryReadTool } from "../tools/builtins/memory-read";
import { createMemoryWriteTool } from "../tools/builtins/memory-write";
import { createMemoryIndexGuard } from "../tools/hooks/memory-index-guard";
import { MemoryFileManager } from "../memory/file-manager";

const MEMORY_GUARDED_TOOLS = new Set(["file_write", "file_edit"]);

export function registerBuiltinTools(
  registry: ToolRegistry,
): void {
  const descriptors = createBuiltinToolDescriptors();
  registry.registerAll(descriptors);

  const memoryRoots = {
    project: join(process.cwd(), ".specra", "memory"),
    user: join(homedir(), ".specra", "memory"),
  };
  const fileManager = new MemoryFileManager(memoryRoots);
  registry.register(createMemoryReadTool(fileManager));
  registry.register(createMemoryWriteTool(fileManager));

  const memoryIndexGuard = createMemoryIndexGuard();
  registry.globalGuards.push((input, ctx) => {
    if (!MEMORY_GUARDED_TOOLS.has(ctx.toolName)) {
      return { outcome: "allow" };
    }
    return memoryIndexGuard(input, ctx);
  });

  registry.globalHooks.after.push(createRedactionHook());
  registry.globalHooks.after.push(createOutputTruncator());
  registry.globalHooks.after.push(createAuditHook());
  registry.globalHooks.after.push(createExecutionLogger());
}
