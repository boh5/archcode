import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProviderAdapterCatalog } from "@archcode/protocol";
import type { ServerConfigSnapshot } from "../../api/config";
import type { ServerConfig } from "../../api/config";
import { DialogRoot } from "../ui/Dialog";
import { RuntimeRecoverySettings, SettingsBody as SettingsBodyComponent, SettingsCloseButton } from "./SettingsDialog";
import { SettingsRuntimeDataPanel } from "./SettingsRuntimeDataPanel";
import { ConfigRecoverySettings } from "./ConfigRecoverySettings";

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;

const snapshot: ServerConfigSnapshot = {
  revision: "r1", modelRuntimeRevision: "m1", configPath: "/home/a/.archcode/config.json", restartRequiredSections: [],
  config: {
    provider: { local: { npm: "@ai-sdk/openai-compatible", name: "Local", options: { baseURL: "http://localhost/v1", apiKey: { action: "preserve" }, headers: { Authorization: { action: "preserve" } } }, models: { demo: { name: "Demo", limit: { context: 1000, output: 500 }, modalities: { input: ["text"], output: ["text"] }, variants: { fast: { temperature: 0.1 } } } } } },
    profiles: { principal: { model: "local:demo" }, deep: { model: "local:demo" }, fast: { model: "local:demo" } },
    mcp: { servers: { custom: { type: "http", enabled: true, url: "https://example.com/mcp", headers: { Authorization: { action: "preserve" } } } } },
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
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement, HTMLInputElement: dom.window.HTMLInputElement, DocumentFragment: dom.window.DocumentFragment, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MouseEvent: dom.window.MouseEvent, PointerEvent: dom.window.PointerEvent ?? dom.window.MouseEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, name, { configurable: true, value });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
}
function click(label: string) { const element = [...container.querySelectorAll("button")].find((button) => button.textContent === label); if (!element) throw new Error(`Missing ${label}`); act(() => element.click()); }
function input(label: string, index = 0) {
  const fields = [...container.querySelectorAll("label")].filter((element) => !element.closest("[hidden]") && element.querySelector("span")?.textContent === label);
  const element = fields[index]?.querySelector("input, textarea, select") as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  if (!element) throw new Error(`Missing input ${label}[${index}]`);
  return element;
}
function modality(label: "Input modalities" | "Output modalities", value: "text" | "image" | "audio" | "video") {
  const element = container.querySelector(`input[aria-label="${label}: ${value}"]`) as HTMLInputElement | null;
  if (!element) throw new Error(`Missing modality ${label}: ${value}`);
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
async function waitForText(expected: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (container.textContent?.includes(expected)) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  throw new Error(`Timed out waiting for ${expected}`);
}
function successfulSaveResponse(restartRequiredSections: ServerConfigSnapshot["restartRequiredSections"] = []) {
  return {
    ...snapshot,
    modelRuntimeRevision: "m2",
    restartRequiredSections,
    mcpApply: { state: "applied" as const, status: { servers: {} } },
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
      mcp: { servers: { custom: { type: "http" as const, enabled: true, url: "https://example.com/mcp", headers: { Authorization: { configured: true } } } } },
    },
  };
}

function customHttpServer(config: ServerConfig) {
  const server = config.mcp?.servers.custom;
  if (server?.type !== "http") throw new Error("Expected custom HTTP MCP server");
  return server;
}

beforeEach(() => installDom());
afterEach(() => { act(() => root.unmount()); dom.window.close(); });

