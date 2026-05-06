import React from "react";
import { render } from "ink";
import { loadConfig } from "./config/load";
import { createRegistry } from "./provider/registry";
import { createSessionStore } from "./store/store";
import { App } from "./tui/App";
import { randomUUID } from "node:crypto";

async function main() {
  const configPath = ".specra.json";

  const config = await loadConfig(configPath);
  const registry = createRegistry(config.provider);

  const modelIds = registry.modelIds;
  if (modelIds.length === 0) {
    console.error("No models configured in .specra.json");
    process.exit(1);
  }

  const firstModelInfo = registry.getModel(modelIds[0]);
  const sessionId = randomUUID();
  const store = createSessionStore(sessionId);

  render(
    React.createElement(App, {
      store,
      model: firstModelInfo.model,
      tools: {},
      toolExecutors: {},
    }),
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
