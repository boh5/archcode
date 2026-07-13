import { useEffect, useState } from "react";
import {
  Calendar,
  Clock,
  Folder,
  GitBranch,
  Play,
  RotateCcw,
  Send,
  X,
  type LucideIcon,
} from "lucide-react";

import { useCreateAutomation, useUpdateAutomation } from "../../api/mutations";
import type {
  Automation,
  AutomationAction,
  AutomationTrigger,
  CreateAutomationPayload,
} from "../../api/types";
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
  "w-full rounded-sm border border-border-default bg-bg-base px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted transition-colors duration-150 focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50";

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

interface AutomationDialogProps {
  open: boolean;
  onClose: () => void;
  slug: string;
  automation?: Automation;
  onCreated?: (automationId: string) => void;
}

export function AutomationDialog({
  open,
  onClose,
  slug,
  automation,
  onCreated,
}: AutomationDialogProps) {
  const create = useCreateAutomation();
  const update = useUpdateAutomation();
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

  useEffect(() => {
    if (!open) return;
    const interval = automation?.trigger.kind === "interval"
      ? intervalFromMilliseconds(automation.trigger.everyMs)
      : { value: 1, unit: "minutes" as const };

    setName(automation?.name ?? "");
    setTriggerKind(automation?.trigger.kind ?? "interval");
    setOnceAt(automation?.trigger.kind === "once" ? automation.trigger.at.slice(0, 16) : "");
    setIntervalValue(interval.value);
    setIntervalUnit(interval.unit);
    setCron(automation?.trigger.kind === "cron" ? automation.trigger.expression : "*/15 * * * *");
    setTimezone(automation?.trigger.kind === "cron"
      ? automation.trigger.timezone
      : Intl.DateTimeFormat().resolvedOptions().timeZone);
    setActionKind(automation?.action.kind ?? "start_session");
    setMessage(automation?.action.message ?? "");
    setSessionId(automation?.action.kind === "send_message" ? automation.action.sessionId : "");
    setLocation(automation?.action.kind === "start_session" ? automation.action.location : "project");
  }, [open, automation?.id]);

  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;
  const everyMs = intervalToMilliseconds(intervalValue, intervalUnit);
  const valid = name.trim().length > 0
    && message.trim().length > 0
    && (triggerKind !== "once" || Number.isFinite(new Date(onceAt).getTime()))
    && (triggerKind !== "interval" || Number.isInteger(everyMs) && everyMs >= 30_000)
    && (triggerKind !== "cron" || cron.trim().split(/\s+/).length === 5 && timezone.trim().length > 0)
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
    const payload: CreateAutomationPayload = { name: name.trim(), trigger, action };

    if (automation) {
      update.mutate(
        { slug, automationId: automation.id, ...payload },
        { onSuccess: onClose },
      );
      return;
    }
    create.mutate(
      { slug, ...payload },
      {
        onSuccess: ({ automation: created }) => {
          onCreated?.(created.id);
          onClose();
        },
      },
    );
  };

  const errorMessage = error
    ? error instanceof Error
      ? error.message
      : "Automation request failed"
    : null;

  return (
    <DialogRoot open={open} onOpenChange={(next) => { if (!next && !pending) onClose(); }}>
      <DialogContent size="large" className="overflow-hidden p-0">
        <form onSubmit={submit} className="flex max-h-[calc(100vh-32px)] flex-col">
          <header className="flex shrink-0 items-center gap-3 border-b border-border-subtle px-5 py-4">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-accent/30 bg-accent-subtle text-accent">
              <Clock size={17} aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-base font-semibold text-text-primary">
                {automation ? "Edit Automation" : "New Automation"}
              </DialogTitle>
              <DialogDescription className="mt-0.5 text-[12px] text-text-muted">
                Schedule an ordinary Session message. The Session keeps its existing tools and permissions.
              </DialogDescription>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={pending}
              aria-label="Close"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-40"
            >
              <X size={15} aria-hidden="true" />
            </button>
          </header>

          <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto min-[760px]:grid-cols-2 min-[760px]:overflow-hidden">
            <div className="space-y-5 border-b border-border-subtle px-5 py-4 min-[760px]:overflow-y-auto min-[760px]:border-b-0 min-[760px]:border-r">
              <div>
                <FieldLabel htmlFor="automation-name">Name</FieldLabel>
                <input
                  id="automation-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. Daily project health check"
                  autoFocus
                  disabled={pending}
                  className={INPUT_CLASS}
                />
              </div>

              <FormSection
                title="Schedule"
                description="Choose when this message should be dispatched. Missed occurrences are not replayed."
              >
                <div className="grid grid-cols-3 gap-2">
                  <ChoiceCard
                    checked={triggerKind === "once"}
                    description="A specific time"
                    disabled={pending}
                    icon={Calendar}
                    id="automation-trigger-once"
                    label="Once"
                    name="automation-trigger"
                    onChange={() => setTriggerKind("once")}
                  />
                  <ChoiceCard
                    checked={triggerKind === "interval"}
                    description="Fixed cadence"
                    disabled={pending}
                    icon={RotateCcw}
                    id="automation-trigger-interval"
                    label="Every"
                    name="automation-trigger"
                    onChange={() => setTriggerKind("interval")}
                  />
                  <ChoiceCard
                    checked={triggerKind === "cron"}
                    description="Cron schedule"
                    disabled={pending}
                    icon={Clock}
                    id="automation-trigger-cron"
                    label="Cron"
                    name="automation-trigger"
                    onChange={() => setTriggerKind("cron")}
                  />
                </div>

                <div className="mt-3 rounded-sm border border-border-subtle bg-bg-elevated p-3">
                  {triggerKind === "once" && (
                    <div>
                      <FieldLabel htmlFor="automation-once-at">Run at</FieldLabel>
                      <input
                        id="automation-once-at"
                        type="datetime-local"
                        value={onceAt}
                        onChange={(event) => setOnceAt(event.target.value)}
                        disabled={pending}
                        className={INPUT_CLASS}
                      />
                      <FieldHint>Uses your current local time.</FieldHint>
                    </div>
                  )}
                  {triggerKind === "interval" && (
                    <div>
                      <FieldLabel htmlFor="automation-interval-value">Repeat every</FieldLabel>
                      <div className="grid grid-cols-[minmax(0,1fr)_132px] gap-2">
                        <input
                          id="automation-interval-value"
                          type="number"
                          min={1}
                          step={1}
                          value={intervalValue}
                          onChange={(event) => setIntervalValue(Number(event.target.value))}
                          disabled={pending}
                          className={INPUT_CLASS}
                        />
                        <select
                          aria-label="Interval unit"
                          value={intervalUnit}
                          onChange={(event) => setIntervalUnit(event.target.value as IntervalUnit)}
                          disabled={pending}
                          className={INPUT_CLASS}
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
                    <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-2">
                      <div>
                        <FieldLabel htmlFor="automation-cron">Expression</FieldLabel>
                        <input
                          id="automation-cron"
                          value={cron}
                          onChange={(event) => setCron(event.target.value)}
                          placeholder="*/15 * * * *"
                          disabled={pending}
                          className={`${INPUT_CLASS} font-mono`}
                        />
                      </div>
                      <div>
                        <FieldLabel htmlFor="automation-timezone">Timezone</FieldLabel>
                        <input
                          id="automation-timezone"
                          value={timezone}
                          onChange={(event) => setTimezone(event.target.value)}
                          placeholder="Asia/Shanghai"
                          disabled={pending}
                          className={INPUT_CLASS}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </FormSection>
            </div>

            <div className="space-y-5 px-5 py-4 min-[760px]:overflow-y-auto">
              <FormSection
                title="Action"
                description="Start fresh work or continue a Session that already has context."
              >
                <div className="grid grid-cols-2 gap-2">
                  <ChoiceCard
                    checked={actionKind === "start_session"}
                    description="Create a new Engineer Session"
                    disabled={pending}
                    icon={Play}
                    id="automation-action-start"
                    label="New Session"
                    name="automation-action"
                    onChange={() => setActionKind("start_session")}
                  />
                  <ChoiceCard
                    checked={actionKind === "send_message"}
                    description="Continue existing context"
                    disabled={pending}
                    icon={Send}
                    id="automation-action-send"
                    label="Existing Session"
                    name="automation-action"
                    onChange={() => setActionKind("send_message")}
                  />
                </div>

                <div className="mt-3">
                  {actionKind === "start_session" ? (
                    <fieldset>
                      <legend className="mb-1.5 text-[12px] font-medium text-text-secondary">Run location</legend>
                      <div className="grid grid-cols-2 gap-2">
                        <CompactChoice
                          checked={location === "project"}
                          description="Use the current checkout"
                          disabled={pending}
                          icon={Folder}
                          id="automation-location-project"
                          label="Project"
                          name="automation-location"
                          onChange={() => setLocation("project")}
                        />
                        <CompactChoice
                          checked={location === "worktree"}
                          description="Create an isolated checkout"
                          disabled={pending}
                          icon={GitBranch}
                          id="automation-location-worktree"
                          label="Worktree"
                          name="automation-location"
                          onChange={() => setLocation("worktree")}
                        />
                      </div>
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
                        className={`${INPUT_CLASS} font-mono`}
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
                  disabled={pending}
                  className={`${INPUT_CLASS} min-h-36 resize-y leading-5`}
                />
                <FieldHint>This is sent through the normal Session command, permission, and HITL flow.</FieldHint>
              </div>
            </div>
          </div>

          <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-border-subtle px-5 py-3">
            <div className="min-w-0 text-xs text-error" role={errorMessage ? "alert" : undefined}>
              {errorMessage}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={pending}
                className="rounded-sm bg-bg-active px-4 py-2 text-[13px] font-medium text-text-primary transition-colors duration-150 hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!valid || pending}
                className="rounded-sm bg-accent px-4 py-2 text-[13px] font-medium text-bg-base transition-colors duration-150 hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                {pending ? "Saving…" : automation ? "Save changes" : "Create Automation"}
              </button>
            </div>
          </footer>
        </form>
      </DialogContent>
    </DialogRoot>
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
        <h3 className="text-[13px] font-semibold text-text-primary">{title}</h3>
        <p className="mt-0.5 text-[11.5px] leading-4 text-text-muted">{description}</p>
      </div>
      {children}
    </section>
  );
}

function ChoiceCard({
  checked,
  description,
  disabled,
  icon: Icon,
  id,
  label,
  name,
  onChange,
}: {
  checked: boolean;
  description: string;
  disabled: boolean;
  icon: LucideIcon;
  id: string;
  label: string;
  name: string;
  onChange: () => void;
}) {
  return (
    <label
      htmlFor={id}
      className={`flex min-w-0 cursor-pointer flex-col rounded-sm border px-2.5 py-2 transition-colors duration-150 ${checked
        ? "border-accent/60 bg-accent-subtle text-text-primary"
        : "border-border-subtle bg-bg-base text-text-secondary hover:border-border-default hover:bg-bg-hover"
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
      <span className="flex items-center gap-1.5 text-[12px] font-medium">
        <Icon size={13} className={checked ? "text-accent" : "text-text-muted"} aria-hidden="true" />
        {label}
      </span>
      <span className="mt-1 truncate text-[10.5px] text-text-muted">{description}</span>
    </label>
  );
}

function CompactChoice({
  checked,
  description,
  disabled,
  icon: Icon,
  id,
  label,
  name,
  onChange,
}: {
  checked: boolean;
  description: string;
  disabled: boolean;
  icon: LucideIcon;
  id: string;
  label: string;
  name: string;
  onChange: () => void;
}) {
  return (
    <label
      htmlFor={id}
      className={`flex cursor-pointer items-start gap-2 rounded-sm border p-2.5 transition-colors duration-150 ${checked
        ? "border-accent/60 bg-accent-subtle"
        : "border-border-subtle bg-bg-base hover:border-border-default hover:bg-bg-hover"
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
      <Icon size={14} className={`mt-0.5 shrink-0 ${checked ? "text-accent" : "text-text-muted"}`} aria-hidden="true" />
      <span className="min-w-0">
        <span className="block text-[12px] font-medium text-text-secondary">{label}</span>
        <span className="mt-0.5 block text-[10.5px] leading-4 text-text-muted">{description}</span>
      </span>
    </label>
  );
}

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-[12px] font-medium text-text-secondary">
      {children}
    </label>
  );
}

function FieldHint({ children }: { children: React.ReactNode }) {
  return <p className="mt-1.5 text-[10.5px] leading-4 text-text-muted">{children}</p>;
}
