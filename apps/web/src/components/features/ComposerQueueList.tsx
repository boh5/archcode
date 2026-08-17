import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CornerDownRight, LoaderCircle, Pencil, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import type {
  ExecutionModelBindingSummary,
  ModelRuntimeCatalog,
  ModelSelectionRef,
  PendingSessionMessage,
  RequestedModelSelection,
  SessionNextModelSelection,
} from "@archcode/protocol";
import { ApiError } from "../../api/client";
import {
  useDeletePendingMessage,
  useEditPendingMessage,
  usePostMessage,
  useSteerPendingMessage,
} from "../../api/mutations";
import { useModelRuntime } from "../../api/queries";
import { coherentModelRuntime } from "../../lib/model-runtime-coherence";
import { useSessionFamilySteerTargetExecutionId } from "../../store/session-runtime-store";
import { getWebSessionStore, useSessionStore, type WebSessionStoreState } from "../../store/session-store";
import { DialogContent, DialogDescription, DialogRoot, DialogTitle } from "../ui/Dialog";
import { ActivityArc } from "../primitives/ActivityArc";
import { StatusGlyph } from "../primitives/StatusGlyph";
import { AttachmentChip } from "../primitives/AttachmentChip";

type LocalSendingMessage = WebSessionStoreState["localSendingMessages"][number];

type QueueEntry =
  | { kind: "durable"; message: PendingSessionMessage; time: number; order: number }
  | { kind: "local"; message: LocalSendingMessage; time: number; order: number };

export function ComposerQueueList({ slug, sessionId, focusClientRequestId }: { slug: string; sessionId: string; focusClientRequestId?: string | null }) {
  const pendingMessages = useSessionStore(sessionId, (state) => state.pendingMessages, slug);
  const localSendingMessages = useSessionStore(sessionId, (state) => state.localSendingMessages, slug);
  const activeModelBinding = useSessionStore(sessionId, (state) => state.activeModelBinding, slug);
  const nextModelSelection = useSessionStore(sessionId, (state) => state.nextModelSelection, slug);
  const steerTargetExecutionId = useSessionFamilySteerTargetExecutionId(slug, sessionId);
  const { data: modelRuntime, isFetching: isModelRuntimeFetching } = useModelRuntime();
  const coherentRuntime = coherentModelRuntime(modelRuntime, nextModelSelection, isModelRuntimeFetching);
  const entries = useMemo(() => buildQueueEntries(pendingMessages, localSendingMessages), [localSendingMessages, pendingMessages]);

  if (entries.length === 0) return null;

  return (
    <section
      aria-label="Queued messages"
      className="mx-2 grid min-w-0 shrink-0 gap-1.5 bg-transparent"
      data-testid="composer-queue-list"
    >
      {entries.map((entry) => entry.kind === "durable" ? (
        <DurableQueueRow
          key={`durable-${entry.message.id}`}
          activeModelBinding={activeModelBinding}
          message={entry.message}
          modelRuntime={coherentRuntime}
          nextModelSelection={coherentRuntime ? nextModelSelection : undefined}
          sessionId={sessionId}
          slug={slug}
          steerTargetExecutionId={steerTargetExecutionId}
          focused={entry.message.clientRequestId === focusClientRequestId}
        />
      ) : (
        <LocalQueueRow key={`local-${entry.message.clientRequestId}`} message={entry.message} sessionId={sessionId} slug={slug} />
      ))}
    </section>
  );
}

function buildQueueEntries(
  pendingMessages: readonly PendingSessionMessage[],
  localSendingMessages: readonly LocalSendingMessage[],
): QueueEntry[] {
  const entries: QueueEntry[] = [];
  const durableRequestIds = new Set(pendingMessages.map((message) => message.clientRequestId));
  for (const message of pendingMessages) {
    entries.push({ kind: "durable", message, time: message.acceptedAt, order: entries.length });
  }
  for (const message of localSendingMessages) {
    if (durableRequestIds.has(message.clientRequestId)) continue;
    entries.push({ kind: "local", message, time: message.createdAt, order: entries.length });
  }
  return entries.sort((left, right) => left.time - right.time || left.order - right.order);
}

