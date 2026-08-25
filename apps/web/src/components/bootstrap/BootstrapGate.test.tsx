import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { BootstrapGate } from "./BootstrapGate";
import { notifyAuthInvalidated } from "../../api/client";
import { AppRoot } from "../../app-root";

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
  test("directs an uninitialized home page to the terminal setup link instead of showing setup fields", async () => {
    globalThis.fetch = mock(async () => Response.json({ mode: "setup" })) as unknown as typeof fetch;

    await act(async () => { root.render(<BootstrapGate><p>Workbench mounted</p></BootstrapGate>); });

    expect(document.body.textContent).toContain("Open the setup link from your terminal");
    expect(document.body.textContent).toContain("Complete first-run setup at");
    expect(document.body.textContent).not.toContain("Set up your workbench");
    expect(document.body.textContent).not.toContain("Require login");
    expect(document.body.textContent).not.toContain("Password");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/bootstrap", expect.objectContaining({ credentials: "same-origin" }));
  });

  test("does not mount workbench children until bootstrap authorizes ready mode", async () => {
    globalThis.fetch = mock(async () => Response.json({ mode: "ready", authRequired: false, authenticated: false, runtime: { state: "ready" } })) as unknown as typeof fetch;

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
      runtime: { state: "ready" },
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
        ? { mode: "ready", authRequired: false, authenticated: false, runtime: { state: "ready" } }
        : { mode: "ready", authRequired: true, authenticated: false, runtime: { state: "ready" } });
    }) as unknown as typeof fetch;

    await act(async () => { root.render(<BootstrapGate><p>Workbench mounted</p></BootstrapGate>); });
    expect(document.body.textContent).toContain("Workbench mounted");

    await act(async () => { notifyAuthInvalidated(); });

    expect(document.body.textContent).not.toContain("Workbench mounted");
    expect(document.body.textContent).toContain("Sign in");
  });

  test("opens the complete Settings workspace on Runtime error", async () => {
    window.localStorage.setItem("archcodeTheme", "light");
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/bootstrap") return Response.json({
        mode: "ready",
        authRequired: false,
        authenticated: true,
        runtime: { state: "error", error: { message: "Session data could not be loaded.", recoveryAllowed: true } },
      });
      if (String(input) === "/api/runtime-data") return Response.json({ projects: [] });
      throw new Error(`Unexpected request: ${String(input)}`);
    }) as unknown as typeof fetch;

    await act(async () => {
      root.render(<AppRoot><BootstrapGate><p>Workbench mounted</p></BootstrapGate></AppRoot>);
      await Promise.resolve();
    });

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.body.textContent).toContain("Runtime Data");
    expect(document.body.textContent).toContain("Session data could not be loaded.");
    expect(document.body.textContent).toContain("Models");
    expect(document.body.textContent).toContain("About & Updates");
    expect(document.body.textContent).not.toContain("Workbench mounted");
    expect(document.body.textContent).not.toContain("ArchCode could not start");
  });

  test("requires the terminal Config Recovery link instead of exposing recovery actions", async () => {
    globalThis.fetch = mock(async () => Response.json({
      mode: "config_error",
      message: "The global configuration is invalid. Open Config Recovery from the server terminal.",
    })) as unknown as typeof fetch;

    await act(async () => { root.render(<BootstrapGate><p>Workbench mounted</p></BootstrapGate>); });

    expect(document.body.textContent).toContain("Open Config Recovery from your terminal");
    expect(document.body.textContent).toContain("Repair the invalid global configuration at");
    expect(document.body.textContent).not.toContain("Reset configuration");
    expect(document.body.textContent).not.toContain("Workbench mounted");
  });

  test("applies the saved light theme to recovery before the workbench mounts", async () => {
    window.localStorage.setItem("archcodeTheme", "light");
    globalThis.fetch = mock(async () => Response.json({
      mode: "config_error",
      message: "The global configuration is invalid. Open Config Recovery from the server terminal.",
    })) as unknown as typeof fetch;

    await act(async () => {
      root.render(<AppRoot><BootstrapGate><p>Workbench mounted</p></BootstrapGate></AppRoot>);
    });

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.body.textContent).toContain("Open Config Recovery from your terminal");
    expect(document.body.textContent).not.toContain("Workbench mounted");
  });

  test("opens Config Recovery inside the restricted Settings shell with a terminal grant", async () => {
    dom.reconfigure({ url: "http://localhost/config-recovery#token=recovery-token" });
    window.localStorage.setItem("archcodeTheme", "dark");
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/bootstrap") return Response.json({
        mode: "config_error",
        message: "The global configuration is invalid. Open Config Recovery from the server terminal.",
      });
      if (String(input) === "/api/config-recovery") {
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer recovery-token");
        return Response.json({
          configPath: "/Users/test/.archcode/config.json",
          issues: [{ path: "configuration", message: "This value does not match the current ArchCode configuration format." }],
          removableItems: [],
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    }) as unknown as typeof fetch;

    await act(async () => {
      root.render(<AppRoot><BootstrapGate><p>Workbench mounted</p></BootstrapGate></AppRoot>);
      await Promise.resolve();
    });

    expect(window.location.hash).toBe("");
    expect(document.body.textContent).toContain("Config Recovery");
    expect(document.body.textContent).toContain("/Users/test/.archcode/config.json");
    expect(document.body.textContent).toContain("Retry configuration");
    expect(document.body.textContent).toContain("Reset entire Config — last resort");
    expect(document.body.textContent).toContain("About & Updates");
    expect((document.querySelector("button[aria-label^='Models, unavailable']") as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).not.toContain("Workbench mounted");
  });
});
