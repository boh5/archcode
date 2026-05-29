import { useDiff } from "../../api/queries";
import { DiffView } from "../diff/DiffView";

interface DiffTabProps {
  slug: string;
}

export function DiffTab({ slug }: DiffTabProps) {
  const { data: files, isLoading, error } = useDiff(slug);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-text-muted">Loading diff…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-error">Failed to load diff</p>
      </div>
    );
  }

  return <DiffView files={files ?? []} />;
}