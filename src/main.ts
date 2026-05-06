import React from "react";
import { render } from "ink";
import { loadConfig } from "./config/load";
import { TestAgent } from "./agents/test-agent";
import { App } from "./tui/App";

async function main() {
  const configPath = ".specra.json";

  const config = await loadConfig(configPath);
  const agent = new TestAgent(config);

  render(React.createElement(App, { agent }));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
