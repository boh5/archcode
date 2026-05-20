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

type CloseProjectDialogComponent = typeof import("./CloseProjectDialog").CloseProjectDialog;

const Fragment = Symbol.for("react.fragment");
const jsxDEV = mock((type: unknown, props: Record<string, unknown> | null, key?: unknown) => ({
  type,
  props: props ?? {},
  key,
}));

const DialogRoot = "DialogRoot";
const DialogContent = "DialogContent";
const DialogTitle = "DialogTitle";
const DialogDescription = "DialogDescription";
const onClose = mock(() => {});
const onClosed = mock((_project: Project) => {});
const deleteMutate = mock((_slug: string, _options?: { onSuccess?: () => void }) => {});

const project: Project = {
  slug: "specra",
  name: "Specra",
  workspaceRoot: "/workspace/specra",
};

let CloseProjectDialog: CloseProjectDialogComponent;
let isPending = false;

const useCallback = mock(<T extends (...args: never[]) => unknown>(callback: T) => callback);
const useDeleteProject = mock(() => ({
  mutate: deleteMutate,
  isPending,
  error: null,
}));

mock.module("react", () => ({
  default: {},
  useCallback,
  useState: <T,>(initial: T): [T, (value: T | ((previous: T) => T)) => void] => [initial, mock(() => {})],
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

mock.module("../ui/Dialog", () => ({
  DialogRoot,
  DialogContent,
  DialogTitle,
  DialogDescription,
}));

mock.module("../../api/mutations", () => ({
  useDeleteProject,
  useAddProject: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
  useUpdateProjectName: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
  useCreateSession: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
  usePostPermissionResponse: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
  usePostQuestionAnswer: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
  usePostCommand: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
}));

({ CloseProjectDialog } = await import("./CloseProjectDialog"));

function render(): unknown {
  return CloseProjectDialog({ open: true, onClose, project, onClosed });
}

describe("CloseProjectDialog", () => {
  beforeEach(() => {
    isPending = false;
    for (const fn of [onClose, onClosed, deleteMutate, useCallback, useDeleteProject]) {
      fn.mockClear();
    }
  });

  test("renders accessible title, description, and warning that files are not deleted", () => {
    const tree = render();
    const copy = textContent(tree);

    expect(textContent(findAll(tree, (element) => typeName(element) === "DialogTitle")[0])).toBe("Close project");
    expect(textContent(findAll(tree, (element) => typeName(element) === "DialogDescription")[0])).toContain(
      "Remove Specra from the project list",
    );
    expect(copy).toContain("The workspace folder will");
    expect(copy).toContain("not");
    expect(copy).toContain("be deleted");
    expect(copy).toContain("removes the project from the sidebar");
  });

  test("destructive Close Project button deletes by slug and fires callbacks on success", () => {
    deleteMutate.mockImplementation((_slug, options) => {
      options?.onSuccess?.();
    });
    const tree = render();
    const confirm = findAll(
      tree,
      (element) => element.type === "button" && textContent(element).includes("Close Project"),
    )[0];

    expect(confirm?.props?.disabled).toBe(false);
    (confirm?.props?.onClick as () => void)();

    expect(deleteMutate.mock.calls[0]?.[0]).toBe("specra");
    expect(onClosed).toHaveBeenCalledWith(project);
    expect(onClose).toHaveBeenCalled();
  });

  test("buttons are disabled while close mutation is pending", () => {
    isPending = true;
    const tree = render();
    const buttons = findAll(tree, (element) => element.type === "button");

    expect(buttons.map((button) => button.props?.disabled)).toEqual([true, true]);
  });
});
