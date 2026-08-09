import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, FilePlus, Loader2, Square, X } from "lucide-react";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_SIZE_BYTES,
  type AttachmentDescriptor,
  type RequestedModelSelection,
  type SessionFamilyActivity,
} from "@archcode/protocol";
import { ApiError } from "../../api/client";
import { uploadSessionAttachment, usePatchSessionModelSelection, usePostMessage, useStopSessionFamily } from "../../api/mutations";
import { useModelRuntime } from "../../api/queries";
import {
  getWebSessionStore,
  useSessionStore,
} from "../../store/session-store";
import { ModelPicker } from "./ModelPicker";
import { coherentModelRuntime } from "../../lib/model-runtime-coherence";
import { createClientUuid } from "../../lib/client-uuid";
import { sessionFamilyActivityLabel } from "../../lib/session-family-presentation";
import { getCompleteProjectSkillInventory, type ProjectSkillPickerItem } from "../../api/skills";
import type { StatusTone, VisualStatusKind } from "../../lib/status-visuals";
import { StatusGlyph } from "../primitives/StatusGlyph";
import { formatAttachmentSize } from "../primitives/AttachmentChip";

const SLASH_COMMANDS = [
  { name: "/compact", description: "Compact conversation context" },
  { name: "/skill use", description: "Activate a Skill" },
] as const;

type SlashCommand = (typeof SLASH_COMMANDS)[number];

type DraftAttachment = {
  id: string;
  file: File;
  status: "ready" | "uploading" | "uploaded" | "error";
  descriptor?: AttachmentDescriptor;
  error?: string;
  previewUrl?: string;
};

const UPLOAD_LIMIT_GUIDANCE = "Files are limited to 50 MiB. Compress or split it, or place it in the workspace and send its path.";
const SLASH_ATTACHMENT_GUIDANCE = "Slash commands can only be sent as plain text. Remove the attachment first.";

function isSlashInput(text: string): boolean {
  return text.trimStart().startsWith("/");
}

function uploadErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 413) return UPLOAD_LIMIT_GUIDANCE;
  return error instanceof Error ? error.message : "Upload failed. Retry from the beginning.";
}

function releasePreview(attachment: DraftAttachment): void {
  if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
}

export interface ChatInputProps {
  slug: string;
  sessionId: string;
  activity: SessionFamilyActivity | undefined;
  hitlReady: boolean;
  hasPendingHitl: boolean;
  focusOnReady?: boolean;
}

function composerStatus(
  activity: SessionFamilyActivity | undefined,
  hitlReady: boolean,
  hasPendingHitl: boolean,
): { label: string; kind: VisualStatusKind; tone?: StatusTone } {
  if (activity === undefined) return { label: "Connecting", kind: "running", tone: "neutral" };
  if (!hitlReady) return { label: "Syncing", kind: "running", tone: "info" };
  if (activity === "stopping") return { label: "Stopping", kind: "running", tone: "warning" };
  if (hasPendingHitl) return { label: "Needs you", kind: "needs_you" };
  if (activity === "running" || activity === "resuming") {
    return { label: sessionFamilyActivityLabel(activity), kind: "running" };
  }
  if (activity === "waiting_for_human") {
    return { label: sessionFamilyActivityLabel(activity), kind: "pending" };
  }
  return { label: "Ready", kind: "idle" };
}

