import type { ToolRegistry } from "../tools/index";
import { createBuiltinToolDescriptors } from "../tools/builtins";

export function registerBuiltinTools(registry: ToolRegistry): void {
  const descriptors = createBuiltinToolDescriptors();
  registry.registerAll(descriptors);
}