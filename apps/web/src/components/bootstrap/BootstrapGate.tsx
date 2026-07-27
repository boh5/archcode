import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { LockKeyhole, RefreshCw, ShieldAlert, Terminal, TriangleAlert } from "lucide-react";
import type { BootstrapStatus, CompleteSetupRequest, ProviderAdapterCatalog, ServerConfigUpdate } from "@archcode/protocol";
import { MAX_AUTH_PASSWORD_BYTES, MIN_AUTH_PASSWORD_LENGTH } from "@archcode/protocol";
import { ApiError, subscribeAuthInvalidation } from "../../api/client";
import { completeSetup, getBootstrapStatus, getSetupProviderAdapterCatalog } from "../../api/bootstrap";
import { login } from "../../api/auth";
import { SettingsModelsPanel, SettingsProfilesPanel } from "../features/settings-panels";
import { toFieldErrors, type FieldErrors } from "../features/settings-helpers";
import { Field, TextInput } from "../features/settings-fields";

type GateState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "status"; status: BootstrapStatus };

const primaryButton = "inline-flex h-9 items-center justify-center gap-2 rounded-sm bg-brand px-4 text-[12px] font-semibold text-brand-ink transition-colors duration-[var(--motion-hover)] hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40";
const secondaryButton = "inline-flex h-9 items-center justify-center gap-2 rounded-sm bg-bg-active px-4 text-[12px] font-semibold text-text-secondary transition-colors duration-[var(--motion-hover)] hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40";

let inspectedSetupFragment = false;
let setupGrantFromFragment: string | undefined;

function readSetupGrant(): string | undefined {
  if (inspectedSetupFragment) return setupGrantFromFragment;
  inspectedSetupFragment = true;
  if (typeof window === "undefined") return undefined;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const token = params.get("token")?.trim();
  if (token) {
    setupGrantFromFragment = token;
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }
  return setupGrantFromFragment;
}

function emptySetupConfig(): ServerConfigUpdate {
  return {
    provider: {},
    profiles: {
      principal: { model: "" },
      deep: { model: "" },
      fast: { model: "" },
    },
  };
}

export function BootstrapGate({
  children,
  onAuthInvalidated,
}: {
  children: ReactNode;
  onAuthInvalidated?: () => void;
}) {
  const [state, setState] = useState<GateState>({ kind: "loading" });
  const reload = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const status = await getBootstrapStatus();
      normalizeCompletedSetupPath(status);
      setState({ kind: "status", status });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "Unable to reach ArchCode." });
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(
    () => subscribeAuthInvalidation(() => {
      onAuthInvalidated?.();
      void reload();
    }),
    [onAuthInvalidated, reload],
  );
  useEffect(() => {
    if (state.kind !== "status" || state.status.mode !== "activating") return;
    const timeout = window.setTimeout(() => { void reload(); }, 1_000);
    return () => window.clearTimeout(timeout);
  }, [reload, state]);

  if (state.kind === "loading") return <BootstrapShell title="Starting ArchCode"><p className="text-sm text-text-tertiary">Checking server readiness…</p></BootstrapShell>;
  if (state.kind === "error") return <BlockingPage icon={<TriangleAlert size={20} />} title="Can’t reach ArchCode" message={state.message} onRetry={reload} />;

  const { status } = state;
  if (status.mode === "setup") {
    const grant = readSetupGrant();
    return grant
      ? <SetupPage grant={grant} onComplete={reload} />
      : <SetupLinkRequiredPage onRetry={reload} />;
  }
  if (status.mode === "activating") return <BootstrapShell title="Finishing setup"><p className="text-sm text-text-tertiary">ArchCode is creating the runtime. This page will continue automatically.</p></BootstrapShell>;
  if (status.mode === "config_error") return <BlockingPage icon={<ShieldAlert size={20} />} title="Configuration needs repair" message={status.message} onRetry={reload} />;
  if (status.mode === "startup_error") return <BlockingPage icon={<TriangleAlert size={20} />} title="ArchCode could not start" message={status.message} onRetry={reload} />;
  if (status.authRequired && !status.authenticated) return <LoginPage onLoggedIn={reload} />;
  return <>{children}</>;
}

function BootstrapShell({ title, children }: { title: string; children: ReactNode }) {
  return <main className="flex min-h-dvh items-center justify-center bg-bg-base px-4 py-10">
    <section className="w-full max-w-xl rounded-md border border-border-default bg-bg-surface">
      <header className="border-b border-border-subtle px-6 py-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-tertiary">ArchCode</p>
        <h1 className="mt-1 text-[22px] font-semibold text-text-primary">{title}</h1>
      </header>
      <div className="px-6 py-5">{children}</div>
    </section>
  </main>;
}

