import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Loader2, Square } from "lucide-react";
import type { SessionFamilyActivity } from "@archcode/protocol";
import { ApiError } from "../../api/client";
import { usePostMessage, useStopSessionFamily } from "../../api/mutations";
import { getWebSessionStore, useSessionStore } from "../../store/session-store";

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
): { label: string; dotClass: string } {
  if (activity === undefined) return { label: "Connecting", dotClass: "bg-text-muted" };
  if (!hitlReady) return { label: "Syncing", dotClass: "bg-text-muted" };
  if (activity === "stopping") return { label: "Stopping", dotClass: "bg-warning" };
  if (hasPendingHitl) return { label: "Waiting for input", dotClass: "bg-warning" };
  if (activity === "running") return { label: "Running", dotClass: "bg-accent" };
  return { label: "Ready", dotClass: "bg-success" };
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

  const modelInfo = useSessionStore(sessionId, (state) => state.modelInfo, slug);
  const postMessage = usePostMessage();
  const stopSession = useStopSessionFamily();

  const isPending = postMessage.isPending || stopSession.isPending;
  const isRunning = activity === "running";
  const isStopping = activity === "stopping";
  const runtimeReady = activity !== undefined;
  const canCompose = runtimeReady && hitlReady && !isStopping && !isPending;
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

  const submitMessage = useCallback((content: string) => {
    const clientRequestId = crypto.randomUUID();
    getWebSessionStore(sessionId, slug).getState().addLocalSendingMessage({
      clientRequestId,
      content,
    });

    postMessage.mutate(
      { slug, sessionId, content, clientRequestId },
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
    if (!content || !canCompose) return;
    submitMessage(content);
  }, [canCompose, submitMessage, value]);

  const selectSlashCommand = useCallback((command: SlashCommand) => {
    if (!canCompose || isRunning || hasPendingHitl) return;
    submitMessage(command.name);
    setShowSlashMenu(false);
    setSlashFilter("");
    setSlashActiveIndex(0);
    textareaRef.current?.focus();
  }, [canCompose, hasPendingHitl, isRunning, submitMessage]);

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
          className="absolute bottom-[calc(100%+8px)] left-0 right-0 z-20 max-h-[200px] overflow-y-auto rounded-[12px] border border-border-default bg-bg-elevated p-1 shadow-lg"
          data-testid="composer-slash-menu"
        >
          {filteredCommands.map((command, index) => (
            <button
              type="button"
              key={command.name}
              className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] transition-colors duration-100 ${
                index === slashActiveIndex ? "bg-bg-hover" : "hover:bg-bg-hover"
              }`}
              onClick={() => selectSlashCommand(command)}
              onMouseEnter={() => setSlashActiveIndex(index)}
            >
              <span className="font-mono text-accent">{command.name}</span>
              <span className="text-xs text-text-muted">{command.description}</span>
            </button>
          ))}
        </div>
      )}

      <div
        className="overflow-hidden rounded-[16px] border border-border-default bg-bg-elevated shadow-md transition-[border-color,box-shadow] duration-150 focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-subtle),var(--shadow-md)]"
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
                : hasPendingHitl || isRunning
                  ? "Queue a message…"
                  : isStopping
                    ? "Stopping…"
                    : "Send a message…"
          }
          rows={1}
          className="block min-h-[48px] max-h-[200px] w-full resize-none overflow-y-auto border-0 bg-transparent px-[14px] pb-[8px] pt-[12px] font-sans text-[13.5px] leading-[1.55] text-text-primary outline-none placeholder:text-text-tertiary disabled:cursor-not-allowed disabled:text-text-tertiary"
        />

        <div className="flex min-h-[38px] items-center justify-between gap-3 px-[10px] pb-[9px]">
          <div className="flex min-w-0 items-center gap-2 text-[11px] text-text-tertiary">
            <span className="max-w-[180px] truncate" data-testid="composer-model">
              {modelInfo?.displayName ?? "Unknown model"}
            </span>
            <span className="h-3 w-px shrink-0 bg-border-default" aria-hidden="true" />
            <span className="flex shrink-0 items-center gap-1.5" aria-live="polite">
              <span className={`h-1.5 w-1.5 rounded-full ${status.dotClass}`} aria-hidden="true" />
              {status.label}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <span className="mr-1 text-[10.5px] text-text-muted max-[720px]:hidden">
              {isRunning ? "Enter to queue" : "Shift+Enter for newline"}
            </span>
            <button
              type="button"
              className={`flex h-8 w-8 items-center justify-center rounded-lg shadow-sm transition-[background-color,color,transform] active:scale-95 disabled:cursor-not-allowed disabled:bg-bg-active disabled:text-text-muted disabled:shadow-none ${isRunning
                ? "bg-text-primary text-bg-base hover:bg-error hover:text-white"
                : "bg-text-primary text-bg-base hover:bg-accent-hover hover:text-white"
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
                  ? <Loader2 size={14} className="animate-spin" />
                  : <Square size={11} fill="currentColor" />
                : isStopping || isPending
                  ? <Loader2 size={14} className="animate-spin" />
                  : <ArrowUp size={16} strokeWidth={2} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
