import { useEffect, useRef, useState, type RefObject } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError } from "../../api/client";
import {
  useCreateProjectTodo,
  useRunProjectTodoNow,
  useStartProjectTodoDiscussion,
} from "../../api/mutations";
import { createClientUuid } from "../../lib/client-uuid";

export interface ProjectTodoRunNowRecovery {
  readonly todoId: string;
  readonly sessionId?: string;
  readonly message: string;
  readonly content?: string;
}

export interface ProjectTodoDiscussionStartRecovery {
  readonly todoId: string;
  readonly sessionId: string;
  readonly content: string;
  readonly message: string;
}

export function projectTodoRunNowRecovery(cause: unknown): ProjectTodoRunNowRecovery | null {
  if (!(cause instanceof ApiError) || cause.details === null || typeof cause.details !== "object") return null;
  const details = cause.details as Record<string, unknown>;
  if (details.scopeCode !== "PROJECT_TODO_RUN_NOW_RECOVERY_REQUIRED" || typeof details.todoId !== "string") return null;
  return {
    todoId: details.todoId,
    ...(typeof details.sessionId === "string" ? { sessionId: details.sessionId } : {}),
    message: cause.message,
  };
}

export function projectTodoStartDiscussionRecovery(cause: unknown): Omit<ProjectTodoDiscussionStartRecovery, "content"> | null {
  if (!(cause instanceof ApiError) || cause.details === null || typeof cause.details !== "object") return null;
  const details = cause.details as Record<string, unknown>;
  if (details.scopeCode !== "PROJECT_TODO_START_DISCUSSION_RECOVERY_REQUIRED"
    || typeof details.todoId !== "string"
    || typeof details.sessionId !== "string") return null;
  return { todoId: details.todoId, sessionId: details.sessionId, message: cause.message };
}

