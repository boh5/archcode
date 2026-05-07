import React from "react";
import { render } from "ink";
import { loadConfig } from "./config/load";
import { TestAgent } from "./agents/test-agent";
import { createRegistry as createProviderRegistry } from "./provider/index";
import { createRegistry as createToolRegistry } from "./tools/index";
import { registerBuiltinTools } from "./core/index";
import { App } from "./tui/App";

async function main() {
  const configPath = ".specra.json";

  const config = await loadConfig(configPath);
  const providerRegistry = createProviderRegistry(config.provider);
  const toolRegistry = createToolRegistry();
  registerBuiltinTools(toolRegistry);

  const agent = new TestAgent({ providerRegistry, toolRegistry });

  render(React.createElement(App, { agent }));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});