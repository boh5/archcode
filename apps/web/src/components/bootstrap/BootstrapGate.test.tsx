import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { BootstrapGate } from "./BootstrapGate";
import { notifyAuthInvalidated } from "../../api/client";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalNavigator = globalThis.navigator;
const originalHTMLElement = globalThis.HTMLElement;
const originalEvent = globalThis.Event;
const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const originalReactAct = testGlobal.IS_REACT_ACT_ENVIRONMENT;

let dom: JSDOM;
let root: Root;

beforeEach(() => {
  dom = new JSDOM("<div id=\"root\"></div>", { url: "http://localhost/" });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Event", { configurable: true, value: dom.window.Event });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  root = createRoot(dom.window.document.getElementById("root")!);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: originalHTMLElement });
  Object.defineProperty(globalThis, "Event", { configurable: true, value: originalEvent });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: originalReactAct });
  dom.window.close();
});

describe("BootstrapGate", () => {
  test("does not mount workbench children until bootstrap authorizes ready mode", async () => {
    globalThis.fetch = mock(async () => Response.json({ mode: "ready", authRequired: false, authenticated: false })) as unknown as typeof fetch;

    await act(async () => { root.render(<BootstrapGate><p>Workbench mounted</p></BootstrapGate>); });

    expect(document.body.textContent).toContain("Workbench mounted");
    expect(fetch).toHaveBeenCalledWith("/api/bootstrap", expect.objectContaining({ credentials: "same-origin" }));
  });

  test("leaves the one-time Setup route before mounting an authorized workbench", async () => {
    dom.reconfigure({ url: "http://localhost/setup#token=consumed" });
    const onPopState = mock(() => undefined);
    window.addEventListener("popstate", onPopState);
    globalThis.fetch = mock(async () => Response.json({
      mode: "ready",
      authRequired: false,
      authenticated: true,
    })) as unknown as typeof fetch;

    await act(async () => {
      root.render(<BootstrapGate><p>Workbench mounted</p></BootstrapGate>);
    });

    expect(window.location.pathname).toBe("/");
    expect(window.location.hash).toBe("");
    expect(onPopState).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Workbench mounted");
  });

  test("unmounts workbench and returns to login after a shared auth invalidation", async () => {
    let bootstrapCalls = 0;
    globalThis.fetch = mock(async () => {
      bootstrapCalls += 1;
      return Response.json(bootstrapCalls === 1
        ? { mode: "ready", authRequired: false, authenticated: false }
        : { mode: "ready", authRequired: true, authenticated: false });
    }) as unknown as typeof fetch;

    await act(async () => { root.render(<BootstrapGate><p>Workbench mounted</p></BootstrapGate>); });
    expect(document.body.textContent).toContain("Workbench mounted");

    await act(async () => { notifyAuthInvalidated(); });

    expect(document.body.textContent).not.toContain("Workbench mounted");
    expect(document.body.textContent).toContain("Sign in");
  });
});
