import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  AUTOMATION_MESSAGE_MAX_LENGTH,
  AUTOMATION_NAME_MAX_LENGTH,
  AUTOMATION_TIMEZONE_MAX_LENGTH,
  MIN_AUTOMATION_INTERVAL_MS,
} from "@archcode/protocol";
import { X } from "lucide-react";

import { useCreateAutomation, useDeleteAutomation, useUpdateAutomation } from "../../api/mutations";
import type {
  Automation,
  AutomationAction,
  AutomationTrigger,
  UpdateAutomationPayload,
} from "../../api/types";
import { formatAutomationTrigger } from "../../lib/automation-trigger-presentation";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../ui/Dialog";

type IntervalUnit = "seconds" | "minutes" | "hours";

const INTERVAL_UNIT_MS: Record<IntervalUnit, number> = {
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
};

const INPUT_CLASS =
  "w-full rounded-[6px] border border-border-control bg-bg-base px-2.5 text-[12.5px] text-text-primary placeholder:text-text-muted transition-colors duration-[var(--motion-hover)] hover:border-text-secondary focus:border-brand focus:outline-none focus:[box-shadow:0_0_0_3px_color-mix(in_srgb,var(--brand)_18%,transparent)] disabled:cursor-not-allowed disabled:opacity-50";

export function intervalToMilliseconds(value: number, unit: IntervalUnit): number {
  return value * INTERVAL_UNIT_MS[unit];
}

export function intervalFromMilliseconds(everyMs: number): { value: number; unit: IntervalUnit } {
  if (everyMs % INTERVAL_UNIT_MS.hours === 0) {
    return { value: everyMs / INTERVAL_UNIT_MS.hours, unit: "hours" };
  }
  if (everyMs % INTERVAL_UNIT_MS.minutes === 0) {
    return { value: everyMs / INTERVAL_UNIT_MS.minutes, unit: "minutes" };
  }
  return { value: everyMs / INTERVAL_UNIT_MS.seconds, unit: "seconds" };
}

