import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { ProviderAdapterCatalog } from "@archcode/protocol";
import type { ServerConfigSnapshot } from "../../api/config";
import { DialogRoot } from "../ui/Dialog";
import { SettingsBody as SettingsBodyComponent, SettingsCloseButton } from "./SettingsDialog";

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;

const snapshot: ServerConfigSnapshot = {
  revision: "r1", modelRuntimeRevision: "m1", configPath: "/home/a/.archcode/config.json", restartRequiredSections: [],
  config: {
    provider: { local: { npm: "@ai-sdk/openai-compatible", name: "Local", options: { baseURL: "http://localhost/v1", apiKey: { action: "preserve" }, headers: { Authorization: { action: "preserve" } } }, models: { demo: { name: "Demo", limit: { context: 1000, output: 500 }, modalities: { input: ["text"], output: ["text"] }, variants: { fast: { temperature: 0.1 } } } } } },
    profiles: { principal: { model: "local:demo" }, deep: { model: "local:demo" }, fast: { model: "local:demo" } },
    mcp: { servers: { custom: { url: "https://example.com/mcp", headers: { Authorization: { action: "preserve" } } } } },
  },
};

const adapterCatalog: ProviderAdapterCatalog = [{
  npmPackage: "@ai-sdk/openai-compatible",
  displayName: "OpenAI-compatible",
  fields: [
    { path: "baseURL", label: "Base URL", kind: "url", required: true, secret: false },
    { path: "apiKey", label: "API key", kind: "string", required: false, secret: true },
    { path: "headers", label: "Headers", kind: "json", required: false, secret: true },
    { path: "queryParams", label: "Query parameters", kind: "json", required: false, secret: true },
  ],
}, {
  npmPackage: "@ai-sdk/anthropic",
  displayName: "Anthropic",
  fields: [
    { path: "apiKey", label: "API key", kind: "string", required: false, secret: true },
    { path: "baseURL", label: "Base URL", kind: "url", required: false, secret: false },
  ],
}];

function SettingsBody(props: Omit<ComponentProps<typeof SettingsBodyComponent>, "adapterCatalog">) {
  return <SettingsBodyComponent {...props} adapterCatalog={adapterCatalog} />;
}

