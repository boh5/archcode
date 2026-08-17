import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { ModelPicker } from "./ModelPicker";
import type {
  ExecutionModelBindingSummary,
  ModelRuntimeCatalog,
  RequestedModelSelection,
  SessionNextModelSelection,
} from "@archcode/protocol";

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;

const nextBinding: ExecutionModelBindingSummary = {
  selection: { model: "anthropic:claude-sonnet", variant: "deep" },
  providerId: "anthropic",
  providerDisplayName: "Anthropic",
  modelId: "claude-sonnet",
  modelDisplayName: "Claude Sonnet",
  resolution: "session_override",
  modelRuntimeRevision: "revision-2",
};
const next: SessionNextModelSelection = {
  requested: { mode: "session_override", selection: nextBinding.selection },
  resolved: nextBinding,
};
const active: ExecutionModelBindingSummary = {
  selection: { model: "openai:gpt-5" },
  providerId: "openai",
  providerDisplayName: "OpenAI",
  modelId: "gpt-5",
  modelDisplayName: "GPT-5",
  resolution: "requested",
  modelRuntimeRevision: "revision-1",
};
const catalog: ModelRuntimeCatalog = {
  revision: "revision-2",
  providers: [
    {
      id: "openai",
      displayName: "OpenAI",
      models: [{ id: "gpt-5", qualifiedId: "openai:gpt-5", displayName: "GPT-5", variants: ["fast"] }],
    },
    {
      id: "anthropic",
      displayName: "Anthropic",
      models: [{ id: "claude-sonnet", qualifiedId: "anthropic:claude-sonnet", displayName: "Claude Sonnet", variants: ["fast", "deep"] }],
    },
  ],
  profileDefaults: {
    principal: { model: "openai:gpt-5", variant: "fast" },
    deep: { model: "openai:gpt-5", variant: "fast" },
    fast: { model: "openai:gpt-5", variant: "fast" },
  },
};
const onSelect = mock((_selection: RequestedModelSelection) => {});

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div><button id="outside">Outside</button></body></html>', { url: "http://localhost" });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    PointerEvent: dom.window.PointerEvent ?? dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) Object.defineProperty(globalThis, name, { configurable: true, value });
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", { configurable: true, value: () => {} });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", { configurable: true, value: () => {} });
  container = document.querySelector("#root") as HTMLDivElement;
  root = createRoot(container);
  onSelect.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  dom.window.close();
});

function renderPicker(props: Partial<Parameters<typeof ModelPicker>[0]> = {}) {
  act(() => root.render(<ModelPicker catalog={catalog} next={next} active={active} onSelect={onSelect} {...props} />));
}

function click(selector: string): void {
  const element = container.querySelector(selector);
  if (!(element instanceof dom.window.HTMLElement)) throw new Error(`Missing ${selector}`);
  act(() => element.click());
}

function openPicker(): void {
  click('[data-testid="model-picker-trigger"]');
}

function profileDefaultState(): SessionNextModelSelection {
  const resolved: ExecutionModelBindingSummary = {
    ...nextBinding,
    selection: { model: "openai:gpt-5", variant: "fast" },
    providerId: "openai",
    providerDisplayName: "OpenAI",
    modelId: "gpt-5",
    modelDisplayName: "GPT-5",
    resolution: "profile_default",
  };
  return { requested: { mode: "profile_default", selection: resolved.selection }, resolved };
}

