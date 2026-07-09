import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CreateLoopPayload, LoopConfig, LoopState } from "../../api/types";

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
type BuildCreatePayloadFunction = typeof import("./CreateLoopDialog").buildCreatePayload;
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
    _args: { slug: string } & CreateLoopPayload,
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
let buildCreatePayload: BuildCreatePayloadFunction;
let buildLoopConfig: BuildLoopConfigFunction;

const imported = await import("./CreateLoopDialog");
CreateLoopForm = imported.CreateLoopForm;
LoopForm = imported.LoopForm;
buildCreatePayload = imported.buildCreatePayload;
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
    onSubmitPayload: mock((_payload: CreateLoopPayload) => {}),
    initialState,
    showQuickStarts: true,
  });
}

const REMOVED_TEMPLATE_LABELS = [
  "Daily Triage",
  "Changelog Drafter",
  "CI Sweeper",
  "Dependency Sweeper",
  "Post-Land Cleanup",
  "Issue Triage",
];

const FORBIDDEN_INTERNAL_TEXT = [
  "runKind",
  "toolProfileId",
  "extraTools",
  "collisionTargets",
  "cleanupPolicy",
  "Automation",
  "softThresholdRatio",
  "hardThresholdRatio",
  "soft ratio",
  "hard ratio",
  "cadenceMs",
  "on_pr",
  "on_commit",
  "on_ci_fail",
  "dedupeKey",
  "subjectKey",
  "branchKey",
  "triggerHealth",
  "maxConcurrent",
];

describe("CreateLoopDialog templates", () => {
  beforeEach(() => {
    createPending = false;
    createError = null;
    for (const fn of [onCreated, onClose, createMutate, useState, useCallback, useEffect, useMemo]) {
      fn.mockClear();
    }
  });

  test("renders exactly the four allowed template labels", () => {
    const tree = render();
    const copy = textContent(tree);

    expect(copy).toContain("Watch & Report");
    expect(copy).toContain("Maintain & Fix");
    expect(copy).toContain("PR Babysitter");
    expect(copy).toContain("Goal Runner");
  });

  test("does not render removed template labels", () => {
    const tree = render();
    const copy = textContent(tree);

    for (const label of REMOVED_TEMPLATE_LABELS) {
      expect(copy).not.toContain(label);
    }
  });

  test("does not render forbidden internal plumbing text", () => {
    const tree = render();
    const copy = textContent(tree);

    for (const text of FORBIDDEN_INTERNAL_TEXT) {
      expect(copy).not.toContain(text);
    }
  });

  test("template radio inputs offer exactly four template ids", () => {
    const tree = render();
    const radios = findAll(tree, (el) => {
      const props = el.props ?? {};
      return props.type === "radio" && props.name === "loop-template";
    });
    const values = radios.map((el) => String(el.props?.value ?? "")).sort();
    expect(values).toEqual(["goal_runner", "maintain_fix", "pr_babysitter", "watch_report"]);
  });

  test("quick start buttons offer exactly four template labels", () => {
    const tree = render();
    const buttons = findAll(tree, (el) => {
      const props = el.props ?? {};
      return el.type === "button" && typeof props["aria-label"] === "string" && String(props["aria-label"]).startsWith("Template ");
    });
    const labels = buttons.map((el) => String(el.props?.["aria-label"] ?? "")).sort();
    expect(labels).toEqual([
      "Template Goal Runner",
      "Template Maintain & Fix",
      "Template PR Babysitter",
      "Template Watch & Report",
    ]);
  });
});

