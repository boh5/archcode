import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { AddProjectModal } from "../components/features/AddProjectModal";

interface AddProjectModalContextValue {
  addProjectOpen: boolean;
  openAddProjectModal: () => void;
  closeAddProjectModal: () => void;
}

const AddProjectModalContext = createContext<AddProjectModalContextValue | null>(null);

export function AddProjectModalProvider({ children }: { children: ReactNode }) {
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const openAddProjectModal = useCallback(() => setAddProjectOpen(true), []);
  const closeAddProjectModal = useCallback(() => setAddProjectOpen(false), []);

  return (
    <AddProjectModalContext.Provider value={{ addProjectOpen, openAddProjectModal, closeAddProjectModal }}>
      {children}
    </AddProjectModalContext.Provider>
  );
}

export function AddProjectModalRenderer() {
  const { addProjectOpen, closeAddProjectModal } = useAddProjectModal();
  return <AddProjectModal open={addProjectOpen} onClose={closeAddProjectModal} />;
}

export function useAddProjectModal() {
  const ctx = useContext(AddProjectModalContext);
  if (!ctx) throw new Error("useAddProjectModal must be used within AddProjectModalProvider");
  return ctx;
}