import { bootServer } from "./boot";
import { createConsoleLogger, createRuntime, type AgentRuntime } from "@archcode/agent-core";
import { ENV_SERVER_PASSWORD } from "@archcode/protocol";
import {
  requireEmbeddedWebAssets,
  type EmbeddedWebAssets,
} from "./serve-web";

export { createRuntime, type AgentRuntime, type AgentRuntimeOptions } from "@archcode/agent-core";

const logger = createConsoleLogger({ level: "info" });

export interface StartArchCodeOptions {
  embeddedWebAssets?: EmbeddedWebAssets;
}

async function main(options: StartArchCodeOptions) {
  const serverPassword = Bun.env[ENV_SERVER_PASSWORD];
  const runtime: AgentRuntime = await createRuntime({
    logger,
    externalSecretLiterals: serverPassword === undefined ? [] : [serverPassword],
  });

  await bootServer(runtime, {
    embeddedWebAssets: options.embeddedWebAssets,
  });
}

export function startArchCode(options: StartArchCodeOptions = {}): void {
  main(options).catch((err) => {
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

export function startProductionArchCode(embeddedWebAssets: EmbeddedWebAssets): void {
  startArchCode({
    embeddedWebAssets: requireEmbeddedWebAssets(embeddedWebAssets),
  });
}

// Only run main() when this source module is the entry point. Production
// binaries use the generated dist/.build entrypoint to inject Web assets.
if (import.meta.main) {
  startArchCode();
}
