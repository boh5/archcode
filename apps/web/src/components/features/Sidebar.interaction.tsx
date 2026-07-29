import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type {
  Automation,
  Project,
  ProjectTodo,
  SessionSummaryWithGoal,
} from "../../api/types";
import type { SessionFamilyActivity } from "@archcode/protocol";
import type { ScopedHitlView } from "../../store/hitl-store";

const navigationCalls: string[] = [];
const navigate = mock((path: string) => {
  navigationCalls.push(path);
});
const createSession = { isPending: false, mutate: mock(() => {}) };
const postMessage = { mutate: mock(() => {}) };

let route = {
  pathname: "/projects/demo/sessions/recent",
  params: { slug: "demo", sessionId: "recent", automationId: "" },
};
let sessions: SessionSummaryWithGoal[] = [];
let automations: Automation[] = [];
let projectTodos: ProjectTodo[] = [];
let runtimeInitialized = true;
let runtimeFamilies: Record<
  string,
  { activity: SessionFamilyActivity }
> = {};
let attentionVisibleHitl: ScopedHitlView[] = [];

const Icon = (props: Record<string, unknown>) => <svg {...props} />;
const ListTodoIcon = (props: Record<string, unknown>) => (
  <svg data-icon="list-todo" {...props} />
);

mock.module("react-router-dom", () => ({
  Link: ({ to, children, ...props }: { to: string; children?: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useLocation: () => ({ pathname: route.pathname }),
  useNavigate: () => navigate,
  useParams: () => route.params,
}));

mock.module("lucide-react", () => ({
  ChevronRight: Icon,
  Focus: Icon,
  LayoutDashboard: Icon,
  ListTodo: ListTodoIcon,
  MoreHorizontal: Icon,
  PanelLeftClose: Icon,
  Plus: Icon,
  Trash2: Icon,
  TriangleAlert: Icon,
}));

mock.module("../../api/mutations", () => ({
  useCreateSession: () => createSession,
  useDeleteSession: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
  usePostMessage: () => postMessage,
}));

const project: Project = {
  slug: "demo",
  name: "Demo project",
  workspaceRoot: "/workspace/demo",
  addedAt: "2026-07-25T00:00:00.000Z",
};

mock.module("../../api/queries", () => ({
  useProjects: () => ({ data: [project] }),
  useSessions: () => ({ data: sessions }),
  useSessionTree: () => ({ data: undefined, isLoading: false, error: null }),
  useAutomations: () => ({ data: automations }),
  useProjectTodos: () => ({ data: projectTodos }),
}));

mock.module("../../store/session-runtime-store", () => ({
  runtimeFamilyKey: (slug: string, sessionId: string) => `${slug}:${sessionId}`,
  useSessionRuntimeInitialized: () => runtimeInitialized,
  useSessionRuntimeFamilies: () => runtimeFamilies,
}));

mock.module("../../store/hitl-store", () => ({
  selectSessionFamilyHitl: (
    entries: ScopedHitlView[],
    slug: string,
    rootSessionId: string,
  ) =>
    entries.filter(
      (entry) =>
        entry.projectSlug === slug && entry.rootSessionId === rootSessionId,
    ),
  useAttentionVisibleScopedHitl: () => attentionVisibleHitl,
}));

mock.module("../primitives/StatusGlyph", () => ({
  StatusGlyph: ({ kind, label }: { kind: string; label?: string }) => (
    <span
      aria-label={label}
      data-visual-kind={kind}
      role={label ? "img" : undefined}
    />
  ),
}));

mock.module("./GoalStatusMark", () => ({
  GoalStatusMark: ({ label }: { label?: string }) => (
    <span aria-label={label} data-testid="goal-status-mark" role="img" />
  ),
}));

mock.module("./ProjectActionMenu", () => ({
  ProjectActionDropdown: ({ trigger }: { trigger: ReactNode }) => (
    <>{trigger}</>
  ),
}));

mock.module("./EditProjectDialog", () => ({ EditProjectDialog: () => null }));
mock.module("./CloseProjectDialog", () => ({ CloseProjectDialog: () => null }));

const { Sidebar } = await import("./Sidebar");

function session(
  sessionId: string,
  title: string,
  updatedAt: number,
  goal?: SessionSummaryWithGoal["goal"],
): SessionSummaryWithGoal {
  return {
    sessionId,
    title,
    updatedAt,
    createdAt: updatedAt - 1,
    cwd: "/workspace/demo",
    rootSessionId: sessionId,
    agentName: "lead",
    profile: "principal",
    activeSkillNames: [],
    modelSelection: { model: "test:model" },
    goal,
  } as unknown as SessionSummaryWithGoal;
}

function attention(
  rootSessionId: string,
  source: "tool_permission" | "ask_user",
): ScopedHitlView {
  return {
    projectSlug: "demo",
    ownerSessionId: rootSessionId,
    rootSessionId,
    view: {
      hitlId: `${rootSessionId}-${source}`,
      owner: { type: "session", id: rootSessionId },
      source:
        source === "tool_permission"
          ? { type: "tool_permission", toolCallId: "tool-1", toolName: "bash" }
          : { type: "ask_user", toolCallId: "tool-1" },
      status: "pending",
      displayPayload: { title: "Needs a response", redacted: true },
      allowedActions:
        source === "tool_permission" ? ["approve", "deny"] : ["answer"],
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:00.000Z",
    },
  };
}

function automation(id: string, name: string): Automation {
  return {
    id,
    name,
    status: "active",
    trigger: { kind: "once", at: "2026-07-26T00:00:00.000Z" },
    action: {
      kind: "send_message",
      sessionId: "recent",
      content: "Review status",
    },
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
  } as unknown as Automation;
}

function projectTodo(
  id: string,
  status: ProjectTodo["status"],
  archivedAt?: number,
): ProjectTodo {
  return {
    id,
    title: id,
    body: "",
    status,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...(archivedAt === undefined ? {} : { archivedAt }),
  };
}

let dom: JSDOM;
let root: Root;
let container: HTMLElement;
const originals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
  dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { url: "http://localhost" },
  );
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MouseEvent: dom.window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  navigationCalls.length = 0;
  route = {
    pathname: "/projects/demo/sessions/recent",
    params: { slug: "demo", sessionId: "recent", automationId: "" },
  };
  runtimeInitialized = true;
  runtimeFamilies = {
    "demo:running": { activity: "running" },
    "demo:recent": { activity: "idle" },
  };
  sessions = [
    session("permission", "Review destructive command", 1_753_000_000_000),
    session("question", "Choose the rollout plan", 1_753_000_001_000),
    session("mixed", "Resolve pending requests", 1_753_000_001_500),
    session("running", "Rebuild execution surface", 1_753_000_002_000),
    session("recent", "Tighten workbench hierarchy", 1_753_000_003_000, {
      instanceId: "goal-1",
      settlementReceipts: [],
      generation: 1,
      objective: "Ship the workbench",
      status: "active",
      usage: {
        tokens: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          reasoningTokens: 0,
          cachedInputTokens: 0,
        },
        executionTimeMs: 0,
        executionCount: 0,
      },
      createdAt: 1,
      activatedAt: 1,
      updatedAt: 1,
    }),
  ];
  attentionVisibleHitl = [
    attention("permission", "tool_permission"),
    attention("question", "ask_user"),
    attention("mixed", "tool_permission"),
    attention("mixed", "ask_user"),
  ];
  automations = [automation("auto-1", "Nightly review")];
  projectTodos = [
    projectTodo("idea", "idea"),
    projectTodo("ready", "ready"),
    projectTodo("done", "done"),
    projectTodo("rejected", "rejected"),
    projectTodo("archived", "idea", 2),
  ];
  container = document.getElementById("root")!;
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
});

