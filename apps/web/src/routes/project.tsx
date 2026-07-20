import { useParams } from "react-router-dom";
import { Dashboard } from "./dashboard";

/** Project Dashboard is the same scoped workbench as Home, never a placeholder. */
export function ProjectRoute() {
  const { slug } = useParams<{ slug: string }>();
  if (!slug) return <div className="p-4 text-sm text-error">Project is unavailable.</div>;
  return <Dashboard scope={{ kind: "project", projectSlug: slug }} />;
}
