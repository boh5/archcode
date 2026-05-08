import type { ToolRegistry } from "../tools/index";
import { createBuiltinToolDescriptors } from "../tools/builtins";
import { createExecutionLogger } from "../tools/hooks/logger";
import { createOutputTruncator } from "../tools/hooks/truncate";

export function registerBuiltinTools(registry: ToolRegistry): void {
  const descriptors = createBuiltinToolDescriptors();
  registry.registerAll(descriptors);

  registry.globalHooks.after.push(createExecutionLogger());
  registry.globalHooks.after.push(createOutputTruncator());
}