function installDom() {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MouseEvent: dom.window.MouseEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, name, { configurable: true, value });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
}
function click(label: string) { const element = [...container.querySelectorAll("button")].find((button) => button.textContent === label); if (!element) throw new Error(`Missing ${label}`); act(() => element.click()); }
function input(label: string, index = 0) {
  const fields = [...container.querySelectorAll("label")].filter((element) => !element.closest("[hidden]") && element.querySelector("span")?.textContent === label);
  const element = fields[index]?.querySelector("input, textarea, select") as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  if (!element) throw new Error(`Missing input ${label}[${index}]`);
  return element;
}
function change(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  act(() => {
    const previous = element.value;
    const prototype = element instanceof dom.window.HTMLSelectElement ? dom.window.HTMLSelectElement.prototype
      : element instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype
      : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
    (element as unknown as { _valueTracker?: { setValue(value: string): void } })._valueTracker?.setValue(previous);
    const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
    const props = propsKey ? (element as unknown as Record<string, { onChange?: (event: { target: typeof element }) => void }>)[propsKey] : undefined;
    if (props?.onChange) props.onChange({ target: element });
    else element.dispatchEvent(new dom.window.Event(element instanceof dom.window.HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
function blur(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
  act(() => {
    const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
    const props = propsKey ? (element as unknown as Record<string, { onBlur?: () => void }>)[propsKey] : undefined;
    if (props?.onBlur) props.onBlur();
    else element.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }));
  });
}
function successfulSaveResponse(restartRequiredSections: ServerConfigSnapshot["restartRequiredSections"] = []) {
  return {
    ...snapshot,
    modelRuntimeRevision: "m2",
    restartRequiredSections,
    config: {
      ...snapshot.config,
      provider: {
        local: {
          ...snapshot.config.provider.local,
          options: {
            ...snapshot.config.provider.local.options,
            apiKey: { configured: true },
            headers: { Authorization: { configured: true } },
          },
        },
      },
      mcp: { servers: { custom: { ...snapshot.config.mcp!.servers.custom, headers: { Authorization: { configured: true } } } } },
    },
  };
}

beforeEach(() => installDom());
afterEach(() => { act(() => root.unmount()); dom.window.close(); });

describe("SettingsDialog interactions", () => {
  test("opens the requested section and follows an external section change", () => {
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} section="profiles" /></DialogRoot>));
    expect(container.textContent).toContain("Principal, deep, and fast model bindings");

    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} section="models" /></DialogRoot>));
    expect(container.textContent).toContain("Providers and their model profiles");
  });

  test("navigates all five server settings sections", () => {
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));
    const sections: Array<[string, string]> = [
      ["Models", "Providers and their model profiles"],
      ["Profiles", "Principal, deep, and fast model bindings"],
      ["MCP", "MCP servers"],
      ["Memory", "Configure extraction thresholds"],
      ["GitHub", "Optional GitHub integration settings"],
    ];

    for (const [label, heading] of sections) {
      click(label);
      expect(container.textContent).toContain(heading);
    }
  });

  test("adds a provider and model while exposing options and variants as JSON", () => {
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));
    click("Add provider");
    expect(container.textContent).toContain("provider-2");
    click("Add model");
    expect(container.textContent).toContain("model-2");
    expect(input("Default options JSON")).not.toBeNull();
    expect(input("Variants JSON")).not.toBeNull();
    expect(container.textContent).not.toContain("Multi-tool calls");
    expect(container.textContent).not.toContain("Structured tool calls");
    expect(container.textContent).not.toContain("Instruction tier");
  });

  test("never overwrites sparse generated provider, model, or MCP identifiers", () => {
    const sparse = structuredClone(snapshot);
    sparse.config.provider["provider-3"] = {
      ...structuredClone(snapshot.config.provider.local),
      name: "Existing provider three",
    };
    sparse.config.provider.local.models["model-3"] = structuredClone(snapshot.config.provider.local.models.demo);
    sparse.config.mcp!.servers["server-3"] = { url: "https://three.example.com/mcp" };
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={sparse} servers={{}} onReload={async () => {}} /></DialogRoot>));

    click("Add provider");
    click("Add model");
    expect(input("Display name", 1).value).toBe("Existing provider three");
    click("MCP");
    click("Add MCP server");

    expect(container.textContent).toContain("provider-4");
    expect(container.textContent).toContain("model-4");
    expect(container.textContent).toContain("server-4");
  });

  test("retains package, output limits, and modalities while omitting pricing and fine-grained call fields", () => {
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));
    expect(input("Provider package").value).toBe("@ai-sdk/openai-compatible");
    expect(input("Output limit").value).toBe("500");
    expect(input("Input modalities").value).toBe("text");
    expect(input("Output modalities").value).toBe("text");
    expect(container.textContent).not.toContain("Multi-tool calls");
    expect(container.textContent).not.toContain("Structured tool calls");
    expect(container.textContent).not.toContain("Instruction tier");
    expect(container.textContent).not.toContain("Pricing");
    expect([...container.querySelectorAll("label")].some((label) => label.querySelector("span")?.textContent === "maxOutputTokens")).toBe(false);
  });

  test("selects packages from the server catalog and preserves adapter-specific advanced options", () => {
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));
    const providerPackage = input("Provider package");
    expect([...providerPackage.querySelectorAll("option")].map((option) => option.value)).toEqual([
      "@ai-sdk/openai-compatible",
      "@ai-sdk/anthropic",
    ]);

    change(providerPackage, "@ai-sdk/anthropic");
    expect(input("Provider package").value).toBe("@ai-sdk/anthropic");
    expect(input("Advanced options JSON").value).toContain("Authorization");
    expect(input("Advanced options JSON").value).toContain("preserve");

    change(input("Provider package"), "@ai-sdk/openai-compatible");
    expect((input("Value for Authorization") as HTMLInputElement).placeholder).toBe("Configured");
  });

  test("keeps a dirty Models draft through navigation and enables save", () => {
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));
    click("Add provider");
    expect(container.textContent).toContain("Unsaved changes");
    expect([...container.querySelectorAll("button")].find((button) => button.textContent === "Save changes")?.disabled).toBe(false);
    click("MCP"); expect(container.textContent).toContain("MCP servers");
    click("Models"); expect(container.textContent).toContain("provider-2");
  });

  test("preserves the draft and reports a revision conflict on save", async () => {
    const fetchMock = mock(async () => Response.json({ error: { code: "CONFIG_REVISION_CONFLICT", message: "Conflict", details: { expected: "r1", current: "r2" } } }, { status: 409 }));
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));
    click("Add provider");
    await act(async () => { click("Save changes"); await Promise.resolve(); });
    expect(container.textContent).toContain("changed elsewhere");
    expect(container.textContent).toContain("provider-2");
  });

  test("renders a server 422 field error without discarding the dirty draft", async () => {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async () => Response.json({
      error: { code: "CONFIG_VALIDATION_ERROR", message: "Invalid configuration", details: { issues: [{ path: "provider.local.options.baseURL", message: "Must be a URL" }] } },
    }, { status: 422 })) });
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));
    click("Add provider");
    await act(async () => { click("Save changes"); await Promise.resolve(); });
    expect(container.textContent).toContain("Must be a URL");
    expect(container.textContent).toContain("provider-2");
  });

  test("reports live-applied Models separately from named restart sections", async () => {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async () => Response.json({
      ...successfulSaveResponse(["mcp", "memory"]),
    })) });
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));
    click("Add provider");
    await act(async () => { click("Save changes"); await Promise.resolve(); });
    expect(container.textContent).toContain("Model and Profile changes applied live");
    expect(container.textContent).toContain("Restart required for: MCP, Memory");
  });

  test("clears a prior live-applied notice before a failed follow-up save", async () => {
    let saveCount = 0;
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async () => {
      saveCount += 1;
      if (saveCount === 1) return Response.json(successfulSaveResponse());
      return Response.json({
        error: { code: "CONFIG_VALIDATION_ERROR", message: "Invalid configuration", details: { issues: [{ path: "provider.local.options.baseURL", message: "Must be a URL" }] } },
      }, { status: 422 });
    }) });
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));

    click("Add provider");
    await act(async () => { click("Save changes"); await Promise.resolve(); });
    expect(container.textContent).toContain("Model and Profile changes applied live");

    click("Add provider");
    await act(async () => { click("Save changes"); await Promise.resolve(); });
    expect(container.textContent).toContain("Must be a URL");
    expect(container.textContent).not.toContain("applied live");
  });

  test("names restart-only sections without claiming a model live-apply", async () => {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async () => Response.json(
      successfulSaveResponse(["memory"]),
    )) });
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));
    click("Memory");
    const enabled = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => enabled.click());
    await act(async () => { click("Save changes"); await Promise.resolve(); });
    expect(container.textContent).toContain("Restart required for: Memory");
    expect(container.textContent).not.toContain("applied live");
  });

  test("submits explicit delete mutations for configured API and header secrets", async () => {
    let request: Record<string, unknown> | undefined;
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async (_url: string, init?: RequestInit) => {
      request = JSON.parse(String(init?.body));
      return Response.json(successfulSaveResponse());
    }) });
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));
    act(() => [...container.querySelectorAll("button")].find((button) => button.textContent === "Clear")!.click());
    act(() => [...container.querySelectorAll("button")].filter((button) => button.textContent === "Clear")[1]!.click());
    await act(async () => { click("Save changes"); await Promise.resolve(); });
    const config = request?.config as typeof snapshot.config;
    const providerOptions = config.provider.local.options as unknown as { apiKey?: unknown; headers?: Record<string, unknown> };
    expect(providerOptions.apiKey).toEqual({ action: "delete" });
    expect(providerOptions.headers?.Authorization).toEqual({ action: "delete" });
  });

  test("keeps unchanged secrets as preserve mutations", async () => {
    let request: Record<string, unknown> | undefined;
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async (_url: string, init?: RequestInit) => {
      request = JSON.parse(String(init?.body));
      return Response.json(successfulSaveResponse());
    }) });
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));
    change(input("Display name"), "Local changed");
    await act(async () => { click("Save changes"); await Promise.resolve(); });
    const config = request?.config as typeof snapshot.config;
    const providerOptions = config.provider.local.options as unknown as { apiKey?: unknown; headers?: Record<string, unknown> };
    expect(providerOptions.apiKey).toEqual({ action: "preserve" });
    expect(providerOptions.headers?.Authorization).toEqual({ action: "preserve" });
    expect(config.mcp?.servers.custom.headers?.Authorization).toEqual({ action: "preserve" });
  });

  test("submits multi-character replacements for every secret collection", async () => {
    let request: Record<string, unknown> | undefined;
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async (_url: string, init?: RequestInit) => {
      request = JSON.parse(String(init?.body));
      return Response.json(successfulSaveResponse());
    }) });
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));
    change(input("API key"), "api-secret-123");
    change(input("Value for Authorization"), "provider-header-123");
    const queryParams = [...container.querySelectorAll("fieldset")].find((fieldset) => fieldset.querySelector("legend")?.textContent === "Query parameters");
    const addQueryParam = [...(queryParams?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Add value");
    if (!addQueryParam) throw new Error("Missing Query parameters Add value");
    act(() => addQueryParam.click());
    change(input("Value for header"), "query-secret-123");
    click("MCP");
    change(input("Value for Authorization"), "mcp-header-123");
    await act(async () => { click("Save changes"); await Promise.resolve(); });
    const config = request?.config as typeof snapshot.config;
    const providerOptions = config.provider.local.options as unknown as { apiKey?: unknown; headers?: Record<string, unknown>; queryParams?: Record<string, unknown> };
    expect(providerOptions.apiKey).toEqual({ action: "replace", value: "api-secret-123" });
    expect(providerOptions.headers?.Authorization).toEqual({ action: "replace", value: "provider-header-123" });
    expect(providerOptions.queryParams?.header).toEqual({ action: "replace", value: "query-secret-123" });
    expect(config.mcp?.servers.custom.headers?.Authorization).toEqual({ action: "replace", value: "mcp-header-123" });
  });

  test("submits deletes for provider query and MCP header secrets", async () => {
    const withQuery = structuredClone(snapshot);
    withQuery.config.provider.local.options.queryParams = { token: { action: "preserve" } };
    let request: Record<string, unknown> | undefined;
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async (_url: string, init?: RequestInit) => {
      request = JSON.parse(String(init?.body));
      return Response.json(successfulSaveResponse());
    }) });
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={withQuery} servers={{}} onReload={async () => {}} /></DialogRoot>));
    change(input("Value for token"), "");
    click("MCP");
    change(input("Value for Authorization"), "");
    await act(async () => { click("Save changes"); await Promise.resolve(); });
    const config = request?.config as typeof snapshot.config;
    const providerOptions = config.provider.local.options as unknown as { queryParams?: Record<string, unknown> };
    expect(providerOptions.queryParams?.token).toEqual({ action: "delete" });
    expect(config.mcp?.servers.custom.headers?.Authorization).toEqual({ action: "delete" });
  });

  test("uses variant keys from the model JSON in the Profile editor", () => {
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));
    change(input("Variants JSON"), JSON.stringify({ deep: { temperature: 0.2 } }));
    click("Profiles");
    expect(input("Model").value).toBe("local:demo");
    expect([...(input("Variant") as HTMLSelectElement).querySelectorAll("option")].map((option) => option.value)).toContain("deep");
  });

  test("locks secret-bearing identities and still renames entries without preserved secrets", () => {
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));
    expect((input("Provider ID") as HTMLInputElement).readOnly).toBe(true);
    click("MCP");
    expect((input("Name") as HTMLInputElement).readOnly).toBe(true);

    const withoutMcpSecrets = structuredClone(snapshot);
    delete withoutMcpSecrets.config.mcp!.servers.custom.headers;
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={withoutMcpSecrets} servers={{}} onReload={async () => {}} /></DialogRoot>));
    click("MCP");
    const name = input("Name");
    change(name, "renamed");
    expect(container.textContent).toContain("Delete custom");
    expect(container.textContent).not.toContain("Delete renamed");
    blur(name);
    expect(container.textContent).toContain("renamed");
    expect(container.textContent).toContain("Delete renamed");
  });

  test("commits model identifiers only after editing finishes", () => {
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));
    const modelId = input("Model ID");

    change(modelId, "renamed-model");
    expect(container.textContent).toContain("local:demo");
    expect(container.textContent).not.toContain("local:renamed-model");
    blur(modelId);

    click("Profiles");
    expect(container.textContent).toContain("local:renamed-model");
  });

  test("renders an exact secret field error path", async () => {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async () => Response.json({
      error: { code: "CONFIG_VALIDATION_ERROR", message: "Invalid configuration", details: { issues: [{ path: "provider.local.options.headers.Authorization", message: "Header is invalid" }] } },
    }, { status: 422 })) });
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));
    change(input("Display name"), "Changed");
    await act(async () => { click("Save changes"); await Promise.resolve(); });
    expect(input("Value for Authorization").closest("label")?.textContent).toContain("Header is invalid");
  });

  test("rejects non-object providerOptions without polluting the draft", () => {
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));
    change(input("Default options JSON"), "[1, 2]");
    expect(container.textContent).toContain("Must be a JSON object");
    expect(container.textContent).toContain("Fix invalid JSON before saving");
  });

  test("preserves incomplete JSON text and blocks saving other changes until it is valid", () => {
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));
    change(input("Display name"), "Changed");
    const options = input("Default options JSON");

    change(options, "{");
    expect(options.value).toBe("{");
    expect(container.textContent).toContain("JSON Parse error");
    expect([...container.querySelectorAll("button")].find((button) => button.textContent === "Save changes")?.disabled).toBe(true);

    change(options, JSON.stringify({ temperature: 0.2 }));
    expect(container.textContent).not.toContain("JSON Parse error");
    expect([...container.querySelectorAll("button")].find((button) => button.textContent === "Save changes")?.disabled).toBe(false);
  });

  test("keeps invalid JSON and the save guard active across section navigation", () => {
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));
    change(input("Display name"), "Changed");
    change(input("Default options JSON"), "{");

    click("MCP");
    expect([...container.querySelectorAll("button")].find((button) => button.textContent === "Save changes")?.disabled).toBe(true);
    click("Models");
    expect(input("Default options JSON").value).toBe("{");
    expect(container.textContent).toContain("Fix invalid JSON before saving");
  });

  test("disables all settings controls while a save request is pending", async () => {
    let resolveSave!: (response: Response) => void;
    const pendingSave = new Promise<Response>((resolve) => { resolveSave = resolve; });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async () => pendingSave) });
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));
    change(input("Display name"), "Changed");

    await act(async () => { click("Save changes"); await Promise.resolve(); });
    expect((container.querySelector("fieldset[data-settings-controls]") as HTMLFieldSetElement).disabled).toBe(true);

    await act(async () => {
      resolveSave(Response.json(successfulSaveResponse()));
      await pendingSave;
      await Promise.resolve();
    });
  });

  test("disables settings controls while the latest snapshot reloads", () => {
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} reloading /></DialogRoot>));
    expect((container.querySelector("fieldset[data-settings-controls]") as HTMLFieldSetElement).disabled).toBe(true);
    expect(container.textContent).toContain("Reloading…");
  });

  test("shows reload failures without hiding the last valid snapshot", () => {
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} reloadError="Unable to reload configuration" /></DialogRoot>));
    expect(input("Display name").value).toBe("Local");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Unable to reload configuration");
  });

  test("maps nested server option errors to the JSON editor", async () => {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async () => Response.json({
      error: { code: "CONFIG_VALIDATION_ERROR", message: "Invalid configuration", details: { issues: [{ path: "provider.local.models.demo.options.temperature", message: "Temperature is invalid" }] } },
    }, { status: 422 })) });
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));
    change(input("Default options JSON"), JSON.stringify({ temperature: 3 }));
    await act(async () => { click("Save changes"); await Promise.resolve(); });
    expect(input("Default options JSON").closest("label")?.textContent).toContain("Temperature is invalid");
  });

  test("invokes onClose from the dialog close button", async () => {
    const onClose = mock(() => {});
    act(() => root.render(<SettingsCloseButton onClose={onClose} />));
    const close = container.querySelector('button[aria-label="Close settings"]') as HTMLButtonElement;
    act(() => close.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });


  test("keeps built-in MCP rows locked in the rendered DOM", () => {
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{ context7: { state: "ready", toolCount: 2, warningCount: 0 } }} onReload={async () => {}} /></DialogRoot>));
    click("MCP");
    expect(container.textContent).toContain("Built-in");
    expect(container.textContent).toContain("Ready");
    expect(container.textContent).toContain("Not reported");
    expect(container.querySelectorAll('[role="status"][aria-label^="MCP status:"]')).toHaveLength(4);
    expect(container.textContent).not.toContain("Delete context7");
    expect(container.textContent).not.toContain("Delete grep.app");
    expect(container.textContent).not.toContain("Delete exa");
  });

  test("renders the schema default as enabled when memory is absent", () => {
    const withoutMemory = { ...snapshot, config: { ...snapshot.config, memory: undefined } };
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={withoutMemory} servers={{}} onReload={async () => {}} /></DialogRoot>));
    click("Memory");
    expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
  });

  test("matches the GitHub enabled default when the integration section exists", () => {
    const withGithub = structuredClone(snapshot);
    withGithub.config.integrations = { github: { tokenEnv: "GITHUB_TOKEN" } };
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={withGithub} servers={{}} onReload={async () => {}} /></DialogRoot>));
    click("GitHub");
    expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
    expect(container.textContent).not.toContain("API base URL");
    expect(container.textContent).not.toContain("https://api.github.com");
  });

});
