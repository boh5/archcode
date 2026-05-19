import { useCallback, useEffect, useRef, useState } from "react";
import { usePostMessage, usePostCommand } from "../../api/mutations";
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

  const isRunning = useSessionStore(sessionId, (s) => s.isRunning);
  const postMessage = usePostMessage();
  const postCommand = usePostCommand();

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
        if (e.key === "Enter" || e.key === "Tab") {
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

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
        return;
      }

      if (e.key === "Escape" && isRunning) {
        e.preventDefault();
        postCommand.mutate({ slug, sessionId, name: "abort" });
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
      postCommand,
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

  // v1: static label until model info is available in store
  const modelName = "GLM-5";

  return (
    <div className="border-t border-border-subtle bg-bg-surface px-5 py-3 flex flex-col gap-2 shrink-0 relative">
      {showSlashMenu && filteredCommands.length > 0 && (
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
            className="w-9 h-9 rounded-sm border border-border-default bg-transparent text-text-tertiary cursor-pointer flex items-center justify-center text-sm transition-all duration-150 hover:bg-bg-hover hover:text-text-primary hover:border-border-strong shrink-0"
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

        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Send a message…"
          rows={1}
          className="flex-1 resize-none border border-border-default rounded-lg px-3.5 py-2.5 bg-bg-base text-text-primary text-[13.5px] leading-[1.55] min-h-[42px] max-h-[200px] overflow-y-auto font-sans outline-none transition-colors duration-150 focus:border-accent placeholder:text-text-tertiary"
        />

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
      </div>

      <div className="flex items-center justify-between text-[11px] text-text-tertiary px-1">
        <span>{modelName}</span>
        <span>
          <kbd className="text-text-muted">Enter</kbd> send ·{" "}
          <kbd className="text-text-muted">Shift+Enter</kbd> newline
          {isRunning && (
            <>
              {" · "}
              <kbd className="text-text-muted">Esc</kbd> abort
            </>
          )}
        </span>
      </div>
    </div>
  );
}