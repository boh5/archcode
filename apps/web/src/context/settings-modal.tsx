import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { useMatch } from "react-router-dom";
import { SettingsDialog } from "../components/features/SettingsDialog";
import type { SettingsSection } from "../components/features/settings-helpers";

interface SettingsModalContextValue {
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  openSettingsModal: (section?: SettingsSection) => void;
  closeSettingsModal: () => void;
}

const SettingsModalContext = createContext<SettingsModalContextValue | null>(null);

export function SettingsModalProvider({ children }: { children: ReactNode }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("models");
  const openSettingsModal = useCallback((section: SettingsSection = "models") => {
    setSettingsSection(section);
    setSettingsOpen(true);
  }, []);
  const closeSettingsModal = useCallback(() => setSettingsOpen(false), []);

  return (
    <SettingsModalContext.Provider value={{ settingsOpen, settingsSection, openSettingsModal, closeSettingsModal }}>
      {children}
    </SettingsModalContext.Provider>
  );
}

export function SettingsModalRenderer() {
  const { settingsOpen, settingsSection, closeSettingsModal } = useSettingsModal();
  const projectMatch = useMatch("/projects/:slug/*");
  return <SettingsDialog open={settingsOpen} section={settingsSection} projectSlug={projectMatch?.params.slug} onClose={closeSettingsModal} />;
}

export function useSettingsModal() {
  const ctx = useContext(SettingsModalContext);
  if (!ctx) throw new Error("useSettingsModal must be used within SettingsModalProvider");
  return ctx;
}
