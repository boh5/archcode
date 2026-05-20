import type { ReactNode } from "react";
import type { Project } from "../../api/types";
import {
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../ui/DropdownMenu";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "../ui/ContextMenu";

interface ProjectActionMenuProps {
  project: Project;
  onEdit: (project: Project) => void;
  onClose: (project: Project) => void;
}

interface DropdownModeProps extends ProjectActionMenuProps {
  trigger: ReactNode;
}

interface ContextMenuModeProps extends ProjectActionMenuProps {
  children: ReactNode;
}

/** Shared menu items for both dropdown and context-menu trigger modes. */
function renderMenuItems(
  project: Project,
  onEdit: (project: Project) => void,
  onClose: (project: Project) => void,
  ItemComponent: typeof DropdownMenuItem | typeof ContextMenuItem,
  SeparatorComponent: typeof DropdownMenuSeparator | typeof ContextMenuSeparator,
) {
  return (
    <>
      <ItemComponent onSelect={() => onEdit(project)}>
        Edit
      </ItemComponent>
      <SeparatorComponent />
      <ItemComponent
        className="text-error hover:!text-error focus:!text-error"
        onSelect={() => onClose(project)}
      >
        Close
      </ItemComponent>
    </>
  );
}

/**
 * Dropdown-triggered project action menu.
 * Use in Sidebar header button — renders a DropdownMenu with an explicit trigger element.
 */
export function ProjectActionDropdown({
  project,
  onEdit,
  onClose,
  trigger,
}: DropdownModeProps) {
  return (
    <DropdownMenuRoot>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {renderMenuItems(project, onEdit, onClose, DropdownMenuItem, DropdownMenuSeparator)}
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}

/**
 * Context-menu-triggered project action menu.
 * Use in ProjectBar right-click — wraps children in ContextMenu trigger.
 */
export function ProjectActionContextMenu({
  project,
  onEdit,
  onClose,
  children,
}: ContextMenuModeProps) {
  return (
    <ContextMenuRoot>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {renderMenuItems(project, onEdit, onClose, ContextMenuItem, ContextMenuSeparator)}
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}