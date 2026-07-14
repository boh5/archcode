import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Automation, GoalState, Project, SessionSummary, SessionTreeResponse } from "../../api/types";
import type { SessionFamilyRuntimeProjection } from "@archcode/protocol";

interface ElementLike {
  type?: unknown;
  props?: Record<string, unknown> | null;
}

function isElement(value: unknown): value is ElementLike {
  return typeof value === "object" && value !== null && "props" in value;
}

function childrenOf(value: unknown): unknown[] {
  if (!isElement(value)) return [];
  const children = value.props?.children;
  if (children === undefined || children === null) return [];
  return Array.isArray(children) ? children : [children];
}

function textContent(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (!isElement(value)) return "";
  return textContent(value.props?.children);
}

function findAll(
  value: unknown,
  predicate: (element: ElementLike) => boolean,
): ElementLike[] {
  const matches: ElementLike[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!isElement(node)) return;
    if (predicate(node)) matches.push(node);
    for (const child of childrenOf(node)) visit(child);
  };
  visit(value);
  return matches;
}

function typeName(element: ElementLike): string {
  if (typeof element.type === "string") return element.type;
  if (typeof element.type === "function") return element.type.name;
  return "";
}

type SidebarComponent = typeof import("./Sidebar").Sidebar;

const Fragment = Symbol.for("react.fragment");
const jsxDEV = mock((type: unknown, props: Record<string, unknown> | null, key?: unknown) => ({
  type,
  props: props ?? {},
  key,
}));

const project: Project = {
  slug: "archcode",
  name: "ArchCode",
  workspaceRoot: "/workspace/archcode",
  addedAt: "2026-01-01T00:00:00.000Z",
};

const navigate = mock((_path: string) => {});
const createSessionMutate = mock((_variables: { slug: string }, _options?: unknown) => {});
const setState = mock((_value: unknown) => {});
const useMemo = mock(<T,>(factory: () => T) => factory());
const useState = mock(<T,>(initial: T): [T, (value: T | ((previous: T) => T)) => void] => [
  initial,
  setState as (value: T | ((previous: T) => T)) => void,
]);
const useNavigate = mock(() => navigate);
const useParams = mock(() => ({ slug: "missing-project", sessionId: "", goalId: "" }));
let currentPathname = "/projects/missing-project";
const useLocation = mock(() => ({ pathname: currentPathname }));
const useCreateSession = mock(() => ({
  mutate: createSessionMutate,
  isPending: false,
}));
let projects: Project[] = [];
let sessions: SessionSummary[] = [];
let goals: GoalState[] = [];
let automations: Automation[] = [];
let sessionTree: SessionTreeResponse | null = null;
let createSessionPending = false;
let runtimeInitialized = false;
let runtimeFamilies: Record<string, SessionFamilyRuntimeProjection> = {};
const useProjects = mock(() => ({ data: projects }));
const useSessions = mock((_slug: string) => ({ data: sessions }));
const useGoals = mock((_slug: string) => ({ data: goals }));
const useSessionTree = mock((_slug: string, _rootSessionId: string) => ({ data: sessionTree }));

let Sidebar: SidebarComponent;

mock.module("react", () => ({
  default: {},
  useMemo,
  useState,
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
  useEffect: (_callback: () => void | (() => void), _deps?: unknown[]) => {},
  useRef: <T,>(initial: T) => ({ current: initial }),
}));

mock.module("react/jsx-dev-runtime", () => ({
  Fragment,
  jsxDEV,
  jsx: jsxDEV,
  jsxs: jsxDEV,
}));

mock.module("react-router-dom", () => ({
  useNavigate,
  useParams,
  useLocation,
  Link: "Link",
}));

mock.module("../../api/mutations", () => ({
  useCreateSession: () => ({
    mutate: createSessionMutate,
    isPending: createSessionPending,
  }),
  usePostMessage: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
  useAddProject: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
  useUpdateProjectName: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
  useDeleteProject: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
  usePostCommand: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
}));

let focusSessionId: string | null = null;
const setFocusSessionId = mock((id: string | null) => { focusSessionId = id; });
const getWebSessionStore = mock((_sessionId: string, _slug?: string) => ({
  getState: () => ({ setFocusSessionId, focusSessionId }),
}));
const useSessionStore = mock((_sessionId: string, selector: (state: { focusSessionId: string | null }) => unknown, _slug?: string) =>
  selector({ focusSessionId }),
);

mock.module("../../store/session-store", () => ({
  getWebSessionStore,
  useSessionStore,
}));

