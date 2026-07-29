import { useWorkbenchLayout } from "../../context/workbench-layout";
import { PanelToggleButton } from "./PanelToggleButton";

export function SidebarToggleButton() {
  const { sidebarCollapsed, toggleSidebar } = useWorkbenchLayout();
  const expanded = !sidebarCollapsed;

  return (
    <PanelToggleButton
      side="left"
      expanded={expanded}
      label={expanded ? "Collapse project sidebar" : "Expand project sidebar"}
      controls="project-sidebar"
      onToggle={toggleSidebar}
    />
  );
}
