import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Project } from "../api/types";

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

function findAll(value: unknown, predicate: (element: ElementLike) => boolean): ElementLike[] {
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

function textContent(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textContent).join("");
  return isElement(value) ? textContent(value.props?.children) : "";
}

const Fragment = Symbol.for("react.fragment");
const jsx = mock((type: unknown, props: Record<string, unknown> | null, key?: unknown) => ({
  type,
  props: props ?? {},
  key,
}));

const first: Project = {
  slug: "first project",
  name: "First Project",
  workspaceRoot: "/workspace/first",
  addedAt: "2026-01-01T00:00:00.000Z",
};
const stored: Project = {
  ...first,
  slug: "stored",
  name: "Stored Project",
  workspaceRoot: "/workspace/stored",
};

let query: {
  data: Project[] | undefined;
  error: Error | null;
  isLoading: boolean;
  isFetching: boolean;
  refetch: ReturnType<typeof mock>;
};
const openAddProjectModal = mock(() => {});
const localValues = new Map<string, string>();
let getItemLocked = false;
let removeItemLocked = false;
const removeItem = mock((key: string) => {
  if (removeItemLocked) throw new Error("local storage locked");
  localValues.delete(key);
});
const useEffect = mock((effect: () => void) => effect());

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    localStorage: {
      getItem: (key: string) => {
        if (getItemLocked) throw new Error("local storage locked");
        return localValues.get(key) ?? null;
      },
      removeItem,
    },
  },
});

mock.module("react", () => ({
  default: {},
  forwardRef: (render: (props: Record<string, unknown>, ref: unknown) => unknown) => (
    props: Record<string, unknown>
  ) => render(props, null),
  useEffect,
}));
mock.module("react/jsx-dev-runtime", () => ({ Fragment, jsxDEV: jsx, jsx, jsxs: jsx }));
mock.module("react-router-dom", () => ({ Navigate: "Navigate" }));
mock.module("lucide-react", () => ({
  Check: "Check",
  Ellipsis: "Ellipsis",
  LoaderCircle: "LoaderCircle",
  Moon: "Moon",
  Plus: "Plus",
  RotateCw: "RotateCw",
  Search: "Search",
  Settings: "Settings",
  Sun: "Sun",
}));
mock.module("../api/queries", () => ({ useProjects: () => query }));
mock.module("../context/add-project-modal", () => ({
  useAddProjectModal: () => ({ openAddProjectModal }),
}));

const { LAST_PROJECT_STORAGE_KEY, RootEntryRoute, resolveRootProject } = await import("./root-entry");

describe("RootEntryRoute", () => {
  beforeEach(() => {
    localValues.clear();
    getItemLocked = false;
    removeItemLocked = false;
    removeItem.mockClear();
    openAddProjectModal.mockClear();
    query = {
      data: undefined,
      error: null,
      isLoading: true,
      isFetching: true,
      refetch: mock(async () => {}),
    };
  });

  test("resolves a valid stored project before the server registration order", () => {
    localValues.set(LAST_PROJECT_STORAGE_KEY, stored.slug);
    query = { ...query, data: [first, stored], isLoading: false, isFetching: false };

    const route = RootEntryRoute();
    expect((route as ElementLike).type).toBe("Navigate");
    expect((route as ElementLike).props).toMatchObject({
      replace: true,
      to: "/projects/stored/todos",
    });
    expect(removeItem).not.toHaveBeenCalled();
  });

  test("clears an invalid stored slug only after a successful registry read and uses first server order", () => {
    localValues.set(LAST_PROJECT_STORAGE_KEY, "missing");
    query = { ...query, data: [first, stored], isLoading: false, isFetching: false };

    const route = RootEntryRoute();
    expect((route as ElementLike).props?.to).toBe("/projects/first%20project/todos");
    expect(removeItem).toHaveBeenCalledWith(LAST_PROJECT_STORAGE_KEY);
    expect(resolveRootProject([first, stored], "missing")).toBe(first);
  });

  test("keeps loading, success-empty, and error states distinct", () => {
    const loading = RootEntryRoute();
    expect((loading as ElementLike).props?.role).toBe("status");
    expect(textContent(loading)).not.toContain("Open a project to begin");

    query = { ...query, data: [], isLoading: false, isFetching: false };
    const empty = RootEntryRoute();
    expect(textContent(empty)).toContain("Open a project to begin");
    const open = findAll(empty, (element) => typeof element.props?.onClick === "function" && textContent(element).includes("Open project"))[0];
    (open?.props?.onClick as () => void)();
    expect(openAddProjectModal).toHaveBeenCalledTimes(1);

    localValues.set(LAST_PROJECT_STORAGE_KEY, stored.slug);
    const refetch = mock(async () => {});
    query = { data: [], error: new Error("offline"), isLoading: false, isFetching: false, refetch };
    const error = RootEntryRoute();
    expect(textContent(error)).toContain("Projects unavailable");
    const retry = findAll(error, (element) => element.type === "button" && textContent(element).includes("Retry"))[0];
    (retry?.props?.onClick as () => void)();
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(removeItem).not.toHaveBeenCalledWith(LAST_PROJECT_STORAGE_KEY);
    expect(localValues.get(LAST_PROJECT_STORAGE_KEY)).toBe(stored.slug);
  });

  test("keeps routing from the registry when local preferences are locked", () => {
    getItemLocked = true;
    query = { ...query, data: [first, stored], isLoading: false, isFetching: false };
    expect((RootEntryRoute() as ElementLike).props?.to).toBe("/projects/first%20project/todos");

    getItemLocked = false;
    removeItemLocked = true;
    localValues.set(LAST_PROJECT_STORAGE_KEY, "missing");
    expect((RootEntryRoute() as ElementLike).props?.to).toBe("/projects/first%20project/todos");
  });
});
