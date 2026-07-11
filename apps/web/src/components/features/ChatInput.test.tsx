import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SessionFamilyActivity } from "@archcode/protocol";

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

function findAll(value: unknown, predicate: (element: ElementLike) => boolean): ElementLike[] {
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

const Fragment = Symbol.for("react.fragment");
const jsxDEV = mock((type: unknown, props: Record<string, unknown> | null, key?: unknown) => ({
  type,
  props: props ?? {},
  key,
}));

const setState = mock((_value: unknown) => {});
const postMessageMutate = mock((_variables: unknown, _options?: unknown) => {});
const postCommandMutate = mock((_variables: unknown, _options?: unknown) => {});
const stopSessionMutate = mock((_variables: unknown) => {});
let activity: SessionFamilyActivity | undefined;
let pendingHitlCount = 0;
let hitlReady = false;
let stopPending = false;

mock.module("react", () => ({
  default: {},
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
  useEffect: (_callback: () => void | (() => void), _deps?: unknown[]) => {},
  useRef: <T,>(initial: T) => ({ current: initial }),
  useState: <T,>(initial: T): [T, (value: T | ((previous: T) => T)) => void] => [
    initial,
    setState as (value: T | ((previous: T) => T)) => void,
  ],
}));

mock.module("react/jsx-dev-runtime", () => ({ Fragment, jsxDEV, jsx: jsxDEV, jsxs: jsxDEV }));

mock.module("../../api/mutations", () => ({
  usePostMessage: () => ({ mutate: postMessageMutate, isPending: false }),
  usePostCommand: () => ({ mutate: postCommandMutate, isPending: false }),
  useStopSessionFamily: () => ({ mutate: stopSessionMutate, isPending: stopPending }),
}));

mock.module("../../store/session-store", () => ({
  useSessionStore: (_sessionId: string, selector: (state: { modelInfo: { displayName: string } }) => unknown) =>
    selector({ modelInfo: { displayName: "Test Model" } }),
}));

mock.module("../../store/session-runtime-store", () => ({
  useSessionFamilyActivity: () => activity,
}));

mock.module("../../store/hitl-store", () => ({
  useRealtimeHitl: () => Array.from({ length: pendingHitlCount }, (_, index) => ({ hitlId: `hitl-${index}` })),
  useHitlProjectInitialized: () => hitlReady,
}));

const { ChatInput } = await import("./ChatInput");

describe("ChatInput runtime controls", () => {
  beforeEach(() => {
    activity = undefined;
    pendingHitlCount = 0;
    hitlReady = false;
    stopPending = false;
    setState.mockClear();
    postMessageMutate.mockClear();
    postCommandMutate.mockClear();
    stopSessionMutate.mockClear();
  });

  test("disables controls until the runtime snapshot initializes", () => {
    const tree = ChatInput({ slug: "proj", sessionId: "root-1" });
    const textarea = findAll(tree, (element) => element.type === "textarea")[0];
    const send = findAll(tree, (element) => element.props?.title === "Send message")[0];

    expect(textarea?.props?.disabled).toBe(true);
    expect(textarea?.props?.placeholder).toBe("Connecting to runtime…");
    expect(send?.props?.disabled).toBe(true);
    expect(findAll(tree, (element) => element.props?.title === "Stop")).toHaveLength(0);
  });

  test("running family shows Stop and stops the entire root family", () => {
    activity = "running";
    const tree = ChatInput({ slug: "proj", sessionId: "root-1" });
    const stop = findAll(tree, (element) => element.props?.title === "Stop")[0];

    expect(stop).toBeDefined();
    expect(stop?.props?.disabled).not.toBe(true);
    (stop?.props?.onClick as () => void)();
    expect(stopSessionMutate).toHaveBeenCalledWith({ slug: "proj", rootSessionId: "root-1" });
  });

  test("stopping family renders a disabled Stopping control", () => {
    activity = "stopping";
    const tree = ChatInput({ slug: "proj", sessionId: "root-1" });
    const stopping = findAll(tree, (element) => element.props?.title === "Stopping")[0];

    expect(stopping).toBeDefined();
    expect(stopping?.props?.disabled).toBe(true);
    expect(findAll(tree, (element) => element.props?.title === "Stop")).toHaveLength(0);
  });

  test("pending family stop disables duplicate Stop requests including Escape", () => {
    activity = "running";
    stopPending = true;
    const tree = ChatInput({ slug: "proj", sessionId: "root-1" });
    const stop = findAll(tree, (element) => element.props?.title === "Stop")[0];
    const textarea = findAll(tree, (element) => element.type === "textarea")[0];

    expect(stop?.props?.disabled).toBe(true);
    (textarea?.props?.onKeyDown as (event: unknown) => void)({
      key: "Escape",
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: mock(() => {}),
    });
    expect(stopSessionMutate).not.toHaveBeenCalled();
  });

  test("idle family enables composition but pending HITL blocks a new turn independently", () => {
    activity = "idle";
    hitlReady = true;
    let tree = ChatInput({ slug: "proj", sessionId: "root-1" });
    let textarea = findAll(tree, (element) => element.type === "textarea")[0];
    expect(textarea?.props?.disabled).toBe(false);

    pendingHitlCount = 1;
    tree = ChatInput({ slug: "proj", sessionId: "root-1" });
    textarea = findAll(tree, (element) => element.type === "textarea")[0];
    expect(textarea?.props?.disabled).toBe(true);
    expect(textarea?.props?.placeholder).toBe("Answer the pending request to continue…");
    expect(findAll(tree, (element) => element.props?.title === "Stop")).toHaveLength(0);
  });

  test("idle runtime remains non-composable until the HITL snapshot initializes", () => {
    activity = "idle";
    hitlReady = false;

    const tree = ChatInput({ slug: "proj", sessionId: "root-1" });
    const textarea = findAll(tree, (element) => element.type === "textarea")[0];
    const send = findAll(tree, (element) => element.props?.title === "Send message")[0];

    expect(textarea?.props?.disabled).toBe(true);
    expect(textarea?.props?.placeholder).toBe("Syncing pending requests…");
    expect(send?.props?.disabled).toBe(true);
  });
});
