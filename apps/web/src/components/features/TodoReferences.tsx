import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Download, File as FileIcon, FileImage, FileText, LoaderCircle, Plus, RefreshCw, Trash2 } from "lucide-react";
import { MAX_ATTACHMENT_SIZE_BYTES, MAX_ATTACHMENTS_PER_TODO } from "@archcode/protocol";
import type { AttachmentDescriptor } from "@archcode/protocol";
import type { ProjectTodo, ProjectTodoAttachmentListResponse } from "../../api/types";
import {
  removeProjectTodoAttachment,
  uploadProjectTodoAttachment,
} from "../../api/mutations";
import { projectTodoAttachmentsQueryOptions, queryKeys, useProjectTodoAttachments } from "../../api/queries";
import { ApiError } from "../../api/client";
import { createClientUuid } from "../../lib/client-uuid";
import { formatAttachmentSize } from "../primitives/AttachmentChip";
import { DestructiveActionDialog } from "./DestructiveActionDialog";

type PendingUploadStatus = "queued" | "uploading" | "error";

interface PendingUpload {
  id: string;
  file: File;
  status: PendingUploadStatus;
  error?: string;
}

interface UploadTask {
  rowId: string;
  file: File;
}

export function todoAttachmentUrl(slug: string, todoId: string, attachmentId: string): string {
  return `/api/projects/${encodeURIComponent(slug)}/todos/${encodeURIComponent(todoId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

/** Only image bytes and native PDF documents may be opened inline. */
export function canOpenTodoAttachmentInline(attachment: AttachmentDescriptor): boolean {
  return attachment.mediaType === "application/pdf"
    || (
      attachment.kind === "image"
      && attachment.mediaType.startsWith("image/")
      && attachment.mediaType !== "image/svg+xml"
    );
}

function messageFor(cause: unknown, fallback: string): string {
  if (cause instanceof ApiError) return cause.message;
  return cause instanceof Error ? cause.message : fallback;
}

export function TodoReferences({ slug, todo }: { slug: string; todo: ProjectTodo }) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const revisionRef = useRef(todo.revision);
  const queueRef = useRef<UploadTask[]>([]);
  const drainingRef = useRef(false);
  const blockedUploadIdRef = useRef<string | null>(null);
  const pendingRef = useRef<PendingUpload[]>([]);
  const [pendingUploads, setPendingUploadsState] = useState<PendingUpload[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [isDropActive, setIsDropActive] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<AttachmentDescriptor | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const attachments = useProjectTodoAttachments(slug, todo.id);

  const refreshRevision = useCallback(async () => {
    try {
      const current = await queryClient.fetchQuery(
        { ...projectTodoAttachmentsQueryOptions(slug, todo.id), staleTime: 0 },
      );
      revisionRef.current = Math.max(revisionRef.current, current.todoRevision);
    } catch {
      // The existing row error remains authoritative and retryable.
    }
  }, [queryClient, slug, todo.id]);

  const setPendingUploads = useCallback((update: PendingUpload[] | ((current: PendingUpload[]) => PendingUpload[])) => {
    setPendingUploadsState((current) => {
      const next = typeof update === "function" ? update(current) : update;
      pendingRef.current = next;
      return next;
    });
  }, []);

  const updatePending = useCallback((id: string, update: (item: PendingUpload) => PendingUpload) => {
    setPendingUploads((current) => current.map((item) => item.id === id ? update(item) : item));
  }, [setPendingUploads]);

  useEffect(() => {
    if (attachments.data === undefined) return;
    revisionRef.current = Math.max(revisionRef.current, todo.revision, attachments.data.todoRevision);
  }, [attachments.data, todo.revision]);

  const drainUploadQueue = useCallback(async () => {
    if (drainingRef.current || blockedUploadIdRef.current !== null) return;
    drainingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        const task = queueRef.current.shift();
        if (task === undefined) break;
        updatePending(task.rowId, (item) => ({ ...item, status: "uploading", error: undefined }));
        try {
          const result = await uploadProjectTodoAttachment({
            slug,
            todoId: todo.id,
            attachmentId: task.rowId,
            expectedRevision: revisionRef.current,
            file: task.file,
          });
          revisionRef.current = result.todo.revision;
          queryClient.setQueryData<ProjectTodo[]>(queryKeys.projectTodos(slug), (current) =>
            current?.map((candidate) => candidate.id === result.todo.id ? result.todo : candidate),
          );
          const attachmentQueryKey = queryKeys.projectTodoAttachments(slug, todo.id);
          const currentAttachments = queryClient.getQueryData<ProjectTodoAttachmentListResponse>(attachmentQueryKey);
          const known = new Map(currentAttachments?.attachments.map((candidate) => [candidate.id, candidate]));
          known.set(result.attachment.id, result.attachment);
          const ordered = result.todo.attachmentIds
            .map((id) => known.get(id))
            .filter((candidate): candidate is AttachmentDescriptor => candidate !== undefined);
          if (ordered.length === result.todo.attachmentIds.length) {
            queryClient.setQueryData<ProjectTodoAttachmentListResponse>(attachmentQueryKey, {
              todoRevision: result.todo.revision,
              attachments: ordered,
            });
          } else {
            void queryClient.invalidateQueries({ queryKey: attachmentQueryKey, exact: true, refetchType: "all" });
          }
          setPendingUploads((current) => current.filter((item) => item.id !== task.rowId));
        } catch (cause) {
          const error = messageFor(cause, "Could not add this reference");
          blockedUploadIdRef.current = task.rowId;
          updatePending(task.rowId, (item) => ({ ...item, status: "error", error }));
          setNotice("Upload paused. Retry or dismiss the failed file to continue.");
          await refreshRevision();
          break;
        }
      }
    } finally {
      drainingRef.current = false;
      if (blockedUploadIdRef.current === null && queueRef.current.length > 0) {
        queueMicrotask(() => { void drainUploadQueue(); });
      }
    }
  }, [queryClient, refreshRevision, setPendingUploads, slug, todo.id, updatePending]);

  const enqueueFiles = useCallback((incoming: readonly File[]) => {
    setNotice(null);
    const remoteCount = attachments.data?.attachments.length ?? todo.attachmentIds.length;
    const existingCount = remoteCount + pendingRef.current.length;
    const available = Math.max(0, MAX_ATTACHMENTS_PER_TODO - existingCount);
    if (incoming.length > available) {
      setNotice(`A Todo can keep at most ${MAX_ATTACHMENTS_PER_TODO} references.`);
    }
    const accepted = incoming.slice(0, available);
    const tasks: UploadTask[] = [];
    const addedUploads: PendingUpload[] = [];
    for (const file of accepted) {
      const rowId = createClientUuid();
      if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
        setNotice("Files larger than 50 MiB cannot be added.");
        continue;
      }
      addedUploads.push({ id: rowId, file, status: "queued" });
      tasks.push({ rowId, file });
    }
    if (addedUploads.length > 0) {
      setPendingUploads((current) => [...current, ...addedUploads]);
    }
    queueRef.current.push(...tasks);
    void drainUploadQueue();
  }, [attachments.data?.attachments.length, drainUploadQueue, setPendingUploads, todo.attachmentIds.length]);

  const onInputChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) enqueueFiles(Array.from(event.target.files));
    event.target.value = "";
  }, [enqueueFiles]);

  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDropActive(true);
  }, []);

  const onDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsDropActive(false);
  }, []);

  const onDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDropActive(false);
    enqueueFiles(Array.from(event.dataTransfer.files));
  }, [enqueueFiles]);

  const retryUpload = useCallback((item: PendingUpload) => {
    if (item.status === "uploading") return;
    if (blockedUploadIdRef.current === item.id) blockedUploadIdRef.current = null;
    setNotice(null);
    updatePending(item.id, (current) => ({ ...current, status: "queued", error: undefined }));
    queueRef.current.unshift({ rowId: item.id, file: item.file });
    void drainUploadQueue();
  }, [drainUploadQueue, updatePending]);

  const discardUpload = useCallback((rowId: string) => {
    if (blockedUploadIdRef.current === rowId) blockedUploadIdRef.current = null;
    queueRef.current = queueRef.current.filter((task) => task.rowId !== rowId);
    setPendingUploads((current) => current.filter((item) => item.id !== rowId));
    setNotice(null);
    void drainUploadQueue();
  }, [drainUploadQueue, setPendingUploads]);

  const confirmRemove = useCallback(async () => {
    const target = removeTarget;
    if (target === null) return;
    setRemovingId(target.id);
    try {
      const result = await removeProjectTodoAttachment({
        slug,
        todoId: todo.id,
        attachmentId: target.id,
        expectedRevision: revisionRef.current,
      });
      revisionRef.current = result.todo.revision;
      queryClient.setQueryData<ProjectTodo[]>(queryKeys.projectTodos(slug), (current) =>
        current?.map((candidate) => candidate.id === result.todo.id ? result.todo : candidate),
      );
      const attachmentQueryKey = queryKeys.projectTodoAttachments(slug, todo.id);
      const currentAttachments = queryClient.getQueryData<ProjectTodoAttachmentListResponse>(attachmentQueryKey);
      const known = new Map(currentAttachments?.attachments.map((candidate) => [candidate.id, candidate]));
      const ordered = result.todo.attachmentIds
        .map((id) => known.get(id))
        .filter((candidate): candidate is AttachmentDescriptor => candidate !== undefined);
      if (ordered.length === result.todo.attachmentIds.length) {
        queryClient.setQueryData<ProjectTodoAttachmentListResponse>(attachmentQueryKey, {
          todoRevision: result.todo.revision,
          attachments: ordered,
        });
      } else {
        void queryClient.invalidateQueries({ queryKey: attachmentQueryKey, exact: true, refetchType: "all" });
      }
      setRemoveTarget(null);
      setNotice(null);
    } catch (cause) {
      setNotice(messageFor(cause, "Could not remove this reference"));
      setRemoveTarget(null);
      await refreshRevision();
    } finally {
      setRemovingId(null);
    }
  }, [queryClient, refreshRevision, removeTarget, slug, todo.id]);

  const remoteAttachments = attachments.data?.attachments ?? [];
  const loadingList = attachments.isLoading && pendingUploads.length === 0;

  return (
    <section
      aria-labelledby="todo-references-heading"
      data-testid="todo-references"
      className={`border-y border-border-subtle py-4 transition-colors ${isDropActive ? "bg-brand-field" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="todo-references-heading" className="text-[13px] font-semibold text-text-primary">References</h2>
          <p id="todo-references-help" className="mt-1 max-w-[680px] text-[11px] leading-4 text-text-tertiary">
            Files stay in this project. Agent work can read current references; images may be sent to the selected model provider.
          </p>
        </div>
        <div className="shrink-0">
          <input
            ref={inputRef}
            type="file"
            multiple
            className="sr-only"
            aria-label="Choose files to add as Todo references"
            onChange={onInputChange}
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            aria-describedby="todo-references-help"
            className="inline-flex min-h-8 items-center gap-1.5 rounded-sm border border-brand/40 bg-brand-subtle px-2.5 text-[12px] font-medium text-brand hover:bg-brand/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand [@media(pointer:coarse)]:min-h-11"
          >
            <Plus size={13} aria-hidden="true" />
            Add files
          </button>
        </div>
      </div>

      {loadingList ? <p className="mt-3 text-[12px] text-text-tertiary">Loading references…</p> : null}
      {attachments.error ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-error" role="alert">
          <span>Could not load references: {messageFor(attachments.error, "Request failed")}</span>
          <button type="button" onClick={() => void attachments.refetch()} className="inline-flex min-h-8 items-center gap-1 rounded-sm border border-error/30 px-2 text-[11px] font-medium hover:bg-error-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error [@media(pointer:coarse)]:min-h-11">
            <RefreshCw size={12} aria-hidden="true" /> Retry
          </button>
        </div>
      ) : null}

      {remoteAttachments.length > 0 || pendingUploads.length > 0 ? (
        <ul className="mt-3 divide-y divide-border-subtle border-y border-border-subtle" aria-label="Todo references">
          {remoteAttachments.map((descriptor) => (
            <TodoReferenceRow
              key={descriptor.id}
              slug={slug}
              todoId={todo.id}
              descriptor={descriptor}
              removing={removingId === descriptor.id}
              onRemove={(descriptor) => setRemoveTarget(descriptor)}
            />
          ))}
          {pendingUploads.map((item) => (
            <PendingReferenceRow
              key={item.id}
              item={item}
              onRetry={() => retryUpload(item)}
              onDiscard={() => discardUpload(item.id)}
            />
          ))}
        </ul>
      ) : null}

      {notice ? <p className="mt-2 text-[11px] leading-4 text-warning" role="status">{notice}</p> : null}

      <DestructiveActionDialog
        open={removeTarget !== null}
        title="Remove Todo reference?"
        description="This removes the file from the Todo's current reference set."
        subject={removeTarget?.name ?? "Selected file"}
        confirmLabel="Remove"
        pendingLabel="Removing…"
        consequences={["The file becomes unavailable to all associated Sessions on their next model or tool call."]}
        note="Already-started model requests and tools are not changed."
        pending={removingId !== null}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => void confirmRemove()}
      />
    </section>
  );
}

