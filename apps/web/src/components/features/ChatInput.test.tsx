import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SessionFamilyActivity } from "@archcode/protocol";

globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
  callback(0);
  return 1;
}) as typeof requestAnimationFrame;

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
let hookCursor = 0;
const stateValues: unknown[] = [];
const postMessageMutate = mock((_variables: unknown, _options?: unknown) => {});
const stopSessionMutate = mock((_variables: unknown) => {});
const addLocalSendingMessage = mock((_input: unknown) => {});
const removeLocalSendingMessage = mock((_clientRequestId: string) => {});
const setLocalSendingMessageStatus = mock((_clientRequestId: string, _status: string) => {});
let activity: SessionFamilyActivity | undefined;
let pendingHitlCount = 0;
let hitlReady = false;
let stopPending = false;

mock.module("react", () => ({
  default: {},
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
  useEffect: (_callback: () => void | (() => void), _deps?: unknown[]) => {},
  useRef: <T,>(initial: T) => ({ current: initial }),
  useState: <T,>(initial: T): [T, (value: T | ((previous: T) => T)) => void] => {
    const index = hookCursor++;
    if (!(index in stateValues)) stateValues[index] = initial;
    return [
      stateValues[index] as T,
      (value: T | ((previous: T) => T)) => {
        const previous = stateValues[index] as T;
        stateValues[index] = typeof value === "function"
          ? (value as (previous: T) => T)(previous)
          : value;
        setState(value);
      },
    ];
  },
}));

mock.module("react/jsx-dev-runtime", () => ({ Fragment, jsxDEV, jsx: jsxDEV, jsxs: jsxDEV }));

mock.module("../../api/mutations", () => ({
  usePostMessage: () => ({ mutate: postMessageMutate, isPending: false }),
  useStopSessionFamily: () => ({ mutate: stopSessionMutate, isPending: stopPending }),
}));

