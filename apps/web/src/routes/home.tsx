import type { HomeSummaryItem } from "@archcode/protocol";
import { Calendar, LoaderCircle } from "lucide-react";
import { Link } from "react-router-dom";
import { useHome } from "../api/queries";
import { StatusGlyph } from "../components/primitives/StatusGlyph";
import { RelativeTime } from "../components/primitives/TemporalText";

const HOME_ENTITY_LABELS: Readonly<Record<HomeSummaryItem["kind"], string>> = {
  hitl: "Request",
  todo: "Todo",
  session: "Session",
  automation: "Automation",
};

const HOME_STATUS_LABELS: Readonly<Record<string, string>> = {
  inspection: "Manual inspection",
  permission: "Permission",
  question: "Question",
  blocked: "Blocked",
  budget_limited: "Budget limited",
  failed: "Failed",
  timed_out: "Timed out",
  running: "Running",
  waiting_for_human: "Waiting",
  resuming: "Resuming",
  stopping: "Stopping",
  ready_to_review: "Ready to review",
  missed: "Missed",
  scheduled: "Scheduled",
};

export function homeEntityLabel(kind: HomeSummaryItem["kind"]): string {
  return HOME_ENTITY_LABELS[kind];
}

export function homeStatusLabel(status: string): string {
  const known = HOME_STATUS_LABELS[status];
  if (known !== undefined) return known;
  const readable = status.replaceAll("_", " ").trim();
  return readable.length === 0
    ? "Status unavailable"
    : `${readable[0]!.toLocaleUpperCase()}${readable.slice(1)}`;
}

export function formatHomeSchedule(timestamp: number, now = Date.now()): string {
  const target = new Date(timestamp);
  const today = new Date(now);
  const targetDay = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const dayDifference = Math.round((targetDay - todayDay) / 86_400_000);
  const time = target.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (dayDifference === 0) return `Today ${time}`;
  if (dayDifference === 1) return `Tomorrow ${time}`;
  if (dayDifference > 1 && dayDifference < 7) {
    return `${target.toLocaleDateString([], { weekday: "short" })} ${time}`;
  }
  return `${target.toLocaleDateString([], { month: "short", day: "numeric" })} · ${time}`;
}

export function HomeRoute() {
  const home = useHome();
  return (
    <div className="h-full overflow-y-auto bg-bg-base" data-testid="home">
      <div className="mx-auto max-w-[1180px] px-4 pb-16 pt-6 min-[761px]:px-10 min-[761px]:pt-8">
        <header className="mb-[18px] border-b border-border-subtle pb-4 min-[761px]:mb-[22px]">
          <p className="mb-1.5 mt-1.5 max-w-[46ch] text-[13px] font-[680] uppercase leading-[1.5] tracking-[0.08em] text-text-tertiary">Home</p>
          <h1 className="text-[26px] font-[680] leading-[1.15] tracking-[-0.03em] text-text-primary">Across all projects</h1>
          <p className="mt-1.5 max-w-[46ch] text-[13px] leading-[1.5] text-text-secondary">What needs you, what is running, what is ready to review, and what is coming next.</p>
        </header>

        {home.isLoading ? <p className="flex items-center gap-2 text-[13px] text-text-tertiary"><LoaderCircle className="animate-activity" size={14} /> Loading Home…</p> : null}
        {home.error ? <p role="alert" className="text-[13px] text-error">Failed to load Home: {home.error.message}</p> : null}
        {home.data?.projectErrors.map((error) => (
          <p key={error.project.slug} role="alert" className="border-l-2 border-error bg-error-field px-3 py-2 text-[12px] text-error">{error.project.name}: {error.message}</p>
        ))}

        {home.data ? (
          <div className="grid min-w-0 grid-cols-1 gap-5 min-[920px]:grid-cols-2">
            <HomeSection variant="needs_you" title="Needs you" items={home.data.needsYou} empty="Nothing needs your decision." footnote="Permission gates and failed runs surface first — nothing else competes here." icon={<StatusGlyph kind="needs_you" size={15} />} />
            <HomeSection variant="running" title="Running" items={home.data.running} empty="No work is running." icon={<StatusGlyph kind="running" size={15} />} />
            <HomeSection variant="review" title="Ready to review" items={home.data.readyToReview} empty="No completed Todo work is waiting for review." icon={<StatusGlyph kind="completed" tone="brand" size={15} />} />
            <HomeSection variant="upcoming" title="Upcoming" items={home.data.upcoming} empty="No Automation is scheduled soon." icon={<Calendar size={15} className="text-text-tertiary" />} />
          </div>
        ) : null}
        <p className="mt-5 text-[11px] leading-[1.45] text-text-tertiary">Work lives in each project’s Todos. Open a project to capture, shape, run, and accept work.</p>
      </div>
    </div>
  );
}

