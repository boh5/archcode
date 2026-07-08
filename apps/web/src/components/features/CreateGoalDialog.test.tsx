import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { GoalState } from "../../api/types";

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
      objective: string;
      acceptanceCriteria: string;
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

  test("renders title, objective, and acceptance criteria fields with Create Draft submit", () => {
    const tree = render();
    const copy = textContent(tree);

    expect(copy).toContain("New Goal");
    expect(copy).toContain("Title");
    expect(copy).toContain("Objective");
    expect(copy).toContain("Acceptance Criteria");
    expect(copy).toContain("Create Draft");
  });

  test("does not render old DoneCondition, retry policy, approval points, reviewerAgent, or author controls", () => {
    const tree = render();
    const copy = textContent(tree);

    expect(copy).not.toContain("Done Conditions");
    expect(copy).not.toContain("File exists");
    expect(copy).not.toContain("Grep contains");
    expect(copy).not.toContain("Command succeeds");
    expect(copy).not.toContain("Tests pass");
    expect(copy).not.toContain("Typecheck passes");
    expect(copy).not.toContain("LSP clean");
    expect(copy).not.toContain("User confirmed");
    expect(copy).not.toContain("Retry Policy");
    expect(copy).not.toContain("maxRetries");
    expect(copy).not.toContain("escalate on failure");
    expect(copy).not.toContain("Approval Points");
    expect(copy).not.toContain("after_plan");
    expect(copy).not.toContain("before_complete");
    expect(copy).not.toContain("Reviewer agent");
    expect(copy).not.toContain("Author");
  });

  test("Create Draft button is disabled when title is empty", () => {
    const tree = render();
    const submitButton = findAll(
      tree,
      (el) => el.type === "button" && textContent(el).includes("Create Draft"),
    )[0];
    expect(submitButton?.props?.disabled).toBe(true);
  });

  test("has exactly three input fields: title, objective, acceptanceCriteria", () => {
    const tree = render();
    const inputs = findAll(tree, (el) => el.type === "input") as ElementLike[];
    const textareas = findAll(tree, (el) => el.type === "textarea") as ElementLike[];

    const titleInput = inputs.find((i) => i.props?.id === "new-goal-title");
    const objectiveTextarea = textareas.find((i) => i.props?.id === "new-goal-objective");
    const acceptanceTextarea = textareas.find((i) => i.props?.id === "new-goal-acceptance-criteria");

    expect(titleInput).toBeDefined();
    expect(objectiveTextarea).toBeDefined();
    expect(acceptanceTextarea).toBeDefined();

    // No old fields
    const reviewerInput = inputs.find((i) => i.props?.id === "new-goal-reviewer");
    const authorInput = inputs.find((i) => i.props?.id === "new-goal-author");
    expect(reviewerInput).toBeUndefined();
    expect(authorInput).toBeUndefined();
  });
});