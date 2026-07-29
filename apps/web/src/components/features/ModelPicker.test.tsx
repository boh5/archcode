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
  dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://localhost" });
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
  })) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
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
  act(() => root.render(
    <ModelPicker
      catalog={catalog}
      next={next}
      active={active}
      onSelect={onSelect}
      {...props}
    />,
  ));
}

function click(element: Element | null): void {
  if (!(element instanceof dom.window.HTMLElement)) throw new Error("Missing clickable element");
  act(() => element.click());
}

function openModelPicker(): void {
  click(container.querySelector('[data-testid="model-picker-trigger"]'));
}

function openVariantPicker(): void {
  click(container.querySelector('[data-testid="variant-picker-trigger"]'));
}

function changeSearch(value: string): void {
  const search = container.querySelector('input[type="search"]');
  if (!(search instanceof dom.window.HTMLInputElement)) throw new Error("Missing search input");

  act(() => {
    const previous = search.value;
    const valueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;
    valueSetter?.call(search, value);
    (search as unknown as { _valueTracker?: { setValue(value: string): void } })._valueTracker?.setValue(previous);
    const propsKey = Object.keys(search).find((key) => key.startsWith("__reactProps$"));
    const props = propsKey
      ? (search as unknown as Record<string, { onChange?: (event: { target: HTMLInputElement }) => void }>)[propsKey]
      : undefined;
    if (props?.onChange) props.onChange({ target: search });
    else search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
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
  return {
    requested: { mode: "profile_default", selection: resolved.selection },
    resolved,
  };
}

function largeCatalogState(): ModelRuntimeCatalog {
  return {
    ...catalog,
    providers: [
      ...catalog.providers,
      {
        id: "local",
        displayName: "Local",
        models: Array.from({ length: 8 }, (_, index) => ({
          id: `model-${index + 1}`,
          qualifiedId: `local:model-${index + 1}`,
          displayName: `Local Model ${index + 1}`,
          variants: index === 7 ? ["deep"] : [],
        })),
      },
    ],
  };
}

describe("ModelPicker", () => {
  test("renders only a neutral refresh state for mismatched catalog and next revisions", () => {
    renderPicker({ catalog: { ...catalog, revision: "revision-3" } });
    expect(container.querySelector('[data-testid="model-picker-refreshing"]')?.textContent).toBe("Refreshing model configuration…");
    expect(container.querySelector('[data-testid="model-picker-trigger"]')).toBeNull();
    expect(container.querySelector('[data-testid="variant-picker-trigger"]')).toBeNull();
  });

  test("renders two independent ghost selectors without segmented chrome", () => {
    renderPicker();
    const picker = container.querySelector('[data-testid="model-picker"]');
    const modelTrigger = container.querySelector('[data-testid="model-picker-trigger"]');
    const variantTrigger = container.querySelector('[data-testid="variant-picker-trigger"]');

    expect(picker?.className).toContain("gap-0.5");
    expect(picker?.className).not.toContain("border");
    expect(picker?.className).not.toContain("bg-bg-base");
    expect(modelTrigger?.textContent).toContain("Claude Sonnet");
    expect(modelTrigger?.textContent).not.toContain("deep");
    expect(variantTrigger?.textContent).toContain("deep");
    expect(variantTrigger?.className).not.toContain("font-mono");
    expect(modelTrigger?.getAttribute("aria-label")).toBe(
      "Choose next model, Claude Sonnet; running GPT-5",
    );
    expect(variantTrigger?.getAttribute("aria-label")).toBe(
      "Choose next variant for Claude Sonnet, deep",
    );
  });

  test("uses compact anchored menus and omits routine audit and management chrome", () => {
    renderPicker();
    openModelPicker();

    const popover = container.querySelector('[data-testid="model-picker-popover"]');
    expect(popover?.className).toContain("bottom-[calc(100%+6px)]");
    expect(popover?.className).toContain("min-[761px]:left-0");
    expect(popover?.className).toContain("w-[288px]");
    expect(popover?.className).toContain("[@media(max-width:520px)]:fixed");
    expect(popover?.className).toContain("[@media(max-width:520px)]:right-3");
    expect(popover?.className).toContain(
      "[@media(max-width:520px)]:w-[min(288px,calc(100vw-72px))]",
    );
    expect(container.querySelector('[data-testid="model-picker-selection-summary"]')).toBeNull();
    expect(container.querySelector('input[type="search"]')).toBeNull();
    expect(popover?.textContent).not.toContain("Running");
    expect(popover?.textContent).not.toContain("Next");
    expect(popover?.textContent).not.toContain("Manage models");
    expect(popover?.textContent).not.toContain("anthropic:claude-sonnet");
  });

  test("announces an accepted next-selection transition without persistent audit chrome", () => {
    renderPicker();
    expect(container.querySelector('[data-testid="model-picker-next-notice"]')).toBeNull();

    const changedBinding: ExecutionModelBindingSummary = {
      ...nextBinding,
      selection: { model: "anthropic:claude-sonnet", variant: "fast" },
    };
    renderPicker({
      next: {
        requested: { mode: "session_override", selection: changedBinding.selection },
        resolved: changedBinding,
      },
    });

    expect(container.querySelector('[data-testid="model-picker-next-notice"]')?.textContent).toBe(
      "Applies to the next execution",
    );
  });

  test("lists every model once and marks the effective model regardless of source", () => {
    renderPicker();
    openModelPicker();

    expect(container.querySelectorAll("button[data-model]").length).toBe(2);
    expect(container.querySelectorAll('button[data-model="anthropic:claude-sonnet"]').length).toBe(1);
    expect(container.querySelector('button[data-model="anthropic:claude-sonnet"] [aria-label="Selected"]')).not.toBeNull();
    expect(container.querySelector("section")).toBeNull();
  });

  test("reveals search only for a larger catalog and filters models rather than Variants", () => {
    renderPicker({ catalog: largeCatalogState() });
    openModelPicker();

    expect((container.querySelector('input[type="search"]') as HTMLInputElement).placeholder).toBe("Search models…");
    changeSearch("Local Model 8");
    expect(container.querySelectorAll("button[data-model]").length).toBe(1);
    expect(container.querySelector('button[data-model="local:model-8"]')).not.toBeNull();

    changeSearch("deep");
    expect(container.querySelectorAll("button[data-model]").length).toBe(0);
    expect(container.textContent).toContain("No models match “deep”");
  });

  test("selects a different model with its model default", () => {
    renderPicker();
    openModelPicker();
    click(container.querySelector('button[data-model="openai:gpt-5"]'));

    expect(onSelect).toHaveBeenCalledWith({
      mode: "session_override",
      selection: { model: "openai:gpt-5" },
    });
    expect(container.querySelector('[data-testid="model-picker-popover"]')).toBeNull();
  });

  test("treats the effective model as a no-op instead of changing its source", () => {
    renderPicker({ next: profileDefaultState(), active: undefined });
    openModelPicker();
    click(container.querySelector('button[data-model="openai:gpt-5"]'));

    expect(onSelect).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="model-picker-popover"]')).toBeNull();
  });

  test("shows only Default and the current model Variants in the compact Variant menu", () => {
    renderPicker();
    openVariantPicker();

    const popover = container.querySelector('[data-testid="variant-picker-popover"]');
    expect(popover?.className).toContain("right-0");
    expect(popover?.className).toContain("w-[152px]");
    expect(popover?.className).toContain("[@media(max-width:520px)]:w-[min(152px,calc(100vw-72px))]");
    expect(popover?.textContent).toBe("Defaultfastdeep");
    expect(popover?.textContent).not.toContain("Model settings");
    expect(popover?.textContent).not.toContain("Principal");
    expect(container.querySelectorAll("button[data-variant]").length).toBe(3);
    expect(container.querySelector('button[data-variant="deep"] [aria-label="Selected"]')).not.toBeNull();
    expect(container.querySelector('button[data-variant="deep"]')?.className).not.toContain("font-mono");
  });

  test("preserves the model when selecting a different Variant", () => {
    renderPicker();
    openVariantPicker();
    click(container.querySelector('button[data-variant="fast"]'));

    expect(onSelect).toHaveBeenCalledWith({
      mode: "session_override",
      selection: { model: "anthropic:claude-sonnet", variant: "fast" },
    });
    expect(container.querySelector('[data-testid="variant-picker-popover"]')).toBeNull();
  });

  test("selects the current model default by omitting the Variant", () => {
    renderPicker();
    openVariantPicker();
    click(container.querySelector('button[data-variant=""]'));

    expect(onSelect).toHaveBeenCalledWith({
      mode: "session_override",
      selection: { model: "anthropic:claude-sonnet" },
    });
  });

  test("treats the effective Variant as a no-op instead of changing its source", () => {
    renderPicker({ next: profileDefaultState(), active: undefined });
    openVariantPicker();
    click(container.querySelector('button[data-variant="fast"]'));

    expect(onSelect).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="variant-picker-popover"]')).toBeNull();
  });

  test("keeps an internal option pointerdown inside the picker", () => {
    renderPicker();
    openVariantPicker();
    const option = container.querySelector('button[data-variant="fast"]');
    if (!(option instanceof dom.window.HTMLButtonElement)) throw new Error("Missing Variant option");

    act(() => {
      option.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true }));
      option.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });

    expect(onSelect).toHaveBeenCalledWith({
      mode: "session_override",
      selection: { model: "anthropic:claude-sonnet", variant: "fast" },
    });
  });

  test("closes either picker on pointerdown outside the control group", () => {
    renderPicker();
    openVariantPicker();
    const outside = document.createElement("button");
    document.body.append(outside);

    act(() => outside.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true })));

    expect(container.querySelector('[data-testid="variant-picker-popover"]')).toBeNull();
    outside.remove();
  });

  test("offers a single contextual path back to the Principal default", () => {
    renderPicker();
    openModelPicker();

    const reset = container.querySelector('[data-testid="model-picker-principal-profile"]');
    expect(reset?.textContent).toBe("Use Principal default");
    click(reset);
    expect(onSelect).toHaveBeenCalledWith({
      mode: "profile_default",
      selection: { model: "openai:gpt-5", variant: "fast" },
    });

    renderPicker({ next: profileDefaultState(), active: undefined });
    openModelPicker();
    expect(container.querySelector('[data-testid="model-picker-principal-profile"]')).toBeNull();
    expect(container.querySelector('button[data-model="openai:gpt-5"] [aria-label="Selected"]')).not.toBeNull();
  });

  test("shows provider hints only when model display names collide", () => {
    const duplicateCatalog: ModelRuntimeCatalog = {
      ...catalog,
      providers: catalog.providers.map((provider) => ({
        ...provider,
        models: [
          ...provider.models,
          {
            id: "shared",
            qualifiedId: `${provider.id}:shared`,
            displayName: "Shared Model",
            variants: [],
          },
        ],
      })),
    };
    renderPicker({ catalog: duplicateCatalog });
    openModelPicker();

    const duplicates = container.querySelectorAll('button[data-model$=":shared"]');
    expect(duplicates.length).toBe(2);
    expect(duplicates[0]?.textContent).toContain("OpenAI");
    expect(duplicates[1]?.textContent).toContain("Anthropic");
    expect(container.querySelector('button[data-model="openai:gpt-5"]')?.textContent).toBe("GPT-5");
  });

  test("supports Arrow navigation within either compact menu", () => {
    renderPicker();
    openVariantPicker();
    const selected = container.querySelector('button[data-variant="deep"]');
    if (!(selected instanceof dom.window.HTMLButtonElement)) throw new Error("Missing selected Variant");
    selected.focus();

    act(() => selected.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
    })));

    expect(document.activeElement?.getAttribute("data-variant")).toBe("");
  });

  test("preserves search caret keys and restores model-trigger focus after keyboard navigation", async () => {
    renderPicker({
      catalog: largeCatalogState(),
      next: profileDefaultState(),
      active: undefined,
    });
    openModelPicker();
    await act(async () => await Promise.resolve());

    const search = container.querySelector('input[type="search"]');
    if (!(search instanceof dom.window.HTMLInputElement)) throw new Error("Missing search input");
    expect(document.activeElement).toBe(search);

    for (const key of ["Home", "End"]) {
      const event = new dom.window.KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      act(() => search.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(search);
    }

    act(() => search.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    })));
    expect(document.activeElement?.getAttribute("data-model")).toBe("openai:gpt-5");

    act(() => document.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    })));
    await act(async () => await Promise.resolve());
    expect(container.querySelector('[data-testid="model-picker-popover"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('[data-testid="model-picker-trigger"]'));
  });

  test("hides the Variant selector when the current model has no configured Variants", () => {
    const catalogWithoutVariants: ModelRuntimeCatalog = {
      ...catalog,
      providers: [{
        id: "anthropic",
        displayName: "Anthropic",
        models: [{
          id: "claude-sonnet",
          qualifiedId: "anthropic:claude-sonnet",
          displayName: "Claude Sonnet",
          variants: [],
        }],
      }],
    };
    const baseBinding = {
      ...nextBinding,
      selection: { model: "anthropic:claude-sonnet" },
    };
    renderPicker({
      catalog: catalogWithoutVariants,
      next: {
        requested: { mode: "session_override", selection: baseBinding.selection },
        resolved: baseBinding,
      },
    });

    expect(container.querySelector('[data-testid="model-picker-trigger"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="variant-picker-trigger"]')).toBeNull();
  });

  test("closes on Escape and disables both selectors when unavailable", () => {
    renderPicker();
    openVariantPicker();
    act(() => document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector('[data-testid="variant-picker-popover"]')).toBeNull();

    renderPicker({ disabled: true });
    const modelTrigger = container.querySelector('[data-testid="model-picker-trigger"]');
    const variantTrigger = container.querySelector('[data-testid="variant-picker-trigger"]');
    expect((modelTrigger as HTMLButtonElement).disabled).toBe(true);
    expect((variantTrigger as HTMLButtonElement).disabled).toBe(true);
    click(modelTrigger);
    click(variantTrigger);
    expect(container.querySelector('[data-testid="model-picker-popover"]')).toBeNull();
    expect(container.querySelector('[data-testid="variant-picker-popover"]')).toBeNull();
  });
});
