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

type EditProjectDialogComponent = typeof import("./EditProjectDialog").EditProjectDialog;

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
const updateMutate = mock((_variables: { slug: string; name: string }, _options?: { onSuccess?: () => void }) => {});
const setName = mock((_value: unknown) => {});

const project: Project = {
  slug: "archcode",
  name: "ArchCode",
  workspaceRoot: "/workspace/archcode",
  addedAt: "2026-01-01T00:00:00.000Z",
};

let EditProjectDialog: EditProjectDialogComponent;
let currentName = project.name;
let isPending = false;

const useState = mock(<T,>(_initial: T): [T, (value: T | ((previous: T) => T)) => void] => [
  currentName as T,
  setName as (value: T | ((previous: T) => T)) => void,
]);
const useEffect = mock((_callback: () => void | (() => void), _deps?: unknown[]) => {});
const useCallback = mock(<T extends (...args: never[]) => unknown>(callback: T) => callback);
const useUpdateProjectName = mock(() => ({
  mutate: updateMutate,
  isPending,
  error: null,
}));

mock.module("react", () => ({
  default: {},
  useState,
  useEffect,
  useCallback,
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
  useUpdateProjectName,
  useAddProject: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
  useDeleteProject: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
  useCreateSession: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
  usePostCommand: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
}));

({ EditProjectDialog } = await import("./EditProjectDialog"));

function render(name = currentName): unknown {
  currentName = name;
  return EditProjectDialog({ open: true, onClose, project });
}

function saveButton(tree: unknown) {
  return findAll(
    tree,
    (element) => element.type === "button" && textContent(element).includes("Save"),
  )[0];
}

describe("EditProjectDialog", () => {
  beforeEach(() => {
    currentName = project.name;
    isPending = false;
    for (const fn of [onClose, updateMutate, setName, useState, useEffect, useCallback, useUpdateProjectName]) {
      fn.mockClear();
    }
  });

  test("has dialog title, description, and labelled name input", () => {
    const tree = render();

    expect(textContent(findAll(tree, (element) => typeName(element) === "DialogTitle")[0])).toBe("Edit project");
    expect(textContent(findAll(tree, (element) => typeName(element) === "DialogDescription")[0])).toContain(
      "Change the display name for ArchCode",
    );
    expect(textContent(findAll(tree, (element) => element.type === "label")[0])).toBe("Name");
    expect(findAll(tree, (element) => element.type === "input")[0]?.props?.id).toBe("edit-project-name");
  });

  test("disables Save when name is empty or unchanged", () => {
    expect(saveButton(render(""))?.props?.disabled).toBe(true);
    expect(saveButton(render("   "))?.props?.disabled).toBe(true);
    expect(saveButton(render("ArchCode"))?.props?.disabled).toBe(true);
    expect(saveButton(render(" ArchCode "))?.props?.disabled).toBe(true);
  });

  test("trims changed names on submit and closes after mutation success", () => {
    updateMutate.mockImplementation((_variables, options) => {
      options?.onSuccess?.();
    });
    const tree = render("  Renamed ArchCode  ");
    const form = findAll(tree, (element) => element.type === "form")[0];
    const preventDefault = mock(() => {});

    expect(saveButton(tree)?.props?.disabled).toBe(false);
    (form?.props?.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault });

    expect(preventDefault).toHaveBeenCalled();
    expect(updateMutate.mock.calls[0]?.[0]).toEqual({ slug: "archcode", name: "Renamed ArchCode" });
    expect(onClose).toHaveBeenCalled();
  });

  test("does not submit unchanged names", () => {
    const tree = render("ArchCode");
    const form = findAll(tree, (element) => element.type === "form")[0];

    (form?.props?.onSubmit as (event: { preventDefault: () => void }) => void)({
      preventDefault: mock(() => {}),
    });

    expect(updateMutate).not.toHaveBeenCalled();
  });
});