describe("ModelPicker", () => {
  test("renders only a neutral refresh state for a mismatched runtime revision", () => {
    renderPicker({ catalog: { ...catalog, revision: "revision-3" } });
    expect(container.querySelector('[data-testid="model-picker-refreshing"]')?.textContent).toBe("Refreshing model configuration…");
    expect(container.querySelector('[data-testid="model-picker-trigger"]')).toBeNull();
  });

  test("uses one trigger for model and effort", () => {
    renderPicker();
    const triggers = container.querySelectorAll('[data-testid="model-picker"] > button');
    expect(triggers.length).toBe(1);
    expect(triggers[0]?.getAttribute("aria-label")).toContain("Claude Sonnet · deep");
    expect(triggers[0]?.className).toContain("rounded-[999px]");
  });

  test("renders display-name model rows, a Default annotation, and one Effort section", () => {
    renderPicker();
    openPicker();
    const popover = container.querySelector('[data-testid="model-picker-popover"]');
    expect(popover?.textContent).toContain("GPT-5Default");
    expect(popover?.textContent).toContain("Claude Sonnet");
    expect(popover?.textContent).toContain("EffortDefaultfastdeep");
    expect(popover?.textContent).not.toContain("Anthropic");
    expect(popover?.textContent).not.toContain("openai:gpt-5");
    expect(container.querySelectorAll("button[data-model]").length).toBe(2);
    expect(container.querySelectorAll("button[data-variant]").length).toBe(3);
    expect(container.querySelector('[role="radiogroup"][aria-label="Effort"]')).not.toBeNull();
  });

  test("keeps the menu open while selecting model and effort in one pass", () => {
    renderPicker();
    openPicker();
    click('button[data-model="openai:gpt-5"]');
    expect(onSelect).toHaveBeenLastCalledWith({ mode: "session_override", selection: { model: "openai:gpt-5" } });
    expect(container.querySelector('[data-testid="model-picker-popover"]')).not.toBeNull();

    click('button[data-variant="fast"]');
    expect(onSelect).toHaveBeenLastCalledWith({
      mode: "session_override",
      selection: { model: "anthropic:claude-sonnet", variant: "fast" },
    });
    expect(container.querySelector('[data-testid="model-picker-popover"]')).not.toBeNull();
  });

  test("offers override reset only for an explicit Session override", () => {
    renderPicker();
    openPicker();
    expect(container.querySelector('[data-testid="model-picker-principal-profile"]')?.textContent).toBe("Reset explicit override");
    click('[data-testid="model-picker-principal-profile"]');
    expect(onSelect).toHaveBeenLastCalledWith({
      mode: "profile_default",
      selection: { model: "openai:gpt-5", variant: "fast" },
    });
    expect(container.querySelector('[data-testid="model-picker-popover"]')).not.toBeNull();

    renderPicker({ next: profileDefaultState(), active: undefined });
    expect(container.querySelector('[data-testid="model-picker-principal-profile"]')).toBeNull();
  });

  test("omits effort only when the selected model has no variants", () => {
    const noVariantCatalog: ModelRuntimeCatalog = {
      ...catalog,
      providers: [{ id: "local", displayName: "Local", models: [{ id: "plain", qualifiedId: "local:plain", displayName: "Plain", variants: [] }] }],
      profileDefaults: { principal: { model: "local:plain" }, deep: { model: "local:plain" }, fast: { model: "local:plain" } },
    };
    const resolved: ExecutionModelBindingSummary = {
      ...nextBinding,
      selection: { model: "local:plain" },
      providerId: "local",
      providerDisplayName: "Local",
      modelId: "plain",
      modelDisplayName: "Plain",
    };
    renderPicker({ catalog: noVariantCatalog, next: { requested: { mode: "profile_default", selection: resolved.selection }, resolved }, active: undefined });
    expect(container.querySelector('[data-testid="model-picker-trigger"]')?.textContent).toContain("Plain");
    openPicker();
    expect(container.textContent).not.toContain("Effort");
  });

  test("searches large model catalogs without filtering against effort keys", () => {
    const largeCatalog: ModelRuntimeCatalog = {
      ...catalog,
      providers: [...catalog.providers, {
        id: "local",
        displayName: "Local",
        models: Array.from({ length: 8 }, (_, index) => ({ id: `model-${index}`, qualifiedId: `local:model-${index}`, displayName: `Local ${index}`, variants: [] })),
      }],
    };
    renderPicker({ catalog: largeCatalog });
    openPicker();
    const search = container.querySelector('input[type="search"]') as HTMLInputElement;
    act(() => {
      const previous = search.value;
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(search, "Local 7");
      (search as unknown as { _valueTracker?: { setValue(value: string): void } })._valueTracker?.setValue(previous);
      const propsKey = Object.keys(search).find((key) => key.startsWith("__reactProps$"));
      const props = propsKey
        ? (search as unknown as Record<string, { onChange?: (event: { target: HTMLInputElement }) => void }>)[propsKey]
        : undefined;
      if (props?.onChange) props.onChange({ target: search });
      else search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    expect(container.querySelectorAll("button[data-model]").length).toBe(1);
    expect(container.querySelector('button[data-model="local:model-7"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Effort");
  });

  test("leaves pointer-open focus on the trigger", async () => {
    renderPicker();
    const trigger = container.querySelector('[data-testid="model-picker-trigger"]') as HTMLButtonElement;
    trigger.focus();
    await act(async () => {
      trigger.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true }));
      trigger.click();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="model-picker-popover"]')).not.toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test("focuses the current option on keyboard open, supports Arrow navigation, and restores trigger focus on Escape", async () => {
    renderPicker();
    const trigger = container.querySelector('[data-testid="model-picker-trigger"]') as HTMLButtonElement;
    trigger.focus();
    await act(async () => {
      trigger.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await Promise.resolve();
    });
    const selected = container.querySelector('button[data-model="anthropic:claude-sonnet"]') as HTMLButtonElement;
    expect(document.activeElement).toBe(selected);
    act(() => selected.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(container.querySelector('button[data-variant=""]'));
    await act(async () => {
      document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="model-picker-popover"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('[data-testid="model-picker-trigger"]'));
  });

  test("closes on outside pointerdown and announces accepted next-selection changes", () => {
    renderPicker();
    openPicker();
    act(() => document.querySelector("#outside")?.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true })));
    expect(container.querySelector('[data-testid="model-picker-popover"]')).toBeNull();

    renderPicker({ next: { requested: { mode: "session_override", selection: { model: "anthropic:claude-sonnet", variant: "fast" } }, resolved: { ...nextBinding, selection: { model: "anthropic:claude-sonnet", variant: "fast" } } } });
    expect(container.querySelector('[data-testid="model-picker-next-notice"]')?.textContent).toBe("Applies to the next execution");
  });
});
