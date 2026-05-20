import { bootServer } from "./server/boot";
import { closeMcpManagerBestEffort, createSpecraRuntime, type SpecraRuntime } from "./runtime";
import type { McpWarning } from "./mcp/index";

export { createSpecraRuntime, type SpecraRuntime, type SpecraRuntimeOptions } from "./runtime";

function logMcpWarning(warning: McpWarning): void {
  console.warn(`MCP warning: ${warning.message}`);
}

async function main() {
  const runtime: SpecraRuntime = await createSpecraRuntime({ warn: logMcpWarning });

  const close = () => {
    void closeMcpManagerBestEffort(runtime.mcpManager, logMcpWarning);
    runtime.sessionAgentManager.disposeAll();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);

  await bootServer(runtime);
}

// Only run main() when this module is the entry point
if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
