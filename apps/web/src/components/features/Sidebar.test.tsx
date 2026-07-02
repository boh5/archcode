import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { GoalState, Project, Session, SessionTreeResponse } from "../../api/types";

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
const useParams = mock(() => ({ slug: "missing-project", sessionId: "", goalId: "" }));
const useCreateSession = mock(() => ({
  mutate: createSessionMutate,
  isPending: false,
}));
let projects: Project[] = [];
let sessions: Session[] = [];
let goals: GoalState[] = [];
let sessionTree: SessionTreeResponse | null = null;
let createSessionPending = false;
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
  usePostPermissionResponse: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
  usePostQuestionAnswer: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
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

({ Sidebar } = await import("./Sidebar"));

function render(): unknown {
  return Sidebar();
}

describe("Sidebar", () => {
  beforeEach(() => {
    projects = [];
    sessions = [];
    goals = [];
    sessionTree = null;
    createSessionPending = false;
    focusSessionId = null;
    useParams.mockImplementation(() => ({ slug: "missing-project", sessionId: "", goalId: "" }));
    for (const fn of [
      navigate,
      createSessionMutate,
      setState,
      useMemo,
      useState,
      useNavigate,
      useParams,
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

  test("missing active project shows slug fallback and hides project action menu", () => {
    const tree = render();

    expect(textContent(tree)).toContain("missing-project");
    expect(textContent(tree)).not.toContain("/workspace/archcode");
    expect(findAll(tree, (element) => typeName(element) === "ProjectActionDropdown")).toHaveLength(0);
  });

  test("active project renders action menu and workspace path", () => {
    projects = [project];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "" }));
    const tree = render();

    expect(textContent(tree)).toContain("ArchCode");
    expect(textContent(tree)).toContain("/workspace/archcode");
    expect(findAll(tree, (element) => typeName(element) === "ProjectActionDropdown")).toHaveLength(1);
  });

  test("New Session button exposes disabled state while mutation is pending", () => {
    createSessionPending = true;
    const tree = render();
    const headers = findAll(tree, (element) => typeName(element) === "SectionHeader");
    const sessionsHeader = headers.find((h) => h.props?.title === "Sessions");

    expect(sessionsHeader).toBeDefined();
    expect(sessionsHeader?.props?.actionDisabled).toBe(true);
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
        session: { sessionId: "root-session", rootSessionId: "root-session", agentName: "orchestrator", title: "Root Session", createdAt: 1 },
        children: [
          {
            session: {
              sessionId: "child-session",
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
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "child-session", goalId: "" }));

    const tree = render();
    const sessionItems = findAll(tree, (element) => typeName(element) === "SessionItem");
    const agentNodes = findAll(tree, (element) => typeName(element) === "AgentNode");

    expect(useSessionTree).toHaveBeenCalledWith("archcode", "root-session");
    const headers = findAll(tree, (element) => typeName(element) === "SectionHeader");
    expect(headers.some((h) => h.props?.title === "Agent Tree")).toBe(true);
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
        session: { sessionId: "root-session", rootSessionId: "root-session", title: "Root Session", createdAt: 1 },
        children: [
          {
            session: {
              sessionId: "child-session",
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
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "root-session", goalId: "" }));

    const tree = render();
    const agentNodes = findAll(tree, (element) => typeName(element) === "AgentNode");

    // Click child node → setFocusSessionId(childSessionId)
    const childNode = agentNodes[1];
    (childNode?.props?.onClick as () => void)?.();
    expect(setFocusSessionId).toHaveBeenCalledWith("child-session");
    expect(navigate).not.toHaveBeenCalled();

    setFocusSessionId.mockClear();
    navigate.mockClear();

    // Click root node → setFocusSessionId(null)
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
        session: { sessionId: "root-session", rootSessionId: "root-session", title: "Root Session", createdAt: 1 },
        children: [
          {
            session: {
              sessionId: "child-session",
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
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "root-session", goalId: "" }));

    // focusSessionId is null → root is active
    focusSessionId = null;
    let tree = render();
    let agentNodes = findAll(tree, (element) => typeName(element) === "AgentNode");
    expect(agentNodes[0]?.props?.isActive).toBe(true);
    expect(agentNodes[1]?.props?.isActive).toBe(false);

    // focusSessionId is child → child is active
    focusSessionId = "child-session";
    tree = render();
    agentNodes = findAll(tree, (element) => typeName(element) === "AgentNode");
    expect(agentNodes[0]?.props?.isActive).toBe(false);
    expect(agentNodes[1]?.props?.isActive).toBe(true);
  });

  test("goals section renders goal items and highlights active goal", () => {
    projects = [project];
    goals = [
      {
        id: "goal-1",
        projectId: "archcode",
        title: "First Goal",
        status: "draft",
        phase: "plan",
        doneConditions: [],
        doneResults: {},
        reviewerAgent: "reviewer",
        retryPolicy: { maxRetries: 2, backoffMs: 1000, escalateOnFailure: true },
        retryCount: 0,
        approvalPoints: [],
        author: "architect",
        childSessionIds: [],
        createdAt: "1",
        updatedAt: "1",
      },
      {
        id: "goal-2",
        projectId: "archcode",
        title: "Second Goal",
        status: "running",
        phase: "build",
        doneConditions: [],
        doneResults: {},
        reviewerAgent: "reviewer",
        retryPolicy: { maxRetries: 2, backoffMs: 1000, escalateOnFailure: true },
        retryCount: 1,
        approvalPoints: [],
        author: "architect",
        childSessionIds: [],
        createdAt: "2",
        updatedAt: "2",
      },
    ];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "goal-2" }));

    const tree = render();
    const goalItems = findAll(tree, (element) => typeName(element) === "GoalItem");

    expect(goalItems).toHaveLength(2);
    expect(goalItems[0]?.props?.isActive).toBe(false);
    expect(goalItems[1]?.props?.isActive).toBe(true);
    expect((goalItems[1]?.props?.goal as GoalState).title).toBe("Second Goal");
  });

  test("goals section shows empty state when no goals", () => {
    projects = [project];
    goals = [];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "" }));

    const tree = render();
    expect(textContent(tree)).toContain("No goals yet");
    expect(findAll(tree, (element) => typeName(element) === "GoalItem")).toHaveLength(0);
  });

  test("clicking goals title navigates to goals route", () => {
    projects = [project];
    goals = [];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "" }));

    const tree = render();
    const headers = findAll(tree, (element) => typeName(element) === "SectionHeader");
    const goalsHeader = headers.find((h) => h.props?.title === "Goals");
    (goalsHeader?.props?.onTitleClick as () => void)?.();

    expect(navigate).toHaveBeenCalledWith("/projects/archcode/goals");
  });

  test("clicking a goal item navigates to goal detail route", () => {
    projects = [project];
    goals = [
      {
        id: "goal-abc",
        projectId: "archcode",
        title: "Target Goal",
        status: "draft",
        phase: "plan",
        doneConditions: [],
        doneResults: {},
        reviewerAgent: "reviewer",
        retryPolicy: { maxRetries: 2, backoffMs: 1000, escalateOnFailure: true },
        retryCount: 0,
        approvalPoints: [],
        author: "architect",
        childSessionIds: [],
        createdAt: "1",
        updatedAt: "1",
      },
    ];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "" }));

    const tree = render();
    const goalItems = findAll(tree, (element) => typeName(element) === "GoalItem");
    (goalItems[0]?.props?.onClick as () => void)?.();

    expect(navigate).toHaveBeenCalledWith("/projects/archcode/goals/goal-abc");
  });

  test("new goal action button opens CreateGoalDialog", () => {
    projects = [project];
    goals = [];
    useParams.mockImplementation(() => ({ slug: "archcode", sessionId: "", goalId: "" }));

    const tree = render();
    const headers = findAll(tree, (element) => typeName(element) === "SectionHeader");
    const goalsHeader = headers.find((h) => h.props?.title === "Goals");

    expect(typeof goalsHeader?.props?.onAction).toBe("function");
    expect(goalsHeader?.props?.actionTitle).toBe("New goal");
    expect(goalsHeader?.props?.count).toBe(0);

    const dialogs = findAll(tree, (element) => typeName(element) === "CreateGoalDialog");
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]?.props?.slug).toBe("archcode");
  });
});
