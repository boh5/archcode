import { describe, expect, mock, test } from "bun:test";
import type { PermissionRequest, PermissionDecision } from "@specra/protocol";

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

const { ConfirmationCard } = await import("./AttentionQueue");

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