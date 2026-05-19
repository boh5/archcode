import { useNavigate, useParams } from "react-router-dom";
import { useProjects } from "../../api/queries";
import { useTheme } from "../../hooks/use-theme";

interface ProjectBarProps {
  onAddProject?: () => void;
}

function getInitials(slug: string): string {
  return slug.slice(0, 2).toLowerCase();
}

export function ProjectBar({ onAddProject }: ProjectBarProps) {
  const navigate = useNavigate();
  const { slug: activeSlug } = useParams<{ slug: string }>();
  const { data: projects } = useProjects();
  const { theme, toggleTheme } = useTheme();

  const handleProjectClick = (slug: string) => {
    navigate(`/projects/${slug}`);
  };

  const handleAddProject = () => {
    onAddProject?.();
  };

  return (
    <div className="flex flex-col items-center py-2 gap-0.5 z-10 h-full">
      <div className="w-8 h-8 rounded-md bg-gradient-to-br from-accent to-agent-orchestrator flex items-center justify-center font-bold text-sm text-white mb-2 shrink-0">
        S
      </div>

      {projects?.map((project) => {
        const isActive = project.slug === activeSlug;
        return (
          <div
            key={project.slug}
            className={`group w-9 h-9 rounded-md flex items-center justify-center font-semibold text-[13px] cursor-pointer transition-all duration-150 relative shrink-0 ${
              isActive
                ? "bg-accent-muted text-accent"
                : "text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
            }`}
            onClick={() => handleProjectClick(project.slug)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                handleProjectClick(project.slug);
              }
            }}
          >
            {isActive && (
              <div className="absolute -left-2 top-2 bottom-2 w-[3px] rounded-r-sm bg-accent" />
            )}
            {getInitials(project.slug)}
            <div className="absolute left-12 bg-bg-elevated border border-border-default text-text-primary px-2.5 py-1 rounded-sm text-xs whitespace-nowrap pointer-events-none shadow-md z-50 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
              {project.name}
            </div>
          </div>
        );
      })}

      <div
        className="group w-9 h-9 rounded-md flex items-center justify-center font-semibold text-[13px] text-text-tertiary cursor-pointer transition-all duration-150 relative shrink-0 hover:bg-bg-hover hover:text-text-secondary"
        onClick={handleAddProject}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            handleAddProject();
          }
        }}
      >
        +
        <div className="absolute left-12 bg-bg-elevated border border-border-default text-text-primary px-2.5 py-1 rounded-sm text-xs whitespace-nowrap pointer-events-none shadow-md z-50 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          Open project
        </div>
      </div>

      <div className="flex-1" />

      <div className="flex flex-col items-center gap-1 pt-2 border-t border-border-subtle mt-2">
        <div
          className="w-8 h-8 rounded-sm flex items-center justify-center text-text-muted cursor-pointer transition-all duration-150 text-[15px] hover:bg-bg-hover hover:text-text-secondary"
          role="button"
          tabIndex={0}
          title="Settings"
          onClick={() => console.log("[ProjectBar] Settings clicked")}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              console.log("[ProjectBar] Settings clicked");
            }
          }}
        >
          ⚙
        </div>
        <div
          className="w-8 h-8 rounded-sm flex items-center justify-center text-text-muted cursor-pointer transition-all duration-150 text-[15px] hover:bg-bg-hover hover:text-text-secondary"
          role="button"
          tabIndex={0}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          onClick={toggleTheme}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              toggleTheme();
            }
          }}
        >
          {theme === "dark" ? "☀" : "🌙"}
        </div>
      </div>
    </div>
  );
}