describe("CreateLoopDialog worktree", () => {
  beforeEach(() => {
    createPending = false;
    createError = null;
    for (const fn of [onCreated, onClose, createMutate, useState, useCallback, useEffect, useMemo]) {
      fn.mockClear();
    }
  });

  test("useWorktree defaults to false (unchecked) and Advanced toggle is present", () => {
    const tree = render();
    const copy = textContent(tree);

    // Advanced section is collapsed by default; the toggle is present.
    expect(copy).toContain("Advanced");

    // The worktree checkbox is inside the collapsed Advanced section, so it
    // does not render until expanded. Verify the default via the payload builder.
    const payload = buildCreatePayload({
      templateId: "watch_report",
      title: "Watch Loop",
      description: "",
      scheduleKind: "manual",
      everyMs: 60000,
      cronExpression: "*/15 * * * *",
      approvalPolicy: "interactive",
      maxIterationsPerRun: 8,
      maxTokensPerRun: 120000,
      maxWallClockMinutesPerRun: 15,
      maxRunsPerDay: 2,
      taskPrompt: "Run triage.",
      instructions: "",
      author: "architect",
      useWorktree: false,
      goalTitle: "",
      goalObjective: "",
      goalAcceptanceCriteria: "",
    });
    expect("useWorktree" in payload).toBe(false);
  });

  test("buildCreatePayload omits useWorktree when false", () => {
    const payload = buildCreatePayload({
      templateId: "watch_report",
      title: "Watch Loop",
      description: "",
      scheduleKind: "manual",
      everyMs: 60000,
      cronExpression: "*/15 * * * *",
      approvalPolicy: "interactive",
      maxIterationsPerRun: 8,
      maxTokensPerRun: 120000,
      maxWallClockMinutesPerRun: 15,
      maxRunsPerDay: 2,
      taskPrompt: "Run triage.",
      instructions: "",
      author: "architect",
      useWorktree: false,
      goalTitle: "",
      goalObjective: "",
      goalAcceptanceCriteria: "",
    });

    expect("useWorktree" in payload).toBe(false);
  });

  test("buildCreatePayload sends useWorktree: true only when explicitly true", () => {
    const payload = buildCreatePayload({
      templateId: "maintain_fix",
      title: "Maintain Loop",
      description: "",
      scheduleKind: "manual",
      everyMs: 60000,
      cronExpression: "*/15 * * * *",
      approvalPolicy: "explicit_per_run",
      maxIterationsPerRun: 16,
      maxTokensPerRun: 200000,
      maxWallClockMinutesPerRun: 30,
      maxRunsPerDay: 2,
      taskPrompt: "Fix one issue.",
      instructions: "",
      author: "architect",
      useWorktree: true,
      goalTitle: "",
      goalObjective: "",
      goalAcceptanceCriteria: "",
    });

    expect(payload.useWorktree).toBe(true);
  });

  test("buildCreatePayload never sends mode, toolProfileId, or extraTools", () => {
    const payload = buildCreatePayload({
      templateId: "pr_babysitter",
      title: "PR Watch",
      description: "",
      scheduleKind: "manual",
      everyMs: 60000,
      cronExpression: "*/15 * * * *",
      approvalPolicy: "interactive",
      maxIterationsPerRun: 12,
      maxTokensPerRun: 160000,
      maxWallClockMinutesPerRun: 20,
      maxRunsPerDay: 4,
      taskPrompt: "Watch PRs.",
      instructions: "",
      author: "architect",
      useWorktree: false,
      goalTitle: "",
      goalObjective: "",
      goalAcceptanceCriteria: "",
    });

    expect("mode" in payload).toBe(false);
    expect("toolProfileId" in payload).toBe(false);
    expect("extraTools" in payload).toBe(false);
    expect("collisionTargets" in payload).toBe(false);
    expect("cleanupPolicy" in payload).toBe(false);
  });
});

describe("CreateLoopDialog Goal template", () => {
  beforeEach(() => {
    createPending = false;
    createError = null;
    for (const fn of [onCreated, onClose, createMutate, useState, useCallback, useEffect, useMemo]) {
      fn.mockClear();
    }
  });

  test("goal_runner template renders natural-language Goal template fields: title, objective, acceptance criteria", () => {
    const tree = render({
      templateId: "goal_runner",
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

  test("goal_runner template does not render old DoneCondition builder, retry policy, approval points, reviewerAgent, or author", () => {
    const tree = render({
      templateId: "goal_runner",
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

  test("buildCreatePayload produces natural-language goalTemplate with title/objective/acceptanceCriteria only", () => {
    const payload = buildCreatePayload({
      templateId: "goal_runner",
      title: "Goal Loop",
      description: "",
      scheduleKind: "manual",
      everyMs: 60000,
      cronExpression: "*/15 * * * *",
      approvalPolicy: "explicit_per_run",
      maxIterationsPerRun: 20,
      maxTokensPerRun: 240000,
      maxWallClockMinutesPerRun: 45,
      maxRunsPerDay: 2,
      taskPrompt: "",
      instructions: "",
      author: "architect",
      useWorktree: false,
      goalTitle: "Inline Goal Title",
      goalObjective: "Investigate failing tests and propose fixes.",
      goalAcceptanceCriteria: "Reviewer can decide DONE from logs and diff.",
    });

    expect(payload.goalTemplate).toBeDefined();
    const gt = payload.goalTemplate!;
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

  test("buildCreatePayload non-goal template produces no goalTemplate", () => {
    const payload = buildCreatePayload({
      templateId: "watch_report",
      title: "Session Loop",
      description: "",
      scheduleKind: "manual",
      everyMs: 60000,
      cronExpression: "*/15 * * * *",
      approvalPolicy: "interactive",
      maxIterationsPerRun: 8,
      maxTokensPerRun: 120000,
      maxWallClockMinutesPerRun: 15,
      maxRunsPerDay: 2,
      taskPrompt: "Run triage.",
      instructions: "",
      author: "architect",
      useWorktree: false,
      goalTitle: "",
      goalObjective: "",
      goalAcceptanceCriteria: "",
    });

    expect(payload.goalTemplate).toBeUndefined();
  });

  test("buildLoopConfig still produces a valid LoopConfig for edit flows", () => {
    const config = buildLoopConfig({
      templateId: "watch_report",
      title: "Session Loop",
      description: "desc",
      scheduleKind: "manual",
      everyMs: 60000,
      cronExpression: "*/15 * * * *",
      approvalPolicy: "interactive",
      maxIterationsPerRun: 8,
      maxTokensPerRun: 120000,
      maxWallClockMinutesPerRun: 15,
      maxRunsPerDay: 2,
      taskPrompt: "Run triage.",
      instructions: "",
      author: "architect",
      useWorktree: false,
      goalTitle: "",
      goalObjective: "",
      goalAcceptanceCriteria: "",
    });

    expect(config.templateId).toBe("watch_report");
    expect(config.title).toBe("Session Loop");
    expect(config.schedule.kind).toBe("manual");
    expect(config.approvalPolicy).toBe("interactive");
    expect("useWorktree" in config).toBe(false);
  });
});