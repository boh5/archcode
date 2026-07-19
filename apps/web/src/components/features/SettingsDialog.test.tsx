import { describe, expect, test } from "bun:test";
import type { McpServerStatus, ProviderAdapterCatalog } from "@archcode/protocol";
import type { ServerConfig } from "../../api/config";
import {
  SettingsModelsPanel,
  SettingsMcpPanel,
  SettingsNavigation,
  SettingsApplyNotice,
} from "./SettingsDialog";

interface ElementLike {
  type?: unknown;
  props?: Record<string, unknown> | null;
}

function isElement(value: unknown): value is ElementLike {
  return typeof value === "object" && value !== null && "props" in value;
}

function childrenOf(value: unknown): unknown[] {
  if (!isElement(value)) return [];
  const children = value.props?.children;
  if (children === undefined || children === null) return [];
  return Array.isArray(children) ? children : [children];
}

function textContent(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (!isElement(value)) return "";
  return textContent(value.props?.children);
}

function findAll(value: unknown, predicate: (element: ElementLike) => boolean): ElementLike[] {
  const matches: ElementLike[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return void node.forEach(visit);
    if (!isElement(node)) return;
    if (predicate(node)) matches.push(node);
    childrenOf(node).forEach(visit);
  };
  visit(value);
  return matches;
}

const config: ServerConfig = {
  provider: {
    local: {
      npm: "@ai-sdk/openai-compatible",
      name: "Local",
      options: { baseURL: "http://localhost:3000/v1", apiKey: { action: "preserve" } },
      models: {
        "demo-model": {
          name: "Demo model",
          limit: { context: 1000, output: 500 },
          modalities: { input: ["text"], output: ["text"] },
          variants: { fast: { temperature: 0.1 } },
        },
      },
    },
  },
  agents: {
    engineer: { model: "local:demo-model" }, goal_lead: { model: "local:demo-model" },
    plan: { model: "local:demo-model" }, build: { model: "local:demo-model" },
    reviewer: { model: "local:demo-model" }, explore: { model: "local:demo-model" },
    librarian: { model: "local:demo-model" }, shaper: { model: "local:demo-model" },
  },
  memory: { enabled: true, minMessages: 5, minContentLength: 1000, cooldownMs: 300000 },
};

const adapterCatalog: ProviderAdapterCatalog = [{
  npmPackage: "@ai-sdk/openai-compatible",
  displayName: "OpenAI-compatible",
  fields: [
    { path: "baseURL", label: "Base URL", kind: "url", required: true, secret: false },
    { path: "apiKey", label: "API key", kind: "string", required: false, secret: true },
  ],
}];

describe("SettingsDialog", () => {
  test("uses the exact Server navigation and no placeholder settings", () => {
    const tree = SettingsNavigation({ activeSection: "models", onSelect: () => {} });
    const labels = findAll(tree, (element) => element.type === "button").map(textContent);

    expect(textContent(tree)).toContain("Server");
    expect(labels).toEqual(["Models", "Agents", "MCP", "Memory", "GitHub"]);
    expect(textContent(tree)).not.toContain("General");
    expect(textContent(tree)).not.toContain("MCP Status");
    expect(textContent(tree)).not.toContain("Providers");
  });

  test("keeps providers and models in one continuous Models surface", () => {
    const tree = SettingsModelsPanel({ config, adapterCatalog, onChange: () => {} });
    const header = findAll(tree, (element) => element.props?.title === "Models")[0];
    expect(header?.props?.description).toBe("Providers and their model profiles are configured together.");
    expect(textContent(tree)).toContain("local");
    const editor = findAll(tree, (element) => element.props?.providerId === "local" && element.props?.modelId === "demo-model");
    expect(editor).toHaveLength(1);
  });

  test("keeps model configuration minimal without behavior capability controls", () => {
    const tree = SettingsModelsPanel({ config, adapterCatalog, onChange: () => {} });
    const content = textContent(tree);
    const editor = findAll(tree, (element) => element.props?.providerId === "local" && element.props?.modelId === "demo-model")[0];

    expect(content).not.toContain("Pricing");
    expect(content).not.toContain("maxRetries");
    expect(content).not.toContain("Multi-tool calls");
    expect(content).not.toContain("Structured tool calls");
    expect(content).not.toContain("Instruction tier");
    expect(editor?.props?.model).toBe(config.provider.local.models["demo-model"]);
  });

  test("locks the three built-in MCP servers while showing live status", () => {
    const servers: Record<string, McpServerStatus> = {
      context7: { state: "ready", toolCount: 4, warningCount: 0 },
      "grep.app": { state: "pending" },
      exa: { state: "failed", error: "unreachable" },
    };
    const tree = SettingsMcpPanel({ config, servers, onChange: () => {} });
    const buttons = findAll(tree, (element) => element.type === "button").map(textContent);

    expect(textContent(tree)).toContain("Built-in");
    expect(textContent(tree)).toContain("Ready");
    expect(textContent(tree)).toContain("Pending");
    expect(textContent(tree)).toContain("Failed");
    expect(textContent(tree)).toContain("4 tools available");
    expect(textContent(tree)).toContain("unreachable");
    expect(buttons).not.toContain("Delete context7");
    expect(buttons).not.toContain("Delete grep.app");
    expect(buttons).not.toContain("Delete exa");
  });

  test("distinguishes live model application from named restart-only sections", () => {
    expect(textContent(SettingsApplyNotice({ modelsAppliedLive: false, restartRequiredSections: [] }))).toBe("");
    expect(textContent(SettingsApplyNotice({ modelsAppliedLive: true, restartRequiredSections: [] }))).toContain("applied live");
    const notice = textContent(SettingsApplyNotice({ modelsAppliedLive: true, restartRequiredSections: ["mcp", "integrations.github"] }));
    expect(notice).toContain("applied live");
    expect(notice).toContain("Restart required for: MCP, GitHub");
  });
});