function BlockingPage({ icon, title, message, onRetry }: { icon: ReactNode; title: string; message: string; onRetry: () => void }) {
  return <BootstrapShell title={title}>
    <div className="flex gap-3">
      <span className="mt-0.5 text-warning" aria-hidden="true">{icon}</span>
      <p role="alert" className="text-sm leading-6 text-text-secondary">{message}</p>
    </div>
    <button type="button" className={`mt-6 ${secondaryButton}`} onClick={onRetry}><RefreshCw size={14} aria-hidden="true" />Retry</button>
  </BootstrapShell>;
}

function SetupLinkRequiredPage({ onRetry }: { onRetry: () => void }) {
  return <BootstrapShell title="Open the setup link from your terminal">
    <div className="flex gap-3">
      <span className="mt-0.5 text-warning" aria-hidden="true"><Terminal size={20} /></span>
      <div className="space-y-2 text-sm leading-6 text-text-secondary">
        <p>This ArchCode server has not been set up yet.</p>
        <p>Return to the terminal where ArchCode is running and open the URL printed after <span className="font-medium text-text-primary">“Complete first-run setup at”</span>. That URL contains the one-time token required to begin setup.</p>
      </div>
    </div>
    <button type="button" className={`mt-6 ${secondaryButton}`} onClick={onRetry}><RefreshCw size={14} aria-hidden="true" />Check again</button>
  </BootstrapShell>;
}

function LoginPage({ onLoggedIn }: { onLoggedIn: () => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const passwordError = new TextEncoder().encode(password).byteLength > MAX_AUTH_PASSWORD_BYTES
    ? `Use at most ${MAX_AUTH_PASSWORD_BYTES} UTF-8 bytes.` : undefined;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (passwordError) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await login({ password });
      setPassword("");
      await onLoggedIn();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to sign in.");
    } finally {
      setSubmitting(false);
    }
  };
  return <BootstrapShell title="Sign in">
    <p className="mb-5 text-sm leading-6 text-text-secondary">This ArchCode server requires its configured password.</p>
    <form className="space-y-4" onSubmit={(event) => { void submit(event); }}>
      <Field label="Password" error={passwordError ?? error}><TextInput type="password" value={password} onChange={setPassword} /></Field>
      <button className={primaryButton} disabled={submitting || !password || Boolean(passwordError)} type="submit"><LockKeyhole size={14} aria-hidden="true" />{submitting ? "Signing in…" : "Sign in"}</button>
    </form>
  </BootstrapShell>;
}