mock.module("../../store/session-runtime-store", () => ({
  runtimeFamilyKey: (projectSlug: string, rootSessionId: string) => `${projectSlug}\u0000${rootSessionId}`,
  useSessionRuntimeInitialized: () => runtimeInitialized,
  useSessionRuntimeFamilies: () => runtimeFamilies,
}));

mock.module("../../context/workbench-layout", () => ({
  useWorkbenchLayout: () => ({
    toggleSidebar: mock(() => {}),
    toggleFocusMode: mock(() => {}),
  }),
}));

mock.module("../../api/queries", () => ({
  queryKeys: {},
  projectsQueryOptions: () => ({}),
  sessionsQueryOptions: (_slug: string) => ({}),
  sessionQueryOptions: (_slug: string, _sessionId: string) => ({}),
  diffQueryOptions: (_slug: string) => ({}),
  useProjects,
  useSessions,
  useGoals,
  useAutomations: (_slug: string) => ({ data: automations }),
  useSession: (_slug: string, _sessionId: string) => ({ data: null }),
  useSessionTree,
  useDiff: (_slug: string) => ({ data: [] }),
  useDirectoryList: (_path: string, _limit?: number) => ({ data: { entries: [], truncated: false }, isLoading: false, error: null }),
  useDirectorySearch: (_query: string, _limit?: number) => ({ data: { entries: [], truncated: false }, isLoading: false, error: null }),
}));

mock.module("lucide-react", () => ({
  ChevronRight: "ChevronRight",
  Focus: "Focus",
  LayoutDashboard: "LayoutDashboard",
  PanelLeftClose: "PanelLeftClose",
  Plus: "Plus",
}));

mock.module("../ui/DropdownMenu", () => ({
  DropdownMenuRoot: "DropdownMenuRoot",
  DropdownMenuTrigger: "DropdownMenuTrigger",
  DropdownMenuContent: "DropdownMenuContent",
  DropdownMenuItem: "DropdownMenuItem",
  DropdownMenuSeparator: "DropdownMenuSeparator",
}));

mock.module("../ui/ContextMenu", () => ({
  ContextMenuRoot: "ContextMenuRoot",
  ContextMenuTrigger: "ContextMenuTrigger",
  ContextMenuContent: "ContextMenuContent",
  ContextMenuItem: "ContextMenuItem",
  ContextMenuSeparator: "ContextMenuSeparator",
}));

mock.module("../ui/Dialog", () => ({
  DialogRoot: "DialogRoot",
  DialogContent: "DialogContent",
  DialogTitle: "DialogTitle",
  DialogDescription: "DialogDescription",
}));

({ Sidebar } = await import("./Sidebar"));

function render(): unknown {
  return Sidebar();
}