export function ChatInput({
  slug,
  sessionId,
  activity,
  hitlReady,
  hasPendingHitl,
  focusOnReady = false,
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [skillInventory, setSkillInventory] = useState<ProjectSkillPickerItem[]>([]);
  const [skillInventoryState, setSkillInventoryState] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [hitlComposerExpanded, setHitlComposerExpanded] = useState(false);
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [attachmentNotice, setAttachmentNotice] = useState<string>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const focusOnReadyAppliedRef = useRef(false);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef<DraftAttachment[]>([]);
  const skillInventoryRequestRef = useRef(0);

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
  const postMessage = usePostMessage();
  const patchModelSelection = usePatchSessionModelSelection();
  const stopSession = useStopSessionFamily();

  const isPending = postMessage.isPending || patchModelSelection.isPending || stopSession.isPending;
  const isStopping = activity === "stopping";
  const isQueueing = activity !== undefined && activity !== "idle" && !isStopping;
  const runtimeReady = activity !== undefined;
  const modelControlsReady = coherentCatalog !== undefined && agentName !== null;
  const canCompose = runtimeReady && hitlReady && modelControlsReady && !isStopping && !isPending && nextModelSelection !== undefined;
  const hasAttachments = attachments.length > 0;
  const hasAttachmentError = attachments.some((attachment) => attachment.status === "error");
  const attachmentUploadInProgress = attachments.some((attachment) => attachment.status === "uploading");
  const canSubmit = canCompose
    && (value.trim().length > 0 || hasAttachments)
    && !hasAttachmentError
    && !attachmentUploadInProgress
    && !(hasAttachments && isSlashInput(value));
  const status = composerStatus(activity, hitlReady, hasPendingHitl);
  const skillUseInput = /^\/skill\s+use(?:\s+(.*))?$/i.exec(value);
  const selectingSkill = skillUseInput !== null;
  const skillQuery = skillUseInput?.[1]?.trim().toLowerCase() ?? "";
  const filteredSkills = skillUseInput === null ? [] : skillInventory.filter((skill) =>
    skill.name.toLowerCase().includes(skillQuery) || skill.description?.toLowerCase().includes(skillQuery),
  );
  const filteredCommands = (skillUseInput === null ? SLASH_COMMANDS : []).filter((command) =>
    command.name.replace(/\s/g, "").startsWith(`/ ${slashFilter}`.replace(/\s/g, "")),
  );
  const slashOptionCount = skillUseInput === null ? filteredCommands.length : filteredSkills.length;

  useEffect(() => {
    skillInventoryRequestRef.current += 1;
    setSkillInventory([]);
    setSkillInventoryState("idle");
  }, [sessionId, slug]);

  const loadSkillInventory = useCallback(() => {
    const request = ++skillInventoryRequestRef.current;
    setSkillInventoryState("loading");
    void getCompleteProjectSkillInventory(slug, sessionId).then((items) => {
      if (request !== skillInventoryRequestRef.current) return;
      setSkillInventory(items);
      setSkillInventoryState("ready");
    }).catch(() => {
      if (request === skillInventoryRequestRef.current) setSkillInventoryState("failed");
    });
  }, [sessionId, slug]);

  useEffect(() => {
    if (!selectingSkill || skillInventoryState !== "idle") return;
    loadSkillInventory();
  }, [loadSkillInventory, selectingSkill, skillInventoryState]);

  useEffect(() => {
    if (!selectingSkill && skillInventoryState === "failed") setSkillInventoryState("idle");
  }, [selectingSkill, skillInventoryState]);

  useEffect(() => {
    if (!selectingSkill || filteredSkills.length === 0) return;
    setSlashActiveIndex((current) => {
      const currentSkill = filteredSkills[current];
      if (currentSkill && skillIsSelectable(currentSkill)) return current;
      const firstSelectable = filteredSkills.findIndex(skillIsSelectable);
      return firstSelectable < 0 ? 0 : firstSelectable;
    });
  }, [selectingSkill, skillInventory, skillQuery]);

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
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => () => {
    for (const attachment of attachmentsRef.current) releasePreview(attachment);
  }, []);

  useEffect(() => {
    if (!hasPendingHitl) setHitlComposerExpanded(false);
  }, [hasPendingHitl]);

  useEffect(() => {
    if (!focusOnReady || !canCompose || focusOnReadyAppliedRef.current) return;
    focusOnReadyAppliedRef.current = true;
    textareaRef.current?.focus();
  }, [canCompose, focusOnReady]);

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

  const replaceAttachments = useCallback((next: DraftAttachment[]) => {
    const retained = new Set(next.map((attachment) => attachment.id));
    for (const attachment of attachmentsRef.current) {
      if (!retained.has(attachment.id)) releasePreview(attachment);
    }
    attachmentsRef.current = next;
    setAttachments(next);
  }, []);

  const updateAttachment = useCallback((id: string, update: (attachment: DraftAttachment) => DraftAttachment) => {
    const next = attachmentsRef.current.map((attachment) => attachment.id === id ? update(attachment) : attachment);
    attachmentsRef.current = next;
    setAttachments(next);
  }, []);

  const addFiles = useCallback((files: readonly File[]) => {
    if (files.length === 0) return;
    if (attachmentsRef.current.some((attachment) => attachment.status === "uploading")) return;
    if (attachmentsRef.current.length + files.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      setAttachmentNotice(`A message can include at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments.`);
      return;
    }
    const oversized = files.find((file) => file.size > MAX_ATTACHMENT_SIZE_BYTES);
    if (oversized) {
      setAttachmentNotice(`${oversized.name}: ${UPLOAD_LIMIT_GUIDANCE}`);
      return;
    }
    const added = files.map((file) => ({
      id: createClientUuid(),
      file,
      status: "ready" as const,
      previewUrl: file.type.startsWith("image/") && typeof URL.createObjectURL === "function"
        ? URL.createObjectURL(file)
        : undefined,
    }));
    setAttachmentNotice(undefined);
    replaceAttachments([...attachmentsRef.current, ...added]);
  }, [replaceAttachments]);

  const uploadAttachment = useCallback(async (attachment: DraftAttachment): Promise<AttachmentDescriptor | undefined> => {
    updateAttachment(attachment.id, (current) => ({ ...current, status: "uploading", error: undefined }));
    try {
      const descriptor = await uploadSessionAttachment({
        slug,
        sessionId,
        attachmentId: attachment.id,
        file: attachment.file,
      });
      updateAttachment(attachment.id, (current) => ({ ...current, status: "uploaded", descriptor, error: undefined }));
      return descriptor;
    } catch (error) {
      const message = uploadErrorMessage(error);
      updateAttachment(attachment.id, (current) => ({ ...current, status: "error", error: message }));
      setAttachmentNotice(message);
      return undefined;
    }
  }, [sessionId, slug, updateAttachment]);

  const submitMessage = useCallback((content: string, descriptors: AttachmentDescriptor[], requestedModelSelection: RequestedModelSelection) => {
    const clientRequestId = createClientUuid();
    getWebSessionStore(sessionId, slug).getState().addLocalSendingMessage({
      clientRequestId,
      content,
      attachments: descriptors,
      requestedModelSelection,
    });

    postMessage.mutate(
      { slug, sessionId, content, attachmentIds: descriptors.map((attachment) => attachment.id), clientRequestId, requestedModelSelection },
      {
        onSuccess: (acceptance) => {
          replaceAttachments([]);
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
          replaceAttachments([]);
        },
      },
    );
    setValue("");

    requestAnimationFrame(() => {
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    });
  }, [postMessage, replaceAttachments, sessionId, slug]);

  const sendMessage = useCallback(async () => {
    const content = value.trim();
    if ((!content && !hasAttachments) || !canCompose || !nextModelSelection) return;
    if (hasAttachments && isSlashInput(content)) {
      setAttachmentNotice(SLASH_ATTACHMENT_GUIDANCE);
      return;
    }

    const descriptors: AttachmentDescriptor[] = [];
    for (const attachment of attachmentsRef.current) {
      if (attachment.status === "uploaded" && attachment.descriptor) {
        descriptors.push(attachment.descriptor);
        continue;
      }
      if (attachment.status !== "ready") return;
      const descriptor = await uploadAttachment(attachment);
      if (!descriptor) return;
      descriptors.push(descriptor);
    }
    submitMessage(content, descriptors, nextModelSelection.requested);
  }, [canCompose, hasAttachments, nextModelSelection, submitMessage, uploadAttachment, value]);

  const selectSlashCommand = useCallback((command: SlashCommand) => {
    if (!canCompose || isQueueing || hasPendingHitl) return;
    if (!nextModelSelection) return;
    if (command.name === "/skill use") {
      setValue("/skill use ");
      setSlashFilter("skill use ");
      setSlashActiveIndex(0);
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    if (attachmentsRef.current.length > 0) {
      setAttachmentNotice(SLASH_ATTACHMENT_GUIDANCE);
      return;
    }
    submitMessage(command.name, [], nextModelSelection.requested);
    setShowSlashMenu(false);
    setSlashFilter("");
    setSlashActiveIndex(0);
    textareaRef.current?.focus();
  }, [canCompose, hasPendingHitl, isQueueing, nextModelSelection, submitMessage]);

  const selectSkill = useCallback((skill: ProjectSkillPickerItem) => {
    if (!skill.valid || skill.shadowed || !skill.winner || !canCompose || isQueueing || hasPendingHitl || !nextModelSelection) return;
    if (attachmentsRef.current.length > 0) {
      setAttachmentNotice(SLASH_ATTACHMENT_GUIDANCE);
      return;
    }
    submitMessage(`/skill use ${skill.name}`, [], nextModelSelection.requested);
    setShowSlashMenu(false);
    setSlashFilter("");
    setSlashActiveIndex(0);
    textareaRef.current?.focus();
  }, [canCompose, hasPendingHitl, isQueueing, nextModelSelection, submitMessage]);

  const selectModel = useCallback((requestedModelSelection: RequestedModelSelection) => {
    patchModelSelection.mutate({
      slug,
      sessionId,
      expectedRevision: modelSelection.revision,
      requestedModelSelection,
    }, {
      onSuccess: (state) => {
        getWebSessionStore(sessionId, slug).getState().applyModelStatePatch(state);
      },
    });
  }, [modelSelection.revision, patchModelSelection, sessionId, slug]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSlashMenu && slashOptionCount > 0) {
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashActiveIndex((index) => nextSlashIndex(index, -1, slashOptionCount, filteredSkills, selectingSkill));
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashActiveIndex((index) => nextSlashIndex(index, 1, slashOptionCount, filteredSkills, selectingSkill));
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.nativeEvent.isComposing) {
        const selectedSkill = skillUseInput === null ? undefined : filteredSkills[slashActiveIndex];
        if (selectedSkill !== undefined && !skillIsSelectable(selectedSkill)) {
          if (event.key === "Enter") event.preventDefault();
          else setShowSlashMenu(false);
          return;
        }
        event.preventDefault();
        if (selectedSkill !== undefined) selectSkill(selectedSkill);
        else selectSlashCommand(filteredCommands[slashActiveIndex]);
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

    if (event.key === "Escape" && isQueueing && !stopSession.isPending) {
      event.preventDefault();
      stopSession.mutate({ slug, rootSessionId: sessionId });
    }
  }, [
    filteredCommands,
    filteredSkills,
    isQueueing,
    selectSlashCommand,
    selectSkill,
    sendMessage,
    sessionId,
    showSlashMenu,
    slashActiveIndex,
    slashOptionCount,
    skillUseInput,
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

  const removeAttachment = useCallback((id: string) => {
    replaceAttachments(attachmentsRef.current.filter((attachment) => attachment.id !== id));
  }, [replaceAttachments]);

  const moveAttachment = useCallback((id: string, direction: -1 | 1) => {
    const index = attachmentsRef.current.findIndex((attachment) => attachment.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= attachmentsRef.current.length) return;
    const next = [...attachmentsRef.current];
    [next[index], next[target]] = [next[target], next[index]];
    replaceAttachments(next);
  }, [replaceAttachments]);

  const handleFileSelection = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(event.target.files ?? []));
    // Permit retrying the same file after removal or an upload error.
    event.target.value = "";
  }, [addFiles]);

  const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const entries = Array.from(event.dataTransfer.items).map((item) => (
      (item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.()
    ));
    if (entries.some((entry) => entry?.isDirectory)) {
      setAttachmentNotice("Folders are not supported. Choose files instead.");
      return;
    }
    addFiles(Array.from(event.dataTransfer.files));
  }, [addFiles]);

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) return;
    event.preventDefault();
    addFiles(images);
  }, [addFiles]);

  if (hasPendingHitl && !hitlComposerExpanded) {
    return (
      <div className="relative" data-testid="conversation-composer">
        <div
          className="flex min-h-10 min-w-0 items-center gap-2 rounded-sm border border-border-subtle bg-bg-elevated px-1.5"
          data-density="collapsed"
          data-testid="composer-card"
        >
          <button
            type="button"
            className="flex min-h-9 min-w-0 flex-1 items-center justify-between gap-3 rounded-sm px-2 text-left text-[12px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            data-testid="hitl-queue-composer-trigger"
            aria-expanded="false"
            onClick={() => setHitlComposerExpanded(true)}
          >
            <span>Queue another instruction…</span>
            <span className="hidden items-center gap-1.5 whitespace-nowrap text-[11px] text-text-tertiary sm:flex" aria-live="polite">
              <StatusGlyph kind={status.kind} tone={status.tone} size={11} />
              {status.label}
            </span>
          </button>
          {isQueueing && (
            <button
              type="button"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-text-primary text-bg-base transition-colors duration-[var(--motion-hover)] hover:bg-error hover:text-bg-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:bg-bg-active disabled:text-text-muted"
              disabled={stopSession.isPending}
              onClick={() => stopSession.mutate({ slug, rootSessionId: sessionId })}
              title="Stop"
              aria-label="Stop session"
            >
              {stopSession.isPending
                ? <Loader2 size={14} className="animate-activity" />
                : <Square size={11} fill="currentColor" />}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="relative" data-testid="conversation-composer">
      {showSlashMenu && canCompose && !isQueueing && !hasPendingHitl && (slashOptionCount > 0 || skillUseInput !== null) && (
        <div
          ref={slashMenuRef}
          id="composer-slash-menu"
          role={skillUseInput !== null && skillInventoryState === "failed" ? "group" : "listbox"}
          aria-label={skillUseInput === null ? "Slash commands" : "Skills"}
          className="absolute bottom-[calc(100%+8px)] left-0 right-0 z-20 max-h-[200px] overflow-y-auto rounded-lg border border-border-default bg-bg-overlay p-1 shadow-md"
          data-testid="composer-slash-menu"
        >
          {skillUseInput !== null && skillInventoryState === "loading" && <p role="status" className="px-3 py-2 text-[12px] text-text-tertiary">Loading Skills…</p>}
          {skillUseInput !== null && skillInventoryState === "failed" && <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <p role="alert" className="text-[12px] text-error">Unable to load Skills.</p>
            <button type="button" className="min-h-8 rounded-sm bg-bg-active px-3 text-[12px] font-medium text-text-secondary hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand [@media(pointer:coarse)]:min-h-11" onClick={loadSkillInventory}>Retry</button>
          </div>}
          {skillUseInput !== null && skillInventoryState === "ready" && filteredSkills.length === 0 && <p role="status" className="px-3 py-2 text-[12px] text-text-tertiary">No matching Skills.</p>}
          {(skillUseInput === null ? filteredCommands : filteredSkills).map((entry, index) => {
            const skill = skillUseInput === null ? undefined : entry as ProjectSkillPickerItem;
            const command = skillUseInput === null ? entry as SlashCommand : undefined;
            const unavailable = skill !== undefined && !skillIsSelectable(skill);
            const id = `composer-slash-option-${index}`;
            return (
            <button
              type="button"
              id={id}
              role="option"
              aria-selected={index === slashActiveIndex}
              disabled={unavailable}
              key={skill ? `${skill.source}:${skill.name}:${index}` : command!.name}
              className={`flex min-w-0 w-full flex-wrap items-start gap-x-2 gap-y-1 rounded-sm px-3 py-2 text-left text-[13px] transition-colors duration-[var(--motion-hover)] [@media(pointer:coarse)]:min-h-11 ${
                index === slashActiveIndex ? "bg-bg-hover" : "hover:bg-bg-hover"
              } disabled:cursor-not-allowed disabled:opacity-50`}
              onClick={() => skill ? selectSkill(skill) : selectSlashCommand(command!)}
              onMouseEnter={() => setSlashActiveIndex(index)}
            >
              <span className="min-w-0 max-w-full break-all font-mono text-brand">{skill?.name ?? command!.name}</span>
              <span className="min-w-[12rem] flex-1 break-words text-[12px] leading-4 text-text-tertiary">
                {skill ? skill.description : command!.description}
                {skill?.diagnostic && <span className="block break-words text-error">{skill.diagnostic.message}</span>}
              </span>
              {skill && <span className="break-all text-[10px] text-text-tertiary">{skill.source}</span>}
              {skill?.winner && <span className="text-[10px] text-text-secondary">Winner</span>}
              {skill?.shadowed && <span className="text-[10px] text-text-tertiary">Shadowed</span>}
              {skill?.valid && <span className="text-[10px] text-success">Valid</span>}
              {skill && !skill.valid && <span className="text-[10px] text-error">Invalid</span>}
              {skill?.promptOmitted && <span className="text-[10px] text-warning">Prompt omitted</span>}
            </button>
          );})}
        </div>
      )}

      <div
        className="overflow-visible rounded-xl border border-border-control bg-bg-elevated shadow-sm transition-[border-color,box-shadow] duration-[var(--motion-hover)] focus-within:border-brand focus-within:ring-2 focus-within:ring-brand"
        data-testid="composer-card"
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
      >
        {attachments.length > 0 && (
          <ul className="mx-3 mt-3 flex max-h-40 flex-col gap-1 overflow-y-auto" aria-label="Message attachments" data-testid="composer-attachments">
            {attachments.map((attachment, index) => (
              <li key={attachment.id} className="flex min-w-0 items-center gap-2 rounded-sm border border-border-subtle bg-bg-base px-2 py-1.5">
                {attachment.previewUrl && (
                  <img src={attachment.previewUrl} alt="" className="h-8 w-8 shrink-0 rounded-sm object-cover" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] text-text-primary">{attachment.file.name}</span>
                  <span className="block text-[11px] text-text-tertiary">{formatAttachmentSize(attachment.file.size)} · {attachment.status}</span>
                  {attachment.error && <span className="block text-[11px] text-error" role="alert">{attachment.error}</span>}
                </span>
                <div className="flex shrink-0 items-center gap-1">
                  {attachment.status === "error" && (
                    <button className="rounded-sm px-1.5 py-1 text-[11px] text-brand hover:bg-bg-hover" disabled={attachmentUploadInProgress} type="button" onClick={() => void uploadAttachment(attachment)}>Retry</button>
                  )}
                  <button aria-label={`Move ${attachment.file.name} earlier`} className="rounded-sm px-1 py-1 text-[11px] text-text-tertiary hover:bg-bg-hover disabled:opacity-30" disabled={index === 0 || attachmentUploadInProgress} type="button" onClick={() => moveAttachment(attachment.id, -1)}>↑</button>
                  <button aria-label={`Move ${attachment.file.name} later`} className="rounded-sm px-1 py-1 text-[11px] text-text-tertiary hover:bg-bg-hover disabled:opacity-30" disabled={index === attachments.length - 1 || attachmentUploadInProgress} type="button" onClick={() => moveAttachment(attachment.id, 1)}>↓</button>
                  <button aria-label={`Remove ${attachment.file.name}`} className="rounded-sm p-1 text-text-tertiary hover:bg-bg-hover hover:text-error disabled:opacity-30" disabled={attachmentUploadInProgress} type="button" onClick={() => removeAttachment(attachment.id)}><X size={13} /></button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          aria-label="Message"
          aria-autocomplete="list"
          aria-controls={showSlashMenu ? "composer-slash-menu" : undefined}
          aria-expanded={showSlashMenu}
          aria-activedescendant={showSlashMenu && slashOptionCount > 0 ? `composer-slash-option-${slashActiveIndex}` : undefined}
          disabled={!canCompose}
          placeholder={
            !runtimeReady
              ? "Connecting to runtime…"
              : !hitlReady
                ? "Syncing pending requests…"
                : !modelControlsReady
                  ? "Refreshing model configuration…"
                : hasPendingHitl || isQueueing
                  ? "Queue a message…"
                  : isStopping
                    ? "Stopping…"
                    : "Send a message…"
          }
          rows={1}
          className="block min-h-[56px] max-h-[200px] w-full resize-none overflow-y-auto border-0 bg-transparent px-4 pb-2 pt-3.5 font-sans text-[16px] leading-6 text-text-primary outline-none placeholder:text-text-tertiary disabled:cursor-not-allowed disabled:text-text-tertiary sm:text-[15px] sm:leading-6"
        />

        {attachmentNotice && <p className="mx-3 mt-1 text-[11px] leading-4 text-warning" role="alert">{attachmentNotice}</p>}

        <div className="flex min-h-[38px] items-center justify-between gap-3 px-3 pb-2" data-testid="composer-toolbar">
          <div className="flex shrink-0 items-center gap-2 text-[11px] text-text-tertiary" data-testid="composer-left-controls">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="sr-only"
              data-testid="composer-file-input"
              onChange={handleFileSelection}
            />
            <button
              type="button"
              className="flex h-8 w-8 items-center justify-center rounded-sm text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!canCompose || attachmentUploadInProgress}
              onClick={() => fileInputRef.current?.click()}
              title="Attach file"
              aria-label="Attach file"
            >
              <FilePlus size={16} />
            </button>
            <span className="flex shrink-0 items-center gap-2 max-[520px]:gap-0" aria-live="polite">
              <StatusGlyph kind={status.kind} tone={status.tone} size={11} />
              <span className="max-[520px]:sr-only">{status.label}</span>
            </span>
            {hasPendingHitl && (
              <button
                type="button"
                className="shrink-0 rounded-sm px-1.5 py-1 text-[11px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                aria-label="Collapse queued-message composer"
                onClick={() => setHitlComposerExpanded(false)}
              >
                Hide
              </button>
            )}
          </div>

          <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
            <div className="min-w-0 text-[11px] text-text-tertiary" data-testid="composer-model">
              {coherentCatalog && nextModelSelection && agentName ? <ModelPicker
                catalog={coherentCatalog}
                next={nextModelSelection}
                active={activeModelBinding}
                onSelect={selectModel}
                disabled={patchModelSelection.isPending}
              /> : <span className="block max-w-[180px] truncate">Loading model…</span>}
            </div>
            <span className="mr-1 text-[11px] text-text-tertiary max-[720px]:hidden">
              {isQueueing ? "Enter to queue" : "Shift+Enter for newline"}
            </span>
            {isQueueing && (
              <button
                type="button"
                className="flex h-8 w-8 items-center justify-center rounded-sm bg-text-primary text-bg-base transition-colors duration-[var(--motion-hover)] hover:bg-brand-hover hover:text-bg-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:bg-bg-active disabled:text-text-muted"
                disabled={!canSubmit}
                onClick={sendMessage}
                title="Queue message"
                aria-label="Queue message"
              >
                {postMessage.isPending
                  ? <Loader2 size={14} className="animate-activity" />
                  : <ArrowUp size={16} strokeWidth={2} />}
              </button>
            )}
            <button
              type="button"
              className={`flex h-8 w-8 items-center justify-center rounded-sm transition-colors duration-[var(--motion-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:bg-bg-active disabled:text-text-muted ${isQueueing
                ? "bg-text-primary text-bg-base hover:bg-error hover:text-bg-overlay"
                : "bg-text-primary text-bg-base hover:bg-brand-hover hover:text-bg-overlay"
              }`}
              disabled={isQueueing ? stopSession.isPending : isStopping || !canSubmit}
              onClick={isQueueing
                ? () => stopSession.mutate({ slug, rootSessionId: sessionId })
                : sendMessage}
              title={isQueueing ? "Stop" : isStopping ? "Stopping" : hasPendingHitl ? "Queue message" : "Send message"}
              aria-label={isQueueing ? "Stop session" : isStopping ? "Session stopping" : hasPendingHitl ? "Queue message" : "Send message"}
            >
              {isQueueing
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

function skillIsSelectable(skill: ProjectSkillPickerItem): boolean {
  return skill.valid && skill.winner && !skill.shadowed;
}

function nextSlashIndex(
  current: number,
  direction: -1 | 1,
  count: number,
  skills: readonly ProjectSkillPickerItem[],
  selectingSkill: boolean,
): number {
  if (!selectingSkill) return (current + direction + count) % count;
  for (let offset = 1; offset <= count; offset += 1) {
    const candidate = (current + direction * offset + count * 2) % count;
    const skill = skills[candidate];
    if (skill !== undefined && skillIsSelectable(skill)) return candidate;
  }
  return current;
}
