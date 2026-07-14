import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  AUTOMATION_MESSAGE_MAX_LENGTH,
  AUTOMATION_NAME_MAX_LENGTH,
  AUTOMATION_TIMEZONE_MAX_LENGTH,
} from "@archcode/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { Automation } from "../../api/types";

type EditAutomationDialogComponent = typeof import("./EditAutomationDialog").EditAutomationDialog;

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
let EditAutomationDialog: EditAutomationDialogComponent;

const automationTimezone = "Asia/Shanghai";
const automation: Automation = {
  id: "automation-edit-limits",
  projectSlug: "archcode",
  createdFromSessionId: "session-source",
  name: "Daily review",
  trigger: { kind: "cron", expression: "0 9 * * *", timezone: automationTimezone },
  action: { kind: "start_session", message: "Review current work.", location: "project" },
  status: "active",
  createdAt: "2026-07-14T00:00:00.000Z",
  updatedAt: "2026-07-14T00:00:00.000Z",
  nextFireAt: "2026-07-15T01:00:00.000Z",
};

function installDom(): void {
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
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    HTMLSelectElement: dom.window.HTMLSelectElement,
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
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
}

function field(id: string): HTMLInputElement | HTMLTextAreaElement {
  const element = document.getElementById(id);
  if (!(element instanceof dom.window.HTMLInputElement) && !(element instanceof dom.window.HTMLTextAreaElement)) {
    throw new Error(`Missing field ${id}`);
  }
  return element;
}

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

function saveButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")]
    .find((candidate) => candidate.textContent === "Save changes");
  if (button === undefined) throw new Error("Missing Save changes button");
  return button;
}

beforeEach(async () => {
  installDom();
  ({ EditAutomationDialog } = await import("./EditAutomationDialog"));
});

afterEach(() => {
  act(() => root.unmount());
  dom.window.close();
});

describe("EditAutomationDialog limits", () => {
  test("binds Protocol maxLength values and disables submit for over-limit fields", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <EditAutomationDialog open onClose={() => {}} slug="archcode" automation={automation} />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    const name = field("automation-name");
    const message = field("automation-message");
    const timezone = field("automation-timezone");
    expect(name.maxLength).toBe(AUTOMATION_NAME_MAX_LENGTH);
    expect(message.maxLength).toBe(AUTOMATION_MESSAGE_MAX_LENGTH);
    expect(timezone.maxLength).toBe(AUTOMATION_TIMEZONE_MAX_LENGTH);
    expect(saveButton().disabled).toBe(false);

    for (const [input, limit, validValue] of [
      [name, AUTOMATION_NAME_MAX_LENGTH, automation.name],
      [message, AUTOMATION_MESSAGE_MAX_LENGTH, automation.action.message],
      [timezone, AUTOMATION_TIMEZONE_MAX_LENGTH, automationTimezone],
    ] as const) {
      change(input, "x".repeat(limit + 1));
      expect(saveButton().disabled).toBe(true);
      change(input, validValue);
      expect(saveButton().disabled).toBe(false);
    }
  });
});
