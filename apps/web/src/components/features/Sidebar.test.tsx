import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { GoalState, LoopState, Project, Session, SessionTreeResponse } from "../../api/types";

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
const useParams = mock(() => ({ slug: "missing-project", sessionId: "", goalId: "", loopId: "" }));
let currentPathname = "/projects/missing-project";
const useLocation = mock(() => ({ pathname: currentPathname }));
const useCreateSession = mock(() => ({
  mutate: createSessionMutate,
  isPending: false,
}));
let projects: Project[] = [];
let sessions: Session[] = [];
let goals: GoalState[] = [];
let loops: LoopState[] = [];
let sessionTree: SessionTreeResponse | null = null;
let createSessionPending = false;
const useProjects = mock(() => ({ data: projects }));
const useSessions = mock((_slug: string) => ({ data: sessions }));
const useGoals = mock((_slug: string) => ({ data: goals }));
const useLoops = mock((_slug: string) => ({ data: loops }));
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
  useCreateGoal: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
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

mock.module("../../api/queries", () => ({
  queryKeys: {},
  projectsQueryOptions: () => ({}),
  sessionsQueryOptions: (_slug: string) => ({}),
  sessionQueryOptions: (_slug: string, _sessionId: string) => ({}),
  diffQueryOptions: (_slug: string) => ({}),
  useProjects,
  useSessions,
  useGoals,
  useLoops,
  useSession: (_slug: string, _sessionId: string) => ({ data: null }),
  useSessionTree,
  useDiff: (_slug: string) => ({ data: [] }),
  useDirectoryList: (_path: string, _limit?: number) => ({ data: { entries: [], truncated: false }, isLoading: false, error: null }),
  useDirectorySearch: (_query: string, _limit?: number) => ({ data: { entries: [], truncated: false }, isLoading: false, error: null }),
}));

