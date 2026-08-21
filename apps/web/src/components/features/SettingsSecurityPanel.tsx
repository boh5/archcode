import { useEffect, useState } from "react";
import { MAX_AUTH_PASSWORD_BYTES, MIN_AUTH_PASSWORD_LENGTH, type AuthStatus } from "@archcode/protocol";
import { changePassword, getAuthStatus } from "../../api/auth";
import type { ServerConfig } from "../../api/config";
import { Field, TextInput } from "./settings-fields";
import { withDraft } from "./settings-helpers";

const primaryButton = "inline-flex h-8 items-center justify-center rounded-sm bg-brand px-4 text-[12px] font-medium text-brand-ink transition-colors duration-[var(--motion-fast)] hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40 [@media(pointer:coarse)]:min-h-11";
const dangerButton = "inline-flex h-8 items-center justify-center rounded-sm border border-error/30 bg-error-muted px-4 text-[12px] font-medium text-error transition-colors duration-[var(--motion-fast)] hover:bg-error-field focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40 [@media(pointer:coarse)]:min-h-11";

export function SettingsSecurityPanel({
  config,
  configDirty,
  onChange,
  onConfigChanged,
  onPasswordMutationPendingChange,
}: {
  config: ServerConfig;
  configDirty: boolean;
  onChange: (config: ServerConfig) => void;
  onConfigChanged: () => Promise<void>;
  onPasswordMutationPendingChange: (pending: boolean) => void;
}) {
  const [status, setStatus] = useState<AuthStatus>();
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState<"set" | "change" | "remove">();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    void getAuthStatus().then(
      (next) => { if (live) setStatus(next); },
      (cause) => { if (live) setError(cause instanceof Error ? cause.message : "Unable to load authentication settings."); },
    );
    return () => { live = false; };
  }, []);

  const passwordError = password.length > 0 && password.length < MIN_AUTH_PASSWORD_LENGTH
    ? `Use at least ${MIN_AUTH_PASSWORD_LENGTH} characters.`
    : new TextEncoder().encode(password).byteLength > MAX_AUTH_PASSWORD_BYTES
      ? `Use at most ${MAX_AUTH_PASSWORD_BYTES} UTF-8 bytes.`
      : password && password !== confirmation ? "Passwords do not match." : undefined;
  const currentPasswordError = new TextEncoder().encode(currentPassword).byteLength > MAX_AUTH_PASSWORD_BYTES
    ? `Use at most ${MAX_AUTH_PASSWORD_BYTES} UTF-8 bytes.` : undefined;
  const autoReview = config.permissions?.autoReview ?? true;
  const passwordMutationDisabled = pending !== undefined || configDirty;
  const autoReviewSetting = <div className="rounded-md border border-border-default bg-bg-surface p-4">
    <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-sm border border-border-subtle bg-bg-elevated px-3 py-3 transition-colors duration-[var(--motion-fast)] hover:border-border-default focus-within:ring-2 focus-within:ring-brand [@media(pointer:coarse)]:min-h-11 sm:min-h-0">
      <input
        type="checkbox"
        aria-label="AI approval review"
        checked={autoReview}
        onChange={(event) => onChange(withDraft(config, (draft) => {
          draft.permissions = { ...(draft.permissions ?? {}), autoReview: event.target.checked };
        }))}
        className="mt-1 h-4 w-4 accent-brand"
      />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-[13px] font-medium text-text-secondary">AI approval review</span>
        <span className="text-[11px] leading-4 text-text-tertiary">Fast model only approves a single action when it clearly fits the current task; if it is uncertain or fails, you’ll still be asked.</span>
      </span>
    </label>
  </div>;
  const save = async (action: "set" | "change" | "remove") => {
    if (configDirty) return;
    if (action !== "remove" && (!password || passwordError)) return;
    if ((action === "change" || action === "remove") && (!currentPassword || currentPasswordError)) return;
    onPasswordMutationPendingChange(true);
    setPending(action);
    setError(undefined);
    try {
      const next = action === "set"
        ? await changePassword({ action, password })
        : action === "change"
          ? await changePassword({ action, currentPassword, password })
          : await changePassword({ action, currentPassword });
      setStatus(next);
      setCurrentPassword("");
      setPassword("");
      setConfirmation("");
      await onConfigChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update password.");
    } finally {
      setPending(undefined);
      onPasswordMutationPendingChange(false);
    }
  };

  if (!status) return <section className="space-y-5 pb-1"><PanelHeader />{autoReviewSetting}<p role={error ? "alert" : undefined} className={error ? "text-sm text-error" : "text-sm text-text-tertiary"}>{error ?? "Loading security settings…"}</p></section>;
  const hasLogin = status.required;
  return <section className="space-y-5 pb-1">
    <PanelHeader />
    {autoReviewSetting}
    <div className="rounded-md border border-border-default bg-bg-surface p-4">
      <p className="text-[13px] font-medium text-text-primary">{hasLogin ? "Login is required" : "Login is disabled"}</p>
      <p className="mt-1 text-[12px] leading-5 text-text-tertiary">{hasLogin ? "Changing or removing the password signs every existing browser session out." : "Anyone who can reach this server can control ArchCode."}</p>
    </div>
    {hasLogin && <Field label="Current password" error={currentPasswordError}><TextInput type="password" value={currentPassword} onChange={setCurrentPassword} /></Field>}
    <div className="grid gap-4 sm:grid-cols-2"><Field label={hasLogin ? "New password" : "Password"} error={passwordError?.startsWith("Use") ? passwordError : undefined}><TextInput type="password" value={password} onChange={setPassword} /></Field><Field label="Confirm password" error={passwordError === "Passwords do not match." ? passwordError : undefined}><TextInput type="password" value={confirmation} onChange={setConfirmation} /></Field></div>
    {configDirty && <p id="security-password-dirty-hint" role="status" className="rounded-sm border border-warning/30 bg-warning-muted px-3 py-2 text-[12px] leading-5 text-warning">Save or Reload your Config draft before changing the server password.</p>}
    {error && <p role="alert" className="text-[12px] leading-5 text-error">{error}</p>}
    <div className="flex flex-wrap gap-2 border-t border-border-subtle pt-4"><button type="button" aria-describedby={configDirty ? "security-password-dirty-hint" : undefined} className={primaryButton} disabled={passwordMutationDisabled || !password || (hasLogin && !currentPassword) || Boolean(passwordError) || Boolean(currentPasswordError)} onClick={() => { void save(hasLogin ? "change" : "set"); }}>{pending === "set" || pending === "change" ? "Saving…" : hasLogin ? "Change password" : "Enable login"}</button>{hasLogin && <button type="button" aria-describedby={configDirty ? "security-password-dirty-hint" : undefined} className={dangerButton} disabled={passwordMutationDisabled || !currentPassword || Boolean(currentPasswordError)} onClick={() => { void save("remove"); }}>{pending === "remove" ? "Removing…" : "Remove password"}</button>}</div>
  </section>;
}

function PanelHeader() {
  return <header className="border-b border-border-subtle pb-4"><p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-tertiary">Server settings</p><h1 className="text-[16px] font-semibold leading-[22px] text-text-primary">Security</h1><p className="mt-1 text-[13px] leading-5 text-text-tertiary">Manage the one password that protects this ArchCode server.</p></header>;
}
