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
const originalFetch = globalThis.fetch;

const automationTimezone = "Asia/Shanghai";
const automation: Automation = {
  id: "automation-edit-limits",
  projectSlug: "archcode",
  origin: { kind: "session", sessionId: "session-source" },
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
  Object.defineProperties(dom.window, {
    requestAnimationFrame: {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        queueMicrotask(() => callback(0));
        return 0;
      },
    },
    cancelAnimationFrame: { configurable: true, value: () => {} },
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
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 0;
    },
    cancelAnimationFrame: () => {},
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
    .find((candidate) => candidate.textContent === "Update Automation");
  if (button === undefined) throw new Error("Missing Update Automation button");
  return button;
}

beforeEach(async () => {
  installDom();
  ({ EditAutomationDialog } = await import("./EditAutomationDialog"));
});

afterEach(() => {
  act(() => root.unmount());
  dom.window.close();
  globalThis.fetch = originalFetch;
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
    for (const input of [name, field("automation-cron"), timezone]) {
      expect(input.className).toContain("border-border-control");
      expect(input.className).toContain("bg-bg-base");
      expect(input.className).toContain("focus:border-brand");
    }
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

  test("protects a dirty draft with a controlled confirmation layer", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    let closeCount = 0;
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <EditAutomationDialog open onClose={() => { closeCount += 1; }} slug="archcode" automation={automation} />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("Lead · principal");
    change(field("automation-name"), "Changed draft");
    const cancel = [...document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent === "Cancel");
    if (cancel === undefined) throw new Error("Missing Cancel button");

    dom.window.confirm = () => { throw new Error("native confirm must not be used"); };
    act(() => cancel.click());
    expect(closeCount).toBe(0);
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Discard unsaved changes?");
    expect(field("automation-name").value).toBe("Changed draft");

    const keepEditing = [...document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent === "Keep editing");
    if (keepEditing === undefined) throw new Error("Missing Keep editing button");
    await act(async () => {
      keepEditing.click();
      await Promise.resolve();
    });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(field("automation-name").value).toBe("Changed draft");
    expect(document.activeElement).toBe(cancel);

    act(() => cancel.click());
    const discard = [...document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent === "Discard changes");
    if (discard === undefined) throw new Error("Missing Discard changes button");
    act(() => discard.click());
    expect(closeCount).toBe(1);
  });

  test("keeps deletion inside the editor, preserves the draft on cancel, and retries after failure", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    let pauseCount = 0;
    let deletedCount = 0;
    let closeCount = 0;
    let deleteAttempts = 0;
    let settleFirstDelete: ((response: Response) => void) | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "DELETE") return Response.json({});
      deleteAttempts += 1;
      if (deleteAttempts === 1) {
        return new Promise<Response>((resolve) => { settleFirstDelete = resolve; });
      }
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <EditAutomationDialog
            open
            onClose={() => { closeCount += 1; }}
            onDeleted={() => { deletedCount += 1; }}
            onPause={() => { pauseCount += 1; }}
            onResume={() => {}}
            slug="archcode"
            automation={automation}
          />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("Definition controls");
    const pause = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Pause Automation");
    const remove = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Delete Automation");
    if (pause === undefined || remove === undefined) throw new Error("Missing Definition controls");
    act(() => pause.click());
    expect(pauseCount).toBe(1);

    change(field("automation-name"), "Draft survives deletion");
    await act(async () => {
      remove.click();
      await Promise.resolve();
    });
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Delete Automation?");
    expect(field("automation-name").value).toBe("Draft survives deletion");

    const deleteCancel = [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Cancel" && button.closest('[role="alertdialog"]'));
    if (deleteCancel === undefined) throw new Error("Missing deletion Cancel button");
    expect(document.activeElement).toBe(deleteCancel);
    await act(async () => {
      deleteCancel.click();
      await Promise.resolve();
    });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(field("automation-name").value).toBe("Draft survives deletion");
    expect(document.activeElement).toBe(remove);
    expect(deleteAttempts).toBe(0);

    await act(async () => {
      remove.click();
      await Promise.resolve();
    });
    const confirmDelete = [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Delete Automation" && button.closest('[role="alertdialog"]'));
    if (confirmDelete === undefined) throw new Error("Missing Delete Automation confirmation button");
    await act(async () => {
      confirmDelete.click();
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
    expect(deleteAttempts).toBe(1);
    expect(document.body.textContent).toContain("Deleting…");
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(deletedCount).toBe(0);
    expect(closeCount).toBe(0);
    const pendingDelete = [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Deleting…");
    const pendingCancel = [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Cancel" && button.closest('[role="alertdialog"]'));
    if (pendingDelete === undefined || pendingCancel === undefined) throw new Error("Missing pending deletion controls");
    expect(pendingDelete.disabled).toBe(true);
    expect(pendingCancel.disabled).toBe(true);
    await act(async () => {
      pendingDelete.click();
      pendingCancel.click();
      document.querySelector('[role="alertdialog"]')?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
    expect(deleteAttempts).toBe(1);
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(closeCount).toBe(0);

    await act(async () => {
      settleFirstDelete?.(Response.json({ error: { code: "DELETE_FAILED", message: "Delete failed safely" } }, { status: 500 }));
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    });
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Delete failed safely");
    expect(deletedCount).toBe(0);

    const retryDelete = [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Delete Automation" && button.closest('[role="alertdialog"]'));
    if (retryDelete === undefined) throw new Error("Missing deletion retry button");
    await act(async () => {
      retryDelete.click();
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    });
    expect(deleteAttempts).toBe(2);
    expect(deletedCount).toBe(1);
    expect(closeCount).toBe(1);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });
});
