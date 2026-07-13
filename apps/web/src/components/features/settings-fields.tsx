import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ConfigSecretMutation } from "@archcode/protocol";
import type { FieldErrors } from "./settings-helpers";

export function Field({ label, children, error }: { label: string; children: ReactNode; error?: string }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-[11.5px] font-medium text-text-secondary">
      <span>{label}</span>
      {children}
      {error && <span role="alert" className="text-[11px] font-normal leading-4 text-error">{error}</span>}
    </label>
  );
}

export function TextInput({
  value,
  onChange,
  type = "text",
  placeholder,
  readOnly = false,
  onBlur,
}: {
  value?: string | number;
  onChange: (value: string) => void;
  type?: "text" | "number" | "password";
  placeholder?: string;
  readOnly?: boolean;
  onBlur?: () => void;
}) {
  return (
    <input
      type={type}
      value={value ?? ""}
      placeholder={placeholder}
      readOnly={readOnly}
      onChange={(event) => onChange(event.target.value)}
      onBlur={onBlur}
      className="h-9 w-full min-w-0 rounded-sm border border-border-default bg-bg-base px-3 text-[13px] text-text-primary outline-none transition-colors duration-150 placeholder:text-text-muted hover:border-border-strong focus:border-accent read-only:cursor-default read-only:border-border-subtle read-only:bg-bg-elevated read-only:text-text-tertiary"
    />
  );
}

export function RenameInput({
  value,
  readOnly = false,
  onCommit,
}: {
  value: string;
  readOnly?: boolean;
  onCommit: (value: string) => boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <TextInput
    value={draft}
    readOnly={readOnly}
    onChange={setDraft}
    onBlur={() => {
      const next = draft.trim();
      if (next === value) return;
      if (!next || !onCommit(next)) setDraft(value);
    }}
  />;
}

export function NumberField({ value, onChange }: { value?: number; onChange: (value: number | undefined) => void }) {
  return <TextInput type="number" value={value} onChange={(next) => onChange(next === "" ? undefined : Number(next))} />;
}

export function JsonObjectField({
  label,
  value,
  onChange,
  error,
  validationPath,
  onValidationChange,
  resetVersion = 0,
}: {
  label: string;
  value?: Record<string, unknown>;
  onChange: (value: Record<string, unknown> | undefined) => void;
  error?: string;
  validationPath?: string;
  onValidationChange?: (path: string, error?: string) => void;
  resetVersion?: number;
}) {
  const serialize = (next?: Record<string, unknown>) => next ? JSON.stringify(next, null, 2) : "";
  const [text, setText] = useState(() => serialize(value));
  const [invalid, setInvalid] = useState<string>();
  const committedText = useRef(serialize(value));
  const validationCallback = useRef(onValidationChange);

  useEffect(() => {
    validationCallback.current = onValidationChange;
  }, [onValidationChange]);

  useEffect(() => () => {
    if (validationPath) validationCallback.current?.(validationPath, undefined);
  }, [validationPath]);

  useEffect(() => {
    const next = serialize(value);
    if (next === committedText.current) return;
    committedText.current = next;
    setText(next);
    setInvalid(undefined);
    if (validationPath) validationCallback.current?.(validationPath, undefined);
  }, [value]);

  useEffect(() => {
    const next = serialize(value);
    committedText.current = next;
    setText(next);
    setInvalid(undefined);
    if (validationPath) validationCallback.current?.(validationPath, undefined);
  }, [resetVersion]);

  return (
    <Field label={label} error={error ?? invalid}>
      <textarea
        value={text}
        rows={5}
        placeholder="{ }"
        onChange={(event) => {
          const raw = event.target.value;
          setText(raw);
          if (!raw.trim()) {
            setInvalid(undefined);
            if (validationPath) validationCallback.current?.(validationPath, undefined);
            committedText.current = "";
            onChange(undefined);
            return;
          }
          try {
            const parsed: unknown = JSON.parse(raw);
            if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("Must be a JSON object");
            setInvalid(undefined);
            if (validationPath) validationCallback.current?.(validationPath, undefined);
            committedText.current = serialize(parsed as Record<string, unknown>);
            onChange(parsed as Record<string, unknown>);
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : "Must be a JSON object";
            setInvalid(message);
            if (validationPath) validationCallback.current?.(validationPath, message);
          }
        }}
        onBlur={() => {
          if (!invalid) setText(committedText.current);
        }}
        className="min-h-28 resize-y rounded-sm border border-border-default bg-bg-base px-3 py-2.5 font-mono text-xs leading-5 text-text-primary outline-none transition-colors duration-150 placeholder:text-text-muted hover:border-border-strong focus:border-accent"
      />
    </Field>
  );
}

export function SecretField({
  label,
  value,
  onChange,
  error,
}: {
  label: string;
  value?: ConfigSecretMutation;
  onChange: (value: ConfigSecretMutation) => void;
  error?: string;
}) {
  const configured = value?.action === "preserve";
  return (
    <Field label={label} error={error}>
      <div className="flex min-w-0 gap-2">
        <TextInput
          type="password"
          value={value?.action === "replace" ? value.value : ""}
          placeholder={configured ? "Configured" : "Not configured"}
          onChange={(next) => onChange(next ? { action: "replace", value: next } : { action: "delete" })}
        />
        <button type="button" onClick={() => onChange({ action: "delete" })} className="h-9 shrink-0 rounded-sm bg-bg-active px-3 text-xs font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary">
          Clear
        </button>
      </div>
    </Field>
  );
}

export function SecretRecordEditor({
  label,
  value,
  onChange,
  errors = {},
  path,
}: {
  label: string;
  value?: Record<string, ConfigSecretMutation>;
  onChange: (value: Record<string, ConfigSecretMutation> | undefined) => void;
  errors?: FieldErrors;
  path: string;
  errorPrefix?: string;
}) {
  const entries = Object.entries(value ?? {});
  const update = (key: string, secret: ConfigSecretMutation) => onChange({ ...(value ?? {}), [key]: secret });
  return (
    <fieldset className="min-w-0 rounded-sm border border-border-subtle bg-bg-base px-3 pb-3">
      <legend className="px-1 text-[11.5px] font-medium text-text-secondary">{label}</legend>
      {errors[path] && <span role="alert" className="text-xs text-error">{errors[path]}</span>}
      <div className="mt-1.5 space-y-2.5">
        {entries.map(([key, secret]) => (
          <div key={key} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
            <RenameInput value={key} readOnly={secret.action !== "replace"} onCommit={(next) => {
              if (next === key) return true;
              if (value?.[next]) return false;
              const draft = { ...(value ?? {}) };
              draft[next] = draft[key];
              draft[key] = { action: "delete" };
              onChange(draft);
              return true;
            }} />
            <SecretField label={`Value for ${key}`} value={secret} onChange={(next) => update(key, next)} error={errors[`${path}.${key}`]} />
            <button type="button" onClick={() => {
              const draft = { ...(value ?? {}) };
              draft[key] = { action: "delete" };
              onChange(draft);
            }} className="self-end rounded-sm px-2 py-2 text-xs text-error transition-colors duration-150 hover:bg-error-muted">Remove</button>
          </div>
        ))}
        <button type="button" onClick={() => {
          let key = "header";
          let index = 2;
          while (value?.[key]) key = `header-${index++}`;
          onChange({ ...(value ?? {}), [key]: { action: "replace", value: "" } });
        }} className="rounded-sm px-2 py-1.5 text-left text-xs font-medium text-accent transition-colors duration-150 hover:bg-accent-subtle">Add value</button>
      </div>
    </fieldset>
  );
}
