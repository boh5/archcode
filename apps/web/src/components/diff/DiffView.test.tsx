import { describe, expect, mock, test } from "bun:test";
import type { DiffFile, DiffHunk, DiffLine } from "@specra/protocol";

interface ElementLike {
  type?: unknown;
  props?: Record<string, unknown> | null;
}

function isElement(value: unknown): value is ElementLike {
  return typeof value === "object" && value !== null && "props" in value;
}

function childrenOf(value: unknown): unknown[] {
  if (!isElement(value)) return [];
  const children = value?.props?.children;
  if (children === undefined || children === null) return [];
  return Array.isArray(children) ? children : [children];
}

function textContent(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (!isElement(value)) return "";
  return textContent(value?.props?.children);
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

function findAllWithClass(value: unknown, className: string): ElementLike[] {
  return findAll(value, (el) => {
    const cls = el?.props?.className;
    return typeof cls === "string" && cls.includes(className);
  });
}

function findWithClass(value: unknown, className: string): ElementLike | undefined {
  return findAllWithClass(value, className)[0];
}

const Fragment = Symbol.for("react.fragment");
const jsxDEV = mock((type: unknown, props: Record<string, unknown> | null, key?: unknown) => {
  const resolvedProps = props ?? {};
  if (typeof type === "function") {
    const result = type(resolvedProps);
    return result;
  }
  return { type, props: resolvedProps, key };
});

const setState = mock(<T,>(_value: T | ((previous: T) => T)) => {});
const useState = mock(<T,>(initialOrInitializer: T | (() => T)): [T, (value: T | ((previous: T) => T)) => void] => {
  const initial = typeof initialOrInitializer === "function"
    ? (initialOrInitializer as () => T)()
    : initialOrInitializer;
  return [initial, setState as (value: T | ((previous: T) => T)) => void];
});

mock.module("react", () => ({
  default: {},
  useState,
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
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

const {
  DiffView,
  DiffFileAccordion,
  DiffHunkBlock,
  DiffLineRow,
  computeDiffLineNumbers,
} = await import("./DiffView");

function makeLine(type: DiffLine["type"], content: string): DiffLine {
  return { type, content };
}

function makeHunk(overrides: Partial<DiffHunk> = {}): DiffHunk {
  return {
    header: "@@ -1,3 +1,3 @@",
    oldStart: 1,
    oldLines: 3,
    newStart: 1,
    newLines: 3,
    lines: [],
    ...overrides,
  };
}

function makeFile(overrides: Partial<DiffFile> = {}): DiffFile {
  return {
    path: "src/index.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    hunks: [],
    ...overrides,
  };
}

describe("computeDiffLineNumbers", () => {
  test("add line: oldLine empty, newLine increments", () => {
    const result = computeDiffLineNumbers(makeLine("add", "new line"), 5, 10);
    expect(result.oldLine).toBe("");
    expect(result.newLine).toBe("10");
    expect(result.nextLine).toEqual({ old: 5, new: 11 });
  });

  test("delete line: newLine empty, oldLine increments", () => {
    const result = computeDiffLineNumbers(makeLine("delete", "old line"), 5, 10);
    expect(result.oldLine).toBe("5");
    expect(result.newLine).toBe("");
    expect(result.nextLine).toEqual({ old: 6, new: 10 });
  });

  test("context line: both lines increment", () => {
    const result = computeDiffLineNumbers(makeLine("context", "same line"), 5, 10);
    expect(result.oldLine).toBe("5");
    expect(result.newLine).toBe("10");
    expect(result.nextLine).toEqual({ old: 6, new: 11 });
  });
});

describe("DiffLineRow", () => {
  test("renders added line with text-success", () => {
    const el = DiffLineRow({
      line: makeLine("add", "added content"),
      oldLine: "",
      newLine: "5",
    });
    const wrapper = findWithClass(el, "bg-success-muted");
    expect(wrapper).toBeDefined();
    expect(textContent(wrapper)).toContain("added content");
  });

  test("renders deleted line with text-error", () => {
    const el = DiffLineRow({
      line: makeLine("delete", "removed content"),
      oldLine: "5",
      newLine: "",
    });
    const wrapper = findWithClass(el, "bg-error-muted");
    expect(wrapper).toBeDefined();
    expect(textContent(wrapper)).toContain("removed content");
  });

  test("renders context line with neutral styling (no color class)", () => {
    const el = DiffLineRow({
      line: makeLine("context", "unchanged"),
      oldLine: "5",
      newLine: "5",
    });
    const successMatches = findAllWithClass(el, "bg-success-muted");
    const errorMatches = findAllWithClass(el, "bg-error-muted");
    expect(successMatches.length).toBe(0);
    expect(errorMatches.length).toBe(0);
  });

  test("renders line number for delete lines (oldLine) and add/context lines (newLine)", () => {
    const deleteEl = DiffLineRow({
      line: makeLine("delete", "removed"),
      oldLine: "42",
      newLine: "",
    });
    const addEl = DiffLineRow({
      line: makeLine("add", "added"),
      oldLine: "",
      newLine: "43",
    });
    const contextEl = DiffLineRow({
      line: makeLine("context", "same"),
      oldLine: "44",
      newLine: "44",
    });
    expect(textContent(deleteEl)).toContain("42");
    expect(textContent(addEl)).toContain("43");
    expect(textContent(contextEl)).toContain("44");
  });

  test("renders + marker for add, - for delete", () => {
    const addEl = DiffLineRow({
      line: makeLine("add", "x"),
      oldLine: "",
      newLine: "1",
    });
    const delEl = DiffLineRow({
      line: makeLine("delete", "x"),
      oldLine: "1",
      newLine: "",
    });
    expect(textContent(addEl)).toContain("+");
    expect(textContent(delEl)).toContain("-");
  });
});

describe("DiffHunkBlock", () => {
  test("renders hunk header", () => {
    const hunk = makeHunk({ header: "@@ -10,5 +10,5 @@" });
    const el = DiffHunkBlock({ hunk });
    expect(textContent(el)).toContain("@@ -10,5 +10,5 @@");
  });

  test("renders lines within hunk", () => {
    const hunk = makeHunk({
      lines: [
        makeLine("context", "unchanged"),
        makeLine("delete", "old line"),
        makeLine("add", "new line"),
      ],
    });
    const el = DiffHunkBlock({ hunk });
    expect(textContent(el)).toContain("unchanged");
    expect(textContent(el)).toContain("old line");
    expect(textContent(el)).toContain("new line");
  });
});

describe("DiffFileAccordion", () => {
  test("renders status badge A for created", () => {
    const file = makeFile({ status: "created", path: "new-file.ts" });
    const el = DiffFileAccordion({
      file,
      isExpanded: false,
      onToggle: () => {},
    });
    const text = textContent(el);
    expect(text).toContain("A");
    expect(text).toContain("new-file.ts");
  });

  test("renders status badge M for modified", () => {
    const file = makeFile({ status: "modified", path: "changed.ts" });
    const el = DiffFileAccordion({
      file,
      isExpanded: false,
      onToggle: () => {},
    });
    expect(textContent(el)).toContain("M");
  });

  test("renders status badge D for deleted", () => {
    const file = makeFile({ status: "deleted", path: "removed.ts" });
    const el = DiffFileAccordion({
      file,
      isExpanded: false,
      onToggle: () => {},
    });
    expect(textContent(el)).toContain("D");
  });

  test("renders additions and deletions counts", () => {
    const file = makeFile({ additions: 5, deletions: 3 });
    const el = DiffFileAccordion({
      file,
      isExpanded: false,
      onToggle: () => {},
    });
    const text = textContent(el);
    expect(text).toContain("+5");
    expect(text).toContain("-3");
  });

  test("shows hunks when expanded", () => {
    const file = makeFile({
      hunks: [makeHunk({ lines: [makeLine("add", "new code")] })],
    });
    const el = DiffFileAccordion({
      file,
      isExpanded: true,
      onToggle: () => {},
    });
    expect(textContent(el)).toContain("new code");
  });

  test("hides hunks when collapsed", () => {
    const file = makeFile({
      hunks: [makeHunk({ lines: [makeLine("add", "hidden code")] })],
    });
    const el = DiffFileAccordion({
      file,
      isExpanded: false,
      onToggle: () => {},
    });
    expect(textContent(el)).not.toContain("hidden code");
  });
});

describe("DiffView", () => {
  test("renders empty state when files array is empty", () => {
    const el = DiffView({ files: [] });
    expect(textContent(el)).toContain("No changes");
  });

  test("renders files when provided", () => {
    const files = [
      makeFile({ path: "a.ts", status: "modified" }),
      makeFile({ path: "b.ts", status: "created" }),
    ];
    const el = DiffView({ files });
    expect(textContent(el)).toContain("a.ts");
    expect(textContent(el)).toContain("b.ts");
  });

  test("defaultExpanded expands all files", () => {
    const files = [
      makeFile({
        path: "expanded.ts",
        hunks: [makeHunk({ lines: [makeLine("add", "visible content")] })],
      }),
    ];
    const el = DiffView({ files, defaultExpanded: true });
    expect(textContent(el)).toContain("visible content");
  });

  test("without defaultExpanded, files start collapsed", () => {
    const files = [
      makeFile({
        path: "collapsed.ts",
        hunks: [makeHunk({ lines: [makeLine("add", "hidden content")] })],
      }),
    ];
    const el = DiffView({ files });
    expect(textContent(el)).not.toContain("hidden content");
  });
});