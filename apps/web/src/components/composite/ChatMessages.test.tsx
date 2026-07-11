import { describe, expect, mock, test } from "bun:test";
import type { CompressionBlockPart, CompressionBlockSnapshot, CompactionPart, ToolChildSessionLink, ToolChildSessionLinkStatus, RecoveryNoticePart, TextPart, ReasoningPart } from "@archcode/protocol";
import { parseToolInput, parseToolOutput, mapLinkStatusToBadge, PartRenderer } from "./ChatMessages";
import { CompressionBlock } from "./CompressionBlock";
import type { CompressionOriginalRangeSuccess } from "../../api/compression";

const Fragment = Symbol.for("react.fragment");

const stateSlots: unknown[] = [];
let stateSlotIndex = 0;

function resetStateSlots(): void {
  stateSlots.length = 0;
  stateSlotIndex = 0;
}

const jsxDEV = mock((type: unknown, props: Record<string, unknown> | null, key?: unknown) => {
  const resolvedProps = props ?? {};
  if (typeof type === "function") {
    stateSlotIndex = 0;
    return type(resolvedProps);
  }
  return { type, props: resolvedProps, key };
});

mock.module("react", () => ({
  default: {},
  useState: <T,>(initialOrInitializer: T | (() => T)): [T, (value: T | ((previous: T) => T)) => void] => {
    const slot = stateSlotIndex++;
    const initial = typeof initialOrInitializer === "function"
      ? (initialOrInitializer as () => T)()
      : initialOrInitializer;
    if (slot >= stateSlots.length) stateSlots.push(initial);
    const currentValue = stateSlots[slot] as T;
    const setter = (value: T | ((previous: T) => T)): void => {
      stateSlots[slot] = typeof value === "function"
        ? (value as (previous: T) => T)(stateSlots[slot] as T)
        : value;
    };
    return [currentValue, setter];
  },
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

mock.module("../primitives/MarkdownContent", () => ({
  MarkdownContent: ({ children }: { children: string }) => children,
}));

const mockSetFocusSessionId = mock((_id: string | null) => {});
mock.module("../../store/session-store", () => ({
  getWebSessionStore: mock((_sessionId: string, _slug?: string) => ({
    getState: () => ({ setFocusSessionId: mockSetFocusSessionId }),
  })),
}));

const fetchCompressionOriginalRangeMock = mock(async (): Promise<CompressionOriginalRangeSuccess> => {
  throw new Error("fetchCompressionOriginalRangeMock not configured");
});
mock.module("../../api/compression", () => ({
  fetchCompressionOriginalRange: fetchCompressionOriginalRangeMock,
}));

function textContent(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (typeof value === "object" && value !== null && "props" in (value as object)) {
    const el = value as { props?: Record<string, unknown> };
    return textContent(el?.props?.children);
  }
  return "";
}

// ─── parseToolInput ───

describe("parseToolInput", () => {
  test("parses object input directly", () => {
    const result = parseToolInput({ agent_type: "explore", prompt: "test" });
    expect(result).toEqual({ agent_type: "explore", prompt: "test" });
  });

  test("parses string JSON input", () => {
    const result = parseToolInput(JSON.stringify({ agent_type: "explore", description: "Search" }));
    expect(result).toEqual({ agent_type: "explore", description: "Search" });
  });

  test("returns null for null input", () => {
    expect(parseToolInput(null)).toBeNull();
  });

  test("returns null for undefined input", () => {
    expect(parseToolInput(undefined)).toBeNull();
  });

  test("returns null for invalid JSON string", () => {
    expect(parseToolInput("not json")).toBeNull();
  });

  test("returns null for number input", () => {
    expect(parseToolInput(42)).toBeNull();
  });
});

// ─── parseToolOutput ───

describe("parseToolOutput", () => {
  test("parses valid JSON output", () => {
    const result = parseToolOutput(JSON.stringify({ sessionId: "abc-123", text: "Done" }));
    expect(result).toEqual({ sessionId: "abc-123", text: "Done" });
  });

  test("returns null for undefined output", () => {
    expect(parseToolOutput(undefined)).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    expect(parseToolOutput("not json")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseToolOutput("")).toBeNull();
  });
});

// ─── mapLinkStatusToBadge ───

describe("mapLinkStatusToBadge", () => {
  test("completed maps to completed", () => {
    expect(mapLinkStatusToBadge("completed")).toBe("completed");
  });

  test("running maps to running", () => {
    expect(mapLinkStatusToBadge("running")).toBe("running");
  });

  test("linked maps to running", () => {
    expect(mapLinkStatusToBadge("linked")).toBe("running");
  });

  test("cancelling maps to running", () => {
    expect(mapLinkStatusToBadge("cancelling")).toBe("running");
  });

  test("failed maps to error", () => {
    expect(mapLinkStatusToBadge("failed")).toBe("error");
  });

  test("timed_out maps to error", () => {
    expect(mapLinkStatusToBadge("timed_out")).toBe("error");
  });

  test("cancelled maps to error", () => {
    expect(mapLinkStatusToBadge("cancelled")).toBe("error");
  });

  test("interrupted maps to error", () => {
    expect(mapLinkStatusToBadge("interrupted")).toBe("error");
  });

  test("all ToolChildSessionLinkStatus values are covered", () => {
    const statuses: ToolChildSessionLinkStatus[] = [
      "linked", "running", "waiting_for_human", "cancelling", "completed", "failed", "timed_out", "cancelled", "interrupted",
    ];
    for (const status of statuses) {
      const result = mapLinkStatusToBadge(status);
      expect(typeof result).toBe("string");
      expect(["running", "completed", "pending", "error"]).toContain(result);
    }
  });

  test("waiting_for_human maps to pending", () => {
    expect(mapLinkStatusToBadge("waiting_for_human")).toBe("pending");
  });
});

describe("PartRenderer", () => {
  const defaultProps = { projectSlug: "demo", focusStoreSessionId: "session-1", childSessionLinks: [] as never[] };

  test("renders interrupted text with badge", () => {
    const part: TextPart = {
      type: "text",
      id: "text-1",
      text: "Partial response content",
      createdAt: Date.now(),
      completedAt: Date.now(),
      meta: { interrupted: true, discardedFromContext: true },
    };
    const el = PartRenderer({ part, ...defaultProps });
    const text = textContent(el);
    expect(text).toContain("Response was interrupted");
    expect(text).toContain("Partial response content");
  });

  test("renders normal text without badge", () => {
    const part: TextPart = {
      type: "text",
      id: "text-2",
      text: "Normal response",
      createdAt: Date.now(),
      completedAt: Date.now(),
    };
    const el = PartRenderer({ part, ...defaultProps });
    const text = textContent(el);
    expect(text).not.toContain("Response was interrupted");
    expect(text).toContain("Normal response");
  });

  test("renders interrupted reasoning with badge", () => {
    const part: ReasoningPart = {
      type: "reasoning",
      id: "reasoning-1",
      text: "Partial reasoning",
      createdAt: Date.now(),
      completedAt: Date.now(),
      meta: { interrupted: true },
    };
    const el = PartRenderer({ part, ...defaultProps });
    const text = textContent(el);
    expect(text).toContain("Response was interrupted");
    expect(text).toContain("Reasoning");
  });

  test("renders recovery-notice part", () => {
    const part: RecoveryNoticePart = {
      type: "recovery-notice",
      id: "recovery-1",
      status: "retrying",
      message: "Retrying after rate limit",
      attempt: 2,
      createdAt: Date.now(),
    };
    const el = PartRenderer({ part, ...defaultProps });
    const text = textContent(el);
    expect(text).toContain("Retrying");
    expect(text).toContain("Retrying after rate limit");
  });

  test("renders recovery-notice failed status", () => {
    const part: RecoveryNoticePart = {
      type: "recovery-notice",
      id: "recovery-2",
      status: "failed",
      message: "All retries exhausted",
      attempt: 3,
      errorKind: "context_overflow",
      createdAt: Date.now(),
      completedAt: Date.now(),
    };
    const el = PartRenderer({ part, ...defaultProps });
    const text = textContent(el);
    expect(text).toContain("Recovery failed");
    expect(text).toContain("context_overflow");
  });
});

// ─── CompressionBlock + hard CompactionPart ───

function makeCompressionBlockPart(overrides: Partial<CompressionBlockPart> = {}): CompressionBlockPart {
  return {
    type: "compression-block",
    id: "compression:b1:part-1",
    blockRef: "b1",
    status: "active",
    strategy: "dynamic-range",
    trigger: "model_tool_call",
    summary: "## Current Objective\nKeep going\n## User Constraints\nBe fast",
    startRef: "m0001",
    endRef: "m0004",
    childBlockRefs: [],
    committedAt: 123456789,
    ...overrides,
  };
}

function findAll(value: unknown, predicate: (el: { type?: unknown; props?: Record<string, unknown> | null }) => boolean): Array<{ type?: unknown; props?: Record<string, unknown> | null }> {
  const matches: Array<{ type?: unknown; props?: Record<string, unknown> | null }> = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { for (const child of node) visit(child); return; }
    if (typeof node === "object" && node !== null && "props" in node) {
      const el = node as { type?: unknown; props?: Record<string, unknown> | null };
      if (predicate(el)) matches.push(el);
      const children = el.props?.children;
      if (children !== undefined && children !== null) {
        visit(Array.isArray(children) ? children : [children]);
      }
    }
  };
  visit(value);
  return matches;
}

describe("CompressionBlock", () => {
  test("renders block ref, strategy, trigger, summary, range, and child refs", () => {
    resetStateSlots();
    const part = makeCompressionBlockPart({
      childBlockRefs: ["b2"],
      strategy: "dynamic-range",
      trigger: "model_tool_call",
    });
    const el = CompressionBlock({ part, projectSlug: "demo", sessionId: "sess-1", focusStoreSessionId: "session-1" });
    const text = textContent(el);

    expect(text).toContain("b1");
    expect(text).toContain("Dynamic Range");
    expect(text).toContain("model");
    expect(text).toContain("Keep going");
    expect(text).toContain("User Constraints");
    expect(text).toContain("m0001");
    expect(text).toContain("m0004");
    expect(text).toContain("children");
    expect(text).toContain("b2");
  });

  test("renders dynamic-range strategy with correct label", () => {
    resetStateSlots();
    const part = makeCompressionBlockPart({ strategy: "dynamic-range", trigger: "model_tool_call" });
    const el = CompressionBlock({ part, projectSlug: "demo", sessionId: "sess-1", focusStoreSessionId: "session-1" });
    const text = textContent(el);

    expect(text).toContain("Dynamic Range");
    expect(text).toContain("model");
  });

  test("renders token savings and protected refs count from snapshot", () => {
    resetStateSlots();
    const part = makeCompressionBlockPart();
    const snapshot: CompressionBlockSnapshot = {
      id: "block-1",
      ref: "b1",
      status: "active",
      strategy: "dynamic-range",
      trigger: "model_tool_call",
      range: {
        startMessageId: "msg-1",
        endMessageId: "msg-4",
        startRef: "m0001",
        endRef: "m0004",
        startIndex: 0,
        endIndex: 3,
      },
      summary: "## Current Objective\nKeep going",
      childBlockRefs: [],
      protectedRefs: ["m0003", "b0"],
      tokenEstimate: { originalTokens: 10000, summaryTokens: 2000, savedTokens: 8000, estimatedAt: 123456789 },
      createdAt: 123456789,
      updatedAt: 123456789,
    };
    const el = CompressionBlock({ part, projectSlug: "demo", sessionId: "sess-1", focusStoreSessionId: "session-1", snapshot });
    const text = textContent(el);

    expect(text).toContain("saved");
    expect(text).toContain("8000 tokens");
    expect(text).toContain("protected");
    expect(text).toContain("2 refs");
  });

  test("renders saved tokens as 0 when snapshot has tokenEstimate with savedTokens=0", () => {
    resetStateSlots();
    const part = makeCompressionBlockPart();
    const snapshot: CompressionBlockSnapshot = {
      id: "block-1",
      ref: "b1",
      status: "active",
      strategy: "dynamic-range",
      trigger: "model_tool_call",
      range: {
        startMessageId: "msg-1",
        endMessageId: "msg-4",
        startRef: "m0001",
        endRef: "m0004",
        startIndex: 0,
        endIndex: 3,
      },
      summary: "## Current Objective\nKeep going",
      childBlockRefs: [],
      protectedRefs: ["m0003"],
      tokenEstimate: { originalTokens: 5000, summaryTokens: 5000, savedTokens: 0, estimatedAt: 123456789 },
      createdAt: 123456789,
      updatedAt: 123456789,
    };
    const el = CompressionBlock({ part, projectSlug: "demo", sessionId: "sess-1", focusStoreSessionId: "session-1", snapshot });
    const text = textContent(el);

    expect(text).toContain("saved");
    expect(text).toContain("0 tokens");
  });

  test("renders protected count as 0 when snapshot has empty protectedRefs", () => {
    resetStateSlots();
    const part = makeCompressionBlockPart();
    const snapshot: CompressionBlockSnapshot = {
      id: "block-1",
      ref: "b1",
      status: "active",
      strategy: "dynamic-range",
      trigger: "model_tool_call",
      range: {
        startMessageId: "msg-1",
        endMessageId: "msg-4",
        startRef: "m0001",
        endRef: "m0004",
        startIndex: 0,
        endIndex: 3,
      },
      summary: "## Current Objective\nKeep going",
      childBlockRefs: [],
      protectedRefs: [],
      createdAt: 123456789,
      updatedAt: 123456789,
    };
    const el = CompressionBlock({ part, projectSlug: "demo", sessionId: "sess-1", focusStoreSessionId: "session-1", snapshot });
    const text = textContent(el);

    expect(text).toContain("protected");
    expect(text).toContain("0 refs");
  });

  test("does not render token savings or protected refs when snapshot is absent", () => {
    resetStateSlots();
    const part = makeCompressionBlockPart();
    const el = CompressionBlock({ part, projectSlug: "demo", sessionId: "sess-1", focusStoreSessionId: "session-1" });
    const text = textContent(el);

    expect(text).not.toContain("saved");
    expect(text).not.toContain("protected");
  });

  test("shows explicit Show original range CTA before expansion", () => {
    resetStateSlots();
    const part = makeCompressionBlockPart();
    const el = CompressionBlock({ part, projectSlug: "demo", sessionId: "sess-1", focusStoreSessionId: "session-1" });
    const text = textContent(el);

    expect(text).toContain("Show original range");
  });

  test("header is non-clickable and does not trigger fetch", () => {
    resetStateSlots();
    fetchCompressionOriginalRangeMock.mockClear();

    const part = makeCompressionBlockPart();
    const el = CompressionBlock({ part, projectSlug: "demo", sessionId: "sess-1", focusStoreSessionId: "session-1" });

    const headerRows = findAll(el, (e) => {
      const cls = e.props?.className;
      return typeof cls === "string" && cls.includes("bg-bg-elevated") && cls.includes("border-b");
    });
    expect(headerRows.length).toBeGreaterThan(0);
    expect(headerRows[0]!.props?.onClick).toBeUndefined();
    expect(headerRows[0]!.type).not.toBe("button");

    expect(fetchCompressionOriginalRangeMock).toHaveBeenCalledTimes(0);
  });

  test("does not fetch original range on initial render (lazy)", () => {
    resetStateSlots();
    fetchCompressionOriginalRangeMock.mockClear();

    const part = makeCompressionBlockPart();
    CompressionBlock({ part, projectSlug: "demo", sessionId: "sess-1", focusStoreSessionId: "session-1" });

    expect(fetchCompressionOriginalRangeMock).toHaveBeenCalledTimes(0);
  });

  test("fetches original range only after clicking Show original range (expand)", async () => {
    resetStateSlots();
    fetchCompressionOriginalRangeMock.mockClear();

    const successBody: CompressionOriginalRangeSuccess = {
      ok: true,
      blockRef: "b1",
      blockId: "block-1",
      status: "active",
      strategy: "dynamic-range",
      trigger: "model_tool_call",
      childBlockRefs: [],
      range: {
        startMessageId: "msg-1",
        endMessageId: "msg-2",
        startRef: "m0001",
        endRef: "m0002",
        startIndex: 0,
        endIndex: 1,
      },
      coveredRefs: ["m0001", "m0002"],
      coveredMessageIds: ["msg-1", "msg-2"],
      messages: [
        {
          ref: "m0001",
          message: {
            id: "msg-1",
            role: "user",
            parts: [{ type: "text", id: "t1", text: "original hello", createdAt: 1, completedAt: 2 }],
            createdAt: 1,
            completedAt: 2,
          },
        },
        {
          ref: "m0002",
          message: {
            id: "msg-2",
            role: "assistant",
            parts: [
              {
                type: "tool",
                id: "tool-1",
                state: "error",
                toolCallId: "tc-1",
                toolName: "bash",
                input: { command: "ls" },
                errorMessage: "partial output",
                createdAt: 3,
                startedAt: 3,
                endedAt: 4,
                meta: { unknownResult: true },
              },
            ],
            createdAt: 3,
            completedAt: 4,
          },
        },
      ],
    };
    fetchCompressionOriginalRangeMock.mockImplementation(async () => successBody);

    const part = makeCompressionBlockPart();
    const el1 = CompressionBlock({ part, projectSlug: "demo", sessionId: "sess-1", focusStoreSessionId: "session-1" });
    expect(fetchCompressionOriginalRangeMock).toHaveBeenCalledTimes(0);

    const ctaButtons = findAll(el1, (e) => {
      const text = textContent(e);
      return text.includes("Show original range") && e.props?.onClick !== undefined;
    });
    expect(ctaButtons.length).toBeGreaterThan(0);

    await (ctaButtons[0]!.props!.onClick as () => Promise<void>)();

    expect(fetchCompressionOriginalRangeMock).toHaveBeenCalledTimes(1);

    const el2 = CompressionBlock({ part, projectSlug: "demo", sessionId: "sess-1", focusStoreSessionId: "session-1" });
    const expandedText = textContent(el2);

    expect(expandedText).toContain("original hello");
    expect(expandedText).toContain("bash");
    expect(expandedText).toContain("Tool result unknown");
    expect(expandedText).toContain("Hide original range");
  });

  test("renders error state with retry button on fetch failure", async () => {
    resetStateSlots();
    fetchCompressionOriginalRangeMock.mockClear();

    fetchCompressionOriginalRangeMock.mockImplementation(async () => {
      throw new Error("Network down");
    });

    const part = makeCompressionBlockPart();
    const el1 = CompressionBlock({ part, projectSlug: "demo", sessionId: "sess-1", focusStoreSessionId: "session-1" });

    const ctaButtons = findAll(el1, (e) => {
      const text = textContent(e);
      return text.includes("Show original range") && e.props?.onClick !== undefined;
    });
    await (ctaButtons[0]!.props!.onClick as () => Promise<void>)();

    const el2 = CompressionBlock({ part, projectSlug: "demo", sessionId: "sess-1", focusStoreSessionId: "session-1" });
    const text = textContent(el2);

    expect(text).toContain("Network down");
    expect(text).toContain("Retry");
  });

  test("renders persisted output preview and ref without inlining full output", async () => {
    resetStateSlots();
    fetchCompressionOriginalRangeMock.mockClear();

    const successBody: CompressionOriginalRangeSuccess = {
      ok: true,
      blockRef: "b1",
      blockId: "block-1",
      status: "active",
      strategy: "dynamic-range",
      trigger: "model_tool_call",
      childBlockRefs: [],
      range: {
        startMessageId: "msg-1",
        endMessageId: "msg-1",
        startRef: "m0001",
        endRef: "m0001",
        startIndex: 0,
        endIndex: 0,
      },
      coveredRefs: ["m0001"],
      coveredMessageIds: ["msg-1"],
      messages: [
        {
          ref: "m0001",
          message: {
            id: "msg-1",
            role: "assistant",
            parts: [
              {
                type: "tool",
                id: "tool-big",
                state: "completed",
                toolCallId: "tc-big",
                toolName: "file_read",
                input: { path: "/big.txt" },
                output: "short preview only",
                createdAt: 1,
                startedAt: 1,
                endedAt: 2,
                persistedOutput: {
                  kind: "tool-output",
                  ref: "sess-1:file_read:tc-big",
                  truncated: true,
                  preview: "first 2000 chars preview…",
                },
              },
            ],
            createdAt: 1,
            completedAt: 2,
          },
        },
      ],
    };
    fetchCompressionOriginalRangeMock.mockImplementation(async () => successBody);

    const part = makeCompressionBlockPart();
    const el1 = CompressionBlock({ part, projectSlug: "demo", sessionId: "sess-1", focusStoreSessionId: "session-1" });

    const ctaButtons = findAll(el1, (e) => {
      const text = textContent(e);
      return text.includes("Show original range") && e.props?.onClick !== undefined;
    });
    await (ctaButtons[0]!.props!.onClick as () => Promise<void>)();

    const el2 = CompressionBlock({ part, projectSlug: "demo", sessionId: "sess-1", focusStoreSessionId: "session-1" });
    const text = textContent(el2);

    expect(text).toContain("sess-1:file_read:tc-big");
    expect(text).toContain("first 2000 chars preview");
    expect(text).not.toContain("short preview only");
  });

  test("renders DelegationCard for delegate tool parts in expanded originals", async () => {
    resetStateSlots();
    fetchCompressionOriginalRangeMock.mockClear();

    const childLink: ToolChildSessionLink = {
      parentSessionId: "sess-1",
      parentToolCallId: "tc-delegate-1",
      toolName: "delegate",
      childSessionId: "child-sess-1",
      childAgentName: "explore",
      depth: 1,
      background: false,
      status: "completed",
      createdAt: 100,
      endedAt: 200,
      durationMs: 100,
      summary: "Explored the codebase for patterns",
      title: "Explore codebase",
    };

    const successBody: CompressionOriginalRangeSuccess = {
      ok: true,
      blockRef: "b1",
      blockId: "block-1",
      status: "active",
      strategy: "dynamic-range",
      trigger: "model_tool_call",
      childBlockRefs: [],
      range: {
        startMessageId: "msg-1",
        endMessageId: "msg-1",
        startRef: "m0001",
        endRef: "m0001",
        startIndex: 0,
        endIndex: 0,
      },
      coveredRefs: ["m0001"],
      coveredMessageIds: ["msg-1"],
      messages: [
        {
          ref: "m0001",
          message: {
            id: "msg-1",
            role: "assistant",
            parts: [
              {
                type: "tool",
                id: "tool-delegate-1",
                state: "completed",
                toolCallId: "tc-delegate-1",
                toolName: "delegate",
                input: { agent_type: "explore", description: "Explore codebase" },
                output: JSON.stringify({ sessionId: "child-sess-1", text: "Done" }),
                createdAt: 1,
                startedAt: 1,
                endedAt: 2,
              },
            ],
            createdAt: 1,
            completedAt: 2,
          },
        },
      ],
    };
    fetchCompressionOriginalRangeMock.mockImplementation(async () => successBody);

    const part = makeCompressionBlockPart();
    const el1 = CompressionBlock({
      part,
      projectSlug: "demo",
      sessionId: "sess-1",
      focusStoreSessionId: "session-1",
      childSessionLinks: [childLink],
      agentDescriptors: [{ name: "explore", displayName: "Code Explorer" }],
    });

    const ctaButtons = findAll(el1, (e) => {
      const text = textContent(e);
      return text.includes("Show original range") && e.props?.onClick !== undefined;
    });
    await (ctaButtons[0]!.props!.onClick as () => Promise<void>)();

    const el2 = CompressionBlock({
      part,
      projectSlug: "demo",
      sessionId: "sess-1",
      focusStoreSessionId: "session-1",
      childSessionLinks: [childLink],
      agentDescriptors: [{ name: "explore", displayName: "Code Explorer" }],
    });
    const text = textContent(el2);

    expect(text).toContain("Explore codebase");
    expect(text).toContain("Code Explorer");
    expect(text).toContain("Explored the codebase for patterns");
    expect(text).toContain("done");
  });
});

describe("PartRenderer hard compaction", () => {
  const defaultProps = { projectSlug: "demo", focusStoreSessionId: "session-1", childSessionLinks: [] as never[] };

  test("renders CompactionPart summary visibly", () => {
    resetStateSlots();
    const part: CompactionPart = {
      type: "compaction",
      id: "compaction-1",
      summary: "Previous context was compacted. Key decisions: use Bun, follow TDD.",
      tailStartId: "msg-tail-1",
      compactedAt: 123456789,
    };
    const el = PartRenderer({ part, ...defaultProps });
    const text = textContent(el);

    expect(text).toContain("Hard context compaction");
    expect(text).toContain("Previous context was compacted");
    expect(text).toContain("use Bun");
  });
});
