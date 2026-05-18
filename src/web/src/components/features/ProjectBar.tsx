/**
 * ProjectBar — Column 1 of the 4-column layout.
 *
 * Renders project icons with tooltips, active state accent bar,
 * and bottom settings/theme/add buttons.
 *
 * Design spec: design/web-ui.html → .project-bar
 */

import { useNavigate, useParams } from "react-router-dom";
import { useProjects } from "../../api/queries";

/**
 * Extract initials from a project slug (first 2 characters).
 * Slugs are typically kebab-case; we take the first 2 chars of the
 * slug for a compact visual identifier.
 */
function getInitials(slug: string): string {
  return slug.slice(0, 2).toLowerCase();
}

export function ProjectBar() {
  const navigate = useNavigate();
  const { slug: activeSlug } = useParams<{ slug: string }>();
  const { data: projects } = useProjects();

  const handleProjectClick = (slug: string) => {
    navigate(`/projects/${slug}`);
  };

  const handleAddProject = () => {
    // Placeholder — full add-project flow to be implemented later
    console.log("[ProjectBar] Add project clicked");
  };

  return (
    <div className="project-bar">
      <div className="project-bar-logo">S</div>

      {projects?.map((project) => {
        const isActive = project.slug === activeSlug;
        return (
          <div
            key={project.slug}
            className={`project-item${isActive ? " active" : ""}`}
            onClick={() => handleProjectClick(project.slug)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                handleProjectClick(project.slug);
              }
            }}
          >
            {getInitials(project.slug)}
            <div className="project-tooltip">{project.name}</div>
          </div>
        );
      })}

      <div
        className="project-item"
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
        <div className="project-tooltip">Open project</div>
      </div>

      <div className="project-bar-spacer" />

      <div className="project-bar-bottom">
        <div
          className="project-bar-icon"
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
          className="project-bar-icon"
          role="button"
          tabIndex={0}
          title="Toggle theme"
          onClick={() => console.log("[ProjectBar] Theme toggle clicked")}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              console.log("[ProjectBar] Theme toggle clicked");
            }
          }}
        >
          ◐
        </div>
      </div>
    </div>
  );
}