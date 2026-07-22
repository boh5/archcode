import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Loader2, Square } from "lucide-react";
import type { RequestedModelSelection, SessionFamilyActivity } from "@archcode/protocol";
import { ApiError } from "../../api/client";
import { usePatchSessionModelSelection, usePostMessage, useStopSessionFamily } from "../../api/mutations";
import { useModelRuntime } from "../../api/queries";
import { getWebSessionStore, useSessionStore } from "../../store/session-store";
import { useSettingsModal } from "../../context/settings-modal";
import { ModelPicker } from "./ModelPicker";
import { coherentModelRuntime } from "../../lib/model-runtime-coherence";
import { createClientUuid } from "../../lib/client-uuid";
import type { StatusTone, VisualStatusKind } from "../../lib/status-visuals";
import { StatusGlyph } from "../primitives/StatusGlyph";

const SLASH_COMMANDS = [
  { name: "/compact", description: "Compact conversation context" },
] as const;

type SlashCommand = (typeof SLASH_COMMANDS)[number];

export interface ChatInputProps {
  slug: string;
  sessionId: string;
  activity: SessionFamilyActivity | undefined;
  hitlReady: boolean;
  hasPendingHitl: boolean;
}

function composerStatus(
  activity: SessionFamilyActivity | undefined,
  hitlReady: boolean,
  hasPendingHitl: boolean,
): { label: string; kind: VisualStatusKind; tone?: StatusTone } {
  if (activity === undefined) return { label: "Connecting", kind: "running", tone: "neutral" };
  if (!hitlReady) return { label: "Syncing", kind: "running", tone: "info" };
  if (activity === "stopping") return { label: "Stopping", kind: "running", tone: "warning" };
  if (hasPendingHitl) return { label: "Waiting for input", kind: "needs_you" };
  if (activity === "running") return { label: "Running", kind: "running" };
  return { label: "Ready", kind: "idle" };
}