export function isoToLocalDateTimeInput(value: string): string {
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

interface EditAutomationDialogProps {
  open: boolean;
  onClose: () => void;
  slug: string;
  automation?: Automation;
  lifecyclePending?: boolean;
  onDeleted?: () => void;
  onPause?: () => void;
  onResume?: () => void;
}

export function EditAutomationDialog({
  open,
  onClose,
  slug,
  automation,
  lifecyclePending = false,
  onDeleted,
  onPause,
  onResume,
}: EditAutomationDialogProps) {
  const update = useUpdateAutomation();
  const create = useCreateAutomation();
  const remove = useDeleteAutomation();
  const initial = useMemo(() => {
    const interval = automation?.trigger.kind === "interval"
      ? intervalFromMilliseconds(automation.trigger.everyMs)
      : { value: 1, unit: "minutes" as const };
    return {
      name: automation?.name ?? "",
      triggerKind: automation?.trigger.kind ?? "interval" as const,
      onceAt: automation?.trigger.kind === "once" ? isoToLocalDateTimeInput(automation.trigger.at) : "",
      intervalValue: interval.value,
      intervalUnit: interval.unit,
      cron: automation?.trigger.kind === "cron" ? automation.trigger.expression : "*/15 * * * *",
      timezone: automation?.trigger.kind === "cron"
        ? automation.trigger.timezone
        : Intl.DateTimeFormat().resolvedOptions().timeZone,
      actionKind: automation?.action.kind ?? "start_session" as const,
      message: automation?.action.message ?? "",
      sessionId: automation?.action.kind === "send_message" ? automation.action.sessionId : "",
      location: automation?.action.kind === "start_session" ? automation.action.location : "project" as const,
    };
  // Snapshot the server value when the dialog opens. Realtime inventory
  // refreshes for the same Automation must not overwrite an in-progress edit.
  }, [open, automation?.id]);
  const [name, setName] = useState("");
  const [triggerKind, setTriggerKind] = useState<AutomationTrigger["kind"]>("interval");
  const [onceAt, setOnceAt] = useState("");
  const [intervalValue, setIntervalValue] = useState(1);
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>("minutes");
  const [cron, setCron] = useState("*/15 * * * *");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [actionKind, setActionKind] = useState<AutomationAction["kind"]>("start_session");
  const [message, setMessage] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [location, setLocation] = useState<"project" | "worktree">("project");
  const [confirmation, setConfirmation] = useState<"discard" | "delete" | null>(null);
  const confirmationCancelRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const confirmationReturnRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(initial.name);
    setTriggerKind(initial.triggerKind);
    setOnceAt(initial.onceAt);
    setIntervalValue(initial.intervalValue);
    setIntervalUnit(initial.intervalUnit);
    setCron(initial.cron);
    setTimezone(initial.timezone);
    setActionKind(initial.actionKind);
    setMessage(initial.message);
    setSessionId(initial.sessionId);
    setLocation(initial.location);
    setConfirmation(null);
  }, [initial, open]);

  const pending = update.isPending || create.isPending || remove.isPending || lifecyclePending;
  const error = update.error ?? create.error;
  const dirty = name !== initial.name
    || triggerKind !== initial.triggerKind
    || onceAt !== initial.onceAt
    || intervalValue !== initial.intervalValue
    || intervalUnit !== initial.intervalUnit
    || cron !== initial.cron
    || timezone !== initial.timezone
    || actionKind !== initial.actionKind
    || message !== initial.message
    || sessionId !== initial.sessionId
    || location !== initial.location;
  const returnFromConfirmation = () => {
    const target = confirmation === "delete" ? deleteButtonRef.current : confirmationReturnRef.current;
    setConfirmation(null);
    window.requestAnimationFrame(() => target?.focus());
  };
  const openConfirmation = (kind: "discard" | "delete", trigger?: HTMLElement | null) => {
    if (pending) return;
    if (kind === "delete") remove.reset();
    confirmationReturnRef.current = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setConfirmation(kind);
  };
  const requestClose = (trigger?: HTMLElement | null) => {
    if (pending) return;
    if (confirmation !== null) {
      returnFromConfirmation();
      return;
    }
    if (dirty) {
      openConfirmation("discard", trigger);
      return;
    }
    onClose();
  };
  const everyMs = intervalToMilliseconds(intervalValue, intervalUnit);
  const valid = name.trim().length > 0
    && name.trim().length <= AUTOMATION_NAME_MAX_LENGTH
    && message.trim().length > 0
    && message.trim().length <= AUTOMATION_MESSAGE_MAX_LENGTH
    && (triggerKind !== "once" || Number.isFinite(new Date(onceAt).getTime()))
    && (triggerKind !== "interval" || Number.isInteger(everyMs) && everyMs >= MIN_AUTOMATION_INTERVAL_MS)
    && (triggerKind !== "cron" || cron.trim().split(/\s+/).length === 5
      && timezone.trim().length > 0
      && timezone.trim().length <= AUTOMATION_TIMEZONE_MAX_LENGTH)
    && (actionKind !== "send_message" || sessionId.trim().length > 0);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid || pending) return;

    const trigger: AutomationTrigger = triggerKind === "once"
      ? { kind: "once", at: new Date(onceAt).toISOString() }
      : triggerKind === "interval"
        ? { kind: "interval", everyMs }
        : { kind: "cron", expression: cron.trim(), timezone: timezone.trim() };
    const action: AutomationAction = actionKind === "start_session"
      ? { kind: "start_session", message: message.trim(), location }
      : { kind: "send_message", message: message.trim(), sessionId: sessionId.trim() };
    const payload: Required<UpdateAutomationPayload> = { name: name.trim(), trigger, action };
    if (automation) update.mutate({ slug, automationId: automation.id, ...payload }, { onSuccess: onClose });
    else create.mutate({ slug, ...payload }, { onSuccess: onClose });
  };

  const errorMessage = error
    ? error instanceof Error
      ? error.message
      : "Automation request failed"
    : null;
  const deleteErrorMessage = remove.error
    ? remove.error instanceof Error
      ? remove.error.message
      : "Failed to delete Automation"
    : null;

  useEffect(() => {
    if (confirmation === null) return;
    const frame = window.requestAnimationFrame(() => confirmationCancelRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [confirmation]);

  const confirmDelete = () => {
    if (!automation || remove.isPending) return;
    remove.mutate(
      { slug, automationId: automation.id },
      { onSuccess: () => {
        setConfirmation(null);
        onClose();
        onDeleted?.();
      } },
    );
  };

  return (
    <DialogRoot open={open} onOpenChange={(next) => { if (!next) requestClose(); }}>
      <DialogContent size="large" className="!w-[min(840px,calc(100vw-36px))] !rounded-[12px] overflow-hidden p-0">
        <form onSubmit={submit} className="relative flex max-h-[calc(100vh-32px)] flex-col">
          <div aria-hidden={confirmation !== null ? true : undefined} inert={confirmation !== null ? true : undefined} className="contents">
          <header className="flex shrink-0 items-start gap-3 border-b border-border-subtle px-[18px] py-4">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-brand/30 bg-brand-subtle text-brand">
              <svg aria-hidden="true" fill="none" height="17" viewBox="0 0 24 24" width="17">
                <path d="M3 5h6v6H3zM15 13h6v6h-6zM9 8h3a3 3 0 0 1 3 3v2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-[15px] font-[650] tracking-[-0.01em] text-text-primary">
                {automation ? "Edit Automation" : "New Automation"}
              </DialogTitle>
              <DialogDescription className="mt-1 text-[12px] leading-[1.45] text-text-tertiary">
                Schedule an ordinary Session message. The Session keeps its existing tools and permissions.
              </DialogDescription>
            </div>
            <button
              type="button"
              onClick={(event) => requestClose(event.currentTarget)}
              disabled={pending}
              aria-label="Close"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
            >
              <X size={15} aria-hidden="true" />
            </button>
          </header>

          <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto min-[761px]:grid-cols-2 min-[761px]:overflow-hidden">
            <div className="space-y-[18px] border-b border-border-subtle px-[18px] pb-[18px] pt-4 min-[761px]:overflow-y-auto min-[761px]:border-b-0">
              <div>
                <FieldLabel htmlFor="automation-name">Name</FieldLabel>
                <input
                  id="automation-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. Daily project health check"
                  maxLength={AUTOMATION_NAME_MAX_LENGTH}
                  autoFocus
                  disabled={pending}
                  className={`${INPUT_CLASS} h-[34px]`}
                />
              </div>

              <FormSection
                title="Schedule"
                description="Choose when this message should be dispatched. Missed occurrences are not replayed."
              >
                <div className="grid grid-cols-1 gap-2 min-[761px]:grid-cols-3">
                  <ChoiceCard
                    checked={triggerKind === "once"}
                    description="A specific time"
                    disabled={pending}
                    id="automation-trigger-once"
                    label="Once"
                    name="automation-trigger"
                    onChange={() => setTriggerKind("once")}
                  />
                  <ChoiceCard
                    checked={triggerKind === "interval"}
                    description="Fixed cadence"
                    disabled={pending}
                    id="automation-trigger-interval"
                    label="Every"
                    name="automation-trigger"
                    onChange={() => setTriggerKind("interval")}
                  />
                  <ChoiceCard
                    checked={triggerKind === "cron"}
                    description="Cron schedule"
                    disabled={pending}
                    id="automation-trigger-cron"
                    label="Cron"
                    name="automation-trigger"
                    onChange={() => setTriggerKind("cron")}
                  />
                </div>

                <div className="mt-2.5 rounded-lg border border-border-subtle bg-bg-elevated p-3">
                  {triggerKind === "once" && (
                    <div>
                      <FieldLabel htmlFor="automation-once-at">Run at</FieldLabel>
                      <input
                        id="automation-once-at"
                        type="datetime-local"
                        value={onceAt}
                        onChange={(event) => setOnceAt(event.target.value)}
                        disabled={pending}
                        className={`${INPUT_CLASS} h-[34px]`}
                      />
                      <FieldHint>Uses your current local time.</FieldHint>
                    </div>
                  )}
                  {triggerKind === "interval" && (
                    <div>
                      <FieldLabel htmlFor="automation-interval-value">Repeat every</FieldLabel>
                      <div className="grid grid-cols-1 gap-2 min-[761px]:grid-cols-[minmax(0,1fr)_132px]">
                        <input
                          id="automation-interval-value"
                          type="number"
                          min={1}
                          step={1}
                          value={intervalValue}
                          onChange={(event) => setIntervalValue(Number(event.target.value))}
                          disabled={pending}
                          className={`${INPUT_CLASS} h-[34px]`}
                        />
                        <select
                          aria-label="Interval unit"
                          value={intervalUnit}
                          onChange={(event) => setIntervalUnit(event.target.value as IntervalUnit)}
                          disabled={pending}
                          className={`${INPUT_CLASS} h-[34px]`}
                        >
                          <option value="seconds">Seconds</option>
                          <option value="minutes">Minutes</option>
                          <option value="hours">Hours</option>
                        </select>
                      </div>
                      <FieldHint>Minimum interval: 30 seconds.</FieldHint>
                    </div>
                  )}
                  {triggerKind === "cron" && (
                    <div className="grid grid-cols-1 gap-2 min-[761px]:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
                      <div>
                        <FieldLabel htmlFor="automation-cron">Expression</FieldLabel>
                        <input
                          id="automation-cron"
                          value={cron}
                          onChange={(event) => setCron(event.target.value)}
                          placeholder="*/15 * * * *"
                          disabled={pending}
                          className={`${INPUT_CLASS} h-[34px] font-mono`}
                        />
                      </div>
                      <div>
                        <FieldLabel htmlFor="automation-timezone">Timezone</FieldLabel>
                        <input
                          id="automation-timezone"
                          value={timezone}
                          onChange={(event) => setTimezone(event.target.value)}
                          placeholder="Asia/Shanghai"
                          maxLength={AUTOMATION_TIMEZONE_MAX_LENGTH}
                          disabled={pending}
                          className={`${INPUT_CLASS} h-[34px]`}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </FormSection>
            </div>

            <div className="space-y-[18px] px-[18px] pb-[18px] pt-4 min-[761px]:border-l min-[761px]:border-border-subtle min-[761px]:overflow-y-auto">
              <FormSection
                title="Action"
                description="Start fresh work or continue a Session that already has context."
              >
                <div className="grid grid-cols-1 gap-2 min-[761px]:grid-cols-2">
                  <ChoiceCard
                    checked={actionKind === "start_session"}
                    description="Create a new Lead Session"
                    disabled={pending}
                    id="automation-action-start"
                    label="New Session"
                    name="automation-action"
                    onChange={() => setActionKind("start_session")}
                  />
                  <ChoiceCard
                    checked={actionKind === "send_message"}
                    description="Continue existing context"
                    disabled={pending}
                    id="automation-action-send"
                    label="Existing Session"
                    name="automation-action"
                    onChange={() => setActionKind("send_message")}
                  />
                </div>

                <div className="mt-2.5 rounded-lg border border-border-subtle bg-bg-elevated p-3">
                  {actionKind === "start_session" ? (
                    <fieldset>
                      <legend className="mb-2 text-[12px] font-medium text-text-secondary">Run location</legend>
                      <div className="grid grid-cols-1 gap-2 min-[761px]:grid-cols-2">
                        <CompactChoice
                          checked={location === "project"}
                          description="Use the current checkout"
                          disabled={pending}
                          id="automation-location-project"
                          label="Project"
                          name="automation-location"
                          onChange={() => setLocation("project")}
                        />
                        <CompactChoice
                          checked={location === "worktree"}
                          description="Create an isolated checkout"
                          disabled={pending}
                          id="automation-location-worktree"
                          label="Worktree"
                          name="automation-location"
                          onChange={() => setLocation("worktree")}
                        />
                      </div>
                      <p className="mt-2 text-[11px] leading-[1.4] text-text-tertiary">Binding: Lead + principal. Every run starts a root Session with the principal profile.</p>
                    </fieldset>
                  ) : (
                    <div>
                      <FieldLabel htmlFor="automation-session-id">Session ID</FieldLabel>
                      <input
                        id="automation-session-id"
                        value={sessionId}
                        onChange={(event) => setSessionId(event.target.value)}
                        placeholder="Paste an existing Session ID"
                        disabled={pending}
                        className={`${INPUT_CLASS} h-[34px] font-mono`}
                      />
                    </div>
                  )}
                </div>
              </FormSection>

              <div>
                <FieldLabel htmlFor="automation-message">Message</FieldLabel>
                <textarea
                  id="automation-message"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="Describe the work to perform. You can use /skill use … just like in a normal Session."
                  rows={7}
                  maxLength={AUTOMATION_MESSAGE_MAX_LENGTH}
                  disabled={pending}
                  className={`${INPUT_CLASS} h-[153px] min-h-[148px] resize-y !p-2.5 leading-[1.5]`}
                />
                <FieldHint>This is sent through the normal Session command, permission, and HITL flow.</FieldHint>
              </div>

              {automation && onDeleted && onPause && onResume ? (
                <FormSection
                  title="Definition controls"
                  description="Pause dispatch without changing the definition, or permanently delete it."
                >
                  <div className="mt-0.5 divide-y divide-border-subtle rounded-sm border border-border-subtle bg-bg-base">
                    <div className="flex min-h-[58px] items-center justify-between gap-3 px-3 py-2.5">
                      <span className="min-w-0"><strong className="block text-[12px] font-medium text-text-secondary">Dispatch status</strong><span className="mt-1 block text-[11px] text-text-tertiary">{automation.status === "active" ? "Active and eligible to run" : automation.status === "paused" ? "Paused until resumed" : "Disabled"}</span></span>
                      <button
                        type="button"
                        disabled={pending || automation.status === "disabled"}
                        onClick={automation.status === "paused" ? onResume : onPause}
                        className="inline-flex h-8 shrink-0 items-center rounded-sm border border-border-default bg-transparent px-[13px] text-[12px] font-semibold text-text-secondary transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] disabled:opacity-40 [@media(pointer:coarse)]:h-11"
                      >
                        {automation.status === "paused" ? "Resume" : "Pause"}
                      </button>
                    </div>
                    <div className="flex min-h-[58px] items-center justify-between gap-3 px-3 py-2.5">
                      <span className="min-w-0"><strong className="block text-[12px] font-medium text-text-secondary">Delete Automation</strong><span className="mt-1 block text-[11px] text-text-tertiary">Removes the definition; existing Sessions remain durable.</span></span>
                      <button
                        ref={deleteButtonRef}
                        type="button"
                        disabled={pending}
                        onClick={(event) => openConfirmation("delete", event.currentTarget)}
                        className="inline-flex h-8 shrink-0 items-center rounded-sm border border-error/30 bg-error-muted px-3 text-[12px] font-semibold text-error transition-colors duration-[var(--motion-hover)] hover:border-error/50 focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] disabled:opacity-40 [@media(pointer:coarse)]:h-11"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </FormSection>
              ) : null}
            </div>
          </div>

          <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-border-subtle bg-bg-surface px-[18px] pb-[14px] pt-3">
            <div className="min-w-0 text-xs text-error" role={errorMessage ? "alert" : undefined}>
              {errorMessage}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={(event) => requestClose(event.currentTarget)}
                disabled={pending}
                className="h-8 rounded-sm border border-border-default bg-transparent px-[13px] text-[12px] font-semibold text-text-primary transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40 [@media(pointer:coarse)]:h-11"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!valid || pending}
                className="h-8 rounded-sm bg-brand px-[13px] text-[12px] font-semibold text-brand-ink transition-colors duration-[var(--motion-hover)] hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40 [@media(pointer:coarse)]:h-11"
              >
                {pending ? "Saving…" : automation ? "Save changes" : "Create Automation"}
              </button>
            </div>
          </footer>
          </div>
          {confirmation ? (
            <AutomationEditorConfirmation
              automation={automation}
              cancelRef={confirmationCancelRef}
              deleteError={deleteErrorMessage}
              kind={confirmation}
              pending={remove.isPending}
              onCancel={returnFromConfirmation}
              onConfirm={confirmation === "delete" ? confirmDelete : () => {
                setConfirmation(null);
                onClose();
              }}
            />
          ) : null}
        </form>
      </DialogContent>
    </DialogRoot>
  );
}

function AutomationEditorConfirmation({
  automation,
  cancelRef,
  deleteError,
  kind,
  onCancel,
  onConfirm,
  pending,
}: {
  automation?: Automation;
  cancelRef: RefObject<HTMLButtonElement | null>;
  deleteError: string | null;
  kind: "discard" | "delete";
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
}) {
  const titleId = `automation-editor-${kind}-title`;
  const descriptionId = `automation-editor-${kind}-description`;
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !pending) {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    if (buttons.length === 0) return;
    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.shiftKey
      ? currentIndex <= 0 ? buttons.length - 1 : currentIndex - 1
      : currentIndex === -1 || currentIndex === buttons.length - 1 ? 0 : currentIndex + 1;
    event.preventDefault();
    buttons[nextIndex]?.focus();
  };

  return (
    <div
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      aria-modal="true"
      className="absolute inset-0 z-20 flex items-center justify-center overflow-y-auto bg-[color-mix(in_srgb,var(--bg-overlay)_92%,transparent)] p-[18px]"
      onKeyDown={handleKeyDown}
      role="alertdialog"
    >
      <section className="w-full max-w-[500px] overflow-hidden rounded-[10px] border border-border-default bg-bg-surface shadow-[var(--elevation-lg)]">
        <header className="border-b border-border-subtle px-5 py-4">
          <h2 id={titleId} className="text-[16px] font-[650] text-text-primary">
            {kind === "delete" ? "Delete Automation?" : "Discard unsaved changes?"}
          </h2>
          <p id={descriptionId} className="mt-1 text-[12px] leading-5 text-text-tertiary">
            {kind === "delete" ? "This action cannot be undone." : "Your current Automation draft will be lost."}
          </p>
        </header>
        <div className="space-y-4 px-5 py-4">
          {kind === "delete" && automation ? (
            <>
              <div className="rounded-md border border-border-default bg-bg-base px-3.5 py-3">
                <span className="block text-[10px] font-semibold uppercase tracking-[0.09em] text-text-tertiary">Selected</span>
                <strong className="mt-1 block truncate text-[13px] font-semibold text-text-primary">{automation.name}</strong>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">This will permanently remove</p>
                <ul className="mt-2 space-y-1.5 text-[12px] leading-5 text-text-secondary">
                  <li>• The schedule and its configuration</li>
                  <li>• Pending runs and the complete invocation history</li>
                </ul>
              </div>
              <p className="rounded-md border border-warning/25 bg-warning-muted px-3 py-2.5 text-[12px] leading-5 text-text-secondary">
                Sessions already created or updated by this Automation remain unchanged. Schedule: <strong className="font-medium text-text-primary">{formatAutomationTrigger(automation.trigger)}</strong>
              </p>
            </>
          ) : (
            <p className="text-[12px] leading-5 text-text-secondary">Keep editing to preserve the draft, or discard it and close the editor.</p>
          )}
          {kind === "delete" && deleteError ? <p className="text-[12px] text-error" role="alert">{deleteError}</p> : null}
        </div>
        <footer className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <button
            ref={cancelRef}
            type="button"
            disabled={pending}
            onClick={onCancel}
            className="h-8 rounded-sm border border-border-default bg-bg-active px-4 text-[12px] font-semibold text-text-primary hover:bg-bg-hover focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] disabled:opacity-40 [@media(pointer:coarse)]:h-11"
          >
            {kind === "delete" ? "Cancel" : "Keep editing"}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={onConfirm}
            className={`h-8 rounded-sm px-4 text-[12px] font-semibold focus-visible:outline-none focus-visible:[box-shadow:var(--focus)] disabled:opacity-40 [@media(pointer:coarse)]:h-11 ${kind === "delete" ? "bg-error text-bg-overlay" : "bg-brand text-brand-ink"}`}
          >
            {kind === "delete" ? pending ? "Deleting…" : "Delete Automation" : "Discard changes"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function FormSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-2.5">
        <h3 className="text-[13px] font-[650] text-text-primary">{title}</h3>
        <p className="mt-1 text-[11px] leading-[1.45] text-text-tertiary">{description}</p>
      </div>
      {children}
    </section>
  );
}

function ChoiceCard({
  checked,
  description,
  disabled,
  id,
  label,
  name,
  onChange,
}: {
  checked: boolean;
  description: string;
  disabled: boolean;
  id: string;
  label: string;
  name: string;
  onChange: () => void;
}) {
  return (
    <label
      htmlFor={id}
      className={`grid min-h-[72px] min-w-0 cursor-pointer gap-1 rounded-lg border px-[11px] py-2.5 transition-[border-color,background-color,transform] duration-[var(--motion-hover)] hover:-translate-y-px ${checked
        ? "border-[color-mix(in_srgb,var(--brand)_42%,var(--border-default))] bg-[color-mix(in_srgb,var(--brand)_10%,var(--bg-surface))] text-text-primary"
        : "border-border-subtle bg-bg-surface text-text-secondary hover:border-border-default hover:bg-bg-hover"
      } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
    >
      <input
        id={id}
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="sr-only"
      />
      <span className="text-[12.5px] font-[650]">{label}</span>
      <span className="text-[11px] leading-[1.35] text-text-tertiary">{description}</span>
    </label>
  );
}

function CompactChoice({
  checked,
  description,
  disabled,
  id,
  label,
  name,
  onChange,
}: {
  checked: boolean;
  description: string;
  disabled: boolean;
  id: string;
  label: string;
  name: string;
  onChange: () => void;
}) {
  return (
    <label
      htmlFor={id}
      className={`grid min-h-[58px] cursor-pointer gap-0.5 rounded-lg border px-[11px] py-[9px] transition-colors duration-[var(--motion-hover)] ${checked
        ? "border-[color-mix(in_srgb,var(--brand)_42%,var(--border-default))] bg-[color-mix(in_srgb,var(--brand)_10%,var(--bg-surface))]"
        : "border-border-subtle bg-bg-elevated hover:border-border-default hover:bg-bg-hover"
      } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
    >
      <input
        id={id}
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="sr-only"
      />
      <span className="min-w-0">
        <span className="block text-[12px] font-[650] text-text-secondary">{label}</span>
        <span className="mt-0.5 block text-[10.5px] text-text-tertiary">{description}</span>
      </span>
    </label>
  );
}

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-[12px] font-semibold text-text-secondary">
      {children}
    </label>
  );
}

function FieldHint({ children }: { children: React.ReactNode }) {
  return <p className="mt-1.5 text-[11px] leading-[1.4] text-text-tertiary">{children}</p>;
}
