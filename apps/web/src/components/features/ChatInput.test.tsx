import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ModelRuntimeCatalog, SessionFamilyActivity, SessionNextModelSelection } from "@archcode/protocol";

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
const patchModelSelectionMutate = mock((_variables: unknown, _options?: unknown) => {});
const stopSessionMutate = mock((_variables: unknown) => {});
const addLocalSendingMessage = mock((_input: unknown) => {});
const removeLocalSendingMessage = mock((_clientRequestId: string) => {});
const setLocalSendingMessageStatus = mock((_clientRequestId: string, _status: string) => {});
let activity: SessionFamilyActivity | undefined;
let pendingHitlCount = 0;
let hitlReady = false;
let stopPending = false;
let modelRuntimeFetching = false;

mock.module("react", () => ({
  default: {},
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
  useEffect: (_callback: () => void | (() => void), _deps?: unknown[]) => {},
  useMemo: <T,>(factory: () => T) => factory(),
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

const Icon = (props: Record<string, unknown>) => jsxDEV("svg", props);
mock.module("lucide-react", () => ({ ArrowUp: Icon, Check: Icon, ChevronDown: Icon, Loader2: Icon, Search: Icon, Square: Icon }));

mock.module("../../api/mutations", () => ({
  usePostMessage: () => ({ mutate: postMessageMutate, isPending: false }),
  usePatchSessionModelSelection: () => ({ mutate: patchModelSelectionMutate, isPending: false }),
  useStopSessionFamily: () => ({ mutate: stopSessionMutate, isPending: stopPending }),
}));

const requestedModelSelection = { mode: "profile_default" as const, selection: { model: "test:model" } };
const nextBinding = { selection: { model: "test:model" }, providerId: "test", modelId: "model", providerDisplayName: "Test", modelDisplayName: "Test Model", resolution: "profile_default" as const, modelRuntimeRevision: "m1" };
let nextModelSelection: SessionNextModelSelection = { requested: requestedModelSelection, resolved: nextBinding };
let modelCatalog: ModelRuntimeCatalog = { revision: "m1", providers: [], profileDefaults: { principal: { model: "test:model" }, deep: { model: "test:model" }, fast: { model: "test:model" } } };

mock.module("../../api/queries", () => ({
  useModelRuntime: () => ({ data: modelCatalog, isFetching: modelRuntimeFetching }),
}));
mock.module("../../context/settings-modal", () => ({ useSettingsModal: () => ({ openSettingsModal: mock(() => {}) }) }));

mock.module("../../store/session-store", () => ({
  getWebSessionStore: () => ({
    getState: () => ({ addLocalSendingMessage, removeLocalSendingMessage, setLocalSendingMessageStatus }),
  }),
  useSessionStore: (_sessionId: string, selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      modelSelection: { revision: 0 },
      nextModelSelection,
      activeModelBinding: activity === "running" ? { ...nextBinding, selection: { model: "test:running" }, modelDisplayName: "Running Model" } : undefined,
      agentName: "lead",
    }),
}));

const { ChatInput } = await import("./ChatInput");

function renderChatInput() {
  return ChatInput({
    slug: "proj",
    sessionId: "root-1",
    activity,
    hitlReady,
    hasPendingHitl: pendingHitlCount > 0,
  });
}

describe("ChatInput runtime controls", () => {
  beforeEach(() => {
    activity = undefined;
    pendingHitlCount = 0;
    hitlReady = false;
    stopPending = false;
    modelRuntimeFetching = false;
    nextModelSelection = { requested: requestedModelSelection, resolved: nextBinding };
    modelCatalog = { revision: "m1", providers: [], profileDefaults: { principal: { model: "test:model" }, deep: { model: "test:model" }, fast: { model: "test:model" } } };
    hookCursor = 0;
    stateValues.length = 0;
    setState.mockClear();
    postMessageMutate.mockClear();
    patchModelSelectionMutate.mockClear();
    stopSessionMutate.mockClear();
    addLocalSendingMessage.mockClear();
    removeLocalSendingMessage.mockClear();
    setLocalSendingMessageStatus.mockClear();
  });

  test("renders one unified composer card without a fake attachment control", () => {
    const tree = renderChatInput();
    const card = findAll(tree, (element) => element.props?.["data-testid"] === "composer-card")[0];
    const textarea = findAll(tree, (element) => element.type === "textarea")[0];

    expect(card?.props?.className).toContain("rounded-[16px]");
    expect(card?.props?.className).toContain("overflow-visible");
    expect(card?.props?.className).not.toContain("overflow-hidden");
    expect(card?.props?.className).toContain("focus-within:border-accent");
    expect(textarea?.props?.className).toContain("border-0");
    expect(textarea?.props?.className).toContain("bg-transparent");
    expect(findAll(tree, (element) => element.props?.title === "Attach file")).toHaveLength(0);
    expect(findAll(tree, (element) => element.props?.title === "Send message")).toHaveLength(1);
  });

  test("shows the resolved Agent default before first send and separates running from next", () => {
    activity = "idle";
    hitlReady = true;
    let tree = renderChatInput();
    let picker = findAll(tree, (element) => typeof element.type === "function" && (element.type as { name?: string }).name === "ModelPicker")[0];
    expect((picker?.props?.next as { requested: { mode: string }; resolved: { modelDisplayName: string } }).requested.mode).toBe("profile_default");
    expect((picker?.props?.next as { resolved: { modelDisplayName: string } }).resolved.modelDisplayName).toBe("Test Model");
    expect(picker?.props?.active).toBeUndefined();

    activity = "running";
    hookCursor = 0;
    tree = renderChatInput();
    picker = findAll(tree, (element) => typeof element.type === "function" && (element.type as { name?: string }).name === "ModelPicker")[0];
    expect((picker?.props?.active as { modelDisplayName: string }).modelDisplayName).toBe("Running Model");
    expect((picker?.props?.next as { resolved: { modelDisplayName: string } }).resolved.modelDisplayName).toBe("Test Model");
  });

  test("gates the picker and sending until catalog and Session next share one revision", () => {
    activity = "idle";
    hitlReady = true;

    let tree = renderChatInput();
    expect(findAll(tree, (element) => typeof element.type === "function" && (element.type as { name?: string }).name === "ModelPicker")).toHaveLength(1);

    modelRuntimeFetching = true;
    hookCursor = 0;
    tree = renderChatInput();
    expect(findAll(tree, (element) => typeof element.type === "function" && (element.type as { name?: string }).name === "ModelPicker")).toHaveLength(0);
    expect(findAll(tree, (element) => element.type === "textarea")[0]?.props?.placeholder).toBe("Refreshing model configuration…");
    expect(findAll(tree, (element) => element.type === "textarea")[0]?.props?.disabled).toBe(true);

    // Session-first response: new next remains hidden until the matching catalog arrives.
    nextModelSelection = {
      requested: { mode: "profile_default", selection: { model: "test:new" } },
      resolved: { ...nextBinding, selection: { model: "test:new" }, modelId: "new", modelDisplayName: "New Model", modelRuntimeRevision: "m2" },
    };
    modelRuntimeFetching = false;
    hookCursor = 0;
    tree = renderChatInput();
    expect(findAll(tree, (element) => typeof element.type === "function" && (element.type as { name?: string }).name === "ModelPicker")).toHaveLength(0);

    modelCatalog = { revision: "m2", providers: [], profileDefaults: { principal: { model: "test:new" }, deep: { model: "test:new" }, fast: { model: "test:new" } } };
    hookCursor = 0;
    tree = renderChatInput();
    let picker = findAll(tree, (element) => typeof element.type === "function" && (element.type as { name?: string }).name === "ModelPicker")[0];
    expect((picker?.props?.next as SessionNextModelSelection).resolved.modelDisplayName).toBe("New Model");

    // Catalog-first response is also neutral until Session next catches up.
    modelCatalog = { revision: "m3", providers: [], profileDefaults: { principal: { model: "test:newer" }, deep: { model: "test:newer" }, fast: { model: "test:newer" } } };
    hookCursor = 0;
    tree = renderChatInput();
    expect(findAll(tree, (element) => typeof element.type === "function" && (element.type as { name?: string }).name === "ModelPicker")).toHaveLength(0);
    nextModelSelection = {
      requested: { mode: "profile_default", selection: { model: "test:newer" } },
      resolved: { ...nextBinding, selection: { model: "test:newer" }, modelId: "newer", modelDisplayName: "Newer Model", modelRuntimeRevision: "m3" },
    };
    hookCursor = 0;
    tree = renderChatInput();
    picker = findAll(tree, (element) => typeof element.type === "function" && (element.type as { name?: string }).name === "ModelPicker")[0];
    expect((picker?.props?.next as SessionNextModelSelection).resolved.modelDisplayName).toBe("Newer Model");
  });

  test("patches the controlled Session selection with the current revision", () => {
    activity = "idle";
    hitlReady = true;
    const tree = renderChatInput();
    const picker = findAll(tree, (element) => typeof element.type === "function" && (element.type as { name?: string }).name === "ModelPicker")[0];
    const requested = { mode: "session_override", selection: { model: "test:other", variant: "deep" } };
    (picker?.props?.onSelect as (selection: typeof requested) => void)(requested);
    expect(patchModelSelectionMutate).toHaveBeenCalledWith({ slug: "proj", sessionId: "root-1", expectedRevision: 0, requestedModelSelection: requested }, expect.any(Object));
  });

  test("disables controls until the runtime snapshot initializes", () => {
    const tree = renderChatInput();
    const textarea = findAll(tree, (element) => element.type === "textarea")[0];

    expect(textarea?.props?.disabled).toBe(true);
    expect(textarea?.props?.placeholder).toBe("Connecting to runtime…");
    expect(findAll(tree, (element) => element.props?.title === "Send message")[0]?.props?.disabled).toBe(true);
    expect(findAll(tree, (element) => element.props?.title === "Stop")).toHaveLength(0);
  });

  test("running family replaces Send with one Stop action for the entire root family", () => {
    activity = "running";
    const tree = renderChatInput();
    const stop = findAll(tree, (element) => element.props?.title === "Stop")[0];

    expect(stop).toBeDefined();
    expect(findAll(tree, (element) => element.props?.title === "Queue message")).toHaveLength(0);
    expect(findAll(tree, (element) => element.props?.title === "Send message")).toHaveLength(0);
    expect(stop?.props?.disabled).not.toBe(true);
    (stop?.props?.onClick as () => void)();
    expect(stopSessionMutate).toHaveBeenCalledWith({ slug: "proj", rootSessionId: "root-1" });
  });

  test("running family keeps Enter enabled for queued sends while the button remains Stop", () => {
    activity = "running";
    hitlReady = true;
    let tree = renderChatInput();
    let textarea = findAll(tree, (element) => element.type === "textarea")[0];

    expect(textarea?.props?.disabled).toBe(false);
    expect(textarea?.props?.placeholder).toBe("Queue a message…");
    expect(findAll(tree, (element) => element.props?.title === "Stop")).toHaveLength(1);

    (textarea?.props?.onChange as (event: unknown) => void)({ target: { value: "Queue while running" } });
    hookCursor = 0;
    tree = renderChatInput();
    textarea = findAll(tree, (element) => element.type === "textarea")[0];
    (textarea?.props?.onKeyDown as (event: unknown) => void)({
      key: "Enter",
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: mock(() => {}),
    });

    expect(postMessageMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "proj",
        sessionId: "root-1",
        content: "Queue while running",
        clientRequestId: expect.any(String),
        requestedModelSelection,
      }),
      expect.any(Object),
    );
  });

  test("stopping family disables the integrated submit control", () => {
    activity = "stopping";
    hitlReady = true;
    const tree = renderChatInput();
    const submit = findAll(tree, (element) => element.props?.title === "Send message")[0];

    expect(submit?.props?.disabled).toBe(true);
    expect(findAll(tree, (element) => element.props?.title === "Stop")).toHaveLength(0);
  });

  test("pending family stop disables duplicate Stop requests including Escape", () => {
    activity = "running";
    stopPending = true;
    const tree = renderChatInput();
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
    let tree = renderChatInput();
    let textarea = findAll(tree, (element) => element.type === "textarea")[0];
    expect(textarea?.props?.disabled).toBe(false);

    pendingHitlCount = 1;
    tree = renderChatInput();
    textarea = findAll(tree, (element) => element.type === "textarea")[0];
    expect(textarea?.props?.disabled).toBe(false);
    expect(textarea?.props?.placeholder).toBe("Queue a message…");
    expect(findAll(tree, (element) => element.props?.title === "Stop")).toHaveLength(0);
    expect(findAll(tree, (element) => element.props?.title === "Queue message")).toHaveLength(1);
  });

  test("idle runtime remains non-composable until the HITL snapshot initializes", () => {
    activity = "idle";
    hitlReady = false;

    const tree = renderChatInput();
    const textarea = findAll(tree, (element) => element.type === "textarea")[0];

    expect(textarea?.props?.disabled).toBe(true);
    expect(textarea?.props?.placeholder).toBe("Syncing pending requests…");
    expect(findAll(tree, (element) => element.props?.title === "Send message")[0]?.props?.disabled).toBe(true);
  });

  test("submits slash commands as ordinary Session messages", () => {
    activity = "idle";
    hitlReady = true;

    let tree = renderChatInput();
    const textarea = findAll(tree, (element) => element.type === "textarea")[0];
    (textarea?.props?.onChange as (event: unknown) => void)({ target: { value: "/compact" } });

    hookCursor = 0;
    tree = renderChatInput();
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
        requestedModelSelection,
      }),
      expect.any(Object),
    );
    expect(addLocalSendingMessage).toHaveBeenCalledWith(expect.objectContaining({
      content: "/compact",
      clientRequestId: expect.any(String),
      requestedModelSelection,
    }));
  });

  test("command acceptance removes its optimistic bubble without waiting for a message event", () => {
    activity = "idle";
    hitlReady = true;

    let tree = renderChatInput();
    const textarea = findAll(tree, (element) => element.type === "textarea")[0];
    (textarea?.props?.onChange as (event: unknown) => void)({ target: { value: "/compact" } });

    hookCursor = 0;
    tree = renderChatInput();
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

    let tree = renderChatInput();
    const textarea = findAll(tree, (element) => element.type === "textarea")[0];
    (textarea?.props?.onChange as (event: unknown) => void)({ target: { value: "Keep this identity" } });
    hookCursor = 0;
    tree = renderChatInput();
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
