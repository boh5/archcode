import { Navigate, Outlet, useParams } from "react-router-dom";
import { ProjectToolbar } from "../components/features/ProjectToolbar";

export function ProjectRoute() {
  const { slug } = useParams<{ slug: string }>();
  if (!slug) return <div className="p-4 text-sm text-error">Project is unavailable.</div>;
  return <Navigate replace to={`/projects/${slug}/todos`} />;
}

export function ProjectLayout() {
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <ProjectToolbar />
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}