function TodoReferenceRow({
  slug,
  todoId,
  descriptor,
  removing,
  onRemove,
}: {
  slug: string;
  todoId: string;
  descriptor: AttachmentDescriptor;
  removing: boolean;
  onRemove: (descriptor: AttachmentDescriptor) => void;
}) {
  const openInline = canOpenTodoAttachmentInline(descriptor);
  const href = todoAttachmentUrl(slug, todoId, descriptor.id);

  return (
    <li className="flex min-h-14 min-w-0 items-center gap-2 py-2">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center border border-border-subtle bg-bg-surface text-text-tertiary" aria-hidden="true">
        {descriptor.kind === "image" && openInline ? (
          <img src={href} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : descriptor.kind === "image" ? <FileImage size={16} /> : descriptor.mediaType === "application/pdf" ? <FileText size={16} /> : <FileIcon size={16} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium text-text-primary" title={descriptor.name}>
          {descriptor.name}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-text-tertiary">
          <span>{formatAttachmentSize(descriptor.sizeBytes)}</span>
          <span aria-hidden="true">·</span>
          <span>{removing ? "Removing…" : descriptor.mediaType}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {removing ? <LoaderCircle className="animate-activity text-text-tertiary" size={14} aria-label="Removing" /> : (
          <a
            href={href}
            target={openInline ? "_blank" : undefined}
            rel={openInline ? "noreferrer" : undefined}
            download={openInline ? undefined : descriptor.name}
            className="inline-flex min-h-8 items-center gap-1 rounded-sm px-2 text-[11px] font-medium text-brand hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand [@media(pointer:coarse)]:min-h-11"
            aria-label={`${openInline ? "Open" : "Download"} ${descriptor.name}`}
          >
            {openInline ? <FileText size={12} aria-hidden="true" /> : <Download size={12} aria-hidden="true" />}
            {openInline ? "Open" : "Download"}
          </a>
        )}
        <button
          type="button"
          onClick={() => onRemove(descriptor)}
          disabled={removing}
          aria-label={`Remove ${descriptor.name}`}
          className="inline-flex min-h-8 items-center justify-center rounded-sm px-2 text-[11px] font-medium text-text-tertiary hover:bg-error-muted hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error disabled:cursor-not-allowed disabled:opacity-40 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
        >
          <Trash2 size={13} aria-hidden="true" />
          <span className="sr-only">Remove</span>
        </button>
      </div>
    </li>
  );
}

function PendingReferenceRow({
  item,
  onRetry,
  onDiscard,
}: {
  item: PendingUpload;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const busy = item.status === "queued" || item.status === "uploading";
  return (
    <li className="flex min-h-14 min-w-0 items-center gap-2 py-2">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center border border-border-subtle bg-bg-surface text-text-tertiary" aria-hidden="true">
        <FileIcon size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium text-text-primary" title={item.file.name}>{item.file.name}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-text-tertiary">
          <span>{formatAttachmentSize(item.file.size)}</span>
          <span aria-hidden="true">·</span>
          <span>{item.status === "queued" ? "Waiting…" : item.status === "uploading" ? "Uploading…" : "Upload failed"}</span>
          {item.error ? <span role="alert" className="text-error">{item.error}</span> : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {busy ? <LoaderCircle className="animate-activity text-text-tertiary" size={14} aria-label="Uploading" /> : null}
        {item.status === "error" ? (
          <>
            <button type="button" onClick={onRetry} className="inline-flex min-h-8 items-center gap-1 rounded-sm px-2 text-[11px] font-medium text-brand hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand [@media(pointer:coarse)]:min-h-11"><RefreshCw size={12} aria-hidden="true" /> Retry</button>
            <button type="button" onClick={onDiscard} className="inline-flex min-h-8 items-center gap-1 rounded-sm px-2 text-[11px] font-medium text-text-tertiary hover:bg-error-muted hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error [@media(pointer:coarse)]:min-h-11"><Trash2 size={12} aria-hidden="true" /> Dismiss</button>
          </>
        ) : null}
      </div>
    </li>
  );
}
