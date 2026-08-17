import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

mock.module("../../store/hitl-store", () => ({
  useAttentionVisibleScopedHitl: () => [],
}));

mock.module("./HitlAttentionList", () => ({
  HitlAttentionList: ({ footer }: { footer?: ReactNode }) => <div>{footer}</div>,
}));

const { HitlBell } = await import("./HitlBell");
const originals = new Map<string, PropertyDescriptor | undefined>();

function installDom(requestPermission: () => Promise<NotificationPermission>): JSDOM {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const notification = { permission: "default", requestPermission };
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    MouseEvent: dom.window.MouseEvent,
    Notification: notification,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
  return dom;
}

function restoreDom(): void {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
}

afterEach(restoreDom);

describe("HitlBell", () => {
  test("requests desktop notification permission from the local popover action", async () => {
    const requestPermission = mock(async (): Promise<NotificationPermission> => "granted");
    const dom = installDom(requestPermission);
    const root = createRoot(document.getElementById("root")!);

    await act(async () => root.render(<HitlBell variant="rail" />));
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Open work that needs you"]')!.click();
    });
    const enable = Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Enable desktop alerts");
    expect(enable).toBeDefined();

    await act(async () => enable!.click());
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("Enable desktop alerts");

    await act(async () => root.unmount());
    dom.window.close();
  });
});
