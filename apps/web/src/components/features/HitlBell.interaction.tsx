import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { JSDOM } from "jsdom";
import type { HitlView } from "@archcode/protocol";
import { hitlStore } from "../../store/hitl-store";
import { HitlBell } from "./HitlBell";

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
let notificationPermission: NotificationPermission;
let notificationRequests: number;
const originals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    Event: dom.window.Event,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  notificationPermission = "default";
  notificationRequests = 0;
  originals.set("Notification", Object.getOwnPropertyDescriptor(globalThis, "Notification"));
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: {
      get permission() { return notificationPermission; },
      requestPermission: async () => { notificationRequests += 1; return notificationPermission; },
    },
  });
  hitlStore.getState().reset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  hitlStore.getState().reset();
  dom.window.close();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
});

async function render() {
  await act(async () => root.render(<MemoryRouter><HitlBell mobile /></MemoryRouter>));
}

function addRequest(hitlId: string, title: string) {
  const view: HitlView = {
    hitlId,
    owner: { type: "session", id: "root-session" },
    source: { type: "ask_user", toolCallId: `call-${hitlId}` },
    status: "pending",
    displayPayload: { title, redacted: true },
    allowedActions: ["answer", "cancel"],
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
  hitlStore.getState().applyRealtimeEvent({
    type: "hitl.event",
    projectSlug: "demo",
    hitlId,
    ownerSessionId: "root-session",
    rootSessionId: "root-session",
    view,
    createdAt: 1,
    payload: { type: "hitl.request" },
  });
}

function bell(): HTMLButtonElement {
  const trigger = container.querySelector("button[aria-label='Open requests needing attention']") as HTMLButtonElement | null;
  if (!trigger) throw new Error("Missing Bell trigger");
  return trigger;
}

async function click(element: HTMLElement) {
  await act(async () => { element.click(); await Promise.resolve(); });
}

describe("HitlBell interactions", () => {
  test("mobile sheet restores focus to Bell after focus moves inside then Escape", async () => {
    addRequest("one", "Choose a deployment target");
    addRequest("two", "Confirm the migration window");
    await render();

    expect(bell().querySelector("span[aria-label='2 requests need attention']")?.textContent).toBe("2");
    await click(bell());
    const dialog = container.querySelector("section[role='dialog']") as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.className).toContain("fixed inset-x-2 bottom-2 z-50");
    expect(container.querySelector("button.fixed.inset-0.z-40")).not.toBeNull();
    expect(dialog.textContent).toContain("Choose a deployment target");
    expect(dialog.querySelector("form")).toBeNull();
    expect([...dialog.querySelectorAll("button")].map((button) => button.textContent)).not.toContain("Approve");
    expect(dialog.textContent).not.toContain("Deny");
    expect(dialog.textContent).not.toContain("Answer");

    const closeButton = dialog.querySelector("button[aria-label='Close requests needing attention']") as HTMLButtonElement;
    closeButton.focus();
    expect(document.activeElement).toBe(closeButton);
    await act(async () => {
      window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await Promise.resolve();
    });

    expect(container.querySelector("section[role='dialog']")).toBeNull();
    expect(document.activeElement).toBe(bell());
  });

  test("all mobile dismissal controls restore focus and the alert footer follows permission state", async () => {
    addRequest("one", "Need an answer");
    await render();

    await click(bell());
    expect(container.textContent).toContain("Enable desktop alerts");
    await click(container.querySelector("button[class*='text-text-secondary']") as HTMLButtonElement);
    expect(notificationRequests).toBe(1);
    await click(container.querySelector("section button[aria-label='Close requests needing attention']") as HTMLButtonElement);
    expect(document.activeElement).toBe(bell());

    await click(bell());
    const backdrop = container.querySelectorAll("button[aria-label='Close requests needing attention']")[0] as HTMLButtonElement;
    await click(backdrop);
    expect(container.querySelector("section[role='dialog']")).toBeNull();
    expect(document.activeElement).toBe(bell());

    notificationPermission = "denied";
    await click(bell());
    expect(container.textContent).not.toContain("Enable desktop alerts");
    await click(bell());
    expect(container.querySelector("section[role='dialog']")).toBeNull();
    expect(document.activeElement).toBe(bell());
  });

  test("opening a HITL destination closes the mobile sheet and restores Bell focus", async () => {
    addRequest("one", "Need an answer");
    await render();

    await click(bell());
    const open = container.querySelector("a[data-testid='hitl-attention-open']") as HTMLAnchorElement | null;
    expect(open?.getAttribute("href")).toBe("/projects/demo/sessions/root-session?hitl=one");
    await click(open!);

    expect(container.querySelector("section[role='dialog']")).toBeNull();
    expect(document.activeElement).toBe(bell());
  });
});
