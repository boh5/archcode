import { describe, expect, test } from "bun:test";
import type { McpServerStatus, ProviderAdapterCatalog } from "@archcode/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import type { ServerConfig } from "../../api/config";
import {
  SettingsModelsPanel,
  SettingsMcpPanel,
  SettingsNavigation,
  SettingsApplyNotice,
  SettingsSkillsPanel,
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
  profiles: {
    principal: { model: "local:demo-model" },
    deep: { model: "local:demo-model" },
    fast: { model: "local:demo-model" },
  },
  memory: { useMemory: true, autoLearning: true },
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
  test("uses the Server navigation sections", () => {
    const tree = SettingsNavigation({ activeSection: "models", onSelect: () => {} });
    const labels = findAll(tree, (element) => element.type === "button").map(textContent);

    expect(textContent(tree)).toContain("Server");
    expect(labels).toEqual(["Models", "Profiles", "Security", "Runtime Data", "MCP", "Skills", "Memory", "GitHub", "About & Updates"]);
  });

  test("adds Config Recovery while disabling Config-dependent sections", () => {
    const tree = SettingsNavigation({
      activeSection: "config-recovery",
      onSelect: () => {},
      recoveryMode: true,
    });
    const buttons = findAll(tree, (element) => element.type === "button");
    const labels = buttons.map(textContent);

    expect(labels[0]).toBe("Config Recovery");
    expect(buttons.find((button) => textContent(button) === "Config Recovery")?.props?.disabled).toBe(false);
    expect(buttons.find((button) => textContent(button) === "About & Updates")?.props?.disabled).toBe(false);
    expect(buttons.find((button) => textContent(button) === "Models")?.props?.disabled).toBe(true);
    expect(buttons.find((button) => textContent(button) === "Runtime Data")?.props?.disabled).toBe(true);
  });

  test("keeps providers and models in one continuous Models surface", () => {
    const tree = SettingsModelsPanel({ config, adapterCatalog, onChange: () => {} });
    const header = findAll(tree, (element) => element.props?.title === "Providers and models")[0];
    expect(header?.props?.kicker).toBe("Models");
    expect(header?.props?.description).toBe("Configure provider adapters, credentials, model limits, modalities, and variants.");
    expect(textContent(tree)).toContain("local");
    const editor = findAll(tree, (element) => element.props?.providerId === "local" && element.props?.modelId === "demo-model");
    expect(editor).toHaveLength(1);
  });

  test("passes each model record to its editor", () => {
    const tree = SettingsModelsPanel({ config, adapterCatalog, onChange: () => {} });
    const editor = findAll(tree, (element) => element.props?.providerId === "local" && element.props?.modelId === "demo-model")[0];

    expect(editor?.props?.model).toBe(config.provider.local.models["demo-model"]);
  });

  test("locks the three built-in MCP servers while showing live status", () => {
    const servers: Record<string, McpServerStatus> = {
      context7: { state: "ready", toolCount: 4, warningCount: 0, connectedAt: 1 },
      "grep.app": { state: "connecting", startedAt: 1 },
      exa: { state: "failed", error: "unreachable", failedAt: 1 },
    };
    const markup = renderToStaticMarkup(<SettingsMcpPanel config={config} servers={servers} onChange={() => {}} />);

    expect(markup).toContain("Built-in");
    expect(markup).toContain("Ready");
    expect(markup).toContain("Connecting");
    expect(markup).toContain("Failed");
    expect(markup).toContain("4 tools available");
    expect(markup).toContain("unreachable");
    expect(markup).not.toContain("Delete context7");
    expect(markup).not.toContain("Delete grep.app");
    expect(markup).not.toContain("Delete exa");
  });

  test("distinguishes live model application from named restart-only sections", () => {
    expect(textContent(SettingsApplyNotice({ modelsAppliedLive: false, restartRequiredSections: [] }))).toBe("");
    expect(textContent(SettingsApplyNotice({ modelsAppliedLive: true, restartRequiredSections: [] }))).toContain("applied live");
    const notice = textContent(SettingsApplyNotice({ modelsAppliedLive: true, restartRequiredSections: ["integrations.github"] }));
    expect(notice).toContain("applied live");
    expect(notice).toContain("Restart required for: GitHub");
  });

  test("does not claim live application while Runtime is unavailable", () => {
    const notice = textContent(SettingsApplyNotice({
      modelsAppliedLive: false,
      restartRequiredSections: [],
      savedWhileRuntimeUnavailable: true,
    }));

    expect(notice).toContain("Configuration saved");
    expect(notice).toContain("Retry Runtime");
    expect(notice).not.toContain("applied live");
  });

  test("keeps MCP configuration visible while live status is unavailable", () => {
    const markup = renderToStaticMarkup(<SettingsMcpPanel config={config} servers={{}} onChange={() => {}} runtimeAvailable={false} />);

    expect(markup).toContain("Unavailable while Runtime is offline");
    expect(markup).toContain("Unavailable");
    expect(markup).not.toContain("Failed");
  });

  test("does not guess a project for the Skill diagnostics surface", () => {
    const markup = renderToStaticMarkup(<SettingsSkillsPanel />);

    expect(markup).toContain("Project Skills");
    expect(markup).toContain("Open a project to inspect its Skills");
  });
});