type HomeSectionVariant = "needs_you" | "running" | "review" | "upcoming";

function HomeSection({ variant, title, items, empty, footnote, icon }: { variant: HomeSectionVariant; title: string; items: readonly HomeSummaryItem[]; empty: string; footnote?: string; icon: React.ReactNode }) {
  return (
    <section className="min-w-0 border-y border-border-default" aria-labelledby={`home-${title.toLowerCase().replaceAll(" ", "-")}`}>
      <div className="grid min-h-[42px] grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-[9px] border-b border-border-subtle px-3.5">
        {icon}
        <h2 id={`home-${title.toLowerCase().replaceAll(" ", "-")}`} className="text-[13px] font-semibold tracking-[-0.01em] text-text-primary">{title}</h2>
        <span className="text-center text-[11px] font-bold tabular-nums text-text-tertiary">{items.length}</span>
      </div>
      <div className="divide-y divide-border-subtle">
        {items.length === 0 ? <p className="flex min-h-[68px] items-center px-2 text-[12px] text-text-tertiary">{empty}</p> : items.map((item) => <HomeRow key={`${item.kind}:${item.project.slug}:${item.entityId}`} item={item} variant={variant} />)}
      </div>
      {footnote ? <p className="border-t border-border-subtle px-3.5 pb-3 pt-2.5 text-[11px] leading-[1.45] text-text-tertiary">{footnote}</p> : null}
    </section>
  );
}

function HomeRow({ item, variant }: { item: HomeSummaryItem; variant: HomeSectionVariant }) {
  const failed = item.status.toLowerCase().includes("fail") || item.status === "timed_out" || item.status === "missed";
  const mechanismLabel = homeStatusLabel(item.status);
  const label = variant === "needs_you" && !failed ? "Needs you" : mechanismLabel;
  const glyph = failed
    ? <StatusGlyph kind="failed" label={label} size={14} />
    : variant === "needs_you"
      ? <StatusGlyph kind="needs_you" label="Needs you" size={14} />
      : variant === "running"
        ? <StatusGlyph kind="running" label={label} size={14} />
        : variant === "review"
          ? <StatusGlyph kind="completed" tone="brand" label="Ready to review" size={14} />
          : <StatusGlyph kind="enabled" label={label} size={14} />;
  const context = variant === "upcoming" ? undefined : item.context;
  const upcomingSchedule = variant === "upcoming" ? formatHomeSchedule(item.sortAt) : undefined;
  return (
    <Link to={item.href} aria-label={`${item.title}, ${item.project.name}, ${homeEntityLabel(item.kind)}, ${label}${mechanismLabel === label ? "" : `, ${mechanismLabel}`}${upcomingSchedule ? `, ${upcomingSchedule}` : ""}`} className="workbench-row-lift grid min-h-[72px] grid-cols-[14px_minmax(0,1fr)] items-center gap-3 px-4 py-3.5 tracking-[-0.09px] transition-[background-color,transform] duration-[var(--motion-hover)] hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand min-[761px]:min-h-[68px] min-[761px]:grid-cols-[14px_minmax(0,1fr)_auto]">
      {glyph}
      <span className="min-w-0 flex-1">
        <span className="block whitespace-normal text-[13.5px] font-[620] leading-[1.55] tracking-[-0.015em] text-text-primary min-[761px]:truncate">{item.title}</span>
        <span className="mt-1 block whitespace-normal text-[11.5px] leading-[1.55] text-text-tertiary min-[761px]:truncate">{item.project.name} · {homeEntityLabel(item.kind)}{context ? ` · ${context}` : ""}</span>
      </span>
      <span className="col-start-2 flex shrink-0 items-center justify-self-start min-[761px]:col-start-auto min-[761px]:justify-self-auto">
        {variant === "running" ? (
          <RelativeTime className="text-[11.5px] font-[640] leading-[1.55] text-signal-foreground" timestamp={item.sortAt} style="short" />
        ) : variant === "upcoming" ? (
          <time className="text-[11.5px] font-[640] leading-[1.55] text-text-secondary" dateTime={new Date(item.sortAt).toISOString()}>{upcomingSchedule}</time>
        ) : (
          <span className={`text-[11.5px] font-[640] leading-[1.55] ${failed ? "text-error" : variant === "review" ? "text-brand" : "text-warning"}`}>{label}</span>
        )}
      </span>
    </Link>
  );
}
