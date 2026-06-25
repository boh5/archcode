import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { SettingsDialog } from "../components/features/SettingsDialog";

interface SettingsModalContextValue {
  settingsOpen: boolean;
  openSettingsModal: () => void;
  closeSettingsModal: () => void;
}

const SettingsModalContext = createContext<SettingsModalContextValue | null>(null);

export function SettingsModalProvider({ children }: { children: ReactNode }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const openSettingsModal = useCallback(() => setSettingsOpen(true), []);
  const closeSettingsModal = useCallback(() => setSettingsOpen(false), []);

  return (
    <SettingsModalContext.Provider value={{ settingsOpen, openSettingsModal, closeSettingsModal }}>
      {children}
    </SettingsModalContext.Provider>
  );
}

export function SettingsModalRenderer() {
  const { settingsOpen, closeSettingsModal } = useSettingsModal();
  return <SettingsDialog open={settingsOpen} onClose={closeSettingsModal} />;
}

export function useSettingsModal() {
  const ctx = useContext(SettingsModalContext);
  if (!ctx) throw new Error("useSettingsModal must be used within SettingsModalProvider");
  return ctx;
}
