import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ApprovalPoint, DoneCondition, GoalState, RetryPolicy } from "../../api/types";
import { validateCondition, sanitizeCondition } from "./CreateGoalDialog";

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

type CreateGoalDialogComponent = typeof import("./CreateGoalDialog").CreateGoalDialog;

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
const onCreated = mock((_goalId: string) => {});
const createMutate = mock(
  (
    _args: {
      slug: string;
      title: string;
      doneConditions: DoneCondition[];
      retryPolicy: RetryPolicy;
      approvalPoints: ApprovalPoint[];
      reviewerAgent: string;
      author: string;
    },
    _options?: { onSuccess?: (goal: GoalState) => void },
  ) => {},
);

let createPending = false;
let createError: Error | null = null;

const useState = mock(<T,>(initial: T): [T, (value: T | ((previous: T) => T)) => void] => {
  let current = initial;
  const setter = mock((value: T | ((previous: T) => T)) => {
    current = typeof value === "function" ? (value as (previous: T) => T)(current) : value;
  });
  return [current, setter];
});

const useCallback = mock(<T extends (...args: never[]) => unknown>(callback: T) => callback);
const useEffect = mock((_callback: () => void | (() => void), _deps?: unknown[]) => {});

mock.module("react", () => ({
  default: {},
  useState,
  useCallback,
  useEffect,
  useRef: <T,>(initial: T) => ({ current: initial }),
  useMemo: <T,>(factory: () => T) => factory(),
  createContext: <T,>(defaultValue: T) => ({ Provider: ({ children }: { children: unknown }) => children, Consumer: () => null, defaultValue }),
  forwardRef: <T,>(render: (props: unknown, ref: unknown) => T) => render,
  createElement: (type: unknown, props?: Record<string, unknown>, ...children: unknown[]) => ({ type, props: props ?? {}, children }),
}));

mock.module("lucide-react", () => ({
  Plus: "Plus",
  Trash2: "Trash2",
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
  useCreateGoal: () => ({ mutate: createMutate, isPending: createPending, error: createError }),
}));

let CreateGoalDialog: CreateGoalDialogComponent;

({ CreateGoalDialog } = await import("./CreateGoalDialog"));

function render(): unknown {
  return CreateGoalDialog({ open: true, onClose, slug: "demo", onCreated });
}

describe("CreateGoalDialog", () => {
  beforeEach(() => {
    createPending = false;
    createError = null;
    for (const fn of [onClose, onCreated, createMutate, useState, useCallback, useEffect]) {
      fn.mockClear();
    }
  });

  test("renders title input, condition kind buttons, and Create Draft submit", () => {
    const tree = render();
    const copy = textContent(tree);

    expect(copy).toContain("New Goal");
    expect(copy).toContain("Title");
    expect(copy).toContain("Done Conditions");
    expect(copy).toContain("File exists");
    expect(copy).toContain("Grep contains");
    expect(copy).toContain("Grep empty");
    expect(copy).toContain("Command succeeds");
    expect(copy).toContain("Tests pass");
    expect(copy).toContain("Typecheck passes");
    expect(copy).toContain("LSP clean");
    expect(copy).toContain("User confirmed");
    expect(copy).toContain("Create Draft");
  });

  test("Create Draft button is disabled when title is empty and no conditions exist", () => {
    const tree = render();
    const submitButton = findAll(
      tree,
      (el) => el.type === "button" && textContent(el).includes("Create Draft"),
    )[0];
    expect(submitButton?.props?.disabled).toBe(true);
  });

  test("retry policy defaults to maxRetries=2 and escalateOnFailure=true", () => {
    const tree = render();
    const copy = textContent(tree);

    expect(copy).toContain("maxRetries");
    expect(copy).toContain("escalate on failure");
  });

  test("approval points default to after_plan and before_complete checked", () => {
    const tree = render();
    const copy = textContent(tree);

    expect(copy).toContain("after_plan");
    expect(copy).toContain("before_complete");
  });

  test("reviewer defaults to reviewer and author defaults to architect", () => {
    const tree = render();
    const inputs = findAll(tree, (el) => el.type === "input") as ElementLike[];
    const reviewerInput = inputs.find((i) => i.props?.id === "new-goal-reviewer");
    const authorInput = inputs.find((i) => i.props?.id === "new-goal-author");

    expect(reviewerInput?.props?.value).toBe("reviewer");
    expect(authorInput?.props?.value).toBe("architect");
  });
});