describe("Sidebar", () => {
  beforeEach(() => {
    projects = [];
    sessions = [];
    goals = [];
    automations = [];
    sessionTree = null;
    createSessionPending = false;
    runtimeInitialized = false;
    runtimeFamilies = {};
    focusSessionId = null;
    currentPathname = "/projects/missing-project";
    useParams.mockImplementation(() => ({ slug: "missing-project", sessionId: "", goalId: "" }));
    for (const fn of [
      navigate,
      createSessionMutate,
      setState,
      useMemo,
      useState,
      useNavigate,
      useParams,
      useLocation,
      useCreateSession,
      useProjects,
      useSessions,
      useGoals,
      useSessionTree,
      setFocusSessionId,
      getWebSessionStore,
      useSessionStore,
    ]) {
      fn.mockClear();
    }
  });

  test("missing active project shows an unavailable state and hides project action menu", () => {
    const tree = render();

    expect(textContent(tree)).toContain("Project unavailable");
    expect(textContent(tree)).not.toContain("missing-project");
    expect(textContent(tree)).not.toContain("/workspace/archcode");
    expect(findAll(tree, (element) => typeName(element) === "ProjectActionDropdown")).toHaveLength(0);
  });

  test("active project renders action menu and workspace path", () => {
    projects = [project];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "" }));
    currentPathname = "/projects/archcode";
    const tree = render();

    expect(textContent(tree)).toContain("ArchCode");
    expect(textContent(tree)).toContain("/workspace/archcode");
    expect(findAll(tree, (element) => typeName(element) === "ProjectActionDropdown")).toHaveLength(1);
  });

  test("renders the real project dashboard entry without placeholder copy", () => {
    projects = [project];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "" }));
    currentPathname = "/projects/archcode";
    const tree = render();

    const dashboards = findAll(tree, (element) => typeName(element) === "DashboardLinkButton");
    expect(dashboards).toHaveLength(3);
    expect(dashboards[0]?.props?.to).toBe("/projects/archcode");
    expect(dashboards[0]?.props?.label).toBe("Project Dashboard");
    expect(textContent(tree)).not.toContain("Placeholder");
  });

  test("preserves the future sessions dashboard placeholder", () => {
    projects = [project];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "" }));
    currentPathname = "/projects/archcode";
    const tree = render();

    const placeholders = findAll(tree, (element) => typeName(element) === "PlaceholderDashboardButton");
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0]?.props?.label).toBe("Sessions Dashboard");
  });

  test("keeps the project dashboard reachable on session routes", () => {
    projects = [project];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "s1", goalId: "" }));
    currentPathname = "/projects/archcode/sessions/s1";
    const tree = render();

    const dashboards = findAll(tree, (element) => typeName(element) === "DashboardLinkButton");
    expect(dashboards).toHaveLength(3);
    expect(dashboards[0]?.props?.label).toBe("Project Dashboard");
  });


  test("active tab defaults to sessions for project dashboard path", () => {
    projects = [project];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "" }));
    currentPathname = "/projects/archcode";
    const tree = render();

    const tabs = findAll(tree, (element) => element.props?.role === "tab");
    const sessionsTab = tabs.find((t) => t.props?.children === "Sessions");
    expect(sessionsTab?.props?.["aria-selected"]).toBe(true);
  });

  test("clicking tabs switches the sidebar tab without navigating", () => {
    projects = [project];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "" }));
    currentPathname = "/projects/archcode";
    const tree = render();

    setState.mockClear();
    navigate.mockClear();

    const tabs = findAll(tree, (element) => element.props?.role === "tab");
    const sessionsTab = tabs.find((t) => t.props?.children === "Sessions");
    const goalsTab = tabs.find((t) => t.props?.children === "Goals");

    (sessionsTab?.props?.onClick as () => void)?.();
    (goalsTab?.props?.onClick as () => void)?.();

    expect(setState).toHaveBeenCalledWith("sessions");
    expect(setState).toHaveBeenCalledWith("goals");
    expect(navigate).not.toHaveBeenCalled();
  });

  test("active tab derives from /goals path", () => {
    projects = [project];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "" }));
    currentPathname = "/projects/archcode/goals";
    const tree = render();

    const tabs = findAll(tree, (element) => element.props?.role === "tab");
    const goalsTab = tabs.find((t) => t.props?.children === "Goals");
    expect(goalsTab?.props?.["aria-selected"]).toBe(true);
  });


  test("New Session create button exposes disabled state while mutation is pending", () => {
    projects = [project];
    createSessionPending = true;
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "" }));
    currentPathname = "/projects/archcode";
    const tree = render();

    const createButtons = findAll(tree, (element) => typeName(element) === "CreateButton");
    const sessionCreateButton = createButtons.find((b) => b.props?.title === "New session");
    expect(sessionCreateButton).toBeDefined();
    expect(sessionCreateButton?.props?.label).toBe("New session");
    expect(sessionCreateButton?.props?.disabled).toBe(true);
  });

  test("filters sidebar session list to root sessions without rendering agents", () => {
    projects = [project];
    sessions = [
      {
        sessionId: "root-session",
        cwd: "/workspace",
        rootSessionId: "root-session",
        agentName: "engineer",
        modelInfo: null,
        title: "Root Session",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        sessionId: "child-session",
        cwd: "/workspace",
        rootSessionId: "root-session",
        parentSessionId: "root-session",
        agentName: "build",
        modelInfo: null,
        title: "Child Session",
        createdAt: 2,
        updatedAt: 2,
      },
    ];
    sessionTree = {
      root: {
        session: { sessionId: "root-session", cwd: "/workspace", rootSessionId: "root-session", agentName: "engineer", modelInfo: null, title: "Root Session", createdAt: 1, updatedAt: 1 },
        children: [
          {
            session: {
              sessionId: "child-session",
              cwd: "/workspace",
              rootSessionId: "root-session",
              parentSessionId: "root-session",
              agentName: "build",
              modelInfo: null,
              title: "Child Session",
              createdAt: 2,
              updatedAt: 2,
            },
            children: [],
          },
        ],
      },
      diagnostics: [],
    };
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "child-session", goalId: "" }));
    currentPathname = "/projects/archcode/sessions/child-session";

    const tree = render();
    const sessionItems = findAll(tree, (element) => typeName(element) === "SessionItem");
    const agentNodes = findAll(tree, (element) => typeName(element) === "AgentNode");

    expect(sessionItems).toHaveLength(1);
    expect((sessionItems[0].props?.session as SessionSummary).sessionId).toBe("root-session");
    expect(agentNodes).toHaveLength(0);
    expect(textContent(tree)).not.toContain("Agent Tree");
  });

  test("root session activity comes only from the runtime projection, never updatedAt", () => {
    projects = [project];
    sessions = [
      {
        sessionId: "root-running",
        cwd: "/workspace",
        rootSessionId: "root-running",
        agentName: "engineer",
        modelInfo: null,
        title: "Old but running",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        sessionId: "root-idle",
        cwd: "/workspace",
        rootSessionId: "root-idle",
        agentName: "engineer",
        modelInfo: null,
        title: "Fresh but idle",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];
    runtimeInitialized = true;
    runtimeFamilies = {
      "archcode\u0000root-running": {
        projectSlug: "archcode",
        rootSessionId: "root-running",
        activity: "running",
      },
    };
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "" }));
    currentPathname = "/projects/archcode";

    const tree = render();
    const items = findAll(tree, (element) => typeName(element) === "SessionItem");
    const byId = Object.fromEntries(items.map((item) => [
      (item.props?.session as SessionSummary).sessionId,
      item.props?.activity,
    ]));

    expect(byId).toEqual({ "root-running": "running", "root-idle": "idle" });
    const subgroupTitles = findAll(tree, (element) => typeName(element) === "SubGroupHeader")
      .map((element) => element.props?.title);
    expect(subgroupTitles).toEqual(["Active", "Sessions"]);
    expect(subgroupTitles).not.toContain("Completed");
  });

  test("uninitialized runtime gives root sessions a neutral unknown activity", () => {
    projects = [project];
    sessions = [{
      sessionId: "root-1",
      cwd: "/workspace",
      rootSessionId: "root-1",
      agentName: "engineer",
      modelInfo: null,
      title: "Session",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }];
    runtimeInitialized = false;
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "" }));
    currentPathname = "/projects/archcode";

    const tree = render();
    const item = findAll(tree, (element) => typeName(element) === "SessionItem")[0];

    expect(item?.props?.activity).toBeUndefined();
  });

  test("does not keep Agent Tree interaction inside the sidebar", () => {
    projects = [project];
    sessions = [
      {
        sessionId: "root-session",
        cwd: "/workspace",
        rootSessionId: "root-session",
        agentName: "engineer",
        modelInfo: null,
        title: "Root Session",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        sessionId: "child-session",
        cwd: "/workspace",
        rootSessionId: "root-session",
        parentSessionId: "root-session",
        agentName: "explore",
        modelInfo: null,
        title: "Child Session",
        createdAt: 2,
        updatedAt: 2,
      },
    ];
    sessionTree = {
      root: {
        session: { sessionId: "root-session", cwd: "/workspace", rootSessionId: "root-session", agentName: "engineer", modelInfo: null, title: "Root Session", createdAt: 1, updatedAt: 1 },
        children: [
          {
            session: {
              sessionId: "child-session",
              cwd: "/workspace",
              rootSessionId: "root-session",
              parentSessionId: "root-session",
              agentName: "explore",
              modelInfo: null,
              title: "Child Session",
              createdAt: 2,
              updatedAt: 2,
            },
            children: [],
          },
        ],
      },
      diagnostics: [],
    };
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "root-session", goalId: "" }));
    currentPathname = "/projects/archcode/sessions/root-session";

    const tree = render();
    const agentNodes = findAll(tree, (element) => typeName(element) === "AgentNode");

    expect(agentNodes).toHaveLength(0);
    expect(setFocusSessionId).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  test("does not render Agent Tree state in the sidebar", () => {
    projects = [project];
    sessions = [
      {
        sessionId: "root-session",
        cwd: "/workspace",
        rootSessionId: "root-session",
        agentName: "engineer",
        modelInfo: null,
        title: "Root Session",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        sessionId: "child-session",
        cwd: "/workspace",
        rootSessionId: "root-session",
        parentSessionId: "root-session",
        agentName: "explore",
        modelInfo: null,
        title: "Child Session",
        createdAt: 2,
        updatedAt: 2,
      },
    ];
    sessionTree = {
      root: {
        session: { sessionId: "root-session", cwd: "/workspace", rootSessionId: "root-session", agentName: "engineer", modelInfo: null, title: "Root Session", createdAt: 1, updatedAt: 1 },
        children: [
          {
            session: {
              sessionId: "child-session",
              cwd: "/workspace",
              rootSessionId: "root-session",
              parentSessionId: "root-session",
              agentName: "explore",
              modelInfo: null,
              title: "Child Session",
              createdAt: 2,
              updatedAt: 2,
            },
            children: [],
          },
        ],
      },
      diagnostics: [],
    };
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "root-session", goalId: "" }));
    currentPathname = "/projects/archcode/sessions/root-session";

    focusSessionId = "child-session";
    const tree = render();
    expect(findAll(tree, (element) => typeName(element) === "AgentNode")).toHaveLength(0);
  });

  test("goals panel renders goal items and highlights active goal", () => {
    projects = [project];
    goals = [
      {
        id: "goal-1",
        projectSlug: "archcode",
        createdFromSessionId: "origin",
        title: "First Goal",
        objective: "Simplify the Goal experience",
        acceptanceCriteria: "Reviewer can decide DONE from logs and diff.",
        useWorktree: false,
        status: "running",
        attempt: 1,
        reviewGeneration: 0,
        pendingHitlIds: [],
        approvalRefs: [],
        appliedHitlIds: [],
        childSessionIds: [],
        mainSessionId: "main-1",
        startedAt: "1",
        createdAt: "1",
        updatedAt: "1",
      },
      {
        id: "goal-2",
        projectSlug: "archcode",
        createdFromSessionId: "origin",
        title: "Second Goal",
        objective: "Simplify the Goal experience",
        acceptanceCriteria: "Reviewer can decide DONE from logs and diff.",
        useWorktree: false,
        status: "running",
        attempt: 2,
        reviewGeneration: 0,
        pendingHitlIds: [],
        approvalRefs: [],
        appliedHitlIds: [],
        childSessionIds: [],
        mainSessionId: "main-2",
        startedAt: "2",
        createdAt: "2",
        updatedAt: "2",
      },
    ];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "goal-2" }));
    currentPathname = "/projects/archcode/goals/goal-2";

    const tree = render();
    const goalItems = findAll(tree, (element) => typeName(element) === "GoalItem");

    expect(goalItems).toHaveLength(2);
    expect(goalItems[0]?.props?.isActive).toBe(false);
    expect(goalItems[1]?.props?.isActive).toBe(true);
    expect((goalItems[1]?.props?.goal as GoalState).title).toBe("Second Goal");
  });

  test("goals panel shows empty state when no goals", () => {
    projects = [project];
    goals = [];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "" }));
    currentPathname = "/projects/archcode/goals";

    const tree = render();
    expect(textContent(tree)).toContain("No goals yet");
    expect(findAll(tree, (element) => typeName(element) === "GoalItem")).toHaveLength(0);
  });

  test("renders the real goals dashboard entry", () => {
    projects = [project];
    goals = [];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "" }));
    currentPathname = "/projects/archcode/goals";

    const tree = render();
    const dashboards = findAll(tree, (element) => typeName(element) === "DashboardLinkButton");
    expect(dashboards[1]?.props?.to).toBe("/projects/archcode/goals");
    expect(dashboards[1]?.props?.isActive).toBe(true);
  });

  test("clicking a goal item navigates to goal detail route", () => {
    projects = [project];
    goals = [
      {
        id: "goal-abc",
        projectSlug: "archcode",
        createdFromSessionId: "origin",
        title: "Target Goal",
        objective: "Simplify the Goal experience",
        acceptanceCriteria: "Reviewer can decide DONE from logs and diff.",
        useWorktree: false,
        status: "running",
        attempt: 1,
        reviewGeneration: 0,
        pendingHitlIds: [],
        approvalRefs: [],
        appliedHitlIds: [],
        childSessionIds: [],
        mainSessionId: "main-abc",
        startedAt: "1",
        createdAt: "1",
        updatedAt: "1",
      },
    ];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "" }));
    currentPathname = "/projects/archcode/goals";

    const tree = render();
    const goalItems = findAll(tree, (element) => typeName(element) === "GoalItem");
    (goalItems[0]?.props?.onClick as () => void)?.();

    expect(navigate).toHaveBeenCalledWith("/projects/archcode/goals/goal-abc");
  });

  test("new goal create button starts an ordinary skill session", () => {
    projects = [project];
    goals = [];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "" }));
    currentPathname = "/projects/archcode/goals";

    const tree = render();
    const createButtons = findAll(tree, (element) => typeName(element) === "CreateButton");
    const goalCreateButton = createButtons.find((b) => b.props?.title === "New goal");
    expect(goalCreateButton).toBeDefined();
    expect(goalCreateButton?.props?.label).toBe("New goal");
    expect(typeof goalCreateButton?.props?.onClick).toBe("function");

    (goalCreateButton?.props?.onClick as (() => void) | undefined)?.();
    expect(createSessionMutate).toHaveBeenCalled();
  });
});
