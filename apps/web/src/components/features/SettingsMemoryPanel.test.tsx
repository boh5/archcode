import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { ServerConfig } from "../../api/config";

type MockDestructiveActionDialogProps = {
  open: boolean;
  title: string;
  confirmLabel: string;
  pendingLabel: string;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
};

mock.module("./DestructiveActionDialog", () => ({
  DestructiveActionDialog: ({ open, title, confirmLabel, pendingLabel, pending, onConfirm, onClose }: MockDestructiveActionDialogProps) => open
    ? <div role="dialog"><h2>{title}</h2><button type="button" onClick={onConfirm}>{pending ? pendingLabel : confirmLabel}</button><button type="button" onClick={onClose}>Cancel</button></div>
    : null,
}));

const { SettingsMemoryPanel } = await import("./SettingsMemoryPanel");

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;

const config = {
  provider: {},
  profiles: {},
  memory: { useMemory: true, autoLearning: true },
} as ServerConfig;

const snapshot = {
  preferences: { content: "# Preferences\n", revision: "p1", capacity: { bytes: 14, maxBytes: 8192, state: "within-limit", mutationPolicy: "normal" }, availableForPrompt: true },
  topics: [{ name: "build-tools", title: "Build Tools", description: "Commands", type: "project", revision: "t1", capacity: { bytes: 48, maxBytes: 16384, state: "within-limit", mutationPolicy: "normal" } }],
  index: { revision: "i1", bytes: 48, topicCount: { count: 1, max: 200, state: "within-limit", canCreate: true }, availableForPrompt: true },
  warnings: [],
} as const;

function installDom() {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
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
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) Object.defineProperty(globalThis, name, { configurable: true, value });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
}

function renderPanel(projectSlug?: string, onChange = () => {}) {
  act(() => root.render(<SettingsMemoryPanel config={config} onChange={onChange} projectSlug={projectSlug} active />));
}

function renderInactivePanel(projectSlug: string) {
  act(() => root.render(<SettingsMemoryPanel config={config} onChange={() => {}} projectSlug={projectSlug} active={false} />));
}

function setControlledValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const prototype = element instanceof dom.window.HTMLTextAreaElement
      ? dom.window.HTMLTextAreaElement.prototype
      : dom.window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(element, value);
    const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
    const props = propsKey
      ? (element as unknown as Record<string, { onChange?: (event: { target: typeof element }) => void }>)[propsKey]
      : undefined;
    props?.onChange?.({ target: element });
  });
}

function clickReactButton(button: HTMLButtonElement | null | undefined) {
  if (!button) return;
  const propsKey = Object.keys(button).find((key) => key.startsWith("__reactProps$"));
  const props = propsKey
    ? (button as unknown as Record<string, { onClick?: () => void }>)[propsKey]
    : undefined;
  act(() => props?.onClick?.());
}

function capacityLabels() {
  return [...container.querySelectorAll<HTMLElement>('[aria-label^="Memory capacity:"]')]
    .map((element) => element.getAttribute("aria-label"));
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => installDom());
afterEach(() => { act(() => root.unmount()); dom.window.close(); });

