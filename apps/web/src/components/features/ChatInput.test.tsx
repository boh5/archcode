import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ModelRuntimeCatalog, SessionFamilyActivity, SessionNextModelSelection } from "@archcode/protocol";
import { ApiError } from "../../api/client";

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

function textContent(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textContent).join("");
  return isElement(value) ? textContent(value.props?.children) : "";
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
let refCursor = 0;
const refValues: Array<{ current: unknown }> = [];
const postMessageMutate = mock((_variables: unknown, _options?: unknown) => {});
let uploadHandler = async (input: { attachmentId: string; file: File }) => ({
  id: input.attachmentId,
  name: input.file.name,
  mediaType: input.file.type || "application/octet-stream",
  sizeBytes: input.file.size,
  kind: input.file.type.startsWith("image/") ? "image" as const : "file" as const,
});
const uploadSessionAttachment = mock((input: { attachmentId: string; file: File }) => uploadHandler(input));
const patchModelSelectionMutate = mock((_variables: unknown, _options?: unknown) => {});
const stopSessionMutate = mock((_variables: unknown) => {});
const addLocalSendingMessage = mock((_input: unknown) => {});
const removeLocalSendingMessage = mock((_clientRequestId: string) => {});
const setLocalSendingMessageStatus = mock((_clientRequestId: string, _status: string) => {});
const getCompleteProjectSkillInventory = mock(async (_slug: string, _sessionId?: string) => []);
let activity: SessionFamilyActivity | undefined;
let pendingHitlCount = 0;
let terminalFailed = false;
let hitlReady = false;
let stopPending = false;
let modelRuntimeFetching = false;