mock.module("lucide-react", () => ({
  ChevronRight: "ChevronRight",
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

mock.module("./CreateGoalDialog", () => ({
  CreateGoalDialog: "CreateGoalDialog",
}));

mock.module("./CreateLoopDialog", () => ({
  CreateLoopDialog: "CreateLoopDialog",
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
    loops = [];
    sessionTree = null;
    createSessionPending = false;
    focusSessionId = null;
    currentPathname = "/projects/missing-project";
    useParams.mockImplementation(() => ({ slug: "missing-project", sessionId: "", goalId: "", loopId: "" }));
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
      useLoops,
      useSessionTree,
      setFocusSessionId,
      getWebSessionStore,
      useSessionStore,
    ]) {
      fn.mockClear();
    }
  });

  test("missing active project shows slug fallback and hides project action menu", () => {
    const tree = render();

    expect(textContent(tree)).toContain("missing-project");
    expect(textContent(tree)).not.toContain("/workspace/archcode");
    expect(findAll(tree, (element) => typeName(element) === "ProjectActionDropdown")).toHaveLength(0);
  });

  test("active project renders action menu and workspace path", () => {
    projects = [project];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "", loopId: "" }));
    currentPathname = "/projects/archcode";
    const tree = render();

    expect(textContent(tree)).toContain("ArchCode");
    expect(textContent(tree)).toContain("/workspace/archcode");
    expect(findAll(tree, (element) => typeName(element) === "ProjectActionDropdown")).toHaveLength(1);
  });

  test("project dashboard button links to /projects/:slug and shows active on exact match", () => {
    projects = [project];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "", loopId: "" }));
    currentPathname = "/projects/archcode";
    const tree = render();

    const dashboardButtons = findAll(tree, (element) => typeName(element) === "DashboardLinkButton");
    const projectDashboard = dashboardButtons.find((l) => (l.props?.to as string) === "/projects/archcode");
    expect(projectDashboard).toBeDefined();
    expect(projectDashboard?.props?.isActive).toBe(true);
    expect(projectDashboard?.props?.label).toBe("Project Dashboard");
    expect(projectDashboard?.props?.placeholderLabel).toBe("Placeholder");
  });

  test("sessions dashboard renders as its own obvious placeholder instead of project dashboard link", () => {
    projects = [project];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "", loopId: "" }));
    currentPathname = "/projects/archcode";
    const tree = render();

    const projectDashboardLinks = findAll(tree, (element) =>
      typeName(element) === "DashboardLinkButton" && (element.props?.to as string) === "/projects/archcode",
    );
    expect(projectDashboardLinks).toHaveLength(1);

    const placeholders = findAll(tree, (element) => typeName(element) === "PlaceholderDashboardButton");
    const sessionsDashboard = placeholders.find((element) => element.props?.label === "Sessions Dashboard");
    expect(sessionsDashboard).toBeDefined();
    expect(sessionsDashboard?.props?.description).toContain("dedicated sessions dashboard is not available yet");
  });

  test("project dashboard button is inactive when path is a sub-route", () => {
    projects = [project];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "s1", goalId: "", loopId: "" }));
    currentPathname = "/projects/archcode/sessions/s1";
    const tree = render();

    const dashboardButtons = findAll(tree, (element) => typeName(element) === "DashboardLinkButton");
    const projectDashboard = dashboardButtons.find((l) => (l.props?.to as string) === "/projects/archcode");
    expect(projectDashboard?.props?.isActive).toBe(false);
  });

  test("tab selector renders Sessions, Goals, Loops tabs with accessible roles", () => {
    projects = [project];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "", loopId: "" }));
    currentPathname = "/projects/archcode";
    const tree = render();

    const tabs = findAll(tree, (element) => element.props?.role === "tab");
    expect(tabs).toHaveLength(3);
    expect(tabs.map((t) => t.props?.children)).toEqual(["Sessions", "Goals", "Loops"]);
    expect(tabs.every((t) => t.props?.["aria-selected"] !== undefined)).toBe(true);
    expect(tabs.every((t) => t.props?.["aria-controls"] !== undefined)).toBe(true);

    const tablist = findAll(tree, (element) => element.props?.role === "tablist");
    expect(tablist.length).toBeGreaterThan(0);

    const panels = findAll(tree, (element) => element.props?.role === "tabpanel");
    expect(panels).toHaveLength(3);
  });

  test("active tab defaults to sessions for project dashboard path", () => {
    projects = [project];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "", loopId: "" }));
    currentPathname = "/projects/archcode";
    const tree = render();

    const tabs = findAll(tree, (element) => element.props?.role === "tab");
    const sessionsTab = tabs.find((t) => t.props?.children === "Sessions");
    expect(sessionsTab?.props?.["aria-selected"]).toBe(true);
  });

  test("clicking tabs switches the sidebar tab without navigating", () => {
    projects = [project];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "", loopId: "" }));
    currentPathname = "/projects/archcode";
    const tree = render();

    setState.mockClear();
    navigate.mockClear();

    const tabs = findAll(tree, (element) => element.props?.role === "tab");
    const sessionsTab = tabs.find((t) => t.props?.children === "Sessions");
    const goalsTab = tabs.find((t) => t.props?.children === "Goals");
    const loopsTab = tabs.find((t) => t.props?.children === "Loops");

    (sessionsTab?.props?.onClick as () => void)?.();
    (goalsTab?.props?.onClick as () => void)?.();
    (loopsTab?.props?.onClick as () => void)?.();

    expect(setState).toHaveBeenCalledWith("sessions");
    expect(setState).toHaveBeenCalledWith("goals");
    expect(setState).toHaveBeenCalledWith("loops");
    expect(navigate).not.toHaveBeenCalled();
  });

  test("active tab derives from /goals path", () => {
    projects = [project];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "", loopId: "" }));
    currentPathname = "/projects/archcode/goals";
    const tree = render();

    const tabs = findAll(tree, (element) => element.props?.role === "tab");
    const goalsTab = tabs.find((t) => t.props?.children === "Goals");
    expect(goalsTab?.props?.["aria-selected"]).toBe(true);
  });

  test("active tab derives from /loops path", () => {
    projects = [project];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "", loopId: "" }));
    currentPathname = "/projects/archcode/loops";
    const tree = render();

    const tabs = findAll(tree, (element) => element.props?.role === "tab");
    const loopsTab = tabs.find((t) => t.props?.children === "Loops");
    expect(loopsTab?.props?.["aria-selected"]).toBe(true);
  });

  test("New Session create button exposes disabled state while mutation is pending", () => {
    projects = [project];
    createSessionPending = true;
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "", loopId: "" }));
    currentPathname = "/projects/archcode";
    const tree = render();

    const createButtons = findAll(tree, (element) => typeName(element) === "CreateButton");
    const sessionCreateButton = createButtons.find((b) => b.props?.title === "New session");
    expect(sessionCreateButton).toBeDefined();
    expect(sessionCreateButton?.props?.label).toBe("New session");
    expect(sessionCreateButton?.props?.disabled).toBe(true);
  });

  test("filters sidebar list to roots and fetches active child's root tree", () => {
    projects = [project];
    sessions = [
      {
        id: "root-session",
        sessionId: "root-session",
        rootSessionId: "root-session",
        title: "Root Session",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "child-session",
        sessionId: "child-session",
        rootSessionId: "root-session",
        parentSessionId: "root-session",
        title: "Child Session",
        createdAt: 2,
        updatedAt: 2,
      },
    ];
    sessionTree = {
      root: {
        session: { sessionId: "root-session", cwd: "/workspace", rootSessionId: "root-session", agentName: "orchestrator", title: "Root Session", createdAt: 1 },
        children: [
          {
            session: {
              sessionId: "child-session",
              cwd: "/workspace",
              rootSessionId: "root-session",
              parentSessionId: "root-session",
              agentName: "explore",
              title: "Child Session",
              createdAt: 2,
            },
            children: [],
          },
        ],
      },
      diagnostics: [],
    };
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "child-session", goalId: "", loopId: "" }));
    currentPathname = "/projects/archcode/sessions/child-session";

    const tree = render();
    const sessionItems = findAll(tree, (element) => typeName(element) === "SessionItem");
    const agentNodes = findAll(tree, (element) => typeName(element) === "AgentNode");

    expect(useSessionTree).toHaveBeenCalledWith("archcode", "root-session");
    expect(textContent(tree)).toContain("Agent Tree");
    expect(sessionItems).toHaveLength(1);
    expect((sessionItems[0].props?.session as Session).sessionId).toBe("root-session");
    expect(agentNodes).toHaveLength(2);
    expect(agentNodes.map((node) => node.props?.name)).toEqual(["Root Session", "Child Session"]);
    expect(agentNodes.map((node) => node.props?.agentType)).toEqual(["orchestrator", "explore"]);
  });

  test("agent tree click calls setFocusSessionId instead of navigate", () => {
    projects = [project];
    sessions = [
      {
        id: "root-session",
        sessionId: "root-session",
        rootSessionId: "root-session",
        title: "Root Session",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "child-session",
        sessionId: "child-session",
        rootSessionId: "root-session",
        parentSessionId: "root-session",
        title: "Child Session",
        createdAt: 2,
        updatedAt: 2,
      },
    ];
    sessionTree = {
      root: {
        session: { sessionId: "root-session", cwd: "/workspace", rootSessionId: "root-session", title: "Root Session", createdAt: 1 },
        children: [
          {
            session: {
              sessionId: "child-session",
              cwd: "/workspace",
              rootSessionId: "root-session",
              parentSessionId: "root-session",
              title: "Child Session",
              createdAt: 2,
            },
            children: [],
          },
        ],
      },
      diagnostics: [],
    };
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "root-session", goalId: "", loopId: "" }));
    currentPathname = "/projects/archcode/sessions/root-session";

    const tree = render();
    const agentNodes = findAll(tree, (element) => typeName(element) === "AgentNode");

    const childNode = agentNodes[1];
    (childNode?.props?.onClick as () => void)?.();
    expect(setFocusSessionId).toHaveBeenCalledWith("child-session");
    expect(navigate).not.toHaveBeenCalled();

    setFocusSessionId.mockClear();
    navigate.mockClear();

    const rootNode = agentNodes[0];
    (rootNode?.props?.onClick as () => void)?.();
    expect(setFocusSessionId).toHaveBeenCalledWith(null);
    expect(navigate).not.toHaveBeenCalled();
  });

  test("agent tree isActive follows focusSessionId", () => {
    projects = [project];
    sessions = [
      {
        id: "root-session",
        sessionId: "root-session",
        rootSessionId: "root-session",
        title: "Root Session",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "child-session",
        sessionId: "child-session",
        rootSessionId: "root-session",
        parentSessionId: "root-session",
        title: "Child Session",
        createdAt: 2,
        updatedAt: 2,
      },
    ];
    sessionTree = {
      root: {
        session: { sessionId: "root-session", cwd: "/workspace", rootSessionId: "root-session", title: "Root Session", createdAt: 1 },
        children: [
          {
            session: {
              sessionId: "child-session",
              cwd: "/workspace",
              rootSessionId: "root-session",
              parentSessionId: "root-session",
              title: "Child Session",
              createdAt: 2,
            },
            children: [],
          },
        ],
      },
      diagnostics: [],
    };
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "root-session", goalId: "", loopId: "" }));
    currentPathname = "/projects/archcode/sessions/root-session";

    focusSessionId = null;
    let tree = render();
    let agentNodes = findAll(tree, (element) => typeName(element) === "AgentNode");
    expect(agentNodes[0]?.props?.isActive).toBe(true);
    expect(agentNodes[1]?.props?.isActive).toBe(false);

    focusSessionId = "child-session";
    tree = render();
    agentNodes = findAll(tree, (element) => typeName(element) === "AgentNode");
    expect(agentNodes[0]?.props?.isActive).toBe(false);
    expect(agentNodes[1]?.props?.isActive).toBe(true);
  });

  test("goals panel renders goal items and highlights active goal", () => {
    projects = [project];
    goals = [
      {
        id: "goal-1",
        projectId: "archcode",
        title: "First Goal",
        objective: "Simplify the Goal experience",
        acceptanceCriteria: "Reviewer can decide DONE from logs and diff.",
        status: "draft",
        attempt: 1,
        pendingHitlIds: [],
        approvalRefs: [],
        childSessionIds: [],
        createdAt: "1",
        updatedAt: "1",
      },
      {
        id: "goal-2",
        projectId: "archcode",
        title: "Second Goal",
        objective: "Simplify the Goal experience",
        acceptanceCriteria: "Reviewer can decide DONE from logs and diff.",
        status: "running",
        attempt: 2,
        pendingHitlIds: [],
        approvalRefs: [],
        childSessionIds: [],
        createdAt: "2",
        updatedAt: "2",
      },
    ];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "goal-2", loopId: "" }));
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
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "", loopId: "" }));
    currentPathname = "/projects/archcode/goals";

    const tree = render();
    expect(textContent(tree)).toContain("No goals yet");
    expect(findAll(tree, (element) => typeName(element) === "GoalItem")).toHaveLength(0);
  });

  test("goals dashboard button links to /projects/:slug/goals", () => {
    projects = [project];
    goals = [];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "", loopId: "" }));
    currentPathname = "/projects/archcode/goals";

    const tree = render();
    const dashboardButtons = findAll(tree, (element) => typeName(element) === "DashboardLinkButton");
    const goalsDashboard = dashboardButtons.find((l) => (l.props?.to as string) === "/projects/archcode/goals");
    expect(goalsDashboard).toBeDefined();
    expect(goalsDashboard?.props?.label).toBe("Goals Dashboard");
    expect(goalsDashboard?.props?.isActive).toBe(true);
  });

  test("clicking a goal item navigates to goal detail route", () => {
    projects = [project];
    goals = [
      {
        id: "goal-abc",
        projectId: "archcode",
        title: "Target Goal",
        objective: "Simplify the Goal experience",
        acceptanceCriteria: "Reviewer can decide DONE from logs and diff.",
        status: "draft",
        attempt: 1,
        pendingHitlIds: [],
        approvalRefs: [],
        childSessionIds: [],
        createdAt: "1",
        updatedAt: "1",
      },
    ];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "", loopId: "" }));
    currentPathname = "/projects/archcode/goals";

    const tree = render();
    const goalItems = findAll(tree, (element) => typeName(element) === "GoalItem");
    (goalItems[0]?.props?.onClick as () => void)?.();

    expect(navigate).toHaveBeenCalledWith("/projects/archcode/goals/goal-abc");
  });

  test("new goal create button opens CreateGoalDialog", () => {
    projects = [project];
    goals = [];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "", loopId: "" }));
    currentPathname = "/projects/archcode/goals";

    const tree = render();
    const createButtons = findAll(tree, (element) => typeName(element) === "CreateButton");
    const goalCreateButton = createButtons.find((b) => b.props?.title === "New goal");
    expect(goalCreateButton).toBeDefined();
    expect(goalCreateButton?.props?.label).toBe("New goal");
    expect(typeof goalCreateButton?.props?.onClick).toBe("function");

    const dialogs = findAll(tree, (element) => typeName(element) === "CreateGoalDialog");
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]?.props?.slug).toBe("archcode");
  });

  test("loops panel renders loop items and highlights active loop", () => {
    projects = [project];
    loops = [
      {
        loopId: "loop-aaaa1111",
        projectId: "archcode",
        config: {
          templateId: "watch_report",
          title: "Nightly Watch",
          schedule: { kind: "interval", everyMs: 60000 },
          approvalPolicy: "interactive",
          limits: { maxIterationsPerRun: 10 },
        },
        status: "active",
        createdAt: 1,
        updatedAt: 1,
        runCount: 0,
        stateVersion: 1,
      },
      {
        loopId: "loop-bbbb2222",
        projectId: "archcode",
        config: {
          templateId: "goal_runner",
          title: "PR Babysitter",
          schedule: { kind: "manual" },
          approvalPolicy: "explicit_per_run",
          limits: { maxIterationsPerRun: 5 },
        },
        status: "paused",
        createdAt: 2,
        updatedAt: 2,
        runCount: 0,
        stateVersion: 1,
      },
    ];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "", loopId: "loop-bbbb2222" }));
    currentPathname = "/projects/archcode/loops/loop-bbbb2222";

    const tree = render();
    const loopItems = findAll(tree, (element) => typeName(element) === "LoopItem");

    expect(loopItems).toHaveLength(2);
    expect(loopItems[0]?.props?.isActive).toBe(false);
    expect(loopItems[1]?.props?.isActive).toBe(true);
    expect((loopItems[1]?.props?.loop as LoopState).loopId).toBe("loop-bbbb2222");
  });

  test("loops panel shows empty state when no loops", () => {
    projects = [project];
    loops = [];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "", loopId: "" }));
    currentPathname = "/projects/archcode/loops";

    const tree = render();
    expect(textContent(tree)).toContain("No loops yet");
    expect(findAll(tree, (element) => typeName(element) === "LoopItem")).toHaveLength(0);
  });

  test("loops dashboard button links to /projects/:slug/loops", () => {
    projects = [project];
    loops = [];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "", loopId: "" }));
    currentPathname = "/projects/archcode/loops";

    const tree = render();
    const dashboardButtons = findAll(tree, (element) => typeName(element) === "DashboardLinkButton");
    const loopsDashboard = dashboardButtons.find((l) => (l.props?.to as string) === "/projects/archcode/loops");
    expect(loopsDashboard).toBeDefined();
    expect(loopsDashboard?.props?.label).toBe("Loops Dashboard");
    expect(loopsDashboard?.props?.isActive).toBe(true);
  });

  test("clicking a loop item navigates to loop detail route", () => {
    projects = [project];
    loops = [
      {
        loopId: "loop-xyz12345",
        projectId: "archcode",
        config: {
          templateId: "watch_report",
          title: "Watch Loop",
          schedule: { kind: "manual" },
          approvalPolicy: "interactive",
          limits: { maxIterationsPerRun: 3 },
        },
        status: "active",
        createdAt: 1,
        updatedAt: 1,
        runCount: 0,
        stateVersion: 1,
      },
    ];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "", loopId: "" }));
    currentPathname = "/projects/archcode/loops";

    const tree = render();
    const loopItems = findAll(tree, (element) => typeName(element) === "LoopItem");
    (loopItems[0]?.props?.onClick as () => void)?.();

    expect(navigate).toHaveBeenCalledWith("/projects/archcode/loops/loop-xyz12345");
  });

  test("new loop create button opens CreateLoopDialog", () => {
    projects = [project];
    loops = [];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "", loopId: "" }));
    currentPathname = "/projects/archcode/loops";

    const tree = render();
    const createButtons = findAll(tree, (element) => typeName(element) === "CreateButton");
    const loopCreateButton = createButtons.find((b) => b.props?.title === "New loop");
    expect(loopCreateButton).toBeDefined();
    expect(loopCreateButton?.props?.label).toBe("New loop");
    expect(typeof loopCreateButton?.props?.onClick).toBe("function");

    const dialogs = findAll(tree, (element) => typeName(element) === "CreateLoopDialog");
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]?.props?.slug).toBe("archcode");
  });

  test("root Dashboard with no route slug falls back to first project slug for Loop create", () => {
    projects = [project];
    loops = [];
    // Root Dashboard ("/") has no :slug route param.
    useParams.mockImplementation(() => ({ slug: "", sessionId: "", goalId: "", loopId: "" }));
    currentPathname = "/";

    const tree = render();
    const createButtons = findAll(tree, (element) => typeName(element) === "CreateButton");
    const loopCreateButton = createButtons.find((b) => b.props?.title === "New loop");
    expect(loopCreateButton).toBeDefined();
    // Button stays enabled because a fallback project slug is available.
    expect(loopCreateButton?.props?.disabled).toBeFalsy();

    const dialogs = findAll(tree, (element) => typeName(element) === "CreateLoopDialog");
    expect(dialogs).toHaveLength(1);
    // CreateLoopDialog must receive a non-empty fallback slug, never "".
    expect(dialogs[0]?.props?.slug).toBe("archcode");
  });

  test("root Dashboard with no route slug and no projects disables New loop button", () => {
    projects = [];
    loops = [];
    useParams.mockImplementation(() => ({ slug: "", sessionId: "", goalId: "", loopId: "" }));
    currentPathname = "/";

    const tree = render();
    const createButtons = findAll(tree, (element) => typeName(element) === "CreateButton");
    const loopCreateButton = createButtons.find((b) => b.props?.title === "New loop");
    expect(loopCreateButton).toBeDefined();
    // No fallback slug available -> button disabled so the broken dialog never opens.
    expect(loopCreateButton?.props?.disabled).toBe(true);

    const dialogs = findAll(tree, (element) => typeName(element) === "CreateLoopDialog");
    expect(dialogs).toHaveLength(1);
    // Dialog still renders but receives an empty slug; the disabled button prevents opening it.
    expect(dialogs[0]?.props?.slug).toBe("");
  });

  test("loop item receives loop with empty title and uses placeholder inside component", () => {
    projects = [project];
    loops = [
      {
        loopId: "loop-placeholder9",
        projectId: "archcode",
        config: {
          templateId: "watch_report",
          title: "",
          schedule: { kind: "manual" },
          approvalPolicy: "interactive",
          limits: { maxIterationsPerRun: 3 },
        },
        status: "active",
        createdAt: 1,
        updatedAt: 1,
        runCount: 0,
        stateVersion: 1,
      },
    ];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "", loopId: "" }));
    currentPathname = "/projects/archcode/loops";

    const tree = render();
    const loopItems = findAll(tree, (element) => typeName(element) === "LoopItem");
    expect(loopItems).toHaveLength(1);
    const loopProp = loopItems[0]?.props?.loop as LoopState;
    expect(loopProp.config.title).toBe("");
    expect(loopProp.loopId).toBe("loop-placeholder9");
  });
});