describe("Settings Memory panel", () => {
  test("does not fetch project Memory without a project and keeps CRUD unavailable", () => {
    const fetchMock = mock(async () => Response.json(snapshot));
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });
    renderPanel();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Open a project to manage Memory");
    expect(container.querySelector('input[aria-label="Use Memory"]')).not.toBeNull();
    expect(container.querySelector('input[aria-label="Auto learning"]')).not.toBeNull();
  });

  test("does not prefetch Memory while another Settings section is active", () => {
    const fetchMock = mock(async () => Response.json(snapshot));
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });
    renderInactivePanel("demo");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("loads the scoped snapshot and fetches a topic only when selected", async () => {
    const fetchMock = mock(async (url: string) => url.endsWith("/memory/topics/build-tools")
      ? Response.json({ ...snapshot.topics[0], content: "commands" })
      : Response.json(snapshot));
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });
    renderPanel("demo");
    await flush();

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/projects/demo/memory");
    expect(container.textContent).toContain("build-tools");
    expect(container.textContent).toContain("Index generated by server");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const topicButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("build-tools"));
    act(() => topicButton?.click());
    await flush();
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/projects/demo/memory/topics/build-tools");
    expect(container.textContent).toContain("commands");
  });

  test("projects edited preferences and existing topic drafts", async () => {
    const fetchMock = mock(async (url: string) => url.endsWith("/memory/topics/build-tools")
      ? Response.json({ ...snapshot.topics[0], content: "commands" })
      : Response.json(snapshot));
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });
    renderPanel("demo");
    await flush();

    setControlledValue(container.querySelector('textarea[aria-label="Personal Memory"]') as HTMLTextAreaElement, "偏好");
    expect(capacityLabels()).toContain("Memory capacity: 6 B of 8.0 KiB");

    const topicButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("build-tools"));
    act(() => topicButton?.click());
    await flush();
    setControlledValue(container.querySelector('textarea[aria-label="Topic Markdown content"]') as HTMLTextAreaElement, "😀");
    // The canonical frontmatter is 62 bytes; the emoji body is four UTF-8 bytes.
    expect(capacityLabels()).toContain("Memory capacity: 66 B of 16 KiB");
  });

  test("includes canonical frontmatter bytes for a new topic", async () => {
    const fetchMock = mock(async () => Response.json(snapshot));
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });
    renderPanel("demo");
    await flush();

    const newTopic = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("New topic"));
    act(() => newTopic?.click());
    const nameInput = container.querySelector('section[aria-labelledby="project-memory-heading"] input[type="text"]') as HTMLInputElement;
    setControlledValue(nameInput, "new-topic");

    // `title` falls back to the normalized name and the empty body still has
    // the complete canonical frontmatter document around it.
    expect(capacityLabels()).toContain("Memory capacity: 52 B of 16 KiB");
  });

  test("keeps an edited draft after a revision conflict and offers reload", async () => {
    let call = 0;
    const fetchMock = mock(async (_url: string, init?: RequestInit) => {
      call += 1;
      if (init?.method === "PUT") return Response.json({ error: { code: "MEMORY_REVISION_CONFLICT", message: "Memory changed" } }, { status: 409 });
      return Response.json(snapshot);
    });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });
    renderPanel("demo");
    await flush();
    const textarea = container.querySelector('textarea[aria-label="Personal Memory"]') as HTMLTextAreaElement;
    setControlledValue(textarea, "draft that must stay");
    const save = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Save Personal Memory"));
    act(() => save?.click());
    await flush();
    expect(call).toBeGreaterThanOrEqual(2);
    expect((container.querySelector('textarea[aria-label="Personal Memory"]') as HTMLTextAreaElement | null)?.value).toBe("draft that must stay");
    expect(container.textContent).toContain("changed elsewhere");
    expect(container.textContent).toContain("Reload latest");
  });

  test("renders legacy capacity warnings, recovers, and completes CRUD through confirmation", async () => {
    const legacyPreferences = "p".repeat(25 * 1024);
    const topicHeader = "---\nname: Oversized\ndescription: legacy topic\ntype: project\n---\n";
    const oversizedTopicContent = "t".repeat(20 * 1024 - new TextEncoder().encode(topicHeader).byteLength);
    const oversizedTopicSummary = {
      ...snapshot.topics[0],
      name: "oversized",
      title: "Oversized",
      description: "legacy topic",
      capacity: {
        bytes: 20 * 1024,
        maxBytes: 16 * 1024,
        state: "over-limit" as const,
        mutationPolicy: "shrink-only" as const,
      },
    };
    const oversizedTopic = {
      ...oversizedTopicSummary,
      content: oversizedTopicContent,
    };
    const legacyTopics = Array.from({ length: 201 }, (_, index) => index === 0
      ? oversizedTopicSummary
      : {
        ...snapshot.topics[0],
        name: `legacy_${index}`,
      });
    const legacySnapshot = {
      preferences: {
        ...snapshot.preferences,
        content: legacyPreferences,
        capacity: {
          bytes: 25 * 1024,
          maxBytes: 8 * 1024,
          state: "over-limit" as const,
          mutationPolicy: "shrink-only" as const,
        },
        availableForPrompt: false,
      },
      topics: legacyTopics,
      index: {
        ...snapshot.index,
        bytes: 201 * 48,
        topicCount: { count: 201, max: 200, state: "over-limit" as const, canCreate: false },
        availableForPrompt: false,
      },
      warnings: [
        {
          code: "preferences_over_capacity" as const,
          target: "preferences",
          message: "Personal Memory is over 8 KiB and must be reduced before it can grow.",
        },
        {
          code: "topic_over_capacity" as const,
          target: "oversized",
          message: "Memory topic oversized is over 16 KiB and must be reduced before it can grow.",
        },
        {
          code: "topic_count_over_capacity" as const,
          target: "project topics",
          message: "Project Memory has 201 topics; reduce it to 200 before creating another topic.",
        },
      ],
    };
    const compliantPreferences = {
      ...snapshot.preferences,
      content: "compliant preferences",
      capacity: { bytes: 22, maxBytes: 8 * 1024, state: "within-limit" as const, mutationPolicy: "normal" as const },
      availableForPrompt: true,
    };
    const recoveredSnapshot = {
      ...snapshot,
      preferences: compliantPreferences,
      topics: [],
      index: {
        ...snapshot.index,
        bytes: 0,
        topicCount: { count: 0, max: 200, state: "within-limit" as const, canCreate: true },
      },
      warnings: [],
    };
    const createdTopic = {
      ...snapshot.topics[0],
      name: "new-topic",
      title: "New Topic",
      description: "Created from Settings",
      content: "created body",
      revision: "new-topic-revision",
    };
    const createdSnapshot = {
      ...recoveredSnapshot,
      topics: [{
        name: createdTopic.name,
        title: createdTopic.title,
        description: createdTopic.description,
        type: createdTopic.type,
        revision: createdTopic.revision,
        capacity: createdTopic.capacity,
      }],
      index: {
        ...recoveredSnapshot.index,
        bytes: 62,
        topicCount: { count: 1, max: 200, state: "within-limit" as const, canCreate: true },
      },
    };
    const finalSnapshot = recoveredSnapshot;
    const snapshots = [legacySnapshot, recoveredSnapshot, createdSnapshot, finalSnapshot];
    let snapshotIndex = 0;
    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT" && url.endsWith("/memory/preferences")) {
        return Response.json(compliantPreferences);
      }
      if (init?.method === "PUT" && url.endsWith("/memory/topics/new-topic")) {
        return Response.json(createdTopic);
      }
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (url.endsWith("/memory/topics/oversized")) return Response.json(oversizedTopic);
      if (url.endsWith("/memory/topics/new-topic")) return Response.json(createdTopic);
      return Response.json(snapshots[Math.min(snapshotIndex++, snapshots.length - 1)]);
    });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });

    renderPanel("demo");
    await flush();

    expect(container.textContent).toContain("Personal Memory is over 8 KiB");
    expect(container.textContent).toContain("Memory topic oversized is over 16 KiB");
    expect(container.textContent).toContain("Project Memory has 201 topics");
    expect(container.textContent).toContain("201/200 topics");
    expect(capacityLabels()).toContain("Memory capacity: 25 KiB of 8.0 KiB");
    const blockedNewTopic = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("New topic"));
    expect(blockedNewTopic?.disabled).toBe(true);

    const oversizedButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("oversized"));
    act(() => oversizedButton?.click());
    await flush();
    expect(capacityLabels()).toContain("Memory capacity: 20 KiB of 16 KiB");

    setControlledValue(container.querySelector('textarea[aria-label="Personal Memory"]') as HTMLTextAreaElement, "compliant preferences");
    const savePreferences = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Save Personal Memory"));
    act(() => savePreferences?.click());
    await flush();
    expect(fetchMock.mock.calls.some(([url, init]) => url.endsWith("/memory/preferences") && init?.method === "PUT")).toBe(true);
    expect(container.querySelector('[aria-label="Memory warnings"]')).toBeNull();
    expect(container.textContent).toContain("0/200 topics");

    const newTopicButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("New topic"));
    expect(newTopicButton?.disabled).toBe(false);
    act(() => newTopicButton?.click());
    const topicInputs = container.querySelectorAll('section[aria-labelledby="project-memory-heading"] input[type="text"]');
    setControlledValue(topicInputs[0] as HTMLInputElement, "new-topic");
    setControlledValue(topicInputs[1] as HTMLInputElement, "New Topic");
    setControlledValue(topicInputs[2] as HTMLInputElement, "Created from Settings");
    setControlledValue(container.querySelector('textarea[aria-label="Topic Markdown content"]') as HTMLTextAreaElement, "created body");
    const createTopicButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Create topic"));
    act(() => createTopicButton?.click());
    await flush();
    expect(fetchMock.mock.calls.some(([url, init]) => url.endsWith("/memory/topics/new-topic") && init?.method === "PUT")).toBe(true);
    expect(container.textContent).toContain("new-topic");

    const deleteTopicButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Delete topic");
    expect(deleteTopicButton).not.toBeUndefined();
    expect(deleteTopicButton?.disabled).toBe(false);
    clickReactButton(deleteTopicButton);
    await flush();
    expect(document.body.textContent).toContain("Delete Memory topic?");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    const dialog = document.body.querySelector('[role="dialog"]');
    const confirmDelete = [...(dialog?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.trim() === "Delete topic");
    act(() => confirmDelete?.click());
    await flush();
    const deleteCall = fetchMock.mock.calls.find(([url, init]) => url.endsWith("/memory/topics/new-topic") && init?.method === "DELETE");
    expect(deleteCall?.[1]?.method).toBe("DELETE");
    expect(JSON.parse(String(deleteCall?.[1]?.body))).toEqual({ expectedRevision: "new-topic-revision" });
    expect(container.textContent).toContain("0/200 topics");
    expect(container.querySelector('[aria-label="Memory warnings"]')).toBeNull();
  });
});