mock.module("react", () => ({
  default: {},
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
  useEffect: (_callback: () => void | (() => void), _deps?: unknown[]) => {},
  useMemo: <T,>(factory: () => T) => factory(),
  useRef: <T,>(initial: T) => {
    const index = refCursor++;
    if (!(index in refValues)) refValues[index] = { current: initial };
    return refValues[index] as { current: T };
  },
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
mock.module("lucide-react", () => ({
  ArrowUp: Icon, Ban: Icon, Calendar: Icon, Check: Icon, ChevronDown: Icon, Circle: Icon, File: Icon, FilePlus: Icon, Image: Icon,
  CircleAlert: Icon, CircleCheck: Icon, CircleDashed: Icon,
  CirclePause: Icon, CircleStop: Icon, CircleX: Icon, Clock3: Icon, Gauge: Icon,
  Loader2: Icon, LoaderCircle: Icon, MessageCircleQuestion: Icon, Search: Icon, Square: Icon, TriangleAlert: Icon, X: Icon,
}));

mock.module("../../api/mutations", () => ({
  uploadSessionAttachment,
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
mock.module("../../api/skills", () => ({
  getCompleteProjectSkillInventory,
}));
mock.module("../../context/settings-modal", () => ({ useSettingsModal: () => ({ openSettingsModal: mock(() => {}) }) }));

mock.module("../../store/session-store", () => ({
  getWebSessionStore: () => ({
    getState: () => ({
      addLocalSendingMessage,
      applyModelStatePatch: () => {},
      removeLocalSendingMessage,
      setLocalSendingMessageStatus,
    }),
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
  refCursor = 0;
  return ChatInput({
    slug: "proj",
    sessionId: "root-1",
    activity,
    hitlReady,
    hasPendingHitl: pendingHitlCount > 0,
    terminalFailed,
  });
}

function rerenderChatInput() {
  hookCursor = 0;
  return renderChatInput();
}

function fileInputOf(tree: unknown): ElementLike {
  return findAll(tree, (element) => element.props?.["data-testid"] === "composer-file-input")[0]!;
}

function selectFiles(tree: unknown, files: File[]): void {
  const target = { files, value: "selected" };
  (fileInputOf(tree).props?.onChange as (event: { target: typeof target }) => void)({ target });
}

function composerCardOf(tree: unknown): ElementLike {
  return findAll(tree, (element) => element.props?.["data-testid"] === "composer-card")[0]!;
}

describe("ChatInput runtime controls", () => {
  beforeEach(() => {
    activity = undefined;
    pendingHitlCount = 0;
    terminalFailed = false;
    hitlReady = false;
    stopPending = false;
    modelRuntimeFetching = false;
    nextModelSelection = { requested: requestedModelSelection, resolved: nextBinding };
    modelCatalog = { revision: "m1", providers: [], profileDefaults: { principal: { model: "test:model" }, deep: { model: "test:model" }, fast: { model: "test:model" } } };
    hookCursor = 0;
    stateValues.length = 0;
    refCursor = 0;
    refValues.length = 0;
    uploadHandler = async (input) => ({
      id: input.attachmentId,
      name: input.file.name,
      mediaType: input.file.type || "application/octet-stream",
      sizeBytes: input.file.size,
      kind: input.file.type.startsWith("image/") ? "image" : "file",
    });
    uploadSessionAttachment.mockClear();
    setState.mockClear();
    postMessageMutate.mockClear();
    patchModelSelectionMutate.mockClear();
    stopSessionMutate.mockClear();
    addLocalSendingMessage.mockClear();
    removeLocalSendingMessage.mockClear();
    setLocalSendingMessageStatus.mockClear();
    getCompleteProjectSkillInventory.mockClear();
  });

  test("renders one unified composer card with a real attachment control", () => {
    const tree = renderChatInput();
    const card = findAll(tree, (element) => element.props?.["data-testid"] === "composer-card")[0];
    const textarea = findAll(tree, (element) => element.type === "textarea")[0];

    expect(card?.props?.className).toContain("rounded-xl");
    expect(card?.props?.className).toContain("overflow-visible");
    expect(card?.props?.className).not.toContain("overflow-hidden");
    expect(card?.props?.className).toContain("focus-within:border-brand");
    expect(textarea?.props?.className).toContain("border-0");
    expect(textarea?.props?.className).toContain("bg-transparent");
    const toolbar = findAll(tree, (element) => element.props?.["data-testid"] === "composer-toolbar")[0];
    const toolbarChildren = childrenOf(toolbar);
    expect(toolbarChildren[0] && isElement(toolbarChildren[0])
      ? toolbarChildren[0].props?.["data-testid"]
      : undefined).toBe("composer-left-controls");
    expect(toolbarChildren[1] && isElement(toolbarChildren[1])
      ? findAll(toolbarChildren[1], (element) => element.props?.["data-testid"] === "composer-model")
      : []).toHaveLength(1);
    expect(findAll(tree, (element) => element.props?.title === "Attach file")).toHaveLength(1);
    expect(findAll(tree, (element) => element.props?.["data-testid"] === "composer-file-input")).toHaveLength(1);
    expect(findAll(tree, (element) => element.props?.title === "Send message")).toHaveLength(1);
    expect(textContent(tree)).not.toContain("Images may be sent to the selected model provider.");
  });

  test("renders the complete Skill inventory with accessible availability states", () => {
    activity = "idle";
    hitlReady = true;
    stateValues[0] = "/skill use ";
    stateValues[1] = true;
    stateValues[2] = "skill use ";
    stateValues[3] = 0;
    stateValues[4] = [
      { name: "ready", source: "builtin", winner: true, shadowed: false, valid: true, description: "Ready Skill" },
      { name: "omitted", source: "builtin", winner: true, shadowed: false, valid: true, promptOmitted: true },
      { name: "shadowed", source: "user-agents", winner: false, shadowed: true, valid: true },
      { name: "invalid", source: "project-archcode", winner: true, shadowed: false, valid: false, diagnostic: { code: "SKILL_INVALID_PACKAGE", message: "Invalid frontmatter" } },
    ];
    stateValues[5] = "ready";

    const tree = rerenderChatInput();
    const menu = findAll(tree, (element) => element.props?.role === "listbox")[0];
    const options = findAll(tree, (element) => element.props?.role === "option");
    const textarea = findAll(tree, (element) => element.type === "textarea")[0];

    expect(menu?.props?.["aria-label"]).toBe("Skills");
    expect(options).toHaveLength(4);
    expect(options.map(textContent)).toEqual([
      "readyReady SkillbuiltinWinnerValid",
      "omittedbuiltinWinnerValidPrompt omitted",
      "shadoweduser-agentsShadowedValid",
      "invalidInvalid frontmatterproject-archcodeWinnerInvalid",
    ]);
    expect(options.map((option) => option.props?.disabled)).toEqual([false, false, true, true]);
    expect(options[0]?.props?.className).toContain("flex-wrap");
    expect(findAll(options[0], (element) => element.type === "span" && String(element.props?.className).includes("break-all"))).not.toHaveLength(0);
    expect(textarea?.props?.["aria-controls"]).toBe("composer-slash-menu");
    expect(textarea?.props?.["aria-activedescendant"]).toBe("composer-slash-option-0");
  });

  test("offers an actual retry after Skill inventory loading fails", () => {
    activity = "idle";
    hitlReady = true;
    stateValues[0] = "/skill use ";
    stateValues[1] = true;
    stateValues[2] = "skill use ";
    stateValues[3] = 0;
    stateValues[4] = [];
    stateValues[5] = "failed";

    const tree = rerenderChatInput();
    const retry = findAll(tree, (element) => element.type === "button" && textContent(element) === "Retry")[0];

    expect(findAll(tree, (element) => element.props?.role === "group" && element.props?.["aria-label"] === "Skills")).toHaveLength(1);
    expect(retry).toBeDefined();
    (retry?.props?.onClick as () => void)();
    expect(stateValues[5]).toBe("loading");
    expect(getCompleteProjectSkillInventory).toHaveBeenCalledWith("proj", "root-1");
  });

  test("Escape closes a Skill menu with no selectable matches", () => {
    activity = "idle";
    hitlReady = true;
    stateValues[0] = "/skill use missing";
    stateValues[1] = true;
    stateValues[2] = "skill use missing";
    stateValues[3] = 0;
    stateValues[4] = [];
    stateValues[5] = "ready";

    const tree = rerenderChatInput();
    const textarea = findAll(tree, (element) => element.type === "textarea")[0]!;
    const preventDefault = mock(() => {});
    (textarea.props?.onKeyDown as (event: unknown) => void)({
      key: "Escape",
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault,
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stateValues[1]).toBe(false);
  });

  test("sends Skill selection through the ordinary postMessage command path", () => {
    activity = "idle";
    hitlReady = true;
    stateValues[0] = "/skill use ready";
    stateValues[1] = true;
    stateValues[2] = "skill use ready";
    stateValues[3] = 0;
    stateValues[4] = [{ name: "ready", source: "builtin", winner: true, shadowed: false, valid: true }];
    stateValues[5] = "ready";
    const tree = rerenderChatInput();
    const textarea = findAll(tree, (element) => element.type === "textarea")[0];
    const preventDefault = mock(() => {});

    (textarea.props?.onKeyDown as (event: unknown) => void)({ key: "Enter", shiftKey: false, nativeEvent: { isComposing: false }, preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(postMessageMutate).toHaveBeenCalledTimes(1);
    expect(postMessageMutate.mock.calls[0]?.[0]).toMatchObject({
      slug: "proj",
      sessionId: "root-1",
      content: "/skill use ready",
      attachmentIds: [],
    });
  });

  test("accepts a selected file and enables an attachment-only send", () => {
    activity = "idle";
    hitlReady = true;
    let tree = renderChatInput();
    const input = findAll(tree, (element) => element.props?.["data-testid"] === "composer-file-input")[0];
    const target = { files: [new File(["draft"], "draft.txt", { type: "text/plain" })], value: "selected" };

    (input?.props?.onChange as (event: { target: typeof target }) => void)({ target });
    hookCursor = 0;
    tree = renderChatInput();

    expect(target.value).toBe("");
    expect(findAll(tree, (element) => element.props?.["data-testid"] === "composer-attachments")).toHaveLength(1);
    expect(findAll(tree, (element) => element.props?.title === "Send message")[0]?.props?.disabled).toBe(false);
  });

  test("rejects a dropped folder without adding any of its files", () => {
    activity = "idle";
    hitlReady = true;
    let tree = renderChatInput();
    const preventDefault = mock(() => {});

    (composerCardOf(tree).props?.onDrop as (event: unknown) => void)({
      preventDefault,
      dataTransfer: {
        items: [{ webkitGetAsEntry: () => ({ isDirectory: true }) }],
        files: [new File(["nested"], "nested.txt")],
      },
    });
    tree = rerenderChatInput();

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(findAll(tree, (element) => element.props?.["data-testid"] === "composer-attachments")).toHaveLength(0);
    expect(textContent(findAll(tree, (element) => element.props?.role === "alert")[0])).toContain("Folders are not supported");
  });

  test("adds ordinary multi-file drops in browser order", () => {
    activity = "idle";
    hitlReady = true;
    let tree = renderChatInput();
    const files = [new File(["a"], "a.txt"), new File(["bb"], "b.txt")];

    (composerCardOf(tree).props?.onDrop as (event: unknown) => void)({
      preventDefault: mock(() => {}),
      dataTransfer: {
        items: files.map(() => ({ webkitGetAsEntry: () => ({ isDirectory: false }) })),
        files,
      },
    });
    tree = rerenderChatInput();

    const removeLabels = findAll(tree, (element) => String(element.props?.["aria-label"] ?? "").startsWith("Remove "))
      .map((element) => element.props?.["aria-label"]);
    expect(removeLabels).toEqual(["Remove a.txt", "Remove b.txt"]);
  });

  test("renders clipboard images as ordinary file chips and prevents the browser paste fallback", () => {
    activity = "idle";
    hitlReady = true;
    let tree = renderChatInput();
    const preventDefault = mock(() => {});
    const image = new File(["png"], "clipboard.png", { type: "image/png" });
    const textarea = findAll(tree, (element) => element.type === "textarea")[0]!;

    (textarea.props?.onPaste as (event: unknown) => void)({
      preventDefault,
      clipboardData: { files: [image] },
    });
    tree = rerenderChatInput();

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(findAll(tree, (element) => element.type === "img")).toHaveLength(0);
    expect(textContent(tree)).toContain("clipboard.png");
    expect(findAll(tree, (element) => element.props?.["aria-label"] === "Remove clipboard.png")).toHaveLength(1);
  });

  test("preserves attach order and exposes no reorder controls", () => {
    activity = "idle";
    hitlReady = true;
    let tree = renderChatInput();
    selectFiles(tree, [
      new File(["a"], "a.txt"),
      new File(["b"], "b.txt"),
      new File(["c"], "c.txt"),
    ]);
    tree = rerenderChatInput();

    expect(findAll(tree, (element) => String(element.props?.["aria-label"] ?? "").startsWith("Move "))).toHaveLength(0);
    (findAll(tree, (element) => element.props?.["aria-label"] === "Remove a.txt")[0]?.props?.onClick as () => void)();
    tree = rerenderChatInput();

    const removeLabels = findAll(tree, (element) => String(element.props?.["aria-label"] ?? "").startsWith("Remove "))
      .map((element) => element.props?.["aria-label"]);
    expect(removeLabels).toEqual(["Remove b.txt", "Remove c.txt"]);
  });

  test("shows upload progress without a fake cancellation control", async () => {
    activity = "idle";
    hitlReady = true;
    let finish: ((value: { id: string; name: string; mediaType: string; sizeBytes: number; kind: "file" }) => void) | undefined;
    uploadHandler = async (input) => new Promise((resolve) => {
      finish = resolve;
    });
    let tree = renderChatInput();
    selectFiles(tree, [new File(["body"], "uploading.txt")]);
    tree = rerenderChatInput();

    const send = (findAll(tree, (element) => element.props?.title === "Send message")[0]?.props?.onClick as () => Promise<void>)();
    tree = rerenderChatInput();

    expect(textContent(tree)).toContain("Uploading…");
    expect(findAll(tree, (element) => element.props?.["aria-label"] === "Remove uploading.txt")).toHaveLength(0);
    expect(findAll(tree, (element) => String(element.props?.["aria-label"] ?? "").startsWith("Move "))).toHaveLength(0);

    finish?.({ id: "uploaded", name: "uploading.txt", mediaType: "text/plain", sizeBytes: 4, kind: "file" });
    await send;
  });

  test("uploads sequentially in draft order, then posts the ordered ids once", async () => {
    activity = "idle";
    hitlReady = true;
    const uploadOrder: string[] = [];
    uploadHandler = async (input) => {
      uploadOrder.push(input.file.name);
      return {
        id: input.attachmentId,
        name: input.file.name,
        mediaType: "text/plain",
        sizeBytes: input.file.size,
        kind: "file",
      };
    };
    let tree = renderChatInput();
    selectFiles(tree, [new File(["first"], "first.txt"), new File(["second"], "second.txt")]);
    tree = rerenderChatInput();

    await (findAll(tree, (element) => element.props?.title === "Send message")[0]?.props?.onClick as () => Promise<void>)();

    expect(uploadOrder).toEqual(["first.txt", "second.txt"]);
    expect(uploadSessionAttachment).toHaveBeenCalledTimes(2);
    const uploadedIds = uploadSessionAttachment.mock.calls.map(([input]) => input.attachmentId);
    expect(postMessageMutate).toHaveBeenCalledTimes(1);
    expect(postMessageMutate).toHaveBeenCalledWith(
      expect.objectContaining({ content: "", attachmentIds: uploadedIds }),
      expect.any(Object),
    );
  });

  test("retries a failed upload from the full File with the same attachment id", async () => {
    activity = "idle";
    hitlReady = true;
    let attempts = 0;
    uploadHandler = async (input) => {
      attempts += 1;
      if (attempts === 1) throw new Error("connection reset");
      return {
        id: input.attachmentId,
        name: input.file.name,
        mediaType: "application/octet-stream",
        sizeBytes: input.file.size,
        kind: "file",
      };
    };
    const file = new File(["complete-body"], "retry.bin");
    let tree = renderChatInput();
    selectFiles(tree, [file]);
    tree = rerenderChatInput();
    await (findAll(tree, (element) => element.props?.title === "Send message")[0]?.props?.onClick as () => Promise<void>)();
    tree = rerenderChatInput();

    (findAll(tree, (element) => element.type === "button" && textContent(element) === "Retry")[0]?.props?.onClick as () => void)();
    await Promise.resolve();
    await Promise.resolve();

    expect(uploadSessionAttachment).toHaveBeenCalledTimes(2);
    const [first, second] = uploadSessionAttachment.mock.calls.map(([input]) => input);
    expect(second.attachmentId).toBe(first.attachmentId);
    expect(first.file).toBe(file);
    expect(second.file).toBe(file);
  });

  test("shows all three recovery options for a server 413", async () => {
    activity = "idle";
    hitlReady = true;
    uploadHandler = async () => {
      throw new ApiError({ code: "ATTACHMENT_TOO_LARGE", message: "too large", status: 413 });
    };
    let tree = renderChatInput();
    selectFiles(tree, [new File(["small-client-file"], "server-rejected.bin")]);
    tree = rerenderChatInput();
    await (findAll(tree, (element) => element.props?.title === "Send message")[0]?.props?.onClick as () => Promise<void>)();
    tree = rerenderChatInput();
    const notice = textContent(findAll(tree, (element) => element.props?.role === "alert")[0]);

    expect(notice).toContain("Compress");
    expect(notice).toContain("split");
    expect(notice).toContain("workspace");
    expect(notice).toContain("path");
  });

  test("blocks attachment plus slash command from menu click and Enter", async () => {
    activity = "idle";
    hitlReady = true;
    let tree = renderChatInput();
    selectFiles(tree, [new File(["data"], "context.txt")]);
    tree = rerenderChatInput();
    let textarea = findAll(tree, (element) => element.type === "textarea")[0]!;
    (textarea.props?.onChange as (event: unknown) => void)({ target: { value: "/compact" } });
    tree = rerenderChatInput();

    const command = findAll(tree, (element) => element.type === "button" && textContent(element).includes("/compact"))[0]!;
    (command.props?.onClick as () => void)();
    tree = rerenderChatInput();
    textarea = findAll(tree, (element) => element.type === "textarea")[0]!;
    (textarea.props?.onKeyDown as (event: unknown) => void)({
      key: "Enter",
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: mock(() => {}),
    });
    await Promise.resolve();
    tree = rerenderChatInput();

    expect(uploadSessionAttachment).not.toHaveBeenCalled();
    expect(postMessageMutate).not.toHaveBeenCalled();
    expect(textContent(findAll(tree, (element) => element.props?.role === "alert")[0])).toContain("Slash commands can only be sent as plain text");
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

  test("running family keeps Queue and Stop as independent visible actions", () => {
    activity = "running";
    const tree = renderChatInput();
    const stop = findAll(tree, (element) => element.props?.title === "Stop")[0];
    const queue = findAll(tree, (element) => element.props?.title === "Queue message")[0];

    expect(stop).toBeDefined();
    expect(queue).toBeDefined();
    expect(queue?.props?.disabled).toBe(true);
    expect(queue?.props?.className).toContain("bg-brand");
    expect(queue?.props?.className).toContain("text-brand-ink");
    expect(stop?.props?.className).toContain("bg-bg-active");
    expect(stop?.props?.className).toContain("hover:bg-error");
    expect(findAll(tree, (element) => element.props?.title === "Send message")).toHaveLength(0);
    expect(stop?.props?.disabled).not.toBe(true);
    (stop?.props?.onClick as () => void)();
    expect(stopSessionMutate).toHaveBeenCalledWith({ slug: "proj", rootSessionId: "root-1" });
  });

  test("suspended and resuming families queue and stop instead of becoming ready", () => {
    for (const familyActivity of ["waiting_for_human", "resuming"] as const) {
      activity = familyActivity;
      hitlReady = true;
      hookCursor = 0;
      const tree = renderChatInput();
      const textarea = findAll(tree, (element) => element.type === "textarea")[0];
      const stop = findAll(tree, (element) => element.props?.title === "Stop")[0];
      const queue = findAll(tree, (element) => element.props?.title === "Queue message")[0];

      expect(textarea?.props?.disabled).toBe(false);
      expect(textarea?.props?.placeholder).toBe("Queue a message…");
      expect(stop?.props?.disabled).not.toBe(true);
      expect(queue).toBeDefined();
      expect(findAll(tree, (element) => element.props?.title === "Send message")).toHaveLength(0);
    }
  });

  test("running family queues from Enter or the independent Queue action", () => {
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
    const queue = findAll(tree, (element) => element.props?.title === "Queue message")[0];
    expect(queue?.props?.disabled).toBe(false);
    (queue?.props?.onClick as () => void)();

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

    (textarea?.props?.onChange as (event: unknown) => void)({ target: { value: "Queue from Enter" } });
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
        content: "Queue from Enter",
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
    const submit = findAll(tree, (element) => element.props?.title === "Stopping")[0];

    expect(submit?.props?.disabled).toBe(true);
    expect(findAll(tree, (element) => element.props?.title === "Send message")).toHaveLength(0);
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

  test("pending HITL keeps the bottom composer visible and queue-ready", () => {
    activity = "idle";
    hitlReady = true;
    pendingHitlCount = 1;
    const tree = renderChatInput();
    const textarea = findAll(tree, (element) => element.type === "textarea")[0];
    expect(textarea?.props?.disabled).toBe(false);
    expect(textarea?.props?.placeholder).toBe("Queue a message…");
    expect(findAll(tree, (element) => element.props?.title === "Stop")).toHaveLength(0);
    expect(findAll(tree, (element) => element.props?.title === "Queue message")).toHaveLength(1);
  });

  test("a suspended family with HITL keeps Stop and presents Needs you", () => {
    activity = "waiting_for_human";
    hitlReady = true;
    pendingHitlCount = 1;
    const tree = renderChatInput();

    expect(findAll(tree, (element) => element.type === "textarea")[0]).toBeDefined();
    expect(findAll(tree, (element) => element.props?.title === "Stop")).toHaveLength(1);
    expect(textContent(tree)).toContain("Needs you");
    expect(findAll(tree, (element) => element.props?.title === "Send message")).toHaveLength(0);
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

  test("terminal failed work keeps error state in the always-visible Composer", () => {
    activity = "idle";
    hitlReady = true;
    terminalFailed = true;
    const tree = renderChatInput();
    expect(textContent(tree)).toContain("Failed");
    expect(findAll(tree, (element) => element.type === "textarea")[0]).toBeDefined();
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
