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

type ProjectActionDropdownComponent = typeof import("./ProjectActionMenu").ProjectActionDropdown;
type ProjectActionContextMenuComponent = typeof import("./ProjectActionMenu").ProjectActionContextMenu;

const Fragment = Symbol.for("react.fragment");
const jsxDEV = mock((type: unknown, props: Record<string, unknown> | null, key?: unknown) => ({
  type,
  props: props ?? {},
  key,
}));

const DropdownMenuRoot = "DropdownMenuRoot";
const DropdownMenuTrigger = "DropdownMenuTrigger";
const DropdownMenuContent = "DropdownMenuContent";
const DropdownMenuItem = "DropdownMenuItem";
const DropdownMenuSeparator = "DropdownMenuSeparator";
const ContextMenuRoot = "ContextMenuRoot";
const ContextMenuTrigger = "ContextMenuTrigger";
const ContextMenuContent = "ContextMenuContent";
const ContextMenuItem = "ContextMenuItem";
const ContextMenuSeparator = "ContextMenuSeparator";

const project: Project = {
  slug: "archcode",
  name: "ArchCode",
  workspaceRoot: "/workspace/archcode",
};
const onEdit = mock((_project: Project) => {});
const onClose = mock((_project: Project) => {});

let ProjectActionDropdown: ProjectActionDropdownComponent;
let ProjectActionContextMenu: ProjectActionContextMenuComponent;

mock.module("../ui/DropdownMenu", () => ({
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
}));

mock.module("../ui/ContextMenu", () => ({
  ContextMenuRoot,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
}));

mock.module("react/jsx-dev-runtime", () => ({
  Fragment,
  jsxDEV,
  jsx: jsxDEV,
  jsxs: jsxDEV,
}));

({ ProjectActionDropdown, ProjectActionContextMenu } = await import("./ProjectActionMenu"));

function menuItems(tree: unknown) {
  return findAll(
    tree,
    (element) =>
      typeName(element) === "DropdownMenuItem" || typeName(element) === "ContextMenuItem",
  );
}

describe("ProjectActionMenu", () => {
  beforeEach(() => {
    onEdit.mockClear();
    onClose.mockClear();
  });

  test("dropdown mode renders Edit and Close menu labels and callbacks", () => {
    const tree = ProjectActionDropdown({
      project,
      onEdit,
      onClose,
      trigger: "⋯",
    });
    const items = menuItems(tree);

    expect(items.map(textContent)).toEqual(["Edit", "Close"]);
    expect(items[1]?.props?.className).toContain("text-error");

    (items[0]?.props?.onSelect as () => void)();
    (items[1]?.props?.onSelect as () => void)();

    expect(onEdit).toHaveBeenCalledWith(project);
    expect(onClose).toHaveBeenCalledWith(project);
  });

  test("context menu mode uses the same accessible item text and callbacks", () => {
    const tree = ProjectActionContextMenu({
      project,
      onEdit,
      onClose,
      children: "project trigger",
    });
    const items = menuItems(tree);

    expect(items.map(textContent)).toEqual(["Edit", "Close"]);
    expect(findAll(tree, (element) => typeName(element) === "ContextMenuTrigger")[0]?.props?.asChild).toBe(true);

    (items[0]?.props?.onSelect as () => void)();
    (items[1]?.props?.onSelect as () => void)();

    expect(onEdit).toHaveBeenCalledWith(project);
    expect(onClose).toHaveBeenCalledWith(project);
  });
});