export function ChatInput({
  slug,
  sessionId,
  activity,
  hitlReady,
  hasPendingHitl,
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);

  const modelSelection = useSessionStore(sessionId, (state) => state.modelSelection, slug);
  const nextModelSelection = useSessionStore(sessionId, (state) => state.nextModelSelection, slug);
  const activeModelBinding = useSessionStore(sessionId, (state) => state.activeModelBinding, slug);
  const agentName = useSessionStore(sessionId, (state) => state.agentName, slug);
  const { data: modelCatalog, isFetching: isModelRuntimeFetching } = useModelRuntime();
  const coherentCatalog = coherentModelRuntime(
    modelCatalog,
    nextModelSelection,
    isModelRuntimeFetching,
  );
  const { openSettingsModal } = useSettingsModal();
  const postMessage = usePostMessage();
  const patchModelSelection = usePatchSessionModelSelection();
  const stopSession = useStopSessionFamily();

  const isPending = postMessage.isPending || patchModelSelection.isPending || stopSession.isPending;
  const isRunning = activity === "running";
  const isStopping = activity === "stopping";
  const runtimeReady = activity !== undefined;
  const modelControlsReady = coherentCatalog !== undefined && agentName !== null;
  const canCompose = runtimeReady && hitlReady && modelControlsReady && !isStopping && !isPending && nextModelSelection !== undefined;
  const canSubmit = canCompose && value.trim().length > 0;
  const status = composerStatus(activity, hitlReady, hasPendingHitl);
  const filteredCommands = SLASH_COMMANDS.filter((command) =>
    command.name.startsWith(`/ ${slashFilter}`.replace(/\s/g, "")),
  );

  const adjustHeight = useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        slashMenuRef.current
        && !slashMenuRef.current.contains(event.target as Node)
        && textareaRef.current
        && !textareaRef.current.contains(event.target as Node)
      ) {
        setShowSlashMenu(false);
      }
    }

    if (!showSlashMenu) return;
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showSlashMenu]);

  const submitMessage = useCallback((content: string, requestedModelSelection: RequestedModelSelection) => {
    const clientRequestId = createClientUuid();
    getWebSessionStore(sessionId, slug).getState().addLocalSendingMessage({
      clientRequestId,
      content,
      requestedModelSelection,
    });

    postMessage.mutate(
      { slug, sessionId, content, clientRequestId, requestedModelSelection },
      {
        onSuccess: (acceptance) => {
          // Commands have no canonical message event to replace this optimistic record.
          if (acceptance.status === "command") {
            getWebSessionStore(sessionId, slug).getState().removeLocalSendingMessage(clientRequestId);
          }
        },
        onError: (error) => {
          // Restore a definitively rejected draft. Ambiguous network outcomes
          // stay in the Dock so Retry can reuse this exact clientRequestId.
          const store = getWebSessionStore(sessionId, slug).getState();
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
            store.removeLocalSendingMessage(clientRequestId);
            setValue(content);
            return;
          }
          store.setLocalSendingMessageStatus(clientRequestId, "retryable");
        },
      },
    );
    setValue("");

    requestAnimationFrame(() => {
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    });
  }, [postMessage, sessionId, slug]);

  const sendMessage = useCallback(() => {
    const content = value.trim();
    if (!content || !canCompose || !nextModelSelection) return;
    submitMessage(content, nextModelSelection.requested);
  }, [canCompose, nextModelSelection, submitMessage, value]);

  const selectSlashCommand = useCallback((command: SlashCommand) => {
    if (!canCompose || isRunning || hasPendingHitl) return;
    if (!nextModelSelection) return;
    submitMessage(command.name, nextModelSelection.requested);
    setShowSlashMenu(false);
    setSlashFilter("");
    setSlashActiveIndex(0);
    textareaRef.current?.focus();
  }, [canCompose, hasPendingHitl, isRunning, nextModelSelection, submitMessage]);

  const selectModel = useCallback((requestedModelSelection: RequestedModelSelection) => {
    patchModelSelection.mutate({
      slug,
      sessionId,
      expectedRevision: modelSelection.revision,
      requestedModelSelection,
    }, {
      onSuccess: (state) => getWebSessionStore(sessionId, slug).getState().initializeFromSnapshot(state),
    });
  }, [modelSelection.revision, patchModelSelection, sessionId, slug]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSlashMenu && filteredCommands.length > 0) {
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashActiveIndex((index) => index <= 0 ? filteredCommands.length - 1 : index - 1);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashActiveIndex((index) => index >= filteredCommands.length - 1 ? 0 : index + 1);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.nativeEvent.isComposing) {
        event.preventDefault();
        selectSlashCommand(filteredCommands[slashActiveIndex]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setShowSlashMenu(false);
        setSlashFilter("");
        setSlashActiveIndex(0);
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      sendMessage();
      return;
    }

    if (event.key === "Escape" && isRunning && !stopSession.isPending) {
      event.preventDefault();
      stopSession.mutate({ slug, rootSessionId: sessionId });
    }
  }, [
    filteredCommands,
    isRunning,
    selectSlashCommand,
    sendMessage,
    sessionId,
    showSlashMenu,
    slashActiveIndex,
    slug,
    stopSession,
  ]);

  const handleChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = event.target.value;
    setValue(nextValue);
    if (nextValue.startsWith("/")) {
      setShowSlashMenu(true);
      setSlashFilter(nextValue.slice(1));
      setSlashActiveIndex(0);
      return;
    }
    setShowSlashMenu(false);
    setSlashFilter("");
  }, []);

  return (
    <div className="relative" data-testid="conversation-composer">
      {showSlashMenu && filteredCommands.length > 0 && canCompose && !isRunning && !hasPendingHitl && (
        <div
          ref={slashMenuRef}
          className="absolute bottom-[calc(100%+8px)] left-0 right-0 z-20 max-h-[200px] overflow-y-auto rounded-lg border border-border-default bg-bg-overlay p-1 shadow-md"
          data-testid="composer-slash-menu"
        >
          {filteredCommands.map((command, index) => (
            <button
              type="button"
              key={command.name}
              className={`flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-[13px] transition-colors duration-[var(--motion-hover)] ${
                index === slashActiveIndex ? "bg-bg-hover" : "hover:bg-bg-hover"
              }`}
              onClick={() => selectSlashCommand(command)}
              onMouseEnter={() => setSlashActiveIndex(index)}
            >
              <span className="font-mono text-brand">{command.name}</span>
              <span className="text-[12px] leading-4 text-text-tertiary">{command.description}</span>
            </button>
          ))}
        </div>
      )}

      <div
        className="overflow-visible rounded-lg border border-border-control bg-bg-elevated shadow-sm transition-[border-color,box-shadow] duration-[var(--motion-hover)] focus-within:border-brand focus-within:ring-2 focus-within:ring-brand"
        data-testid="composer-card"
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          disabled={!canCompose}
          placeholder={
            !runtimeReady
              ? "Connecting to runtime…"
              : !hitlReady
                ? "Syncing pending requests…"
                : !modelControlsReady
                  ? "Refreshing model configuration…"
                  : hasPendingHitl || isRunning
                  ? "Queue a message…"
                  : isStopping
                    ? "Stopping…"
                    : "Send a message…"
          }
          rows={1}
          className="block min-h-[48px] max-h-[200px] w-full resize-none overflow-y-auto border-0 bg-transparent px-4 pb-2 pt-3 font-sans text-[13px] leading-5 text-text-primary outline-none placeholder:text-text-tertiary disabled:cursor-not-allowed disabled:text-text-tertiary"
        />

        <div className="flex min-h-[38px] items-center justify-between gap-3 px-3 pb-2">
          <div className="flex min-w-0 items-center gap-2 text-[11px] text-text-tertiary" data-testid="composer-model">
            {coherentCatalog && nextModelSelection && agentName ? <ModelPicker
              catalog={coherentCatalog}
              next={nextModelSelection}
              active={activeModelBinding}
              onSelect={selectModel}
              onManageModels={() => openSettingsModal("models")}
              disabled={patchModelSelection.isPending}
            /> : <span className="max-w-[180px] truncate">Loading model…</span>}
            <span className="h-3 w-px shrink-0 bg-border-default" aria-hidden="true" />
            <span className="flex shrink-0 items-center gap-2" aria-live="polite">
              <StatusGlyph kind={status.kind} tone={status.tone} size={11} />
              {status.label}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <span className="mr-1 text-[11px] text-text-tertiary max-[720px]:hidden">
              {isRunning ? "Enter to queue" : "Shift+Enter for newline"}
            </span>
            <button
              type="button"
              className={`flex h-8 w-8 items-center justify-center rounded-sm transition-colors duration-[var(--motion-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:bg-bg-active disabled:text-text-muted ${isRunning
                ? "bg-text-primary text-bg-base hover:bg-error hover:text-bg-overlay"
                : "bg-text-primary text-bg-base hover:bg-brand-hover hover:text-bg-overlay"
              }`}
              disabled={isRunning ? stopSession.isPending : !canSubmit}
              onClick={isRunning
                ? () => stopSession.mutate({ slug, rootSessionId: sessionId })
                : sendMessage}
              title={isRunning ? "Stop" : hasPendingHitl ? "Queue message" : "Send message"}
              aria-label={isRunning ? "Stop session" : hasPendingHitl ? "Queue message" : "Send message"}
            >
              {isRunning
                ? stopSession.isPending
                  ? <Loader2 size={14} className="animate-activity" />
                  : <Square size={11} fill="currentColor" />
                : isStopping || isPending
                  ? <Loader2 size={14} className="animate-activity" />
                  : <ArrowUp size={16} strokeWidth={2} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
