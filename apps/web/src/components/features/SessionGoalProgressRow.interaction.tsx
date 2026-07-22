import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { SessionGoalView } from "../../api/types";

type SessionGoalProgressRowComponent = typeof import("./SessionGoalProgressRow").SessionGoalProgressRow;

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
let fetchMock: ReturnType<typeof mock>;
let SessionGoalProgressRow: SessionGoalProgressRowComponent;

const activeGoal: SessionGoalView = {
  instanceId: "goal-1",
  generation: 2,
  objective: "Finish the Composer hard cut",
  status: "active",
  usage: {
    executionCount: 3,
    executionTimeMs: 90_000,
    tokens: {
      inputTokens: 1_000,
      outputTokens: 500,
      totalTokens: 1_500,
      reasoningTokens: 0,
      cachedInputTokens: 0,
    },
  },
  createdAt: 1,
  activatedAt: 1,
  updatedAt: 2,
};

function change(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  act(() => {
    const previous = element.value;
    const prototype = element instanceof dom.window.HTMLTextAreaElement
      ? dom.window.HTMLTextAreaElement.prototype
      : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
    (element as unknown as { _valueTracker?: { setValue(value: string): void } })._valueTracker?.setValue(previous);
    const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
    const props = propsKey
      ? (element as unknown as Record<string, { onChange?: (event: { target: typeof element }) => void }>)[propsKey]
      : undefined;
    props?.onChange?.({ target: element });
  });
}

beforeEach(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: { configurable: true, value: () => {} },
    detachEvent: { configurable: true, value: () => {} },
  });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    DocumentFragment: dom.window.DocumentFragment,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  fetchMock = mock(async () => Response.json({ ok: true }));
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  ({ SessionGoalProgressRow } = await import("./SessionGoalProgressRow"));
});

afterEach(() => {
  act(() => root.unmount());
  dom.window.close();
});

function renderGoal(client: QueryClient, goal: SessionGoalView): void {
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <SessionGoalProgressRow slug="project-1" sessionId="session-goal" goal={goal} />
      </QueryClientProvider>,
    );
  });
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
  if (!(match instanceof dom.window.HTMLButtonElement)) throw new Error(`Missing ${label} button`);
  return match;
}

describe("SessionGoalProgressRow", () => {
  test("keeps one summary row and puts budget adjustment and removal only in budget-limited Edit", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    renderGoal(client, activeGoal);

    const row = container.querySelector('[data-testid="session-goal-progress-row"]');
    expect(row?.querySelector("textarea")).toBeNull();
    expect(row?.textContent).toContain("EditPauseClear");
    expect(row?.textContent).not.toContain("Adjust budget");
    await act(async () => {
      button("Edit").click();
      await Promise.resolve();
    });
    expect(document.querySelector('[data-testid="goal-budget-editor"]')).toBeNull();
    await act(async () => button("Cancel").click());

    const budgetLimitedGoal: SessionGoalView = {
      ...activeGoal,
      status: "budget_limited",
      tokenBudget: 1_500,
      blockedReason: "Token budget reached",
    };
    renderGoal(client, budgetLimitedGoal);
    expect(container.textContent).toContain("EditClear");
    expect(container.textContent).not.toContain("Pause");
    expect(container.textContent).not.toContain("Resume");
    await act(async () => {
      button("Edit").click();
      await Promise.resolve();
    });

    expect(document.querySelector('[data-testid="goal-budget-editor"]')).not.toBeNull();
    const objective = document.querySelector('textarea[aria-label="Goal objective"]');
    const budget = document.querySelector('input[aria-label="Goal token budget"]');
    if (!(objective instanceof dom.window.HTMLTextAreaElement) || !(budget instanceof dom.window.HTMLInputElement)) {
      throw new Error("Missing Goal Edit fields");
    }
    change(objective, "Finish and verify the Composer hard cut");
    change(budget, "6500");
    await act(async () => {
      button("Save").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const requests = fetchMock.mock.calls.map(([path, init]) => ({ path: String(path), init: init as RequestInit | undefined }));
    const objectiveRequest = requests.find(({ path, init }) => path.endsWith("/goal") && init?.method === "PATCH");
    const budgetRequest = requests.find(({ path, init }) => path.endsWith("/goal/budget") && init?.method === "POST");
    expect(JSON.parse(String(objectiveRequest?.init?.body))).toEqual({
      objective: "Finish and verify the Composer hard cut",
      expectedGeneration: 2,
    });
    expect(JSON.parse(String(budgetRequest?.init?.body))).toEqual({ tokenBudget: 6500 });

    renderGoal(client, { ...budgetLimitedGoal, tokenBudget: 6_500, objective: "Finish and verify the Composer hard cut", generation: 3 });
    await act(async () => {
      button("Edit").click();
      await Promise.resolve();
    });
    const removeLimit = document.querySelector('input[type="checkbox"]');
    if (!(removeLimit instanceof dom.window.HTMLInputElement)) throw new Error("Missing remove-limit control");
    await act(async () => removeLimit.click());
    await act(async () => {
      button("Save").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const removalRequest = fetchMock.mock.calls
      .filter(([path, init]) => String(path).endsWith("/goal/budget") && (init as RequestInit | undefined)?.method === "POST")
      .at(-1);
    expect(JSON.parse(String((removalRequest?.[1] as RequestInit | undefined)?.body))).toEqual({ tokenBudget: null });
  });
});
