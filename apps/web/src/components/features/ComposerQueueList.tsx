import { type ReactNode, useCallback, useMemo, useState } from "react";
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

type LocalSendingMessage = WebSessionStoreState["localSendingMessages"][number];

type QueueEntry =
  | { kind: "durable"; message: PendingSessionMessage; time: number; order: number }
  | { kind: "local"; message: LocalSendingMessage; time: number; order: number };

export function ComposerQueueList({ slug, sessionId }: { slug: string; sessionId: string }) {
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
      className="min-h-0 max-h-[160px] shrink overflow-x-hidden overflow-y-auto border-y border-border-subtle max-[799px]:max-h-[116px]"
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
}: {
  message: PendingSessionMessage;
  slug: string;
  sessionId: string;
  steerTargetExecutionId?: string;
  activeModelBinding?: ExecutionModelBindingSummary;
  modelRuntime?: ModelRuntimeCatalog;
  nextModelSelection?: SessionNextModelSelection;
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

  const openEditor = () => {
    editMessage.reset();
    setDraft(message.content);
    setEditing(true);
  };

  return (
    <div
      className="grid min-h-[32px] min-w-0 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 border-b border-border-subtle px-2 py-1 last:border-b-0 max-[560px]:gap-1"
      data-queue-state={message.state}
      data-testid={`composer-queue-${message.id}`}
    >
      <span className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">
        {message.state === "steering" ? "Steering" : "Queued"}
      </span>
      <span className="min-w-0 truncate text-xs text-text-secondary" title={message.content}>{message.content}</span>
      <span
        className={`max-w-[240px] truncate text-[10px] text-text-muted max-[560px]:max-w-16 ${invalidationLabel ? "text-warning" : ""}`}
        data-testid={invalidationLabel ? `pending-model-invalidation-${message.id}` : `pending-requested-model-${message.id}`}
        title={invalidationLabel ?? selectionLabel(message.requestedModelSelection.selection)}
      >
        {invalidationLabel ?? selectionLabel(message.requestedModelSelection.selection)}
      </span>
      <div className="flex shrink-0 items-center justify-end gap-2 whitespace-nowrap text-[10px] text-text-muted max-[560px]:gap-1">
        {mutationError && <span className="max-w-32 truncate text-error" role="alert" title={mutationError}>{mutationError}</span>}
        {message.state === "queued" && (
          <>
            {canSteer && (
              <button
                className="text-accent hover:underline disabled:opacity-40"
                disabled={busy}
                onClick={() => steerMessage.mutate({
                  slug,
                  sessionId,
                  messageId: message.id,
                  expectedRevision: message.revision,
                  expectedExecutionId: steerTargetExecutionId,
                })}
                type="button"
              >
                Steer
              </button>
            )}
            <button className="hover:text-text-primary disabled:opacity-40" disabled={busy} onClick={openEditor} type="button">Edit</button>
            <button
              className="text-error hover:underline disabled:opacity-40"
              disabled={busy}
              onClick={() => deleteMessage.mutate({ slug, sessionId, messageId: message.id, expectedRevision: message.revision })}
              type="button"
            >
              Delete
            </button>
          </>
        )}
      </div>

      <DialogRoot open={editing} onOpenChange={(open) => { if (!open && !editMessage.isPending) setEditing(false); }}>
        <DialogContent>
          <div className="p-5">
            <DialogTitle className="text-base font-semibold text-text-primary">Edit queued message</DialogTitle>
            <DialogDescription className="mt-1 text-xs text-text-muted">
              This updates the queued instruction without changing its requested model.
            </DialogDescription>
            <label className="mt-4 grid gap-1.5 text-xs text-text-secondary">
              Message
              <textarea
                aria-label="Edit queued message"
                autoFocus
                className="min-h-28 resize-y rounded-md border border-border-default bg-bg-base px-3 py-2 text-sm leading-relaxed text-text-primary outline-none focus:border-accent"
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
                disabled={!nextDraft || nextDraft === message.content || editMessage.isPending}
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
      className="grid min-h-[32px] min-w-0 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 border-b border-border-subtle px-2 py-1 last:border-b-0 max-[560px]:gap-1"
      data-queue-state={message.status}
      data-testid={`composer-local-message-${message.clientRequestId}`}
    >
      <span className={`text-[10px] font-semibold uppercase tracking-wide ${retryable ? "text-warning" : "text-text-muted"}`}>
        {retryable ? "Retryable" : "Sending"}
      </span>
      <span className="min-w-0 truncate text-xs text-text-secondary" title={message.content}>{message.content}</span>
      <span className="max-w-[240px] truncate text-[10px] text-text-muted max-[560px]:max-w-16" data-testid={`local-requested-model-${message.clientRequestId}`} title={selectionLabel(message.requestedModelSelection.selection)}>
        {selectionLabel(message.requestedModelSelection.selection)}
      </span>
      <div className="flex shrink-0 items-center justify-end gap-2 whitespace-nowrap text-[10px] text-text-muted max-[560px]:gap-1">
        <span className="max-[560px]:hidden">{retryable ? "Send status unknown" : "Sending…"}</span>
        {retryable && (
          <button className="text-accent hover:underline" onClick={retryMessage} type="button" aria-label="Retry sending message">Retry</button>
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
      className={`rounded-md border px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50 ${primary
        ? "border-accent bg-accent text-white"
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
