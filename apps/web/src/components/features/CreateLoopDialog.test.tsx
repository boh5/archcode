import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { LoopConfig, LoopState } from "../../api/types";

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

type CreateLoopFormComponent = typeof import("./CreateLoopDialog").CreateLoopForm;
type LoopFormComponent = typeof import("./CreateLoopDialog").LoopForm;
type BuildLoopConfigFunction = typeof import("./CreateLoopDialog").buildLoopConfig;

const Fragment = Symbol.for("react.fragment");
const jsxDEV = mock((type: unknown, props: Record<string, unknown> | null, key?: unknown) => ({
  type,
  props: props ?? {},
  key,
}));

const onCreated = mock((_loopId: string) => {});
const onClose = mock(() => {});
const createMutate = mock(
  (
    _args: { slug: string; config: LoopConfig; author?: string },
    _options?: { onSuccess?: (response: { loop: LoopState }) => void },
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
const useMemo = mock(<T,>(factory: () => T) => factory());

mock.module("react", () => ({
  default: {},
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef: <T,>(initial: T) => ({ current: initial }),
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
  DialogRoot: "DialogRoot",
  DialogContent: "DialogContent",
  DialogTitle: "DialogTitle",
  DialogDescription: "DialogDescription",
}));

mock.module("../../api/mutations", () => ({
  useCreateLoop: () => ({ mutate: createMutate, isPending: createPending, error: createError }),
  useUpdateLoop: () => ({ mutate: mock(() => {}), isPending: false, error: null }),
}));

let CreateLoopForm: CreateLoopFormComponent;
let LoopForm: LoopFormComponent;
let buildLoopConfig: BuildLoopConfigFunction;

const imported = await import("./CreateLoopDialog");
CreateLoopForm = imported.CreateLoopForm;
LoopForm = imported.LoopForm;
buildLoopConfig = imported.buildLoopConfig;

function render(initialState?: Record<string, unknown>): unknown {
  return LoopForm({
    slug: "demo",
    title: "New Loop",
    description: "",
    submitLabel: "Create Loop",
    pendingLabel: "Creating…",
    pending: createPending,
    error: createError,
    onClose,
    onSubmitConfig: mock((_config: LoopConfig, _author?: string) => {}),
    initialState,
  });
}

describe("CreateLoopDialog Goal template", () => {
  beforeEach(() => {
    createPending = false;
    createError = null;
    for (const fn of [onCreated, onClose, createMutate, useState, useCallback, useEffect, useMemo]) {
      fn.mockClear();
    }
  });

  test("goal runKind renders natural-language Goal template fields: title, objective, acceptance criteria", () => {
    const tree = render({
      runKind: "goal",
      goalTitle: "Triage Follow-up",
      goalObjective: "Investigate failing tests and propose fixes.",
      goalAcceptanceCriteria: "Reviewer can decide DONE from logs and diff.",
    });
    const copy = textContent(tree);

    expect(copy).toContain("Goal Template");
    expect(copy).toContain("Goal Title");
    expect(copy).toContain("Goal Objective");
    expect(copy).toContain("Goal Acceptance Criteria");
  });

  test("goal runKind does not render old DoneCondition builder, retry policy, approval points, reviewerAgent, or author", () => {
    const tree = render({
      runKind: "goal",
      goalTitle: "Triage Follow-up",
      goalObjective: "Investigate failing tests and propose fixes.",
      goalAcceptanceCriteria: "Reviewer can decide DONE from logs and diff.",
    });
    const copy = textContent(tree);

    expect(copy).not.toContain("Done Conditions");
    expect(copy).not.toContain("File exists");
    expect(copy).not.toContain("Grep contains");
    expect(copy).not.toContain("Command succeeds");
    expect(copy).not.toContain("Tests pass");
    expect(copy).not.toContain("Retry Policy");
    expect(copy).not.toContain("maxRetries");
    expect(copy).not.toContain("Approval Points");
    expect(copy).not.toContain("after_plan");
    expect(copy).not.toContain("before_complete");
    expect(copy).not.toContain("Reviewer agent");
    expect(copy).not.toContain("Goal Author");
  });

  test("buildLoopConfig produces natural-language goalTemplate with title/objective/acceptanceCriteria only", () => {
    const config = buildLoopConfig({
      title: "Goal Loop",
      description: "",
      scheduleKind: "manual",
      everyMs: 60000,
      cronExpression: "*/15 * * * *",
      triggerOnPr: false,
      triggerCadenceMs: 60000,
      runKind: "goal",
      mode: "act",
      approvalPolicy: "explicit_per_run",
      maxIterationsPerRun: 4,
      maxTokensPerRun: 160000,
      maxWallClockMinutesPerRun: 20,
      maxRunsPerDay: 3,
      softThresholdRatio: 0.75,
      hardThresholdRatio: 1,
      toolProfileId: "loop_goal_action",
      taskPrompt: "",
      instructions: "",
      author: "architect",
      goalTitle: "Inline Goal Title",
      goalObjective: "Investigate failing tests and propose fixes.",
      goalAcceptanceCriteria: "Reviewer can decide DONE from logs and diff.",
    });

    expect(config.goalTemplate).toBeDefined();
    const gt = config.goalTemplate!;
    expect(gt.title).toBe("Inline Goal Title");
    expect(gt.objective).toBe("Investigate failing tests and propose fixes.");
    expect(gt.acceptanceCriteria).toBe("Reviewer can decide DONE from logs and diff.");
    expect("doneConditions" in gt).toBe(false);
    expect("retryPolicy" in gt).toBe(false);
    expect("approvalPoints" in gt).toBe(false);
    expect("reviewerAgent" in gt).toBe(false);
    expect("author" in gt).toBe(false);
    expect("prompt" in gt).toBe(false);
    expect("instructions" in gt).toBe(false);
  });

  test("buildLoopConfig session runKind produces no goalTemplate", () => {
    const config = buildLoopConfig({
      title: "Session Loop",
      description: "",
      scheduleKind: "manual",
      everyMs: 60000,
      cronExpression: "*/15 * * * *",
      triggerOnPr: false,
      triggerCadenceMs: 60000,
      runKind: "session",
      mode: "report",
      approvalPolicy: "interactive",
      maxIterationsPerRun: 4,
      maxTokensPerRun: 160000,
      maxWallClockMinutesPerRun: 20,
      maxRunsPerDay: 3,
      softThresholdRatio: 0.75,
      hardThresholdRatio: 1,
      toolProfileId: "loop_local_report",
      taskPrompt: "Run triage.",
      instructions: "",
      author: "architect",
      goalTitle: "",
      goalObjective: "",
      goalAcceptanceCriteria: "",
    });

    expect(config.goalTemplate).toBeUndefined();
  });
});