mock.module("../../store/session-store", () => ({
  getWebSessionStore: () => ({
    getState: () => ({ addLocalSendingMessage, removeLocalSendingMessage, setLocalSendingMessageStatus }),
  }),
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
    hookCursor = 0;
    stateValues.length = 0;
    setState.mockClear();
    postMessageMutate.mockClear();
    stopSessionMutate.mockClear();
    addLocalSendingMessage.mockClear();
    removeLocalSendingMessage.mockClear();
    setLocalSendingMessageStatus.mockClear();
  });

  test("disables controls until the runtime snapshot initializes", () => {
    const tree = ChatInput({ slug: "proj", sessionId: "root-1" });
    const textarea = findAll(tree, (element) => element.type === "textarea")[0];

    expect(textarea?.props?.disabled).toBe(true);
    expect(textarea?.props?.placeholder).toBe("Connecting to runtime…");
    expect(findAll(tree, (element) => element.props?.title === "Send message")).toHaveLength(0);
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

  test("running family keeps the composer enabled for queued sends", () => {
    activity = "running";
    hitlReady = true;
    const tree = ChatInput({ slug: "proj", sessionId: "root-1" });
    const textarea = findAll(tree, (element) => element.type === "textarea")[0];

    expect(textarea?.props?.disabled).toBe(false);
    expect(textarea?.props?.placeholder).toBe("Queue a message…");
    expect(findAll(tree, (element) => element.props?.title === "Send message")).toHaveLength(0);
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

  test("pending HITL keeps ordinary Queue composition enabled", () => {
    activity = "idle";
    hitlReady = true;
    let tree = ChatInput({ slug: "proj", sessionId: "root-1" });
    let textarea = findAll(tree, (element) => element.type === "textarea")[0];
    expect(textarea?.props?.disabled).toBe(false);

    pendingHitlCount = 1;
    tree = ChatInput({ slug: "proj", sessionId: "root-1" });
    textarea = findAll(tree, (element) => element.type === "textarea")[0];
    expect(textarea?.props?.disabled).toBe(false);
    expect(textarea?.props?.placeholder).toBe("Queue a message…");
    expect(findAll(tree, (element) => element.props?.title === "Stop")).toHaveLength(0);
  });

  test("idle runtime remains non-composable until the HITL snapshot initializes", () => {
    activity = "idle";
    hitlReady = false;

    const tree = ChatInput({ slug: "proj", sessionId: "root-1" });
    const textarea = findAll(tree, (element) => element.type === "textarea")[0];

    expect(textarea?.props?.disabled).toBe(true);
    expect(textarea?.props?.placeholder).toBe("Syncing pending requests…");
    expect(findAll(tree, (element) => element.props?.title === "Send message")).toHaveLength(0);
  });

  test("submits slash commands as ordinary Session messages", () => {
    activity = "idle";
    hitlReady = true;

    let tree = ChatInput({ slug: "proj", sessionId: "root-1" });
    const textarea = findAll(tree, (element) => element.type === "textarea")[0];
    (textarea?.props?.onChange as (event: unknown) => void)({ target: { value: "/compact" } });

    hookCursor = 0;
    tree = ChatInput({ slug: "proj", sessionId: "root-1" });
    const updatedTextarea = findAll(tree, (element) => element.type === "textarea")[0];
    (updatedTextarea?.props?.onKeyDown as (event: unknown) => void)({
      key: "Enter",
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: mock(() => {}),
    });

    expect(postMessageMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "proj",
        sessionId: "root-1",
        content: "/compact",
        clientRequestId: expect.any(String),
      }),
      expect.any(Object),
    );
    expect(addLocalSendingMessage).toHaveBeenCalledWith(expect.objectContaining({
      content: "/compact",
      clientRequestId: expect.any(String),
    }));
  });

  test("command acceptance removes its optimistic bubble without waiting for a message event", () => {
    activity = "idle";
    hitlReady = true;

    let tree = ChatInput({ slug: "proj", sessionId: "root-1" });
    const textarea = findAll(tree, (element) => element.type === "textarea")[0];
    (textarea?.props?.onChange as (event: unknown) => void)({ target: { value: "/compact" } });

    hookCursor = 0;
    tree = ChatInput({ slug: "proj", sessionId: "root-1" });
    const updatedTextarea = findAll(tree, (element) => element.type === "textarea")[0];
    (updatedTextarea?.props?.onKeyDown as (event: unknown) => void)({
      key: "Enter",
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: mock(() => {}),
    });

    const [variables, options] = postMessageMutate.mock.calls[0] as unknown as [
      { clientRequestId: string },
      { onSuccess: (acceptance: { clientRequestId: string; messageId: string; status: "command" }) => void },
    ];
    options.onSuccess({
      clientRequestId: variables.clientRequestId,
      messageId: variables.clientRequestId,
      status: "command",
    });

    expect(removeLocalSendingMessage).toHaveBeenCalledWith(variables.clientRequestId);
  });

  test("an unknown POST outcome keeps the same request identity and exposes retry", () => {
    activity = "idle";
    hitlReady = true;

    let tree = ChatInput({ slug: "proj", sessionId: "root-1" });
    const textarea = findAll(tree, (element) => element.type === "textarea")[0];
    (textarea?.props?.onChange as (event: unknown) => void)({ target: { value: "Keep this identity" } });
    hookCursor = 0;
    tree = ChatInput({ slug: "proj", sessionId: "root-1" });
    const updatedTextarea = findAll(tree, (element) => element.type === "textarea")[0];
    (updatedTextarea?.props?.onKeyDown as (event: unknown) => void)({
      key: "Enter",
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: mock(() => {}),
    });

    const [variables, options] = postMessageMutate.mock.calls[0] as unknown as [
      { clientRequestId: string },
      { onError: (error: Error) => void },
    ];
    options.onError(new Error("network outcome unknown"));

    expect(removeLocalSendingMessage).not.toHaveBeenCalled();
    expect(setLocalSendingMessageStatus).toHaveBeenCalledWith(variables.clientRequestId, "retryable");
  });
});
