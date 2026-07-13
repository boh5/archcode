import { useParams } from "react-router-dom";

export function ProjectRoute() {
  const { slug } = useParams<{ slug: string }>();

  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-md rounded-md border border-dashed border-warning/50 bg-warning/10 px-6 py-5 text-center">
        <div className="mx-auto mb-3 inline-flex rounded-sm border border-warning/40 bg-bg-base px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-warning">
          Placeholder
        </div>
        <h2 className="text-lg font-medium text-text-primary">
          Project Dashboard: {slug}
        </h2>
        <p className="mt-2 text-sm leading-6 text-text-tertiary">
          This project dashboard is not implemented yet. Use the sidebar sections to open sessions,
          goals, or automations while the dashboard is being designed.
        </p>
      </div>
    </div>
  );
}