export function ProjectTodoCaptureDialog({
  slug,
  open,
  returnFocusRef,
  onOpenChange,
  onSaved,
}: {
  slug: string;
  open: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const navigate = useNavigate();
  const createTodo = useCreateProjectTodo();
  const runNow = useRunProjectTodoNow();
  const startDiscussion = useStartProjectTodoDiscussion();
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [failureAction, setFailureAction] = useState<"save" | "discussion" | "run" | null>(null);
  const [runRecovery, setRunRecovery] = useState<ProjectTodoRunNowRecovery | null>(null);
  const [discussionRecovery, setDiscussionRecovery] = useState<ProjectTodoDiscussionStartRecovery | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const saveActionRef = useRef<HTMLButtonElement>(null);
  const discussionActionRef = useRef<HTMLButtonElement>(null);
  const runActionRef = useRef<HTMLButtonElement>(null);
  const saveOperationRef = useRef<{ token: string; content: string; slug: string } | null>(null);
  const runRequestRef = useRef<{ requestId: string; content: string; slug: string } | null>(null);
  const discussionRequestRef = useRef<{ requestId: string; content: string; slug: string } | null>(null);
  const mountedRef = useRef(false);
  const currentSlugRef = useRef(slug);
  const previousSlugRef = useRef(slug);
  currentSlugRef.current = slug;

  const pending = createTodo.isPending || runNow.isPending || startDiscussion.isPending;
  const normalizedContent = content.trim();
  const blockedRunRecovery = runRecovery?.content === normalizedContent ? runRecovery : null;
  const blockedDiscussionRecovery = discussionRecovery?.content === normalizedContent ? discussionRecovery : null;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (previousSlugRef.current === slug) return;
    previousSlugRef.current = slug;
    reset(false);
    onOpenChange(false);
  }, [slug]);

  const reset = (restoreFocus: boolean) => {
    setContent("");
    setError(null);
    setFailureAction(null);
    setRunRecovery(null);
    setDiscussionRecovery(null);
    saveOperationRef.current = null;
    runRequestRef.current = null;
    discussionRequestRef.current = null;
    if (restoreFocus) requestAnimationFrame(() => returnFocusRef.current?.focus());
  };

  const close = () => {
    if (pending) return;
    reset(true);
    onOpenChange(false);
  };

  const updateContent = (value: string) => {
    setContent(value);
    setError(null);
    setFailureAction(null);
    setRunRecovery(null);
    setDiscussionRecovery(null);
    saveOperationRef.current = null;
    runRequestRef.current = null;
    discussionRequestRef.current = null;
  };

  const requireContent = (): string | null => {
    const next = content.trim();
    if (next.length > 0) return next;
    setError("Todo content is required");
    setFailureAction(null);
    inputRef.current?.focus();
    return null;
  };

  const save = () => {
    const next = requireContent();
    if (next === null) return;
    const operation = { token: createClientUuid(), content: next, slug };
    saveOperationRef.current = operation;
    setError(null);
    setFailureAction(null);
    createTodo.mutate({ slug: operation.slug, input: { content: operation.content } }, {
      onSuccess: () => {
        if (!mountedRef.current || currentSlugRef.current !== operation.slug || saveOperationRef.current !== operation) return;
        reset(false);
        onOpenChange(false);
        onSaved();
        requestAnimationFrame(() => returnFocusRef.current?.focus());
      },
      onError: (cause) => {
        if (!mountedRef.current || currentSlugRef.current !== operation.slug || saveOperationRef.current !== operation) return;
        setFailureAction("save");
        setError(messageFor(cause));
      },
    });
  };

  const run = () => {
    const next = requireContent();
    if (next === null) return;
    const previous = runRequestRef.current;
    const operation = previous?.content === next && previous.slug === slug
      ? previous
      : { requestId: createClientUuid(), content: next, slug };
    runRequestRef.current = operation;
    setError(null);
    setFailureAction(null);
    runNow.mutate({ slug: operation.slug, clientRequestId: operation.requestId, content: operation.content }, {
      onSuccess: ({ session }) => {
        if (!mountedRef.current || currentSlugRef.current !== operation.slug || runRequestRef.current !== operation) return;
        reset(false);
        onOpenChange(false);
        navigate(`/projects/${encodeURIComponent(operation.slug)}/sessions/${encodeURIComponent(session.sessionId)}`);
      },
      onError: (cause) => {
        if (!mountedRef.current || currentSlugRef.current !== operation.slug || runRequestRef.current !== operation) return;
        const recovery = projectTodoRunNowRecovery(cause);
        if (recovery !== null) {
          runRequestRef.current = null;
          setError(null);
          setFailureAction(null);
          setRunRecovery({ ...recovery, content: next });
          return;
        }
        setFailureAction("run");
        setError(messageFor(cause));
      },
    });
  };

  const discuss = () => {
    const next = requireContent();
    if (next === null) return;
    const previous = discussionRequestRef.current;
    const operation = previous?.content === next && previous.slug === slug
      ? previous
      : { requestId: createClientUuid(), content: next, slug };
    discussionRequestRef.current = operation;
    setError(null);
    setFailureAction(null);
    startDiscussion.mutate({ slug: operation.slug, clientRequestId: operation.requestId, content: operation.content }, {
      onSuccess: ({ session }) => {
        if (!mountedRef.current || currentSlugRef.current !== operation.slug || discussionRequestRef.current !== operation) return;
        reset(false);
        onOpenChange(false);
        navigate(`/projects/${encodeURIComponent(operation.slug)}/sessions/${encodeURIComponent(session.sessionId)}`);
      },
      onError: (cause) => {
        if (!mountedRef.current || currentSlugRef.current !== operation.slug || discussionRequestRef.current !== operation) return;
        const recovery = projectTodoStartDiscussionRecovery(cause);
        if (recovery !== null) {
          discussionRequestRef.current = null;
          setError(null);
          setFailureAction(null);
          setDiscussionRecovery({ ...recovery, content: next });
          return;
        }
        setFailureAction("discussion");
        setError(messageFor(cause));
      },
    });
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen && !pending) close(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="animate-todo-dialog-backdrop fixed inset-0 z-[70] bg-[rgba(6,8,7,0.56)] backdrop-blur-[4px]"
          data-testid="new-todo-scrim"
        />
        <DialogPrimitive.Content
          aria-busy={pending}
          aria-describedby="new-todo-help new-todo-status"
          onOpenAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus(); }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocusRef.current?.focus();
          }}
          onEscapeKeyDown={(event) => { if (pending) event.preventDefault(); }}
          onPointerDownOutside={(event) => { if (pending) event.preventDefault(); }}
          onInteractOutside={(event) => { if (pending) event.preventDefault(); }}
          className="animate-todo-dialog fixed inset-0 z-[71] m-auto flex h-fit max-h-[min(680px,calc(100dvh-32px))] w-[min(560px,calc(100vw-32px))] flex-col overflow-hidden rounded-[var(--shape-dialog)] border border-border-default bg-bg-overlay shadow-lg outline-none"
        >
          <header className="flex min-h-[52px] shrink-0 items-center gap-3 border-b border-border-subtle py-0 pl-[18px] pr-1.5 min-[761px]:pr-2.5">
            <DialogPrimitive.Title className="flex-1 text-[15px] font-semibold text-text-primary">New Todo</DialogPrimitive.Title>
            <button type="button" aria-label="Close New Todo" disabled={pending} onClick={close} className="grid h-11 w-11 shrink-0 place-items-center rounded-[6px] text-text-tertiary transition-colors duration-[var(--motion-fast)] hover:bg-bg-hover hover:text-text-primary disabled:opacity-40 focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] min-[761px]:h-[34px] min-[761px]:w-[34px] [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11">
              <X size={16} aria-hidden="true" />
            </button>
          </header>
          <div className="min-h-0 overflow-y-auto p-4 min-[761px]:p-[18px]">
            <label htmlFor="new-todo-content" className="mb-2 block text-[12px] font-semibold text-text-secondary">Todo content</label>
            <textarea ref={inputRef} id="new-todo-content" rows={6} value={content} onChange={(event) => updateContent(event.target.value)} disabled={pending} aria-describedby="new-todo-help" placeholder="Describe an idea, bug, feature, refactor, or other work…" className="h-[180px] min-h-[180px] max-h-[280px] w-full resize-y rounded-[8px] border border-border-control bg-bg-elevated px-[14px] py-3 text-[16px] leading-[1.6] text-text-primary outline-none focus:border-brand focus:[box-shadow:var(--focus)] disabled:opacity-60 min-[761px]:h-[126px] min-[761px]:min-h-[126px] min-[761px]:text-[15px]" />
            <DialogPrimitive.Description id="new-todo-help" className="mt-2.5 text-[11px] leading-[1.5] text-text-tertiary">Markdown is supported. Save it for later, shape it in a Discussion, or run it as a Lead Session.</DialogPrimitive.Description>
            <p id="new-todo-status" role="status" aria-live="polite" className="sr-only">{pending ? createTodo.isPending ? "Saving Todo…" : startDiscussion.isPending ? "Starting Discussion…" : "Starting work…" : ""}</p>
            <CaptureFeedback error={error} failureAction={failureAction} runRecovery={blockedRunRecovery} discussionRecovery={blockedDiscussionRecovery} slug={slug} pending={pending} saveActionRef={saveActionRef} discussionActionRef={discussionActionRef} runActionRef={runActionRef} />
          </div>
          <footer className="grid shrink-0 grid-cols-2 items-center gap-2.5 border-t border-border-subtle bg-bg-surface px-4 pb-4 pt-3 min-[761px]:flex min-[761px]:justify-end min-[761px]:px-[18px] min-[761px]:py-3">
            <button type="button" disabled={pending} onClick={close} className="hidden h-[34px] items-center justify-center rounded-[6px] px-[11px] text-[11.5px] font-semibold text-text-secondary transition-colors duration-[var(--motion-fast)] hover:bg-bg-hover disabled:opacity-40 min-[761px]:inline-flex [@media(pointer:coarse)]:!h-11">Cancel</button>
            <button ref={saveActionRef} type="button" disabled={pending || blockedRunRecovery !== null || blockedDiscussionRecovery !== null} onClick={save} className="inline-flex h-11 items-center justify-center rounded-[6px] border border-border-default bg-bg-overlay px-[13px] text-[11.5px] font-semibold text-text-secondary transition-colors duration-[var(--motion-fast)] hover:border-border-strong hover:bg-bg-hover disabled:opacity-40 min-[761px]:h-[34px] min-[761px]:px-[11px] [@media(pointer:coarse)]:!h-11">{createTodo.isPending ? "Saving…" : failureAction === "save" ? "Retry save" : "Save"}</button>
            <button ref={discussionActionRef} type="button" disabled={pending || blockedRunRecovery !== null || blockedDiscussionRecovery !== null} onClick={discuss} className="inline-flex h-11 items-center justify-center rounded-[6px] border border-border-default bg-bg-overlay px-[13px] text-[11.5px] font-semibold text-text-secondary transition-colors duration-[var(--motion-fast)] hover:border-brand hover:bg-brand-field hover:text-brand disabled:opacity-40 min-[761px]:h-[34px] min-[761px]:px-[11px] [@media(pointer:coarse)]:!h-11">{startDiscussion.isPending ? "Starting discussion…" : failureAction === "discussion" ? "Retry discussion" : "Start discussion"}</button>
            <button ref={runActionRef} type="button" disabled={pending || blockedRunRecovery !== null || blockedDiscussionRecovery !== null} onClick={run} className="primary-action-button relative col-span-2 inline-flex h-11 items-center justify-center overflow-hidden rounded-[6px] border border-brand bg-brand px-[13px] text-[11.5px] font-semibold text-brand-ink transition-[background-color,border-color,color,box-shadow] duration-[var(--motion-fast)] hover:border-brand-hover hover:bg-brand-hover disabled:border-bg-active disabled:bg-bg-active disabled:text-text-tertiary disabled:shadow-none min-[761px]:col-span-1 min-[761px]:h-[34px] min-[761px]:px-[11px] [@media(pointer:coarse)]:!h-11">{runNow.isPending ? "Starting…" : failureAction === "run" ? "Retry run" : "Run now"}</button>
          </footer>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function CaptureFeedback({ error, failureAction, runRecovery, discussionRecovery, slug, pending, saveActionRef, discussionActionRef, runActionRef }: {
  error: string | null;
  failureAction: "save" | "discussion" | "run" | null;
  runRecovery: ProjectTodoRunNowRecovery | null;
  discussionRecovery: ProjectTodoDiscussionStartRecovery | null;
  slug: string;
  pending: boolean;
  saveActionRef: RefObject<HTMLButtonElement | null>;
  discussionActionRef: RefObject<HTMLButtonElement | null>;
  runActionRef: RefObject<HTMLButtonElement | null>;
}) {
  const feedbackRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (pending) return;
    if (runRecovery || discussionRecovery) {
      requestAnimationFrame(() => feedbackRef.current?.focus());
      return;
    }
    const retryAction = failureAction === "save"
      ? saveActionRef.current
      : failureAction === "discussion"
        ? discussionActionRef.current
        : failureAction === "run"
          ? runActionRef.current
          : null;
    if (retryAction !== null) requestAnimationFrame(() => retryAction.focus());
  }, [discussionActionRef, discussionRecovery, failureAction, pending, runActionRef, runRecovery, saveActionRef]);

  if (error) return <p role="alert" className="mt-3 text-[11px] text-error">{error}</p>;
  if (runRecovery) return <div ref={feedbackRef} tabIndex={-1} role="alert" className="mt-3 border-l-2 border-error bg-error-muted px-3 py-2 text-[11px] leading-5 text-error outline-none focus-visible:[box-shadow:var(--focus)]"><p>{runRecovery.message} Do not retry this unchanged request; inspect the retained work first.</p><div className="flex flex-wrap gap-x-3"><Link className="font-medium underline" to={`/projects/${encodeURIComponent(slug)}/todos/${encodeURIComponent(runRecovery.todoId)}`}>Open Todo {runRecovery.todoId}</Link>{runRecovery.sessionId ? <Link className="font-medium underline" to={`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(runRecovery.sessionId)}`}>Open Session {runRecovery.sessionId}</Link> : null}</div><p>Edit the Todo content before starting a different request.</p></div>;
  if (discussionRecovery) return <div ref={feedbackRef} tabIndex={-1} role="alert" className="mt-3 border-l-2 border-error bg-error-muted px-3 py-2 text-[11px] leading-5 text-error outline-none focus-visible:[box-shadow:var(--focus)]"><p>{discussionRecovery.message} Inspect the retained work before starting another request.</p><div className="flex flex-wrap gap-x-3"><Link className="font-medium underline" to={`/projects/${encodeURIComponent(slug)}/todos/${encodeURIComponent(discussionRecovery.todoId)}`}>Open Todo {discussionRecovery.todoId}</Link><Link className="font-medium underline" to={`/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(discussionRecovery.sessionId)}`}>Open Session {discussionRecovery.sessionId}</Link></div><p>Edit the Todo content before starting a different operation.</p></div>;
  return null;
}

function messageFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The request failed.";
}
