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
let projectData: Project[] = [project];
let activeSlug: string | undefined = "demo-project";

const navigate = mock((_path: string) => {});
const onAddProject = mock(() => {});
const onSettings = mock(() => {});
const setState = mock((_value: unknown) => {});
let attentionVisibleHitl: readonly unknown[] = [];
let runtimeFamilies: Record<string, { projectSlug: string; activity: string }> = {};
const useState = mock(<T,>(initial: T): [T, (value: T | ((previous: T) => T)) => void] => [
  initial,
  setState as (value: T | ((previous: T) => T)) => void,
]);
const useCallback = mock(<T extends (...args: never[]) => unknown>(callback: T) => callback);
const useNavigate = mock(() => navigate);
const useParams = mock(() => ({ slug: activeSlug }));
const useProjects = mock(() => ({ data: projectData }));
const toggleTheme = mock(() => {});

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

mock.module("lucide-react", () => ({
  Ellipsis: "Ellipsis",
  Search: "Search",
  Moon: "Moon",
  Plus: "Plus",
  Settings: "Settings",
  Sun: "Sun",
}));

mock.module("../../store/session-runtime-store", () => ({
  useSessionRuntimeFamilies: () => runtimeFamilies,
}));

mock.module("./ProjectPickerDialog", () => ({
  ProjectPickerDialog: "ProjectPickerDialog",
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

mock.module("../../store/hitl-store", () => ({
  useAttentionVisibleScopedHitl: () => attentionVisibleHitl,
}));

mock.module("./HitlBell", () => ({
  HitlBell: "HitlBell",
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
}));

const projectBarModule = await import("./ProjectBar");
({ ProjectBar } = projectBarModule);
const { buildProjectMarks, orderProjectNavigation, selectRailProjects } = projectBarModule;

function render(compactProjectInventory = false): unknown {
  return ProjectBar({ compactProjectInventory, onAddProject, onSettings, theme: "dark", toggleTheme });
}

function projectNode(tree: unknown) {
  const menu = findAll(tree, (element) => typeName(element) === "ProjectActionContextMenu")[0];
  return menu?.props?.children;
}

describe("ProjectBar", () => {
  beforeEach(() => {
    attentionVisibleHitl = [];
    runtimeFamilies = {};
    projectData = [project];
    activeSlug = "demo-project";
    for (const fn of [navigate, onAddProject, onSettings, setState, useState, useCallback, useNavigate, useParams, useProjects, toggleTheme]) {
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

  test("project icon is a native button with active-page semantics", () => {
    const node = projectNode(render()) as {
      props: {
        onClick: (event: { ctrlKey?: boolean; metaKey?: boolean }) => void;
        type: string;
        "aria-current": string;
      };
    };

    expect((node as ElementLike).type).toBe("button");
    expect(node.props.type).toBe("button");
    expect(node.props["aria-current"]).toBe("page");
    expect(String((node as ElementLike).props?.className)).toContain("bg-brand-subtle");
    expect(String((node as ElementLike).props?.className)).toContain("shadow-[inset_0_0_0_1px");
    expect(String((node as ElementLike).props?.className)).toContain("text-brand");
    expect(String((node as ElementLike).props?.className)).not.toContain("bg-signal");
    expect(textContent(node)).toContain("dp");

    node.props.onClick({ ctrlKey: false, metaKey: false });
    expect(navigate).toHaveBeenCalledWith("/projects/demo-project/todos");
  });

  test("brand opens the current project's All todos and is static without a valid project", () => {
    const brand = findAll(
      render(),
      (element) => element.type === "button" && element.props?.["aria-label"] === "Open Demo Project All todos",
    )[0];
    expect(brand).toBeDefined();
    (brand?.props?.onClick as () => void)();
    expect(navigate).toHaveBeenCalledWith("/projects/demo-project/todos");

    activeSlug = undefined;
    projectData = [];
    const staticBrand = findAll(
      render(),
      (element) => element.type === "span" && element.props?.["aria-label"] === "ArchCode",
    )[0];
    expect(staticBrand).toBeDefined();
    expect(staticBrand?.props?.onClick).toBeUndefined();
  });

  test("keeps Search visible without advertising a document shortcut", () => {
    const search = findAll(
      render(),
      (element) => element.type === "button" && element.props?.["aria-label"] === "Search all work",
    )[0];
    expect(search?.props?.title).toBe("Search all work");
    expect(search?.props?.["aria-keyshortcuts"]).toBeUndefined();
  });

  test("shows only project-independent rail controls when no project is registered", () => {
    activeSlug = undefined;
    projectData = [];
    const tree = render();

    expect(findAll(tree, (element) => element.type === "button" && element.props?.["aria-label"] === "Search all work")).toHaveLength(0);
    expect(findAll(tree, (element) => typeName(element) === "HitlBell")).toHaveLength(0);
    expect(findAll(tree, (element) => element.type === "button" && element.props?.["aria-label"] === "Open project")).toHaveLength(1);
    expect(findAll(tree, (element) => element.type === "button" && element.props?.["aria-label"] === "Settings")).toHaveLength(1);
    expect(findAll(render(true), (element) => element.type === "button" && element.props?.["aria-label"] === "More projects")).toHaveLength(0);
  });

  test("add project affordance is a native button", () => {
    const addNode = findAll(
      render(),
      (element) => element.type === "button" && element.props?.["aria-label"] === "Open project",
    )[0];

    expect(addNode?.props?.type).toBe("button");
    (addNode?.props?.onClick as () => void)();

    expect(onAddProject).toHaveBeenCalledTimes(1);
  });

  test("tooltips do not expand project button hit areas", () => {
    const tooltips = findAll(
      render(),
      (element) => element.props?.role === "tooltip",
    );

    expect(tooltips).toHaveLength(2);
    for (const tooltip of tooltips) {
      expect(String(tooltip.props?.className).split(/\s+/)).toContain("pointer-events-none");
    }
  });

  test("counts only this project's attention-visible root family entries on its badge", () => {
    attentionVisibleHitl = [
      { projectSlug: "demo-project", ownerSessionId: "root", rootSessionId: "root", view: { hitlId: "same" } },
      { projectSlug: "demo-project", ownerSessionId: "child", rootSessionId: "root", view: { hitlId: "same" } },
      { projectSlug: "other-project", ownerSessionId: "root", rootSessionId: "root", view: { hitlId: "same" } },
    ];

    const tree = render();
    const projectButton = findAll(tree, (element) => element.type === "button" && String(element.props?.["aria-label"]).startsWith("Open Demo Project, current project"))[0];
    const badges = findAll(tree, (element) => element.props?.["aria-hidden"] === "true" && textContent(element) === "2");
    expect(projectButton?.props?.["aria-label"]).toContain("2 need you");
    expect(badges).toHaveLength(1);
  });

  test("uses the bottom-sheet attention panel on mobile", () => {
    const bell = findAll(render(true), (element) => typeName(element) === "HitlBell")[0];
    expect(bell?.props?.mobile).toBe(true);
  });

  test("derives unique stable lowercase two-letter marks independent of recency order", () => {
    const projects = [
      project,
      { ...project, slug: "demo-platform", name: "Demo Project", workspaceRoot: "/workspace/demo-platform" },
      { ...project, slug: "中文", name: "项目", workspaceRoot: "/workspace/non-latin" },
    ];
    const first = buildProjectMarks(projects);
    const reordered = buildProjectMarks([...projects].reverse());

    expect(reordered).toEqual(first);
    expect(new Set(Object.values(first)).size).toBe(3);
    for (const mark of Object.values(first)) expect(mark).toMatch(/^[a-z]{2}$/);
  });

  test("keeps desktop marks in fixed registration order when recency and active project change", () => {
    const projects = Array.from({ length: 7 }, (_, index) => ({
      ...project,
      slug: `project-${index}`,
      name: `Project ${index}`,
      workspaceRoot: `/workspace/project-${index}`,
      addedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
      lastOpenedAt: `2026-08-0${7 - index}T00:00:00.000Z`,
    }));

    const fixedOrder = projects.slice(0, 5).map((item) => item.slug);
    expect(orderProjectNavigation([...projects].reverse()).map((item) => item.slug)).toEqual(projects.map((item) => item.slug));
    expect(selectRailProjects([...projects].reverse(), undefined, false).map((item) => item.slug)).toEqual(fixedOrder);
    expect(selectRailProjects(projects, "project-6", false).map((item) => item.slug)).toEqual(fixedOrder);
    expect(selectRailProjects(projects, "project-2", false).map((item) => item.slug)).toEqual(fixedOrder);
    expect(selectRailProjects(projects.slice(0, 4), "project-3", false)).toEqual(projects.slice(0, 4));
  });

  test("compact inventory shows only the active project while root entry shows no direct marks", () => {
    const projects = [project, { ...project, slug: "other", workspaceRoot: "/workspace/other" }];
    expect(selectRailProjects(projects, "other", true).map((item) => item.slug)).toEqual(["other"]);
    expect(selectRailProjects(projects, undefined, true)).toEqual([]);
  });

  test("renders the exact full and compact mark/More/Add combinations", () => {
    projectData = Array.from({ length: 6 }, (_, index) => ({
      ...project,
      slug: `project-${index}`,
      name: `Project ${index}`,
      workspaceRoot: `/workspace/project-${index}`,
    }));
    activeSlug = "project-5";
    runtimeFamilies = {
      running: { projectSlug: "project-5", activity: "running" },
      resuming: { projectSlug: "project-5", activity: "resuming" },
      waiting: { projectSlug: "project-5", activity: "waiting_for_human" },
    };

    const desktop = render(false);
    expect(findAll(desktop, (element) => typeName(element) === "ProjectActionContextMenu")).toHaveLength(5);
    expect(findAll(desktop, (element) => element.props?.["aria-label"] === "More projects")).toHaveLength(1);
    expect(findAll(desktop, (element) => element.props?.["aria-label"] === "Open project")).toHaveLength(1);
    const picker = findAll(desktop, (element) => typeName(element) === "ProjectPickerDialog")[0];
    expect((picker?.props?.projects as Project[])).toHaveLength(6);
    expect(picker?.props?.runningCounts).toEqual({ "project-5": 2 });

    const compact = render(true);
    expect(findAll(compact, (element) => typeName(element) === "ProjectActionContextMenu")).toHaveLength(1);
    expect(findAll(compact, (element) => element.props?.["aria-label"] === "More projects")).toHaveLength(1);

    activeSlug = undefined;
    const compactWithoutActiveProject = render(true);
    expect(findAll(compactWithoutActiveProject, (element) => typeName(element) === "ProjectActionContextMenu")).toHaveLength(0);
    expect(findAll(compactWithoutActiveProject, (element) => element.props?.["aria-label"] === "More projects")).toHaveLength(1);
    expect(findAll(compactWithoutActiveProject, (element) => element.props?.["aria-label"] === "Open project")).toHaveLength(1);
  });

  test("settings affordance opens the settings modal", () => {
    const settingsNode = findAll(
      render(),
      (element) => element.props?.title === "Settings",
    )[0] as {
      props: {
        onClick: () => void;
      };
    };

    settingsNode.props.onClick();

    expect(onSettings).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });
});