describe("SettingsDialog interactions", () => {
  test("keeps the apply notice and Settings workspace inside one bounded column", () => {
    const withNotice = structuredClone(snapshot);
    withNotice.restartRequiredSections = ["integrations.github"];
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={withNotice} servers={{}} onReload={async () => {}} /></DialogRoot>));

    const layout = container.querySelector("[data-settings-layout]") as HTMLElement;
    const workspace = container.querySelector("[data-settings-workspace]") as HTMLElement;
    expect(layout.className).toContain("flex-col");
    expect(layout.className).toContain("h-full");
    expect(workspace.className).toContain("flex-1");
    expect(workspace.className).toContain("min-h-0");
    expect(workspace.className).not.toContain("h-full");
  });

  test("opens the requested section and follows an external section change", () => {
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} section="profiles" /></DialogRoot>));
    expect(container.textContent).toContain("Principal, deep, and fast model bindings");

    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} section="models" /></DialogRoot>));
    expect(container.textContent).toContain("Providers and models");
  });

  test("navigates all server settings sections", () => {
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));
    const sections: Array<[string, string]> = [
      ["Models", "Providers and models"],
      ["Profiles", "Principal, deep, and fast model bindings"],
      ["MCP", "MCP servers"],
      ["Skills", "Open a project to inspect its Skills"],
      ["Memory", "Control prompt recall and background learning"],
      ["GitHub", "Optional GitHub integration settings"],
    ];

    for (const [label, heading] of sections) {
      click(label);
      expect(container.textContent).toContain(heading);
    }
  });

  test("reloads the Config snapshot after changing the auth credential", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: mock(async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        if (url === "/api/auth/status") {
          return Response.json({ required: true });
        }
        if (url === "/api/auth/password") {
          return Response.json({ required: true });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    });
    const onReload = mock(async () => {});
    act(() => root.render(
      <DialogRoot open>
        <SettingsBody snapshot={snapshot} servers={{}} onReload={onReload} />
      </DialogRoot>,
    ));

    await act(async () => {
      click("Security");
      await Promise.resolve();
    });
    const changeButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Change password") as HTMLButtonElement;
    expect(changeButton.disabled).toBe(true);

    change(input("Current password"), "current password");
    change(input("New password"), "replacement password");
    change(input("Confirm password"), "replacement password");
    expect(changeButton.disabled).toBe(false);

    await act(async () => {
      changeButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(requests.map(({ url }) => url)).toEqual([
      "/api/auth/status",
      "/api/auth/password",
    ]);
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      action: "change",
      currentPassword: "current password",
      password: "replacement password",
    });
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(input("Current password").value).toBe("");
    expect(changeButton.disabled).toBe(true);
  });

  test("locks Config editing and navigation while a password mutation is pending", async () => {
    let resolvePassword!: (response: Response) => void;
    const passwordResponse = new Promise<Response>((resolve) => { resolvePassword = resolve; });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: mock(async (url: string) => {
        if (url === "/api/auth/status") return Response.json({ required: true });
        if (url === "/api/auth/password") return await passwordResponse;
        throw new Error(`Unexpected request: ${url}`);
      }),
    });
    const onReload = mock(async () => {});
    act(() => root.render(
      <DialogRoot open>
        <SettingsBody snapshot={snapshot} servers={{}} onReload={onReload} section="security" />
      </DialogRoot>,
    ));

    await waitForText("Login is required");
    change(input("Current password"), "current password");
    change(input("New password"), "replacement password");
    change(input("Confirm password"), "replacement password");
    const changeButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Change password") as HTMLButtonElement;

    act(() => changeButton.click());
    await act(async () => { await Promise.resolve(); });

    const controls = container.querySelector("[data-settings-controls]") as HTMLFieldSetElement;
    const review = container.querySelector('input[aria-label="AI approval review"]') as HTMLInputElement;
    const models = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Models") as HTMLButtonElement;
    expect(controls.disabled).toBe(true);
    expect(models.disabled).toBe(true);
    expect(review.matches(":disabled")).toBe(true);
    act(() => review.click());
    expect(review.checked).toBe(true);
    expect(container.textContent).not.toContain("Unsaved changes");

    await act(async () => {
      resolvePassword(Response.json({ required: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onReload).toHaveBeenCalledTimes(1);
    expect((container.querySelector("[data-settings-controls]") as HTMLFieldSetElement).disabled).toBe(false);
    expect([...container.querySelectorAll("button")].find((button) => button.textContent === "Models")?.disabled).toBe(false);
  });

  test("keeps Auto-review in the shared Config draft and protects password mutations while dirty", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: mock(async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        if (url === "/api/auth/status") return Response.json({ required: true });
        if (url === "/api/config") {
          return Response.json({
            ...successfulSaveResponse(),
            config: { ...snapshot.config, permissions: { autoReview: false } },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    });
    const onReload = mock(async () => {});
    act(() => root.render(
      <DialogRoot open>
        <SettingsBody snapshot={snapshot} servers={{}} onReload={onReload} section="security" />
      </DialogRoot>,
    ));

    await waitForText("AI approval review");
    await waitForText("Login is required");
    const review = container.querySelector('input[aria-label="AI approval review"]') as HTMLInputElement;
    expect(review.checked).toBe(true);

    act(() => review.click());
    expect(review.checked).toBe(false);
    expect(container.textContent).toContain("Unsaved changes");

    change(input("Current password"), "current password");
    change(input("New password"), "replacement password");
    change(input("Confirm password"), "replacement password");
    const changeButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Change password") as HTMLButtonElement;
    const removeButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Remove password") as HTMLButtonElement;
    expect(changeButton.disabled).toBe(true);
    expect(container.textContent).toContain("Save or Reload your Config draft before changing the server password.");

    await act(async () => {
      click("Save changes");
      await Promise.resolve();
      await Promise.resolve();
    });

    const configRequest = requests.find((request) => request.url === "/api/config");
    expect(configRequest).toBeDefined();
    const body = JSON.parse(String(configRequest?.init?.body)) as { password?: unknown; config?: { permissions?: { autoReview?: boolean } } };
    expect(body.config?.permissions?.autoReview).toBe(false);
    expect(body.password).toBeUndefined();
    expect(requests.map(({ url }) => url)).not.toContain("/api/auth/password");
    expect(review.closest("label")?.className).toContain("[@media(pointer:coarse)]:min-h-11");
    expect(changeButton.className).toContain("[@media(pointer:coarse)]:min-h-11");
    expect(removeButton.className).toContain("[@media(pointer:coarse)]:min-h-11");
  });

  test("reload restores the server Auto-review value and clears the dirty password guard", async () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: mock(async (url: string) => {
        if (url === "/api/auth/status") return Response.json({ required: true });
        throw new Error(`Unexpected request: ${url}`);
      }),
    });
    const onReload = mock(async () => {});
    act(() => root.render(
      <DialogRoot open>
        <SettingsBody snapshot={snapshot} servers={{}} onReload={onReload} section="security" />
      </DialogRoot>,
    ));

    await waitForText("AI approval review");
    await waitForText("Login is required");
    const review = container.querySelector('input[aria-label="AI approval review"]') as HTMLInputElement;
    act(() => review.click());
    expect(container.textContent).toContain("Unsaved changes");

    const serverSnapshot = structuredClone(snapshot);
    serverSnapshot.config.permissions = { autoReview: true };
    await act(async () => {
      click("Reload");
      root.render(
        <DialogRoot open>
          <SettingsBody snapshot={serverSnapshot} servers={{}} onReload={onReload} section="security" />
        </DialogRoot>,
      );
      await Promise.resolve();
    });

    expect((container.querySelector('input[aria-label="AI approval review"]') as HTMLInputElement).checked).toBe(true);
    expect(container.textContent).toContain("All changes saved");
    change(input("Current password"), "current password");
    change(input("New password"), "replacement password");
    change(input("Confirm password"), "replacement password");
    const changeButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Change password") as HTMLButtonElement;
    expect(changeButton.disabled).toBe(false);
  });

  test("adds a provider and model while exposing options and variants as JSON", () => {
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));
    click("Add provider");
    expect(container.textContent).toContain("provider-2");
    click("Add model");
    expect(container.textContent).toContain("model-2");
    expect(input("Default options JSON")).not.toBeNull();
    expect(input("Variants JSON")).not.toBeNull();
  });

  test("never overwrites sparse generated provider, model, or MCP identifiers", () => {
    const sparse = structuredClone(snapshot);
    sparse.config.provider["provider-3"] = {
      ...structuredClone(snapshot.config.provider.local),
      name: "Existing provider three",
    };
    sparse.config.provider.local.models["model-3"] = structuredClone(snapshot.config.provider.local.models.demo);
    sparse.config.mcp!.servers["server-3"] = { type: "http", enabled: true, url: "https://three.example.com/mcp" };
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

  test("edits package, output limits, and modalities", () => {
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));
    expect(input("Provider package").value).toBe("@ai-sdk/openai-compatible");
    expect(input("Output limit").value).toBe("500");
    expect(modality("Input modalities", "text").checked).toBe(true);
    expect(modality("Input modalities", "image").checked).toBe(false);
    expect(modality("Output modalities", "text").checked).toBe(true);
    expect(modality("Output modalities", "image").checked).toBe(false);
    expect(modality("Input modalities", "text").disabled).toBe(true);
  });

  test("selects model modalities without comma-delimited text editing", () => {
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));

    act(() => modality("Input modalities", "image").click());
    expect(modality("Input modalities", "text").checked).toBe(true);
    expect(modality("Input modalities", "text").disabled).toBe(false);
    expect(modality("Input modalities", "image").checked).toBe(true);

    act(() => modality("Input modalities", "text").click());
    expect(modality("Input modalities", "text").checked).toBe(false);
    expect(modality("Input modalities", "image").checked).toBe(true);
    expect(modality("Input modalities", "image").disabled).toBe(true);
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
    expect(container.querySelector("footer [role=\"alert\"]")?.textContent)
      .toBe("Configuration validation failed: Must be a URL");
    expect(container.textContent).toContain("provider-2");
  });

  test("reports live-applied Models separately from named restart sections", async () => {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async () => Response.json({
      ...successfulSaveResponse(["integrations.github"]),
    })) });
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));
    click("Add provider");
    await act(async () => { click("Save changes"); await Promise.resolve(); });
    expect(container.textContent).toContain("Model and Profile changes applied live");
    expect(container.textContent).toContain("Restart required for: GitHub");
  });

  test("keeps the saved-but-MCP-apply-failed outcome through the matching reload", async () => {
    const response = {
      ...successfulSaveResponse(),
      revision: "r2",
      mcpApply: { state: "failed" as const, error: "Connection refused", status: { servers: {} } },
    };
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async () => Response.json(response)) });
    const reloaded = { ...snapshot, revision: "r2" };
    const onReload = async () => {
      root.render(<DialogRoot open><SettingsBody snapshot={reloaded} servers={{}} onReload={onReload} /></DialogRoot>);
    };
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={onReload} /></DialogRoot>));

    click("Add provider");
    await act(async () => { click("Save changes"); await Promise.resolve(); await Promise.resolve(); });

    expect(container.querySelector("footer [role=\"alert\"]")?.textContent)
      .toBe("Configuration saved, but MCP live apply failed: Connection refused");
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

  test("clears the Runtime-unavailable save notice when a newer snapshot arrives", async () => {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async () => Response.json(
      successfulSaveResponse(),
    )) });
    const runtime = { state: "error" as const, error: { message: "Runtime unavailable", recoveryAllowed: true } };
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} runtime={runtime} onReload={async () => {}} /></DialogRoot>));

    click("Add provider");
    await act(async () => { click("Save changes"); await Promise.resolve(); });
    expect(container.textContent).toContain("Configuration saved. Retry Runtime to use the saved configuration.");

    const newerSnapshot = { ...snapshot, revision: "r2" };
    await act(async () => {
      root.render(<DialogRoot open><SettingsBody snapshot={newerSnapshot} servers={{}} runtime={runtime} onReload={async () => {}} /></DialogRoot>);
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain("Configuration saved. Retry Runtime to use the saved configuration.");
  });

  test("saves Memory switches without exposing obsolete extraction thresholds", async () => {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async () => Response.json(
      successfulSaveResponse([]),
    )) });
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));
    click("Memory");
    const enabled = container.querySelector('input[aria-label="Use Memory"]') as HTMLInputElement;
    act(() => enabled.click());
    await act(async () => { click("Save changes"); await Promise.resolve(); });
    expect(container.textContent).not.toContain("Restart required for: Memory");
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
    expect(customHttpServer(config).headers?.Authorization).toEqual({ action: "preserve" });
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
    expect(customHttpServer(config).headers?.Authorization).toEqual({ action: "replace", value: "mcp-header-123" });
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
    expect(customHttpServer(config).headers?.Authorization).toEqual({ action: "delete" });
  });

  test("uses variant keys from the model JSON in the Profile editor", () => {
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));
    change(input("Variants JSON"), JSON.stringify({ deep: { temperature: 0.2 } }));
    click("Profiles");
    expect(input("Model").value).toBe("local:demo");
    expect([...(input("Variant") as HTMLSelectElement).querySelectorAll("option")].map((option) => option.value)).toContain("deep");
  });

  test("saves missing Profile variant references and marks Profiles for attention", async () => {
    const referenced = structuredClone(snapshot);
    referenced.config.profiles.principal.variant = "fast";
    referenced.config.profiles.deep.variant = "fast";
    let request: Record<string, unknown> | undefined;
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async (_url: string, init?: RequestInit) => {
      request = JSON.parse(String(init?.body));
      const submitted = request?.config as typeof snapshot.config;
      const response = successfulSaveResponse();
      response.config.provider.local.models.demo.variants = structuredClone(submitted.provider.local.models.demo.variants);
      response.config.profiles = structuredClone(submitted.profiles);
      return Response.json(response);
    }) });
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={referenced} servers={{}} onReload={async () => {}} /></DialogRoot>));

    change(input("Variants JSON"), JSON.stringify({ high: { temperature: 0.2 } }));
    const profilesButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Profiles");
    expect(profilesButton?.getAttribute("data-invalid-count")).toBe("2");
    expect(profilesButton?.getAttribute("aria-label")).toBe("Profiles, 2 variant references need attention");

    click("Profiles");
    expect(container.textContent).toContain('Variant "fast" no longer exists. This Profile is using the model default.');
    expect(input("Variant").getAttribute("aria-invalid")).toBe("true");
    expect(input("Variant").value).toBe("fast");
    const principalSummary = [...container.querySelectorAll("summary")].find((summary) => summary.textContent?.includes("principal"));
    expect(principalSummary?.getAttribute("aria-label")).toBe('principal, local:demo, variant "fast" is missing; using model default');

    await act(async () => { click("Save changes"); await Promise.resolve(); });
    const config = request?.config as typeof snapshot.config;
    expect(config.profiles.principal.variant).toBe("fast");
    expect(config.profiles.deep.variant).toBe("fast");
    expect(profilesButton?.getAttribute("data-invalid-count")).toBe("2");
    expect(input("Variant").value).toBe("fast");
  });

  test("locks secret-bearing identities and still renames entries without preserved secrets", () => {
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));
    expect((input("Provider ID") as HTMLInputElement).readOnly).toBe(true);
    click("MCP");
    expect((input("Name") as HTMLInputElement).readOnly).toBe(true);
    expect((input("Transport") as HTMLSelectElement).disabled).toBe(true);

    const withoutMcpSecrets = structuredClone(snapshot);
    const serverWithoutSecrets = withoutMcpSecrets.config.mcp!.servers.custom;
    if (serverWithoutSecrets.type === "http") delete serverWithoutSecrets.headers;
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
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{ context7: { state: "ready", toolCount: 2, warningCount: 0, connectedAt: 1 } }} onReload={async () => {}} /></DialogRoot>));
    click("MCP");
    expect(container.textContent).toContain("Built-in");
    expect(container.textContent).toContain("Ready");
    expect(container.textContent).toContain("Not reported");
    expect(container.querySelectorAll('[role="status"][aria-label^="MCP status:"]')).toHaveLength(4);
    expect(container.textContent).not.toContain("Delete context7");
    expect(container.textContent).not.toContain("Delete grep.app");
    expect(container.textContent).not.toContain("Delete exa");
  });

  test("offers draft Test for built-ins but blocks Reconnect while disabled", () => {
    const disabled = structuredClone(snapshot);
    disabled.config.mcp!.disabledBuiltins = ["context7"];
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={disabled} servers={{ context7: { state: "disabled", updatedAt: 1 } }} onReload={async () => {}} /></DialogRoot>));
    click("MCP");

    const row = [...container.querySelectorAll("article")].find((article) => article.querySelector("h2")?.textContent === "context7");
    if (!row) throw new Error("Missing context7 MCP row");
    const testButton = [...row.querySelectorAll("button")].find((button) => button.textContent === "Test draft") as HTMLButtonElement;
    const reconnectButton = [...row.querySelectorAll("button")].find((button) => button.textContent === "Reconnect") as HTMLButtonElement;

    expect(testButton.disabled).toBe(false);
    expect(reconnectButton.disabled).toBe(true);
    expect(reconnectButton.title).toContain("Enable and save");
  });

  test("drops blank STDIO argument lines from the draft", () => {
    const stdio = structuredClone(snapshot);
    stdio.config.mcp!.servers.custom = {
      type: "stdio",
      enabled: true,
      command: "mcp-server",
      args: [],
    };
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={stdio} servers={{}} onReload={async () => {}} /></DialogRoot>));
    click("MCP");

    const args = input("Arguments (one per line)");
    change(args, "--first\n\n   \n--second\n");
    expect(input("Arguments (one per line)").value).toBe("--first\n--second");
  });

  test("aborts an in-flight MCP draft test when leaving the panel", async () => {
    let draftSignal: AbortSignal | undefined;
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async (url: string, init?: RequestInit) => {
      if (url === "/api/mcp/inventory") return Response.json({ servers: {} });
      if (url === "/api/mcp/test/custom") {
        draftSignal = init?.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) => {
          draftSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) });
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));
    click("MCP");
    const customRow = [...container.querySelectorAll("article")]
      .find((article) => article.querySelector("h2")?.textContent === "custom");
    const testButton = [...(customRow?.querySelectorAll("button") ?? [])]
      .find((button) => button.textContent === "Test draft");
    if (!testButton) throw new Error("Missing custom MCP Test draft button");
    act(() => testButton.click());
    await act(async () => { await Promise.resolve(); });
    expect(draftSignal?.aborted).toBe(false);

    click("Models");
    await act(async () => { await Promise.resolve(); });
    expect(draftSignal?.aborted).toBe(true);
  });

  test("aborts an in-flight MCP draft test when its config changes", async () => {
    let draftSignal: AbortSignal | undefined;
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async (url: string, init?: RequestInit) => {
      if (url === "/api/mcp/inventory") return Response.json({ servers: {} });
      if (url === "/api/mcp/test/custom") {
        draftSignal = init?.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) => {
          draftSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) });
    act(() => root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} onReload={async () => {}} /></DialogRoot>));
    click("MCP");
    const customRow = [...container.querySelectorAll("article")]
      .find((article) => article.querySelector("h2")?.textContent === "custom");
    const testButton = [...(customRow?.querySelectorAll("button") ?? [])]
      .find((button) => button.textContent === "Test draft");
    if (!testButton) throw new Error("Missing custom MCP Test draft button");
    act(() => testButton.click());
    await act(async () => { await Promise.resolve(); });
    expect(draftSignal?.aborted).toBe(false);

    change(input("HTTP URL"), "https://changed.example.com/mcp");
    await act(async () => { await Promise.resolve(); });
    expect(draftSignal?.aborted).toBe(true);
  });

  test("shows complete project Skill diagnostics and Prompt projection", async () => {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async (url: string) => {
      expect(url).toBe("/api/projects/demo/skills");
      return Response.json({
        items: [
          { name: "included", source: "project-archcode", winner: true, shadowed: false, valid: true, description: "Included guidance" },
          { name: "omitted", source: "builtin", winner: true, shadowed: false, valid: true, description: "Omitted guidance" },
          { name: "broken", source: "user-agents", winner: true, shadowed: false, valid: false, diagnostic: { code: "SKILL_INVALID_PACKAGE", message: "Invalid frontmatter" } },
        ],
        promptProjection: {
          includedEntries: [{ name: "included", source: "project-archcode", description: "Included guidance" }],
          omittedCount: 1,
          renderedText: "included: Included guidance",
          byteLength: 27,
        },
      });
    }) });

    await act(async () => {
      root.render(<DialogRoot open><SettingsBody snapshot={snapshot} servers={{}} projectSlug="demo" section="skills" onReload={async () => {}} /></DialogRoot>);
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitForText("Discovered packages");

    expect(container.textContent).toContain("1 included · 1 omitted · 27 bytes");
    expect(container.textContent).toContain("Project .archcode");
    expect(container.textContent).toContain("Prompt omitted");
    expect(container.textContent).toContain("Invalid frontmatter");
    expect(container.textContent).not.toContain("sourceLabel");
    expect(container.querySelectorAll('[data-settings-skills] input[type="checkbox"]')).toHaveLength(0);
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
  });

  test("keeps Runtime Data unselected by default and enables only an affected project", async () => {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async () => Response.json({
      projects: [{
        projectSlug: "healthy",
        name: "Healthy",
        workspace: "/work/healthy",
        runtimePath: "/work/healthy/.archcode/runtime",
        stats: { fileCount: 2, totalBytes: 512 },
        issues: [],
      }, {
        projectSlug: "broken",
        name: "Broken",
        workspace: "/work/broken",
        runtimePath: "/work/broken/.archcode/runtime",
        stats: { fileCount: 4, totalBytes: 2048 },
        issues: [{ relativePath: "sessions/root/session.json", reason: "invalid_current_schema", schemaIssues: [{ path: ["messages", 0], message: "Invalid message" }] }],
      }],
    })) });

    await act(async () => {
      root.render(<SettingsRuntimeDataPanel runtime={{ state: "error", error: { message: "Runtime failed safely", recoveryAllowed: true } }} onRefreshRuntime={async () => {}} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const checkboxes = [...container.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]?.disabled).toBe(true);
    expect(checkboxes[1]?.disabled).toBe(false);
    expect(checkboxes.every((checkbox) => !checkbox.checked)).toBe(true);
    expect(container.textContent).toContain("Does not match the current ArchCode data format");
    expect(container.textContent).toContain("Invalid message");
    expect(([...container.querySelectorAll("button")].find((button) => button.textContent === "Delete runtime data") as HTMLButtonElement).disabled).toBe(true);
  });

  test("keeps inspection available but disables in-process recovery after incomplete cleanup", async () => {
    const requests: Array<{ url: string; method?: string }> = [];
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async (url: string, init?: RequestInit) => {
      requests.push({ url, method: init?.method });
      return Response.json({
        projects: [{
          projectSlug: "broken",
          name: "Broken",
          workspace: "/work/broken",
          runtimePath: "/work/broken/.archcode/runtime",
          stats: { fileCount: 4, totalBytes: 2048 },
          issues: [{ relativePath: "todos/state.json", reason: "invalid_json" }],
        }],
      });
    }) });

    await act(async () => {
      root.render(<SettingsRuntimeDataPanel runtime={{ state: "error", error: { message: "Runtime cleanup did not finish", recoveryAllowed: false } }} onRefreshRuntime={async () => {}} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("todos/state.json");
    expect(container.textContent).toContain("ArchCode must be restarted. Runtime cannot be retried and Runtime data cannot be deleted in this process.");
    expect(container.textContent).toContain("Deletion is unavailable until ArchCode is restarted.");
    expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).disabled).toBe(true);
    const retryButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry Runtime") as HTMLButtonElement;
    const deleteButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Delete runtime data") as HTMLButtonElement;
    expect(retryButton.disabled).toBe(true);
    expect(deleteButton.disabled).toBe(true);
    act(() => {
      retryButton.click();
      deleteButton.click();
    });
    expect(requests).toEqual([{ url: "/api/runtime-data", method: undefined }]);
  });

  test("shows a Runtime retry failure returned by the control plane", async () => {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return Response.json({ state: "error", error: { message: "Runtime still cannot load project data.", recoveryAllowed: true } });
      return Response.json({ projects: [] });
    }) });
    const onRefreshRuntime = mock(async () => {});

    await act(async () => {
      root.render(<SettingsRuntimeDataPanel runtime={{ state: "error", error: { message: "Initial failure", recoveryAllowed: true } }} onRefreshRuntime={onRefreshRuntime} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry Runtime")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect([...container.querySelectorAll('[role="alert"]')].some((alert) => alert.textContent?.includes("Runtime still cannot load project data."))).toBe(true);
    expect(onRefreshRuntime).toHaveBeenCalledTimes(1);
    expect(document.activeElement?.textContent).toBe("Runtime Data");
  });

  test("shows Runtime inspection loading before an empty result", async () => {
    let resolveInspection!: (response: Response) => void;
    const pendingInspection = new Promise<Response>((resolve) => { resolveInspection = resolve; });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async () => pendingInspection) });

    await act(async () => {
      root.render(<SettingsRuntimeDataPanel runtime={{ state: "error", error: { message: "Runtime failed", recoveryAllowed: true } }} onRefreshRuntime={async () => {}} />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Inspecting registered projects…");

    await act(async () => {
      resolveInspection(Response.json({ projects: [] }));
      await pendingInspection;
      await Promise.resolve();
    });
    expect(container.textContent).toContain("No registered project Runtime data was found.");
  });

  test("keeps an inspection failure inline with a retry action", async () => {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async () => Response.json({
      error: { code: "RUNTIME_DATA_INSPECTION_FAILED", message: "Inspection service is unavailable." },
    }, { status: 500 })) });

    await act(async () => {
      root.render(<SettingsRuntimeDataPanel runtime={{ state: "error", error: { message: "Runtime failed", recoveryAllowed: true } }} onRefreshRuntime={async () => {}} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect([...container.querySelectorAll('[role="alert"]')].some((alert) => alert.textContent?.includes("Inspection service is unavailable."))).toBe(true);
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Retry inspection")).toBe(true);
  });

  test("announces a successful Runtime retry", async () => {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return Response.json({ state: "ready" });
      return Response.json({ projects: [] });
    }) });
    const onRefreshRuntime = mock(async () => {});

    await act(async () => {
      root.render(<SettingsRuntimeDataPanel runtime={{ state: "error", error: { message: "Initial failure", recoveryAllowed: true } }} onRefreshRuntime={onRefreshRuntime} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry Runtime")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Runtime is ready.");
    expect(onRefreshRuntime).toHaveBeenCalledTimes(1);
  });

  test("keeps every Settings section reachable from Runtime recovery", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const updateStatus = {
      currentVersion: "0.0.8",
      phase: "idle",
      managed: false,
      restartSupported: true,
      updateAvailable: false,
      restartRequired: false,
    } as const;
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async (url: string) => {
      if (url === "/api/runtime-data") return Response.json({ projects: [] });
      if (url === "/api/config") return Response.json(successfulSaveResponse());
      if (url === "/api/config/provider-adapters") return Response.json(adapterCatalog);
      if (url === "/api/auth/status") return Response.json({ required: false });
      if (url === "/api/update") return Response.json(updateStatus);
      throw new Error(`Unexpected request: ${url}`);
    }) });

    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><RuntimeRecoverySettings runtime={{ state: "error", error: { message: "Runtime failed", recoveryAllowed: true } }} onRefreshRuntime={async () => {}} /></QueryClientProvider>);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-settings-section="runtime-data"]')).not.toBeNull();

    click("Models");
    await waitForText("Providers and models");
    const destinations: Array<[string, string]> = [
      ["Profiles", "Principal, deep, and fast model bindings"],
      ["Security", "Manage the one password"],
      ["MCP", "MCP servers"],
      ["Memory", "Control prompt recall and background learning"],
      ["GitHub", "Optional GitHub integration settings"],
    ];
    for (const [label, expected] of destinations) {
      click(label);
      await waitForText(expected);
    }
    click("About & Updates");
    await waitForText("About & Updates");
    expect(container.textContent).toContain("Install releases signed by the official ArchCode workflow, then restart when the Runtime is idle.");
    expect(container.textContent).not.toContain("preserve Runtime data");
    queryClient.clear();
  });

  test("retries Config while keeping Updates available through the recovery grant", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const onTransition = mock(() => undefined);
    const requests: Array<{ url: string; method: string; authorization: string | null; body?: string }> = [];
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url,
        method: init?.method ?? "GET",
        authorization: headers.get("Authorization"),
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      if (url === "/api/config-recovery") return Response.json({
        configPath: "/Users/test/.archcode/config.json",
        issues: [{ path: "configuration", message: "This value does not match the current ArchCode configuration format." }],
      });
      if (url === "/api/config-recovery/retry") return Response.json({
        status: { mode: "config_error", message: "Config remains invalid." },
        recovery: {
          configPath: "/Users/test/.archcode/config.json",
          issues: [{ path: "profiles.fast.model", message: "This value does not match the current ArchCode configuration format." }],
        },
      });
      if (url === "/api/update") return Response.json({
        currentVersion: "0.0.8",
        phase: "idle",
        managed: false,
        restartSupported: false,
        updateAvailable: false,
        restartRequired: false,
      });
      throw new Error(`Unexpected request: ${url}`);
    }) });

    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><ConfigRecoverySettings grant="recovery-token" onTransition={onTransition} /></QueryClientProvider>);
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitForText("/Users/test/.archcode/config.json");
    expect((container.querySelector("button[aria-label^='Models, unavailable']") as HTMLButtonElement).disabled).toBe(true);

    await act(async () => { click("Retry configuration"); await Promise.resolve(); });
    await waitForText("still invalid");
    expect(container.textContent).toContain("profiles.fast.model");
    expect(document.activeElement?.textContent).toBe("Config Recovery");

    click("About & Updates");
    await waitForText("About & Updates");
    expect(requests.find((request) => request.url === "/api/update")?.authorization).toBe("Bearer recovery-token");
    queryClient.clear();
  });

});
