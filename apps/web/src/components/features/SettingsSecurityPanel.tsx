import { useEffect, useState } from "react";
import { MAX_AUTH_PASSWORD_BYTES, MIN_AUTH_PASSWORD_LENGTH, type AuthStatus } from "@archcode/protocol";
import { changePassword, getAuthStatus } from "../../api/auth";
import { Field, TextInput } from "./settings-fields";

const primaryButton = "inline-flex h-8 items-center justify-center rounded-sm bg-brand px-4 text-[12px] font-medium text-brand-ink transition-colors duration-[var(--motion-hover)] hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40";
const dangerButton = "inline-flex h-8 items-center justify-center rounded-sm border border-error/30 bg-error-muted px-4 text-[12px] font-medium text-error transition-colors duration-[var(--motion-hover)] hover:bg-error-field focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40";

export function SettingsSecurityPanel({
  onConfigChanged,
}: {
  onConfigChanged: () => Promise<void>;
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
  const save = async (action: "set" | "change" | "remove") => {
    if (action !== "remove" && (!password || passwordError)) return;
    if ((action === "change" || action === "remove") && (!currentPassword || currentPasswordError)) return;
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
    }
  };

  if (!status) return <section className="space-y-5 pb-1"><PanelHeader /><p role={error ? "alert" : undefined} className={error ? "text-sm text-error" : "text-sm text-text-tertiary"}>{error ?? "Loading security settings…"}</p></section>;
  const hasLogin = status.required;
  return <section className="space-y-5 pb-1">
    <PanelHeader />
    <div className="rounded-md border border-border-default bg-bg-surface p-4">
      <p className="text-[13px] font-medium text-text-primary">{hasLogin ? "Login is required" : "Login is disabled"}</p>
      <p className="mt-1 text-[12px] leading-5 text-text-tertiary">{hasLogin ? "Changing or removing the password signs every existing browser session out." : "Anyone who can reach this server can control ArchCode."}</p>
    </div>
    {hasLogin && <Field label="Current password" error={currentPasswordError}><TextInput type="password" value={currentPassword} onChange={setCurrentPassword} /></Field>}
    <div className="grid gap-4 sm:grid-cols-2"><Field label={hasLogin ? "New password" : "Password"} error={passwordError?.startsWith("Use") ? passwordError : undefined}><TextInput type="password" value={password} onChange={setPassword} /></Field><Field label="Confirm password" error={passwordError === "Passwords do not match." ? passwordError : undefined}><TextInput type="password" value={confirmation} onChange={setConfirmation} /></Field></div>
    {error && <p role="alert" className="text-[12px] leading-5 text-error">{error}</p>}
    <div className="flex flex-wrap gap-2 border-t border-border-subtle pt-4"><button type="button" className={primaryButton} disabled={pending !== undefined || !password || (hasLogin && !currentPassword) || Boolean(passwordError) || Boolean(currentPasswordError)} onClick={() => { void save(hasLogin ? "change" : "set"); }}>{pending === "set" || pending === "change" ? "Saving…" : hasLogin ? "Change password" : "Enable login"}</button>{hasLogin && <button type="button" className={dangerButton} disabled={pending !== undefined || !currentPassword || Boolean(currentPasswordError)} onClick={() => { void save("remove"); }}>{pending === "remove" ? "Removing…" : "Remove password"}</button>}</div>
  </section>;
}

function PanelHeader() {
  return <header className="border-b border-border-subtle pb-4"><p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-tertiary">Server settings</p><h1 className="text-[16px] font-semibold leading-[22px] text-text-primary">Security</h1><p className="mt-1 text-[13px] leading-5 text-text-tertiary">Manage the one password that protects this ArchCode server.</p></header>;
}
