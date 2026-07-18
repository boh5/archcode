import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { SettingsModalProvider, useSettingsModal } from "./settings-modal";

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;

function Probe() {
  const { settingsOpen, settingsSection, openSettingsModal, closeSettingsModal } = useSettingsModal();
  return (
    <>
      <output data-testid="settings-state">{`${String(settingsOpen)}:${settingsSection}`}</output>
      <button type="button" onClick={() => openSettingsModal("agents")}>Open agents</button>
      <button type="button" onClick={() => openSettingsModal("models")}>Manage models</button>
      <button type="button" onClick={closeSettingsModal}>Close</button>
    </>
  );
}

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://localhost" });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    MouseEvent: dom.window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) Object.defineProperty(globalThis, name, { configurable: true, value });
  container = document.querySelector("#root") as HTMLDivElement;
  root = createRoot(container);
  act(() => root.render(<SettingsModalProvider><Probe /></SettingsModalProvider>));
});

afterEach(() => {
  act(() => root.unmount());
  dom.window.close();
});

function click(label: string): void {
  const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent === label);
  if (!button) throw new Error(`Missing ${label}`);
  act(() => button.click());
}

describe("SettingsModalProvider", () => {
  test("tracks the requested section, including Manage models while already open", () => {
    expect(container.querySelector('[data-testid="settings-state"]')?.textContent).toBe("false:models");
    click("Open agents");
    expect(container.querySelector('[data-testid="settings-state"]')?.textContent).toBe("true:agents");
    click("Manage models");
    expect(container.querySelector('[data-testid="settings-state"]')?.textContent).toBe("true:models");
    click("Close");
    expect(container.querySelector('[data-testid="settings-state"]')?.textContent).toBe("false:models");
  });
});