describe("validateCondition", () => {
  test("file_exists with empty path returns error", () => {
    const condition: DoneCondition = { id: "c1", kind: "file_exists", params: { path: "" }, required: true };
    expect(validateCondition(condition)).toEqual(["path is required"]);
  });

  test("file_exists with whitespace-only path returns error", () => {
    const condition: DoneCondition = { id: "c1", kind: "file_exists", params: { path: "   " }, required: true };
    expect(validateCondition(condition)).toEqual(["path is required"]);
  });

  test("file_exists with valid path returns no errors", () => {
    const condition: DoneCondition = { id: "c1", kind: "file_exists", params: { path: "/src/index.ts" }, required: true };
    expect(validateCondition(condition)).toEqual([]);
  });

  test("grep_contains with empty pattern returns error", () => {
    const condition: DoneCondition = { id: "c1", kind: "grep_contains", params: { pattern: "", path: "", minMatches: 1 }, required: true };
    expect(validateCondition(condition)).toEqual(["pattern is required"]);
  });

  test("grep_contains with valid pattern and empty optional path returns no errors", () => {
    const condition: DoneCondition = { id: "c1", kind: "grep_contains", params: { pattern: "export", path: "", minMatches: 1 }, required: true };
    expect(validateCondition(condition)).toEqual([]);
  });

  test("grep_contains with zero minMatches returns error", () => {
    const condition: DoneCondition = { id: "c1", kind: "grep_contains", params: { pattern: "export", minMatches: 0 }, required: true };
    expect(validateCondition(condition)).toEqual(["minMatches must be a positive integer"]);
  });

  test("grep_empty with empty pattern returns error", () => {
    const condition: DoneCondition = { id: "c1", kind: "grep_empty", params: { pattern: "", path: "src" }, required: true };
    expect(validateCondition(condition)).toEqual(["pattern is required"]);
  });

  test("grep_empty with valid pattern and empty optional path returns no errors", () => {
    const condition: DoneCondition = { id: "c1", kind: "grep_empty", params: { pattern: "TODO", path: "" }, required: true };
    expect(validateCondition(condition)).toEqual([]);
  });

  test("command_succeeds with empty command returns error", () => {
    const condition: DoneCondition = { id: "c1", kind: "command_succeeds", params: { command: "", timeoutMs: 60000 }, required: true };
    expect(validateCondition(condition)).toEqual(["command is required"]);
  });

  test("command_succeeds with valid command returns no errors", () => {
    const condition: DoneCondition = { id: "c1", kind: "command_succeeds", params: { command: "bun run build" }, required: true };
    expect(validateCondition(condition)).toEqual([]);
  });

  test("tests_pass with default command returns no errors", () => {
    const condition: DoneCondition = { id: "c1", kind: "tests_pass", params: { command: "bun test" }, required: true };
    expect(validateCondition(condition)).toEqual([]);
  });

  test("tests_pass with empty command returns no errors (optional)", () => {
    const condition: DoneCondition = { id: "c1", kind: "tests_pass", params: { command: "" }, required: true };
    expect(validateCondition(condition)).toEqual([]);
  });

  test("typecheck_pass with default command returns no errors", () => {
    const condition: DoneCondition = { id: "c1", kind: "typecheck_pass", params: { command: "bun run typecheck" }, required: true };
    expect(validateCondition(condition)).toEqual([]);
  });

  test("lsp_clean with valid severity returns no errors", () => {
    const condition: DoneCondition = { id: "c1", kind: "lsp_clean", params: { severity: "error" }, required: true };
    expect(validateCondition(condition)).toEqual([]);
  });

  test("user_confirmed with empty prompt returns error", () => {
    const condition: DoneCondition = { id: "c1", kind: "user_confirmed", params: { prompt: "" }, required: true };
    expect(validateCondition(condition)).toEqual(["prompt is required"]);
  });

  test("spec_compliance with empty spec path returns error", () => {
    const condition: DoneCondition = { id: "c1", kind: "spec_compliance", params: { specPath: "" }, required: true };
    expect(validateCondition(condition)).toEqual(["specPath is required"]);
  });
});

describe("sanitizeCondition", () => {
  test("file_exists trims path", () => {
    const condition: DoneCondition = { id: "c1", kind: "file_exists", params: { path: "  /src/index.ts  " }, required: true };
    const sanitized = sanitizeCondition(condition);
    expect((sanitized.params as { path: string }).path).toBe("/src/index.ts");
  });

  test("grep_contains omits empty optional path", () => {
    const condition: DoneCondition = { id: "c1", kind: "grep_contains", params: { pattern: "export", path: "", minMatches: 1 }, required: true };
    const sanitized = sanitizeCondition(condition);
    const params = sanitized.params as { pattern: string; path?: string; minMatches?: number };
    expect(params.pattern).toBe("export");
    expect(params.path).toBeUndefined();
    expect(params.minMatches).toBe(1);
  });

  test("grep_contains omits invalid minMatches", () => {
    const condition: DoneCondition = { id: "c1", kind: "grep_contains", params: { pattern: "export", minMatches: 0 }, required: true };
    const sanitized = sanitizeCondition(condition);
    const params = sanitized.params as { pattern: string; minMatches?: number };
    expect(params.minMatches).toBeUndefined();
  });

  test("grep_empty trims pattern and omits empty optional path", () => {
    const condition: DoneCondition = { id: "c1", kind: "grep_empty", params: { pattern: "  TODO  ", path: "" }, required: true };
    const sanitized = sanitizeCondition(condition);
    const params = sanitized.params as { pattern: string; path?: string };
    expect(params.pattern).toBe("TODO");
    expect(params.path).toBeUndefined();
  });

  test("command_succeeds omits invalid timeoutMs", () => {
    const condition: DoneCondition = { id: "c1", kind: "command_succeeds", params: { command: "bun run build", timeoutMs: 0 }, required: true };
    const sanitized = sanitizeCondition(condition);
    const params = sanitized.params as { command: string; timeoutMs?: number };
    expect(params.command).toBe("bun run build");
    expect(params.timeoutMs).toBeUndefined();
  });

  test("tests_pass omits empty command", () => {
    const condition: DoneCondition = { id: "c1", kind: "tests_pass", params: { command: "" }, required: true };
    const sanitized = sanitizeCondition(condition);
    const params = sanitized.params as Record<string, unknown>;
    expect(params.command).toBeUndefined();
  });

  test("tests_pass keeps valid command", () => {
    const condition: DoneCondition = { id: "c1", kind: "tests_pass", params: { command: "bun test" }, required: true };
    const sanitized = sanitizeCondition(condition);
    const params = sanitized.params as { command?: string };
    expect(params.command).toBe("bun test");
  });

  test("lsp_clean keeps valid severity", () => {
    const condition: DoneCondition = { id: "c1", kind: "lsp_clean", params: { severity: "warning" }, required: true };
    const sanitized = sanitizeCondition(condition);
    const params = sanitized.params as { severity?: string };
    expect(params.severity).toBe("warning");
  });
});
