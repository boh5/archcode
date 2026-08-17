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

async function renderDesktop() {
  await act(async () => root.render(<MemoryRouter><HitlBell variant="rail" /></MemoryRouter>));
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
    ownerAgentName: "lead",
    ownerSessionTitle: "Root Session",
    view,
    createdAt: 1,
    payload: { type: "hitl.request" },
  });
}

function bell(): HTMLButtonElement {
  const trigger = container.querySelector("button[aria-label='Open work that needs you']") as HTMLButtonElement | null;
  if (!trigger) throw new Error("Missing Bell trigger");
  return trigger;
}

async function click(element: HTMLElement) {
  await act(async () => { element.click(); await Promise.resolve(); });
}

describe("HitlBell interactions", () => {
  test("desktop popover uses the current header and row geometry and focuses Close", async () => {
    addRequest("one", "Choose a deployment target");
    await renderDesktop();

    await click(bell());
    const dialog = container.querySelector("section[role='dialog']") as HTMLElement;
    expect(dialog.className).toContain("bottom-14");
    expect(dialog.className).toContain("left-[62px]");
    expect(dialog.textContent).toContain("Needs youWork that needs you");
    const row = dialog.querySelector("a[data-testid='hitl-attention-open']") as HTMLAnchorElement;
    expect(row.className).toContain("min-h-[58px]");
    expect(row.className).toContain("grid-cols-[28px_minmax(0,1fr)_14px]");
    const closeButton = dialog.querySelector("button[aria-label='Close work that needs you']") as HTMLButtonElement;
    expect(document.activeElement).toBe(closeButton);
  });

  test("desktop popover stays open for internal clicks and closes on an outside click", async () => {
    addRequest("one", "Choose a deployment target");
    await renderDesktop();

    await click(bell());
    const dialog = container.querySelector("section[role='dialog']") as HTMLElement;
    await click(dialog);
    expect(container.querySelector("section[role='dialog']")).toBe(dialog);

    await click(container);
    expect(container.querySelector("section[role='dialog']")).toBeNull();
    expect(document.activeElement).toBe(bell());
  });

  test("mobile sheet restores focus to Bell after focus moves inside then Escape", async () => {
    addRequest("one", "Choose a deployment target");
    addRequest("two", "Confirm the migration window");
    await render();

    expect(bell().querySelector("span[aria-label='2 items need you']")?.textContent).toBe("2");
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

    const closeButton = dialog.querySelector("button[aria-label='Close work that needs you']") as HTMLButtonElement;
    closeButton.focus();
    expect(document.activeElement).toBe(closeButton);
    await act(async () => {
      window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await Promise.resolve();
    });

    expect(container.querySelector("section[role='dialog']")).toBeNull();
    expect(document.activeElement).toBe(bell());
  });

  test("all mobile dismissal controls restore focus to the bell", async () => {
    addRequest("one", "Need an answer");
    await render();

    await click(bell());
    await click(container.querySelector("section button[aria-label='Close work that needs you']") as HTMLButtonElement);
    expect(document.activeElement).toBe(bell());

    await click(bell());
    const backdrop = container.querySelectorAll("button[aria-label='Close work that needs you']")[0] as HTMLButtonElement;
    await click(backdrop);
    expect(container.querySelector("section[role='dialog']")).toBeNull();
    expect(document.activeElement).toBe(bell());

    await click(bell());
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
