import { describe, expect, mock, test } from "bun:test";
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
  return children === undefined || children === null ? [] : Array.isArray(children) ? children : [children];
}

function findAll(value: unknown, predicate: (element: ElementLike) => boolean): ElementLike[] {
  const matches: ElementLike[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return void node.forEach(visit);
    if (!isElement(node)) return;
    if (predicate(node)) matches.push(node);
    childrenOf(node).forEach(visit);
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
const jsx = (type: unknown, props: Record<string, unknown> | null, key?: unknown) => ({ type, props: props ?? {}, key });
mock.module("react/jsx-dev-runtime", () => ({ Fragment, jsx, jsxs: jsx, jsxDEV: jsx }));
mock.module("react", () => ({
  useMemo: <T,>(factory: () => T) => factory(),
  useState: <T,>(initial: T) => [initial, () => {}],
}));
mock.module("lucide-react", () => ({ Search: "Search", X: "X" }));
mock.module("../primitives/StatusGlyph", () => ({ StatusGlyph: "StatusGlyph" }));
mock.module("../ui/Dialog", () => ({
  DialogRoot: "DialogRoot",
  DialogClose: "DialogClose",
  DialogContent: "DialogContent",
  DialogTitle: "DialogTitle",
  DialogDescription: "DialogDescription",
}));

const { ProjectPickerDialog, filterProjectPickerItems } = await import("./ProjectPickerDialog");

const projects: Project[] = [
  { slug: "archcode", name: "ArchCode", workspaceRoot: "/workspace/archcode", addedAt: "2026-01-01T00:00:00.000Z" },
  { slug: "montage", name: "OpenMontage", workspaceRoot: "/workspace/montage", addedAt: "2026-01-02T00:00:00.000Z" },
];

describe("ProjectPickerDialog", () => {
  test("filters the complete inventory by name, slug, or workspace path", () => {
    expect(filterProjectPickerItems(projects, "open").map((project) => project.slug)).toEqual(["montage"]);
    expect(filterProjectPickerItems(projects, "archcode").map((project) => project.slug)).toEqual(["archcode"]);
    expect(filterProjectPickerItems(projects, "/workspace/montage").map((project) => project.slug)).toEqual(["montage"]);
  });

  test("shows every project with mark, name, path, current state, running count, and attention count", () => {
    const tree = ProjectPickerDialog({
      activeSlug: "archcode",
      attentionCounts: { archcode: 2 },
      marks: { archcode: "ac", montage: "om" },
      onOpenChange: () => {},
      onSelect: () => {},
      open: true,
      projects,
      returnFocusRef: { current: null },
      runningCounts: { archcode: 1, montage: 0 },
    });
    const rows = findAll(tree, (element) => element.type === "button" && String(element.props?.["aria-label"]).includes("running"));

    expect(rows).toHaveLength(2);
    expect(rows[0]?.props?.["aria-current"]).toBe("page");
    expect(rows[0]?.props?.["aria-label"]).toBe("ArchCode, current project, 1 running, 2 need you");
    expect(textContent(rows[0])).toContain("acArchCodeCurrent/workspace/archcode1 running2 need you");
    expect(textContent(rows[1])).toContain("omOpenMontage/workspace/montage0 running0 need you");
    expect(String(findAll(rows[0], (element) => textContent(element) === "2 need you")[0]?.props?.className)).toContain("text-warning");
    expect(String(findAll(rows[1], (element) => textContent(element) === "0 need you")[0]?.props?.className)).toContain("text-text-tertiary");
  });
});
