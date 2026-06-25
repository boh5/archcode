import { bootServer } from "./boot";
import { closeMcpManagerBestEffort, createConsoleLogger, createRuntime, type McpWarning, type AgentRuntime } from "@archcode/agent-core";

export { createRuntime, type AgentRuntime, type AgentRuntimeOptions } from "@archcode/agent-core";

const logger = createConsoleLogger({ level: "info" });

async function main() {
  const runtime: AgentRuntime = await createRuntime({ logger });

  const close = () => {
    void closeMcpManagerBestEffort(runtime.mcpManager, (warning: McpWarning) => {
      logger.warn("mcp.close.warning", {
        meta: { toolName: warning.toolName, message: warning.message },
      });
    });
    runtime.disposeAllSessionAgents();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);

  await bootServer(runtime);
}

// Only run main() when this module is the entry point
if (import.meta.main) {
  main().catch((err) => {
    logger.error("server.fatal", { error: err });
    process.exit(1);
  });
}
