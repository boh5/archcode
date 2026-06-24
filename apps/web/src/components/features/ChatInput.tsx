import { useCallback, useEffect, useRef, useState } from "react";
import { usePostMessage, usePostCommand, useAbortSession } from "../../api/mutations";
import { useSessionStore } from "../../store/session-store";

const SLASH_COMMANDS = [
  { name: "/compact", description: "Compact conversation context" },
] as const;

type SlashCommand = (typeof SLASH_COMMANDS)[number];

interface ChatInputProps {
  slug: string;
  sessionId: string;
}

export function ChatInput({ slug, sessionId }: ChatInputProps) {
  const [value, setValue] = useState("");
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [attachTooltip, setAttachTooltip] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);

  const isRunning = useSessionStore(sessionId, (s) => s.isRunning, slug);
  const modelInfo = useSessionStore(sessionId, (s) => s.modelInfo, slug);
  const postMessage = usePostMessage();
  const postCommand = usePostCommand();
  const abortSession = useAbortSession();

  const isPending = postMessage.isPending || postCommand.isPending;
  const canSend = value.trim().length > 0 && !isPending;

  const filteredCommands = SLASH_COMMANDS.filter((cmd) =>
    cmd.name.startsWith(`/ ${slashFilter}`.replace(/\s/g, "")),
  );

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxHeight = 200;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        slashMenuRef.current &&
        !slashMenuRef.current.contains(e.target as Node) &&
        textareaRef.current &&
        !textareaRef.current.contains(e.target as Node)
      ) {
        setShowSlashMenu(false);
      }
    }
    if (showSlashMenu) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [showSlashMenu]);

  const sendMessage = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || isPending) return;

    if (trimmed.startsWith("/")) {
      const parts = trimmed.split(/\s+/);
      const commandName = parts[0].slice(1);
      const commandArgs = parts.slice(1).join(" ") || undefined;

      postCommand.mutate(
        { slug, sessionId, name: commandName, args: commandArgs },
        { onSettled: () => setValue("") },
      );
    } else {
      postMessage.mutate(
        { slug, sessionId, content: trimmed },
        { onSettled: () => setValue("") },
      );
    }

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    });
  }, [value, isPending, slug, sessionId, postMessage, postCommand]);

  const selectSlashCommand = useCallback(
    (cmd: SlashCommand) => {
      postCommand.mutate(
        { slug, sessionId, name: cmd.name.slice(1) },
        { onSettled: () => setValue("") },
      );
      setShowSlashMenu(false);
      setSlashFilter("");
      setSlashActiveIndex(0);
      textareaRef.current?.focus();
    },
    [slug, sessionId, postCommand],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (showSlashMenu && filteredCommands.length > 0) {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashActiveIndex((i) =>
            i <= 0 ? filteredCommands.length - 1 : i - 1,
          );
          return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashActiveIndex((i) =>
            i >= filteredCommands.length - 1 ? 0 : i + 1,
          );
          return;
        }
        if ((e.key === "Enter" || e.key === "Tab") && !e.nativeEvent.isComposing) {
          e.preventDefault();
          selectSlashCommand(filteredCommands[slashActiveIndex]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setShowSlashMenu(false);
          setSlashFilter("");
          setSlashActiveIndex(0);
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        sendMessage();
        return;
      }

      if (e.key === "Escape" && isRunning) {
        e.preventDefault();
        abortSession.mutate({ slug, sessionId });
        return;
      }
    },
    [
      showSlashMenu,
      filteredCommands,
      slashActiveIndex,
      selectSlashCommand,
      sendMessage,
      isRunning,
      slug,
      sessionId,
      abortSession,
    ],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      setValue(newValue);

      if (newValue.startsWith("/")) {
        setShowSlashMenu(true);
        setSlashFilter(newValue.slice(1));
        setSlashActiveIndex(0);
      } else {
        setShowSlashMenu(false);
        setSlashFilter("");
      }
    },
    [],
  );

  return (
    <div className="border-t border-border-subtle bg-bg-surface px-5 py-3 flex flex-col gap-2 shrink-0 relative">
      {showSlashMenu && filteredCommands.length > 0 && !isRunning && (
        <div
          ref={slashMenuRef}
          className="absolute bottom-full left-5 right-5 bg-bg-elevated border border-border-default rounded-md shadow-lg max-h-[200px] overflow-y-auto z-10"
        >
          {filteredCommands.map((cmd, i) => (
            <div
              key={cmd.name}
              className={`flex items-center gap-2 px-3.5 py-2 cursor-pointer text-[13px] transition-colors duration-100 ${
                i === slashActiveIndex
                  ? "bg-bg-hover"
                  : "hover:bg-bg-hover"
              }`}
              onClick={() => selectSlashCommand(cmd)}
              onMouseEnter={() => setSlashActiveIndex(i)}
            >
              <span className="font-mono text-accent">{cmd.name}</span>
              <span className="text-text-muted text-xs">{cmd.description}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        <div className="relative">
          <button
            type="button"
            className="w-9 h-9 rounded-sm border border-border-default bg-transparent text-text-tertiary cursor-pointer flex items-center justify-center text-sm transition-all duration-150 hover:bg-bg-hover hover:text-text-primary hover:border-border-strong shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
            disabled={isRunning}
            onClick={() => setAttachTooltip((v) => !v)}
            onBlur={() => setAttachTooltip(false)}
            title="Attach file"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M9.5 3.5L4.5 8.5C3.67 9.33 3.67 10.67 4.5 11.5C5.33 12.33 6.67 12.33 7.5 11.5L12.5 6.5C13.88 5.12 13.88 2.88 12.5 1.5C11.12 0.12 8.88 0.12 7.5 1.5L2.5 6.5C0.73 8.27 0.73 11.23 2.5 13C4.27 14.77 7.23 14.77 9 13L13.5 8.5" />
            </svg>
          </button>
          {attachTooltip && (
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2.5 py-1.5 bg-bg-elevated border border-border-default rounded-md shadow-md text-xs text-text-secondary whitespace-nowrap z-20">
              Coming soon
            </div>
          )}
        </div>

        <div className="relative flex-1">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            disabled={isRunning}
            placeholder={isRunning ? "Thinking…" : "Send a message…"}
            rows={1}
            style={
              isRunning
                ? {
                    border: "1.5px solid transparent",
                    background: `linear-gradient(var(--bg-base), var(--bg-base)) padding-box, conic-gradient(from var(--border-angle, 0deg), transparent 0%, var(--accent) 25%, transparent 50%) border-box`,
                    animation: "thinking-border 1.5s linear infinite",
                  }
                : undefined
            }
            className={`w-full resize-none rounded-lg px-3.5 py-2.5 text-text-primary text-[13.5px] leading-[1.55] min-h-[42px] max-h-[200px] overflow-y-auto font-sans outline-none transition-all duration-200 placeholder:text-text-tertiary disabled:text-text-tertiary disabled:cursor-not-allowed ${
              isRunning
                ? "bg-transparent"
                : "border border-border-default bg-bg-base focus:border-accent"
            }`}
          />
        </div>

        {isRunning ? (
          <button
            type="button"
            className="w-9 h-9 rounded-sm border border-border-default bg-transparent text-text-tertiary flex items-center justify-center cursor-pointer shrink-0 transition-all duration-150 hover:bg-error-muted hover:border-error hover:text-error"
            onClick={() =>
              abortSession.mutate({ slug, sessionId })
            }
            title="Stop"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
              <rect width="10" height="10" rx="1.5" />
            </svg>
          </button>
        ) : (
          <button
            type="button"
            className="w-9 h-9 rounded-sm bg-accent text-bg-base flex items-center justify-center cursor-pointer shrink-0 transition-opacity duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={!canSend}
            onClick={sendMessage}
            title="Send message"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="currentColor"
            >
              <path d="M2.5 2L14 8L2.5 14L5 8L2.5 2Z" />
            </svg>
          </button>
        )}
      </div>

      <div className="flex items-center justify-between text-[11px] text-text-tertiary px-1">
        <span>{modelInfo?.displayName ?? "Unknown"}</span>
        {isRunning ? (
          <span className="text-text-secondary select-none">Thinking…</span>
        ) : (
          <span>
            <kbd className="text-text-muted">Enter</kbd> send ·{" "}
            <kbd className="text-text-muted">Shift+Enter</kbd> newline
          </span>
        )}
      </div>
    </div>
  );
}