function SetupPage({ grant, onComplete }: { grant: string; onComplete: () => Promise<void> }) {
  const [config, setConfig] = useState<ServerConfigUpdate>(emptySetupConfig);
  const [adapterCatalog, setAdapterCatalog] = useState<ProviderAdapterCatalog>();
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [jsonErrors, setJsonErrors] = useState<FieldErrors>({});
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [requireLogin, setRequireLogin] = useState(true);
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [confirmNoLogin, setConfirmNoLogin] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    void getSetupProviderAdapterCatalog(grant).then(
      (catalog) => { if (live) setAdapterCatalog(catalog); },
      (cause) => { if (live) setError(cause instanceof Error ? cause.message : "Unable to load provider adapters."); },
    ).finally(() => { if (live) setLoadingCatalog(false); });
    return () => { live = false; };
  }, [grant]);

  const onJsonValidationChange = useCallback((path: string, message?: string) => {
    setJsonErrors((current) => {
      if (message === undefined) {
        if (!(path in current)) return current;
        const next = { ...current };
        delete next[path];
        return next;
      }
      return current[path] === message ? current : { ...current, [path]: message };
    });
  }, []);
  const allErrors = useMemo(() => ({ ...fieldErrors, ...jsonErrors }), [fieldErrors, jsonErrors]);
  const passwordError = validatePassword(password, passwordConfirmation, requireLogin);

  const submit = async () => {
    if (Object.keys(jsonErrors).length > 0 || passwordError || (requireLogin && !password)) return;
    if (!requireLogin && !confirmNoLogin) {
      setConfirmNoLogin(true);
      return;
    }
    setSubmitting(true);
    setError(undefined);
    setFieldErrors({});
    try {
      const request: CompleteSetupRequest = requireLogin
        ? { config, requireLogin: true, password }
        : { config, requireLogin: false };
      await completeSetup(grant, request);
      setSetupGrantConsumed();
      await onComplete();
    } catch (cause) {
      setFieldErrors(toFieldErrors(cause));
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : "Unable to finish setup.");
    } finally {
      setSubmitting(false);
    }
  };

  return <main className="min-h-dvh bg-bg-base px-4 py-6 sm:px-8 sm:py-10">
    <section className="mx-auto max-w-4xl overflow-hidden rounded-md border border-border-default bg-bg-surface">
      <header className="border-b border-border-subtle px-5 py-5 sm:px-7">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-tertiary">ArchCode · first run</p>
        <h1 className="mt-1 text-[22px] font-semibold text-text-primary">Set up your workbench</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-text-secondary">Add one provider and model, then choose whether this server requires a password. Advanced integration settings remain available after setup.</p>
      </header>
      <div className="space-y-8 px-5 py-6 sm:px-7">
        {error && <p role="alert" className="rounded-sm border border-error/30 bg-error-muted px-3 py-3 text-sm leading-5 text-error">{error}</p>}
        {loadingCatalog ? <p className="text-sm text-text-tertiary">Loading provider adapters…</p> : adapterCatalog ? <>
          <SettingsModelsPanel config={config} adapterCatalog={adapterCatalog} onChange={setConfig} errors={allErrors} onJsonValidationChange={onJsonValidationChange} />
          <SettingsProfilesPanel config={config} onChange={setConfig} errors={allErrors} onJsonValidationChange={onJsonValidationChange} />
        </> : null}
        <section className="space-y-5 border-t border-border-subtle pt-6">
          <header><p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-tertiary">Server settings</p><h2 className="text-[16px] font-semibold leading-[22px] text-text-primary">Security</h2><p className="mt-1 text-[13px] leading-5 text-text-tertiary">A password is optional, but recommended whenever another device can reach this server.</p></header>
          <label className="flex cursor-pointer items-start gap-3 rounded-sm border border-border-subtle bg-bg-elevated px-3 py-3"><input type="checkbox" checked={requireLogin} onChange={(event) => { setRequireLogin(event.target.checked); setConfirmNoLogin(false); }} className="mt-1 h-4 w-4 accent-brand" /><span><span className="block text-[13px] font-medium text-text-secondary">Require login</span><span className="mt-1 block text-[11px] leading-4 text-text-tertiary">Use one password to protect this ArchCode server.</span></span></label>
          {requireLogin ? <div className="grid gap-4 sm:grid-cols-2"><Field label="Password" error={passwordError?.startsWith("Use") ? passwordError : undefined}><TextInput type="password" value={password} onChange={setPassword} /></Field><Field label="Confirm password" error={passwordError === "Passwords do not match." ? passwordError : undefined}><TextInput type="password" value={passwordConfirmation} onChange={setPasswordConfirmation} /></Field></div> : <div className="rounded-sm border border-warning/30 bg-warning-muted px-3 py-3 text-sm leading-5 text-warning"><p>Anyone who can reach this server can control ArchCode.</p>{confirmNoLogin && <p className="mt-2 font-medium">Click “Finish setup” once more to confirm that you understand.</p>}</div>}
        </section>
      </div>
      <footer className="flex items-center justify-end border-t border-border-subtle bg-bg-surface px-5 py-4 sm:px-7"><button type="button" className={primaryButton} disabled={submitting || loadingCatalog || !adapterCatalog} onClick={() => { void submit(); }}>{submitting ? "Finishing setup…" : confirmNoLogin && !requireLogin ? "Confirm without login" : "Finish setup"}</button></footer>
    </section>
  </main>;
}

function setSetupGrantConsumed() {
  setupGrantFromFragment = undefined;
}

function normalizeCompletedSetupPath(status: BootstrapStatus): void {
  if (
    typeof window !== "undefined"
    && window.location.pathname === "/setup"
    && status.mode === "ready"
    && (!status.authRequired || status.authenticated)
  ) {
    window.history.replaceState(null, "", "/");
    window.dispatchEvent(new window.PopStateEvent("popstate"));
  }
}

function validatePassword(password: string, confirmation: string, required: boolean): string | undefined {
  if (required && password.length > 0 && password.length < MIN_AUTH_PASSWORD_LENGTH) return `Use at least ${MIN_AUTH_PASSWORD_LENGTH} characters.`;
  if (new TextEncoder().encode(password).byteLength > MAX_AUTH_PASSWORD_BYTES) return `Use at most ${MAX_AUTH_PASSWORD_BYTES} UTF-8 bytes.`;
  if (password && password !== confirmation) return "Passwords do not match.";
  return undefined;
}