function DurableQueueRow({
  message,
  slug,
  sessionId,
  steerTargetExecutionId,
  activeModelBinding,
  modelRuntime,
  nextModelSelection,
  focused,
}: {
  message: PendingSessionMessage;
  slug: string;
  sessionId: string;
  steerTargetExecutionId?: string;
  activeModelBinding?: ExecutionModelBindingSummary;
  modelRuntime?: ModelRuntimeCatalog;
  nextModelSelection?: SessionNextModelSelection;
  focused: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const editMessage = useEditPendingMessage();
  const deleteMessage = useDeletePendingMessage();
  const steerMessage = useSteerPendingMessage();
  const resolvedPendingSelection = resolvePendingSelection(message.requestedModelSelection, modelRuntime, nextModelSelection);
  const invalidationLabel = resolvedPendingSelection !== undefined
    && !sameSelection(message.requestedModelSelection.selection, resolvedPendingSelection)
    ? `Model changed: ${selectionLabel(message.requestedModelSelection.selection)} → ${selectionLabel(resolvedPendingSelection)}`
    : undefined;
  const canSteer = message.state === "queued"
    && typeof steerTargetExecutionId === "string"
    && steerTargetExecutionId.length > 0
    && activeModelBinding !== undefined
    && resolvedPendingSelection !== undefined
    && sameSelection(resolvedPendingSelection, activeModelBinding.selection);
  const mutationError = queueMutationError(editMessage.error, deleteMessage.error, steerMessage.error);
  const busy = editMessage.isPending || deleteMessage.isPending || steerMessage.isPending;
  const nextDraft = draft.trim();
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focused || !rowRef.current) return;
    rowRef.current.scrollIntoView({ block: "nearest" });
    rowRef.current.focus({ preventScroll: true });
  }, [focused, message.id]);

  const openEditor = () => {
    editMessage.reset();
    setDraft(message.content);
    setEditing(true);
  };

  return (
    <div
      ref={rowRef}
      className={`flex min-h-10 min-w-0 items-center gap-[9px] rounded-[10px] border border-[color:color-mix(in_srgb,var(--border-strong)_72%,var(--border-subtle))] bg-[color:color-mix(in_srgb,var(--bg-elevated)_94%,var(--bg-surface))] py-[3px] pl-[9px] pr-2 transition-[background-color,border-color] duration-[var(--motion-fast)] hover:border-border-strong hover:bg-[color:color-mix(in_srgb,var(--bg-elevated)_88%,var(--bg-hover))] [@media(max-width:560px)]:gap-2 [@media(max-width:560px)]:pl-2.5 ${focused ? "ring-2 ring-inset ring-brand" : ""}`}
      data-client-request-id={message.clientRequestId}
      data-queue-state={message.state}
      data-testid={`composer-queue-${message.id}`}
      tabIndex={focused ? -1 : undefined}
      title={`Requested model: ${selectionLabel(message.requestedModelSelection.selection)}`}
    >
      {message.state === "steering" ? (
        <span className="inline-grid size-6 shrink-0 place-items-center rounded-full bg-bg-active text-info" data-queue-visual="steering">
          <ActivityArc label="Steering" size={13} />
        </span>
      ) : (
        <span className="inline-grid size-6 shrink-0 place-items-center rounded-full bg-bg-active text-text-tertiary" data-queue-visual="queued">
          <StatusGlyph kind="pending" label="Queued" size={13} />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 overflow-hidden text-[12.5px] font-medium leading-[1.35] text-text-secondary">
        {message.content && <span className="min-w-0 flex-1 truncate" title={message.content}>{message.content}</span>}
        {message.attachments.map((attachment) => <AttachmentChip key={attachment.id} attachment={attachment} className="shrink-0" />)}
      </div>
      {invalidationLabel ? <span
        className="max-w-[220px] truncate text-[10.5px] font-medium text-warning [@media(max-width:560px)]:max-w-16"
        data-testid={`pending-model-invalidation-${message.id}`}
        title={invalidationLabel}
      >{invalidationLabel}</span> : <span className="sr-only" data-testid={`pending-requested-model-${message.id}`}>{selectionLabel(message.requestedModelSelection.selection)}</span>}
      <div className="ml-1 flex shrink-0 items-center justify-end gap-0.5 whitespace-nowrap text-text-tertiary">
        {mutationError && <span className="max-w-32 truncate text-error" role="alert" title={mutationError}>{mutationError}</span>}
        {message.state === "queued" && (
          <>
            {canSteer && (
              <button
                aria-label="Steer queued message"
                className="inline-grid h-7 w-7 place-items-center rounded-full text-brand transition-colors duration-[var(--motion-fast)] hover:bg-brand-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
                disabled={busy}
                onClick={() => steerMessage.mutate({
                  slug,
                  sessionId,
                  messageId: message.id,
                  expectedRevision: message.revision,
                  expectedExecutionId: steerTargetExecutionId,
                })}
                title="Steer into root Session turn"
                type="button"
              >
                <CornerDownRight size={14} aria-hidden="true" />
              </button>
            )}
            <button aria-label="Edit queued message" className="inline-grid h-7 w-7 place-items-center rounded-full transition-colors duration-[var(--motion-fast)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11" disabled={busy} onClick={openEditor} title="Edit" type="button"><Pencil size={14} aria-hidden="true" /></button>
            <button
              aria-label="Delete queued message"
              className="inline-grid h-7 w-7 place-items-center rounded-full transition-colors duration-[var(--motion-fast)] hover:bg-error-muted hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error disabled:opacity-40 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
              disabled={busy}
              onClick={() => deleteMessage.mutate({ slug, sessionId, messageId: message.id, expectedRevision: message.revision })}
              title="Delete"
              type="button"
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </>
        )}
      </div>

      <DialogRoot open={editing} onOpenChange={(open) => { if (!open && !editMessage.isPending) setEditing(false); }}>
        <DialogContent>
          <div className="p-5">
            <DialogTitle className="text-base font-semibold text-text-primary">Edit queued message</DialogTitle>
            <DialogDescription className="mt-1 text-xs text-text-tertiary">
              This updates the queued instruction without changing its requested model.
            </DialogDescription>
            <label className="mt-4 grid gap-2 text-xs text-text-secondary">
              Message
              <textarea
                aria-label="Edit queued message"
                autoFocus
                className="min-h-28 resize-y rounded-sm border border-border-control bg-bg-base px-3 py-2 text-[13px] leading-5 text-text-primary outline-none focus:border-brand focus:ring-2 focus:ring-brand-subtle"
                disabled={editMessage.isPending}
                onChange={(event) => setDraft(event.target.value)}
                value={draft}
              />
            </label>
            {editMessage.error && <p className="mt-2 text-xs text-error" role="alert">{queueMutationError(editMessage.error)}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <DialogButton disabled={editMessage.isPending} onClick={() => setEditing(false)}>Cancel</DialogButton>
              <DialogButton
                primary
                disabled={(!nextDraft && message.attachments.length === 0) || nextDraft === message.content || editMessage.isPending}
                onClick={() => editMessage.mutate({
                  slug,
                  sessionId,
                  messageId: message.id,
                  expectedRevision: message.revision,
                  content: nextDraft,
                }, { onSuccess: () => setEditing(false) })}
              >
                Save
              </DialogButton>
            </div>
          </div>
        </DialogContent>
      </DialogRoot>
    </div>
  );
}

function LocalQueueRow({ message, slug, sessionId }: { message: LocalSendingMessage; slug: string; sessionId: string }) {
  const retry = usePostMessage();
  const retryMessage = useCallback(() => {
    const store = getWebSessionStore(sessionId, slug).getState();
    store.setLocalSendingMessageStatus(message.clientRequestId, "sending");
    retry.mutate(
      {
        slug,
        sessionId,
        content: message.content,
        attachmentIds: message.attachments.map((attachment) => attachment.id),
        clientRequestId: message.clientRequestId,
        requestedModelSelection: message.requestedModelSelection,
      },
      {
        onSuccess: (acceptance) => {
          if (acceptance.status === "command") {
            getWebSessionStore(sessionId, slug).getState().removeLocalSendingMessage(message.clientRequestId);
          }
        },
        onError: (error) => {
          const current = getWebSessionStore(sessionId, slug).getState();
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
            current.removeLocalSendingMessage(message.clientRequestId);
            return;
          }
          current.setLocalSendingMessageStatus(message.clientRequestId, "retryable");
        },
      },
    );
  }, [message, retry, sessionId, slug]);
  const retryable = message.status === "retryable" && !retry.isPending;

  return (
    <div
      className="flex min-h-10 min-w-0 items-center gap-[9px] rounded-[10px] border border-[color:color-mix(in_srgb,var(--border-strong)_72%,var(--border-subtle))] bg-[color:color-mix(in_srgb,var(--bg-elevated)_94%,var(--bg-surface))] py-[3px] pl-[9px] pr-2 transition-[background-color,border-color] duration-[var(--motion-fast)] hover:border-border-strong hover:bg-[color:color-mix(in_srgb,var(--bg-elevated)_88%,var(--bg-hover))] [@media(max-width:560px)]:gap-2 [@media(max-width:560px)]:pl-2.5"
      data-queue-state={message.status}
      data-testid={`composer-local-message-${message.clientRequestId}`}
      title={`Requested model: ${selectionLabel(message.requestedModelSelection.selection)}`}
    >
      {retryable ? (
        <span className="inline-grid size-6 shrink-0 place-items-center rounded-full bg-warning-muted text-warning" data-queue-visual="retryable" role="img" aria-label="Retryable">
          <TriangleAlert aria-hidden="true" size={13} />
        </span>
      ) : (
        <span className="inline-grid size-6 shrink-0 place-items-center rounded-full bg-bg-active text-info" data-queue-visual="sending" role="img" aria-label="Sending">
          <LoaderCircle aria-hidden="true" className="animate-activity" size={13} />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 overflow-hidden text-[12.5px] font-medium leading-[1.35] text-text-secondary">
        {message.content && <span className="min-w-0 flex-1 truncate" title={message.content}>{message.content}</span>}
        {message.attachments.map((attachment) => <AttachmentChip key={attachment.id} attachment={attachment} className="shrink-0" />)}
      </div>
      <span className="sr-only" data-testid={`local-requested-model-${message.clientRequestId}`}>
        {selectionLabel(message.requestedModelSelection.selection)}
      </span>
      <div className="ml-1 flex shrink-0 items-center justify-end gap-0.5 whitespace-nowrap text-text-tertiary">
        <span className="sr-only">{retryable ? "Send status unknown" : "Sending…"}</span>
        {retryable && (
          <button className="inline-grid h-7 w-7 place-items-center rounded-full text-brand transition-colors duration-[var(--motion-fast)] hover:bg-brand-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11" onClick={retryMessage} type="button" aria-label="Retry sending message" title="Retry"><RefreshCw size={14} aria-hidden="true" /></button>
        )}
      </div>
    </div>
  );
}

function resolvePendingSelection(
  requested: RequestedModelSelection,
  catalog: ModelRuntimeCatalog | undefined,
  nextModelSelection: SessionNextModelSelection | undefined,
): ModelSelectionRef | undefined {
  if (catalog === undefined || nextModelSelection === undefined) return undefined;
  if (catalogHasSelection(catalog, requested.selection)) return requested.selection;
  return nextModelSelection.resolved.selection;
}

function catalogHasSelection(catalog: ModelRuntimeCatalog, selection: ModelSelectionRef): boolean {
  const model = catalog.providers.flatMap((provider) => provider.models).find((candidate) => candidate.qualifiedId === selection.model);
  return model !== undefined && (selection.variant === undefined || model.variants.includes(selection.variant));
}

function sameSelection(left: ModelSelectionRef, right: ModelSelectionRef): boolean {
  return left.model === right.model && left.variant === right.variant;
}

function selectionLabel(selection: ModelSelectionRef): string {
  return selection.variant ? `${selection.model} · ${selection.variant}` : selection.model;
}

function queueMutationError(...errors: readonly unknown[]): string | undefined {
  const error = errors.find((candidate) => candidate !== null && candidate !== undefined);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : error === undefined
      ? undefined
      : "Unable to update this queued message.";
}

function DialogButton({
  children,
  disabled,
  onClick,
  primary = false,
}: {
  children: ReactNode;
  disabled: boolean;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      className={`h-8 rounded-sm border px-3 text-[12px] font-medium leading-4 transition-colors duration-[var(--motion-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-50 ${primary
        ? "border-brand bg-brand text-brand-ink"
        : "border-border-default bg-bg-base text-text-secondary hover:text-text-primary"
      }`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}
