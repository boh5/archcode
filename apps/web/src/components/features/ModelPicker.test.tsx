import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  ModelPicker,
} from "./ModelPicker";
import type { ExecutionModelBindingSummary, ModelRuntimeCatalog, RequestedModelSelection, SessionNextModelSelection } from "@archcode/protocol";

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
  agentDefaults: {
    engineer: { model: "openai:gpt-5", variant: "fast" },
  },
};

const onSelect = mock((_selection: RequestedModelSelection) => {});
const onManageModels = mock(() => {});

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
  onManageModels.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  dom.window.close();
});

function renderPicker(props: Partial<Parameters<typeof ModelPicker>[0]> = {}) {
  act(() => root.render(
    <ModelPicker
      catalog={catalog}
      agentName="engineer"
      next={next}
      active={active}
      onSelect={onSelect}
      onManageModels={onManageModels}
      {...props}
    />,
  ));
}

function click(element: Element | null): void {
  if (!(element instanceof dom.window.HTMLElement)) throw new Error("Missing clickable element");
  act(() => element.click());
}

function openPicker(): void {
  click(container.querySelector('[data-testid="model-picker-trigger"]'));
}

describe("ModelPicker", () => {
  test("renders only a neutral refresh state for mismatched catalog and next revisions", () => {
    renderPicker({ catalog: { ...catalog, revision: "revision-3" } });
    expect(container.querySelector('[data-testid="model-picker-refreshing"]')?.textContent).toBe("Refreshing model configuration…");
    expect(container.querySelector('[data-testid="model-picker-trigger"]')).toBeNull();
  });

  test("shows controlled next and active bindings in an upward, narrow-safe popover", () => {
    renderPicker();
    expect(container.querySelector('[data-testid="model-picker-trigger"]')?.textContent).toContain("Next: Claude Sonnet · deep · Override");

    openPicker();
    const popover = container.querySelector('[data-testid="model-picker-popover"]');
    expect(popover?.className).toContain("bottom-[calc(100%+8px)]");
    expect(popover?.className).toContain("max-[390px]:fixed");
    expect(popover?.className).toContain("max-[390px]:left-3");
    expect(container.textContent).toContain("Running withGPT-5");
    expect(container.textContent).toContain("NextClaude Sonnet · deep");
  });

  test("searches provider, model, and variant while preserving Provider groups", () => {
    renderPicker();
    openPicker();
    const search = container.querySelector('input[type="search"]');
    if (!(search instanceof dom.window.HTMLInputElement)) throw new Error("Missing search input");

    act(() => {
      const previous = search.value;
      const valueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(search, "deep");
      (search as unknown as { _valueTracker?: { setValue(value: string): void } })._valueTracker?.setValue(previous);
      const propsKey = Object.keys(search).find((key) => key.startsWith("__reactProps$"));
      const props = propsKey ? (search as unknown as Record<string, { onChange?: (event: { target: HTMLInputElement }) => void }>)[propsKey] : undefined;
      if (props?.onChange) props.onChange({ target: search });
      else search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });

    expect(container.querySelector('section[aria-label="Anthropic"]')).not.toBeNull();
    expect(container.querySelector('section[aria-label="OpenAI"]')).toBeNull();
    expect(container.querySelector('button[data-model="anthropic:claude-sonnet"][data-variant="deep"]')).not.toBeNull();
    expect(container.querySelector('button[data-model="anthropic:claude-sonnet"][data-variant="fast"]')).toBeNull();
  });

  test("reports an override without mutating the controlled trigger", () => {
    renderPicker();
    openPicker();
    click(container.querySelector('button[data-model="openai:gpt-5"][data-variant="fast"]'));

    expect(onSelect).toHaveBeenCalledWith({ mode: "session_override", selection: { model: "openai:gpt-5", variant: "fast" } });
    expect(container.querySelector('[data-testid="model-picker-popover"]')).toBeNull();
    expect(container.querySelector('[data-testid="model-picker-trigger"]')?.textContent).toContain("Next: Claude Sonnet · deep · Override");
  });

  test("keeps an internal option pointerdown inside the picker", () => {
    renderPicker();
    openPicker();
    const option = container.querySelector('button[data-model="openai:gpt-5"][data-variant="fast"]');
    if (!(option instanceof dom.window.HTMLButtonElement)) throw new Error("Missing model option");

    act(() => {
      option.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true }));
      option.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });

    expect(onSelect).toHaveBeenCalledWith({ mode: "session_override", selection: { model: "openai:gpt-5", variant: "fast" } });
  });

  test("closes on pointerdown outside the picker", () => {
    renderPicker();
    openPicker();
    const outside = document.createElement("button");
    document.body.append(outside);

    act(() => outside.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true })));

    expect(container.querySelector('[data-testid="model-picker-popover"]')).toBeNull();
    outside.remove();
  });

  test("offers Agent default with its resolved model", () => {
    renderPicker();
    openPicker();
    expect(container.querySelector('[data-testid="model-picker-agent-default"]')?.textContent).toContain("GPT-5 · fast");
    click(container.querySelector('[data-testid="model-picker-agent-default"]'));
    expect(onSelect).toHaveBeenCalledWith({ mode: "agent_default", selection: { model: "openai:gpt-5", variant: "fast" } });
  });

  test("uses requested mode for the trigger and exactly one selected option", () => {
    const defaultBinding = {
      ...active,
      selection: { model: "openai:gpt-5", variant: "fast" },
      resolution: "agent_default" as const,
      modelRuntimeRevision: catalog.revision,
    };
    renderPicker({ next: { requested: { mode: "agent_default", selection: defaultBinding.selection }, resolved: defaultBinding }, active: undefined });
    expect(container.querySelector('[data-testid="model-picker-trigger"]')?.textContent).toContain("GPT-5 · fast · Agent default");
    openPicker();
    expect(container.querySelector('[data-testid="model-picker-agent-default"] [aria-label="Selected"]')).not.toBeNull();
    expect(container.querySelector('button[data-model="openai:gpt-5"][data-variant="fast"] [aria-label="Selected"]')).toBeNull();
    act(() => document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

    renderPicker({ next: { requested: { mode: "session_override", selection: defaultBinding.selection }, resolved: { ...defaultBinding, resolution: "session_override" } }, active: undefined });
    expect(container.querySelector('[data-testid="model-picker-trigger"]')?.textContent).toContain("GPT-5 · fast · Override");
    openPicker();
    expect(container.querySelector('[data-testid="model-picker-agent-default"] [aria-label="Selected"]')).toBeNull();
    expect(container.querySelector('button[data-model="openai:gpt-5"][data-variant="fast"] [aria-label="Selected"]')).not.toBeNull();
  });

  test("opens Models management and closes the picker", () => {
    renderPicker();
    openPicker();
    click(Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Manage models")) ?? null);
    expect(onManageModels).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="model-picker-popover"]')).toBeNull();
  });

  test("closes on Escape and disables opening when unavailable", () => {
    renderPicker();
    openPicker();
    act(() => document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector('[data-testid="model-picker-popover"]')).toBeNull();

    renderPicker({ disabled: true });
    const trigger = container.querySelector('[data-testid="model-picker-trigger"]');
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    click(trigger);
    expect(container.querySelector('[data-testid="model-picker-popover"]')).toBeNull();
  });
});
