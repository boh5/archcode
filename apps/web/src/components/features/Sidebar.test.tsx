import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Project, Session, SessionTreeResponse } from "../../api/types";

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
  slug: "specra",
  name: "Specra",
  workspaceRoot: "/workspace/specra",
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
const useParams = mock(() => ({ slug: "missing-project", sessionId: "" }));
const useCreateSession = mock(() => ({
  mutate: createSessionMutate,
  isPending: false,
}));
let projects: Project[] = [];
let sessions: Session[] = [];
let sessionTree: SessionTreeResponse | null = null;
let createSessionPending = false;
const useProjects = mock(() => ({ data: projects }));
const useSessions = mock((_slug: string) => ({ data: sessions }));
const useSessionTree = mock((_slug: string, _rootSessionId: string) => ({ data: sessionTree }));
const useWorkflow = mock((_slug: string, _sessionId: string) => ({ data: null }));

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
  useAddProject: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
  useUpdateProjectName: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
  useDeleteProject: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
  usePostPermissionResponse: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
  usePostQuestionAnswer: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
  usePostCommand: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
}));

mock.module("../../api/queries", () => ({
  queryKeys: {},
  projectsQueryOptions: () => ({}),
  sessionsQueryOptions: (_slug: string) => ({}),
  sessionQueryOptions: (_slug: string, _sessionId: string) => ({}),
  workflowQueryOptions: (_slug: string, _sessionId: string) => ({}),
  diffQueryOptions: (_slug: string) => ({}),
  useProjects,
  useSessions,
  useSession: (_slug: string, _sessionId: string) => ({ data: null }),
  useSessionTree,
  useWorkflow,
  useDiff: (_slug: string) => ({ data: [] }),
  useDirectoryList: (_path: string, _limit?: number) => ({ data: { entries: [], truncated: false }, isLoading: false, error: null }),
  useDirectorySearch: (_query: string, _limit?: number) => ({ data: { entries: [], truncated: false }, isLoading: false, error: null }),
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
    sessionTree = null;
    createSessionPending = false;
    useParams.mockImplementation(() => ({ slug: "missing-project", sessionId: "" }));
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
      useSessionTree,
      useWorkflow,
    ]) {
      fn.mockClear();
    }
  });

  test("missing active project shows slug fallback and hides project action menu", () => {
    const tree = render();

    expect(textContent(tree)).toContain("missing-project");
    expect(textContent(tree)).not.toContain("/workspace/specra");
    expect(findAll(tree, (element) => typeName(element) === "ProjectActionDropdown")).toHaveLength(0);
  });

  test("active project renders action menu and workspace path", () => {
    projects = [project];
    useParams.mockImplementation(() => ({ slug: "specra", sessionId: "" }));
    const tree = render();

    expect(textContent(tree)).toContain("Specra");
    expect(textContent(tree)).toContain("/workspace/specra");
    expect(findAll(tree, (element) => typeName(element) === "ProjectActionDropdown")).toHaveLength(1);
  });

  test("New Session button exposes disabled state while mutation is pending", () => {
    createSessionPending = true;
    const tree = render();
    const button = findAll(
      tree,
      (element) => element.type === "button" && textContent(element).includes("+ New Session"),
    )[0];

    expect(button?.props?.disabled).toBe(true);
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
    useParams.mockImplementation(() => ({ slug: "specra", sessionId: "child-session" }));

    const tree = render();
    const sessionItems = findAll(tree, (element) => typeName(element) === "SessionItem");
    const agentNodes = findAll(tree, (element) => typeName(element) === "AgentNode");

    expect(useSessionTree).toHaveBeenCalledWith("specra", "root-session");
    expect(textContent(tree)).toContain("Agent Tree");
    expect(sessionItems).toHaveLength(1);
    expect((sessionItems[0].props?.session as Session).sessionId).toBe("root-session");
    expect(agentNodes).toHaveLength(2);
    expect(agentNodes.map((node) => node.props?.name)).toEqual(["Root Session", "Child Session"]);
  });
});
