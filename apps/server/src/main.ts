import { bootServer } from "./boot";
import { createConsoleLogger, createRuntime, type AgentRuntime } from "@archcode/agent-core";
import { ENV_SERVER_PASSWORD } from "@archcode/protocol";

export { createRuntime, type AgentRuntime, type AgentRuntimeOptions } from "@archcode/agent-core";

const logger = createConsoleLogger({ level: "info" });

async function main() {
  const serverPassword = Bun.env[ENV_SERVER_PASSWORD];
  const runtime: AgentRuntime = await createRuntime({
    logger,
    externalSecretLiterals: serverPassword === undefined ? [] : [serverPassword],
  });

  await bootServer(runtime);
}

// Only run main() when this module is the entry point
if (import.meta.main) {
  main().catch((err) => {
    logger.error("server.fatal", {
      message: "Server startup failed",
      meta: {
        errorName: err instanceof Error ? err.name : "NonErrorThrow",
        errorCode: typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
          ? err.code
          : "SERVER_START_FAILED",
      },
    });
    process.exit(1);
  });
}
