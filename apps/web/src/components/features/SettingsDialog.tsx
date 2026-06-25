import type { McpServerStatus } from "@archcode/protocol";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../ui/Dialog";
import { useMcpStatusStore } from "../../store/mcp-status-store";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

interface SettingsDialogContentProps {
  servers: Record<string, McpServerStatus>;
  onClose: () => void;
}

const SETTINGS_ITEMS = [
  { id: "general", label: "General", description: "Workspace preferences", enabled: false },
  { id: "mcp", label: "MCP Status", description: "Server discovery status", enabled: true },
  { id: "providers", label: "Providers", description: "AI providers", enabled: false },
  { id: "models", label: "Models", description: "Available model profiles", enabled: false },
] as const;

const STATUS_META: Record<McpServerStatus["state"], { label: string; dotClass: string; badgeClass: string }> = {
  pending: {
    label: "Pending",
    dotClass: "bg-warning",
    badgeClass: "bg-warning-muted text-warning border-warning/30",
  },
  ready: {
    label: "Ready",
    dotClass: "bg-success",
    badgeClass: "bg-success-muted text-success border-success/30",
  },
  failed: {
    label: "Failed",
    dotClass: "bg-error",
    badgeClass: "bg-error-muted text-error border-error/30",
  },
  disabled: {
    label: "Disabled",
    dotClass: "bg-text-muted",
    badgeClass: "bg-bg-elevated text-text-tertiary border-border-default",
  },
};

function describeStatus(status: McpServerStatus): string {
  switch (status.state) {
    case "ready":
      return `${status.toolCount} ${status.toolCount === 1 ? "tool" : "tools"} available`;
    case "failed":
      return status.error;
    case "pending":
      return "Discovery is still running";
    case "disabled":
      return "Server is disabled in configuration";
  }
}

function StatusBadge({ status }: { status: McpServerStatus }) {
  const meta = STATUS_META[status.state];

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${meta.badgeClass}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dotClass}`} />
      {meta.label}
    </span>
  );
}

export function SettingsMcpStatusPanel({ servers }: { servers: Record<string, McpServerStatus> }) {
  const entries = Object.entries(servers).sort(([left], [right]) => left.localeCompare(right));
  const readyCount = entries.filter(([, status]) => status.state === "ready").length;
  const failedCount = entries.filter(([, status]) => status.state === "failed").length;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-bg-base">
      <div className="flex w-full flex-col gap-6 px-6 py-6">
        <header className="flex flex-col gap-2 border-b border-border-default pb-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-text-muted">Servers</p>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-text-primary">MCP Status</h1>
              <p className="mt-1 text-sm text-text-secondary">
                Monitor configured MCP servers and their discovered tools.
              </p>
            </div>
            <div className="flex gap-2 text-[11px] text-text-tertiary">
              <span className="rounded-full border border-border-default bg-bg-surface px-2.5 py-1">{entries.length} servers</span>
              <span className="rounded-full border border-border-default bg-bg-surface px-2.5 py-1">{readyCount} ready</span>
              {failedCount > 0 && <span className="rounded-full border border-error/30 bg-error-muted px-2.5 py-1 text-error">{failedCount} failed</span>}
            </div>
          </div>
        </header>

        {entries.length === 0 ? (
          <section className="rounded-lg border border-dashed border-border-default bg-bg-surface px-5 py-10 text-center shadow-sm">
            <h2 className="text-base font-medium text-text-primary">No MCP servers reported yet</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-text-tertiary">
              Statuses appear here after the global SSE connection receives the initial MCP snapshot.
            </p>
          </section>
        ) : (
          <section className="overflow-hidden rounded-lg border border-border-default bg-bg-surface shadow-sm">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] border-b border-border-subtle px-4 py-2 text-[11px] font-medium uppercase tracking-[0.14em] text-text-muted">
              <span>Server</span>
              <span>Status</span>
            </div>
            <div className="divide-y divide-border-subtle">
              {entries.map(([name, status]) => (
                <article key={name} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 transition-colors hover:bg-bg-hover">
                  <div className="min-w-0">
                    <h2 className="truncate font-mono text-sm font-medium text-text-primary">{name}</h2>
                    <p className={`mt-1 text-xs ${status.state === "failed" ? "text-error" : "text-text-tertiary"}`}>
                      {describeStatus(status)}
                    </p>
                  </div>
                  <StatusBadge status={status} />
                </article>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

export function SettingsDialogContent({ servers, onClose }: SettingsDialogContentProps) {
  return (
    <>
      <DialogDescription className="sr-only">
        Configure ArchCode settings and view MCP server status.
      </DialogDescription>

      <div className="flex h-full min-h-0 flex-col sm:flex-row">
        <aside className="flex shrink-0 flex-col border-b border-border-default bg-bg-surface sm:w-60 sm:border-b-0 sm:border-r">
          <div className="flex items-start justify-between gap-3 border-b border-border-subtle px-4 py-4">
            <div>
              <DialogTitle className="text-base font-semibold text-text-primary">Settings</DialogTitle>
              <p className="mt-1 text-xs text-text-tertiary">ArchCode preferences</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded-sm text-text-muted transition-colors duration-150 hover:bg-bg-hover hover:text-text-secondary"
              aria-label="Close settings"
            >
              ✕
            </button>
          </div>

          <nav aria-label="Settings sections" className="flex gap-1 overflow-x-auto px-3 py-3 sm:flex-col sm:overflow-visible">
            <p className="hidden px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.16em] text-text-muted sm:block">
              Workspace
            </p>
            {SETTINGS_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`flex min-w-[150px] flex-col rounded-md px-3 py-2 text-left transition-colors duration-150 sm:min-w-0 ${
                  item.enabled
                    ? "bg-accent-muted text-accent"
                    : "cursor-not-allowed text-text-muted opacity-55"
                }`}
                disabled={!item.enabled}
                aria-current={item.enabled ? "page" : undefined}
              >
                <span className="text-[13px] font-medium">{item.label}</span>
                <span className="mt-0.5 text-[11px] text-text-tertiary">{item.enabled ? item.description : "Coming soon"}</span>
              </button>
            ))}
          </nav>

          <div className="mt-auto hidden border-t border-border-subtle px-4 py-3 text-[11px] text-text-muted sm:block">
            ArchCode
          </div>
        </aside>

        <div className="min-h-0 flex-1">
          <SettingsMcpStatusPanel servers={servers} />
        </div>
      </div>
    </>
  );
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const servers = useMcpStatusStore((state) => state.servers);
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) onClose();
  };

  return (
    <DialogRoot open={open} onOpenChange={handleOpenChange}>
      <DialogContent size="x-large" className="overflow-hidden p-0">
        <SettingsDialogContent servers={servers} onClose={onClose} />
      </DialogContent>
    </DialogRoot>
  );
}
