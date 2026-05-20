import { useParams } from "react-router-dom";

export function ProjectRoute() {
  const { slug } = useParams<{ slug: string }>();

  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-2">
        <h2 className="text-lg font-medium text-text-primary">
          Project: {slug}
        </h2>
        <p className="text-sm text-text-tertiary">
          Select or create a session to begin
        </p>
      </div>
    </div>
  );
}