import type { HomeSummaryItem } from "@archcode/protocol";
import { Calendar, LoaderCircle, TriangleAlert } from "lucide-react";
import { Link } from "react-router-dom";
import { useHome } from "../api/queries";
import { StatusGlyph } from "../components/primitives/StatusGlyph";
import { RelativeTime } from "../components/primitives/TemporalText";

export function HomeRoute() {
  const home = useHome();
  return (
    <div className="h-full overflow-y-auto bg-bg-base" data-testid="home">
      <div className="mx-auto flex max-w-[1180px] flex-col gap-8 px-4 pb-16 pt-8 min-[761px]:px-10 min-[761px]:pt-11">
        <header>
          <h1 className="text-[26px] font-bold leading-8 tracking-[-0.035em] text-text-primary">Home</h1>
          <p className="mt-1 text-[14px] text-text-secondary">Across all projects</p>
        </header>

        {home.isLoading ? <p className="flex items-center gap-2 text-[13px] text-text-tertiary"><LoaderCircle className="animate-activity" size={14} /> Loading Home…</p> : null}
        {home.error ? <p role="alert" className="text-[13px] text-error">Failed to load Home: {home.error.message}</p> : null}
        {home.data?.projectErrors.map((error) => (
          <p key={error.project.slug} role="alert" className="border-l-2 border-error bg-error-field px-3 py-2 text-[12px] text-error">{error.project.name}: {error.message}</p>
        ))}

        {home.data ? (
          <div className="grid min-w-0 grid-cols-1 gap-5 min-[920px]:grid-cols-2">
            <HomeSection title="Needs you" items={home.data.needsYou} empty="Nothing needs your decision." icon={<StatusGlyph kind="needs_you" size={15} />} />
            <HomeSection title="Running" items={home.data.running} empty="No work is running." icon={<StatusGlyph kind="running" size={15} />} />
            <HomeSection title="Ready to review" items={home.data.readyToReview} empty="No completed Todo work is waiting for review." icon={<StatusGlyph kind="completed" size={15} />} />
            <HomeSection title="Upcoming" items={home.data.upcoming} empty="No Automation is scheduled soon." icon={<Calendar size={15} className="text-text-tertiary" />} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function HomeSection({ title, items, empty, icon }: { title: string; items: readonly HomeSummaryItem[]; empty: string; icon: React.ReactNode }) {
  return (
    <section className="min-w-0 border-t border-border-default bg-bg-surface px-4 pb-2 pt-3" aria-labelledby={`home-${title.toLowerCase().replaceAll(" ", "-")}`}>
      <div className="flex min-h-8 items-center gap-2 pb-2">
        {icon}
        <h2 id={`home-${title.toLowerCase().replaceAll(" ", "-")}`} className="text-[14px] font-semibold text-text-primary">{title}</h2>
        <span className="ml-auto text-[11px] tabular-nums text-text-tertiary">{items.length}</span>
      </div>
      <div className="divide-y divide-border-subtle border-t border-border-subtle">
        {items.length === 0 ? <p className="flex min-h-[68px] items-center px-2 text-[12px] text-text-tertiary">{empty}</p> : items.map((item) => <HomeRow key={`${item.kind}:${item.project.slug}:${item.entityId}`} item={item} />)}
      </div>
    </section>
  );
}

function HomeRow({ item }: { item: HomeSummaryItem }) {
  return (
    <Link to={item.href} className="flex min-h-[68px] items-center gap-3 px-2 py-3 hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand">
      {item.status.toLowerCase().includes("fail") ? <TriangleAlert size={14} className="text-error" /> : <StatusGlyph kind={item.kind === "hitl" ? "needs_you" : item.status.toLowerCase().includes("running") ? "running" : item.kind === "automation" ? "enabled" : "idle"} size={14} />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold text-text-primary">{item.title}</span>
        <span className="mt-1 block truncate text-[11px] text-text-tertiary">{item.project.name} · {item.kind}{item.context ? ` · ${item.context}` : ""}</span>
      </span>
      <span className="shrink-0 text-[11px] font-medium text-text-secondary">{item.status}</span>
      <span className="hidden shrink-0 text-[11px] text-text-tertiary min-[640px]:inline"><RelativeTime timestamp={item.sortAt} /></span>
    </Link>
  );
}
