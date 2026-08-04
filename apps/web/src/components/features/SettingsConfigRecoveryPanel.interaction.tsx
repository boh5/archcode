import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: { configurable: true, value: () => {} },
    detachEvent: { configurable: true, value: () => {} },
  });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    DocumentFragment: dom.window.DocumentFragment,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    MouseEvent: dom.window.MouseEvent,
    PointerEvent: dom.window.PointerEvent ?? dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) Object.defineProperty(globalThis, name, { configurable: true, value });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  dom.window.close();
});

describe("Settings Config Recovery interactions", () => {
  test("requires selection and confirmation before removing only invalid items", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (url === "/api/config-recovery") return Response.json({
        configPath: "/Users/test/.archcode/config.json",
        revision: "revision-sentinel-1234",
        issues: [{ path: "configuration", message: "This value does not match the current ArchCode configuration format." }],
        removableItems: [{
          id: "abcdefghijklmnopqrstuv",
          label: "Invalid configuration field",
          path: "configuration",
          impact: "Removes this invalid field only. Other valid settings remain configured.",
        }],
      });
      if (url === "/api/config-recovery/remove-items") return Response.json({
        status: { mode: "ready", authRequired: false, authenticated: true, runtime: { state: "activating" } },
      });
      throw new Error(`Unexpected request: ${url}`);
    }) });
    const onTransition = mock(() => undefined);
    const { SettingsConfigRecoveryPanel } = await import("./SettingsConfigRecoveryPanel");

    await act(async () => {
      root.render(<SettingsConfigRecoveryPanel grant="recovery-token" onTransition={onTransition} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitForText("Preserve valid settings", container);
    const removeButton = findButton("Remove selected invalid items", container);
    expect(removeButton.disabled).toBe(true);

    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => { checkbox.click(); });
    expect(removeButton.disabled).toBe(false);
    await click("Remove selected invalid items", container);
    expect(document.body.textContent).toContain("only if the entire remaining Config is valid");
    expect(document.body.textContent).toContain("Removing the selected entries is permanent");
    await click("Cancel", document.body);
    expect(requests.filter((request) => request.url === "/api/config-recovery/remove-items")).toHaveLength(0);

    await click("Remove selected invalid items", container);
    await click("Remove selected items", document.body);
    const removal = requests.find((request) => request.url === "/api/config-recovery/remove-items");
    expect(removal).toBeDefined();
    expect(new Headers(removal!.init?.headers).get("Authorization")).toBe("Bearer recovery-token");
    expect(removal!.init?.body).toBe(JSON.stringify({
      expectedRevision: "revision-sentinel-1234",
      itemIds: ["abcdefghijklmnopqrstuv"],
      confirmation: "REMOVE_SELECTED_INVALID_CONFIG_ITEMS",
    }));
    expect(onTransition).toHaveBeenCalledWith(expect.objectContaining({ mode: "ready" }));
  });

  test("requires exact typed confirmation before resetting the entire Config", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (url === "/api/config-recovery") return Response.json({
        configPath: "/Users/test/.archcode/config.json",
        issues: [{ path: "configuration", message: "This value does not match the current ArchCode configuration format." }],
        removableItems: [],
      });
      if (url === "/api/config-recovery/reset") return Response.json({ status: { mode: "setup" } });
      throw new Error(`Unexpected request: ${url}`);
    }) });
    const onTransition = mock(() => undefined);
    const { SettingsConfigRecoveryPanel } = await import("./SettingsConfigRecoveryPanel");

    await act(async () => {
      root.render(<SettingsConfigRecoveryPanel grant="recovery-token" onTransition={onTransition} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitForText("Reset entire Config", container);

    await click("Reset entire Config", container);
    expect(document.body.textContent).toContain("Reset the entire Config?");
    expect(document.body.textContent).toContain("All providers, models, profiles, MCP servers, memory, GitHub integration, and login/security settings will be lost");
    const confirm = findButton("Delete entire Config and open Setup", document.body);
    expect(confirm.disabled).toBe(true);
    await inputText("RESE", document.body);
    expect(confirm.disabled).toBe(true);
    await click("Cancel", document.body);
    expect(requests.filter((request) => request.url === "/api/config-recovery/reset")).toHaveLength(0);

    await click("Reset entire Config", container);
    await inputText("RESET", document.body);
    await click("Delete entire Config and open Setup", document.body);
    const reset = requests.find((request) => request.url === "/api/config-recovery/reset");
    expect(reset).toBeDefined();
    expect(new Headers(reset!.init?.headers).get("Authorization")).toBe("Bearer recovery-token");
    expect(reset!.init?.body).toBe(JSON.stringify({ confirmation: "DELETE_INVALID_CONFIG" }));
    expect(onTransition).toHaveBeenCalledWith({ mode: "setup" });
  });
});

async function click(label: string, root: ParentNode): Promise<void> {
  const button = findButton(label, root);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function findButton(label: string, root: ParentNode): HTMLButtonElement {
  const button = [...root.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`Missing ${label}`);
  return button;
}

async function inputText(value: string, root: ParentNode): Promise<void> {
  const input = root.querySelector<HTMLInputElement>('input[type="text"]');
  if (!input) throw new Error("Missing confirmation input");
  await act(async () => {
    const previous = input.value;
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    (input as unknown as { _valueTracker?: { setValue(value: string): void } })._valueTracker?.setValue(previous);
    const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
    const props = propsKey
      ? (input as unknown as Record<string, { onChange?: (event: { target: HTMLInputElement }) => void }>)[propsKey]
      : undefined;
    if (!props?.onChange) throw new Error("Missing confirmation input change handler");
    props.onChange({ target: input });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForText(text: string, root: ParentNode): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (root.textContent?.includes(text)) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  throw new Error(`Missing text: ${text}`);
}
