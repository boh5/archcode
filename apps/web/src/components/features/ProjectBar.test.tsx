import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Project } from "../../api/types";

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

type ProjectBarComponent = typeof import("./ProjectBar").ProjectBar;

const Fragment = Symbol.for("react.fragment");
const jsxDEV = mock((type: unknown, props: Record<string, unknown> | null, key?: unknown) => ({
  type,
  props: props ?? {},
  key,
}));

const project: Project = {
  slug: "demo-project",
  name: "Demo Project",
  workspaceRoot: "/workspace/demo-project",
  addedAt: "2026-01-01T00:00:00.000Z",
};

const navigate = mock((_path: string) => {});
const onAddProject = mock(() => {});
const onSettings = mock(() => {});
const setState = mock((_value: unknown) => {});
const useState = mock(<T,>(initial: T): [T, (value: T | ((previous: T) => T)) => void] => [
  initial,
  setState as (value: T | ((previous: T) => T)) => void,
]);
const useCallback = mock(<T extends (...args: never[]) => unknown>(callback: T) => callback);
const useNavigate = mock(() => navigate);
const useParams = mock(() => ({ slug: "demo-project" }));
const useProjects = mock(() => ({ data: [project] }));
const toggleTheme = mock(() => {});
const useTheme = mock(() => ({ theme: "dark", toggleTheme }));

let ProjectBar: ProjectBarComponent;

mock.module("react", () => ({
  default: {},
  useState,
  useCallback,
  useEffect: (_callback: () => void | (() => void), _deps?: unknown[]) => {},
  useRef: <T,>(initial: T) => ({ current: initial }),
  useMemo: <T,>(factory: () => T) => factory(),
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

mock.module("../../api/queries", () => ({
  queryKeys: {},
  projectsQueryOptions: () => ({}),
  sessionsQueryOptions: (_slug: string) => ({}),
  sessionQueryOptions: (_slug: string, _sessionId: string) => ({}),
  diffQueryOptions: (_slug: string) => ({}),
  useProjects,
  useSessions: (_slug: string) => ({ data: [] }),
  useSession: (_slug: string, _sessionId: string) => ({ data: null }),
  useDiff: (_slug: string) => ({ data: [] }),
  useDirectoryList: (_path: string, _limit?: number) => ({ data: { entries: [], truncated: false }, isLoading: false, error: null }),
  useDirectorySearch: (_query: string, _limit?: number) => ({ data: { entries: [], truncated: false }, isLoading: false, error: null }),
}));

mock.module("../../hooks/use-theme", () => ({
  useTheme,
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

mock.module("../../api/mutations", () => ({
  useAddProject: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
  useUpdateProjectName: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
  useDeleteProject: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
  useCreateSession: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
  usePostCommand: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
}));

({ ProjectBar } = await import("./ProjectBar"));

function render(): unknown {
  return ProjectBar({ onAddProject, onSettings });
}

function projectNode(tree: unknown) {
  const menu = findAll(tree, (element) => typeName(element) === "ProjectActionContextMenu")[0];
  return menu?.props?.children;
}

describe("ProjectBar", () => {
  beforeEach(() => {
    for (const fn of [navigate, onAddProject, onSettings, setState, useState, useCallback, useNavigate, useParams, useProjects, toggleTheme, useTheme]) {
      fn.mockClear();
    }
  });

  test("Ctrl-click and Cmd-click on project icons skip navigation", () => {
    const node = projectNode(render());

    (node as { props: { onClick: (event: { ctrlKey?: boolean; metaKey?: boolean }) => void } }).props.onClick({
      ctrlKey: true,
      metaKey: false,
    });
    (node as { props: { onClick: (event: { ctrlKey?: boolean; metaKey?: boolean }) => void } }).props.onClick({
      ctrlKey: false,
      metaKey: true,
    });

    expect(navigate).not.toHaveBeenCalled();
  });

  test("plain click and keyboard activation navigate to the project", () => {
    const node = projectNode(render()) as {
      props: {
        role: string;
        tabIndex: number;
        onClick: (event: { ctrlKey?: boolean; metaKey?: boolean }) => void;
        onKeyDown: (event: { key: string }) => void;
      };
    };

    expect(node.props.role).toBe("button");
    expect(node.props.tabIndex).toBe(0);
    expect(textContent(node)).toContain("de");

    node.props.onClick({ ctrlKey: false, metaKey: false });
    node.props.onKeyDown({ key: "Enter" });
    node.props.onKeyDown({ key: " " });

    expect(navigate.mock.calls).toEqual([
      ["/projects/demo-project"],
      ["/projects/demo-project"],
      ["/projects/demo-project"],
    ]);
  });

  test("add project affordance is keyboard accessible", () => {
    const addNode = findAll(
      render(),
      (element) => element.props?.role === "button" && textContent(element).includes("Open project"),
    )[0];

    expect(addNode?.props?.tabIndex).toBe(0);
    (addNode?.props?.onKeyDown as (event: { key: string }) => void)({ key: "Enter" });
    (addNode?.props?.onKeyDown as (event: { key: string }) => void)({ key: " " });

    expect(onAddProject).toHaveBeenCalledTimes(2);
  });

  test("settings affordance opens the settings modal", () => {
    const settingsNode = findAll(
      render(),
      (element) => element.props?.title === "Settings",
    )[0] as {
      props: {
        onClick: () => void;
        onKeyDown: (event: { key: string }) => void;
      };
    };

    settingsNode.props.onClick();
    settingsNode.props.onKeyDown({ key: "Enter" });
    settingsNode.props.onKeyDown({ key: " " });

    expect(onSettings).toHaveBeenCalledTimes(3);
    expect(navigate).not.toHaveBeenCalled();
  });
});