async function renderSidebar(): Promise<void> {
  await act(async () => root.render(<Sidebar />));
}

describe("Sidebar Session list", () => {
  test("gives Todos a distinct icon and counts only open active work", async () => {
    await renderSidebar();

    const todoLink = container.querySelector(
      'a[href="/projects/demo/todos"]',
    ) as HTMLAnchorElement;
    expect(todoLink.querySelector('[data-icon="list-todo"]')).not.toBeNull();
    expect(
      todoLink.querySelector('[data-testid="sidebar-todo-count"]')?.textContent,
    ).toBe("2");
    expect(todoLink.getAttribute("aria-label")).toBe("Todos, 2 open");
  });

  test("groups by attention, live work, then recency using one-line accessible Session rows", async () => {
    await renderSidebar();

    const groupOrder = [
      ...container.querySelectorAll("[data-testid^=sidebar-session-group-]"),
    ].map((group) => group.getAttribute("data-testid"));
    expect(groupOrder).toEqual([
      "sidebar-session-group-needs-you",
      "sidebar-session-group-running",
      "sidebar-session-group-recent",
    ]);

    const permission = container.querySelector(
      '[data-testid="sidebar-session-permission"]',
    ) as HTMLButtonElement;
    const question = container.querySelector(
      '[data-testid="sidebar-session-question"]',
    ) as HTMLButtonElement;
    const mixed = container.querySelector(
      '[data-testid="sidebar-session-mixed"]',
    ) as HTMLButtonElement;
    const running = container.querySelector(
      '[data-testid="sidebar-session-running"]',
    ) as HTMLButtonElement;
    const recent = container.querySelector(
      '[data-testid="sidebar-session-recent"]',
    ) as HTMLButtonElement;
    expect(
      permission.querySelector('[data-visual-kind="needs_you"]'),
    ).not.toBeNull();
    expect(
      question.querySelector(
        '[data-testid="sidebar-session-attention-question"]',
      )?.textContent,
    ).toContain("Question");
    expect(
      permission.querySelector(
        '[data-testid="sidebar-session-attention-permission"]',
      )?.textContent,
    ).toContain("Permission");
    expect(
      mixed.querySelector('[data-testid="sidebar-session-attention-mixed"]')
        ?.textContent,
    ).toContain("2 requests");
    expect(mixed.textContent).not.toContain("Permission");
    expect(mixed.textContent).not.toContain("Question");
    expect(mixed.getAttribute("aria-label")).toContain("2 requests waiting");
    expect(
      running.querySelector('[data-visual-kind="running"]'),
    ).not.toBeNull();
    expect(recent.querySelector('[data-visual-kind="idle"]')).not.toBeNull();
    expect(
      recent.querySelector('[data-testid="sidebar-session-goal-recent"]'),
    ).not.toBeNull();
    expect(recent.getAttribute("aria-current")).toBe("page");
    expect(permission.getAttribute("aria-label")).toContain("Needs attention");
    expect(permission.getAttribute("aria-label")).toContain(
      "Permission waiting",
    );
    expect(running.textContent).not.toContain("running ·");
    const relativeTime = permission.querySelector("time") as HTMLTimeElement;
    expect(relativeTime).not.toBeNull();
    expect(relativeTime.dateTime).toBe(
      new Date(sessions[0]!.updatedAt).toISOString(),
    );
    expect(relativeTime.title).not.toBe("");
    expect(relativeTime.getAttribute("aria-label")).toContain(
      relativeTime.textContent,
    );
    expect(permission.getAttribute("aria-label")).toContain(
      relativeTime.textContent,
    );
    expect(permission.getAttribute("title")).toBeNull();
    expect(permission.className).toContain("h-9");
    expect(permission.className).toContain("[@media(pointer:coarse)]:min-h-11");
    expect(
      container.querySelector(
        'button[aria-label="Actions for Tighten workbench hierarchy"]',
      ),
    ).not.toBeNull();

    await act(async () => permission.click());
    expect(navigationCalls).toEqual(["/projects/demo/sessions/permission"]);

    route = { ...route, params: { ...route.params, sessionId: "permission" } };
    await renderSidebar();
    expect(permission.getAttribute("aria-current")).toBe("page");
    expect(recent.getAttribute("aria-current")).toBeNull();
  });

  test("keeps waiting and resuming families in the live group without HITL", async () => {
    runtimeFamilies = {
      "demo:waiting": { activity: "waiting_for_human" },
      "demo:resuming": { activity: "resuming" },
    };
    sessions = [
      session("waiting", "Waiting on child", 2),
      session("resuming", "Resuming work", 1),
      session("idle", "Recent work", 0),
    ];
    attentionVisibleHitl = [];

    await renderSidebar();

    const liveGroup = container.querySelector('[data-testid="sidebar-session-group-running"]') as HTMLElement;
    const waiting = container.querySelector('[data-testid="sidebar-session-waiting"]') as HTMLButtonElement;
    const resuming = container.querySelector('[data-testid="sidebar-session-resuming"]') as HTMLButtonElement;
    expect(liveGroup).not.toBeNull();
    expect(waiting.getAttribute("aria-label")).toContain("Waiting");
    expect(waiting.querySelector('[data-visual-kind="pending"]')).not.toBeNull();
    expect(resuming.getAttribute("aria-label")).toContain("Resuming");
    expect(resuming.querySelector('[data-visual-kind="running"]')).not.toBeNull();
  });

  test("keeps Automation navigation and creation surface available from its tab", async () => {
    await renderSidebar();

    const automationTab = [...container.querySelectorAll('[role="tab"]')].find(
      (element) => element.textContent === "Automations",
    ) as HTMLButtonElement;
    await act(async () => automationTab.click());

    const panel = container.querySelector(
      "#sidebar-panel-automations",
    ) as HTMLElement;
    expect(panel.hidden).toBe(false);
    const row = container.querySelector(
      '[data-testid="sidebar-automation-auto-1"]',
    ) as HTMLButtonElement;
    expect(row.textContent).toContain("Nightly review");
    expect(row.textContent).not.toContain("auto-1");
    expect(row.className).toContain("h-8");
    expect(row.className).toContain("[@media(pointer:coarse)]:min-h-11");
    expect(row.getAttribute("aria-label")).toContain("auto-1");
    await act(async () => row.click());
    expect(navigationCalls).toEqual(["/projects/demo/automations/auto-1"]);
  });
});
