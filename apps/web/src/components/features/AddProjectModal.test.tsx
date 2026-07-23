import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { DirectoryEntry, Project } from "../../api/types";

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

type AddProjectModalComponent = typeof import("./AddProjectModal").AddProjectModal;
type StateSetter = (value: unknown) => void;

const Fragment = Symbol.for("react.fragment");
const jsxDEV = mock((type: unknown, props: Record<string, unknown> | null, key?: unknown) => ({
  type,
  props: props ?? {},
  key,
}));

const navigate = mock((_path: string) => {});
const onClose = mock(() => {});
const addProjectMutate = mock((_variables: { path: string; name?: string }, _options?: unknown) => {});
const setInput = mock((_value: unknown) => {});
const setDebouncedInput = mock((_value: unknown) => {});
const setSelectedPath = mock((_value: unknown) => {});
const setActiveIndex = mock((_value: unknown) => {});

let AddProjectModal: AddProjectModalComponent;
let stateIndex = 0;
let stateValues: unknown[] = ["", "", null, -1];
let directoryEntries: DirectoryEntry[] = [];
let directoryCurrent: DirectoryEntry | null = null;
let directoryTruncated = false;
let directoryError: Error | null = null;
let directoryLoading = false;

const stateSetters: StateSetter[] = [
  setInput,
  setDebouncedInput,
  setSelectedPath,
  setActiveIndex,
];

const useState = mock(<T,>(initial: T): [T, (value: T | ((previous: T) => T)) => void] => {
  const index = stateIndex++;
  const value = index in stateValues ? stateValues[index] : initial;
  const setter = stateSetters[index] ?? mock((_value: unknown) => {});
  return [value as T, setter as (value: T | ((previous: T) => T)) => void];
});

const useCallback = mock(<T extends (...args: never[]) => unknown>(callback: T) => callback);
const useEffect = mock((_callback: () => void | (() => void), _deps?: unknown[]) => {});
const useRef = mock(<T,>(initial: T) => ({ current: initial }));
const useNavigate = mock(() => navigate);
const useAddProject = mock(() => ({
  mutate: addProjectMutate,
  isPending: false,
  error: null,
}));
const useDirectoryList = mock((_path: string, _limit?: number) => ({
  data: {
    current: directoryCurrent ?? undefined,
    entries: directoryEntries,
    truncated: directoryTruncated,
  },
  isLoading: directoryLoading,
  error: directoryError,
}));
const useDirectorySearch = mock((_query: string, _limit?: number) => ({
  data: { entries: directoryEntries, truncated: directoryTruncated },
  isLoading: directoryLoading,
  error: directoryError,
}));

mock.module("react", () => ({
  default: {},
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo: <T,>(factory: () => T) => factory(),
}));

mock.module("react/jsx-dev-runtime", () => ({
  Fragment,
  jsxDEV,
  jsx: jsxDEV,
  jsxs: jsxDEV,
}));

const Icon = (props: Record<string, unknown>) => jsxDEV("svg", props);
mock.module("lucide-react", () => ({
  Check: Icon,
  Folder: Icon,
  LoaderCircle: Icon,
  Search: Icon,
  X: Icon,
}));

mock.module("react-router-dom", () => ({
  useNavigate,
}));

mock.module("../../api/mutations", () => ({
  useAddProject,
  useUpdateProjectName: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
  useDeleteProject: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
  useCreateSession: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
}));

mock.module("../../api/queries", () => ({
  queryKeys: {},
  projectsQueryOptions: () => ({}),
  sessionsQueryOptions: (_slug: string) => ({}),
  sessionQueryOptions: (_slug: string, _sessionId: string) => ({}),
  diffQueryOptions: (_slug: string) => ({}),
  useDirectoryList,
  useDirectorySearch,
  useProjects: () => ({ data: [] }),
  useSessions: (_slug: string) => ({ data: [] }),
  useSession: (_slug: string, _sessionId: string) => ({ data: null }),
  useDiff: (_slug: string) => ({ data: [] }),
}));

({ AddProjectModal } = await import("./AddProjectModal"));

function resetMocks(): void {
  stateIndex = 0;
  stateValues = ["", "", null, -1];
  directoryEntries = [];
  directoryCurrent = null;
  directoryTruncated = false;
  directoryError = null;
  directoryLoading = false;
  for (const fn of [
    navigate,
    onClose,
    addProjectMutate,
    setInput,
    setDebouncedInput,
    setSelectedPath,
    setActiveIndex,
    useState,
    useCallback,
    useEffect,
    useRef,
    useNavigate,
    useAddProject,
    useDirectoryList,
    useDirectorySearch,
  ]) {
    fn.mockClear();
  }
}

function renderWithState(values: unknown[] = stateValues): unknown {
  stateIndex = 0;
  stateValues = values;
  return AddProjectModal({ open: true, onClose });
}

