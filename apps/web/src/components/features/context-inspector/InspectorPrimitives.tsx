import type { ReactNode } from "react";

export function InspectorSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">{title}</h3>
      {children}
    </section>
  );
}

export function InspectorParagraph({ children }: { children: ReactNode }) {
  return <p className="whitespace-pre-wrap text-xs leading-5 text-text-secondary">{children}</p>;
}

export function InspectorValue({ children }: { children: ReactNode }) {
  return <div className="text-xs text-text-secondary">{children}</div>;
}

export function InspectorRows({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="space-y-2">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-start justify-between gap-3">
          <dt className="text-[11px] text-text-muted">{label}</dt>
          <dd className="max-w-[65%] break-words text-right text-xs capitalize text-text-secondary">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function InspectorNotice({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "warning" | "error";
}) {
  const toneClass = tone === "warning"
    ? "border-warning/30 bg-warning-muted text-warning"
    : tone === "error"
      ? "border-error/30 bg-error-muted text-error"
      : "border-border-subtle bg-bg-base text-text-muted";
  return <div className={`rounded-sm border px-3 py-2 text-xs ${toneClass}`}>{children}</div>;
}
