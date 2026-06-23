import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { PermissionRequest, PermissionDecision, QuestionRequest } from "@specra/protocol";

// ─── Test helpers ───

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

// ─── Mocks ───

const Fragment = Symbol.for("react.fragment");
const jsxDEV = mock((type: unknown, props: Record<string, unknown> | null, key?: unknown) => {
  const resolvedProps = props ?? {};
  if (typeof type === "function") {
    return type(resolvedProps);
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
  useLayoutEffect: (_callback: () => void | (() => void), _deps?: unknown[]) => {},
  useRef: <T,>(initial: T) => ({ current: initial }),
  useMemo: <T,>(factory: () => T) => factory(),
}));

mock.module("react/jsx-dev-runtime", () => ({
  Fragment,
  jsxDEV,
  jsx: jsxDEV,
  jsxs: jsxDEV,
}));

const respondPermission = mock((_id: string, _decision: PermissionDecision) => {});
mock.module("../../hooks/use-attention-queue", () => ({
  useAttentionQueue: () => ({
    permissions: [],
    questions: [],
    respondPermission,
    respondQuestion: mock((_id: string, _body: unknown) => {}),
  }),
}));

const { ConfirmationCard, QuestionCard } = await import("./AttentionQueue");

// ─── Factory helpers ───

function makePermission(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: "perm-1",
    sessionId: "session-1",
    toolName: "bash",
    toolCallId: "call-1",
    input: { description: "List files", command: "ls -la" },
    description: "Execute a shell command",
    ...overrides,
  };
}

// ─── Tests ───

describe("ConfirmationCard", () => {
  test("renders bash tool with icon and tool name", () => {
    const perm = makePermission({ toolName: "bash", input: { description: "List files", command: "ls -la" } });
    const result = ConfirmationCard({ permission: perm, onRespond: respondPermission });
    const text = textContent(result);
    expect(text).toContain("💻");
    expect(text).toContain("bash");
  });

  test("renders bash with description as primary and command as secondary", () => {
    const perm = makePermission({
      toolName: "bash",
      input: { description: "List project files", command: "ls -la /tmp/specra-test" },
    });
    const result = ConfirmationCard({ permission: perm, onRespond: respondPermission });
    const text = textContent(result);
    expect(text).toContain("List project files");
    expect(text).toContain("ls -la /tmp/specra-test");
  });

  test("renders bash without description — command shown in code block", () => {
    const perm = makePermission({
      toolName: "bash",
      input: { command: "rm -rf /tmp/specra-test" },
    });
    const result = ConfirmationCard({ permission: perm, onRespond: respondPermission });
    const text = textContent(result);
    expect(text).toContain("rm -rf /tmp/specra-test");
  });

  test("destructive bash command gets error border styling", () => {
    const perm = makePermission({
      toolName: "bash",
      input: { description: "Remove temp dir", command: "rm -rf /tmp/specra-test" },
    });
    const result = ConfirmationCard({ permission: perm, onRespond: respondPermission });
    const outerDiv = findAll(result, (el) => {
      const cls = el?.props?.className ?? "";
      return typeof cls === "string" && cls.includes("bg-bg-elevated");
    })[0];
    expect(outerDiv).toBeDefined();
    const cls = outerDiv!.props!.className as string;
    expect(cls).toContain("border-error");
  });

  test("file_write tool gets warning border", () => {
    const perm = makePermission({
      toolName: "file_write",
      input: { filePath: "/src/index.ts", content: "console.log('hello')" },
    });
    const result = ConfirmationCard({ permission: perm, onRespond: respondPermission });
    const outerDiv = findAll(result, (el) => {
      const cls = el?.props?.className ?? "";
      return typeof cls === "string" && cls.includes("bg-bg-elevated");
    })[0];
    expect(outerDiv).toBeDefined();
    const cls = outerDiv!.props!.className as string;
    expect(cls).toContain("border-warning");
  });

  test("file_edit tool gets warning border", () => {
    const perm = makePermission({
      toolName: "file_edit",
      input: { filePath: "/src/index.ts", edits: [] },
    });
    const result = ConfirmationCard({ permission: perm, onRespond: respondPermission });
    const outerDiv = findAll(result, (el) => {
      const cls = el?.props?.className ?? "";
      return typeof cls === "string" && cls.includes("bg-bg-elevated");
    })[0];
    expect(outerDiv).toBeDefined();
    const cls = outerDiv!.props!.className as string;
    expect(cls).toContain("border-warning");
  });

  test("renders file_write with path as primary and content stats as secondary", () => {
    const perm = makePermission({
      toolName: "file_write",
      input: { filePath: "/src/index.ts", content: "x".repeat(500) },
    });
    const result = ConfirmationCard({ permission: perm, onRespond: respondPermission });
    const text = textContent(result);
    expect(text).toContain("/src/index.ts");
    expect(text).toContain("500 chars");
  });

  test("renders grep with pattern as primary and details", () => {
    const perm = makePermission({
      toolName: "grep",
      input: { pattern: "TODO", include: "*.ts", path: "/src" },
    });
    const result = ConfirmationCard({ permission: perm, onRespond: respondPermission });
    const text = textContent(result);
    expect(text).toContain("TODO");
    expect(text).toContain("🔍");
    expect(text).toContain("grep");
  });

  test("renders agent badge with shared constants", () => {
    const perm = makePermission({ agentName: "orchestrator" });
    const result = ConfirmationCard({ permission: perm, onRespond: respondPermission });
    const text = textContent(result);
    expect(text).toContain("orchestrator");
  });

  test("falls back to explorer for unknown agent type", () => {
    const perm = makePermission({ agentName: "unknown_agent" });
    const result = ConfirmationCard({ permission: perm, onRespond: respondPermission });
    const text = textContent(result);
    expect(text).toContain("explorer");
  });

  test("renders permission.description as secondary text", () => {
    const perm = makePermission({ description: "Needs permission to execute" });
    const result = ConfirmationCard({ permission: perm, onRespond: respondPermission });
    const text = textContent(result);
    expect(text).toContain("Needs permission to execute");
  });

  test("handles null input gracefully", () => {
    const perm = makePermission({ input: null });
    const result = ConfirmationCard({ permission: perm, onRespond: respondPermission });
    const text = textContent(result);
    expect(text).toContain("💻");
    expect(text).toContain("bash");
  });

  test("handles undefined input gracefully", () => {
    const perm = makePermission({ input: undefined });
    const result = ConfirmationCard({ permission: perm, onRespond: respondPermission });
    const text = textContent(result);
    expect(text).toContain("💻");
    expect(text).toContain("bash");
  });

  test("renders depth indicator when currentDepth is set", () => {
    const perm = makePermission({ agentName: "explorer", currentDepth: 2 });
    const result = ConfirmationCard({ permission: perm, onRespond: respondPermission });
    const text = textContent(result);
    expect(text).toContain("d2");
  });

  test("renders reason when provided", () => {
    const perm = makePermission({ reason: "destructive command" });
    const result = ConfirmationCard({ permission: perm, onRespond: respondPermission });
    const text = textContent(result);
    expect(text).toContain("destructive command");
  });

  test("destructive bash shows warning icon", () => {
    const perm = makePermission({
      toolName: "bash",
      input: { description: "Remove files", command: "rm -rf /tmp/test" },
    });
    const result = ConfirmationCard({ permission: perm, onRespond: respondPermission });
    const text = textContent(result);
    expect(text).toContain("⚠️");
  });

  test("non-destructive bash shows lock icon", () => {
    const perm = makePermission({
      toolName: "bash",
      input: { description: "List files", command: "ls -la" },
    });
    const result = ConfirmationCard({ permission: perm, onRespond: respondPermission });
    const text = textContent(result);
    expect(text).toContain("🔒");
  });
});

