import type { ToolRegistry } from "../tools/index";
import { createBuiltinToolDescriptors } from "../tools/builtins";
import { createAuditHook } from "../tools/hooks/audit";
import { createExecutionLogger } from "../tools/hooks/logger";
import { createRedactionHook } from "../tools/hooks/redact";
import { createOutputTruncator } from "../tools/hooks/truncate";

export function registerBuiltinTools(registry: ToolRegistry): void {
  const descriptors = createBuiltinToolDescriptors();
  registry.registerAll(descriptors);

  registry.globalHooks.after.push(createRedactionHook());
  registry.globalHooks.after.push(createOutputTruncator());
  registry.globalHooks.after.push(createAuditHook());
  registry.globalHooks.after.push(createExecutionLogger());
}