describe("AddProjectModal", () => {
  beforeEach(() => {
    resetMocks();
  });

  test("routes path-like input to directory listing and keyword input to search", () => {
    for (const input of ["/Users/bo", "~/Developer", "./src", ".config"]) {
      useDirectoryList.mockClear();
      useDirectorySearch.mockClear();

      renderWithState([input, input, null, -1]);

      expect(useDirectoryList.mock.calls[0]?.[0]).toBe(input);
      expect(useDirectoryList.mock.calls[0]?.[1]).toBe(50);
      expect(useDirectorySearch.mock.calls[0]?.[0]).toBe("");
    }

    useDirectoryList.mockClear();
    useDirectorySearch.mockClear();
    renderWithState(["archcode", "archcode", null, -1]);

    expect(useDirectoryList.mock.calls[0]?.[0]).toBe("");
    expect(useDirectorySearch.mock.calls[0]?.[0]).toBe("archcode");
    expect(useDirectorySearch.mock.calls[0]?.[1]).toBe(50);
  });

  test("renders one directory input, no project name input, and submits only selected path", () => {
    const tree = renderWithState(["", "", "/workspace/archcode", -1]);
    const inputs = findAll(tree, (element) => element.type === "input");

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.props?.placeholder).toBe("Search or type a folder path…");
    expect(textContent(tree)).not.toContain("Name");

    const submit = findAll(
      tree,
      (element) => element.type === "button" && textContent(element).includes("Add Project"),
    )[0];

    expect(submit?.props?.disabled).toBe(false);
    (submit?.props?.onClick as () => void)();

    expect(addProjectMutate.mock.calls[0]?.[0]).toEqual({ path: "/workspace/archcode" });
    expect("name" in (addProjectMutate.mock.calls[0]?.[0] as Record<string, unknown>)).toBe(false);
  });

  test("opens a successfully registered project's Dashboard", () => {
    const tree = renderWithState(["", "", "/workspace/archcode", -1]);
    const submit = findAll(
      tree,
      (element) => element.type === "button" && textContent(element).includes("Add Project"),
    )[0];
    (submit?.props?.onClick as () => void)();

    const options = addProjectMutate.mock.calls[0]?.[1] as { onSuccess: (project: Project) => void };
    options.onSuccess({
      slug: "archcode",
      name: "ArchCode",
      workspaceRoot: "/workspace/archcode",
      addedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(navigate).toHaveBeenCalledWith("/projects/archcode");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("manages directory selection from click, input change, Enter, and Tab", () => {
    directoryEntries = [{ name: "archcode", path: "/workspace/archcode" }];
    directoryCurrent = { name: "workspace", path: "/workspace" };
    const tree = renderWithState(["/workspace", "/workspace", null, 0]);
    const candidate = findAll(tree, (element) => element.props?.["data-index"] === 0)[0];
    const input = findAll(tree, (element) => element.type === "input")[0];

    (candidate?.props?.onClick as () => void)();
    expect(setSelectedPath).toHaveBeenCalledWith("/workspace/archcode");
    expect(setActiveIndex).toHaveBeenCalledWith(0);

    setInput.mockClear();
    setSelectedPath.mockClear();
    (input?.props?.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "/workspace/archcode/src" },
    });
    expect(setInput).toHaveBeenCalledWith("/workspace/archcode/src");
    expect(setSelectedPath).toHaveBeenCalledWith(null);

    setInput.mockClear();
    setSelectedPath.mockClear();
    (input?.props?.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "keyword-search" },
    });
    expect(setInput).toHaveBeenCalledWith("keyword-search");
    expect(setSelectedPath).toHaveBeenCalledWith(null);

    const preventEnter = mock(() => {});
    setSelectedPath.mockClear();
    (input?.props?.onKeyDown as (event: { key: string; preventDefault: () => void }) => void)({
      key: "Enter",
      preventDefault: preventEnter,
    });
    expect(preventEnter).toHaveBeenCalled();
    expect(setSelectedPath).toHaveBeenCalledWith("/workspace/archcode");

    const preventTab = mock(() => {});
    setInput.mockClear();
    setSelectedPath.mockClear();
    (input?.props?.onKeyDown as (event: { key: string; preventDefault: () => void }) => void)({
      key: "Tab",
      preventDefault: preventTab,
    });
    expect(preventTab).toHaveBeenCalled();
    expect(setInput).toHaveBeenCalledWith("/workspace/archcode/");
    expect(setSelectedPath).toHaveBeenCalledWith("/workspace/archcode");
  });

  test("auto-selects resolved current path and allows Enter without child highlight", () => {
    directoryCurrent = { name: "archcode", path: "/workspace/archcode" };
    directoryEntries = [];
    const tree = renderWithState(["/workspace/archcode", "/workspace/archcode", null, -1]);

    const currentButton = findAll(
      tree,
      (element) => element.props?.["data-current-path"] === "/workspace/archcode",
    )[0];
    expect(currentButton).toBeDefined();
    expect(textContent(tree)).toContain("Use this path");
    expect(textContent(tree)).toContain("No subdirectories");

    const input = findAll(tree, (element) => element.type === "input")[0];
    const preventEnter = mock(() => {});
    setSelectedPath.mockClear();
    (input?.props?.onKeyDown as (event: { key: string; preventDefault: () => void }) => void)({
      key: "Enter",
      preventDefault: preventEnter,
    });
    expect(preventEnter).toHaveBeenCalled();
    expect(setSelectedPath).toHaveBeenCalledWith("/workspace/archcode");

    setSelectedPath.mockClear();
    (currentButton?.props?.onClick as () => void)();
    expect(setSelectedPath).toHaveBeenCalledWith("/workspace/archcode");
    expect(setActiveIndex).toHaveBeenCalledWith(-1);
  });

  test("input Escape handler closes the dialog", () => {
    const tree = renderWithState(["", "", null, -1]);
    const input = findAll(tree, (element) => element.type === "input")[0];
    const preventDefault = mock(() => {});

    (input?.props?.onKeyDown as (event: { key: string; preventDefault: () => void }) => void)({
      key: "Escape",
      preventDefault,
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