// ─── QuestionCard batched-question tests ───

interface QuestionData {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiple?: boolean;
  custom: boolean;
}

function makeBatchedQuestionRequest(
  overrides: Partial<QuestionRequest> = {},
): QuestionRequest {
  return {
    id: "question-batch-1",
    sessionId: "session-1",
    toolName: "ask_user",
    toolCallId: "call-batch-1",
    questions: [],
    ...overrides,
  };
}

function makeQuestionData(
  overrides: Partial<QuestionData> = {},
): QuestionData {
  return {
    question: "Pick one",
    header: "Q1",
    options: [
      { label: "Option A", description: "" },
      { label: "Option B", description: "" },
    ],
    multiple: false,
    custom: true,
    ...overrides,
  };
}

describe("QuestionCard — batched questions", () => {
  const respondQuestion = mock(
    (_id: string, _body: { answers: string[][] } | { isError: true; reason: string }) => {},
  );

  beforeEach(() => {
    respondQuestion.mockClear();
  });

  test("renders all 3 questions in a batched question.request", () => {
    const request = makeBatchedQuestionRequest({
      questions: [
        makeQuestionData({ header: "Q1", question: "First question?" }),
        makeQuestionData({ header: "Q2", question: "Second question?" }),
        makeQuestionData({ header: "Q3", question: "Third question?" }),
      ],
    });

    const result = QuestionCard({ questionRequest: request, onRespond: respondQuestion });
    const text = textContent(result);

    expect(text).toContain("Q1");
    expect(text).toContain("Q2");
    expect(text).toContain("Q3");
    expect(text).toContain("First question?");
    expect(text).toContain("Confirm");
  });

  test("single question does not render tab bar or Confirm tab", () => {
    const request = makeBatchedQuestionRequest({
      questions: [makeQuestionData({ header: "Solo", question: "Only one?" })],
    });

    const result = QuestionCard({ questionRequest: request, onRespond: respondQuestion });
    const text = textContent(result);

    expect(text).not.toContain("Confirm");
    expect(text).toContain("Submit Answer");
  });

  test("handleSubmitAll sends ONE response payload with all answers", () => {
    const request = makeBatchedQuestionRequest({
      questions: [
        makeQuestionData({
          header: "Q1",
          question: "First?",
          options: [{ label: "Alpha", description: "" }],
          custom: false,
        }),
        makeQuestionData({
          header: "Q2",
          question: "Second?",
          options: [{ label: "Beta", description: "" }],
          custom: false,
        }),
        makeQuestionData({
          header: "Q3",
          question: "Third?",
          options: [{ label: "Gamma", description: "" }],
          custom: false,
        }),
      ],
    });

    // Pre-seed useState so answers=[[Alpha],[Beta],[Gamma]] and activeTab=3 (the
    // Confirm tab). The no-op setState mock means we cannot mutate, so we inject
    // the fully-answered state and the Confirm-tab view at init.
    const preAnswered: string[][] = [["Alpha"], ["Beta"], ["Gamma"]];
    const originalUseStateImpl = useState.getMockImplementation();
    let callIndex = 0;
    useState.mockImplementation(<T,>(initialOrInitializer: T | (() => T)): [T, (value: T | ((previous: T) => T)) => void] => {
      const idx = callIndex++;
      if (idx === 0) return [3 as T, setState as (value: T | ((previous: T) => T)) => void];
      if (idx === 1) return [preAnswered as unknown as T, setState as (value: T | ((previous: T) => T)) => void];
      const initial = typeof initialOrInitializer === "function"
        ? (initialOrInitializer as () => T)()
        : initialOrInitializer;
      return [initial, setState as (value: T | ((previous: T) => T)) => void];
    });

    try {
      const result = QuestionCard({ questionRequest: request, onRespond: respondQuestion });

      const submitAllBtn = findAll(result, (el) => {
        const cls = el?.props?.className;
        return typeof cls === "string" && cls.includes("bg-accent") &&
          typeof el?.props?.children === "string" &&
          (el.props.children as string).includes("Submit All Answers");
      })[0];

      expect(submitAllBtn).toBeDefined();
      const onClick = submitAllBtn?.props?.onClick as (() => void) | undefined;
      expect(typeof onClick).toBe("function");
      onClick!();

      expect(respondQuestion).toHaveBeenCalledTimes(1);
      expect(respondQuestion.mock.calls[0]?.[0]).toBe("question-batch-1");
      expect(respondQuestion.mock.calls[0]?.[1]).toEqual({
        answers: [["Alpha"], ["Beta"], ["Gamma"]],
      });
    } finally {
      useState.mockImplementation(originalUseStateImpl!);
      callIndex = 0;
    }
  });

  test("Cancel sends an error response without answers", () => {
    const request = makeBatchedQuestionRequest({
      questions: [
        makeQuestionData({ header: "Q1", options: [{ label: "A", description: "" }], custom: false }),
        makeQuestionData({ header: "Q2", options: [{ label: "B", description: "" }], custom: false }),
      ],
    });

    // Render on the Confirm tab (activeTab=2) where the Cancel button lives.
    const originalUseStateImpl = useState.getMockImplementation();
    let callIndex = 0;
    useState.mockImplementation(<T,>(initialOrInitializer: T | (() => T)): [T, (value: T | ((previous: T) => T)) => void] => {
      const idx = callIndex++;
      if (idx === 0) return [2 as T, setState as (value: T | ((previous: T) => T)) => void];
      const initial = typeof initialOrInitializer === "function"
        ? (initialOrInitializer as () => T)()
        : initialOrInitializer;
      return [initial, setState as (value: T | ((previous: T) => T)) => void];
    });

    try {
      const result = QuestionCard({ questionRequest: request, onRespond: respondQuestion });

      const cancelBtns = findAll(result, (el) => {
        const cls = el?.props?.className;
        const children = el?.props?.children;
        return typeof cls === "string" && cls.includes("text-error") &&
          typeof children === "string" && children === "Cancel";
      });

      expect(cancelBtns.length).toBeGreaterThan(0);
      const onClick = cancelBtns[0]?.props?.onClick as (() => void) | undefined;
      expect(typeof onClick).toBe("function");
      onClick!();

      expect(respondQuestion).toHaveBeenCalledTimes(1);
      expect(respondQuestion.mock.calls[0]?.[1]).toEqual({
        isError: true,
        reason: "Cancelled by user",
      });
    } finally {
      useState.mockImplementation(originalUseStateImpl!);
      callIndex = 0;
    }
  });

  test("Submit All Answers is disabled until all questions are answered", () => {
    const request = makeBatchedQuestionRequest({
      questions: [
        makeQuestionData({ header: "Q1", options: [{ label: "A", description: "" }], custom: false }),
        makeQuestionData({ header: "Q2", options: [{ label: "B", description: "" }], custom: false }),
      ],
    });

    // Default useState initializer: answers=[[],[]] → allAnswered=false. With
    // activeTab=0 the Confirm tab (which holds Submit All Answers) is not rendered,
    // and QuestionPane suppresses its submit button because isLastQuestion=false.
    const result = QuestionCard({ questionRequest: request, onRespond: respondQuestion });

    const submitBtns = findAll(result, (el) => {
      const children = el?.props?.children;
      return typeof children === "string" &&
        (children === "Submit All Answers" || children === "Submit Answer");
    });

    expect(submitBtns.length).toBe(0);
  });
});