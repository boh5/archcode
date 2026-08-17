import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from "react";
import { AddProjectModal } from "../components/features/AddProjectModal";

interface AddProjectModalContextValue {
  addProjectOpen: boolean;
  returnFocusTarget: HTMLElement | null;
  openAddProjectModal: () => void;
  closeAddProjectModal: () => void;
}

const AddProjectModalContext = createContext<AddProjectModalContextValue | null>(null);

export function AddProjectModalProvider({ children }: { children: ReactNode }) {
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const openAddProjectModal = useCallback(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setAddProjectOpen(true);
  }, []);
  const closeAddProjectModal = useCallback(() => setAddProjectOpen(false), []);

  return (
    <AddProjectModalContext.Provider value={{ addProjectOpen, returnFocusTarget: returnFocusRef.current, openAddProjectModal, closeAddProjectModal }}>
      {children}
    </AddProjectModalContext.Provider>
  );
}

export function AddProjectModalRenderer() {
  const { addProjectOpen, returnFocusTarget, closeAddProjectModal } = useAddProjectModal();
  return <AddProjectModal open={addProjectOpen} returnFocusTarget={returnFocusTarget} onClose={closeAddProjectModal} />;
}

export function useAddProjectModal() {
  const ctx = useContext(AddProjectModalContext);
  if (!ctx) throw new Error("useAddProjectModal must be used within AddProjectModalProvider");
  return ctx;
}
